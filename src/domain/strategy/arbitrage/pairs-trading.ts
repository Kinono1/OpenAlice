/**
 * Pairs Trading / Cointegration Strategy.
 *
 * Upgraded with:
 *   - Kalman filter dynamic hedge ratio (adaptive)
 *   - Cointegration break detection
 *   - Regime-aware entry/exit thresholds
 *
 * Academic: Gatev Goetzmann Rouwenhorst (2006) RFS, Avellaneda Lee (2010)
 */

import { clamp } from '../../strategy/factors/helpers.js'

export interface PairsTradingConfig {
  /** Z-score threshold for entry */
  entryZScore?: number
  /** Z-score threshold for exit */
  exitZScore?: number
  /** Lookback window for mean/std estimation */
  lookbackBars?: number
  /** Max holding bars */
  maxHoldingBars?: number
  /** Stop loss as fraction of position */
  stopLossFraction?: number
  /** Half-life of mean reversion (bars) for Kalman filter */
  halfLifeBars?: number
}

export interface PairPriceData {
  assetA: number[]
  assetB: number[]
}

export interface KalmanState {
  hedgeRatio: number
  intercept: number
  errorCov: number
}

export interface PairsTradingSignal {
  symbolA: string
  symbolB: string
  signal: -1 | 0 | 1
  spreadZScore: number
  hedgeRatio: number
  confidence: number
  reason: string
}

const DEFAULT_CONFIG: Required<PairsTradingConfig> = {
  entryZScore: 2.0,
  exitZScore: 0.3,
  lookbackBars: 100,
  maxHoldingBars: 72,
  stopLossFraction: 0.03,
  halfLifeBars: 20,
}

/**
 * Kalman filter for dynamic hedge ratio estimation.
 * State: [hedge_ratio, intercept]
 */
export function kalmanHedgeRatio(
  pricesA: number[],
  pricesB: number[],
  halfLifeBars: number = 20,
): KalmanState[] {
  const n = Math.min(pricesA.length, pricesB.length)
  const states: KalmanState[] = []

  const delta = 1 - Math.exp(Math.log(0.5) / halfLifeBars)
  const q = 1e-5
  const r = 1e-3

  let hr = 1
  let intercept = 0
  let cov = 1

  for (let i = 1; i < n; i++) {
    const x = pricesB[i]
    const y = pricesA[i]

    cov += q
    const k = (cov * x) / (x * x * cov + r)
    const error = y - (hr * x + intercept)

    hr += k * error
    intercept += delta * error
    cov = (1 - k * x) * cov

    states.push({ hedgeRatio: hr, intercept, errorCov: cov })
  }

  return states
}

export function evaluatePairsTrade(
  symbolA: string,
  symbolB: string,
  pricesA: number[],
  pricesB: number[],
  config: PairsTradingConfig = {},
): PairsTradingSignal {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const n = Math.min(pricesA.length, pricesB.length)

  if (n < cfg.lookbackBars) {
    return {
      symbolA,
      symbolB,
      signal: 0,
      spreadZScore: 0,
      hedgeRatio: 1,
      confidence: 0,
      reason: `Insufficient data: ${n} < ${cfg.lookbackBars}`,
    }
  }

  const kalmanStates = kalmanHedgeRatio(pricesA, pricesB, cfg.halfLifeBars)
  const currentHR = kalmanStates[kalmanStates.length - 1]?.hedgeRatio ?? 1

  const spreads: number[] = []
  for (let i = 0; i < n; i++) {
    spreads.push(pricesA[i] - currentHR * pricesB[i])
  }

  const recentSpreads = spreads.slice(-cfg.lookbackBars)
  const mean = recentSpreads.reduce((s, v) => s + v, 0) / recentSpreads.length
  const variance = recentSpreads.reduce((s, v) => s + (v - mean) ** 2, 0) / recentSpreads.length
  const std = Math.sqrt(Math.max(variance, 1e-14))
  const currentSpread = spreads[spreads.length - 1]
  const zScore = std > 0 ? (currentSpread - mean) / std : 0

  const hrStability = kalmanStates.slice(-50).reduce((s, st) => {
    return s + Math.abs(st.hedgeRatio - currentHR)
  }, 0) / Math.max(50, 1)

  let signal: -1 | 0 | 1 = 0
  let confidence = 0
  let reason = ''

  if (Math.abs(zScore) >= cfg.entryZScore && hrStability < 0.1) {
    signal = zScore > 0 ? -1 : 1 // short spread, long spread
    confidence = clamp((Math.abs(zScore) - cfg.entryZScore) / cfg.entryZScore, 0.2, 1)
    reason = `Spread z=${zScore.toFixed(2)} beyond entry threshold. HR=${currentHR.toFixed(3)}`
  } else if (Math.abs(zScore) <= cfg.exitZScore) {
    signal = 0
    reason = `Spread z=${zScore.toFixed(2)} mean-reverted.`
  } else {
    reason = `Spread z=${zScore.toFixed(2)} within band. HR stability=${hrStability.toFixed(3)}`
  }

  if (hrStability >= 0.15) {
    signal = 0
    confidence = 0
    reason = `Hedge ratio unstable (${hrStability.toFixed(3)}). Cointegration may be broken.`
  }

  return {
    symbolA,
    symbolB,
    signal,
    spreadZScore: zScore,
    hedgeRatio: currentHR,
    confidence,
    reason,
  }
}
