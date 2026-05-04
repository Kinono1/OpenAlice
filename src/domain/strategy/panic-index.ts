/**
 * Crypto Panic Index — VIX-like fear gauge for crypto markets.
 *
 * Constructed from:
 *   1. Options-implied volatility (Deribit DVOL proxy)
 *   2. Perp funding rate extremeness
 *   3. Realized volatility percentile
 *   4. Order book imbalance (sell pressure)
 *   5. Stablecoin flow ratio
 *
 * Composite score 0-100:
 *   0-25: Complacency (greed)
 *   25-50: Normal
 *   50-75: Fear
 *   75-100: Extreme Fear / Panic
 */

export interface PanicIndexInput {
  /** Annualized ATM implied vol (from options or perp basis) */
  impliedVolPct: number
  /** Absolute funding rate (annualized) */
  fundingRateAnnualized: number
  /** Realized volatility percentile [0,1] vs historical */
  realizedVolPercentile: number
  /** Order book imbalance [-1, 1], negative = sell pressure */
  orderBookImbalance: number
  /** Stablecoin net flow ratio vs exchange balance */
  stablecoinFlowRatio: number
  /** Max drawdown from ATH as percentage */
  drawdownFromAthPct: number
  /** Volume surge ratio vs 30-day avg */
  volumeSurgeRatio: number
  /** Liquidation volume as fraction of OI */
  liquidationRatio: number
}

export interface PanicIndexResult {
  panicIndex: number // 0-100
  regime: 'complacency' | 'normal' | 'fear' | 'extreme_fear'
  components: {
    volPanic: number
    fundingPanic: number
    flowPanic: number
    liquidationPanic: number
  }
  tradingSignal: 'risk_on' | 'neutral' | 'reduce_risk' | 'risk_off'
}

export function computePanicIndex(input: PanicIndexInput): PanicIndexResult {
  if (!isFinitePanicInput(input)) {
    return {
      panicIndex: 100,
      regime: 'extreme_fear',
      components: {
        volPanic: 1,
        fundingPanic: 1,
        flowPanic: 1,
        liquidationPanic: 1,
      },
      tradingSignal: 'risk_off',
    }
  }

  // 1. Vol panic: implied vol vs long-term avg
  const volScore = clamp01((input.impliedVolPct - 40) / 60) // 40% = normal, 100% = panic

  // 2. Funding panic: extreme funding = stress
  const fundingScore = clamp01(Math.abs(input.fundingRateAnnualized) / 0.3) // 30% annualized = panic

  // 3. Realized vol percentile
  const realizedScore = clamp01(input.realizedVolPercentile)

  // 4. Order book sell pressure
  const obScore = clamp01((-input.orderBookImbalance + 1) / 2)

  // 5. Stablecoin outflow
  const flowScore = clamp01((-input.stablecoinFlowRatio + 0.05) / 0.1)

  // 6. Drawdown panic
  const drawdownScore = clamp01(input.drawdownFromAthPct / 40) // 40% drawdown = max panic

  // 7. Volume surge
  const volumeScore = clamp01((input.volumeSurgeRatio - 1) / 3) // 4x volume = panic

  // 8. Liquidation cascade
  const liquidationScore = clamp01(input.liquidationRatio / 0.1) // 10% OI liquidated = panic

  const volPanic = volScore * 0.25 + realizedScore * 0.15
  const fundingPanic = fundingScore * 0.15
  const flowPanic = obScore * 0.1 + flowScore * 0.1 + drawdownScore * 0.1
  const liquidationPanic = volumeScore * 0.05 + liquidationScore * 0.1

  const panicIndex = clamp01(volPanic + fundingPanic + flowPanic + liquidationPanic) * 100

  const regime: PanicIndexResult['regime'] =
    panicIndex >= 75 ? 'extreme_fear' :
    panicIndex >= 50 ? 'fear' :
    panicIndex >= 25 ? 'normal' : 'complacency'

  const tradingSignal: PanicIndexResult['tradingSignal'] =
    regime === 'extreme_fear' ? 'risk_off' :
    regime === 'fear' ? 'reduce_risk' :
    regime === 'complacency' ? 'risk_on' : 'neutral'

  return {
    panicIndex: Math.round(panicIndex),
    regime,
    components: { volPanic, fundingPanic, flowPanic, liquidationPanic },
    tradingSignal,
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function isFinitePanicInput(input: PanicIndexInput): boolean {
  return Object.values(input).every(value => typeof value === 'number' && Number.isFinite(value))
}
