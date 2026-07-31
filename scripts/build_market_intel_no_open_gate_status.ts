import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildPaperOpenContextSnapshot, paperOpenContextAcceptRejectReasons } from '../src/runtime/paper_open_context.js'
import { BLOCKED_MARKET_INTEL_ALLOW_NEW_POSITIONS_BY_LANE, DEFAULT_MARKET_INTEL_ALLOW_NEW_POSITIONS_BY_LANE } from '../src/runtime/market_intel_constants.js'
import { createBootstrapMarketIntelContext, nextMarketIntelContext } from '../src/runtime/market_intel_context.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type Status = 'pass' | 'blocked'

interface CliArgs {
  outputPath: string | null
  json: boolean
}

export interface MarketIntelNoOpenGateStatus {
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
    riskOffOpenContextStatus: string
    riskOffRejectReasons: string[]
    severeNewsOpenContextStatus: string
    severeNewsRejectReasons: string[]
    laneBlockedOpenContextStatus: string
    laneBlockedRejectReasons: string[]
    symbolBlockedOpenContextStatus: string
    symbolBlockedRejectReasons: string[]
    allowedOpenContextStatus: string
    allowedRejectReasons: string[]
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/market_intel_no_open_gate_status.latest.json'

async function main(): Promise<void> {
  const args = parseMarketIntelNoOpenGateStatusArgs(process.argv.slice(2))
  const report = await runMarketIntelNoOpenGateStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseMarketIntelNoOpenGateStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runMarketIntelNoOpenGateStatus(args: CliArgs): Promise<MarketIntelNoOpenGateStatus> {
  const startedAt = new Date()
  const report = buildMarketIntelNoOpenGateStatus(new Date().toISOString())
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'market_intel_no_open_gate_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'pass' ? 'pass' : 'fail',
      recordsIn: 4,
      recordsOut: 1,
      errorClass: report.blockers[0] ?? null,
    })
  }
  return report
}

export function buildMarketIntelNoOpenGateStatus(
  generatedAt = new Date().toISOString(),
): MarketIntelNoOpenGateStatus {
  const now = new Date('2026-05-08T06:00:00.000Z')
  const base = nextMarketIntelContext(createBootstrapMarketIntelContext(now), {
    generatedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + 60_000).toISOString(),
    riskMode: 'risk_on',
    newsRiskRegime: 'normal',
    allowNewPositionsByLane: { ...DEFAULT_MARKET_INTEL_ALLOW_NEW_POSITIONS_BY_LANE },
    exposureMultiplierByLane: {
      cross_sectional: 0.5,
      volume_breakout_1x: 0.75,
      volume_breakout_3x: 0.5,
      microstructure_10x: 0,
      microstructure_100x: 0,
    },
    bannedSymbols: [],
    coldStartRoundsRemaining: 0,
    flashConfidenceByLane: {
      cross_sectional: { confidence: 0.8, confidenceLow: 0.6, confidenceHigh: 0.95 },
      volume_breakout_1x: { confidence: 0.7, confidenceLow: 0.5, confidenceHigh: 0.9 },
      volume_breakout_3x: { confidence: 0.6, confidenceLow: 0.4, confidenceHigh: 0.85 },
      microstructure_10x: { confidence: 0.75, confidenceLow: 0.55, confidenceHigh: 0.92 },
      microstructure_100x: { confidence: 0.65, confidenceLow: 0.45, confidenceHigh: 0.88 },
    },
    semanticValidation: { passed: true, violations: [] },
    sourceEpoch: { flashEpoch: 1, proEpoch: 1, newsEpoch: 1 },
    trigger: 'diagnostic_probe',
    bootstrap: false,
  })
  const riskOff = nextMarketIntelContext(base, {
    riskMode: 'risk_off',
    allowNewPositionsByLane: { ...BLOCKED_MARKET_INTEL_ALLOW_NEW_POSITIONS_BY_LANE },
  })
  const severeNews = nextMarketIntelContext(base, {
    newsRiskRegime: 'severe',
  })
  const laneBlocked = nextMarketIntelContext(base, {
    allowNewPositionsByLane: {
      ...DEFAULT_MARKET_INTEL_ALLOW_NEW_POSITIONS_BY_LANE,
      cross_sectional: false,
    },
  })
  const symbolBlocked = nextMarketIntelContext(base, {
    bannedSymbols: ['APT-USDT'],
  })

  const riskOffOpen = buildPaperOpenContextSnapshot(riskOff, 'cross_sectional', now, 'BTC-USDT')
  const severeNewsOpen = buildPaperOpenContextSnapshot(severeNews, 'cross_sectional', now, 'BTC-USDT')
  const laneBlockedOpen = buildPaperOpenContextSnapshot(laneBlocked, 'cross_sectional', now, 'BTC-USDT')
  const symbolBlockedOpen = buildPaperOpenContextSnapshot(symbolBlocked, 'cross_sectional', now, 'APT-USDT')
  const allowedOpen = buildPaperOpenContextSnapshot(base, 'cross_sectional', now, 'BTC-USDT')

  const riskOffRejectReasons = paperOpenContextAcceptRejectReasons(riskOffOpen)
  const severeNewsRejectReasons = paperOpenContextAcceptRejectReasons(severeNewsOpen)
  const laneBlockedRejectReasons = paperOpenContextAcceptRejectReasons(laneBlockedOpen)
  const symbolBlockedRejectReasons = paperOpenContextAcceptRejectReasons(symbolBlockedOpen)
  const allowedRejectReasons = paperOpenContextAcceptRejectReasons(allowedOpen)

  const blockers = [
    ...(riskOffOpen.contextStatus === 'risk_off' ? [] : [`risk_off_context_not_blocked:${riskOffOpen.contextStatus}`]),
    ...(riskOffRejectReasons.includes('context_status:risk_off') ? [] : ['risk_off_reject_reason_missing']),
    ...(severeNewsOpen.contextStatus === 'severe_news' ? [] : [`severe_news_context_not_blocked:${severeNewsOpen.contextStatus}`]),
    ...(severeNewsRejectReasons.includes('context_status:severe_news') ? [] : ['severe_news_reject_reason_missing']),
    ...(laneBlockedOpen.contextStatus === 'lane_blocked' ? [] : [`lane_blocked_context_not_blocked:${laneBlockedOpen.contextStatus}`]),
    ...(laneBlockedRejectReasons.includes('context_status:lane_blocked') ? [] : ['lane_blocked_reject_reason_missing']),
    ...(symbolBlockedOpen.contextStatus === 'symbol_blocked' ? [] : [`symbol_blocked_context_not_blocked:${symbolBlockedOpen.contextStatus}`]),
    ...(symbolBlockedRejectReasons.includes('context_status:symbol_blocked') ? [] : ['symbol_blocked_reject_reason_missing']),
    ...(allowedOpen.contextStatus === 'ok' ? [] : [`allowed_context_not_ok:${allowedOpen.contextStatus}`]),
    ...(allowedRejectReasons.length === 0 ? [] : [`allowed_context_has_reject_reasons:${allowedRejectReasons.join('|')}`]),
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
      riskOffOpenContextStatus: riskOffOpen.contextStatus,
      riskOffRejectReasons,
      severeNewsOpenContextStatus: severeNewsOpen.contextStatus,
      severeNewsRejectReasons,
      laneBlockedOpenContextStatus: laneBlockedOpen.contextStatus,
      laneBlockedRejectReasons,
      symbolBlockedOpenContextStatus: symbolBlockedOpen.contextStatus,
      symbolBlockedRejectReasons,
      allowedOpenContextStatus: allowedOpen.contextStatus,
      allowedRejectReasons,
    },
    blockers,
    nextActions: blockers.length === 0
      ? ['Keep MarketIntel no-open validation in the research-evidence refresh chain; this is protection evidence, not trading authorization.']
      : ['Fix MarketIntel open-context handling until risk-off, severe news, lane blocks, and banned symbols reject new opens before execution.'],
    safetyNotes: [
      'This artifact validates fail-closed MarketIntel protection only; it cannot authorize paper orders, live orders, promotion, leverage, or best_config mutation.',
      'MarketIntel blocks apply to new opens; risk-reducing exits and closes remain handled by their lane-specific close paths.',
    ],
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

function renderConsoleSummary(report: MarketIntelNoOpenGateStatus): string {
  return [
    `MarketIntel no-open gate status: ${report.status}`,
    `riskOff=${report.checks.riskOffOpenContextStatus} lane=${report.checks.laneBlockedOpenContextStatus} symbol=${report.checks.symbolBlockedOpenContextStatus}`,
    `paper=false live=false promotion=false`,
    `blockers=${report.blockers.slice(0, 8).join('|') || 'none'}`,
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_market_intel_no_open_gate_status failed:', error)
    process.exit(1)
  })
}
