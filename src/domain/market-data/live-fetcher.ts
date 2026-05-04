/**
 * Live Market Data Fetcher - OKX via undici + proxy.
 *
 * Provides real-time OHLCV, ticker, and funding rate data.
 * Uses OKX public API (no auth needed for market data).
 */

import { request, ProxyAgent } from 'undici'

const OKX_BASE = 'https://www.okx.com'

let _dispatcher: InstanceType<typeof ProxyAgent> | null = null
let _dispatcherProxyUrl: string | null = null

function dispatcher() {
  const proxyUrl = resolveProxyUrl()
  if (!proxyUrl) return undefined
  if (!_dispatcher || _dispatcherProxyUrl !== proxyUrl) {
    _dispatcher = new ProxyAgent(proxyUrl)
    _dispatcherProxyUrl = proxyUrl
  }
  return _dispatcher
}

function resolveProxyUrl(): string | null {
  const raw =
    process.env.OPENALICE_MARKET_DATA_PROXY_URL ??
    process.env.HTTPS_PROXY ??
    process.env.HTTP_PROXY ??
    ''
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

export interface LiveCandle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface LiveTicker {
  symbol: string
  last: number
  bid: number
  ask: number
  high24h: number
  low24h: number
  volume24h: number
  fundingRate?: number
  nextFundingTime?: number
}

async function okxGet<T = any>(path: string): Promise<T> {
  const url = OKX_BASE + path
  const proxyDispatcher = dispatcher()
  const { body } = await request(
    url,
    proxyDispatcher ? { dispatcher: proxyDispatcher } : undefined,
  )
  return body.json() as T
}

/** All OKX supported bar intervals */
export type BarInterval =
  | '1s'
  | '1m' | '3m' | '5m' | '15m' | '30m'
  | '1H' | '2H' | '4H' | '6H' | '12H'
  | '1D' | '2D' | '3D' | '5D'
  | '1W' | '1M' | '1Q'

/** Fetch OHLCV candles from OKX. instId example: "BTC-USDT-SWAP" */
export async function fetchLiveCandles(
  instId: string,
  bar: BarInterval = '1H',
  limit = 200,
  after?: number,
): Promise<LiveCandle[]> {
  let path = `/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`
  if (after) path += `&after=${after}`
  const res = await okxGet<{ code: string; data: string[][] }>(path)
  if (res.code !== '0' || !res.data) return []
  // OKX returns newest first. Keep in chronological order (oldest first).
  return res.data.map((row) => ({
    timestamp: parseInt(row[0]),
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),
    volume: parseFloat(row[5]),
  })).reverse()
}

/** Fetch latest ticker for a symbol */
export async function fetchLiveTicker(instId: string): Promise<LiveTicker | null> {
  const res = await okxGet<{ code: string; data: Array<Record<string, string>> }>(
    `/api/v5/market/ticker?instId=${instId}`,
  )
  if (res.code !== '0' || !res.data?.[0]) return null
  const d = res.data[0]
  return {
    symbol: d.instId,
    last: parseFloat(d.last),
    bid: parseFloat(d.bidPx ?? d.last),
    ask: parseFloat(d.askPx ?? d.last),
    high24h: parseFloat(d.high24h),
    low24h: parseFloat(d.low24h),
    volume24h: parseFloat(d.vol24h),
  }
}

/** Fetch funding rate for perpetual swap */
export async function fetchLiveFundingRate(instId: string): Promise<{
  fundingRate: number
  nextFundingTime: number
} | null> {
  const res = await okxGet<{ code: string; data: Array<Record<string, string>> }>(
    `/api/v5/public/funding-rate?instId=${instId}`,
  )
  if (res.code !== '0' || !res.data?.[0]) return null
  return {
    fundingRate: parseFloat(res.data[0].fundingRate),
    nextFundingTime: parseInt(res.data[0].nextFundingTime),
  }
}

/** Fetch multiple tickers at once */
export async function fetchLiveTickers(instIds: string[]): Promise<Map<string, LiveTicker>> {
  const map = new Map<string, LiveTicker>()
  // Fetch one by one to avoid rate limits
  for (const id of instIds) {
    try {
      const ticker = await fetchLiveTicker(id)
      if (ticker) map.set(id, ticker)
    } catch {}
  }
  return map
}

/**
 * Fetch extended historical candles for research.
 * OKX limits to 300 candles per request, so we paginate.
 */
/**
 * Fetch extended historical candles for research.
 * Handles OKX's 300-candle limit via before-pagination.
 */
export async function fetchExtendedCandles(
  instId: string,
  bar: BarInterval = '1H',
  maxCandles = 5000,
): Promise<LiveCandle[]> {
  const seen = new Set<number>()
  const all: LiveCandle[] = []
  let after: number | undefined
  let iterations = 0

  while (all.length < maxCandles && iterations < 30) {
    const batch = await fetchLiveCandles(instId, bar, 300, after)
    if (batch.length === 0) break

    let newBars = 0
    for (const c of batch) {
      if (!seen.has(c.timestamp)) {
        seen.add(c.timestamp)
        all.push(c)
        newBars++
      }
    }

    // batch is oldest-first (reversed from OKX). batch[0] = oldest bar.
    const oldest = batch[0].timestamp
    if (oldest === after) break
    after = oldest
    iterations++

    if (newBars === 0) break
  }
  return all
}

// ==================== Binance Futures Fetcher ====================

const BINANCE_BASE = 'https://fapi.binance.com'

async function binanceGet<T = any>(path: string): Promise<T> {
  const url = BINANCE_BASE + path
  const proxyDispatcher = dispatcher()
  const { body } = await request(
    url,
    proxyDispatcher ? { dispatcher: proxyDispatcher } : undefined,
  )
  return body.json() as T
}

/** Binance interval format (same values, different case convention) */
export type BinanceInterval = '1s' | '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '8h' | '12h' | '1d' | '3d' | '1w' | '1M'

function barToBinanceInterval(bar: BarInterval): string {
  const m: Record<string, string> = { '1s': '1s', '1H': '1h', '4H': '4h', '2H': '2h', '6H': '6h', '12H': '12h', '1D': '1d', '2D': '2d', '3D': '3d', '5D': '5d', '1W': '1w', '1M': '1M', '1Q': '3M' }
  return m[bar] ?? bar.toLowerCase()
}

/** Fetch a single page of Binance futures klines. endTime: optionally paginate backward from this timestamp (ms). */
export async function fetchBinanceCandles(
  symbol: string,
  interval: BarInterval = '1H',
  limit = 1000,
  endTime?: number,
): Promise<LiveCandle[]> {
  let path = `/fapi/v1/klines?symbol=${symbol}&interval=${barToBinanceInterval(interval)}&limit=${limit}`
  if (endTime) path += `&endTime=${endTime}`
  const data = await binanceGet<(string | number)[][]>(path)
  if (!Array.isArray(data)) return []
  return data.map((row) => ({
    timestamp: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  }))
}

/**
 * Fetch deep historical candles from Binance futures.
 * Binance supports up to 1000 candles per request with no hard limit on history.
 */
export async function fetchBinanceExtendedCandles(
  symbol: string,
  interval: BarInterval = '1H',
  maxCandles = 10000,
): Promise<LiveCandle[]> {
  const seen = new Set<number>()
  const all: LiveCandle[] = []
  let endTime: number | undefined
  let iterations = 0

  while (all.length < maxCandles && iterations < 40) {
    const batch = await fetchBinanceCandles(symbol, interval, 1000, endTime)
    if (batch.length === 0) break

    let newBars = 0
    for (const c of batch) {
      if (!seen.has(c.timestamp)) {
        seen.add(c.timestamp)
        all.push(c)
        newBars++
      }
    }

    // Binance returns oldest-first. batch[0] = oldest in this page.
    const oldest = batch[0].timestamp
    if (oldest === endTime) break
    endTime = oldest - 1 // subtract 1ms to avoid overlap
    iterations++

    if (newBars === 0) break
  }
  return all
}

/** Convert to MarketData-compatible CSV format */
export function candlesToCSV(candles: LiveCandle[], symbol: string, exchange: string): string {
  const lines = ['timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange']
  for (const c of candles) {
    lines.push([
      c.timestamp,
      new Date(c.timestamp).toISOString(),
      c.open, c.high, c.low, c.close, c.volume,
      symbol, '1h', exchange,
    ].join(','))
  }
  return lines.join('\n')
}
