import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { BarInterval, LiveCandle } from '../../src/domain/market-data/live-fetcher.js'
import { writeEvidenceManifestForArtifact } from '../../src/runtime/evidence_manifest.js'

export const DEFAULT_COLLECTOR_PIT_ROWS_RELATIVE_PATH =
  'normalized/research/openalice_okx_public_ohlcv_pit_rows.research_only.jsonl'

export function defaultCollectorPitRowsPath(
  dataRoot = process.env.OPENALICE_DATA_ROOT ?? 'data',
): string {
  return resolve(dataRoot, DEFAULT_COLLECTOR_PIT_ROWS_RELATIVE_PATH)
}

export const DEFAULT_COLLECTOR_PIT_ROWS_PATH = defaultCollectorPitRowsPath()

export interface OhlcvCollectorPitRow {
  schemaVersion: 1
  generatedAt: string
  jobId: string
  collectionRunId: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  exchange: 'okx'
  market: 'swap'
  sourceType: 'okx_public_market_candles'
  symbol: string
  storageSymbol: string
  instId: string
  timeframe: string
  bar: BarInterval
  eventTime: string
  eventTimeMs: number
  eventTimeBasis: 'okx_kline_open_time'
  open: number
  high: number
  low: number
  close: number
  volume: number
  observedAt: string
  observedAtBasis: 'row_explicit_collector_response_time'
  fetchedAt: string
  fetchedAtBasis: 'row_explicit_collector_request_start_time'
  availableAt: string
  availableAtBasis: 'row_explicit_collector_response_time_research_availability'
  sourceEndpoint: '/api/v5/market/candles'
  sourceRequestPath: string
  sourceRequestLimit: number
  sourceRowIndex: number
  sourceRowHash: string
  lineageScope: 'row'
  rowPITUsableForPromotion: false
  pitSuitability: 'collector_row_explicit_times_research_only_needs_promotion_audit'
  quality: {
    promotionGrade: false
    blockers: string[]
  }
}

export function resolveCollectorPitRowsPath(raw = process.env.OPENALICE_OHLCV_COLLECTOR_PIT_ROWS_PATH): string | null {
  const configured = raw?.trim()
  if (configured) {
    const normalized = configured.toLowerCase()
    if (['0', 'false', 'no', 'none', 'null', 'off', 'disabled'].includes(normalized)) return null
    return resolve(configured)
  }
  return defaultCollectorPitRowsPath()
}

export function buildCollectorRunId(input: {
  jobId: string
  generatedAt: string
  timeframe: string
}): string {
  const digest = sha256Hex(`${input.jobId}\n${input.generatedAt}\n${input.timeframe}`).slice(0, 20)
  return `${input.jobId}:${digest}`
}

export function buildOhlcvCollectorPitRows(input: {
  generatedAt: string
  jobId: string
  collectionRunId: string
  symbol: string
  storageSymbol: string
  instId: string
  timeframe: string
  bar: BarInterval
  limit: number
  requestStartedAt: string
  responseObservedAt: string
  candles: LiveCandle[]
}): OhlcvCollectorPitRow[] {
  const sourceRequestPath = buildOkxCandlesRequestPath(input.instId, input.bar, input.limit)
  return input.candles
    .filter(isFiniteCandle)
    .map((candle, sourceRowIndex) => {
      const eventTime = new Date(candle.timestamp).toISOString()
      return {
        schemaVersion: 1,
        generatedAt: input.generatedAt,
        jobId: input.jobId,
        collectionRunId: input.collectionRunId,
        researchOnly: true,
        diagnosticOnly: true,
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        executionAllowed: false,
        exchange: 'okx',
        market: 'swap',
        sourceType: 'okx_public_market_candles',
        symbol: input.symbol,
        storageSymbol: input.storageSymbol,
        instId: input.instId,
        timeframe: input.timeframe,
        bar: input.bar,
        eventTime,
        eventTimeMs: candle.timestamp,
        eventTimeBasis: 'okx_kline_open_time',
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        observedAt: input.responseObservedAt,
        observedAtBasis: 'row_explicit_collector_response_time',
        fetchedAt: input.requestStartedAt,
        fetchedAtBasis: 'row_explicit_collector_request_start_time',
        availableAt: input.responseObservedAt,
        availableAtBasis: 'row_explicit_collector_response_time_research_availability',
        sourceEndpoint: '/api/v5/market/candles',
        sourceRequestPath,
        sourceRequestLimit: input.limit,
        sourceRowIndex,
        sourceRowHash: buildSourceRowHash(input.instId, input.bar, candle),
        lineageScope: 'row',
        rowPITUsableForPromotion: false,
        pitSuitability: 'collector_row_explicit_times_research_only_needs_promotion_audit',
        quality: {
          promotionGrade: false,
          blockers: [
            'research_only_not_execution_evidence',
            'row_promotion_audit_not_passed',
          ],
        },
      }
    })
}

export async function appendOhlcvCollectorPitRows(
  path: string | null,
  rows: OhlcvCollectorPitRow[],
): Promise<{ rowsWritten: number; path: string | null }> {
  if (!path || rows.length === 0) return { rowsWritten: 0, path }
  const startedAt = new Date()
  const outputPath = resolve(path)
  await mkdir(dirname(outputPath), { recursive: true })
  const content = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
  await appendFile(outputPath, content, 'utf-8')
  await writeEvidenceManifestForArtifact({
    job: 'okx_public_ohlcv_pit_rows_research_only',
    artifactPath: outputPath,
    startedAt,
    finishedAt: new Date(),
    exitCode: 0,
    businessStatus: 'warn',
    recordsIn: rows.length,
    recordsOut: rows.length,
    errorClass: 'research_only_not_execution_evidence',
    artifactHash: sha256Hex(content),
  })
  return { rowsWritten: rows.length, path: outputPath }
}

function buildOkxCandlesRequestPath(instId: string, bar: BarInterval, limit: number): string {
  const params = new URLSearchParams({
    instId,
    bar,
    limit: String(limit),
  })
  return `/api/v5/market/candles?${params.toString()}`
}

function buildSourceRowHash(instId: string, bar: BarInterval, candle: LiveCandle): string {
  return sha256Hex(JSON.stringify([
    'okx',
    'swap',
    instId,
    bar,
    candle.timestamp,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
  ]))
}

function isFiniteCandle(candle: LiveCandle): boolean {
  return [
    candle.timestamp,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
  ].every(Number.isFinite)
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
