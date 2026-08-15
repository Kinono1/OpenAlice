import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { ProxyAgent, request } from 'undici'
import { readGitEvidenceSnapshot, writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { acquireRuntimeLock } from '../src/runtime/runtime_lock.js'

export type OkxExternalEndpoint = 'fundingRate' | 'premiumIndex' | 'openInterest' | 'openInterestHist' | 'longShort'

export interface OkxExternalCollectArgs {
  symbols: string[]
  symbolMode?: 'explicit' | 'all_active_stablecoin_swaps'
  endpoints: OkxExternalEndpoint[]
  period: string
  outputPath: string
  reportPath: string
  runLedgerPath: string
  checkpointPath?: string
  lockDir: string
  host: string
  proxyUrl?: string
  fetchTimeoutMs: number
  maxRetries: number
  symbolBatchSize?: number
  dryRun: boolean
  json: boolean
}

export interface OkxExternalRow {
  schemaVersion: 'external_derivatives_event.v1'
  exchange: 'okx'
  market: 'swap'
  symbol: string
  instrumentId: string
  sourceEndpoint: string
  sourceTimestamp: string
  sourceTimestampBasis: 'exchange_event' | 'fetch_bucket'
  fetchTimestamp: string
  payloadReceivedAt: string
  ingestedAt: string
  fetchLatencyMs: number
  decodeLatencyMs: number
  processingLatencyMs: number
  processingLatencyBasis: 'fetch_start_to_row_built'
  appendLatencyMs: number | null
  appendLatencyBasis: 'payload_received_to_jsonl_append' | null
  ingestionLatencyMs: number | null
  ingestionLatencyBasis: 'payload_received_to_jsonl_append' | null
  collectionRunId: string
  reportPath: string
  manifestPath: string
  generatedAt: string
  dedupKey: string
  rawPayloadHash: string
  payloadHashBasis: 'canonical_json_payload'
  rawBodyHash: string
  payload: Record<string, unknown>
}

export interface OkxExternalCollectReport {
  schemaVersion: 1
  venue: 'okx'
  retiredVenue: 'binance_usdm_http_451'
  runId: string
  generatedAt: string
  outputPath: string
  reportPath: string
  runLedgerPath: string
  dryRun: boolean
  sideEffectPolicy: 'read_only_external_fetch_append_only_local_storage'
  collectorLockStatus: 'acquired' | 'skipped_lock_held' | 'disabled_dry_run'
  collectorLockDir: string
  baseUrl: string
  proxyConfigured: boolean
  proxySource: string | null
  fetchTimeoutMs: number
  maxRetries: number
  symbols: string[]
  symbolMode: 'explicit' | 'all_active_stablecoin_swaps'
  universeSize: number
  symbolBatchSize: number
  batchCursor: number | null
  nextBatchCursor: number | null
  endpoints: OkxExternalEndpoint[]
  period: string
  fetchedRows: number
  appendedRows: number
  wouldAppendRows: number
  persistedRows: number
  skippedDuplicateRows: number
  conflictingDuplicateRows: number
  errors: Array<{ symbol: string; endpoint: OkxExternalEndpoint | 'instrumentDiscovery'; error: string; errorClass: string; permanent: boolean }>
  unavailableEndpoints: Array<{ symbol: string; endpoint: OkxExternalEndpoint; error: string; errorClass: 'metric_not_available'; permanent: true }>
  endpointDiagnostics: Array<{
    symbol: string
    endpoint: OkxExternalEndpoint
    sourceEndpoint: string
    urls: string[]
    attempts: number
    status: 'ok' | 'unavailable' | 'error'
    fetchedRows: number
    error: string | null
    errorClass: string | null
    permanent: boolean
  }>
  evidenceManifest: null | {
    manifestPath: string
    evidenceTrust: string
    dqStatus: string
    businessStatus: string
    exitCode: number
    git: { commit: string | null; dirty: boolean; dirtyFilesCount: number; dirtyHash: string }
  }
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

const ENDPOINTS: OkxExternalEndpoint[] = ['fundingRate', 'premiumIndex', 'openInterest', 'openInterestHist', 'longShort']
const DEFAULT_HOST = 'https://www.okx.com'
const DEFAULT_OUTPUT = 'data/external/derivatives/okx_swap_derivatives_events.jsonl'
const DEFAULT_REPORT = 'data/runtime/external_derivatives_data_collect.latest.json'
const DEFAULT_LEDGER = 'data/runtime/external_derivatives_data_collect.runs.jsonl'
const DEFAULT_CHECKPOINT = 'data/runtime/external_derivatives_data_collect.checkpoint.json'
const DEFAULT_LOCK = 'data/runtime/locks/external_derivatives_data_collect.collector.lock'
const proxyDispatchers = new Map<string, ProxyAgent>()

export function parseOkxExternalCollectArgs(argv: string[]): OkxExternalCollectArgs {
  const raw = parseRawArgs(argv)
  const dataRoot = raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT
  const defaultOutput = dataRoot
    ? join(dataRoot, 'external/derivatives/okx_swap_derivatives_events.jsonl')
    : DEFAULT_OUTPUT
  const endpoint = raw.get('endpoint') ?? 'all'
  const rawSymbols = raw.get('symbols') ?? 'all'
  const symbolMode = rawSymbols.trim().toLowerCase() === 'all' ? 'all_active_stablecoin_swaps' : 'explicit'
  return {
    symbols: symbolMode === 'explicit' ? parseSymbols(rawSymbols) : [],
    symbolMode,
    endpoints: endpoint === 'all' ? [...ENDPOINTS] : [parseEndpoint(endpoint)],
    period: raw.get('period') ?? '5m',
    outputPath: resolve(raw.get('outputPath') ?? raw.get('output') ?? defaultOutput),
    reportPath: resolve(raw.get('reportPath') ?? DEFAULT_REPORT),
    runLedgerPath: resolve(raw.get('runLedgerPath') ?? DEFAULT_LEDGER),
    checkpointPath: resolve(raw.get('checkpointPath') ?? DEFAULT_CHECKPOINT),
    lockDir: resolve(raw.get('collectorLockDir') ?? DEFAULT_LOCK),
    host: normalizeHost(raw.get('baseUrl') ?? raw.get('host') ?? process.env.OPENALICE_OKX_PUBLIC_HOST ?? DEFAULT_HOST),
    proxyUrl: normalizeOptional(raw.get('proxyUrl') ?? process.env.OPENALICE_OKX_PROXY_URL ?? process.env.HTTPS_PROXY ?? process.env.https_proxy),
    fetchTimeoutMs: positiveInt(raw.get('fetchTimeoutMs') ?? process.env.OPENALICE_EXTERNAL_FETCH_TIMEOUT_MS, 8_000),
    maxRetries: nonNegativeInt(raw.get('maxRetries') ?? process.env.OPENALICE_EXTERNAL_MAX_RETRIES, 1),
    symbolBatchSize: boundedPositiveInt(raw.get('symbolBatchSize') ?? process.env.OPENALICE_EXTERNAL_SYMBOL_BATCH_SIZE, 25, 50),
    dryRun: parseBool(raw.get('dryRun'), false),
    json: parseBool(raw.get('json'), false),
  }
}

export async function collectOkxExternalDerivatives(
  args: OkxExternalCollectArgs,
  fetchImpl: FetchLike = createFetch(args.proxyUrl),
): Promise<OkxExternalCollectReport> {
  const startedAt = new Date()
  const generatedAt = startedAt.toISOString()
  const runId = `external_derivatives_data_collect_${compactUtc(generatedAt)}_${randomUUID()}`
  const symbolMode = args.symbolMode ?? (args.symbols.length > 0 ? 'explicit' : 'all_active_stablecoin_swaps')
  const lock = args.dryRun ? null : acquireRuntimeLock(args.lockDir, {
    purpose: 'external_derivatives_data_collect_okx',
    staleMs: 6 * 60 * 60 * 1000,
  })
  const lockStatus: OkxExternalCollectReport['collectorLockStatus'] = args.dryRun
    ? 'disabled_dry_run'
    : lock
      ? 'acquired'
      : 'skipped_lock_held'
  if (!args.dryRun && !lock) {
    return buildEmptyLockedReport(args, runId, generatedAt)
  }

  try {
    const existing = await readExistingRows(args.outputPath)
    const rows: OkxExternalRow[] = []
    const errors: OkxExternalCollectReport['errors'] = []
    const unavailableEndpoints: OkxExternalCollectReport['unavailableEndpoints'] = []
    const endpointDiagnostics: OkxExternalCollectReport['endpointDiagnostics'] = []
    let symbols = args.symbols
    let universeSize = symbols.length
    let batchCursor: number | null = null
    let nextBatchCursor: number | null = null

    if (symbolMode === 'all_active_stablecoin_swaps') {
      const discovered = await discoverActiveStablecoinSwaps(args, fetchImpl)
      if (discovered.error) errors.push(discovered.error)
      const selected = await selectSymbolBatch(
        discovered.symbols,
        args.checkpointPath ?? DEFAULT_CHECKPOINT,
        args.symbolBatchSize ?? 25,
      )
      symbols = selected.symbols
      universeSize = discovered.symbols.length
      batchCursor = selected.batchCursor
      nextBatchCursor = selected.nextBatchCursor
    }

    await mapLimit(symbols, 3, async symbol => {
      for (const endpoint of args.endpoints) {
        const result = await fetchEndpoint({ args, symbol, endpoint, runId, generatedAt, fetchImpl })
        rows.push(...result.rows)
        endpointDiagnostics.push(result.diagnostic)
        if (result.error) errors.push(result.error)
        if (result.unavailable) unavailableEndpoints.push(result.unavailable)
      }
    })
    rows.sort((left, right) => left.instrumentId.localeCompare(right.instrumentId) || left.sourceEndpoint.localeCompare(right.sourceEndpoint) || left.sourceTimestamp.localeCompare(right.sourceTimestamp))
    endpointDiagnostics.sort((left, right) => left.symbol.localeCompare(right.symbol) || left.endpoint.localeCompare(right.endpoint))
    errors.sort((left, right) => left.symbol.localeCompare(right.symbol) || left.endpoint.localeCompare(right.endpoint))

    const rowsToAppend: OkxExternalRow[] = []
    let skippedDuplicateRows = 0
    let conflictingDuplicateRows = 0
    for (const row of rows) {
      const priorHash = existing.get(row.dedupKey)
      if (priorHash !== undefined) {
        skippedDuplicateRows += 1
        if (priorHash && priorHash !== row.rawPayloadHash) conflictingDuplicateRows += 1
        continue
      }
      existing.set(row.dedupKey, row.rawPayloadHash)
      rowsToAppend.push(withAppendTimestamps(row))
    }

    if (!args.dryRun && rowsToAppend.length > 0) {
      await mkdir(dirname(args.outputPath), { recursive: true })
      await appendJsonLines(args.outputPath, rowsToAppend)
    }

    const report: OkxExternalCollectReport = {
      schemaVersion: 1,
      venue: 'okx',
      retiredVenue: 'binance_usdm_http_451',
      runId,
      generatedAt,
      outputPath: args.outputPath,
      reportPath: args.reportPath,
      runLedgerPath: args.runLedgerPath,
      dryRun: args.dryRun,
      sideEffectPolicy: 'read_only_external_fetch_append_only_local_storage',
      collectorLockStatus: lockStatus,
      collectorLockDir: args.lockDir,
      baseUrl: args.host,
      proxyConfigured: Boolean(args.proxyUrl),
      proxySource: args.proxyUrl ? 'environment_or_cli' : null,
      fetchTimeoutMs: args.fetchTimeoutMs,
      maxRetries: args.maxRetries,
      symbols,
      symbolMode,
      universeSize,
      symbolBatchSize: symbols.length,
      batchCursor,
      nextBatchCursor,
      endpoints: args.endpoints,
      period: args.period,
      fetchedRows: rows.length,
      appendedRows: args.dryRun ? 0 : rowsToAppend.length,
      wouldAppendRows: rowsToAppend.length,
      persistedRows: args.dryRun ? 0 : rowsToAppend.length,
      skippedDuplicateRows,
      conflictingDuplicateRows,
      errors,
      unavailableEndpoints,
      endpointDiagnostics,
      evidenceManifest: null,
    }

    if (!args.dryRun) {
      const exitCode = errors.length > 0 || rows.length === 0 ? 1 : 0
      const businessStatus = exitCode !== 0 ? 'fail' : conflictingDuplicateRows > 0 || unavailableEndpoints.length > 0 ? 'warn' : 'pass'
      const git = readGitEvidenceSnapshot()
      const finishedAt = new Date()
      const evidenceTrust = exitCode !== 0 ? 'fail' : git.dirty ? 'quarantine' : 'pass'
      const manifestPath = resolve(`${args.reportPath}.manifest.json`)
      report.evidenceManifest = {
        manifestPath,
        evidenceTrust,
        dqStatus: evidenceTrust,
        businessStatus,
        exitCode,
        git,
      }
      await mkdir(dirname(args.reportPath), { recursive: true })
      const reportPayload = `${JSON.stringify(report, null, 2)}\n`
      await writeFile(args.reportPath, reportPayload, 'utf-8')
      await writeEvidenceManifestForArtifact({
        job: 'external_derivatives_data_collect_okx',
        artifactPath: args.reportPath,
        startedAt,
        finishedAt,
        exitCode,
        businessStatus,
        recordsIn: symbols.length * args.endpoints.length,
        recordsOut: rowsToAppend.length,
        errorClass: errors[0]?.errorClass ?? null,
        gitSnapshot: git,
        artifactHash: createHash('sha256').update(reportPayload).digest('hex'),
      })
      await mkdir(dirname(args.runLedgerPath), { recursive: true })
      await appendFile(args.runLedgerPath, `${JSON.stringify({ ...report, endpointDiagnostics: undefined })}\n`, 'utf-8')
      await writeCheckpoint(args.checkpointPath ?? DEFAULT_CHECKPOINT, report, rows)
    }
    return report
  } finally {
    lock?.release()
  }
}

async function discoverActiveStablecoinSwaps(
  args: OkxExternalCollectArgs,
  fetchImpl: FetchLike,
): Promise<{
  symbols: string[]
  error: OkxExternalCollectReport['errors'][number] | null
  unavailable: OkxExternalCollectReport['unavailableEndpoints'][number] | null
}> {
  const url = `${args.host}/api/v5/public/instruments?instType=SWAP`
  try {
    const response = await fetchWithTimeout(fetchImpl, url, args.fetchTimeoutMs)
    const body = await response.text()
    if (!response.ok) throw httpError(response.status, url, body)
    const envelope = JSON.parse(body) as { code?: unknown; msg?: unknown; data?: unknown }
    if (String(envelope.code ?? '0') !== '0' || !Array.isArray(envelope.data)) {
      throw new Error(`OKX ${String(envelope.code ?? 'invalid')} ${url}: ${String(envelope.msg ?? 'invalid instrument payload')}`)
    }
    const symbols = [...new Set(envelope.data
      .map(asRecord)
      .filter((row): row is Record<string, unknown> => row != null)
      .filter(row => String(row.state ?? '') === 'live' && ['USDT', 'USDC'].includes(String(row.settleCcy ?? '')))
      .map(row => instrumentIdToSymbol(String(row.instId ?? '')))
      .filter((value): value is string => value != null))]
      .sort()
    if (symbols.length === 0) throw new Error('OKX instrument discovery returned no active USDT/USDC SWAP')
    return { symbols, error: null }
  } catch (error) {
    const classified = classifyError(error)
    return {
      symbols: [],
      error: { symbol: '*', endpoint: 'instrumentDiscovery', error: redact(error instanceof Error ? error.message : String(error)), ...classified },
    }
  }
}

async function selectSymbolBatch(
  universe: string[],
  checkpointPath: string,
  requestedBatchSize: number,
): Promise<{ symbols: string[]; batchCursor: number; nextBatchCursor: number }> {
  if (universe.length === 0) return { symbols: [], batchCursor: 0, nextBatchCursor: 0 }
  const batchSize = Math.min(Math.max(1, requestedBatchSize), universe.length)
  let cursor = 0
  try {
    const checkpoint = JSON.parse(await readFile(resolve(checkpointPath), 'utf-8')) as { nextBatchCursor?: unknown }
    const parsed = Number(checkpoint.nextBatchCursor)
    if (Number.isInteger(parsed) && parsed >= 0) cursor = parsed % universe.length
  } catch { /* first run or legacy checkpoint */ }
  const symbols: string[] = []
  for (let offset = 0; offset < batchSize; offset += 1) {
    symbols.push(universe[(cursor + offset) % universe.length])
  }
  return { symbols, batchCursor: cursor, nextBatchCursor: (cursor + batchSize) % universe.length }
}

async function fetchEndpoint(input: {
  args: OkxExternalCollectArgs
  symbol: string
  endpoint: OkxExternalEndpoint
  runId: string
  generatedAt: string
  fetchImpl: FetchLike
}): Promise<{
  rows: OkxExternalRow[]
  diagnostic: OkxExternalCollectReport['endpointDiagnostics'][number]
  error: OkxExternalCollectReport['errors'][number] | null
}> {
  const urls = endpointUrls(input.args.host, input.symbol, input.endpoint, input.args.period)
  const sourceEndpoint = canonicalSourceEndpoint(input.endpoint)
  let attempts = 0
  let lastError = 'unknown error'
  let lastClass = 'network_or_unknown'
  let permanent = false
  const maxAttempts = Math.max(1, input.args.maxRetries + 1)
  while (attempts < maxAttempts) {
    attempts += 1
    try {
      const fetchedAtMs = Date.now()
      const fetchedAt = new Date(fetchedAtMs).toISOString()
      const envelopes: unknown[] = []
      const bodies: string[] = []
      for (const url of urls) {
        const response = await fetchWithTimeout(input.fetchImpl, url, input.args.fetchTimeoutMs)
        const body = await response.text()
        bodies.push(body)
        if (!response.ok) throw httpError(response.status, url, body)
        const envelope = JSON.parse(body) as { code?: unknown; msg?: unknown; data?: unknown }
        if (String(envelope.code ?? '0') !== '0') {
          throw new Error(`OKX ${String(envelope.code)} ${url}: ${String(envelope.msg ?? 'unknown error')}`)
        }
        envelopes.push(envelope.data ?? [])
      }
      const payloads = normalizeOkxPayloads(input.endpoint, input.symbol, envelopes, fetchedAtMs)
      const rawBodyHash = sha256(bodies.join('\n'))
      const rows = payloads.map(payload => buildRow({
        endpoint: input.endpoint,
        symbol: input.symbol,
        payload,
        period: input.args.period,
        fetchedAt,
        rawBodyHash,
        runId: input.runId,
        generatedAt: input.generatedAt,
        reportPath: input.args.reportPath,
      }))
      return {
        rows,
        error: null,
        unavailable: null,
        diagnostic: { symbol: input.symbol, endpoint: input.endpoint, sourceEndpoint, urls, attempts, status: 'ok', fetchedRows: rows.length, error: null, errorClass: null, permanent: false },
      }
    } catch (error) {
      lastError = redact(error instanceof Error ? error.message : String(error))
      if (isMetricUnavailable(input.endpoint, lastError)) {
        return {
          rows: [],
          error: null,
          unavailable: { symbol: input.symbol, endpoint: input.endpoint, error: lastError, errorClass: 'metric_not_available', permanent: true },
          diagnostic: { symbol: input.symbol, endpoint: input.endpoint, sourceEndpoint, urls, attempts, status: 'unavailable', fetchedRows: 0, error: lastError, errorClass: 'metric_not_available', permanent: true },
        }
      }
      const classified = classifyError(error)
      lastClass = classified.errorClass
      permanent = classified.permanent
      if (permanent || attempts >= maxAttempts) break
      await new Promise(resolveTimer => setTimeout(resolveTimer, Math.min(500, attempts * 100)))
    }
  }
  return {
    rows: [],
    unavailable: null,
    error: { symbol: input.symbol, endpoint: input.endpoint, error: lastError, errorClass: lastClass, permanent },
    diagnostic: { symbol: input.symbol, endpoint: input.endpoint, sourceEndpoint, urls, attempts, status: 'error', fetchedRows: 0, error: lastError, errorClass: lastClass, permanent },
  }
}

function isMetricUnavailable(endpoint: OkxExternalEndpoint, message: string): boolean {
  return (endpoint === 'openInterestHist' || endpoint === 'longShort')
    && /OKX\s+51012\b.*Token does not exist/i.test(message)
}

function normalizeOkxPayloads(endpoint: OkxExternalEndpoint, symbol: string, data: unknown[], fetchedAtMs: number): Record<string, unknown>[] {
  const instId = toInstId(symbol)
  const ccy = symbol.replace(/USDT$/i, '').replace(/-USDT-SWAP$/i, '')
  if (endpoint === 'premiumIndex') {
    const mark = firstRecord(data[0])
    const index = firstRecord(data[1])
    if (!mark || !index) return []
    const markTs = numberValue(mark.ts) ?? fetchedAtMs
    const indexTs = numberValue(index.ts) ?? fetchedAtMs
    const markPx = numberValue(mark.markPx)
    const indexPx = numberValue(index.idxPx)
    return [{
      instId,
      symbol,
      markPrice: markPx,
      indexPrice: indexPx,
      premiumRate: markPx != null && indexPx ? (markPx - indexPx) / indexPx : null,
      timestamp: Math.max(markTs, indexTs),
      sourceEndpoints: ['/api/v5/public/mark-price', '/api/v5/market/index-tickers'],
    }]
  }
  const rows = Array.isArray(data[0]) ? data[0] as unknown[] : []
  if (endpoint === 'openInterestHist') {
    return rows.map(item => Array.isArray(item) ? {
      instId, symbol, ccy, timestamp: numberValue(item[0]), openInterestUsd: numberValue(item[1]), volumeUsd: numberValue(item[2]), period: '5m',
    } : {}).filter(item => numberValue(item.timestamp) != null)
  }
  if (endpoint === 'longShort') {
    return rows.map(item => Array.isArray(item) ? {
      instId, symbol, ccy, timestamp: numberValue(item[0]), longShortRatio: numberValue(item[1]), period: '5m',
    } : {}).filter(item => numberValue(item.timestamp) != null)
  }
  return rows.map(item => {
    const record = asRecord(item) ?? {}
    if (endpoint === 'fundingRate') return { ...record, symbol, timestamp: numberValue(record.fundingTime), fundingRate: numberValue(record.fundingRate), realizedRate: numberValue(record.realizedRate) }
    return { ...record, symbol, timestamp: numberValue(record.ts), openInterest: numberValue(record.oi), openInterestCcy: numberValue(record.oiCcy), openInterestUsd: numberValue(record.oiUsd) }
  })
}

function buildRow(input: {
  endpoint: OkxExternalEndpoint
  symbol: string
  payload: Record<string, unknown>
  period: string
  fetchedAt: string
  rawBodyHash: string
  runId: string
  generatedAt: string
  reportPath: string
}): OkxExternalRow {
  const timestamp = numberValue(input.payload.timestamp) ?? floorBucket(Date.parse(input.fetchedAt), 5 * 60_000)
  const basis: OkxExternalRow['sourceTimestampBasis'] = numberValue(input.payload.timestamp) == null ? 'fetch_bucket' : 'exchange_event'
  const instrumentId = String(input.payload.instId ?? toInstId(input.symbol))
  const rawPayload = stableJson(input.payload)
  return {
    schemaVersion: 'external_derivatives_event.v1',
    exchange: 'okx',
    market: 'swap',
    symbol: input.symbol,
    instrumentId,
    sourceEndpoint: canonicalSourceEndpoint(input.endpoint),
    sourceTimestamp: new Date(timestamp).toISOString(),
    sourceTimestampBasis: basis,
    fetchTimestamp: input.fetchedAt,
    payloadReceivedAt: input.fetchedAt,
    ingestedAt: input.fetchedAt,
    fetchLatencyMs: 0,
    decodeLatencyMs: 0,
    processingLatencyMs: 0,
    processingLatencyBasis: 'fetch_start_to_row_built',
    appendLatencyMs: null,
    appendLatencyBasis: null,
    ingestionLatencyMs: null,
    ingestionLatencyBasis: null,
    collectionRunId: input.runId,
    reportPath: input.reportPath,
    manifestPath: `${input.reportPath}.manifest.json`,
    generatedAt: input.generatedAt,
    dedupKey: buildOkxDedupKey({ endpoint: input.endpoint, symbol: input.symbol, instrumentId, period: input.period, timestamp }),
    rawPayloadHash: sha256(rawPayload),
    payloadHashBasis: 'canonical_json_payload',
    rawBodyHash: input.rawBodyHash,
    payload: input.payload,
  }
}

export function buildOkxDedupKey(input: { endpoint: OkxExternalEndpoint; symbol: string; instrumentId: string; period: string; timestamp: number }): string {
  return `okx|swap|${input.endpoint}|${input.symbol}|${input.instrumentId}|${input.period}|${input.timestamp}`
}

function endpointUrls(host: string, symbol: string, endpoint: OkxExternalEndpoint, period: string): string[] {
  const instId = toInstId(symbol)
  const { base, quote } = splitSwapInstrument(instId)
  const ccy = base
  if (endpoint === 'fundingRate') return [`${host}/api/v5/public/funding-rate-history?instId=${instId}&limit=100`]
  if (endpoint === 'premiumIndex') return [
    `${host}/api/v5/public/mark-price?instType=SWAP&instId=${instId}`,
    `${host}/api/v5/market/index-tickers?instId=${ccy}-${quote}`,
  ]
  if (endpoint === 'openInterest') return [`${host}/api/v5/public/open-interest?instType=SWAP&instId=${instId}`]
  if (endpoint === 'openInterestHist') return [`${host}/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${ccy}&period=${encodeURIComponent(period)}`]
  return [`${host}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${ccy}&period=${encodeURIComponent(period)}`]
}

function canonicalSourceEndpoint(endpoint: OkxExternalEndpoint): string {
  if (endpoint === 'fundingRate') return '/api/v5/public/funding-rate-history'
  if (endpoint === 'premiumIndex') return '/api/v5/public/mark-price+/api/v5/market/index-tickers'
  if (endpoint === 'openInterest') return '/api/v5/public/open-interest'
  if (endpoint === 'openInterestHist') return '/api/v5/rubik/stat/contracts/open-interest-volume'
  return '/api/v5/rubik/stat/contracts/long-short-account-ratio'
}

function withAppendTimestamps(row: OkxExternalRow): OkxExternalRow {
  const now = Date.now()
  const received = Date.parse(row.payloadReceivedAt)
  const latency = Number.isFinite(received) ? Math.max(0, now - received) : 0
  return { ...row, ingestedAt: new Date(now).toISOString(), appendLatencyMs: latency, appendLatencyBasis: 'payload_received_to_jsonl_append', ingestionLatencyMs: latency, ingestionLatencyBasis: 'payload_received_to_jsonl_append' }
}

async function readExistingRows(path: string): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  if (!existsSync(path)) return out
  const stream = createReadStream(path, 'utf-8')
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as { dedupKey?: unknown; rawPayloadHash?: unknown }
      if (typeof row.dedupKey === 'string') out.set(row.dedupKey, typeof row.rawPayloadHash === 'string' ? row.rawPayloadHash : null)
    } catch { /* preserve append-only history; ignore malformed legacy line here */ }
  }
  return out
}

async function appendJsonLines(path: string, rows: OkxExternalRow[], chunkSize = 500): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize).map(row => JSON.stringify(row)).join('\n')
    if (chunk) await appendFile(path, `${chunk}\n`, 'utf-8')
  }
}

function buildEmptyLockedReport(args: OkxExternalCollectArgs, runId: string, generatedAt: string): OkxExternalCollectReport {
  return {
    schemaVersion: 1, venue: 'okx', retiredVenue: 'binance_usdm_http_451', runId, generatedAt,
    outputPath: args.outputPath, reportPath: args.reportPath, runLedgerPath: args.runLedgerPath, dryRun: args.dryRun,
    sideEffectPolicy: 'read_only_external_fetch_append_only_local_storage', collectorLockStatus: 'skipped_lock_held', collectorLockDir: args.lockDir,
    baseUrl: args.host, proxyConfigured: Boolean(args.proxyUrl), proxySource: args.proxyUrl ? 'environment_or_cli' : null,
    fetchTimeoutMs: args.fetchTimeoutMs, maxRetries: args.maxRetries, symbols: args.symbols,
    symbolMode: args.symbolMode ?? (args.symbols.length > 0 ? 'explicit' : 'all_active_stablecoin_swaps'), endpoints: args.endpoints, period: args.period,
    universeSize: args.symbols.length, symbolBatchSize: args.symbolBatchSize ?? args.symbols.length,
    batchCursor: null, nextBatchCursor: null,
    fetchedRows: 0, appendedRows: 0, wouldAppendRows: 0, persistedRows: 0, skippedDuplicateRows: 0, conflictingDuplicateRows: 0,
    errors: [], unavailableEndpoints: [], endpointDiagnostics: [], evidenceManifest: null,
  }
}

function createFetch(proxyUrl?: string): FetchLike {
  if (!proxyUrl) return globalThis.fetch as FetchLike
  return async url => {
    let dispatcher = proxyDispatchers.get(proxyUrl)
    if (!dispatcher) { dispatcher = new ProxyAgent(proxyUrl); proxyDispatchers.set(proxyUrl, dispatcher) }
    const response = await request(url, { dispatcher })
    const body = await response.body.text()
    return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, text: async () => body }
  }
}

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, timeoutMs: number) {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      fetchImpl(url),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`fetch timeout after ${timeoutMs}ms`)), timeoutMs) }),
    ])
  } finally { if (timeout) clearTimeout(timeout) }
}

function httpError(status: number, url: string, body: string): Error & { status?: number } {
  const error = new Error(`HTTP ${status} ${url}: ${body.slice(0, 240)}`) as Error & { status?: number }
  error.status = status
  return error
}

function classifyError(error: unknown): { errorClass: string; permanent: boolean } {
  const message = error instanceof Error ? error.message : String(error)
  const status = typeof error === 'object' && error ? (error as { status?: unknown }).status : undefined
  if (status === 401 || status === 403 || status === 451 || /HTTP (?:401|403|451)\b/.test(message)) return { errorClass: 'http_permanent', permanent: true }
  if (status === 429 || /HTTP 429\b/.test(message)) return { errorClass: 'rate_limited', permanent: false }
  if (typeof status === 'number' && status >= 400 && status < 500) return { errorClass: 'http_permanent', permanent: true }
  if (/timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed/i.test(message)) return { errorClass: 'transient_network', permanent: false }
  if (message.includes('JSON')) return { errorClass: 'json_parse', permanent: true }
  return { errorClass: 'remote_server_or_unknown', permanent: false }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const [key, inline] = token.slice(2).split('=', 2)
    if (inline !== undefined) out.set(key, inline)
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.set(key, argv[++i])
    else out.set(key, 'true')
  }
  return out
}

function parseSymbols(raw: string): string[] { return [...new Set(raw.split(',').map(value => value.trim().toUpperCase()).filter(Boolean).map(value => instrumentIdToSymbol(value) ?? value))] }
function parseEndpoint(raw: string): OkxExternalEndpoint { if (!ENDPOINTS.includes(raw as OkxExternalEndpoint)) throw new Error(`invalid endpoint: ${raw}`); return raw as OkxExternalEndpoint }
function toInstId(symbol: string): string {
  const normalized = symbol.toUpperCase()
  if (/^[A-Z0-9]+-(?:USDT|USDC)-SWAP$/.test(normalized)) return normalized
  const match = /^([A-Z0-9]+)(USDT|USDC)$/.exec(normalized)
  if (!match) throw new Error(`unsupported OKX SWAP symbol: ${symbol}`)
  return `${match[1]}-${match[2]}-SWAP`
}
function instrumentIdToSymbol(value: string): string | null {
  const normalized = value.toUpperCase()
  const instrument = /^([A-Z0-9]+)-(USDT|USDC)-SWAP$/.exec(normalized)
  if (instrument) return `${instrument[1]}${instrument[2]}`
  return /^([A-Z0-9]+)(USDT|USDC)$/.test(normalized) ? normalized : null
}
function splitSwapInstrument(value: string): { base: string; quote: 'USDT' | 'USDC' } {
  const match = /^([A-Z0-9]+)-(USDT|USDC)-SWAP$/.exec(value)
  if (!match) throw new Error(`unsupported OKX SWAP instrument: ${value}`)
  return { base: match[1], quote: match[2] as 'USDT' | 'USDC' }
}
function firstRecord(value: unknown): Record<string, unknown> | null { return Array.isArray(value) ? asRecord(value[0]) : null }
function asRecord(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }
function numberValue(value: unknown): number | null { const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN; return Number.isFinite(parsed) ? parsed : null }
function parseBool(raw: string | undefined, fallback: boolean): boolean { if (raw == null) return fallback; return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase()) }
function positiveInt(raw: string | undefined, fallback: number): number { const value = Number(raw); return Number.isInteger(value) && value > 0 ? value : fallback }
function nonNegativeInt(raw: string | undefined, fallback: number): number { const value = Number(raw); return Number.isInteger(value) && value >= 0 ? value : fallback }
function boundedPositiveInt(raw: string | undefined, fallback: number, max: number): number { return Math.min(positiveInt(raw, fallback), max) }
function normalizeHost(raw: string): string { return raw.trim().replace(/\/+$/, '') }
function normalizeOptional(raw: string | undefined): string | undefined { const value = raw?.trim(); return value || undefined }
function compactUtc(value: string): string { return value.replace(/[-:.]/g, '') }
function floorBucket(value: number, bucket: number): number { return Math.floor(value / bucket) * bucket }
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }
function stableJson(value: unknown): string { return JSON.stringify(sortValue(value)) }
function sortValue(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortValue); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)])) }
function redact(value: string): string { return value.replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/gi, '$1***').replace(/https?:\/\/[^/@\s:]+:[^/@\s]+@/gi, 'https://***:***@') }

async function writeCheckpoint(path: string, report: OkxExternalCollectReport, rows: OkxExternalRow[]): Promise<void> {
  const latestBySeries: Record<string, string> = {}
  for (const row of rows) {
    const key = `${row.instrumentId}|${row.sourceEndpoint}`
    if (!latestBySeries[key] || row.sourceTimestamp > latestBySeries[key]) latestBySeries[key] = row.sourceTimestamp
  }
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify({
    schemaVersion: 'okx_external_derivatives_checkpoint.v1', generatedAt: new Date().toISOString(),
    runId: report.runId, symbolMode: report.symbolMode, symbols: report.symbols,
    universeSize: report.universeSize, symbolBatchSize: report.symbolBatchSize,
    batchCursor: report.batchCursor, nextBatchCursor: report.nextBatchCursor,
    latestBySeries, errors: report.errors.length, conflictingDuplicateRows: report.conflictingDuplicateRows,
  }, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
  await import('node:fs/promises').then(({ rename }) => rename(temp, path))
}

async function mapLimit<T>(items: T[], concurrency: number, mapper: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const index = next++
      if (index >= items.length) return
      await mapper(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, () => worker()))
}

async function main(): Promise<void> {
  const args = parseOkxExternalCollectArgs(process.argv.slice(2))
  const report = await collectOkxExternalDerivatives(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(`external derivatives collect venue=okx fetched=${report.fetchedRows} appended=${report.appendedRows} errors=${report.errors.length}`)
  if (report.errors.length > 0 || report.fetchedRows === 0) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
