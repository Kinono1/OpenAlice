import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { buildStrategyExecutionDecision } from '../src/domain/strategy/execution.js'
import { evaluateSignalGovernance } from '../src/domain/strategy/governance/index.js'
import { createUnavailableStrategyDataProvenance } from '../src/domain/strategy/runtime-types.js'
import type { RuntimeFactorSnapshot } from '../src/domain/strategy/runtime-evaluator.js'

type Status = 'pass' | 'blocked'

interface CliArgs {
  outputPath: string | null
  json: boolean
}

export interface StaleDataNoOpenGateStatus {
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
    staleHighConfidenceActionStatus: string
    freshHighConfidenceActionStatus: string
    staleOpenDecisionMode: string
    staleOpenBlockReason: string | null
    staleReduceDecisionMode: string
    staleReducePassThrough: boolean
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/stale_data_no_open_gate_status.latest.json'

async function main(): Promise<void> {
  const args = parseStaleDataNoOpenGateStatusArgs(process.argv.slice(2))
  const report = await runStaleDataNoOpenGateStatus(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }
}

export function parseStaleDataNoOpenGateStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runStaleDataNoOpenGateStatus(args: CliArgs): Promise<StaleDataNoOpenGateStatus> {
  const startedAt = new Date()
  const report = buildStaleDataNoOpenGateStatus(new Date().toISOString())
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'stale_data_no_open_gate_status',
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

export function buildStaleDataNoOpenGateStatus(generatedAt = new Date().toISOString()): StaleDataNoOpenGateStatus {
  const staleGovernance = evaluateSignalGovernance(
    {
      sourceTier: 'L1',
      useType: 'U1',
      decisionStrength: 'D1',
      sentiment: 'S0',
    },
    { staleData: true },
  )
  const freshGovernance = evaluateSignalGovernance(
    {
      sourceTier: 'L1',
      useType: 'U1',
      decisionStrength: 'D1',
      sentiment: 'S0',
    },
    { staleData: false },
  )
  const staleSnapshot = makeSnapshot(staleGovernance)
  const staleOpenDecision = buildStrategyExecutionDecision({
    snapshot: staleSnapshot,
    request: {
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'market',
      usd_size: 2500,
    },
    exposureClassification: 'open',
  })
  const staleReduceDecision = buildStrategyExecutionDecision({
    snapshot: staleSnapshot,
    request: {
      symbol: 'BTC/USDT:USDT',
      side: 'sell',
      type: 'market',
      usd_size: 2500,
    },
    exposureClassification: 'reduce',
  })

  const blockers = [
    ...(staleGovernance.actionStatus === 'no-trade' ? [] : [`stale_governance_not_no_trade:${staleGovernance.actionStatus}`]),
    ...(freshGovernance.actionStatus !== 'no-trade' ? [] : ['fresh_high_confidence_signal_unexpectedly_no_trade']),
    ...(staleOpenDecision.mode === 'blocked' ? [] : [`stale_new_open_not_blocked:${staleOpenDecision.mode}`]),
    ...(staleOpenDecision.blockReason?.includes('no-trade') === true ? [] : ['stale_new_open_block_reason_missing_no_trade']),
    ...(staleReduceDecision.mode === 'pass-through' ? [] : [`stale_reduce_not_pass_through:${staleReduceDecision.mode}`]),
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
      staleHighConfidenceActionStatus: staleGovernance.actionStatus,
      freshHighConfidenceActionStatus: freshGovernance.actionStatus,
      staleOpenDecisionMode: staleOpenDecision.mode,
      staleOpenBlockReason: staleOpenDecision.blockReason ?? null,
      staleReduceDecisionMode: staleReduceDecision.mode,
      staleReducePassThrough: staleReduceDecision.mode === 'pass-through',
    },
    blockers,
    nextActions: blockers.length === 0
      ? ['Keep stale-data no-open validation in the research-evidence refresh chain and continue requiring release gates for any execution.']
      : ['Fix governance/execution stale-data handling until stale inputs block new opens while risk-reducing orders remain pass-through.'],
    safetyNotes: [
      'This artifact validates a fail-closed protection only; it cannot authorize paper orders, live orders, promotion, leverage, or best_config mutation.',
      'Risk-reducing pass-through here is diagnostic behavior, not permission to open or add exposure.',
    ],
  }
}

function makeSnapshot(governance: ReturnType<typeof evaluateSignalGovernance>): RuntimeFactorSnapshot {
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
      active: false,
      marketScope: 'crypto',
      activeWindows: [],
      maxActionDuringFreeze: undefined,
    },
    derivedMetrics: {
      return1hPct: 1,
      return6hPct: 2,
      return24hPct: 3,
      return7dPct: 4,
      currentPrice: 50000,
      currentVolume: 100,
      averageVolume: 90,
      realizedVolPct: 10,
      openInterest: 1000,
      openInterestValue: 1000000,
      liquidationCount24h: 2,
      liquidationNotional24h: 500000,
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

function renderConsoleSummary(report: StaleDataNoOpenGateStatus): string {
  return [
    `Stale-data no-open gate status: ${report.status}`,
    `staleAction=${report.checks.staleHighConfidenceActionStatus} staleOpen=${report.checks.staleOpenDecisionMode} staleReduce=${report.checks.staleReduceDecisionMode}`,
    `paper=false live=false promotion=false`,
    `blockers=${report.blockers.slice(0, 8).join('|') || 'none'}`,
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_stale_data_no_open_gate_status failed:', error)
    process.exit(1)
  })
}
