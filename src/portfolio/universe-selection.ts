export interface AssetReturnSeries {
  symbol: string
  returns: number[]
}

export interface RollingSharpeUniverseSelectionConfig {
  lookback: number
  minObservations: number
  annualizationFactor: number
  minLongSharpe: number
  minShortSharpe: number
}

export interface RollingSharpeAssetScore {
  symbol: string
  sampleCount: number
  rollingSharpe: number | null
  longEligible: boolean
  shortEligible: boolean
  reason: string
}

export interface RollingSharpeUniverseSelection {
  longSymbols: string[]
  shortSymbols: string[]
  scores: RollingSharpeAssetScore[]
}

export const DEFAULT_ROLLING_SHARPE_UNIVERSE_CONFIG: RollingSharpeUniverseSelectionConfig = {
  lookback: 24 * 30,
  minObservations: 24 * 14,
  annualizationFactor: 24 * 365,
  minLongSharpe: 1.3,
  minShortSharpe: 1.7,
}

export function selectUniverseByRollingSharpe(
  assets: AssetReturnSeries[],
  config: Partial<RollingSharpeUniverseSelectionConfig> = {},
): RollingSharpeUniverseSelection {
  const resolved = {
    ...DEFAULT_ROLLING_SHARPE_UNIVERSE_CONFIG,
    ...config,
  }
  const scores = assets.map((asset) => scoreRollingSharpeAsset(asset, resolved))
  return {
    longSymbols: scores.filter((score) => score.longEligible).map((score) => score.symbol),
    shortSymbols: scores.filter((score) => score.shortEligible).map((score) => score.symbol),
    scores,
  }
}

function scoreRollingSharpeAsset(
  asset: AssetReturnSeries,
  config: RollingSharpeUniverseSelectionConfig,
): RollingSharpeAssetScore {
  const window = asset.returns
    .filter((value) => Number.isFinite(value))
    .slice(-Math.max(1, Math.floor(config.lookback)))
  if (window.length < config.minObservations) {
    return {
      symbol: asset.symbol,
      sampleCount: window.length,
      rollingSharpe: null,
      longEligible: false,
      shortEligible: false,
      reason: `insufficient observations ${window.length}/${config.minObservations}`,
    }
  }

  const sharpe = annualizedSharpe(window, config.annualizationFactor)
  return {
    symbol: asset.symbol,
    sampleCount: window.length,
    rollingSharpe: sharpe,
    longEligible: sharpe >= config.minLongSharpe,
    shortEligible: -sharpe >= config.minShortSharpe,
    reason:
      sharpe >= config.minLongSharpe
        ? 'long rolling Sharpe threshold passed'
        : -sharpe >= config.minShortSharpe
          ? 'short rolling Sharpe threshold passed'
          : 'rolling Sharpe below long/short thresholds',
  }
}

function annualizedSharpe(values: number[], annualizationFactor: number): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1)
  const sigma = Math.sqrt(Math.max(variance, 0))
  if (sigma === 0) {
    return mean > 0 ? Number.POSITIVE_INFINITY : mean < 0 ? Number.NEGATIVE_INFINITY : 0
  }
  return (mean / sigma) * Math.sqrt(Math.max(annualizationFactor, 1))
}
