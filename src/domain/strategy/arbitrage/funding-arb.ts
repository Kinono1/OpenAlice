import type { FundingArbSignal } from './types.js'

export interface FundingArbConfig {
  /** Minimum annualized yield to trigger arb (default 0.10 = 10% APY) */
  minAnnualizedYield?: number
  /** Minimum net annualized yield after explicit costs (default same as minAnnualizedYield) */
  minNetAnnualizedYield?: number
  /** Funding payments per year (Binance/Bybit: 3/day x 365 = 1095) */
  paymentsPerYear?: number
  /** Minimum consecutive extreme readings before declaring pegged regime */
  peggedMinBars?: number
  /** Round-trip execution, hedge rebalance, and borrow drag in annualized units. */
  annualizedCostDrag?: number
}

const DEFAULT: Required<FundingArbConfig> = {
  minAnnualizedYield: 0.10,
  minNetAnnualizedYield: 0.10,
  paymentsPerYear: 1095,
  peggedMinBars: 6,
  annualizedCostDrag: 0,
}

/**
 * Evaluate whether a delta-neutral funding rate arbitrage is viable.
 *
 * Strategy:
 *   - Positive funding (longs pay shorts): long spot + short perp -> collect funding
 *   - Negative funding (shorts pay longs): short spot + long perp -> collect funding
 *
 * The position is delta-neutral: spot and perp legs cancel directional exposure.
 */
export function evaluateFundingArb(
  symbol: string,
  fundingRate: number,
  recentFundingRates: number[],
  config: FundingArbConfig = {},
): FundingArbSignal {
  const resolved = { ...DEFAULT, ...config }

  const annualizedYield = Math.abs(fundingRate) * resolved.paymentsPerYear
  const netAnnualizedYield = annualizedYield - Math.max(0, resolved.annualizedCostDrag)

  // Detect pegged regime: funding has been extreme and one-sided for many bars
  const isPegged = recentFundingRates.length >= resolved.peggedMinBars &&
    recentFundingRates.slice(-resolved.peggedMinBars).every(r => Math.sign(r) === Math.sign(fundingRate) && Math.abs(r) > 0.0005)
  const reasons: string[] = []

  if (annualizedYield < resolved.minAnnualizedYield) {
    reasons.push(`gross annualized yield ${annualizedYield.toFixed(4)} below ${resolved.minAnnualizedYield}`)
  }
  if (netAnnualizedYield < resolved.minNetAnnualizedYield) {
    reasons.push(`net annualized yield ${netAnnualizedYield.toFixed(4)} below ${resolved.minNetAnnualizedYield}`)
  }

  if (reasons.length > 0) {
    return {
      symbol,
      fundingRate,
      annualizedYield,
      netAnnualizedYield,
      direction: 'none',
      confidence: 0,
      isPegged,
      deltaNeutral: true,
      reasons,
    }
  }

  const direction = fundingRate > 0
    ? 'long_spot_short_perp'
    : 'short_spot_long_perp'

  // Confidence: scales from 0 at threshold to 1 at 3x threshold
  const confidence = Math.min(
    (netAnnualizedYield - resolved.minNetAnnualizedYield)
      / (2 * Math.max(resolved.minNetAnnualizedYield, 1e-6)),
    1,
  )

  return {
    symbol,
    fundingRate,
    annualizedYield,
    netAnnualizedYield,
    direction,
    confidence,
    isPegged,
    deltaNeutral: true,
    reasons: ['delta-neutral spot/perp funding carry passed gross and net yield gates'],
  }
}

/**
 * Compute the net funding P&L for an open arb position over one funding period.
 * spotSize and perpSize should be equal in absolute value (delta-neutral).
 */
export function computeFundingPnl(
  fundingRate: number,
  perpPositionSize: number,
): number {
  // Positive funding: shorts receive payment = fundingRate * |perpSize|
  // perpPositionSize is negative for short perp
  return -fundingRate * perpPositionSize
}
