import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { preTradeRiskCheck } from '../src/domain/trading/risk.js'
import type {
  CryptoAccountInfo,
  CryptoFundingRate,
  CryptoOrder,
  CryptoOrderBook,
  CryptoOrderResult,
  CryptoPlaceOrderRequest,
  CryptoPosition,
  CryptoTicker,
  ICryptoTradingEngine,
  RiskConfig,
} from '../src/domain/trading/operation-dispatcher.types.js'

type Status = 'pass' | 'blocked'

interface CliArgs {
  outputPath: string | null
  json: boolean
}

interface ProbeResult {
  approved: boolean
  reason: string | null
  details: Record<string, unknown> | null
}

export interface StrategyRiskCapStatus {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: Status
  checks: {
    singleTradeLossProbe: ProbeResult
    totalExposureProbe: ProbeResult
    symbolConcentrationProbe: ProbeResult
    netDirectionalExposureProbe: ProbeResult
    correlatedGroupExposureProbe: ProbeResult
    reduceOnlyPassThroughProbe: ProbeResult
    maxSingleTradeLossUsdConfigured: number
    maxTotalExposurePctOfEquityConfigured: number
    maxSymbolExposurePctOfEquityConfigured: number
    maxNetDirectionalExposurePctOfEquityConfigured: number
    maxCorrelatedGroupExposurePctOfEquityConfigured: number
    maxOrderUsdConfigured: number
    maxPositionPctOfEquityConfigured: number
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/strategy_risk_cap_status.latest.json'

const ACCOUNT: CryptoAccountInfo = {
  balance: 10_000,
  totalMargin: 0,
  unrealizedPnL: 0,
  equity: 10_000,
  realizedPnL: 0,
  totalPnL: 0,
  realizedPnlSource: 'balance_payload',
  realizedPnlConfidence: 0.95,
}

const EXISTING_BTC_POSITION: CryptoPosition = {
  symbol: 'BTC/USD',
  side: 'long',
  size: 0.1,
  entryPrice: 40_000,
  leverage: 2,
  margin: 2_000,
  liquidationPrice: 20_000,
  markPrice: 42_000,
  unrealizedPnL: 200,
  positionValue: 4_000,
}

const RISK_CONFIG: RiskConfig = {
  enabled: true,
  killSwitch: false,
  maxOpenPositions: 4,
  maxLeverage: 3,
  maxOrderUsd: 5_000,
  maxPositionPctOfEquity: 50,
  maxSingleTradeLossUsd: 150,
  maxTotalExposurePctOfEquity: 60,
  maxSymbolExposurePctOfEquity: 40,
  maxNetDirectionalExposurePctOfEquity: 40,
  maxCorrelatedGroupExposurePctOfEquity: 60,
  correlatedExposureGroups: {
    crypto_beta: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
  },
  maxDailyLossUsd: 1_000,
}

async function main(): Promise<void> {
  const args = parseStrategyRiskCapStatusArgs(process.argv.slice(2))
  const report = await runStrategyRiskCapStatus(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }
}

export function parseStrategyRiskCapStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runStrategyRiskCapStatus(args: CliArgs): Promise<StrategyRiskCapStatus> {
  const startedAt = new Date()
  const report = await buildStrategyRiskCapStatus(new Date().toISOString())
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'strategy_risk_cap_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'pass' ? 'pass' : 'fail',
      recordsIn: 6,
      recordsOut: 1,
      errorClass: report.blockers[0] ?? null,
    })
  }
  return report
}

export async function buildStrategyRiskCapStatus(
  generatedAt = new Date().toISOString(),
): Promise<StrategyRiskCapStatus> {
  const singleTradeLossProbe = toProbeResult(await preTradeRiskCheck(
    new MockEngine(ACCOUNT, []),
    {
      symbol: 'ETH/USD',
      side: 'buy',
      type: 'market',
      usd_size: 2_000,
      price: 100,
    },
    RISK_CONFIG,
    {
      stopLossPrice: 90,
    },
  ))
  const totalExposureProbe = toProbeResult(await preTradeRiskCheck(
    new MockEngine(ACCOUNT, [EXISTING_BTC_POSITION]),
    {
      symbol: 'ETH/USD',
      side: 'buy',
      type: 'market',
      usd_size: 2_500,
    },
    RISK_CONFIG,
  ))
  const reduceOnlyPassThroughProbe = toProbeResult(await preTradeRiskCheck(
    new MockEngine(ACCOUNT, [
      {
        ...EXISTING_BTC_POSITION,
        positionValue: 6_500,
      },
    ]),
    {
      symbol: 'BTC/USD',
      side: 'sell',
      type: 'market',
      size: 0.1,
      reduceOnly: true,
    },
    RISK_CONFIG,
    {
      dailyLossPct: -8,
      riskIfFilledUsd: 1_000,
    },
  ))
  const symbolConcentrationProbe = toProbeResult(await preTradeRiskCheck(
    new MockEngine(ACCOUNT, [
      {
        ...EXISTING_BTC_POSITION,
        symbol: 'ETH/USD',
        positionValue: 2_500,
      },
    ]),
    {
      symbol: 'ETH/USD',
      side: 'buy',
      type: 'market',
      usd_size: 2_000,
    },
    RISK_CONFIG,
  ))
  const netDirectionalExposureProbe = toProbeResult(await preTradeRiskCheck(
    new MockEngine(ACCOUNT, [
      {
        ...EXISTING_BTC_POSITION,
        symbol: 'BTC/USD',
        side: 'long',
        positionValue: 3_000,
      },
      {
        ...EXISTING_BTC_POSITION,
        symbol: 'SOL/USD',
        side: 'short',
        positionValue: 1_000,
      },
    ]),
    {
      symbol: 'ETH/USD',
      side: 'buy',
      type: 'market',
      usd_size: 2_500,
    },
    {
      ...RISK_CONFIG,
      maxTotalExposurePctOfEquity: 80,
    },
  ))
  const correlatedGroupExposureProbe = toProbeResult(await preTradeRiskCheck(
    new MockEngine(ACCOUNT, [
      {
        ...EXISTING_BTC_POSITION,
        symbol: 'BTC/USD',
        positionValue: 2_500,
      },
      {
        ...EXISTING_BTC_POSITION,
        symbol: 'ETH/USD',
        positionValue: 1_500,
      },
    ]),
    {
      symbol: 'SOL/USD',
      side: 'buy',
      type: 'market',
      usd_size: 2_500,
    },
    {
      ...RISK_CONFIG,
      maxTotalExposurePctOfEquity: 80,
      maxNetDirectionalExposurePctOfEquity: 80,
    },
  ))

  const blockers = [
    ...(!singleTradeLossProbe.approved &&
      singleTradeLossProbe.reason?.includes('maxSingleTradeLossUsd') === true
      ? []
      : ['single_trade_loss_cap_not_blocking_new_open']),
    ...(!totalExposureProbe.approved &&
      totalExposureProbe.reason?.includes('maxTotalExposurePctOfEquity') === true
      ? []
      : ['total_exposure_cap_not_blocking_new_open']),
    ...(!symbolConcentrationProbe.approved &&
      symbolConcentrationProbe.reason?.includes('maxSymbolExposurePctOfEquity') === true
      ? []
      : ['symbol_concentration_cap_not_blocking_new_open']),
    ...(!netDirectionalExposureProbe.approved &&
      netDirectionalExposureProbe.reason?.includes('maxNetDirectionalExposurePctOfEquity') === true
      ? []
      : ['net_directional_exposure_cap_not_blocking_new_open']),
    ...(!correlatedGroupExposureProbe.approved &&
      correlatedGroupExposureProbe.reason?.includes('maxCorrelatedGroupExposurePctOfEquity') === true
      ? []
      : ['correlated_group_exposure_cap_not_blocking_new_open']),
    ...(reduceOnlyPassThroughProbe.approved
      ? []
      : ['risk_reducing_reduce_only_not_pass_through']),
  ]

  return {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: blockers.length === 0 ? 'pass' : 'blocked',
    checks: {
      singleTradeLossProbe,
      totalExposureProbe,
      symbolConcentrationProbe,
      netDirectionalExposureProbe,
      correlatedGroupExposureProbe,
      reduceOnlyPassThroughProbe,
      maxSingleTradeLossUsdConfigured: RISK_CONFIG.maxSingleTradeLossUsd ?? 0,
      maxTotalExposurePctOfEquityConfigured:
        RISK_CONFIG.maxTotalExposurePctOfEquity ?? 0,
      maxSymbolExposurePctOfEquityConfigured:
        RISK_CONFIG.maxSymbolExposurePctOfEquity ?? 0,
      maxNetDirectionalExposurePctOfEquityConfigured:
        RISK_CONFIG.maxNetDirectionalExposurePctOfEquity ?? 0,
      maxCorrelatedGroupExposurePctOfEquityConfigured:
        RISK_CONFIG.maxCorrelatedGroupExposurePctOfEquity ?? 0,
      maxOrderUsdConfigured: RISK_CONFIG.maxOrderUsd,
      maxPositionPctOfEquityConfigured: RISK_CONFIG.maxPositionPctOfEquity,
    },
    blockers,
    nextActions: blockers.length === 0
      ? [
          'Keep this risk-cap status in the research-evidence refresh chain and connect future paper candidates to the same pre-trade risk primitive.',
          'Replace static correlated groups with measured rolling correlation groups before using this as promotion-grade portfolio evidence.',
        ]
      : [
          'Fix pre-trade risk caps until over-limit single-trade loss, total exposure, symbol concentration, correlated-group exposure, and net exposure block new opens while reduce-only remains pass-through.',
        ],
    safetyNotes: [
      'This artifact validates protective risk checks only; it cannot authorize paper orders, live orders, promotion, leverage, or best_config mutation.',
      'Reduce-only pass-through here is diagnostic behavior for risk reduction, not permission to open or add exposure.',
    ],
  }
}

class MockEngine implements ICryptoTradingEngine {
  constructor(
    private readonly account: CryptoAccountInfo,
    private readonly positions: CryptoPosition[],
  ) {}

  async placeOrder(_order: CryptoPlaceOrderRequest): Promise<CryptoOrderResult> {
    return { success: true }
  }

  async getPositions(): Promise<CryptoPosition[]> {
    return this.positions
  }

  async getOrders(): Promise<CryptoOrder[]> {
    return []
  }

  async getAccount(): Promise<CryptoAccountInfo> {
    return this.account
  }

  async cancelOrder(_orderId: string): Promise<boolean> {
    return true
  }

  async adjustLeverage(_symbol: string, _newLeverage: number): Promise<{ success: boolean; error?: string }> {
    return { success: true }
  }

  async getTicker(symbol: string): Promise<CryptoTicker> {
    return {
      symbol,
      last: 100,
      bid: 99.9,
      ask: 100.1,
      high: 110,
      low: 90,
      volume: 1000,
      timestamp: new Date(0),
    }
  }

  async getFundingRate(symbol: string): Promise<CryptoFundingRate> {
    return {
      symbol,
      fundingRate: 0,
      timestamp: new Date(0),
    }
  }

  async getOrderBook(symbol: string): Promise<CryptoOrderBook> {
    return {
      symbol,
      bids: [[99.9, 1]],
      asks: [[100.1, 1]],
      timestamp: new Date(0),
    }
  }
}

function toProbeResult(result: {
  approved: boolean
  reason?: string
  details?: Record<string, unknown>
}): ProbeResult {
  return {
    approved: result.approved,
    reason: result.reason ?? null,
    details: result.details ?? null,
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    i += 1
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' ? null : value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function renderConsoleSummary(report: StrategyRiskCapStatus): string {
  return [
    `Strategy risk-cap status: ${report.status}`,
    `singleTradeLossProbe=${report.checks.singleTradeLossProbe.reason ?? 'approved'}`,
    `totalExposureProbe=${report.checks.totalExposureProbe.reason ?? 'approved'}`,
    `symbolConcentrationProbe=${report.checks.symbolConcentrationProbe.reason ?? 'approved'}`,
    `netDirectionalExposureProbe=${report.checks.netDirectionalExposureProbe.reason ?? 'approved'}`,
    `correlatedGroupExposureProbe=${report.checks.correlatedGroupExposureProbe.reason ?? 'approved'}`,
    `reduceOnlyPassThrough=${report.checks.reduceOnlyPassThroughProbe.approved}`,
    `paper=false live=false promotion=false`,
    `blockers=${report.blockers.slice(0, 8).join('|') || 'none'}`,
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_strategy_risk_cap_status failed:', error)
    process.exit(1)
  })
}
