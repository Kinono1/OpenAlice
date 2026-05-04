export type ReviewLabel =
  | 'alpha-valid'
  | 'timing-bad'
  | 'execution-bad'
  | 'sentiment-trap'
  | 'regime-miss'
  | 'should-not-trade'

export interface ReviewRecord {
  ticketId: string
  label: ReviewLabel
  strategyId?: string
  notes?: string
}

export interface LessonStoreSummary {
  labelCounts: Record<ReviewLabel, number>
  promotedCandidates: string[]
  hardRestrictions: ReviewLabel[]
}
