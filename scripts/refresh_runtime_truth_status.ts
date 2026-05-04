import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
} from '../src/domain/trading/operation-dispatcher.types.js'
import { loadReleaseGateStatus } from '../src/runtime/release_gate_status.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import {
  DEFAULT_PROMOTION_READINESS_V2_PATH,
} from '../src/runtime/promotion_v2_artifacts.js'
import {
  DEFAULT_RUNTIME_STATUS_SNAPSHOT_BASE_DIR,
  buildRuntimeStatusSnapshotPaths,
} from '../src/runtime/runtime_status_snapshot.js'
import { refreshRuntimeTruthMainline } from '../src/runtime/runtime_truth_mainline.js'

const DEFAULT_VALIDATION_RUNS_PATH = 'data/research/strategy/strategy_validation_runs.json'
const DEFAULT_VERDICT_PATH = 'data/research/strategy/experiment_verdict.v2.json'
const DEFAULT_RELEASE_GATE_STATUS_PATH = 'data/runtime/release_gate_status.json'
const DEFAULT_REGISTRY_PATH = 'data/runtime/paper_champion_registry.json'
const DEFAULT_PORTFOLIO_TARGET_PATH = 'data/runtime/paper_portfolio_target.json'
const DEFAULT_RUNTIME_PUBLISH_STATE_PATH = 'data/runtime/runtime_publish_state.json'
const DEFAULT_OUTPUT_PATH = 'data/runtime/runtime_truth_status_refresh.latest.json'
const DEFAULT_SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT']

export interface RuntimeTruthStatusRefreshArgs {
  symbols: string[]
  validationRunsPath: string
  verdictPath: string
  releaseGateStatusPath: string
  registryPath: string
  portfolioTargetPath: string
  runtimePublishStatePath: string
  snapshotBaseDir: string
  promotionReadinessV2Path: string
  outputPath: string | null
  requirePromotionV2: boolean
  validatePromotionV2Artifacts: boolean
  json: boolean
}

export interface RuntimeTruthStatusRefreshResult {
  schemaVersion: 1
  generatedAt: string
  mode: 'status_refresh_only'
  paperExecutionAllowedByScript: false
  tradingSideEffectsAllowed: false
  snapshotBaseDir: string
  snapshotPaths: ReturnType<typeof buildRuntimeStatusSnapshotPaths>
  inputPaths: {
    validationRunsPath: string
    verdictPath: string
    releaseGateStatusPath: string
    registryPath: string
    portfolioTargetPath: string
    runtimePublishStatePath: string
    promotionReadinessV2Path: string
  }
  symbols: string[]
  prices: {
    loadedSymbols: string[]
    fallbackPriceSymbols: string[]
  }
  runtimeAvailability: {
    healthy: boolean
    reason: string | null
  }
  promotionV2: {
    required: boolean
    path: string | null
    loadStatus: string
    error: string | null
  }
  portfolioTargetSource: 'file' | 'fallback_zero_target'
  promotionPass: boolean
  paperAllow: boolean
  executionKind: string
  phaseReadinessSummary: {
    researchStatus: string | null
    paperStatus: string | null
    liveTinyCapitalStatus: string | null
    proofTrackingStatus: string | null
  }
  blockers: string[]
}

async function main(): Promise<void> {
  const args = await parseRuntimeTruthStatusRefreshArgs(process.argv.slice(2))
  const result = await runRuntimeTruthStatusRefresh(args)
  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(renderRuntimeTruthStatusRefreshResult(result))
  }
}

export async function parseRuntimeTruthStatusRefreshArgs(
  argv: string[],
): Promise<RuntimeTruthStatusRefreshArgs> {
  const raw = parseRawArgs(argv)
  const portfolioTargetPath = raw.get('portfolioTargetPath') ?? DEFAULT_PORTFOLIO_TARGET_PATH
  const symbols = parseSymbols(raw.get('symbols')) ??
    await inferSymbolsFromPortfolioTarget(portfolioTargetPath) ??
    DEFAULT_SYMBOLS
  return {
    symbols,
    validationRunsPath: raw.get('validationRunsPath') ?? DEFAULT_VALIDATION_RUNS_PATH,
    verdictPath: raw.get('verdictPath') ?? DEFAULT_VERDICT_PATH,
    releaseGateStatusPath: raw.get('releaseGateStatusPath') ?? DEFAULT_RELEASE_GATE_STATUS_PATH,
    registryPath: raw.get('registryPath') ?? DEFAULT_REGISTRY_PATH,
    portfolioTargetPath,
    runtimePublishStatePath: raw.get('runtimePublishStatePath') ?? DEFAULT_RUNTIME_PUBLISH_STATE_PATH,
    snapshotBaseDir: raw.get('snapshotBaseDir') ?? DEFAULT_RUNTIME_STATUS_SNAPSHOT_BASE_DIR,
    promotionReadinessV2Path: raw.get('promotionReadinessV2Path') ?? DEFAULT_PROMOTION_READINESS_V2_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    requirePromotionV2: parseBool(raw.get('requirePromotionV2'), true),
    validatePromotionV2Artifacts: parseBool(raw.get('validatePromotionV2Artifacts'), true),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runRuntimeTruthStatusRefresh(
  args: RuntimeTruthStatusRefreshArgs,
): Promise<RuntimeTruthStatusRefreshResult> {
  const startedAt = new Date()
  const now = new Date()
  const snapshotBaseDir = resolve(args.snapshotBaseDir)
  const pricesBySymbol = await loadLocalPricesBySymbol(args.symbols)
  const fallbackPriceSymbols = args.symbols.filter(symbol => pricesBySymbol[symbol] == null)
  const releaseGateStatus = await loadReleaseGateStatus(args.releaseGateStatusPath)
  const result = await refreshRuntimeTruthMainline(
    createStatusOnlyEngine({
      basisEquityUsd: 1_000,
      pricesBySymbol,
    }),
    {
      async buildRuntimePlanningState() {
        const releaseGateAllowsPaperTrading = releaseGateStatus?.allowPaperTrading ?? null
        const releaseGateAllowsLiveTrading = releaseGateStatus?.allowLiveTrading ?? null
        const releaseGateBlocked =
          releaseGateAllowsPaperTrading !== true ||
          releaseGateAllowsLiveTrading !== true ||
          Boolean(releaseGateStatus?.failedChecks?.length)
        return {
          regimeSeverity: 'stable' as const,
          regimeReason: null,
          capitalRampStage: 'research_only',
          releaseGateStatus,
          releaseGateBlocked,
          releaseGateBlockedReason: releaseGateBlocked
            ? releaseGateStatus?.failedChecks?.[0] ?? 'release_gate_not_approved'
            : null,
          releaseGateAllowsPaperTrading,
          releaseGateAllowsLiveTrading,
          paperTradingBlocked: true,
          paperTradingBlockedReason: 'runtime_truth_status_refresh_paper_executor_disabled',
          liveDeploymentMode: 'not_ready' as const,
          liveDeploymentReason: 'runtime_truth_status_refresh_status_only',
        }
      },
    },
    {
      symbols: args.symbols,
      validationRunsPath: args.validationRunsPath,
      verdictPath: args.verdictPath,
      releaseGateStatusPath: args.releaseGateStatusPath,
      registryPath: args.registryPath,
      portfolioTargetPath: args.portfolioTargetPath,
      runtimePublishStatePath: args.runtimePublishStatePath,
      promotionReadinessV2Path: args.promotionReadinessV2Path,
      requirePromotionV2: args.requirePromotionV2,
      validatePromotionV2Artifacts: args.validatePromotionV2Artifacts,
      snapshotBaseDir,
      paperExecutorEnabled: false,
      now,
    },
  )
  const blockers = unique([
    ...result.truth.promotionGate.blockingReasons,
    ...result.truth.paperGate.blockingReasons,
    ...(result.truth.executionPlan.kind === 'blocked'
      ? result.truth.executionPlan.blockingReasons
      : []),
  ])
  const report: RuntimeTruthStatusRefreshResult = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    mode: 'status_refresh_only',
    paperExecutionAllowedByScript: false,
    tradingSideEffectsAllowed: false,
    snapshotBaseDir,
    snapshotPaths: buildRuntimeStatusSnapshotPaths(snapshotBaseDir),
    inputPaths: {
      validationRunsPath: resolve(args.validationRunsPath),
      verdictPath: resolve(args.verdictPath),
      releaseGateStatusPath: resolve(args.releaseGateStatusPath),
      registryPath: resolve(args.registryPath),
      portfolioTargetPath: resolve(args.portfolioTargetPath),
      runtimePublishStatePath: resolve(args.runtimePublishStatePath),
      promotionReadinessV2Path: resolve(args.promotionReadinessV2Path),
    },
    symbols: args.symbols,
    prices: {
      loadedSymbols: args.symbols.filter(symbol => pricesBySymbol[symbol] != null),
      fallbackPriceSymbols,
    },
    runtimeAvailability: result.runtimeAvailability,
    promotionV2: result.promotionV2,
    portfolioTargetSource: result.portfolioTargetSource,
    promotionPass: result.truth.promotionGate.pass,
    paperAllow: result.truth.paperGate.allowPaperTrading,
    executionKind: result.truth.executionPlan.kind,
    phaseReadinessSummary: {
      researchStatus: readString(result.phaseReadiness.research.status),
      paperStatus: readString(result.phaseReadiness.paper.status),
      liveTinyCapitalStatus: readString(result.phaseReadiness.liveTinyCapital.status),
      proofTrackingStatus: readString(result.phaseReadiness.proofTracking.status),
    },
    blockers,
  }

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'runtime_truth_status_refresh',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.paperAllow ? 'pass' : 'warn',
      recordsIn: report.symbols.length,
      recordsOut: Object.keys(report.snapshotPaths).length,
      errorClass: report.paperAllow ? null : 'paper_execution_blocked',
    })
  }

  return report
}

export function renderRuntimeTruthStatusRefreshResult(
  result: RuntimeTruthStatusRefreshResult,
): string {
  return [
    '# Runtime Truth Status Refresh',
    '',
    `Generated: ${result.generatedAt}`,
    `Mode: ${result.mode}`,
    `Paper execution allowed by script: ${result.paperExecutionAllowedByScript}`,
    `Trading side effects allowed: ${result.tradingSideEffectsAllowed}`,
    `Promotion pass: ${result.promotionPass}`,
    `Paper allow: ${result.paperAllow}`,
    `Execution kind: ${result.executionKind}`,
    `Snapshot base dir: ${result.snapshotBaseDir}`,
    `Blockers: ${result.blockers.length === 0 ? 'none' : result.blockers.join(', ')}`,
    '',
  ].join('\n')
}

function createStatusOnlyEngine(input: {
  basisEquityUsd: number
  pricesBySymbol: Record<string, number>
}): ICryptoTradingEngine {
  return {
    async placeOrder(_order: CryptoPlaceOrderRequest): Promise<CryptoOrderResult> {
      throw new Error('refresh_runtime_truth_status is status-only and does not place orders.')
    },
    async getPositions(): Promise<CryptoPosition[]> {
      return []
    },
    async getOrders(): Promise<CryptoOrder[]> {
      return []
    },
    async getAccount(): Promise<CryptoAccountInfo> {
      return {
        balance: input.basisEquityUsd,
        totalMargin: 0,
        unrealizedPnL: 0,
        equity: input.basisEquityUsd,
        realizedPnL: 0,
        totalPnL: 0,
      }
    },
    async cancelOrder(_orderId: string): Promise<boolean> {
      throw new Error('refresh_runtime_truth_status is status-only and does not cancel orders.')
    },
    async adjustLeverage(_symbol: string, _newLeverage: number): Promise<{ success: boolean; error?: string }> {
      throw new Error('refresh_runtime_truth_status is status-only and does not adjust leverage.')
    },
    async getTicker(symbol: string): Promise<CryptoTicker> {
      const last = input.pricesBySymbol[symbol] ?? 1
      return {
        symbol,
        last,
        bid: last,
        ask: last,
        high: last,
        low: last,
        volume: 0,
        timestamp: new Date(),
      }
    },
    async getFundingRate(symbol: string): Promise<CryptoFundingRate> {
      return {
        symbol,
        fundingRate: 0,
        previousFundingRate: 0,
        timestamp: new Date(),
      }
    },
    async getOrderBook(symbol: string, _limit?: number): Promise<CryptoOrderBook> {
      const last = input.pricesBySymbol[symbol] ?? 1
      return {
        symbol,
        bids: [[last, 1]],
        asks: [[last, 1]],
        timestamp: new Date(),
      }
    },
  }
}

async function loadLocalPricesBySymbol(symbols: string[]): Promise<Record<string, number>> {
  const entries = await Promise.all(
    symbols.map(async symbol => {
      const price = await loadLatestClose(symbolToLive5mCsvPath(symbol))
      return price == null ? null : [symbol, price] as const
    }),
  )
  return Object.fromEntries(
    entries.filter((entry): entry is readonly [string, number] => entry !== null),
  )
}

function symbolToLive5mCsvPath(symbol: string): string {
  const normalized = symbol
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
  return join('data/market/live_5m', `${normalized}_5m.csv`)
}

async function loadLatestClose(path: string): Promise<number | null> {
  if (!existsSync(path)) return null
  const raw = await readFile(path, 'utf-8')
  const lines = raw.trim().split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return null
  const header = lines[0].split(',')
  const closeIndex = header.indexOf('close')
  if (closeIndex < 0) return null
  const last = lines.at(-1)
  if (!last) return null
  const cells = last.split(',')
  const close = Number(cells[closeIndex])
  return Number.isFinite(close) && close > 0 ? close : null
}

async function inferSymbolsFromPortfolioTarget(path: string): Promise<string[] | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as {
      positions?: Array<{ symbol?: unknown }>
    }
    const symbols = unique(
      (raw.positions ?? [])
        .map(position => typeof position.symbol === 'string' ? position.symbol.trim() : '')
        .filter(Boolean),
    )
    return symbols.length > 0 ? symbols : null
  } catch {
    return null
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const body = token.slice(2)
    const equals = body.indexOf('=')
    if (equals >= 0) {
      out.set(body.slice(0, equals), body.slice(equals + 1))
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(body, next)
      index += 1
    } else {
      out.set(body, 'true')
    }
  }
  return out
}

function parseSymbols(raw: string | undefined): string[] | null {
  if (!raw) return null
  const symbols = unique(
    raw
      .split(',')
      .map(symbol => symbol.trim())
      .filter(Boolean),
  )
  return symbols.length > 0 ? symbols : null
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

function parseNullablePath(raw: string | undefined): string | null {
  if (raw == null) return null
  const normalized = raw.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' || normalized === '-' ? null : raw
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
