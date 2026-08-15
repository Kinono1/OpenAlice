/**
 * Open-position cost snapshot builder.
 *
 * Extracted from shared logic in scripts/paper_trade_volume_breakout.ts
 * and scripts/paper_trade_microstructure_stress.ts.
 *
 * Each strategy calls buildOpenCostSnapshot() and then overlays its own
 * family-specific edge/quality fields on top.
 */

import { estimatePaperRoundTripCostPct, roundSignalQualityNumber } from './paper_cost_helpers.js'
import {
  resolvePaperMarkMatchOpenFields,
  DEFAULT_PAPER_MARK_MATCH_FALLBACK_PENALTY_BPS,
} from '../../scripts/lib/paper_mark_match.js'

export interface OpenCostSnapshot {
  estimatedRoundTripCostPctAtOpen: number
  estimatedRoundTripCostPctOfMarginAtOpen: number
  routeCostBpsAtOpen: number
  roundTripCostBpsAtOpen: number
  markPriceAtOpen: number | null
  markPriceTimestampAtOpen: string | null
  matchPriceAtOpen: number | null
  matchPriceSourceAtOpen: string | null
  markMatchPenaltyBpsAtOpen: number | null
  markMatchStatusAtOpen: string | null
}

/**
 * Build a cost snapshot for a paper trade open event.
 *
 * Resolves mark-vs-match from the Binance premium index (if available),
 * then estimates round-trip cost including fees, slippage, and penalty.
 *
 * @param leverage  Account leverage (used to scale cost-of-margin).
 * @param matchPrice  Simulated fill price for the order.
 * @param symbol  Optional symbol for mark-match resolution.
 * @param decisionTime  Optional decision timestamp for PIT-safe mark lookup.
 */
export function buildOpenCostSnapshot(
  leverage: number,
  matchPrice: number,
  symbol?: string,
  decisionTime?: string | Date | number | null,
): OpenCostSnapshot {
  const markMatch = symbol
    ? resolvePaperMarkMatchOpenFields({
        symbol,
        decisionTime,
        matchPrice,
        fallbackPenaltyBps: DEFAULT_PAPER_MARK_MATCH_FALLBACK_PENALTY_BPS,
      })
    : resolvePaperMarkMatchOpenFields({
        symbol: '',
        decisionTime: null,
        matchPrice,
        fallbackPenaltyBps: DEFAULT_PAPER_MARK_MATCH_FALLBACK_PENALTY_BPS,
      })

  const estimatedRoundTripCostPctAtOpen = estimatePaperRoundTripCostPct(markMatch.markMatchPenaltyBpsAtOpen)
  const roundTripCostBpsAtOpen = roundSignalQualityNumber(estimatedRoundTripCostPctAtOpen * 100)

  return {
    estimatedRoundTripCostPctAtOpen,
    estimatedRoundTripCostPctOfMarginAtOpen: roundSignalQualityNumber(
      estimatedRoundTripCostPctAtOpen * Math.max(leverage, 1),
    ),
    routeCostBpsAtOpen: roundTripCostBpsAtOpen,
    roundTripCostBpsAtOpen,
    ...markMatch,
  }
}
