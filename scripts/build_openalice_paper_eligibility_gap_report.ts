/**
 * Paper Eligibility Gap Report — traces raw paper trades through the
 * promotion-eligibility filter chain.
 *
 * Reads `paper_pnl_diagnostics.latest.json`, `strategy_promotion.latest.json`,
 * `paper_decision.latest.json`, and P1 evidence artifacts to explain the
 * gap between 951 raw closed trades and 12 promotion-counted trades.
 *
 * Usage: npx tsx scripts/build_openalice_paper_eligibility_gap_report.ts
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

const RUNTIME_DIR = 'data/runtime'
const RESEARCH_DIR = 'data/research'

interface CliArgs {
  outputPath: string | null
  json: boolean
}

interface FunnelStage {
  stage: string
  count: number | null
  description: string
  extractable: boolean
  sourceField: string
}

interface ByLaneSummary {
  lane: string
  rawClosedTrades: number | null
  blocked: boolean
  blockReason: string | null
}

interface PaperEligibilityGapReport {
  schemaVersion: 1
  generatedAt: string
  rawClosedTrades: number | null
  promotionCountedTrades: number | null
  funnel: FunnelStage[]
  byLane: ByLaneSummary[]
  byBlockReason: Record<string, number | string>
  timeWindowMismatch: {
    pnlDiagnosticsGeneratedAt: string | null
    promotionGeneratedAt: string | null
    paperDecisionGeneratedAt: string | null
    description: string
  }
  evidenceCoverage: {
    okContextTrades: number | null
    withPredictedCost: number | null
    withMfeMae: number | null
    staleOrUntrusted: number | null
  }
  gapSummary: string
}

function parseArgs(argv: string[]): CliArgs {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq >= 0) {
      out.set(arg.slice(2, eq), arg.slice(eq + 1))
    } else {
      const key = arg.slice(2)
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        out.set(key, argv[++i])
      } else {
        out.set(key, 'true')
      }
    }
  }
  return {
    outputPath: out.get('outputPath') ?? out.get('output') ?? `${RUNTIME_DIR}/paper_eligibility_gap_report.latest.json`,
    json: out.has('json'),
  }
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function extractBlockersFromPromotion(
  blockList: unknown[] | undefined,
  prefix: string,
): string[] {
  if (!blockList) return []
  return blockList
    .filter((b): b is string => typeof b === 'string' && b.startsWith(prefix))
    .map(b => b.replace(prefix, ''))
}

export async function buildPaperEligibilityGapReport(args: CliArgs): Promise<PaperEligibilityGapReport> {
  const generatedAt = new Date().toISOString()

  // Input sources
  const paperDiag = await readJsonIfExists(`${RESEARCH_DIR}/paper_pnl_diagnostics.latest.json`)
  const strategyPromotion = await readJsonIfExists(`${RUNTIME_DIR}/strategy_promotion.latest.json`)
  const paperDecision = await readJsonIfExists(`${RUNTIME_DIR}/paper_decision.latest.json`)
  const trialLedger = await readJsonIfExists(`${RUNTIME_DIR}/p1_trading_evidence/trial_ledger.latest.json`)
  const costModelDiag = await readJsonIfExists(`${RUNTIME_DIR}/p1_trading_evidence/cost_model_diagnostics.latest.json`)
  const lanePolicy = await readJsonIfExists(`${RUNTIME_DIR}/strategy_lane_policy.latest.json`)

  // Raw closed trades from paper diagnostics
  const overall = paperDiag?.overall as Record<string, unknown> | undefined
  const rawClosedTrades = readNumber(overall?.count) ?? readNumber(paperDiag?.count) ?? null

  // Promotion-counted trades from strategy_promotion paperGate
  const paperGate = strategyPromotion?.paperGate as Record<string, unknown> | undefined
  const paperGateMetrics = paperGate?.metricSnapshot as Record<string, unknown> | undefined
  const promotionCountedTrades = readNumber(paperGateMetrics?.paperTradesObserved) ?? null

  // Paper decision promotionReadiness
  const promotionReadiness = paperDecision?.promotionReadiness as Record<string, unknown> | undefined
  const promotionReadinessReasons = promotionReadiness?.reasons as string[] | undefined

  // Trial ledger status
  const trialLedgerStatus = readString(trialLedger?.status)
  const trialLedgerBlockers = trialLedger?.blockers as string[] | undefined

  // Cost model diagnostics
  const costModelStatus = readString(costModelDiag?.status)

  // Lane policy
  const laneBlocks = lanePolicy?.globalBlockers as string[] | undefined
  const laneSummary = lanePolicy?.summary as Record<string, unknown> | undefined
  const lanes = (lanePolicy?.lanes as Array<Record<string, unknown>> | undefined) ?? []

  // Build funnel stages with extractable flag
  const funnel: FunnelStage[] = [
    {
      stage: 'raw_closed',
      count: rawClosedTrades,
      description: 'total closed from paper_pnl_diagnostics.latest.json overall.count',
      extractable: rawClosedTrades !== null,
      sourceField: 'paper_pnl_diagnostics.latest.json.overall.count',
    },
    {
      stage: 'after_lane_block_filter',
      count: null,
      description: 'lanes blocked by strategy_lane_policy.latest.json — promotion gate does not expose filtered-out trades by lane',
      extractable: false,
      sourceField: 'strategy_lane_policy.latest.json.lanes[].lane + lanes[].paperExecutionAllowed',
    },
    {
      stage: 'after_legacy_context_filter',
      count: null,
      description: 'trades with missing open context snapshot — not tracked at trade level in current promotion pipeline',
      extractable: false,
      sourceField: 'paper_decision.latest.json.bestConfigEvidence.status (insufficient_data when unavailable)',
    },
    {
      stage: 'after_cost_filter',
      count: null,
      description: 'trades missing predicted cost at open — cost_model_diagnostics.latest.json shows overall status',
      extractable: false,
      sourceField: 'p1_trading_evidence/cost_model_diagnostics.latest.json',
    },
    {
      stage: 'after_p1_evidence_filter',
      count: null,
      description: 'trades failing P1 evidence trust (gate, cost, MFE/MAE, trial ledger, stoploss)',
      extractable: false,
      sourceField: 'strategy_promotion.latest.json paperGate.hardBlocks (p1_evidence_trust_not_pass:*)',
    },
    {
      stage: 'after_stale_artifact_filter',
      count: null,
      description: 'trades in quarantined/untrusted evidence windows — dirty worktree + stale artifacts block all',
      extractable: false,
      sourceField: 'dirty worktree audit + artifact manifest trust status',
    },
    {
      stage: 'promotion_counted',
      count: promotionCountedTrades,
      description: 'trades surviving filter chain — from strategy_promotion.latest.json paperGate.metricSnapshot.paperTradesObserved',
      extractable: promotionCountedTrades !== null,
      sourceField: 'strategy_promotion.latest.json.paperGate.metricSnapshot.paperTradesObserved',
    },
  ]

  // By-lane summary
  const byLane: ByLaneSummary[] = lanes.map(l => ({
    lane: readString(l.lane) ?? 'unknown',
    rawClosedTrades: null,
    blocked: l.paperExecutionAllowed !== true,
    blockReason: (l.reasons as string[] | undefined)?.join('; ') ?? null,
  }))

  // By block reason from paper gate hard blocks
  const paperHardBlocks = paperGate?.hardBlocks as string[] | undefined
  const blockReasonCounts: Record<string, number | string> = {}
  if (paperHardBlocks) {
    for (const block of paperHardBlocks) {
      const key = block.split(':')[0] ?? block
      blockReasonCounts[key] = (blockReasonCounts[key] as number ?? 0) + 1
    }
  }

  // Time window mismatch
  const timeWindowMismatch = {
    pnlDiagnosticsGeneratedAt: readString(paperDiag?.generatedAt),
    promotionGeneratedAt: readString(strategyPromotion?.generatedAt),
    paperDecisionGeneratedAt: readString(paperDecision?.generatedAt),
    description: 'promotion gate uses paper_decision.latest.json.promotionReadiness, which itself references paper_pnl_diagnostics. If timestamps diverge, counts may come from different evaluation windows.',
  }

  // Evidence coverage (from available artifacts)
  const evidenceCoverage = {
    okContextTrades: null,
    withPredictedCost: costModelStatus === 'blocked' ? null : null,
    withMfeMae: null,
    staleOrUntrusted: null,
  }

  // Gap summary
  const gapSummary = [
    `Raw paper_pnl_diagnostics reports ${rawClosedTrades ?? 'unknown'} closed trades.`,
    `Promotion gate counts ${promotionCountedTrades ?? 'unknown'} eligible trades.`,
    `The gap cannot be fully decomposed because the promotion gate does not expose intermediate filter stage counts.`,
    `Known blockers that exclude trades:`,
    ...(paperHardBlocks ?? []).slice(0, 10).map(b => `  - ${b}`),
    `To enable full decomposition in the future, the promotion builder should emit intermediate stage counts`,
    `(e.g., totalTradesInLane, tradesAfterContextFilter, tradesAfterCostFilter, tradesAfterP1Evidence).`,
  ].join('\n')

  return {
    schemaVersion: 1,
    generatedAt,
    rawClosedTrades,
    promotionCountedTrades,
    funnel,
    byLane,
    byBlockReason: blockReasonCounts,
    timeWindowMismatch,
    evidenceCoverage,
    gapSummary,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const report = await buildPaperEligibilityGapReport(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  }

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'paper_eligibility_gap_report',
      artifactPath: outputPath,
      startedAt: new Date(report.generatedAt),
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.promotionCountedTrades === report.rawClosedTrades ? 'pass' : 'warn',
      recordsIn: report.funnel.length + report.byLane.length,
      recordsOut: 1,
      errorClass: report.promotionCountedTrades === null ? 'promotion_count_missing' : null,
    })
    console.log(`Wrote eligibility gap report to ${outputPath}`)
  }
}

const invokedPath = resolve(pathToFileURL(process.argv[1]!).pathname)
if (invokedPath === resolve(process.argv[1]!)) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
