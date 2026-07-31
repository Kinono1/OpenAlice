import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runLedgerBoundFdrCorrection } from '../src/backtest/fdr.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import {
  latestEthCarryClosedOutcomesByObservationId,
  type EthCarryProspectiveObservationOutcome,
} from './settle_eth_carry_prospective_observations.js'

type UnknownRecord = Record<string, unknown>

type SweepStatus =
  | 'blocked_missing_inputs'
  | 'research_refinement_insufficient_evidence'
  | 'research_refinement_watch_only'

interface CliArgs {
  ledgerPath: string
  outputPath: string | null
  fundingAbsThresholds: number[]
  basisAbsThresholdsPct: number[]
  minTotalClosedOutcomes: number
  minVariantClosedOutcomes: number
  minWindowClosedOutcomes: number
  minWindows: number
  minWinRatePct: number
  minMeanNetPct: number
  maxFdrQ: number
  json: boolean
}

interface ClosedRow {
  observationId: string
  decisionTime: string
  decisionTimeMs: number
  direction: string
  fundingSpread: number | null
  basisSpreadDiffPct: number | null
  grossPct: number
  fundingCashflowPct: number | null
  routeCostPct: number | null
  netPct: number
  profitableNet: boolean
}

interface SweepWindow {
  windowIndex: number
  startTime: string | null
  endTime: string | null
  closedOutcomes: number
  meanNetPct: number | null
  winRatePct: number | null
  passed: boolean
  blockers: string[]
}

interface SweepVariant {
  variantId: string
  familyId: 'funding_carry_rebuild'
  researchOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  rule: {
    fundingSpreadSign: 'positive'
    basisSpreadDiffPctSign: 'positive'
    direction: 'short_eth_long_btc'
    minAbsFundingSpread: number
    minAbsBasisSpreadDiffPct: number
  }
  closedOutcomes: number
  wins: number
  losses: number
  winRatePct: number | null
  meanGrossPct: number | null
  meanFundingCashflowPct: number | null
  meanRouteCostPct: number | null
  meanNetPct: number | null
  netImprovementVsBaselinePct: number | null
  pValue: number
  pAdjustedBYRawM: number | null
  fdrPassed: boolean | null
  wfo: {
    status: 'insufficient_data' | 'fail' | 'pass_research_only'
    passedWindows: number
    failedWindows: number
    windowCount: number
    failedWindowRatio: number | null
    windows: SweepWindow[]
  }
  blockers: string[]
}

export interface EthCarryConfluenceRefinementSweepReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: SweepStatus
  sourceArtifacts: {
    ledgerPath: string
  }
  thresholds: {
    fundingAbsThresholds: number[]
    basisAbsThresholdsPct: number[]
    minTotalClosedOutcomes: number
    minVariantClosedOutcomes: number
    minWindowClosedOutcomes: number
    minWindows: number
    minWinRatePct: number
    minMeanNetPct: number
    maxFdrQ: number
  }
  evidenceCounts: {
    openEvents: number
    closedOutcomes: number
    matchedClosedRows: number
    variantsTested: number
  }
  trialLedger: {
    rawM: number
    rawMComplete: boolean
    includesFailedTrials: boolean
    fdrMethodPrimary: 'BY_raw_m'
    pValuePromotionGrade: false
  }
  baselineVariant: SweepVariant | null
  bestVariant: SweepVariant | null
  topVariants: SweepVariant[]
  allVariants: SweepVariant[]
  fdr: {
    status: 'not_computed' | 'computed_research_only'
    method: 'BY_raw_m'
    alpha: number
    bestVariantQValue: number | null
    bestVariantFdrPassed: boolean | null
    harmonicFactorCm: number | null
    blocker: string | null
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_LEDGER_PATH = 'data/research/eth_carry_prospective_observations.jsonl'
const DEFAULT_OUTPUT_PATH = 'data/research/eth_carry_confluence_refinement_sweep.latest.json'
const DEFAULT_FUNDING_ABS_THRESHOLDS = [0, 0.00004, 0.00006, 0.00008]
const DEFAULT_BASIS_ABS_THRESHOLDS_PCT = [0, 0.01, 0.02, 0.03]
const DEFAULT_MIN_TOTAL_CLOSED_OUTCOMES = 100
const DEFAULT_MIN_VARIANT_CLOSED_OUTCOMES = 30
const DEFAULT_MIN_WINDOW_CLOSED_OUTCOMES = 3
const DEFAULT_MIN_WINDOWS = 3
const DEFAULT_MIN_WIN_RATE_PCT = 55
const DEFAULT_MIN_MEAN_NET_PCT = 0
const DEFAULT_MAX_FDR_Q = 0.1

async function main(): Promise<void> {
  const args = parseEthCarryConfluenceRefinementSweepArgs(process.argv.slice(2))
  const report = await runEthCarryConfluenceRefinementSweep(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseEthCarryConfluenceRefinementSweepArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    ledgerPath: raw.get('ledgerPath') ?? raw.get('ledger') ?? DEFAULT_LEDGER_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    fundingAbsThresholds: parseNumberList(raw.get('fundingAbsThresholds'), DEFAULT_FUNDING_ABS_THRESHOLDS, 'fundingAbsThresholds'),
    basisAbsThresholdsPct: parseNumberList(raw.get('basisAbsThresholdsPct'), DEFAULT_BASIS_ABS_THRESHOLDS_PCT, 'basisAbsThresholdsPct'),
    minTotalClosedOutcomes: parsePositiveInteger(raw.get('minTotalClosedOutcomes'), DEFAULT_MIN_TOTAL_CLOSED_OUTCOMES, 'minTotalClosedOutcomes'),
    minVariantClosedOutcomes: parsePositiveInteger(raw.get('minVariantClosedOutcomes'), DEFAULT_MIN_VARIANT_CLOSED_OUTCOMES, 'minVariantClosedOutcomes'),
    minWindowClosedOutcomes: parsePositiveInteger(raw.get('minWindowClosedOutcomes'), DEFAULT_MIN_WINDOW_CLOSED_OUTCOMES, 'minWindowClosedOutcomes'),
    minWindows: parsePositiveInteger(raw.get('minWindows'), DEFAULT_MIN_WINDOWS, 'minWindows'),
    minWinRatePct: parseFiniteNumber(raw.get('minWinRatePct'), DEFAULT_MIN_WIN_RATE_PCT, 'minWinRatePct'),
    minMeanNetPct: parseFiniteNumber(raw.get('minMeanNetPct'), DEFAULT_MIN_MEAN_NET_PCT, 'minMeanNetPct'),
    maxFdrQ: parseProbability(raw.get('maxFdrQ'), DEFAULT_MAX_FDR_Q, 'maxFdrQ'),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runEthCarryConfluenceRefinementSweep(
  args: CliArgs,
): Promise<EthCarryConfluenceRefinementSweepReport> {
  const startedAt = new Date()
  const ledgerPath = resolve(args.ledgerPath)
  const events = readLedgerEvents(ledgerPath)
  const report = buildEthCarryConfluenceRefinementSweepReport({
    generatedAt: new Date().toISOString(),
    ledgerPath,
    ledgerExists: existsSync(ledgerPath),
    ledgerEvents: events,
    args,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'eth_carry_confluence_refinement_sweep',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'blocked_missing_inputs' ? 'fail' : 'warn',
      recordsIn: report.evidenceCounts.closedOutcomes,
      recordsOut: report.allVariants.length,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export function buildEthCarryConfluenceRefinementSweepReport(input: {
  generatedAt?: string
  ledgerPath: string
  ledgerExists: boolean
  ledgerEvents: UnknownRecord[]
  args: Pick<CliArgs, 'fundingAbsThresholds' | 'basisAbsThresholdsPct' | 'minTotalClosedOutcomes' | 'minVariantClosedOutcomes' | 'minWindowClosedOutcomes' | 'minWindows' | 'minWinRatePct' | 'minMeanNetPct' | 'maxFdrQ'>
}): EthCarryConfluenceRefinementSweepReport {
  const openEvents = input.ledgerEvents.filter(event => readString(event.eventType) === 'eth_carry_prospective_decision_open')
  const closedEvents = latestEthCarryClosedOutcomesByObservationId(
    input.ledgerEvents.filter(event => readString(event.eventType) === 'eth_carry_prospective_decision_closed') as EthCarryProspectiveObservationOutcome[],
  )
  const openById = new Map(openEvents.map(event => [readString(event.observationId) ?? '', event]))
  const rows = closedEvents
    .map(closed => buildClosedRow(openById.get(readString(closed.observationId) ?? ''), closed))
    .filter((row): row is ClosedRow => row != null)
  const baselineRows = rows.filter(row => matchesVariant(row, 0, 0))
  const baselineMeanNetPct = meanNullable(baselineRows.map(row => row.netPct))
  const variants = buildGrid(input.args.fundingAbsThresholds, input.args.basisAbsThresholdsPct)
    .map(rule => buildVariant({
      rows,
      baselineMeanNetPct,
      fundingThreshold: rule.fundingThreshold,
      basisThreshold: rule.basisThreshold,
      args: input.args,
    }))
  const fdrApplied = applyFdr(variants, input.args.maxFdrQ)
  const allVariants = fdrApplied.variants
  const baselineVariant = allVariants.find(variant =>
    variant.rule.minAbsFundingSpread === 0 &&
    variant.rule.minAbsBasisSpreadDiffPct === 0
  ) ?? null
  const bestVariant = selectBestVariant(allVariants)
  const missingInputBlockers = uniqueStrings([
    ...(input.ledgerExists ? [] : ['eth_carry_prospective_ledger_missing']),
    ...(openEvents.length > 0 ? [] : ['eth_carry_open_events_missing']),
    ...(closedEvents.length > 0 ? [] : ['eth_carry_closed_events_missing']),
    ...(rows.length > 0 ? [] : ['eth_carry_matched_closed_rows_missing']),
    ...(allVariants.length > 0 ? [] : ['refinement_variants_missing']),
  ])
  const bestBlockers = bestVariant?.blockers.map(blocker => `best_variant:${blocker}`) ?? ['best_variant_missing']
  const blockers = uniqueStrings([
    ...missingInputBlockers,
    ...(rows.length >= input.args.minTotalClosedOutcomes
      ? []
      : [`prospective_closed_outcomes_low:${rows.length}<${input.args.minTotalClosedOutcomes}`]),
    ...(bestVariant && bestVariant.closedOutcomes >= input.args.minVariantClosedOutcomes
      ? []
      : [`best_variant_closed_outcomes_low:${bestVariant?.closedOutcomes ?? 0}<${input.args.minVariantClosedOutcomes}`]),
    ...(bestVariant?.meanNetPct != null && bestVariant.meanNetPct > input.args.minMeanNetPct
      ? []
      : [`best_variant_mean_net_not_positive:${bestVariant?.meanNetPct ?? 'missing'}<=${input.args.minMeanNetPct}`]),
    ...(bestVariant?.winRatePct != null && bestVariant.winRatePct >= input.args.minWinRatePct
      ? []
      : [`best_variant_win_rate_low:${bestVariant?.winRatePct ?? 'missing'}<${input.args.minWinRatePct}`]),
    ...(bestVariant?.netImprovementVsBaselinePct != null && bestVariant.netImprovementVsBaselinePct > 0
      ? []
      : [`best_variant_no_improvement_vs_baseline:${bestVariant?.netImprovementVsBaselinePct ?? 'missing'}<=0`]),
    ...(fdrApplied.bestVariantQValue != null && fdrApplied.bestVariantQValue <= input.args.maxFdrQ
      ? []
      : [`by_fdr_q_not_passed:${fdrApplied.bestVariantQValue ?? 'missing'}>${input.args.maxFdrQ}`]),
    ...(bestVariant?.wfo.status === 'pass_research_only' ? [] : [`best_variant_wfo_${bestVariant?.wfo.status ?? 'missing'}`]),
    ...bestBlockers.filter(blocker => !blocker.includes('p_value_not_promotion_grade')).slice(0, 8),
    'p_values_research_only_not_promotion_grade',
    'research_only_not_execution_evidence',
    'paper_live_execution_disabled',
    'requires_independent_pit_wfo_fdr_route_cost_risk_and_paper_telemetry',
  ])
  const status = missingInputBlockers.length > 0
    ? 'blocked_missing_inputs'
    : blockers.every(isSafetyOrPromotionGradeBlocker)
      ? 'research_refinement_watch_only'
      : 'research_refinement_insufficient_evidence'

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status,
    sourceArtifacts: {
      ledgerPath: resolve(input.ledgerPath),
    },
    thresholds: {
      fundingAbsThresholds: input.args.fundingAbsThresholds,
      basisAbsThresholdsPct: input.args.basisAbsThresholdsPct,
      minTotalClosedOutcomes: input.args.minTotalClosedOutcomes,
      minVariantClosedOutcomes: input.args.minVariantClosedOutcomes,
      minWindowClosedOutcomes: input.args.minWindowClosedOutcomes,
      minWindows: input.args.minWindows,
      minWinRatePct: input.args.minWinRatePct,
      minMeanNetPct: input.args.minMeanNetPct,
      maxFdrQ: input.args.maxFdrQ,
    },
    evidenceCounts: {
      openEvents: openEvents.length,
      closedOutcomes: closedEvents.length,
      matchedClosedRows: rows.length,
      variantsTested: allVariants.length,
    },
    trialLedger: {
      rawM: allVariants.length,
      rawMComplete: allVariants.length > 0,
      includesFailedTrials: allVariants.length > 1,
      fdrMethodPrimary: 'BY_raw_m',
      pValuePromotionGrade: false,
    },
    baselineVariant,
    bestVariant,
    topVariants: [...allVariants].sort(compareVariants).slice(0, 8),
    allVariants,
    fdr: {
      status: fdrApplied.status,
      method: 'BY_raw_m',
      alpha: input.args.maxFdrQ,
      bestVariantQValue: fdrApplied.bestVariantQValue,
      bestVariantFdrPassed: fdrApplied.bestVariantFdrPassed,
      harmonicFactorCm: fdrApplied.harmonicFactorCm,
      blocker: fdrApplied.blocker,
    },
    blockers,
    nextActions: buildNextActions(status, bestVariant),
    safetyNotes: [
      'This refinement sweep is research-only and cannot authorize paper or live execution.',
      'The sweep uses prospective closed labels only; historical PIT feature rows are not treated as realized PnL.',
      'All threshold combinations are retained in raw_m for BY-FDR accounting, including empty and losing variants.',
      'Promotion still requires independent PIT WFO, promotion-grade FDR, route-cost and slippage stress, risk simulation, sufficient prospective labels, and paper telemetry.',
    ],
  }
}

function buildClosedRow(open: UnknownRecord | undefined, closed: UnknownRecord): ClosedRow | null {
  if (!open) return null
  const signal = asRecord(open.signal)
  const pitFeatures = asRecord(open.pitFeatures)
  const label = asRecord(closed.label)
  const direction = readString(signal?.direction)
  const decisionTime = readString(closed.decisionTime) ?? readString(open.decisionTime)
  const decisionTimeMs = readNumber(closed.decisionBarTime) ?? Date.parse(decisionTime ?? '')
  const grossPct = readNumber(label?.grossCarryPairReturnPct)
  const netPct = readNumber(label?.routeCostAdjustedNetPct)
  if (!direction || !decisionTime || !Number.isFinite(decisionTimeMs) || grossPct == null || netPct == null) return null
  return {
    observationId: readString(closed.observationId) ?? 'unknown',
    decisionTime,
    decisionTimeMs,
    direction,
    fundingSpread: readNumber(pitFeatures?.fundingSpread),
    basisSpreadDiffPct: readNumber(pitFeatures?.basisSpreadDiffPct),
    grossPct,
    fundingCashflowPct: readNumber(label?.fundingCashflowPct),
    routeCostPct: readNumber(label?.routeCostPct),
    netPct,
    profitableNet: netPct > 0,
  }
}

function buildGrid(
  fundingThresholds: number[],
  basisThresholds: number[],
): Array<{ fundingThreshold: number; basisThreshold: number }> {
  const out: Array<{ fundingThreshold: number; basisThreshold: number }> = []
  for (const fundingThreshold of uniqueNumbers(fundingThresholds)) {
    for (const basisThreshold of uniqueNumbers(basisThresholds)) {
      out.push({ fundingThreshold, basisThreshold })
    }
  }
  return out
}

function buildVariant(input: {
  rows: ClosedRow[]
  baselineMeanNetPct: number | null
  fundingThreshold: number
  basisThreshold: number
  args: Pick<CliArgs, 'minVariantClosedOutcomes' | 'minWindowClosedOutcomes' | 'minWindows' | 'minWinRatePct' | 'minMeanNetPct'>
}): SweepVariant {
  const matched = input.rows.filter(row => matchesVariant(row, input.fundingThreshold, input.basisThreshold))
  const wins = matched.filter(row => row.profitableNet).length
  const losses = matched.length - wins
  const meanNetPct = meanNullable(matched.map(row => row.netPct))
  const winRatePct = matched.length > 0 ? round(wins / matched.length * 100, 10) : null
  const windows = buildWindows({
    rows: matched,
    minWindows: input.args.minWindows,
    minWindowClosedOutcomes: input.args.minWindowClosedOutcomes,
    minWinRatePct: input.args.minWinRatePct,
    minMeanNetPct: input.args.minMeanNetPct,
  })
  const failedWindows = windows.filter(window => !window.passed).length
  const passedWindows = windows.filter(window => window.passed).length
  const windowCount = windows.length
  const wfoStatus: SweepVariant['wfo']['status'] = windowCount < input.args.minWindows ||
    windows.some(window => window.closedOutcomes < input.args.minWindowClosedOutcomes)
    ? 'insufficient_data'
    : failedWindows === 0
      ? 'pass_research_only'
      : 'fail'
  const pValue = matched.length > 0 && meanNetPct != null && meanNetPct > 0 && wins > matched.length / 2
    ? binomialUpperTail(matched.length, wins, 0.5)
    : 1
  const blockers = uniqueStrings([
    ...(matched.length >= input.args.minVariantClosedOutcomes
      ? []
      : [`closed_outcomes_low:${matched.length}<${input.args.minVariantClosedOutcomes}`]),
    ...(meanNetPct != null && meanNetPct > input.args.minMeanNetPct
      ? []
      : [`mean_net_not_positive:${meanNetPct ?? 'missing'}<=${input.args.minMeanNetPct}`]),
    ...(winRatePct != null && winRatePct >= input.args.minWinRatePct
      ? []
      : [`win_rate_low:${winRatePct ?? 'missing'}<${input.args.minWinRatePct}`]),
    ...(input.baselineMeanNetPct != null && meanNetPct != null && meanNetPct > input.baselineMeanNetPct
      ? []
      : [`no_improvement_vs_baseline:${meanNetPct ?? 'missing'}<=${input.baselineMeanNetPct ?? 'missing'}`]),
    ...(wfoStatus === 'pass_research_only' ? [] : [`wfo_${wfoStatus}`]),
    'p_value_not_promotion_grade',
  ])
  return {
    variantId: `eth_carry_confluence_refine_funding_abs_gte_${formatThreshold(input.fundingThreshold)}_basis_abs_gte_${formatThreshold(input.basisThreshold)}`,
    familyId: 'funding_carry_rebuild',
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    rule: {
      fundingSpreadSign: 'positive',
      basisSpreadDiffPctSign: 'positive',
      direction: 'short_eth_long_btc',
      minAbsFundingSpread: input.fundingThreshold,
      minAbsBasisSpreadDiffPct: input.basisThreshold,
    },
    closedOutcomes: matched.length,
    wins,
    losses,
    winRatePct,
    meanGrossPct: meanNullable(matched.map(row => row.grossPct)),
    meanFundingCashflowPct: meanNullable(matched.map(row => row.fundingCashflowPct).filter((value): value is number => value != null)),
    meanRouteCostPct: meanNullable(matched.map(row => row.routeCostPct).filter((value): value is number => value != null)),
    meanNetPct,
    netImprovementVsBaselinePct: input.baselineMeanNetPct != null && meanNetPct != null
      ? round(meanNetPct - input.baselineMeanNetPct, 10)
      : null,
    pValue: round(pValue, 12),
    pAdjustedBYRawM: null,
    fdrPassed: null,
    wfo: {
      status: wfoStatus,
      passedWindows,
      failedWindows,
      windowCount,
      failedWindowRatio: windowCount > 0 ? round(failedWindows / windowCount, 10) : null,
      windows,
    },
    blockers,
  }
}

function matchesVariant(row: ClosedRow, minFundingAbs: number, minBasisAbsPct: number): boolean {
  return row.direction === 'short_eth_long_btc' &&
    row.fundingSpread != null &&
    row.basisSpreadDiffPct != null &&
    row.fundingSpread > 0 &&
    row.basisSpreadDiffPct > 0 &&
    Math.abs(row.fundingSpread) >= minFundingAbs &&
    Math.abs(row.basisSpreadDiffPct) >= minBasisAbsPct
}

function buildWindows(input: {
  rows: ClosedRow[]
  minWindows: number
  minWindowClosedOutcomes: number
  minWinRatePct: number
  minMeanNetPct: number
}): SweepWindow[] {
  if (input.rows.length === 0) return []
  const sorted = [...input.rows].sort((left, right) => left.decisionTimeMs - right.decisionTimeMs)
  const chunkSize = Math.ceil(sorted.length / input.minWindows)
  const windows: SweepWindow[] = []
  for (let index = 0; index < input.minWindows; index += 1) {
    const rows = sorted.slice(index * chunkSize, (index + 1) * chunkSize)
    if (rows.length === 0) continue
    const meanNetPct = meanNullable(rows.map(row => row.netPct))
    const winRatePct = round(rows.filter(row => row.profitableNet).length / rows.length * 100, 10)
    const blockers = uniqueStrings([
      ...(rows.length >= input.minWindowClosedOutcomes ? [] : [`window_closed_outcomes_low:${rows.length}<${input.minWindowClosedOutcomes}`]),
      ...(meanNetPct != null && meanNetPct > input.minMeanNetPct ? [] : [`window_mean_net_not_positive:${meanNetPct ?? 'missing'}<=${input.minMeanNetPct}`]),
      ...(winRatePct >= input.minWinRatePct ? [] : [`window_win_rate_low:${winRatePct}<${input.minWinRatePct}`]),
    ])
    windows.push({
      windowIndex: index,
      startTime: rows[0]?.decisionTime ?? null,
      endTime: rows.at(-1)?.decisionTime ?? null,
      closedOutcomes: rows.length,
      meanNetPct,
      winRatePct,
      passed: blockers.length === 0,
      blockers,
    })
  }
  return windows
}

function applyFdr(variants: SweepVariant[], alpha: number): {
  status: 'not_computed' | 'computed_research_only'
  variants: SweepVariant[]
  bestVariantQValue: number | null
  bestVariantFdrPassed: boolean | null
  harmonicFactorCm: number | null
  blocker: string | null
} {
  if (variants.length < 2) {
    return {
      status: 'not_computed',
      variants,
      bestVariantQValue: null,
      bestVariantFdrPassed: null,
      harmonicFactorCm: null,
      blocker: 'refinement_raw_m_too_low',
    }
  }
  const result = runLedgerBoundFdrCorrection({
    pValues: variants.map(variant => variant.pValue),
    alpha,
    trialLedger: {
      rawM: variants.length,
      rawMComplete: true,
      includesFailedTrials: true,
      survivingTrialCount: variants.filter(variant => variant.meanNetPct != null && variant.meanNetPct > 0).length,
      failedTrialCount: variants.filter(variant => !(variant.meanNetPct != null && variant.meanNetPct > 0)).length,
      fdrMethodPrimary: 'BY_raw_m',
    },
  })
  const byIndex = new Map(result.items.map(item => [item.index, item]))
  const adjusted = variants.map((variant, index) => {
    const item = byIndex.get(index)
    return {
      ...variant,
      pAdjustedBYRawM: item ? round(item.qValue, 12) : null,
      fdrPassed: item?.passed ?? null,
    }
  })
  const bestVariant = selectBestVariant(adjusted)
  return {
    status: 'computed_research_only',
    variants: adjusted,
    bestVariantQValue: bestVariant?.pAdjustedBYRawM ?? null,
    bestVariantFdrPassed: bestVariant?.fdrPassed ?? null,
    harmonicFactorCm: result.diagnostics.harmonicFactorCm,
    blocker: null,
  }
}

function selectBestVariant(variants: SweepVariant[]): SweepVariant | null {
  const eligible = variants.filter(variant => variant.closedOutcomes > 0)
  if (eligible.length === 0) return null
  return [...eligible].sort(compareVariants)[0]
}

function compareVariants(left: SweepVariant, right: SweepVariant): number {
  return Number(right.fdrPassed === true) - Number(left.fdrPassed === true) ||
    (right.meanNetPct ?? -Infinity) - (left.meanNetPct ?? -Infinity) ||
    (right.winRatePct ?? -Infinity) - (left.winRatePct ?? -Infinity) ||
    right.rule.minAbsFundingSpread - left.rule.minAbsFundingSpread ||
    right.rule.minAbsBasisSpreadDiffPct - left.rule.minAbsBasisSpreadDiffPct ||
    right.closedOutcomes - left.closedOutcomes
}

function binomialUpperTail(n: number, successes: number, p: number): number {
  if (!Number.isInteger(n) || n <= 0) return 1
  const boundedSuccesses = Math.max(0, Math.min(n, Math.round(successes)))
  let probability = 0
  for (let k = boundedSuccesses; k <= n; k += 1) {
    probability += binomialCoefficient(n, k) * (p ** k) * ((1 - p) ** (n - k))
  }
  return Math.max(0, Math.min(1, probability))
}

function binomialCoefficient(n: number, k: number): number {
  const boundedK = Math.min(k, n - k)
  let result = 1
  for (let i = 1; i <= boundedK; i += 1) {
    result = result * (n - boundedK + i) / i
  }
  return result
}

function buildNextActions(status: SweepStatus, bestVariant: SweepVariant | null): string[] {
  const actions = [
    'Keep all refinement variants research-only; do not mutate best_config.json or paper/live targets.',
  ]
  if (status !== 'research_refinement_watch_only') {
    actions.push('Collect more prospective labels before trusting any stricter funding/basis threshold.')
  }
  if (bestVariant) {
    actions.push(`If evidence improves, rerun independent PIT WFO/BY-FDR/risk validation for ${bestVariant.variantId}.`)
  }
  actions.push('Only consider paper telemetry after release gates explicitly allow paper execution.')
  return actions
}

function isSafetyOrPromotionGradeBlocker(blocker: string): boolean {
  return blocker === 'p_values_research_only_not_promotion_grade' ||
    blocker === 'research_only_not_execution_evidence' ||
    blocker === 'paper_live_execution_disabled' ||
    blocker === 'requires_independent_pit_wfo_fdr_route_cost_risk_and_paper_telemetry'
}

function readLedgerEvents(path: string): UnknownRecord[] {
  const resolvedPath = resolve(path)
  if (!existsSync(resolvedPath)) return []
  return readFileSync(resolvedPath, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return asRecord(JSON.parse(line))
      } catch {
        return null
      }
    })
    .filter((item): item is UnknownRecord => item != null)
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(key, next)
      index += 1
    } else {
      out.set(key, 'true')
    }
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (value == null) return null
  const normalized = value.trim().toLowerCase()
  return normalized === '' || normalized === 'null' || normalized === 'none' || normalized === 'false' ? null : value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function parseNumberList(value: string | undefined, fallback: number[], label: string): number[] {
  if (value == null) return fallback
  const parsed = value.split(',').map(item => Number(item.trim()))
  if (parsed.length === 0 || parsed.some(item => !Number.isFinite(item) || item < 0)) {
    throw new Error(`${label} must be a comma-separated list of non-negative finite numbers`)
  }
  return parsed
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function parseFiniteNumber(value: string | undefined, fallback: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`)
  return parsed
}

function parseProbability(value: string | undefined, fallback: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${label} must be within [0, 1]`)
  return parsed
}

function asRecord(value: unknown): UnknownRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function meanNullable(values: number[]): number | null {
  return values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 10) : null
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right)
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function formatThreshold(value: number): string {
  return String(value).replace(/[^0-9]+/g, '_').replace(/^_+|_+$/g, '') || '0'
}

function renderConsoleSummary(report: EthCarryConfluenceRefinementSweepReport): string {
  return [
    `eth carry confluence refinement sweep: status=${report.status}`,
    `variants=${report.evidenceCounts.variantsTested} closed=${report.evidenceCounts.matchedClosedRows}/${report.thresholds.minTotalClosedOutcomes}`,
    `best=${report.bestVariant?.variantId ?? 'none'} n=${report.bestVariant?.closedOutcomes ?? 0} meanNet=${report.bestVariant?.meanNetPct ?? 'null'} win=${report.bestVariant?.winRatePct ?? 'null'} q=${report.bestVariant?.pAdjustedBYRawM ?? 'null'}`,
    `paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `blockers=${report.blockers.slice(0, 8).join(',')}` : 'blockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_eth_carry_confluence_refinement_sweep failed:', error)
    process.exitCode = 1
  })
}
