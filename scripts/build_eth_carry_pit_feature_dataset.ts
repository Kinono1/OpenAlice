import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>

interface CliArgs {
  sourcePath: string
  sourcePaths?: string[]
  outputPath: string | null
  maxPairSkewMs: number
  json: boolean
}

interface ExternalDerivativeEvent {
  schemaVersion: string | null
  exchange: string
  market: string
  symbol: string
  endpointId: string | null
  sourceEndpoint: string
  sourceTimestamp: string
  sourceTimestampMs: number
  sourceTimestampBasis: string | null
  fetchTimestamp: string | null
  fetchedAt: string | null
  observedAt: string | null
  availableAt: string | null
  ingestedAt: string | null
  payloadReceivedAt: string | null
  rowPITUsableForPromotion: boolean | null
  pitSuitability: string | null
  jobId: string | null
  generatedAt: string | null
  lineageStatus: string | null
  dedupKey: string | null
  rawPayloadHash: string | null
  collectionRunId: string | null
  reportPath: string | null
  manifestPath: string | null
  payload: UnknownRecord
}

interface ExternalDerivativeEventReadResult {
  events: ExternalDerivativeEvent[]
  sourceEventCount: number
  rowsMissingAvailableAt: number
  sourceLineageIncompleteRows: number
}

export interface EthCarryFundingPitFeature {
  featureId: string
  exchange: string
  market: string
  symbol: string
  sourceEndpoint: string
  sourceTimestamp: string
  sourceTimestampBasis: string | null
  fundingTimestamp: string
  fundingTimestampMs: number
  fetchedAt: string | null
  observedAt: string
  availableAt: string
  availableAtMs: number
  fundingRate: number
  markPrice: number | null
  fundingIntervalHours: number | null
  nextFundingTime: string | null
  source: {
    dedupKey: string | null
    rawPayloadHash: string | null
    collectionRunId: string
    jobId: string
    generatedAt: string | null
    reportPath: string
    manifestPath: string
    lineageStatus: string | null
  }
}

export interface EthCarryBasisPitFeature {
  featureId: string
  exchange: string
  market: string
  symbol: string
  sourceEndpoint: string
  sourceTimestamp: string
  sourceTimestampBasis: string | null
  snapshotTimestamp: string
  snapshotTimestampMs: number
  fetchedAt: string | null
  observedAt: string
  availableAt: string
  availableAtMs: number
  markPrice: number
  indexPrice: number
  basisSpreadPct: number
  lastFundingRate: number | null
  nextFundingTime: string | null
  nextFundingTimeMs: number | null
  fundingIntervalHours: number | null
  source: {
    dedupKey: string | null
    rawPayloadHash: string | null
    collectionRunId: string
    jobId: string
    generatedAt: string | null
    reportPath: string
    manifestPath: string
    lineageStatus: string | null
  }
}

export interface EthCarryPitFeatureRow {
  featureId: string
  exchange: string
  market: string
  strategyFamily: 'funding_carry_rebuild'
  symbols: {
    leader: 'ETHUSDT'
    hedge: 'BTCUSDT'
  }
  decisionAvailableAt: string
  decisionAvailableAtMs: number
  pairSkewMs: number
  fundingSpread: number | null
  basisSpreadDiffPct: number
  ethFundingRate: number | null
  btcFundingRate: number | null
  ethBasisSpreadPct: number
  btcBasisSpreadPct: number
  ethNextFundingTime: string | null
  btcNextFundingTime: string | null
  requiredFields: {
    fundingRateCashflow: boolean
    basisSpread: boolean
    explicitAvailableAt: boolean
  }
  sourceFeatures: {
    ethBasisFeatureId: string
    btcBasisFeatureId: string
    ethFundingFeatureId: string | null
    btcFundingFeatureId: string | null
  }
  blockers: string[]
}

export interface EthCarryPitFeatureDatasetReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionAllowed: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  status: 'ready_for_research' | 'blocked_missing_pit_features'
  sourcePath: string
  sourcePaths: string[]
  thresholds: {
    maxPairSkewMs: number
    requireFundingRateCashflow: true
    requireBasisSpread: true
    requireExplicitAvailableAt: true
  }
  counts: {
    sourceEvents: number
    fundingEvents: number
    basisSnapshots: number
    carryFeatureRows: number
    symbolsWithFunding: string[]
    symbolsWithBasis: string[]
    rowsMissingAvailableAt: number
    sourceLineageIncompleteRows: number
  }
  fundingEvents: EthCarryFundingPitFeature[]
  basisSnapshots: EthCarryBasisPitFeature[]
  carryFeatureRows: EthCarryPitFeatureRow[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_SOURCE_PATH = 'data/normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl'
const DEFAULT_OUTPUT_PATH = 'data/research/eth_carry_pit_features.latest.json'
const DEFAULT_MAX_PAIR_SKEW_MS = 10 * 60_000
const FUNDING_ENDPOINT = '/fapi/v1/fundingRate'
const PREMIUM_INDEX_ENDPOINT = '/fapi/v1/premiumIndex'
const OKX_CARRY_SNAPSHOT_ENDPOINT = '/api/v5/public/okx-carry-snapshot'

async function main(): Promise<void> {
  const args = parseEthCarryPitFeatureDatasetArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runEthCarryPitFeatureDataset(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'eth_carry_pit_feature_dataset',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'ready_for_research' ? 'warn' : 'fail',
      recordsIn: report.counts.sourceEvents,
      recordsOut: report.counts.carryFeatureRows,
      errorClass: report.blockers[0] ?? null,
    })
  }
}

export function parseEthCarryPitFeatureDatasetArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const sourcePaths = parseSourcePaths(raw.get('sourcePaths') ?? raw.get('sources') ?? raw.get('sourcePath') ?? raw.get('source') ?? DEFAULT_SOURCE_PATH)
  return {
    sourcePath: sourcePaths[0] ?? DEFAULT_SOURCE_PATH,
    sourcePaths,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    maxPairSkewMs: parsePositiveInteger(raw.get('maxPairSkewMs'), DEFAULT_MAX_PAIR_SKEW_MS, 'maxPairSkewMs'),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runEthCarryPitFeatureDataset(args: CliArgs): Promise<EthCarryPitFeatureDatasetReport> {
  const sourcePaths = (args.sourcePaths && args.sourcePaths.length > 0 ? args.sourcePaths : [args.sourcePath]).map(path => resolve(path))
  const events: ExternalDerivativeEvent[] = []
  let sourceEventCount = 0
  let rowsMissingAvailableAt = 0
  let sourceLineageIncompleteRows = 0
  for (const path of sourcePaths) {
    const source = await readExternalDerivativeEvents(path)
    sourceEventCount += source.sourceEventCount
    rowsMissingAvailableAt += source.rowsMissingAvailableAt
    sourceLineageIncompleteRows += source.sourceLineageIncompleteRows
    for (const event of source.events) events.push(event)
  }
  const report = buildEthCarryPitFeatureDatasetReport({
    generatedAt: new Date().toISOString(),
    sourcePath: sourcePaths[0] ?? resolve(args.sourcePath),
    sourcePaths,
    sourceExists: sourcePaths.length > 0 && sourcePaths.every(path => existsSync(path)),
    events,
    sourceEventCount,
    rowsMissingAvailableAt,
    sourceLineageIncompleteRows,
    maxPairSkewMs: args.maxPairSkewMs,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  }

  return report
}

export function buildEthCarryPitFeatureDatasetReport(input: {
  generatedAt?: string
  sourcePath: string
  sourcePaths?: string[]
  sourceExists: boolean
  events: ExternalDerivativeEvent[]
  sourceEventCount?: number
  rowsMissingAvailableAt?: number
  sourceLineageIncompleteRows?: number
  maxPairSkewMs: number
}): EthCarryPitFeatureDatasetReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const sourcePaths = (input.sourcePaths && input.sourcePaths.length > 0 ? input.sourcePaths : [input.sourcePath]).map(path => resolve(path))
  const fundingEvents = buildFundingFeatures(input.events)
  const basisSnapshots = buildBasisFeatures(input.events)
  const carryFeatureRows = buildCarryFeatureRows(basisSnapshots, fundingEvents, input.maxPairSkewMs)
  const sourceEventCount = input.sourceEventCount ?? input.events.length
  const rowsMissingAvailableAt = input.rowsMissingAvailableAt ?? input.events.filter(event => event.availableAt == null).length
  const sourceLineageIncompleteRows =
    input.sourceLineageIncompleteRows ?? input.events.filter(event => !isResearchUsableExternalDerivativeEvent(event)).length
  const symbolsWithFunding = uniqueSorted(fundingEvents.map(row => row.symbol))
  const symbolsWithBasis = uniqueSorted(basisSnapshots.map(row => row.symbol))
  const blockers = uniqueStrings([
    ...(input.sourceExists ? [] : ['external_derivatives_source_missing']),
    ...(fundingEvents.length > 0 ? [] : ['funding_rate_cashflow_rows_missing']),
    ...(basisSnapshots.length > 0 ? [] : ['basis_spread_rows_missing']),
    ...(symbolsWithFunding.includes('ETHUSDT') ? [] : ['funding_rows_missing:ETHUSDT']),
    ...(symbolsWithFunding.includes('BTCUSDT') ? [] : ['funding_rows_missing:BTCUSDT']),
    ...(symbolsWithBasis.includes('ETHUSDT') ? [] : ['basis_rows_missing:ETHUSDT']),
    ...(symbolsWithBasis.includes('BTCUSDT') ? [] : ['basis_rows_missing:BTCUSDT']),
    ...(carryFeatureRows.length > 0 ? [] : ['matched_eth_btc_carry_feature_rows_missing']),
    ...carryFeatureRows.flatMap(row => row.blockers.map(reason => `carry_feature:${reason}`)),
  ])
  const status: EthCarryPitFeatureDatasetReport['status'] =
    blockers.length === 0 ? 'ready_for_research' : 'blocked_missing_pit_features'

  return {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status,
    sourcePath: sourcePaths[0] ?? resolve(input.sourcePath),
    sourcePaths,
    thresholds: {
      maxPairSkewMs: input.maxPairSkewMs,
      requireFundingRateCashflow: true,
      requireBasisSpread: true,
      requireExplicitAvailableAt: true,
    },
    counts: {
      sourceEvents: sourceEventCount,
      fundingEvents: fundingEvents.length,
      basisSnapshots: basisSnapshots.length,
      carryFeatureRows: carryFeatureRows.length,
      symbolsWithFunding,
      symbolsWithBasis,
      rowsMissingAvailableAt,
      sourceLineageIncompleteRows,
    },
    fundingEvents,
    basisSnapshots,
    carryFeatureRows,
    blockers,
    nextActions: [
      'Use carryFeatureRows only for research decisions strictly after decisionAvailableAt.',
      'Keep legacy timestamp-only funding history out of promotion-grade PIT accounting until recollected with availableAt fields.',
      'Build prospective observations from this artifact before any WFO or promotion review.',
    ],
    safetyNotes: [
      'This feature dataset is research-only and cannot authorize paper or live execution.',
      'availableAt is conservatively based on local ingestion time when present, not the exchange event timestamp.',
      'Funding and basis features must remain evidence inputs, not instructions to trade.',
    ],
  }
}

function buildFundingFeatures(events: ExternalDerivativeEvent[]): EthCarryFundingPitFeature[] {
  const rows = events
    .filter(event => isFundingFeatureSourceEvent(event))
    .map(event => {
      const fundingRate = readNumber(event.payload.fundingRate) ?? readNumber(event.payload.lastFundingRate)
      if (fundingRate == null || !isResearchUsableExternalDerivativeEvent(event)) return null
      const fundingTimestampMs = readNumber(event.payload.fundingTime) ?? event.sourceTimestampMs
      const markPrice = readNumber(event.payload.markPrice) ?? readNumber(event.payload.markPx)
      return {
        featureId: hashId([
          'eth_carry_funding_pit_feature',
          event.exchange,
          event.market,
          event.symbol,
          String(fundingTimestampMs),
          event.availableAt,
          event.rawPayloadHash ?? '',
        ]),
        exchange: event.exchange,
        market: event.market,
        symbol: event.symbol,
        sourceEndpoint: event.sourceEndpoint,
        sourceTimestamp: event.sourceTimestamp,
        sourceTimestampBasis: event.sourceTimestampBasis,
        fundingTimestamp: new Date(fundingTimestampMs).toISOString(),
        fundingTimestampMs,
        fetchedAt: event.fetchedAt,
        observedAt: event.observedAt ?? event.availableAt,
        availableAt: event.availableAt,
        availableAtMs: Date.parse(event.availableAt),
        fundingRate,
        markPrice,
        fundingIntervalHours: null,
        nextFundingTime: null,
        source: {
          dedupKey: event.dedupKey,
          rawPayloadHash: event.rawPayloadHash,
          collectionRunId: event.collectionRunId,
          jobId: event.jobId,
          generatedAt: event.generatedAt,
          reportPath: event.reportPath,
          manifestPath: event.manifestPath,
          lineageStatus: event.lineageStatus,
        },
      } satisfies EthCarryFundingPitFeature
    })
    .filter((row): row is EthCarryFundingPitFeature => row != null)
    .sort((left, right) => left.fundingTimestampMs - right.fundingTimestampMs || left.availableAtMs - right.availableAtMs)

  const intervalsBySymbol = new Map<string, number | null>()
  for (const symbol of uniqueSorted(rows.map(row => row.symbol))) {
    const timestamps = rows
      .filter(row => row.symbol === symbol)
      .map(row => row.fundingTimestampMs)
      .sort((left, right) => left - right)
    const intervals = timestamps
      .slice(1)
      .map((value, index) => value - timestamps[index])
      .filter(value => value > 0)
    intervalsBySymbol.set(symbol, intervals.length > 0 ? round(median(intervals) / 3_600_000, 6) : null)
  }

  return rows.map(row => ({
    ...row,
    fundingIntervalHours: intervalsBySymbol.get(row.symbol) ?? null,
  }))
}

function buildBasisFeatures(events: ExternalDerivativeEvent[]): EthCarryBasisPitFeature[] {
  const rows = events
    .filter(event => isBasisFeatureSourceEvent(event))
    .map(event => {
      const markPrice = readNumber(event.payload.markPrice) ?? readNumber(event.payload.markPx)
      const indexPrice = readNumber(event.payload.indexPrice) ?? readNumber(event.payload.idxPx)
      if (markPrice == null || indexPrice == null || indexPrice <= 0 || !isResearchUsableExternalDerivativeEvent(event)) return null
      const nextFundingTimeMs = readNumber(event.payload.nextFundingTime)
      const lastFundingRate = readNumber(event.payload.lastFundingRate)
      const basisSpreadPct = ((markPrice - indexPrice) / indexPrice) * 100
      return {
        featureId: hashId([
          'eth_carry_basis_pit_feature',
          event.exchange,
          event.market,
          event.symbol,
          String(event.sourceTimestampMs),
          event.availableAt,
          event.rawPayloadHash ?? '',
        ]),
        exchange: event.exchange,
        market: event.market,
        symbol: event.symbol,
        sourceEndpoint: event.sourceEndpoint,
        sourceTimestamp: event.sourceTimestamp,
        sourceTimestampBasis: event.sourceTimestampBasis,
        snapshotTimestamp: event.sourceTimestamp,
        snapshotTimestampMs: event.sourceTimestampMs,
        fetchedAt: event.fetchedAt,
        observedAt: event.observedAt ?? event.availableAt,
        availableAt: event.availableAt,
        availableAtMs: Date.parse(event.availableAt),
        markPrice,
        indexPrice,
        basisSpreadPct: round(basisSpreadPct, 10),
        lastFundingRate,
        nextFundingTime: nextFundingTimeMs != null ? new Date(nextFundingTimeMs).toISOString() : null,
        nextFundingTimeMs,
        fundingIntervalHours: null,
        source: {
          dedupKey: event.dedupKey,
          rawPayloadHash: event.rawPayloadHash,
          collectionRunId: event.collectionRunId,
          jobId: event.jobId,
          generatedAt: event.generatedAt,
          reportPath: event.reportPath,
          manifestPath: event.manifestPath,
          lineageStatus: event.lineageStatus,
        },
      } satisfies EthCarryBasisPitFeature
    })
    .filter((row): row is EthCarryBasisPitFeature => row != null)
    .sort((left, right) => left.snapshotTimestampMs - right.snapshotTimestampMs || left.availableAtMs - right.availableAtMs)

  return rows.map(row => ({
    ...row,
    fundingIntervalHours: inferFundingIntervalHours(row.nextFundingTimeMs, row.snapshotTimestampMs),
  }))
}

function buildCarryFeatureRows(
  basisSnapshots: EthCarryBasisPitFeature[],
  fundingEvents: EthCarryFundingPitFeature[],
  maxPairSkewMs: number,
): EthCarryPitFeatureRow[] {
  const ethRows = basisSnapshots.filter(row => row.symbol === 'ETHUSDT')
  const btcRows = basisSnapshots.filter(row => row.symbol === 'BTCUSDT')
  return ethRows
    .map(eth => {
      const btc = nearestByAvailableAt(eth.availableAtMs, btcRows, maxPairSkewMs)
      if (!btc) return null
      const decisionAvailableAtMs = Math.max(eth.availableAtMs, btc.availableAtMs)
      const pairSkewMs = Math.abs(eth.availableAtMs - btc.availableAtMs)
      const ethFunding = latestFundingKnownAtDecision(fundingEvents, eth, decisionAvailableAtMs)
      const btcFunding = latestFundingKnownAtDecision(fundingEvents, btc, decisionAvailableAtMs)
      const ethFundingRate = eth.lastFundingRate ?? ethFunding?.fundingRate ?? null
      const btcFundingRate = btc.lastFundingRate ?? btcFunding?.fundingRate ?? null
      const fundingSpread =
        ethFundingRate != null && btcFundingRate != null
          ? round(ethFundingRate - btcFundingRate, 12)
          : null
      const blockers = uniqueStrings([
        ...(eth.availableAtMs < decisionAvailableAtMs || btc.availableAtMs < decisionAvailableAtMs
          ? []
          : []),
        ...(fundingSpread == null ? ['funding_rate_cashflow_missing'] : []),
        ...(Number.isFinite(eth.basisSpreadPct) && Number.isFinite(btc.basisSpreadPct) ? [] : ['basis_spread_missing']),
        ...(pairSkewMs <= maxPairSkewMs ? [] : [`pair_skew_ms:${pairSkewMs}>${maxPairSkewMs}`]),
      ])
      return {
        featureId: hashId([
          'eth_carry_pit_pair_feature',
          eth.featureId,
          btc.featureId,
          new Date(decisionAvailableAtMs).toISOString(),
        ]),
        exchange: eth.exchange,
        market: eth.market,
        strategyFamily: 'funding_carry_rebuild',
        symbols: {
          leader: 'ETHUSDT',
          hedge: 'BTCUSDT',
        },
        decisionAvailableAt: new Date(decisionAvailableAtMs).toISOString(),
        decisionAvailableAtMs,
        pairSkewMs,
        fundingSpread,
        basisSpreadDiffPct: round(eth.basisSpreadPct - btc.basisSpreadPct, 10),
        ethFundingRate,
        btcFundingRate,
        ethBasisSpreadPct: eth.basisSpreadPct,
        btcBasisSpreadPct: btc.basisSpreadPct,
        ethNextFundingTime: eth.nextFundingTime,
        btcNextFundingTime: btc.nextFundingTime,
        requiredFields: {
          fundingRateCashflow: fundingSpread != null,
          basisSpread: true,
          explicitAvailableAt: true,
        },
        sourceFeatures: {
          ethBasisFeatureId: eth.featureId,
          btcBasisFeatureId: btc.featureId,
          ethFundingFeatureId: ethFunding?.featureId ?? null,
          btcFundingFeatureId: btcFunding?.featureId ?? null,
        },
        blockers,
      } satisfies EthCarryPitFeatureRow
    })
    .filter((row): row is EthCarryPitFeatureRow => row != null)
    .sort((left, right) => left.decisionAvailableAtMs - right.decisionAvailableAtMs)
}

function latestFundingKnownAtDecision(
  fundingEvents: EthCarryFundingPitFeature[],
  basis: EthCarryBasisPitFeature,
  decisionAvailableAtMs: number,
): EthCarryFundingPitFeature | null {
  return fundingEvents
    .filter(row =>
      row.exchange === basis.exchange &&
      row.market === basis.market &&
      row.symbol === basis.symbol &&
      row.availableAtMs <= decisionAvailableAtMs,
    )
    .sort((left, right) =>
      right.availableAtMs - left.availableAtMs ||
      right.fundingTimestampMs - left.fundingTimestampMs,
    )[0] ?? null
}

async function readExternalDerivativeEvents(path: string): Promise<ExternalDerivativeEventReadResult> {
  const resolvedPath = resolve(path)
  const result: ExternalDerivativeEventReadResult = {
    events: [],
    sourceEventCount: 0,
    rowsMissingAvailableAt: 0,
    sourceLineageIncompleteRows: 0,
  }
  if (!existsSync(resolvedPath)) return result

  const stream = createReadStream(resolvedPath, { encoding: 'utf-8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const event = parseExternalDerivativeEvent(trimmed)
    if (!event) continue

    result.sourceEventCount += 1
    if (event.availableAt == null) result.rowsMissingAvailableAt += 1
    if (!isResearchUsableExternalDerivativeEvent(event)) result.sourceLineageIncompleteRows += 1
    if (isFundingFeatureSourceEvent(event) || isBasisFeatureSourceEvent(event)) {
      result.events.push(event)
    }
  }
  return result
}

function isFundingFeatureSourceEvent(event: ExternalDerivativeEvent): boolean {
  return event.endpointId === 'fundingRate' ||
    event.endpointId === 'okxCarrySnapshot' ||
    event.sourceEndpoint === FUNDING_ENDPOINT ||
    event.sourceEndpoint === OKX_CARRY_SNAPSHOT_ENDPOINT
}

function isBasisFeatureSourceEvent(event: ExternalDerivativeEvent): boolean {
  return event.endpointId === 'premiumIndex' ||
    event.endpointId === 'okxCarrySnapshot' ||
    event.sourceEndpoint === PREMIUM_INDEX_ENDPOINT ||
    event.sourceEndpoint === OKX_CARRY_SNAPSHOT_ENDPOINT
}

function parseExternalDerivativeEvent(line: string): ExternalDerivativeEvent | null {
  try {
    const record = asRecord(JSON.parse(line))
    const normalizedFields = asRecord(record?.fields)
    const payload = asRecord(record?.payload) ?? normalizedFields
    const exchange = readString(record?.exchange)
    const market = readString(record?.market)
    const symbol = readString(record?.symbol)
    const endpointId = readString(record?.endpointId)
    const sourceEndpoint = readString(record?.sourceEndpoint) ?? sourceEndpointFromEndpointId(endpointId, exchange)
    const sourceTimestamp = readString(record?.sourceTimestamp) ?? readString(record?.eventTime)
    const sourceTimestampMs = readNumber(record?.sourceTimestampMs) ?? readNumber(record?.eventTimeMs) ?? (sourceTimestamp ? Date.parse(sourceTimestamp) : NaN)
    if (!payload || !exchange || !market || !symbol || !sourceEndpoint || !sourceTimestamp || !Number.isFinite(sourceTimestampMs)) {
      return null
    }
    const fetchTimestamp = readString(record?.fetchTimestamp) ?? readString(record?.fetchedAt)
    const payloadReceivedAt = readString(record?.payloadReceivedAt) ?? readString(record?.observedAt)
    const ingestedAt = readString(record?.ingestedAt)
    const availableAt = readString(record?.availableAt) ?? selectLatestIso([ingestedAt, payloadReceivedAt, fetchTimestamp])
    const jobId = readString(record?.jobId) ?? readString(record?.collectionRunId)
    const collectionRunId = readString(record?.collectionRunId) ?? jobId
    const generatedAt = readString(record?.generatedAt)
    const reportPath = readString(record?.reportPath)
    const manifestPath = readString(record?.manifestPath)
    return {
      schemaVersion: readString(record?.schemaVersion),
      exchange,
      market,
      symbol,
      endpointId,
      sourceEndpoint,
      sourceTimestamp,
      sourceTimestampMs,
      sourceTimestampBasis: readString(record?.sourceTimestampBasis),
      fetchTimestamp,
      fetchedAt: fetchTimestamp,
      observedAt: payloadReceivedAt ?? fetchTimestamp ?? availableAt,
      availableAt,
      ingestedAt,
      payloadReceivedAt,
      rowPITUsableForPromotion: readBoolean(record?.rowPITUsableForPromotion),
      pitSuitability: readString(record?.pitSuitability),
      jobId,
      generatedAt,
      lineageStatus: readString(record?.lineageStatus),
      dedupKey: readString(record?.dedupKey),
      rawPayloadHash: readString(record?.rawPayloadHash),
      collectionRunId,
      reportPath,
      manifestPath,
      payload,
    }
  } catch {
    return null
  }
}

function isResearchUsableExternalDerivativeEvent(
  event: ExternalDerivativeEvent,
): event is ExternalDerivativeEvent & {
  availableAt: string
  collectionRunId: string
  jobId: string
  reportPath: string
  manifestPath: string
} {
  return Boolean(
    event.availableAt &&
    event.collectionRunId &&
    event.jobId &&
    event.reportPath &&
    event.manifestPath,
  )
}

function sourceEndpointFromEndpointId(endpointId: string | null, exchange: string | null): string | null {
  if (exchange === 'okx') {
    if (endpointId === 'fundingRate') return '/api/v5/public/funding-rate-history'
    if (endpointId === 'premiumIndex') return '/api/v5/public/mark-price+/api/v5/market/index-tickers'
    if (endpointId === 'openInterest') return '/api/v5/public/open-interest'
    if (endpointId === 'openInterestHist') return '/api/v5/rubik/stat/contracts/open-interest-volume'
    if (endpointId === 'globalLongShortAccountRatio') return '/api/v5/rubik/stat/contracts/long-short-account-ratio'
  }
  if (endpointId === 'fundingRate') return FUNDING_ENDPOINT
  if (endpointId === 'premiumIndex') return PREMIUM_INDEX_ENDPOINT
  if (endpointId === 'okxCarrySnapshot') return OKX_CARRY_SNAPSHOT_ENDPOINT
  if (endpointId === 'openInterest') return '/fapi/v1/openInterest'
  if (endpointId === 'openInterestHist') return '/futures/data/openInterestHist'
  if (endpointId === 'globalLongShortAccountRatio') return '/futures/data/globalLongShortAccountRatio'
  return null
}

function nearestByAvailableAt(
  targetAvailableAtMs: number,
  rows: EthCarryBasisPitFeature[],
  maxPairSkewMs: number,
): EthCarryBasisPitFeature | null {
  let best: EthCarryBasisPitFeature | null = null
  let bestSkew = Number.POSITIVE_INFINITY
  for (const row of rows) {
    const skew = Math.abs(row.availableAtMs - targetAvailableAtMs)
    if (skew > maxPairSkewMs) continue
    if (skew < bestSkew) {
      best = row
      bestSkew = skew
    }
  }
  return best
}

function inferFundingIntervalHours(nextFundingTimeMs: number | null, snapshotTimestampMs: number): number | null {
  if (nextFundingTimeMs == null || nextFundingTimeMs <= snapshotTimestampMs) return null
  return round((nextFundingTimeMs - snapshotTimestampMs) / 3_600_000, 6)
}

function selectLatestIso(values: Array<string | null>): string | null {
  const timestamps = values
    .map(value => value ? Date.parse(value) : NaN)
    .filter(Number.isFinite)
  if (timestamps.length === 0) return null
  return new Date(Math.max(...timestamps)).toISOString()
}

function renderConsoleSummary(report: EthCarryPitFeatureDatasetReport): string {
  return [
    `eth carry PIT features: status=${report.status}`,
    `funding=${report.counts.fundingEvents}, basis=${report.counts.basisSnapshots}, carryRows=${report.counts.carryFeatureRows}`,
    `paper=${report.paperTradingAllowed}, live=${report.liveTradingAllowed}, promotion=${report.promotionAllowed}`,
    report.blockers.length > 0 ? `blockers=${report.blockers.join(',')}` : 'blockers=[]',
  ].join('\n')
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const parsed = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      parsed.set(key, next)
      index += 1
    } else {
      parsed.set(key, 'true')
    }
  }
  return parsed
}

function parseNullablePath(value: string | undefined): string | null {
  if (value == null) return null
  if (value === 'null' || value === 'none' || value === '') return null
  return value
}

function parseSourcePaths(value: string): string[] {
  return uniqueStrings(value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean))
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  if (['1', 'true', 'yes'].includes(value.toLowerCase())) return true
  if (['0', 'false', 'no'].includes(value.toLowerCase())) return false
  return fallback
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const midpoint = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint]
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function hashId(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('build_eth_carry_pit_feature_dataset failed:', error)
    process.exitCode = 1
  })
}
