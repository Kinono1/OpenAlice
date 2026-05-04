import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import dns from 'node:dns'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ccxt from 'ccxt'

dns.setDefaultResultOrder('ipv4first')
const execFileAsync = promisify(execFile)

interface CliArgs {
  exchange: string
  symbol: string
  kind: 'funding' | 'open_interest' | 'both'
  timeframe: string
  sinceMs?: number
  endMs?: number
  limit: number
  outputDir: string
  selfCheck: boolean
  dryRun: boolean
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.selfCheck || args.dryRun) {
    console.log(JSON.stringify(args, null, 2))
    return
  }

  const exchange = createPublicExchange(args.exchange)

  const outputDir = resolve(args.outputDir)
  await mkdir(outputDir, { recursive: true })

  if (args.kind === 'funding' || args.kind === 'both') {
    const funding = await fetchFundingRateHistory(
      exchange,
      args.exchange,
      args.symbol,
      args.sinceMs,
      args.endMs,
      args.limit,
    )
    const fundingPath = resolve(outputDir, `${sanitize(args.exchange)}_${sanitize(args.symbol)}_funding_history.json`)
    await writeFile(fundingPath, `${JSON.stringify(funding, null, 2)}\n`, 'utf-8')
    console.log(fundingPath)
  }

  if (args.kind === 'open_interest' || args.kind === 'both') {
    const openInterest = await fetchOpenInterestHistory(
      exchange,
      args.exchange,
      args.symbol,
      args.timeframe,
      args.sinceMs,
      args.limit,
    )
    const oiPath = resolve(outputDir, `${sanitize(args.exchange)}_${sanitize(args.symbol)}_open_interest_history.json`)
    await writeFile(oiPath, `${JSON.stringify(openInterest, null, 2)}\n`, 'utf-8')
    console.log(oiPath)
  }
}

type PublicCcxtExchange = {
  fetchFundingRateHistory?: (
    symbol: string,
    since?: number,
    limit?: number,
    params?: Record<string, unknown>,
  ) => Promise<Array<Record<string, unknown>>>
  fetchOpenInterestHistory?: (
    symbol: string,
    timeframe?: string,
    since?: number,
    limit?: number,
    params?: Record<string, unknown>,
  ) => Promise<Array<Record<string, unknown>>>
}

function createPublicExchange(exchangeId: string): PublicCcxtExchange {
  const exchanges = ccxt as unknown as Record<string, new (opts: Record<string, unknown>) => PublicCcxtExchange>
  const ExchangeClass = exchanges[exchangeId]
  if (!ExchangeClass) {
    throw new Error(`Unknown CCXT exchange: ${exchangeId}`)
  }
  return new ExchangeClass({
    enableRateLimit: true,
    options: {
      fetchMarkets: { types: ['linear', 'inverse', 'spot'] },
    },
  })
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim().replace(/,/g, ''))
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
}

async function fetchFundingRateHistory(
  exchange: PublicCcxtExchange,
  exchangeId: string,
  symbol: string,
  sinceMs?: number,
  endMs?: number,
  limit = 200,
) {
  if (exchangeId === 'binance') {
    return await fetchBinanceFundingRateHistory(symbol, sinceMs, endMs, limit)
  }
  try {
    if (typeof exchange.fetchFundingRateHistory !== 'function') {
      throw new Error('Exchange does not support fetchFundingRateHistory')
    }
    const rows = await exchange.fetchFundingRateHistory(symbol, sinceMs, limit, {})
    return (rows ?? [])
      .map((row) => {
        const record = asRecord(row)
        const info = asRecord(record.info)
        const timestamp =
          toFiniteNumber(record.timestamp) ??
          toFiniteNumber(info.timestamp) ??
          Date.now()
        return {
          symbol,
          fundingRate:
            toFiniteNumber(record.fundingRate) ??
            toFiniteNumber(info.fundingRate) ??
            0,
          previousFundingRate:
            toFiniteNumber(record.previousFundingRate) ??
            toFiniteNumber(info.previousFundingRate),
          timestamp,
        }
      })
      .sort((left, right) => left.timestamp - right.timestamp)
  } catch (error) {
    if (isBybitTimeout(error)) {
      return await fetchBybitFundingRateHistory(symbol, sinceMs, limit)
    }
    throw error
  }
}

async function fetchOpenInterestHistory(
  exchange: PublicCcxtExchange,
  exchangeId: string,
  symbol: string,
  timeframe: string,
  sinceMs?: number,
  limit = 200,
) {
  if (exchangeId === 'binance') {
    return await fetchBinanceOpenInterestHistory(symbol, timeframe, limit)
  }
  try {
    if (typeof exchange.fetchOpenInterestHistory !== 'function') {
      throw new Error('Exchange does not support fetchOpenInterestHistory')
    }
    const rows = await exchange.fetchOpenInterestHistory(symbol, timeframe, sinceMs, limit, {})
    return (rows ?? [])
      .map((row) => {
        const record = asRecord(row)
        const info = asRecord(record.info)
        const timestamp =
          toFiniteNumber(record.timestamp) ??
          toFiniteNumber(info.timestamp) ??
          Date.now()
        return {
          symbol,
          timeframe,
          openInterest:
            toFiniteNumber(record.openInterest) ??
            toFiniteNumber(record.openInterestAmount) ??
            toFiniteNumber(info.openInterest) ??
            toFiniteNumber(info.openInterestAmount) ??
            0,
          openInterestValue:
            toFiniteNumber(record.openInterestValue) ??
            toFiniteNumber(record.notionalValue) ??
            toFiniteNumber(info.openInterestValue) ??
            toFiniteNumber(info.notionalValue),
          timestamp,
        }
      })
      .sort((left, right) => left.timestamp - right.timestamp)
  } catch (error) {
    if (isBybitTimeout(error)) {
      return await fetchBybitOpenInterestHistory(symbol, timeframe, limit)
    }
    throw error
  }
}

function isBybitTimeout(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return /bybit/i.test(text) && /timed out/i.test(text)
}

function toBybitCategory(symbol: string): 'linear' | 'inverse' {
  return symbol.includes(':USDT') || symbol.includes(':USDC') ? 'linear' : 'inverse'
}

function toBinanceMarketId(symbol: string): string {
  const base = symbol.split('/')[0] ?? symbol
  const settle = symbol.split(':')[1] ?? symbol.split('/')[1] ?? ''
  return `${base}${settle}`.replace(/[^A-Z0-9]/gi, '').toUpperCase()
}

async function fetchBinanceFundingRateHistory(
  symbol: string,
  sinceMs: number | undefined,
  endMs: number | undefined,
  limit = 200,
) {
  const marketId = toBinanceMarketId(symbol)
  const rows: Array<Record<string, unknown>> = []
  let nextStart = sinceMs
  const maxLimit = Math.min(limit, 1000)

  while (true) {
    const params = new URLSearchParams({
      symbol: marketId,
      limit: String(maxLimit),
    })
    if (typeof nextStart === 'number') {
      params.set('startTime', String(nextStart))
    }
    if (typeof endMs === 'number') {
      params.set('endTime', String(endMs))
    }

    const batch = await fetchJsonWithCurlFallback<Array<Record<string, unknown>>>(
      `https://fapi.binance.com/fapi/v1/fundingRate?${params}`,
    )
    if (!Array.isArray(batch) || batch.length === 0) {
      break
    }
    rows.push(...batch)

    if (batch.length < maxLimit) {
      break
    }

    const lastFundingTime = toFiniteNumber(batch[batch.length - 1]?.fundingTime)
    if (!(typeof lastFundingTime === 'number' && Number.isFinite(lastFundingTime))) {
      break
    }
    const candidateNextStart = lastFundingTime + 1
    if (typeof endMs === 'number' && candidateNextStart > endMs) {
      break
    }
    if (typeof nextStart === 'number' && candidateNextStart <= nextStart) {
      break
    }
    nextStart = candidateNextStart
  }

  return rows
    .map((row) => ({
      symbol,
      fundingRate: toFiniteNumber(row.fundingRate) ?? 0,
      previousFundingRate: undefined,
      timestamp: toFiniteNumber(row.fundingTime) ?? Date.now(),
    }))
    .sort((left, right) => left.timestamp - right.timestamp)
}

async function fetchBinanceOpenInterestHistory(
  symbol: string,
  timeframe: string,
  limit = 200,
) {
  const marketId = toBinanceMarketId(symbol)
  const params = new URLSearchParams({
    symbol: marketId,
    period: timeframe.toLowerCase(),
    limit: String(limit),
  })
  const rows = await fetchJsonWithCurlFallback<Array<Record<string, unknown>>>(
    `https://fapi.binance.com/futures/data/openInterestHist?${params}`,
  )
  return (rows ?? [])
    .map((row) => ({
      symbol,
      timeframe,
      openInterest:
        toFiniteNumber(row.sumOpenInterest) ??
        toFiniteNumber(row.openInterest) ??
        0,
      openInterestValue:
        toFiniteNumber(row.sumOpenInterestValue) ??
        toFiniteNumber(row.openInterestValue),
      timestamp: toFiniteNumber(row.timestamp) ?? Date.now(),
    }))
    .sort((left, right) => left.timestamp - right.timestamp)
}

async function fetchJsonWithCurlFallback<T>(url: string): Promise<T> {
  try {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`request failed: ${response.status} ${response.statusText}`)
    }
    return await response.json() as T
  } catch (error) {
    const { stdout } = await execFileAsync('curl', ['-L', '--max-time', '15', url], {
      maxBuffer: 4 * 1024 * 1024,
    })
    return JSON.parse(stdout) as T
  }
}

function toBybitMarketId(symbol: string): string {
  const base = symbol.split('/')[0] ?? symbol
  const settle = symbol.split(':')[1] ?? symbol.split('/')[1] ?? ''
  return `${base}${settle}`.replace(/[^A-Z0-9]/gi, '').toUpperCase()
}

async function fetchBybitFundingRateHistory(
  symbol: string,
  sinceMs?: number,
  limit = 200,
) {
  const category = toBybitCategory(symbol)
  const marketId = toBybitMarketId(symbol)
  const params = new URLSearchParams({
    category,
    symbol: marketId,
    limit: String(limit),
  })
  if (typeof sinceMs === 'number') {
    params.set('startTime', String(sinceMs))
  }
  const response = await fetch(`https://api.bybit.com/v5/market/funding/history?${params}`)
  if (!response.ok) {
    throw new Error(`Bybit funding history request failed: ${response.status} ${response.statusText}`)
  }
  const payload = asRecord(await response.json())
  const result = asRecord(payload.result)
  const rows = Array.isArray(result.list) ? result.list : []
  return rows
    .map((row) => {
      const record = asRecord(row)
      const timestamp =
        toFiniteNumber(record.fundingRateTimestamp) ??
        toFiniteNumber(record.timestamp) ??
        Date.now()
      return {
        symbol,
        fundingRate: toFiniteNumber(record.fundingRate) ?? 0,
        previousFundingRate: undefined,
        timestamp,
      }
    })
    .sort((left, right) => left.timestamp - right.timestamp)
}

async function fetchBybitOpenInterestHistory(
  symbol: string,
  timeframe: string,
  limit = 200,
) {
  const category = toBybitCategory(symbol)
  const marketId = toBybitMarketId(symbol)
  const params = new URLSearchParams({
    category,
    symbol: marketId,
    intervalTime: timeframe,
    limit: String(limit),
  })
  const response = await fetch(`https://api.bybit.com/v5/market/open-interest?${params}`)
  if (!response.ok) {
    throw new Error(`Bybit open interest history request failed: ${response.status} ${response.statusText}`)
  }
  const payload = asRecord(await response.json())
  const result = asRecord(payload.result)
  const rows = Array.isArray(result.list) ? result.list : []
  return rows
    .map((row) => {
      const record = asRecord(row)
      const timestamp =
        toFiniteNumber(record.timestamp) ??
        Date.now()
      return {
        symbol,
        timeframe,
        openInterest: toFiniteNumber(record.openInterest) ?? 0,
        openInterestValue: toFiniteNumber(record.openInterestValue),
        timestamp,
      }
    })
    .sort((left, right) => left.timestamp - right.timestamp)
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    exchange: raw.get('exchange') ?? 'binance',
    symbol: raw.get('symbol') ?? 'ETH/USDT:USDT',
    kind: parseKind(raw.get('kind')),
    timeframe: raw.get('timeframe') ?? '1h',
    sinceMs: parseOptionalInt(raw.get('sinceMs')),
    endMs: parseOptionalInt(raw.get('endMs')),
    limit: parsePositiveInt(raw.get('limit'), 200, 'limit'),
    outputDir: raw.get('outputDir') ?? 'data/research/derivatives_history',
    selfCheck: parseBoolArg(raw.get('selfCheck'), false),
    dryRun: parseBoolArg(raw.get('dryRun'), true),
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    index += 1
  }
  return out
}

function parseKind(raw: string | undefined): CliArgs['kind'] {
  if (raw === 'funding' || raw === 'open_interest' || raw === 'both') {
    return raw
  }
  return 'both'
}

function parsePositiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return value
}

function parseOptionalInt(raw: string | undefined): number | undefined {
  if (raw == null) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('sinceMs must be a non-negative integer.')
  }
  return value
}

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

function sanitize(value: string): string {
  return value.replace(/[/:]/g, '_')
}

export {
  parseArgs,
  sanitize,
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
