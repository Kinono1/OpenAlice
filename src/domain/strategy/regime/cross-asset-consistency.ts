import type { MarketRegime } from './types.js'

export interface CrossAssetRegimeState {
  symbol: string
  regime: MarketRegime
  confidence: number
}

export interface CrossAssetRegimeConsistencyInput {
  states: CrossAssetRegimeState[]
  minConfidence?: number
  anchorSymbols?: string[]
}

export interface CrossAssetRegimeConsistency {
  consistent: boolean
  systemicRegime: MarketRegime | null
  highConfidenceCount: number
  disagreementCount: number
  anchorDisagreement: boolean
  reasons: string[]
}

const SYSTEMIC_REGIMES = new Set<MarketRegime>(['vol-stress', 'bear-trend'])
const RISK_ON_REGIMES = new Set<MarketRegime>(['trend-follow', 'range-rotation'])

export function evaluateCrossAssetRegimeConsistency(
  input: CrossAssetRegimeConsistencyInput,
): CrossAssetRegimeConsistency {
  const minConfidence = input.minConfidence ?? 0.55
  const highConfidence = input.states.filter((state) => state.confidence >= minConfidence)
  if (highConfidence.length < 2) {
    return {
      consistent: true,
      systemicRegime: null,
      highConfidenceCount: highConfidence.length,
      disagreementCount: 0,
      anchorDisagreement: false,
      reasons: ['insufficient high-confidence cross-asset regime states'],
    }
  }

  const systemicStates = highConfidence.filter((state) => SYSTEMIC_REGIMES.has(state.regime))
  const riskOnStates = highConfidence.filter((state) => RISK_ON_REGIMES.has(state.regime))
  const systemicRegime = majorityRegime(systemicStates)
  const disagreementCount = systemicStates.length > 0 && riskOnStates.length > 0
    ? Math.min(systemicStates.length, riskOnStates.length)
    : 0
  const anchorDisagreement = hasAnchorDisagreement(highConfidence, input.anchorSymbols ?? ['BTC', 'ETH'])
  const consistent = disagreementCount === 0 && !anchorDisagreement
  const reasons = consistent
    ? ['cross-asset regimes are internally consistent']
    : [
        disagreementCount > 0
          ? 'systemic stress and risk-on regimes coexist across high-confidence assets'
          : '',
        anchorDisagreement ? 'anchor assets disagree on systemic regime state' : '',
      ].filter(Boolean)

  return {
    consistent,
    systemicRegime,
    highConfidenceCount: highConfidence.length,
    disagreementCount,
    anchorDisagreement,
    reasons,
  }
}

function majorityRegime(states: CrossAssetRegimeState[]): MarketRegime | null {
  if (states.length === 0) {
    return null
  }
  const counts = new Map<MarketRegime, number>()
  for (const state of states) {
    counts.set(state.regime, (counts.get(state.regime) ?? 0) + 1)
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
}

function hasAnchorDisagreement(states: CrossAssetRegimeState[], anchorSymbols: string[]): boolean {
  const normalizedAnchors = new Set(anchorSymbols.map((symbol) => symbol.toUpperCase()))
  const anchors = states.filter((state) => normalizedAnchors.has(normalizeSymbolRoot(state.symbol)))
  if (anchors.length < 2) {
    return false
  }
  const systemicFlags = anchors.map((state) => SYSTEMIC_REGIMES.has(state.regime))
  return new Set(systemicFlags).size > 1
}

function normalizeSymbolRoot(symbol: string): string {
  return symbol.toUpperCase().split(/[/_:.-]/u)[0] ?? symbol.toUpperCase()
}
