/**
 * Multi-Exchange Funding Rate Monitor.
 *
 * Tracks funding rates across Binance, Bybit, OKX simultaneously.
 * Detects cross-exchange funding spreads for arbitrage.
 *
 * Practitioner: Wintermute / GSR cross-exchange funding capture
 */

export interface ExchangeFundingRate {
  exchange: 'binance' | 'bybit' | 'okx'
  symbol: string
  fundingRate: number
  nextFundingTime: number
  markPrice: number
  indexPrice: number
  timestamp: number
}

export interface FundingSpreadOpportunity {
  symbol: string
  longExchange: string
  shortExchange: string
  spreadAnnualized: number
  netAfterFeesAnnualized: number
  confidence: number
  expiresAtMs: number
}

export interface MultiExchangeFundingConfig {
  /** Minimum annualized spread to trigger arbitrage */
  minSpreadAnnualized?: number
  /** Estimated round-trip cost in bps */
  roundTripCostBps?: number
  /** Minimum time until next funding settlement (ms) */
  minTimeToSettlementMs?: number
  /** Monitored symbols */
  symbols?: string[]
  /** Deterministic clock override for tests/replay. Defaults to Date.now(). */
  nowMs?: number
}

const DEFAULT_CONFIG: Required<Omit<MultiExchangeFundingConfig, 'nowMs'>> = {
  minSpreadAnnualized: 0.05, // 5% annualized
  roundTripCostBps: 5, // 5bps round trip
  minTimeToSettlementMs: 600_000, // 10 minutes
  symbols: ['BTC-USDT', 'ETH-USDT'],
}

const PAYMENTS_PER_YEAR = 3 * 365 // 3 times daily × 365 days

export function detectFundingSpreadOpportunities(
  rates: ExchangeFundingRate[],
  config: MultiExchangeFundingConfig = {},
): FundingSpreadOpportunity[] {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const nowMs = config.nowMs ?? Date.now()
  const opportunities: FundingSpreadOpportunity[] = []

  for (const symbol of cfg.symbols) {
    const symbolRates = rates.filter(
      r => r.symbol === symbol &&
        r.nextFundingTime > nowMs + cfg.minTimeToSettlementMs &&
        isUsableFundingRate(r),
    )
    if (symbolRates.length < 2) continue

    for (let i = 0; i < symbolRates.length; i++) {
      for (let j = i + 1; j < symbolRates.length; j++) {
        const a = symbolRates[i]
        const b = symbolRates[j]

        const spread = a.fundingRate - b.fundingRate
        const costPerTrade = cfg.roundTripCostBps / 10_000
        const spreadAnnualized = Math.abs(spread) * PAYMENTS_PER_YEAR
        const costAnnualized = costPerTrade * PAYMENTS_PER_YEAR
        const netAnnualized = spreadAnnualized - costAnnualized

        if (netAnnualized < cfg.minSpreadAnnualized) continue

        const longExchange = spread > 0 ? b.exchange : a.exchange
        const shortExchange = spread > 0 ? a.exchange : b.exchange

        const nextSettlement = Math.min(a.nextFundingTime, b.nextFundingTime)
        const confidence = Math.min(netAnnualized / cfg.minSpreadAnnualized / 3, 1)

        opportunities.push({
          symbol,
          longExchange,
          shortExchange,
          spreadAnnualized,
          netAfterFeesAnnualized: netAnnualized,
          confidence,
          expiresAtMs: nextSettlement,
        })
      }
    }
  }

  return opportunities.sort((a, b) => b.netAfterFeesAnnualized - a.netAfterFeesAnnualized)
}

export function aggregateExchangeFundingStats(
  rates: ExchangeFundingRate[],
): Map<string, { min: number; max: number; mean: number; spread: number; count: number }> {
  const bySymbol = new Map<string, ExchangeFundingRate[]>()
  for (const r of rates) {
    if (!isUsableFundingRate(r)) continue
    const list = bySymbol.get(r.symbol) ?? []
    list.push(r)
    bySymbol.set(r.symbol, list)
  }

  const stats = new Map<string, { min: number; max: number; mean: number; spread: number; count: number }>()
  for (const [symbol, list] of bySymbol) {
    const values = list.map(r => r.fundingRate)
    const min = Math.min(...values)
    const max = Math.max(...values)
    const mean = values.reduce((s, v) => s + v, 0) / values.length
    stats.set(symbol, { min, max, mean, spread: max - min, count: values.length })
  }

  return stats
}

function isUsableFundingRate(rate: ExchangeFundingRate): boolean {
  return Boolean(rate.symbol) &&
    Number.isFinite(rate.fundingRate) &&
    Number.isFinite(rate.nextFundingTime) &&
    Number.isFinite(rate.markPrice) &&
    rate.markPrice > 0 &&
    Number.isFinite(rate.indexPrice) &&
    rate.indexPrice > 0 &&
    Number.isFinite(rate.timestamp)
}
