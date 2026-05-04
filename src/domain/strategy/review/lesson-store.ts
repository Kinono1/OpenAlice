import type { LessonStoreSummary, ReviewLabel, ReviewRecord } from './types.js'

const NEGATIVE_LABELS: ReviewLabel[] = ['sentiment-trap', 'regime-miss', 'should-not-trade']
const POSITIVE_LABELS: ReviewLabel[] = ['alpha-valid', 'timing-bad']

export function summarizeReviewRecords(records: ReviewRecord[]): LessonStoreSummary {
  const labelCounts: Record<ReviewLabel, number> = {
    'alpha-valid': 0,
    'timing-bad': 0,
    'execution-bad': 0,
    'sentiment-trap': 0,
    'regime-miss': 0,
    'should-not-trade': 0,
  }

  const positiveStrategyCounts = new Map<string, number>()
  for (const record of records) {
    labelCounts[record.label] += 1
    if (record.strategyId && POSITIVE_LABELS.includes(record.label)) {
      positiveStrategyCounts.set(
        record.strategyId,
        (positiveStrategyCounts.get(record.strategyId) ?? 0) + 1,
      )
    }
  }

  const promotedCandidates = [...positiveStrategyCounts.entries()]
    .filter(([, count]) => count >= 3)
    .map(([strategyId]) => strategyId)
    .sort()

  const hardRestrictions = NEGATIVE_LABELS.filter((label) => labelCounts[label] >= 2)

  return {
    labelCounts,
    promotedCandidates,
    hardRestrictions,
  }
}
