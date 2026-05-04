import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import type { EvidenceManifest } from '../src/runtime/evidence_manifest.js'

const DEFAULT_P1_EVIDENCE_INDEX_PATH = 'data/runtime/p1_trading_evidence/p1_trading_evidence.index.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/runtime/meta_labeling_shadow_readiness.latest.json'

export interface MetaLabelingShadowReadinessArgs {
  p1EvidenceIndexPath: string
  outputPath: string | null
  json: boolean
}

export interface MetaLabelingShadowReadinessReport {
  schemaVersion: 1
  generatedAt: string
  mode: 'shadow_only_readiness'
  primaryObjective: 'outperform_skip_after_cost'
  trainingAllowed: boolean
  paperTradingAllowed: false
  liveTradingAllowed: false
  promotionAllowed: false
  modelMayControlLeverage: false
  modelMayRouteOrders: false
  status: 'ready_shadow_training' | 'blocked'
  minimums: {
    labeledShadowOutcomes: 300
    independentBetsPerSide: 100
    shadowContextCoveragePct: 95
    acceptedCostCoveragePct: 95
    fillAdjustedCoveragePct: 95
    requiredGateStatus: 'useful'
    requiredGateStatusBasis: 'cost_adjusted_accept_vs_skip_net_delta'
  }
  labels: {
    primary: 'outperform_skip_after_cost'
    auxiliary: ['stop_loss', 'tail_loss', 'positive_fill_adjusted_return']
  }
  evidencePaths: {
    p1EvidenceIndex: string
    p1EvidenceIndexManifest: string
    gateEffectiveness: string | null
    costModelDiagnostics: string | null
    trialLedger: string | null
  }
  evidenceTrust: {
    indexManifestPresent: boolean
    indexEvidenceTrust: EvidenceManifest['evidenceTrust'] | null
    indexDqStatus: EvidenceManifest['dqStatus'] | null
    indexGitDirty: boolean | null
    indexGitDirtyFilesCount: number | null
  }
  metrics: {
    gateStatus: string | null
    gateStatusBasis: string | null
    gateStatusDeltaPct: number | null
    acceptedClosedTrades: number
    acceptedWithPredictedCost: number
    acceptedCostCoveragePct: number | null
    fillAdjustedAcceptedTrades: number
    fillAdjustedSkippedTrades: number
    fillAdjustedCoveragePct: number | null
    skippedClosedOutcomes: number
    skippedWithPredictedCost: number
    acceptVsSkipNetDeltaPct: number | null
    acceptedIndependentBets: number
    skippedIndependentBets: number
    shadowContextCoveragePct: number | null
    shadowContextNewMissing: number
    trialLedgerStatus: string | null
    trialLedgerFdrGateStatus: string | null
    costNewWindowStatus: string | null
    costNewWindowReason: string | null
    costNewWindowClosedTrades: number
  }
  blockers: string[]
  nextActions: string[]
  notes: string[]
}

type UnknownRecord = Record<string, unknown>

export function parseMetaLabelingShadowReadinessArgs(argv: string[]): MetaLabelingShadowReadinessArgs {
  const raw = parseRawArgs(argv)
  return {
    p1EvidenceIndexPath: raw.get('p1EvidenceIndexPath') ?? DEFAULT_P1_EVIDENCE_INDEX_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runMetaLabelingShadowReadiness(
  args: MetaLabelingShadowReadinessArgs,
): Promise<MetaLabelingShadowReadinessReport> {
  const startedAt = new Date()
  const p1EvidenceIndexPath = resolve(args.p1EvidenceIndexPath)
  const p1Index = asRecord(await readJsonIfExists(p1EvidenceIndexPath))
  const artifacts = asRecord(p1Index?.artifacts)
  const gatePath = readString(artifacts?.gateEffectiveness)
  const costPath = readString(artifacts?.costModelDiagnostics)
  const trialLedgerPath = readString(artifacts?.trialLedger)
  const report = buildMetaLabelingShadowReadinessReport({
    p1EvidenceIndexPath,
    p1EvidenceIndexManifest: await readJsonIfExists(`${p1EvidenceIndexPath}.manifest.json`),
    gateEffectiveness: gatePath ? await readJsonIfExists(gatePath) : null,
    costModelDiagnostics: costPath ? await readJsonIfExists(costPath) : null,
    trialLedger: trialLedgerPath ? await readJsonIfExists(trialLedgerPath) : null,
    evidencePaths: {
      p1EvidenceIndex: p1EvidenceIndexPath,
      p1EvidenceIndexManifest: `${p1EvidenceIndexPath}.manifest.json`,
      gateEffectiveness: gatePath ? resolve(gatePath) : null,
      costModelDiagnostics: costPath ? resolve(costPath) : null,
      trialLedger: trialLedgerPath ? resolve(trialLedgerPath) : null,
    },
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'meta_labeling_shadow_readiness',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.trainingAllowed ? 'pass' : 'warn',
      recordsIn: report.metrics.acceptedClosedTrades + report.metrics.skippedClosedOutcomes,
      recordsOut: report.blockers.length,
      errorClass: report.trainingAllowed ? null : 'meta_labeling_shadow_readiness_blocked',
    })
  }

  return report
}

export function buildMetaLabelingShadowReadinessReport(input: {
  p1EvidenceIndexPath: string
  p1EvidenceIndexManifest?: unknown
  gateEffectiveness?: unknown
  costModelDiagnostics?: unknown
  trialLedger?: unknown
  evidencePaths?: Partial<MetaLabelingShadowReadinessReport['evidencePaths']>
  generatedAt?: string
}): MetaLabelingShadowReadinessReport {
  const gate = asRecord(input.gateEffectiveness)
  const cost = asRecord(input.costModelDiagnostics)
  const trialLedger = asRecord(input.trialLedger)
  const indexManifest = asRecord(input.p1EvidenceIndexManifest)
  const indexGit = asRecord(indexManifest?.git)
  const costAdjusted = asRecord(gate?.costAdjusted)
  const independentBets = asRecord(gate?.independentBets)
  const shadowContextCoverage = asRecord(gate?.shadowContextCoverage)
  const costNewWindow = asRecord(cost?.newWindow)

  const acceptedClosedTrades = readNumber(costAdjusted?.acceptedClosedTrades) ?? 0
  const acceptedWithPredictedCost = readNumber(costAdjusted?.acceptedWithPredictedCost) ?? 0
  const acceptedCostCoveragePct = acceptedClosedTrades > 0
    ? acceptedWithPredictedCost / acceptedClosedTrades * 100
    : null
  const skippedClosedOutcomes = readNumber(costAdjusted?.skippedClosedOutcomes) ?? 0
  const skippedWithPredictedCost = readNumber(costAdjusted?.skippedWithPredictedCost) ?? 0
  const fillAdjusted = asRecord(gate?.fillAdjusted)
  const fillAdjustedAcceptedTrades = readNumber(fillAdjusted?.acceptedWithFillAdjustedCost) ?? 0
  const fillAdjustedSkippedTrades = readNumber(fillAdjusted?.skippedWithFillAdjustedCost) ?? 0
  const fillAdjustedCoveragePct = readNumber(fillAdjusted?.coveragePct) ??
    (acceptedClosedTrades + skippedClosedOutcomes > 0
      ? (fillAdjustedAcceptedTrades + fillAdjustedSkippedTrades) / (acceptedClosedTrades + skippedClosedOutcomes) * 100
      : null)
  const gateStatus = readString(gate?.gateStatus)
  const gateStatusBasis = readString(gate?.gateStatusBasis)
  const acceptVsSkipNetDeltaPct = readNumber(costAdjusted?.acceptVsSkipNetDeltaPct)
  const acceptedIndependentBets = readNumber(independentBets?.accepted) ?? 0
  const skippedIndependentBets = readNumber(independentBets?.skipped) ?? 0
  const shadowContextCoveragePct = readNumber(shadowContextCoverage?.coveragePct)
  const shadowContextNewMissing = readNumber(shadowContextCoverage?.newMissing) ?? 0
  const indexEvidenceTrust = readEvidenceTrust(indexManifest?.evidenceTrust)
  const indexDqStatus = readEvidenceTrust(indexManifest?.dqStatus)

  const blockers = [
    ...(!existsSync(resolve(input.p1EvidenceIndexPath)) ? ['p1_evidence_index_missing'] : []),
    ...(indexManifest ? [] : ['p1_evidence_index_manifest_missing']),
    ...(indexEvidenceTrust === 'pass' && indexDqStatus === 'pass'
      ? []
      : [`p1_evidence_index_not_trusted:${indexEvidenceTrust ?? 'missing'}:${indexDqStatus ?? 'missing'}`]),
    ...(gate ? [] : ['gate_effectiveness_missing']),
    ...(cost ? [] : ['cost_model_diagnostics_missing']),
    ...(trialLedger ? [] : ['trial_ledger_missing']),
    ...(gateStatus === 'useful' ? [] : [`gate_status_not_useful:${gateStatus ?? 'missing'}`]),
    ...(gateStatusBasis === 'cost_adjusted_accept_vs_skip_net_delta'
      ? []
      : [`gate_basis_not_cost_adjusted:${gateStatusBasis ?? 'missing'}`]),
    ...(acceptVsSkipNetDeltaPct != null && acceptVsSkipNetDeltaPct > 0
      ? []
      : [`accept_vs_skip_net_delta_not_positive:${acceptVsSkipNetDeltaPct ?? 'missing'}`]),
    ...(skippedClosedOutcomes >= 300 ? [] : [`labeled_shadow_outcomes_below_minimum:${skippedClosedOutcomes}<300`]),
    ...(acceptedIndependentBets >= 100 ? [] : [`accepted_independent_bets_below_minimum:${acceptedIndependentBets}<100`]),
    ...(skippedIndependentBets >= 100 ? [] : [`skipped_independent_bets_below_minimum:${skippedIndependentBets}<100`]),
    ...(shadowContextCoveragePct != null && shadowContextCoveragePct >= 95
      ? []
      : [`shadow_context_coverage_below_minimum:${shadowContextCoveragePct ?? 'missing'}<95`]),
    ...(shadowContextNewMissing === 0 ? [] : [`shadow_context_new_missing:${shadowContextNewMissing}`]),
    ...(acceptedCostCoveragePct != null && acceptedCostCoveragePct >= 95
      ? []
      : [`accepted_cost_coverage_below_minimum:${acceptedCostCoveragePct ?? 'missing'}<95`]),
    ...(fillAdjustedCoveragePct != null && fillAdjustedCoveragePct >= 95
      ? []
      : [`fill_adjusted_coverage_below_minimum:${fillAdjustedCoveragePct ?? 'missing'}<95`]),
    ...(readString(trialLedger?.status) === 'valid'
      ? []
      : [`trial_ledger_not_valid:${readString(trialLedger?.status) ?? 'missing'}`]),
    ...(readString(costNewWindow?.status) === 'ok'
      ? []
      : [`post_enforcement_cost_window_not_ok:${readString(costNewWindow?.status) ?? 'missing'}:${readString(costNewWindow?.reason) ?? 'missing'}`]),
  ]
  const trainingAllowed = blockers.length === 0

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    mode: 'shadow_only_readiness',
    primaryObjective: 'outperform_skip_after_cost',
    trainingAllowed,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    promotionAllowed: false,
    modelMayControlLeverage: false,
    modelMayRouteOrders: false,
    status: trainingAllowed ? 'ready_shadow_training' : 'blocked',
    minimums: {
      labeledShadowOutcomes: 300,
      independentBetsPerSide: 100,
      shadowContextCoveragePct: 95,
      acceptedCostCoveragePct: 95,
      fillAdjustedCoveragePct: 95,
      requiredGateStatus: 'useful',
      requiredGateStatusBasis: 'cost_adjusted_accept_vs_skip_net_delta',
    },
    labels: {
      primary: 'outperform_skip_after_cost',
      auxiliary: ['stop_loss', 'tail_loss', 'positive_fill_adjusted_return'],
    },
    evidencePaths: {
      p1EvidenceIndex: resolve(input.p1EvidenceIndexPath),
      p1EvidenceIndexManifest: resolve(`${input.p1EvidenceIndexPath}.manifest.json`),
      gateEffectiveness: input.evidencePaths?.gateEffectiveness ?? null,
      costModelDiagnostics: input.evidencePaths?.costModelDiagnostics ?? null,
      trialLedger: input.evidencePaths?.trialLedger ?? null,
    },
    evidenceTrust: {
      indexManifestPresent: indexManifest != null,
      indexEvidenceTrust,
      indexDqStatus,
      indexGitDirty: readBoolean(indexGit?.dirty),
      indexGitDirtyFilesCount: readNumber(indexGit?.dirtyFilesCount),
    },
    metrics: {
      gateStatus,
      gateStatusBasis,
      gateStatusDeltaPct: readNumber(gate?.gateStatusDeltaPct),
      acceptedClosedTrades,
      acceptedWithPredictedCost,
      acceptedCostCoveragePct,
      fillAdjustedAcceptedTrades,
      fillAdjustedSkippedTrades,
      fillAdjustedCoveragePct,
      skippedClosedOutcomes,
      skippedWithPredictedCost,
      acceptVsSkipNetDeltaPct,
      acceptedIndependentBets,
      skippedIndependentBets,
      shadowContextCoveragePct,
      shadowContextNewMissing,
      trialLedgerStatus: readString(trialLedger?.status),
      trialLedgerFdrGateStatus: readString(trialLedger?.fdrGateStatus),
      costNewWindowStatus: readString(costNewWindow?.status),
      costNewWindowReason: readString(costNewWindow?.reason),
      costNewWindowClosedTrades: readNumber(costNewWindow?.closedTrades) ?? 0,
    },
    blockers,
    nextActions: trainingAllowed
      ? [
          'Freeze this P1 evidence window before any shadow-only model training.',
          'Train only the outperform_skip_after_cost primary label; keep model recommendations out of execution.',
        ]
      : [
          'Do not train or deploy meta-labeling until P1 accept-vs-skip, cost coverage, PIT, and trial-ledger gates are ready.',
          'Collect post-enforcement accepted closed trades with complete predicted-open cost evidence.',
          'Keep meta-labeling shadow-only; it must not control live or paper leverage before two non-overlapping prospective windows.',
        ],
    notes: [
      'This readiness artifact is diagnostic-only. It cannot authorize paper orders, live orders, promotion, or leverage changes.',
      'The primary P1.5 label is outperform_skip_after_cost; stop_loss is only an auxiliary risk label.',
      'A dirty/quarantined P1 evidence manifest blocks readiness even if numeric samples look sufficient.',
    ],
  }
}

export function renderMetaLabelingShadowReadinessMarkdown(report: MetaLabelingShadowReadinessReport): string {
  const lines: string[] = []
  lines.push('# Meta-Labeling Shadow Readiness')
  lines.push('')
  lines.push(`Generated: \`${report.generatedAt}\``)
  lines.push(`Status: \`${report.status}\``)
  lines.push(`Training allowed: \`${report.trainingAllowed}\``)
  lines.push(`Primary objective: \`${report.primaryObjective}\``)
  lines.push('')
  lines.push('## Blockers')
  lines.push('')
  if (report.blockers.length === 0) {
    lines.push('- none')
  } else {
    for (const blocker of report.blockers) lines.push(`- ${blocker}`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return null
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    i++
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

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readEvidenceTrust(value: unknown): EvidenceManifest['evidenceTrust'] | null {
  return value === 'pass' || value === 'quarantine' || value === 'fail' ? value : null
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseMetaLabelingShadowReadinessArgs(argv)
  const report = await runMetaLabelingShadowReadiness(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderMetaLabelingShadowReadinessMarkdown(report))
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
