/**
 * Strategy Decision Interface
 *
 * This is the ONLY interface through which the execution layer depends on strategy.
 * The execution layer (CcxtTradingEngineAdapter) must NOT call evaluateRuntimeFactorSnapshot
 * or any strategy runtime internals directly. It only receives this StrategyDecision object.
 */

import type { AssetLayer, PositionSizingDecision } from './position-sizing/index.js'
import type { RegimeEvaluation } from './regime/index.js'
import type { FactorSignal } from './factors/index.js'
import type { GovernanceEvaluation } from './governance/index.js'

/**
 * The ONLY strategy output that execution may consume.
 * All complexity of factor evaluation, HMM regime, position sizing is
 * encapsulated in this flat, decision-focused interface.
 */
export interface StrategyDecision {
  /** Trading action recommended by the strategy layer */
  action: 'enter' | 'exit' | 'reduce' | 'hold' | 'no-trade'
  /** How strong the signal is (0-1) */
  confidence: number
  /** Current HMM regime state */
  regime: string
  /** Summary of the dominant factor signals */
  dominantFactors: Array<{
    name: string
    value: number
  }>
  /** Aggregate factor ensemble value (-1 to 1) */
  ensembleValue: number
  /** Position sizing recommendation */
  positionSizing: {
    assetLayer: AssetLayer
    recommendedPctOfEquity: number
    requestedPctOfEquity: number
    maxPositionPctOfEquity: number
    method: string
  }
  /** Whether freeze windows are active */
  freezeActive: boolean
  /** Max action allowed during freeze */
  maxActionDuringFreeze?: 'reduce' | 'exit' | 'no-trade' | 'hold'
  /** Source of this decision (for audit) */
  source: 'runtime-evaluator' | 'fallback' | 'freeze-blocked'
  /** Reason for fallback/blocked decisions */
  reason?: string
}
