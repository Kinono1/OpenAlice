import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import {
  OPENALICE_STRATEGY_FAMILY_CONTRACTS,
  validateStrategyFamilyContract,
  type StrategyFamilyContract,
} from '../src/strategy/contracts/strategy_family_contract.js'

type PlanStatus = 'ready_for_research_only_experiments' | 'blocked_missing_inputs'
type ExperimentPriority = 'high' | 'medium' | 'low'
type ExperimentDecision = 'admit_research_only' | 'watch_only' | 'blocked'

interface CliArgs {
  retirementPath: string
  alphaPoolPath: string
  systemStatusPath: string
  outputPath: string | null
  json: boolean
}

export interface NextResearchExperimentCard {
  experimentId: string
  familyId: string
  priority: ExperimentPriority
  decision: ExperimentDecision
  rationale: string[]
  hypothesis: string
  intervention: string
  controls: string[]
  requiredFeatures: string[]
  requiredArtifacts: string[]
  commands: string[]
  metrics: string[]
  killCriteria: string[]
  promotionPrerequisites: string[]
  blockedBy: string[]
  paperTradingAllowed: false
  liveTradingAllowed: false
}

export interface NextResearchHypothesisPlanReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionAllowed: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  policyMutationAllowed: false
  planStatus: PlanStatus
  inputs: {
    retirementPath: string
    alphaPoolPath: string
    systemStatusPath: string
  }
  retirementContext: {
    verdict: string | null
    lineHealth: string | null
    primaryCandidateId: string | null
    activeIncubationCandidates: number | null
    retirementRecommendedLines: number | null
    requiredBeforeReactivation: string[]
  }
  alphaPoolSummary: {
    present: boolean
    entries: number
    acceptedForRuntime: number
    alphaIds: string[]
  }
  systemContext: {
    effectiveActionability: string | null
    overallPlanCompletionPct: number | null
    paperTradingAllowed: boolean | null
    liveTradingAllowed: boolean | null
    canPromote: boolean | null
  }
  forbiddenContinuations: Array<{
    lineId: string
    reason: string
    allowedOnlyIf: string[]
  }>
  experimentCards: NextResearchExperimentCard[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_RETIREMENT_PATH = 'data/research/research_line_retirement.latest.json'
const DEFAULT_ALPHA_POOL_PATH = 'data/research/alpha_pool/latest.json'
const DEFAULT_SYSTEM_STATUS_PATH = 'data/runtime/system_status_reason_chain.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/research/next_research_hypothesis_plan.latest.json'

export function parseNextResearchHypothesisPlanArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    retirementPath: raw.get('retirementPath') ?? raw.get('retirement') ?? DEFAULT_RETIREMENT_PATH,
    alphaPoolPath: raw.get('alphaPoolPath') ?? raw.get('alphaPool') ?? DEFAULT_ALPHA_POOL_PATH,
    systemStatusPath: raw.get('systemStatusPath') ?? raw.get('systemStatus') ?? DEFAULT_SYSTEM_STATUS_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runNextResearchHypothesisPlan(
  args: CliArgs,
): Promise<NextResearchHypothesisPlanReport> {
  const startedAt = new Date()
  const inputPaths = {
    retirementPath: resolve(args.retirementPath),
    alphaPoolPath: resolve(args.alphaPoolPath),
    systemStatusPath: resolve(args.systemStatusPath),
  }
  const report = buildNextResearchHypothesisPlanReport({
    inputs: inputPaths,
    retirement: await readJsonIfExists(inputPaths.retirementPath),
    alphaPool: await readJsonIfExists(inputPaths.alphaPoolPath),
    systemStatus: await readJsonIfExists(inputPaths.systemStatusPath),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'next_research_hypothesis_plan',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.planStatus === 'ready_for_research_only_experiments' ? 'warn' : 'fail',
      recordsIn: report.alphaPoolSummary.entries,
      recordsOut: report.experimentCards.length,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export function buildNextResearchHypothesisPlanReport(input: {
  inputs: NextResearchHypothesisPlanReport['inputs']
  retirement?: unknown
  alphaPool?: unknown
  systemStatus?: unknown
  generatedAt?: string
}): NextResearchHypothesisPlanReport {
  const retirement = asRecord(input.retirement)
  const alphaPool = asRecord(input.alphaPool)
  const systemStatus = asRecord(input.systemStatus)
  const alphaEntries = readRecords(alphaPool?.entries)
  const retirementSummary = asRecord(retirement?.summary)
  const primaryLine = asRecord(retirement?.primaryLine)
  const requiredBeforeReactivation = readStringArray(retirement?.requiredBeforeReactivation)
  const retirementVerdict = readString(retirement?.verdict)
  const planBlockers = uniqueStrings([
    ...(retirement ? [] : ['research_line_retirement_missing']),
    ...(alphaPool ? [] : ['alpha_pool_missing']),
    ...(systemStatus ? [] : ['system_status_reason_chain_missing']),
    ...(retirementVerdict === 'retire_current_line' || retirementVerdict === 'no_active_line'
      ? []
      : [`retirement_verdict_not_ready:${retirementVerdict ?? 'missing'}`]),
  ])
  const cards = buildExperimentCards({
    retirementVerdict,
    alphaEntries,
    effectiveActionability: readString(systemStatus?.effectiveActionability),
  })
  const forbiddenContinuations = buildForbiddenContinuations(retirement)

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    diagnosticOnly: true,
    promotionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    policyMutationAllowed: false,
    planStatus: planBlockers.some(blocker =>
      blocker === 'research_line_retirement_missing' ||
      blocker === 'alpha_pool_missing' ||
      blocker === 'system_status_reason_chain_missing'
    )
      ? 'blocked_missing_inputs'
      : 'ready_for_research_only_experiments',
    inputs: {
      retirementPath: resolve(input.inputs.retirementPath),
      alphaPoolPath: resolve(input.inputs.alphaPoolPath),
      systemStatusPath: resolve(input.inputs.systemStatusPath),
    },
    retirementContext: {
      verdict: retirementVerdict,
      lineHealth: readString(retirement?.lineHealth),
      primaryCandidateId: readString(primaryLine?.candidateId),
      activeIncubationCandidates: readNumber(retirementSummary?.activeIncubationCandidates),
      retirementRecommendedLines: readNumber(retirementSummary?.retirementRecommendedLines),
      requiredBeforeReactivation,
    },
    alphaPoolSummary: {
      present: alphaPool != null,
      entries: alphaEntries.length,
      acceptedForRuntime: alphaEntries.filter(entry => readBool(entry.acceptedForRuntime) === true).length,
      alphaIds: alphaEntries.map(entry => readString(entry.alphaId)).filter((item): item is string => item != null),
    },
    systemContext: {
      effectiveActionability: readString(systemStatus?.effectiveActionability),
      overallPlanCompletionPct: readNumber(systemStatus?.overallPlanCompletionPct),
      paperTradingAllowed: readBool(systemStatus?.paperTradingAllowed),
      liveTradingAllowed: readBool(systemStatus?.liveTradingAllowed),
      canPromote: readBool(systemStatus?.canPromote),
    },
    forbiddenContinuations,
    experimentCards: cards,
    blockers: uniqueStrings([
      ...planBlockers,
      ...cards.flatMap(card => card.blockedBy.map(blocker => `experiment:${card.experimentId}:${blocker}`)),
      ...(forbiddenContinuations.length > 0 ? ['retired_line_parameter_search_forbidden'] : []),
    ]),
    nextActions: [
      'Use this plan to choose the next research-only experiment; do not run broad random search on retired RankIC/liquidity reversal diagnostics.',
      'Before running any admitted experiment, append its card to the trial ledger with PIT feature availability and FDR family accounting.',
      'Keep OKX data, runtime fees, and prospective ledgers fresh while new hypotheses are tested.',
      'Paper/live execution remains disabled until release, WFO, trial ledger, BY FDR, PIT, prospective, and paper-evidence gates pass.',
    ],
    safetyNotes: [
      'This artifact cannot authorize paper orders, live orders, leverage, best_config writes, or policy mutation.',
      'The goal is to improve research direction after a retired line, not to claim profitability.',
      'A new experiment is admissible only as live-only research until closed prospective evidence exists.',
    ],
  }
}

function buildExperimentCards(input: {
  retirementVerdict: string | null
  alphaEntries: Record<string, unknown>[]
  effectiveActionability: string | null
}): NextResearchExperimentCard[] {
  const cards = [
    cardFromContract({
      contract: OPENALICE_STRATEGY_FAMILY_CONTRACTS.funding_carry_rebuild,
      priority: 'high',
      hypothesis:
        'Funding and basis dislocations are a different economic mechanism than the retired reversal line and should be tested as cashflow-first carry, not rank-spread retuning.',
      intervention:
        'Build a funding/basis carry research lane using runtime funding, basis, fees, and stressed unwind cost; evaluate 8h decision cadence with locked PIT cashflow accounting.',
      controls: [
        'flat no-trade carry benchmark',
        'equal-weight BTC/ETH/SOL benchmark',
        'funding-only without basis control',
      ],
      commands: [
        './node_modules/.bin/tsx scripts/refresh_eth_carry_pipeline.ts',
        './node_modules/.bin/tsx scripts/refresh_eth_carry_runtime_status.ts',
      ],
      metrics: [
        'net_carry_after_fees_bps',
        'stressed_unwind_cost_bps',
        'funding_capture_hit_rate',
        'drawdown_under_funding_regime_flip',
      ],
      killCriteria: [
        'net_carry_after_stressed_unwind_cost<=0 for two non-overlapping 8h windows',
        'funding_or_basis_available_time_missing in any promotion sample',
        'cost_model_quarantine persists after runtime fee refresh',
        'single-symbol contribution exceeds 35% of gross edge',
      ],
    }),
    cardFromContract({
      contract: OPENALICE_STRATEGY_FAMILY_CONTRACTS.liquidation_aftermath_oi_confirmation,
      priority: 'high',
      hypothesis:
        'Liquidation aftermath plus open-interest confirmation can capture post-event continuation/reversal without relying on the retired RankIC reversal family.',
      intervention:
        'Create event-driven liquidation/OI observation windows with explicit event quality, OI confirmation lag, and post-event liquidity gates.',
      controls: [
        'same-symbol random event-time windows',
        'liquidation event without OI confirmation',
        'OI shock without liquidation event',
      ],
      commands: [
        './node_modules/.bin/tsx scripts/collect_external_derivatives_data.ts',
        './node_modules/.bin/tsx scripts/build_research_incubation_plan.ts',
      ],
      metrics: [
        'event_quality_coverage_pct',
        'post_event_net_spread_after_cost_pct',
        'closed_event_count',
        'oi_confirmation_lag_minutes',
      ],
      killCriteria: [
        'closed_event_count<12 after 14 live-only days',
        'post_event_net_spread_after_cost_pct<=0 across two non-overlapping event windows',
        'open_interest_confirmation_lag violates PIT available_time policy',
        'route_cost_budget exceeded for selected execution route',
      ],
    }),
    cardFromContract({
      contract: OPENALICE_STRATEGY_FAMILY_CONTRACTS.kronos_forecast_shadow,
      priority: 'medium',
      hypothesis:
        'Forecast models may add context only if they beat simple linear baselines out of sample; they must stay diagnostic and non-executing.',
      intervention:
        'Run Kronos-style forecasts as shadow-only features with model provenance hashes and linear baseline comparison; do not convert forecasts to orders.',
      controls: [
        'linear return baseline',
        'last-return persistence baseline',
        'no-forecast feature set',
      ],
      commands: [
        './node_modules/.bin/tsx scripts/build_ic_monitor_status.ts',
      ],
      metrics: [
        'forecast_incremental_ic',
        'linear_baseline_delta_ic',
        'model_provenance_hash_coverage',
        'feature_available_time_coverage_pct',
      ],
      killCriteria: [
        'forecast_incremental_ic<=0 after 50 closed shadow labels',
        'linear_baseline_delta_ic<=0 in two non-overlapping windows',
        'model_provenance_hash missing for any candidate forecast row',
      ],
    }),
  ]

  return cards.map(card => {
    const alphaCoverage = card.requiredFeatures.some(feature =>
      input.alphaEntries.some(entry => readStringArray(entry.featureNames).includes(feature)),
    )
    const blockedBy = uniqueStrings([
      ...(input.retirementVerdict === 'retire_current_line' || input.retirementVerdict === 'no_active_line'
        ? []
        : [`retirement_context_not_ready:${input.retirementVerdict ?? 'missing'}`]),
      ...(input.effectiveActionability === 'research_only_blocked' || input.effectiveActionability === 'paper_execution_blocked'
        ? []
        : [`unexpected_actionability:${input.effectiveActionability ?? 'missing'}`]),
      ...card.blockedBy,
    ])
    return {
      ...card,
      decision: card.decision === 'blocked'
        ? 'blocked'
        : alphaCoverage || card.familyId === 'funding_carry_rebuild'
          ? 'admit_research_only'
          : 'watch_only',
      blockedBy,
    }
  })
}

function cardFromContract(input: {
  contract: StrategyFamilyContract
  priority: ExperimentPriority
  hypothesis: string
  intervention: string
  controls: string[]
  commands: string[]
  metrics: string[]
  killCriteria: string[]
}): NextResearchExperimentCard {
  const validation = validateStrategyFamilyContract(input.contract)
  return {
    experimentId: `${input.contract.familyId}_next_research`,
    familyId: input.contract.familyId,
    priority: input.priority,
    decision: validation.passed ? 'admit_research_only' : 'blocked',
    rationale: [
      `contract_role:${input.contract.role}`,
      `next_mutation_allowed:${input.contract.nextMutationAllowed}`,
      `promotion_eligibility:${input.contract.promotionEligibility}`,
    ],
    hypothesis: input.hypothesis,
    intervention: input.intervention,
    controls: input.controls,
    requiredFeatures: input.contract.requiredFeatures.map(feature => feature.featureId),
    requiredArtifacts: [
      'data/runtime/fee_snapshot_refresh.latest.json',
      'data/runtime/system_status_reason_chain.latest.json',
      'data/research/research_line_retirement.latest.json',
      'data/runtime/p1_trading_evidence/trial_ledger.latest.json',
    ],
    commands: input.commands,
    metrics: input.metrics,
    killCriteria: [
      ...input.killCriteria,
      'paperTradingAllowed or liveTradingAllowed becomes true from this artifact',
      'trial is missing from complete trial ledger or BY FDR family accounting',
    ],
    promotionPrerequisites: [
      `min_live_only_days:${input.contract.paperEvidenceRequirement.minLiveOnlyDays}`,
      `min_decision_count:${input.contract.paperEvidenceRequirement.minDecisionCount}`,
      `min_executed_trade_count:${input.contract.paperEvidenceRequirement.minExecutedTradeCount}`,
      `min_event_count:${input.contract.paperEvidenceRequirement.minEventCount}`,
      'runtime_fee_snapshot_verified',
      'pit_audit_pass',
      'by_fdr_pass',
      'wfo_pass',
      'paper_execution_evidence_pass',
    ],
    blockedBy: validation.blockingReasons,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
  }
}

function buildForbiddenContinuations(retirement: Record<string, unknown> | null): NextResearchHypothesisPlanReport['forbiddenContinuations'] {
  const retiredLines = readRecords(retirement?.retiredLines)
  return retiredLines.slice(0, 12).map(line => ({
    lineId: readString(line.lineId) ?? readString(line.candidateId) ?? 'retired_line',
    reason: readStringArray(line.killTriggers).join('|') || 'line_retired',
    allowedOnlyIf: [
      'new_alpha_hypothesis_or_materially_different_feature_set',
      'wfo_failed_window_ratio_lte_threshold_and_direction_stable',
      'complete_trial_ledger_with_by_fdr',
      'pit_audit_pass',
    ],
  }))
}

async function readJsonIfExists(path: string): Promise<unknown> {
  const resolved = resolve(path)
  if (!existsSync(resolved)) return null
  return JSON.parse(await readFile(resolved, 'utf-8'))
}

function readRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Record<string, unknown> => item != null)
    : []
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function readBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const tokens = argv.filter(token => token !== '--')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token?.startsWith('--')) continue
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      out.set(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    const next = tokens[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(body, next)
      index += 1
    } else {
      out.set(body, 'true')
    }
  }
  return out
}

function parseNullablePath(raw: string | undefined): string | null {
  if (raw == null) return null
  const normalized = raw.trim().toLowerCase()
  return !normalized || normalized === 'null' || normalized === 'false' || normalized === 'none'
    ? null
    : raw
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

function renderConsoleSummary(report: NextResearchHypothesisPlanReport): string {
  return [
    `next research hypothesis plan: status=${report.planStatus}, cards=${report.experimentCards.length}`,
    `retirement=${report.retirementContext.verdict ?? 'missing'}, actionability=${report.systemContext.effectiveActionability ?? 'missing'}`,
    ...report.experimentCards.map(card =>
      `${card.priority} | ${card.decision} | ${card.familyId} | blockers=${card.blockedBy.join('|') || 'none'}`,
    ),
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = parseNextResearchHypothesisPlanArgs(process.argv.slice(2))
  runNextResearchHypothesisPlan(args)
    .then(report => {
      if (args.json) console.log(JSON.stringify(report, null, 2))
      else console.log(renderConsoleSummary(report))
    })
    .catch(error => {
      console.error('build_next_research_hypothesis_plan failed:', error)
      process.exit(1)
    })
}
