/**
 * Portfolio Risk Overlay — lightweight cross-asset exposure caps.
 *
 * This is NOT a portfolio optimizer. It is a safety layer that runs after
 * per-asset position sizing to enforce gross/net/single-asset limits
 * across the aggregate portfolio. It reads current broker positions and
 * pending operations, making no assumptions about internal cache state.
 *
 * v1: gross exposure cap, net exposure cap, max single-asset cap.
 * v2 (future): correlation-aware concentration caps via allocator.ts.
 */

import type {
  PortfolioRiskOverlayConfig,
  PortfolioPositionSummary,
  OverlayResult,
} from './types.js'
import type { RuntimeFactorSnapshot } from '../runtime-evaluator.js'

export type { PortfolioRiskOverlayConfig, PortfolioPositionSummary, OverlayResult }

export interface ApplyOverlayInput {
  /** The per-asset snapshot from runtime evaluation. */
  currentSnapshot: RuntimeFactorSnapshot
  /** Current open positions from the broker. */
  currentPositions: PortfolioPositionSummary[]
  /** Pending operations (staged + committed-not-pushed). */
  pendingOperations: PortfolioPositionSummary[]
  /** Overlay configuration from strategy config. */
  config: PortfolioRiskOverlayConfig
}

/**
 * Apply portfolio risk caps on top of the per-asset position sizing decision.
 * Returns the capped percentage of equity and the reasons for any caps applied.
 */
export function applyPortfolioRiskOverlay(input: ApplyOverlayInput): OverlayResult {
  if (!input.config.enabled) {
    return {
      cappedPct: input.currentSnapshot.positionSizing.recommendedPctOfEquity,
      originalPct: input.currentSnapshot.positionSizing.recommendedPctOfEquity,
      capped: false,
      reasons: ['portfolio risk overlay is disabled'],
    }
  }

  const reasons: string[] = []
  const equity = input.currentSnapshot.positionSizing.equity ?? 1
  const recommendedPct = input.currentSnapshot.positionSizing.recommendedPctOfEquity
  const recommendedNotional = input.currentSnapshot.positionSizing.recommendedNotionalUsd ?? 0

  // Aggregate current + pending exposure by symbol
  const symbolExposures = new Map<string, number>()
  for (const pos of input.currentPositions) {
    const current = symbolExposures.get(pos.symbol) ?? 0
    symbolExposures.set(pos.symbol, current + pos.notional)
  }
  for (const op of input.pendingOperations) {
    const current = symbolExposures.get(op.symbol) ?? 0
    symbolExposures.set(op.symbol, current + op.notional)
  }

  const symbol = input.currentSnapshot.symbol
  const currentExposure = symbolExposures.get(symbol) ?? 0

  // 1. Max single-asset cap
  const maxSingle = input.config.maxSingleAssetPctOfEquity
  let cappedPct = recommendedPct
  const proposedTotalPct = equity > 0 ? (currentExposure + recommendedNotional) / equity : 0
  if (proposedTotalPct > maxSingle) {
    const allowedAdditionalNotional = maxSingle * equity - currentExposure
    const allowedPct = Math.max(0, equity > 0 ? allowedAdditionalNotional / equity : 0)
    if (allowedPct < cappedPct) {
      reasons.push(
        `single-asset cap (${(maxSingle * 100).toFixed(0)}% of equity): proposed ${symbol} total would be ${(proposedTotalPct * 100).toFixed(1)}%`,
      )
      cappedPct = allowedPct
    }
  }

  // 2. Gross exposure cap
  let grossExposure = 0
  for (const [, notional] of symbolExposures) {
    grossExposure += Math.abs(notional)
  }
  const maxGross = input.config.maxGrossExposurePctOfEquity
  const proposedGross = equity > 0 ? (grossExposure + recommendedNotional) / equity : 0
  if (proposedGross > maxGross) {
    const availableGross = maxGross * equity - grossExposure
    if (availableGross < recommendedNotional) {
      const availablePct = Math.max(0, equity > 0 ? availableGross / equity : 0)
      if (availablePct < cappedPct) {
        reasons.push(
          `gross exposure cap (${(maxGross * 100).toFixed(0)}% of equity): gross would be ${(proposedGross * 100).toFixed(1)}%`,
        )
        cappedPct = availablePct
      }
    }
  }

  return {
    cappedPct,
    originalPct: recommendedPct,
    capped: cappedPct < recommendedPct,
    reasons: reasons.length > 0 ? reasons : ['within portfolio risk limits'],
  }
}
