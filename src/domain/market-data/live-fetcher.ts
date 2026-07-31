/**
 * Live Market Data Fetcher - OKX via undici + proxy.
 *
 * Provides real-time OHLCV, ticker, and funding rate data.
 * Uses OKX public API (no auth needed for market data).
 */

import { request, ProxyAgent } from 'undici'

const DEFAULT_OKX_PUBLIC_HOSTS = ['www.okx.com', 'aws.okx.com', 'eea.okx.com', 'us.okx.com']

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

export function resolveProxyUrl(): string | null {
  if (parseBoolEnv(process.env.OPENALICE_MARKET_DATA_BYPASS_PROXY, false)) return null
  const explicitProxy = normalizeExplicitProxy(process.env.OPENALICE_MARKET_DATA_PROXY_URL)
  if (explicitProxy !== undefined) return explicitProxy

  const proxyCandidates = [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
  ]
  for (const raw of proxyCandidates) {
    const trimmed = raw?.trim() ?? ''
    if (trimmed.length > 0) return trimmed
  }
  return null
}

function normalizeExplicitProxy(raw: string | undefined): string | null | undefined {
  const trimmed = raw?.trim() ?? ''
  if (!trimmed) return undefined
  if (['0', 'false', 'no', 'none', 'direct', 'off'].includes(trimmed.toLowerCase())) return null
  return trimmed
}

function parseBoolEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

export function resolveOkxPublicApiBaseUrls(): string[] {
  const configured = parseHostList(
    process.env.OPENALICE_OKX_PUBLIC_API_BASE_URLS ??
    process.env.OPENALICE_OKX_PUBLIC_API_HOSTS ??
    process.env.OPENALICE_OKX_PUBLIC_API_HOST,
  )
  return dedupeStrings([
    ...configured,
    ...DEFAULT_OKX_PUBLIC_HOSTS.map(host => `https://${host}`),
  ])
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

export class OkxPublicApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null,
    public readonly errorClass: 'remote_permanent' | 'rate_limited' | 'remote_server_error' | 'transient_network' | 'remote_rejected',
    public readonly permanent: boolean,
  ) {
    super(message)
    this.name = 'OkxPublicApiError'
  }
}

export function classifyOkxHttpStatus(statusCode: number): Pick<OkxPublicApiError, 'errorClass' | 'permanent'> {
  if ([401, 403, 451].includes(statusCode)) return { errorClass: 'remote_permanent', permanent: true }
  if (statusCode === 429) return { errorClass: 'rate_limited', permanent: false }
  if (statusCode >= 500) return { errorClass: 'remote_server_error', permanent: false }
  return { errorClass: 'remote_rejected', permanent: statusCode >= 400 && statusCode < 500 }
}

export async function okxPublicGet<T = any>(path: string, timeoutMs = 15_000): Promise<T> {
  const proxyDispatcher = dispatcher()
  let lastError: unknown
  const bases = resolveOkxPublicApiBaseUrls().slice(0, 3)
  for (let attempt = 0; attempt < bases.length; attempt += 1) {
    const baseUrl = bases[attempt]
    try {
      const { body, statusCode } = await request(
        `${baseUrl}${path}`,
        {
          ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
        },
      )
      if (statusCode < 200 || statusCode >= 300) {
        const classified = classifyOkxHttpStatus(statusCode)
        const bodyText = await body.text().catch(() => '')
        const error = new OkxPublicApiError(
          `OKX public API HTTP ${statusCode}: ${bodyText.slice(0, 300)}`,
          statusCode,
          classified.errorClass,
          classified.permanent,
        )
        if (classified.permanent) throw error
        lastError = error
        if (attempt < bases.length - 1) await boundedRetryDelay(attempt, statusCode === 429)
        continue
      }
      return body.json() as T
    } catch (error) {
      if (error instanceof OkxPublicApiError && error.permanent) throw error
      lastError = error
      if (attempt < bases.length - 1) await boundedRetryDelay(attempt, error instanceof OkxPublicApiError && error.statusCode === 429)
    }
  }
  if (lastError instanceof OkxPublicApiError) throw lastError
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new OkxPublicApiError(
    `OKX public API request failed for all configured hosts: ${message}`,
    null,
    'transient_network',
    false,
  )
}

async function boundedRetryDelay(attempt: number, rateLimited: boolean): Promise<void> {
  const base = rateLimited ? 1_000 : attempt === 0 ? 250 : 750
  const jitter = Math.floor(Math.random() * 150)
  await new Promise(resolveDelay => setTimeout(resolveDelay, base + jitter))
}

function parseHostList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(/[,\s]+/)
    .map(item => item.trim())
    .filter(Boolean)
    .map(normalizePublicApiBaseUrl)
    .filter((item): item is string => item != null)
}

function normalizePublicApiBaseUrl(value: string): string | null {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`
  try {
    const parsed = new URL(withProtocol)
    if (!parsed.hostname) return null
    parsed.pathname = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.origin
  } catch {
    return null
  }
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)]
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
  const res = await okxPublicGet<{ code: string; data: string[][] }>(path)
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
  const res = await okxPublicGet<{ code: string; data: Array<Record<string, string>> }>(
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
  const res = await okxPublicGet<{ code: string; data: Array<Record<string, string>> }>(
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
