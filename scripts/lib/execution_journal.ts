import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'

export type JournalStatus =
  | 'started'
  | 'completed'
  | 'failed'
  | 'not_activated'
  | 'imported'
  | 'unavailable'

export interface SummaryMetrics {
  meanPbo?: number | null
  meanDsrProbability?: number | null
  fdrQ?: number | null
  wfoFailureDensity?: number | null
  totalGap?: number | null
  meanSharpe?: number | null
  meanAverageAbsoluteCorrelation?: number | null
  maxAbsoluteCorrelation?: number | null
}

export interface ExecutionJournalEntry {
  schemaVersion?: string
  timestamp?: string
  runId: string
  batchId?: string | null
  stage: string
  action: string
  status: JournalStatus
  inputs?: Record<string, unknown>
  outputs?: Record<string, unknown>
  summaryMetrics?: SummaryMetrics
  decision?: string | null
  codeRefs?: string[]
  notes?: string[]
  hostname?: string | null
  cwd?: string | null
  gitHead?: string | null
  gitBranch?: string | null
  gitDirty?: boolean | null
}

const DEFAULT_JOURNAL_PATH = 'data/research/strategy/execution_journal.jsonl'

export async function appendExecutionJournal(
  entry: ExecutionJournalEntry,
  journalPath = DEFAULT_JOURNAL_PATH,
): Promise<{ journalPath: string; entry: ExecutionJournalEntry }> {
  const resolvedJournalPath = resolve(journalPath)
  const normalized: ExecutionJournalEntry = {
    schemaVersion: entry.schemaVersion ?? 'execution_journal_entry.v1',
    timestamp: entry.timestamp ?? new Date().toISOString(),
    hostname: entry.hostname ?? hostname(),
    cwd: entry.cwd ?? process.cwd(),
    gitHead: entry.gitHead ?? null,
    gitBranch: entry.gitBranch ?? null,
    gitDirty: entry.gitDirty ?? null,
    ...entry,
    inputs: normalizeRecord(entry.inputs),
    outputs: normalizeRecord(entry.outputs),
    summaryMetrics: normalizeSummaryMetrics(entry.summaryMetrics),
    codeRefs: normalizeStringArray(entry.codeRefs),
    notes: normalizeStringArray(entry.notes),
  }

  await mkdir(dirname(resolvedJournalPath), { recursive: true })
  await appendFile(resolvedJournalPath, `${JSON.stringify(normalized)}\n`, 'utf-8')
  return { journalPath: resolvedJournalPath, entry: normalized }
}

export async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf-8')) as T
  } catch {
    return null
  }
}

export function extractSummaryMetrics(payload: unknown): SummaryMetrics {
  const record = asRecord(payload)
  const summary = asRecord(record.summaryMetrics)
  const aggregate = asRecord(record.aggregate)
  const aggregateMetrics = asRecord(record.aggregateMetrics)
  const metrics = asRecord(record.metrics)
  const validationSummary = asRecord(record.summary)
  const portfolio = asRecord(record.portfolio)
  const portfolioAggregateMetrics = asRecord(portfolio.aggregateMetrics)
  const thresholds = asRecord(record.thresholds)
  const configThresholds = asRecord(asRecord(record.config).thresholds)
  const symbols = asRecord(firstArrayRecord(record.symbols))
  const symbolAggregateMetrics = asRecord(symbols.aggregateMetrics)

  const meanPbo =
    pickNumber(record.meanPbo) ??
    pickNumber(summary.meanPbo) ??
    pickNumber(aggregate.meanPbo) ??
    pickNumber(aggregateMetrics.meanPbo) ??
    pickNumber(portfolioAggregateMetrics.meanPbo) ??
    pickNumber(symbolAggregateMetrics.meanPbo) ??
    pickNumber(metrics.meanPbo) ??
    pickNumber(validationSummary.meanPbo)

  const meanDsrProbability =
    pickNumber(record.meanDsrProbability) ??
    pickNumber(summary.meanDsrProbability) ??
    pickNumber(aggregate.meanDsrProbability) ??
    pickNumber(aggregateMetrics.meanDsrProbability) ??
    pickNumber(portfolioAggregateMetrics.meanDsrProbability) ??
    pickNumber(symbolAggregateMetrics.meanDsrProbability) ??
    pickNumber(metrics.meanDsrProbability) ??
    pickNumber(validationSummary.meanDsrProbability)

  const fdrQ =
    pickNumber(record.fdrQ) ??
    pickNumber(summary.fdrQ) ??
    pickNumber(aggregate.fdrQ) ??
    pickNumber(aggregateMetrics.fdrQ) ??
    pickNumber(portfolioAggregateMetrics.fdrQ) ??
    pickNumber(symbolAggregateMetrics.fdrQ) ??
    pickNumber(metrics.fdrQ) ??
    pickNumber(validationSummary.fdrQ) ??
    pickNumber(asRecord(record.candidateLevelFdr).fdrQ)

  const failedWindows =
    pickNumber(asRecord(record.wfo).failedWindows) ??
    pickNumber(asRecord(summary.wfo).failedWindows) ??
    pickNumber(asRecord(validationSummary.wfo).failedWindows)
  const windowCount =
    pickNumber(asRecord(record.wfo).windowCount) ??
    pickNumber(asRecord(summary.wfo).windowCount) ??
    pickNumber(asRecord(validationSummary.wfo).windowCount)
  const wfoFailureDensity =
    pickNumber(record.wfoFailureDensity) ??
    pickNumber(summary.wfoFailureDensity) ??
    pickNumber(aggregate.wfoFailureDensity) ??
    pickNumber(aggregateMetrics.wfoFailureDensity) ??
    pickNumber(portfolioAggregateMetrics.wfoFailureDensity) ??
    pickNumber(symbolAggregateMetrics.wfoFailureDensity) ??
    pickNumber(metrics.wfoFailureDensity) ??
    pickNumber(validationSummary.wfoFailureDensity) ??
    (failedWindows != null && windowCount != null && windowCount > 0
      ? round6(failedWindows / windowCount)
      : computeMeanCandidateMetric(record, candidate => {
          const blockerWfo = asRecord(asRecord(candidate.blockerSummary).wfo)
          return (
            pickNumber(blockerWfo.failedWindowRatio) ??
            pickNumber(asRecord(findReleaseGateCheck(candidate, 'wfo')).failedWindowRatio) ??
            pickNumber(asRecord(asRecord(findReleaseGateCheck(candidate, 'wfo')).metrics).failedWindowRatio)
          )
        }))

  const totalGap =
    pickNumber(record.totalGap) ??
    pickNumber(summary.totalGap) ??
    pickNumber(aggregate.totalGap) ??
    pickNumber(aggregateMetrics.totalGap) ??
    pickNumber(portfolioAggregateMetrics.totalGap) ??
    pickNumber(symbolAggregateMetrics.totalGap) ??
    pickNumber(metrics.totalGap) ??
    pickNumber(validationSummary.totalGap) ??
    buildTotalGap(
      { meanPbo, meanDsrProbability, fdrQ },
      thresholds,
      configThresholds,
    )

  const meanSharpe =
    pickNumber(record.meanSharpe) ??
    pickNumber(summary.meanSharpe) ??
    pickNumber(aggregate.meanSharpe) ??
    pickNumber(aggregateMetrics.meanSharpe) ??
    pickNumber(portfolioAggregateMetrics.meanSharpe) ??
    pickNumber(symbolAggregateMetrics.meanSharpe) ??
    pickNumber(metrics.meanSharpe) ??
    pickNumber(validationSummary.meanSharpe) ??
    pickNumber(asRecord(record.backtest).sharpe) ??
    computeMeanCandidateMetric(record, candidate => pickNumber(asRecord(candidate.backtestMetrics).sharpe))

  const meanAverageAbsoluteCorrelation =
    pickNumber(record.meanAverageAbsoluteCorrelation) ??
    pickNumber(summary.meanAverageAbsoluteCorrelation) ??
    pickNumber(aggregate.meanAverageAbsoluteCorrelation) ??
    pickNumber(aggregateMetrics.meanAverageAbsoluteCorrelation) ??
    pickNumber(portfolioAggregateMetrics.meanAverageAbsoluteCorrelation) ??
    pickNumber(symbolAggregateMetrics.meanAverageAbsoluteCorrelation) ??
    pickNumber(metrics.meanAverageAbsoluteCorrelation) ??
    pickNumber(validationSummary.meanAverageAbsoluteCorrelation)

  const maxAbsoluteCorrelation =
    pickNumber(record.maxAbsoluteCorrelation) ??
    pickNumber(summary.maxAbsoluteCorrelation) ??
    pickNumber(aggregate.maxAbsoluteCorrelation) ??
    pickNumber(aggregateMetrics.maxAbsoluteCorrelation) ??
    pickNumber(portfolioAggregateMetrics.maxAbsoluteCorrelation) ??
    pickNumber(symbolAggregateMetrics.maxAbsoluteCorrelation) ??
    pickNumber(metrics.maxAbsoluteCorrelation) ??
    pickNumber(validationSummary.maxAbsoluteCorrelation)

  return normalizeSummaryMetrics({
    meanPbo,
    meanDsrProbability,
    fdrQ,
    wfoFailureDensity,
    totalGap,
    meanSharpe,
    meanAverageAbsoluteCorrelation,
    maxAbsoluteCorrelation,
  })
}

export function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return String(error)
}

function normalizeRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value ? Object.fromEntries(Object.entries(value)) : {}
}

function normalizeSummaryMetrics(value: SummaryMetrics | undefined): SummaryMetrics {
  const metrics = value ?? {}
  return {
    meanPbo: pickNumber(metrics.meanPbo),
    meanDsrProbability: pickNumber(metrics.meanDsrProbability),
    fdrQ: pickNumber(metrics.fdrQ),
    wfoFailureDensity: pickNumber(metrics.wfoFailureDensity),
    totalGap: pickNumber(metrics.totalGap),
    meanSharpe: pickNumber(metrics.meanSharpe),
    meanAverageAbsoluteCorrelation: pickNumber(metrics.meanAverageAbsoluteCorrelation),
    maxAbsoluteCorrelation: pickNumber(metrics.maxAbsoluteCorrelation),
  }
}

function normalizeStringArray(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return []
  }
  return values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function firstArrayRecord(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) {
    return null
  }
  for (const item of value) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return item as Record<string, unknown>
    }
  }
  return null
}

function findReleaseGateCheck(candidate: Record<string, unknown>, name: string): Record<string, unknown> | null {
  const checks = asRecord(candidate.releaseGate).checks
  if (!Array.isArray(checks)) {
    return null
  }
  for (const item of checks) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue
    }
    const check = item as Record<string, unknown>
    if (check.name === name) {
      return check
    }
  }
  return null
}

function computeMeanCandidateMetric(
  record: Record<string, unknown>,
  selector: (candidate: Record<string, unknown>) => number | null,
): number | null {
  const values: number[] = []
  const symbols = Array.isArray(record.symbols) ? record.symbols : []
  for (const symbol of symbols) {
    if (!symbol || typeof symbol !== 'object' || Array.isArray(symbol)) {
      continue
    }
    const candidates = (symbol as Record<string, unknown>).candidates
    if (!Array.isArray(candidates)) {
      continue
    }
    for (const item of candidates) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        continue
      }
      const value = selector(item as Record<string, unknown>)
      if (value != null) {
        values.push(value)
      }
    }
  }
  return values.length > 0 ? round6(mean(values)) : null
}

function buildTotalGap(
  metrics: {
    meanPbo: number | null
    meanDsrProbability: number | null
    fdrQ: number | null
  },
  thresholds: Record<string, unknown>,
  configThresholds: Record<string, unknown>,
): number | null {
  const thresholdSource = Object.keys(thresholds).length > 0 ? thresholds : configThresholds
  const pboMax = pickNumber(thresholdSource.meanPboMax)
  const dsrMin = pickNumber(thresholdSource.meanDsrProbabilityMin)
  const fdrMax = pickNumber(thresholdSource.fdrQMax)
  if (
    metrics.meanPbo == null ||
    metrics.meanDsrProbability == null ||
    metrics.fdrQ == null ||
    pboMax == null ||
    dsrMin == null ||
    fdrMax == null
  ) {
    return null
  }
  const pboGap = Math.max(metrics.meanPbo - pboMax, 0)
  const dsrGap = Math.max(dsrMin - metrics.meanDsrProbability, 0)
  const fdrGap = Math.max(metrics.fdrQ - fdrMax, 0)
  return round6(pboGap + dsrGap + fdrGap)
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function round6(value: number): number {
  return Number(value.toFixed(6))
}

function pickNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
