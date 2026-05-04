export interface CointegrationResult {
  /** Engle-Granger ADF t-stat on residuals (more negative = stronger cointegration) */
  adfTStat: number
  /** p-value approximation; < 0.05 = reject unit root = cointegrated */
  pValue: number
  /** OLS hedge ratio: spread = priceA - hedgeRatio * priceB */
  hedgeRatio: number
  /** Half-life of mean reversion in bars */
  halfLife: number
  /** Long-run mean of the spread */
  spreadMean: number
  /** Spread standard deviation */
  spreadStd: number
  /** Whether the pair passes the cointegration gate */
  isCointegrated: boolean
}

export interface SpreadSnapshot {
  symbol: string
  symbolA: string
  symbolB: string
  hedgeRatio: number
  spread: number
  zScore: number
  spreadMean: number
  spreadStd: number
  halfLife: number
  timestamp: number
}

export interface PairsSignal {
  symbolA: string
  symbolB: string
  hedgeRatio: number
  zScore: number
  /** +1 = long A / short B, -1 = short A / long B, 0 = flat */
  direction: 1 | -1 | 0
  confidence: number
  halfLife: number
  entryThreshold: number
  exitThreshold: number
}

export interface FundingArbSignal {
  symbol: string
  fundingRate: number
  /** Annualized funding yield (fundingRate * paymentsPerYear) */
  annualizedYield: number
  /** Annualized yield after explicit carry costs and spread/basis penalties. */
  netAnnualizedYield: number
  /** true = long spot + short perp (collect positive funding) */
  direction: 'long_spot_short_perp' | 'short_spot_long_perp' | 'none'
  confidence: number
  isPegged: boolean
  deltaNeutral: boolean
  reasons: string[]
}
