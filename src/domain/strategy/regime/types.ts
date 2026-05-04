import type { HmmRegimeOutput, HmmState, HmmStateName } from './hmm/types.js'

export type MarketRegime =
  | 'spot-defensive'
  | 'range-rotation'
  | 'trend-follow'
  | 'bear-trend'
  | 'vol-stress'
  | 'event-risk-freeze'

export interface RegimeFeatures {
  trendStrength: number
  realizedVolPct: number
  realizedVolPercentile?: number
  rangeCompressionScore: number
  volumeChangeRate?: number
  eventWindowFrozen?: boolean
}

export interface RegimeEvaluation {
  regime: MarketRegime
  confidence: number
  reasons: string[]
  method?: 'threshold' | 'hmm'
  fallbackRegime?: MarketRegime
  hmm?: HmmRegimeOutput | null
  features?: RegimeFeatures
}

export type { HmmState, HmmStateName }

export type TicketTransitionAction = 'keep' | 'downgrade' | 'cancel'

export interface RegimeTransitionDecision {
  previous: MarketRegime
  next: MarketRegime
  action: TicketTransitionAction
  reason: string
}
