import type { PairsSignal, SpreadSnapshot } from './types.js'
import type { CointegrationResult } from './types.js'

export interface PairsSpreadConfig {
  entryZScore?: number
  exitZScore?: number
  /** Rolling window for live z-score normalization */
  zScoreWindow?: number
}

const DEFAULT: Required<PairsSpreadConfig> = {
  entryZScore: 2.0,
  exitZScore: 0.5,
  zScoreWindow: 100,
}

/**
 * Compute the current spread and z-score for a cointegrated pair.
 * Uses the hedge ratio and long-run stats from the offline cointegration result.
 */
export function computeSpreadSnapshot(
  symbolA: string,
  symbolB: string,
  priceA: number,
  priceB: number,
  coint: CointegrationResult,
  recentSpreads: number[],
): SpreadSnapshot {
  const spread = priceA - coint.hedgeRatio * priceB

  // Use rolling window for live normalization if enough history, else use offline stats
  let mean = coint.spreadMean
  let std = coint.spreadStd
  if (recentSpreads.length >= 20) {
    mean = recentSpreads.reduce((s, v) => s + v, 0) / recentSpreads.length
    const variance = recentSpreads.reduce((s, v) => s + (v - mean) ** 2, 0) / recentSpreads.length
    std = Math.sqrt(variance)
  }

  const zScore = std > 0 ? (spread - mean) / std : 0

  return {
    symbol: `${symbolA}/${symbolB}`,
    symbolA,
    symbolB,
    hedgeRatio: coint.hedgeRatio,
    spread,
    zScore,
    spreadMean: mean,
    spreadStd: std,
    halfLife: coint.halfLife,
    timestamp: Date.now(),
  }
}

/**
 * Generate a pairs trading signal from a spread snapshot.
 * Returns direction +1 (long A / short B) or -1 (short A / long B) or 0 (flat).
 */
export function evaluatePairsSignal(
  snapshot: SpreadSnapshot,
  currentDirection: 1 | -1 | 0,
  config: PairsSpreadConfig = {},
): PairsSignal {
  const { entryZScore, exitZScore } = { ...DEFAULT, ...config }
  const z = snapshot.zScore

  let direction: 1 | -1 | 0 = currentDirection

  if (currentDirection === 0) {
    // Entry logic
    if (z > entryZScore) direction = -1       // spread too high -> short A / long B
    else if (z < -entryZScore) direction = 1  // spread too low  -> long A / short B
  } else {
    // Exit logic: close when spread reverts past exit threshold
    if (currentDirection === -1 && z <= exitZScore) direction = 0
    if (currentDirection === 1 && z >= -exitZScore) direction = 0
  }

  // Confidence scales with |z| beyond entry threshold, capped at 1
  const excess = Math.max(Math.abs(z) - entryZScore, 0)
  const confidence = direction !== 0 ? Math.min(excess / entryZScore, 1) : 0

  return {
    symbolA: snapshot.symbolA,
    symbolB: snapshot.symbolB,
    hedgeRatio: snapshot.hedgeRatio,
    zScore: z,
    direction,
    confidence,
    halfLife: snapshot.halfLife,
    entryThreshold: entryZScore,
    exitThreshold: exitZScore,
  }
}
