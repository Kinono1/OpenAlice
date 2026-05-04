import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

export const DEFAULT_EXTERNAL_DERIVATIVES_EVENTS_PATH = 'data/external/derivatives/binance_usdm_derivatives_events.jsonl'
export const DEFAULT_PAPER_MARK_MATCH_STALE_MS = 10 * 60 * 1000
export const DEFAULT_PAPER_MARK_MATCH_INDEX_MAX_AGE_MS = 15 * 60 * 1000
export const DEFAULT_PAPER_MARK_MATCH_FALLBACK_PENALTY_BPS = 15
const PREMIUM_INDEX_ENDPOINT = '/fapi/v1/premiumIndex'

export type PaperMarkMatchStatus = 'ok' | 'stale_or_missing' | 'invalid'

export interface PaperMarkSnapshot {
  symbol: string
  markPrice: number
  sourceTimestamp: string
  sourceTimestampMs: number
  fetchTimestampMs: number
  availableAtMs: number
  dedupKey: string | null
}

export interface PaperMarkMatchOpenFields {
  markPriceAtOpen: number | null
  markPriceTimestampAtOpen: string | null
  matchPriceAtOpen: number | null
  matchPriceSourceAtOpen: string
  markMatchPenaltyBpsAtOpen: number
  markMatchStatusAtOpen: PaperMarkMatchStatus
}

interface CachedSnapshots {
  mtimeMs: number
  size: number
  snapshots: PaperMarkSnapshot[]
}

const snapshotCache = new Map<string, CachedSnapshots>()

export function normalizeBinanceUsdmSymbol(symbol: string): string {
  const compact = symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return compact.endsWith('USDTUSDT') ? compact.slice(0, -4) : compact
}

export function resolvePaperMarkMatchOpenFields(input: {
  symbol: string
  decisionTime: string | Date | number | null | undefined
  matchPrice: number
  matchPriceSource?: string
  externalEventsPath?: string
  staleMs?: number
  maxIndexAgeMs?: number
  indexFreshnessNow?: string | Date | number | null | undefined
  fallbackPenaltyBps?: number
}): PaperMarkMatchOpenFields {
  const fallbackPenaltyBps = finitePositive(input.fallbackPenaltyBps) ?? DEFAULT_PAPER_MARK_MATCH_FALLBACK_PENALTY_BPS
  const matchPriceSource = input.matchPriceSource ?? 'simulated_fill'
  const fallback = (status: PaperMarkMatchStatus): PaperMarkMatchOpenFields => ({
    markPriceAtOpen: null,
    markPriceTimestampAtOpen: null,
    matchPriceAtOpen: Number.isFinite(input.matchPrice) && input.matchPrice > 0 ? input.matchPrice : null,
    matchPriceSourceAtOpen: matchPriceSource,
    markMatchPenaltyBpsAtOpen: fallbackPenaltyBps,
    markMatchStatusAtOpen: status,
  })

  if (!Number.isFinite(input.matchPrice) || input.matchPrice <= 0) return fallback('invalid')
  const decisionMs = parseTimeMs(input.decisionTime)
  if (decisionMs === null) return fallback('stale_or_missing')

  const snapshot = findLatestPitSafeMarkSnapshot({
    symbol: input.symbol,
    decisionMs,
    externalEventsPath: input.externalEventsPath,
    maxIndexAgeMs: input.maxIndexAgeMs,
    indexFreshnessNow: input.indexFreshnessNow,
  })
  if (!snapshot) return fallback('stale_or_missing')

  const staleMs = finitePositive(input.staleMs) ?? DEFAULT_PAPER_MARK_MATCH_STALE_MS
  if (decisionMs - snapshot.sourceTimestampMs > staleMs) return fallback('stale_or_missing')
  if (!Number.isFinite(snapshot.markPrice) || snapshot.markPrice <= 0) return fallback('invalid')

  return {
    markPriceAtOpen: roundPaperMarkMatchNumber(snapshot.markPrice),
    markPriceTimestampAtOpen: snapshot.sourceTimestamp,
    matchPriceAtOpen: input.matchPrice,
    matchPriceSourceAtOpen: matchPriceSource,
    markMatchPenaltyBpsAtOpen: roundPaperMarkMatchNumber(Math.abs(input.matchPrice - snapshot.markPrice) / snapshot.markPrice * 10_000),
    markMatchStatusAtOpen: 'ok',
  }
}

export function findLatestPitSafeMarkSnapshot(input: {
  symbol: string
  decisionMs: number
  externalEventsPath?: string
  maxIndexAgeMs?: number
  indexFreshnessNow?: string | Date | number | null | undefined
}): PaperMarkSnapshot | null {
  const symbol = normalizeBinanceUsdmSymbol(input.symbol)
  if (!symbol || !Number.isFinite(input.decisionMs)) return null
  const snapshots = readPremiumIndexMarkSnapshots(input.externalEventsPath, {
    maxIndexAgeMs: input.maxIndexAgeMs,
    nowMs: parseTimeMs(input.indexFreshnessNow) ?? Date.now(),
  })
  let best: PaperMarkSnapshot | null = null
  for (const snapshot of snapshots) {
    if (snapshot.symbol !== symbol) continue
    if (snapshot.sourceTimestampMs > input.decisionMs) continue
    if (snapshot.fetchTimestampMs > input.decisionMs) continue
    if (snapshot.availableAtMs > input.decisionMs) continue
    if (!best ||
      snapshot.sourceTimestampMs > best.sourceTimestampMs ||
      (snapshot.sourceTimestampMs === best.sourceTimestampMs && snapshot.availableAtMs > best.availableAtMs)) {
      best = snapshot
    }
  }
  return best
}

export function readPremiumIndexMarkSnapshots(
  externalEventsPath?: string,
  options?: {
    maxIndexAgeMs?: number
    nowMs?: number
  },
): PaperMarkSnapshot[] {
  const path = resolve(externalEventsPath ?? process.env.OPENALICE_EXTERNAL_DERIVATIVES_EVENTS_PATH ?? DEFAULT_EXTERNAL_DERIVATIVES_EVENTS_PATH)
  if (!existsSync(path)) return []
  const stat = statSync(path)
  const maxIndexAgeMs = finitePositive(options?.maxIndexAgeMs) ?? DEFAULT_PAPER_MARK_MATCH_INDEX_MAX_AGE_MS
  const nowMs = Number.isFinite(options?.nowMs) ? options?.nowMs as number : Date.now()
  if (Number.isFinite(nowMs) && Math.max(0, nowMs - stat.mtimeMs) > maxIndexAgeMs) return []

  const cached = snapshotCache.get(path)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.snapshots

  const snapshots: PaperMarkSnapshot[] = []
  const raw = readFileSync(path, 'utf-8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const snapshot = parsePremiumIndexMarkSnapshot(trimmed)
    if (snapshot) snapshots.push(snapshot)
  }
  snapshots.sort((left, right) => left.sourceTimestampMs - right.sourceTimestampMs || left.availableAtMs - right.availableAtMs)
  snapshotCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, snapshots })
  return snapshots
}

export function clearPaperMarkMatchSnapshotCacheForTest(): void {
  snapshotCache.clear()
}

function parsePremiumIndexMarkSnapshot(line: string): PaperMarkSnapshot | null {
  try {
    const row = JSON.parse(line) as Record<string, unknown>
    if (row.sourceEndpoint !== PREMIUM_INDEX_ENDPOINT) return null
    const symbol = typeof row.symbol === 'string' ? normalizeBinanceUsdmSymbol(row.symbol) : ''
    if (!symbol) return null
    const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? row.payload as Record<string, unknown>
      : {}
    const markPrice = parseFiniteNumber(payload.markPrice)
    if (markPrice == null || markPrice <= 0) return null
    const sourceTimestampMs = parseTimeMs(row.sourceTimestamp)
    const fetchTimestampMs = parseTimeMs(row.fetchTimestamp)
    if (sourceTimestampMs == null || fetchTimestampMs == null) return null
    const availabilityCandidates = [
      sourceTimestampMs,
      fetchTimestampMs,
      parseTimeMs(row.payloadReceivedAt),
      parseTimeMs(row.ingestedAt),
    ].filter((value): value is number => value != null)
    return {
      symbol,
      markPrice,
      sourceTimestamp: new Date(sourceTimestampMs).toISOString(),
      sourceTimestampMs,
      fetchTimestampMs,
      availableAtMs: Math.max(...availabilityCandidates),
      dedupKey: typeof row.dedupKey === 'string' && row.dedupKey ? row.dedupKey : null,
    }
  } catch {
    return null
  }
}

function parseFiniteNumber(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  return Number.isFinite(value) ? value : null
}

function parseTimeMs(raw: unknown): number | null {
  if (raw instanceof Date) {
    const value = raw.getTime()
    return Number.isFinite(value) ? value : null
  }
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null
  if (typeof raw !== 'string' || !raw.trim()) return null
  const value = Date.parse(raw)
  return Number.isFinite(value) ? value : null
}

function finitePositive(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : NaN
  return Number.isFinite(value) && value > 0 ? value : null
}

function roundPaperMarkMatchNumber(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
