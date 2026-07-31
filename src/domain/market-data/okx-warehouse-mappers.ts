import { payloadHash } from '../../../scripts/lib/okx_warehouse.js'
import type {
  OkxInstrumentRecord,
  OkxInstrumentType,
  OkxMarketDataset,
  OkxMarketEvent,
} from './okx-warehouse-types.js'

export interface OkxEnvelopeInput<T> {
  dataset: OkxMarketDataset
  instrumentType: OkxInstrumentType
  instrumentId: string
  instrumentFamily?: string | null
  symbol?: string
  channel: string
  sourceTransport: 'rest' | 'websocket' | 'derived'
  sourceEndpoint: string
  eventTime: string
  availableAt: string
  ingestedAt?: string
  confirmed?: boolean | null
  sequenceId?: string | null
  checksum?: string | null
  collectionRunId: string
  universeManifestId?: string | null
  dedupKey: string
  payload: T
}

export function buildOkxMarketEvent<T>(input: OkxEnvelopeInput<T>): OkxMarketEvent<T> {
  return {
    schemaVersion: 'okx_market_event.v1',
    exchange: 'okx',
    dataset: input.dataset,
    instrumentType: input.instrumentType,
    instrumentId: input.instrumentId,
    instrumentFamily: input.instrumentFamily ?? null,
    symbol: input.symbol ?? input.instrumentId,
    channel: input.channel,
    sourceTransport: input.sourceTransport,
    sourceEndpoint: input.sourceEndpoint,
    eventTime: input.eventTime,
    availableAt: input.availableAt,
    ingestedAt: input.ingestedAt ?? new Date().toISOString(),
    confirmed: input.confirmed ?? null,
    sequenceId: input.sequenceId ?? null,
    checksum: input.checksum ?? null,
    collectionRunId: input.collectionRunId,
    universeManifestId: input.universeManifestId ?? null,
    dedupKey: input.dedupKey,
    payloadHash: payloadHash(input.payload),
    payload: input.payload,
  }
}

export function mapOkxInstrument(raw: Record<string, unknown>, availableAt: string): OkxInstrumentRecord {
  const instrumentId = stringValue(raw.instId) ?? ''
  const instrumentType = normalizeInstrumentType(stringValue(raw.instType))
  if (!instrumentId) throw new Error('OKX instrument is missing instId')
  const eventTime = epochIso(raw.uTime) ?? epochIso(raw.listTime) ?? availableAt
  const optionType: 'C' | 'P' | null = raw.optType === 'C' ? 'C' : raw.optType === 'P' ? 'P' : null
  const versionedFields = {
    instrumentId,
    instrumentType,
    instrumentFamily: nullableString(raw.instFamily),
    underlying: nullableString(raw.uly),
    baseCurrency: nullableString(raw.baseCcy),
    quoteCurrency: nullableString(raw.quoteCcy),
    settleCurrency: nullableString(raw.settleCcy),
    contractValue: nullableString(raw.ctVal),
    contractMultiplier: nullableString(raw.ctMult),
    tickSize: stringValue(raw.tickSz) ?? '',
    lotSize: stringValue(raw.lotSz) ?? '',
    minimumOrderSize: stringValue(raw.minSz) ?? '',
    listingTime: epochIso(raw.listTime),
    expiryTime: epochIso(raw.expTime),
    optionType,
    strikePrice: nullableString(raw.stk),
    state: stringValue(raw.state) ?? 'unknown',
    marginEligibility: boolish(raw.mgnMode ?? raw.ruleType),
  }
  const normalized = {
    schemaVersion: 'okx_instrument.v1' as const,
    exchange: 'okx' as const,
    ...versionedFields,
    eventTime,
    availableAt,
  }
  return { ...normalized, payloadHash: payloadHash(versionedFields) }
}

export function mapOkxTicker(
  raw: Record<string, unknown>,
  instrumentType: Exclude<OkxInstrumentType, 'OPTION'>,
  collectionRunId: string,
  availableAt: string,
): OkxMarketEvent {
  const instrumentId = stringValue(raw.instId) ?? ''
  const eventTime = epochIso(raw.ts) ?? availableAt
  const bidPx = numberOrNull(raw.bidPx)
  const askPx = numberOrNull(raw.askPx)
  const last = numberOrNull(raw.last)
  const payload = {
    last,
    bidPx,
    askPx,
    bidSz: numberOrNull(raw.bidSz),
    askSz: numberOrNull(raw.askSz),
    open24h: numberOrNull(raw.open24h),
    high24h: numberOrNull(raw.high24h),
    low24h: numberOrNull(raw.low24h),
    baseVolume24h: numberOrNull(raw.vol24h),
    quoteVolume24h: numberOrNull(raw.volCcy24h),
    spread: bidPx != null && askPx != null ? askPx - bidPx : null,
    spreadBps: bidPx != null && askPx != null && bidPx > 0 && askPx > 0
      ? ((askPx - bidPx) / ((askPx + bidPx) / 2)) * 10_000
      : null,
  }
  return buildOkxMarketEvent({
    dataset: 'ticker', instrumentType, instrumentId, channel: 'tickers', sourceTransport: 'rest',
    sourceEndpoint: `/api/v5/market/tickers?instType=${instrumentType}`,
    eventTime, availableAt, collectionRunId,
    dedupKey: `okx|ticker|${instrumentId}|${eventTime}`,
    payload,
  })
}

export function mapOkxCandle(input: {
  raw: unknown[]
  instrumentId: string
  instrumentType: 'SPOT' | 'SWAP'
  bar: '1m' | '5m'
  collectionRunId: string
  availableAt: string
  universeManifestId?: string | null
}): OkxMarketEvent {
  const timestamp = Number(input.raw[0])
  const eventTime = new Date(timestamp).toISOString()
  const confirmed = String(input.raw[8] ?? '') === '1'
  const payload = {
    bar: input.bar,
    openTime: eventTime,
    open: numberOrNull(input.raw[1]),
    high: numberOrNull(input.raw[2]),
    low: numberOrNull(input.raw[3]),
    close: numberOrNull(input.raw[4]),
    volume: numberOrNull(input.raw[5]),
    volumeCurrency: numberOrNull(input.raw[6]),
    volumeQuote: numberOrNull(input.raw[7]),
    confirmed,
  }
  return buildOkxMarketEvent({
    dataset: 'candle', instrumentType: input.instrumentType, instrumentId: input.instrumentId,
    channel: `candle${input.bar}`, sourceTransport: 'rest',
    sourceEndpoint: `/api/v5/market/candles?instId=${input.instrumentId}&bar=${input.bar}`,
    eventTime, availableAt: input.availableAt, confirmed, collectionRunId: input.collectionRunId,
    universeManifestId: input.universeManifestId ?? null,
    dedupKey: `okx|candle|${input.instrumentId}|${input.bar}|${timestamp}`,
    payload,
  })
}

export function mapOkxDerivativeMetric(input: {
  dataset: 'funding' | 'mark_index' | 'open_interest'
  instrumentId: string
  sourceEndpoint: string
  raw: Record<string, unknown>
  collectionRunId: string
  availableAt: string
  eventTime?: string | null
}): OkxMarketEvent {
  const eventTime = input.eventTime ?? epochIso(input.raw.ts) ?? epochIso(input.raw.fundingTime) ?? input.availableAt
  return buildOkxMarketEvent({
    dataset: input.dataset, instrumentType: 'SWAP', instrumentId: input.instrumentId,
    instrumentFamily: nullableString(input.raw.instFamily), channel: input.dataset,
    sourceTransport: 'rest', sourceEndpoint: input.sourceEndpoint, eventTime,
    availableAt: input.availableAt, collectionRunId: input.collectionRunId,
    dedupKey: `okx|${input.dataset}|${input.instrumentId}|${eventTime}`,
    payload: input.raw,
  })
}

export function normalizeInstrumentType(raw: string | null): OkxInstrumentType {
  if (raw === 'SPOT' || raw === 'SWAP' || raw === 'FUTURES' || raw === 'OPTION') return raw
  throw new Error(`unsupported OKX instrument type: ${raw ?? 'missing'}`)
}

function epochIso(value: unknown): string | null {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? new Date(numeric).toISOString() : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function nullableString(value: unknown): string | null {
  return stringValue(value)
}

function numberOrNull(value: unknown): number | null {
  const numeric = Number(value)
  return value !== '' && value != null && Number.isFinite(numeric) ? numeric : null
}

function boolish(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string' || value === '') return null
  if (['true', '1', 'yes', 'cross', 'isolated'].includes(value.toLowerCase())) return true
  if (['false', '0', 'no'].includes(value.toLowerCase())) return false
  return null
}
