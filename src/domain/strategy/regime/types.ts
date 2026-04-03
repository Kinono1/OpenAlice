export type MarketRegime =
  | 'spot-defensive'
  | 'range-rotation'
  | 'trend-follow'
  | 'event-risk-freeze'

export interface RegimeFeatures {
  trendStrength: number
  realizedVolPct: number
  rangeCompressionScore: number
  eventWindowFrozen?: boolean
}

export interface RegimeEvaluation {
  regime: MarketRegime
  confidence: number
  reasons: string[]
}

export type TicketTransitionAction = 'keep' | 'downgrade' | 'cancel'

export interface RegimeTransitionDecision {
  previous: MarketRegime
  next: MarketRegime
  action: TicketTransitionAction
  reason: string
}
