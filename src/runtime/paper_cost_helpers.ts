/**
 * Shared paper trading cost constants and helpers.
 * Extracted from scripts/paper_trade_volume_breakout.ts,
 * scripts/paper_trade_microstructure_stress.ts, and
 * scripts/paper_trade_cross_sectional.ts.
 */

/** Paper fee rate (0.06% per leg). Used by VB + Micro. */
export const PAPER_FEE_RATE = 0.0006

/** Simulated slippage in bps per leg. Used by VB + Micro. */
export const PAPER_SLIPPAGE_BPS = 8

/** Default mark-match fallback penalty in bps when Binance premium index is unavailable. */
export const PAPER_STALE_MARK_MATCH_PENALTY_BPS = 15

/**
 * Round a signal-quality value to 6 decimal places for deterministic artifact output.
 */
export function roundSignalQualityNumber(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

/**
 * Estimate paper round-trip cost as a percentage of notional.
 * Includes fee × 2, slippage × 2, and optional mark-match penalty.
 *
 * Used by volume-breakout and microstructure scripts.
 * Cross-sectional uses its own PaperCostModel-based estimation and should NOT use this.
 */
export function estimatePaperRoundTripCostPct(markMatchPenaltyBps = PAPER_STALE_MARK_MATCH_PENALTY_BPS): number {
  const feeCost = PAPER_FEE_RATE * 2
  const slippageCost = (PAPER_SLIPPAGE_BPS / 10_000) * 2
  const markMatchPenalty = Math.max(0, markMatchPenaltyBps) / 10_000
  return roundSignalQualityNumber((feeCost + slippageCost + markMatchPenalty) * 100)
}
