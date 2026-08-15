import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildStrategyExecutionDecision } from '../src/domain/strategy/execution.js'
import { evaluateSignalGovernance } from '../src/domain/strategy/governance/index.js'
import { evaluateRegime } from '../src/domain/strategy/regime/index.js'
import { createUnavailableStrategyDataProvenance } from '../src/domain/strategy/runtime-types.js'
import type { RuntimeFactorSnapshot } from '../src/domain/strategy/runtime-evaluator.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type Status = 'pass' | 'blocked'

interface CliArgs {
  outputPath: string | null
  json: boolean
}

export interface PanicRegimeNoOpenGateStatus {
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
    eventFreezeRegime: string
    eventFreezeActionStatus: string
    eventFreezeBaseActionStatus: string
    eventFreezeCappedByEventWindow: boolean
    eventFreezeOpenDecisionMode: string
    eventFreezeOpenBlockReason: string | null
    eventFreezeReduceDecisionMode: string
    eventFreezeReducePassThrough: boolean
    volStressRegime: string
    volStressConfidence: number
    volStressOpenDecisionMode: string
    volStressOpenBlockReason: string | null
    volStressReduceDecisionMode: string
    volStressReducePassThrough: boolean
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/panic_regime_no_open_gate_status.latest.json'

async function main(): Promise<void> {
  const args = parsePanicRegimeNoOpenGateStatusArgs(process.argv.slice(2))
  const report = await runPanicRegimeNoOpenGateStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parsePanicRegimeNoOpenGateStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runPanicRegimeNoOpenGateStatus(args: CliArgs): Promise<PanicRegimeNoOpenGateStatus> {
  const startedAt = new Date()
  const report = buildPanicRegimeNoOpenGateStatus(new Date().toISOString())
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'panic_regime_no_open_gate_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'pass' ? 'pass' : 'fail',
      recordsIn: 2,
      recordsOut: 1,
      errorClass: report.blockers[0] ?? null,
    })
  }
  return report
}

export function buildPanicRegimeNoOpenGateStatus(
  generatedAt = new Date().toISOString(),
): PanicRegimeNoOpenGateStatus {
  const highConfidenceSignal = {
    sourceTier: 'L1',
    useType: 'U1',
    decisionStrength: 'D1',
    sentiment: 'S0',
  } as const
  const eventFreezeRegime = evaluateRegime({
    trendStrength: 0.9,
    realizedVolPct: 65,
    realizedVolPercentile: 0.95,
    rangeCompressionScore: 0.1,
    eventWindowFrozen: true,
  })
  const eventFreezeGovernance = evaluateSignalGovernance(highConfidenceSignal, {
    eventWindowFrozen: true,
    eventSeverity: 'high',
    maxActionDuringFreeze: 'reduce',
  })
  const eventFreezeSnapshot = makeSnapshot(eventFreezeGovernance, true, 'reduce')
  const eventFreezeOpenDecision = buildStrategyExecutionDecision({
    snapshot: eventFreezeSnapshot,
    request: {
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'market',
      usd_size: 2500,
    },
    exposureClassification: 'open',
  })
  const eventFreezeReduceDecision = buildStrategyExecutionDecision({
    snapshot: eventFreezeSnapshot,
    request: {
      symbol: 'BTC/USDT:USDT',
      side: 'sell',
      type: 'market',
      usd_size: 2500,
    },
    exposureClassification: 'reduce',
  })

  const volStressRegime = evaluateRegime({
    trendStrength: 0.85,
    realizedVolPct: 95,
    realizedVolPercentile: 0.94,
    rangeCompressionScore: 0.2,
    volumeChangeRate: 3,
  })
  const volStressGovernance = evaluateSignalGovernance(highConfidenceSignal, {
    eventWindowFrozen: true,
    eventSeverity: 'high',
    maxActionDuringFreeze: 'reduce',
  })
  const volStressSnapshot = makeSnapshot(volStressGovernance, true, 'reduce')
  const volStressOpenDecision = buildStrategyExecutionDecision({
    snapshot: volStressSnapshot,
    request: {
      symbol: 'ETH/USDT:USDT',
      side: 'buy',
      type: 'market',
      usd_size: 2500,
    },
    exposureClassification: 'open',
  })
  const volStressReduceDecision = buildStrategyExecutionDecision({
    snapshot: volStressSnapshot,
    request: {
      symbol: 'ETH/USDT:USDT',
      side: 'sell',
      type: 'market',
      usd_size: 2500,
    },
    exposureClassification: 'reduce',
  })

  const blockers = [
    ...(eventFreezeRegime.regime === 'event-risk-freeze'
      ? []
      : [`event_freeze_regime_not_detected:${eventFreezeRegime.regime}`]),
    ...(eventFreezeGovernance.actionStatus === 'reduce'
      ? []
      : [`event_freeze_governance_not_reduce:${eventFreezeGovernance.actionStatus}`]),
    ...(eventFreezeGovernance.cappedByEventWindow
      ? []
      : ['event_freeze_not_capped_by_event_window']),
    ...(eventFreezeOpenDecision.mode === 'blocked'
      ? []
      : [`event_freeze_new_open_not_blocked:${eventFreezeOpenDecision.mode}`]),
    ...(eventFreezeOpenDecision.blockReason?.includes('reduce') === true
      ? []
      : ['event_freeze_new_open_block_reason_missing_reduce']),
    ...(eventFreezeReduceDecision.mode === 'pass-through'
      ? []
      : [`event_freeze_reduce_not_pass_through:${eventFreezeReduceDecision.mode}`]),
    ...(volStressRegime.regime === 'vol-stress'
      ? []
      : [`vol_stress_regime_not_detected:${volStressRegime.regime}`]),
    ...(volStressOpenDecision.mode === 'blocked'
      ? []
      : [`vol_stress_new_open_not_blocked:${volStressOpenDecision.mode}`]),
    ...(volStressOpenDecision.blockReason?.includes('reduce') === true
      ? []
      : ['vol_stress_new_open_block_reason_missing_reduce']),
    ...(volStressReduceDecision.mode === 'pass-through'
      ? []
      : [`vol_stress_reduce_not_pass_through:${volStressReduceDecision.mode}`]),
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
      eventFreezeRegime: eventFreezeRegime.regime,
      eventFreezeActionStatus: eventFreezeGovernance.actionStatus,
      eventFreezeBaseActionStatus: eventFreezeGovernance.baseActionStatus,
      eventFreezeCappedByEventWindow: eventFreezeGovernance.cappedByEventWindow,
      eventFreezeOpenDecisionMode: eventFreezeOpenDecision.mode,
      eventFreezeOpenBlockReason: eventFreezeOpenDecision.blockReason ?? null,
      eventFreezeReduceDecisionMode: eventFreezeReduceDecision.mode,
      eventFreezeReducePassThrough: eventFreezeReduceDecision.mode === 'pass-through',
      volStressRegime: volStressRegime.regime,
      volStressConfidence: volStressRegime.confidence,
      volStressOpenDecisionMode: volStressOpenDecision.mode,
      volStressOpenBlockReason: volStressOpenDecision.blockReason ?? null,
      volStressReduceDecisionMode: volStressReduceDecision.mode,
      volStressReducePassThrough: volStressReduceDecision.mode === 'pass-through',
    },
    blockers,
    nextActions: blockers.length === 0
      ? ['Keep panic/regime no-open validation in the research-evidence refresh chain and continue requiring route-cost, PIT, WFO/FDR, prospective, and release gates before execution.']
      : ['Fix governance/execution handling until event-risk-freeze and vol-stress block new opens while risk-reducing orders remain pass-through.'],
    safetyNotes: [
      'This artifact validates a fail-closed protection only; it cannot authorize paper orders, live orders, promotion, leverage, or best_config mutation.',
      'Reduce pass-through is only for existing risk reduction; it is not permission to open, add, or flip exposure.',
    ],
  }
}

function makeSnapshot(
  governance: ReturnType<typeof evaluateSignalGovernance>,
  freezeActive: boolean,
  maxActionDuringFreeze: RuntimeFactorSnapshot['freeze']['maxActionDuringFreeze'],
): RuntimeFactorSnapshot {
  return {
    symbol: 'BTC/USDT:USDT',
    factorSignals: [],
    governance,
    ensemble: {
      signals: [],
      weights: {},
      aggregateValue: 0.7,
      aggregateConfidence: 0.7,
      consensusScore: 1,
      decisionStrength: 'D1',
    },
    freeze: {
      active: freezeActive,
      marketScope: 'crypto',
      activeWindows: [],
      maxActionDuringFreeze,
    },
    derivedMetrics: {
      return1hPct: -3,
      return6hPct: -8,
      return24hPct: -15,
      return7dPct: -25,
      currentPrice: 50000,
      currentVolume: 200,
      averageVolume: 90,
      realizedVolPct: 95,
      openInterest: 1000,
      openInterestValue: 1000000,
      liquidationCount24h: 300,
      liquidationNotional24h: 50000000,
    },
    dataProvenance: createUnavailableStrategyDataProvenance(),
    metaLabeling: undefined,
    positionSizing: {
      allowed: true,
      maxPositionPctOfEquity: 0.3,
      recommendedPctOfEquity: 0.1,
      requestedPctOfEquity: 0.1,
      recommendedNotionalUsd: 1000,
      assetLayer: 'core',
      equity: 10000,
      method: 'fixed',
      reasons: [],
    },
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

function renderConsoleSummary(report: PanicRegimeNoOpenGateStatus): string {
  return [
    `Panic/regime no-open gate status: ${report.status}`,
    `eventFreeze=${report.checks.eventFreezeRegime}/${report.checks.eventFreezeOpenDecisionMode} volStress=${report.checks.volStressRegime}/${report.checks.volStressOpenDecisionMode}`,
    `paper=false live=false promotion=false`,
    `blockers=${report.blockers.slice(0, 8).join('|') || 'none'}`,
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_panic_regime_no_open_gate_status failed:', error)
    process.exit(1)
  })
}
