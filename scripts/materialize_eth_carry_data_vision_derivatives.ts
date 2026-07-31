import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>
type DataType = 'fundingRate' | 'markPriceKlines' | 'indexPriceKlines' | 'premiumIndexKlines'

interface CliArgs {
  warehouseRoot: string
  outputPath: string
  reportPath: string | null
  json: boolean
}

interface ArchiveSpec {
  dataType: DataType
  sourceEndpoint: string
  directory: string
}

interface ArchiveManifestRecord {
  market: string
  dataType: DataType
  symbol: string
  month: string
  key: string
  url: string
  zipPath: string
  status: string
  collectorObservedAt: string | null
  archiveAvailableAt: string | null
  sourceUrl: string
  sourcePath: string
  collectionRunId: string
  manifestPath: string
}

interface NormalizedDataVisionDerivativeRow {
  schemaVersion: 'openalice.external_derivatives.normalized.v1'
  eventTime: string
  eventTimeMs: number
  exchange: 'binance'
  market: 'usdm'
  symbol: string
  endpointId: 'fundingRate' | 'premiumIndex'
  sourceEndpoint: '/fapi/v1/fundingRate' | '/fapi/v1/premiumIndex'
  sourceTimestamp: string
  sourceTimestampMs: number
  sourceTimestampBasis: string
  fetchedAt: string | null
  observedAt: string | null
  availableAt: string
  availableAtMs: number
  availableAtBasis: 'derived_archive_event_available_time_research_proxy'
  archiveFileAvailableAt: string | null
  ingestedAt: string
  jobId: 'eth_carry_data_vision_derivatives_materialize'
  generatedAt: string
  lineageStatus: 'data_vision_archive_research_proxy'
  dedupKey: string
  rawPayloadHash: string
  collectionRunId: string
  reportPath: string | null
  manifestPath: string
  sourceUrl: string
  sourcePath: string
  normalizedPayloadHash: string
  rowPITUsableForPromotion: false
  pitSuitability: 'archive_event_time_research_proxy_not_promotion_grade'
  fields: Record<string, number | string | null>
}

interface KlinePoint {
  symbol: string
  openTimeMs: number
  closeTimeMs: number
  open: number
  high: number
  low: number
  close: number
  manifest: ArchiveManifestRecord
}

interface FundingPoint {
  symbol: string
  fundingTimeMs: number
  fundingRate: number
  fundingIntervalHours: number | null
  manifest: ArchiveManifestRecord
}

export interface MaterializeEthCarryDataVisionDerivativesReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: 'complete' | 'partial' | 'failed'
  sourceArtifacts: {
    warehouseRoot: string
    outputPath: string
    reportPath: string | null
  }
  counts: {
    archiveManifests: number
    archiveZipFiles: number
    fundingArchiveRows: number
    markKlineRows: number
    indexKlineRows: number
    premiumKlineRows: number
    normalizedFundingRows: number
    normalizedBasisRows: number
    normalizedRows: number
    rowsPITUsableForPromotion: number
  }
  symbols: string[]
  observedStartTime: string | null
  observedEndTime: string | null
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
  outputHash: string | null
}

const DEFAULT_WAREHOUSE_ROOT = 'data'
const DEFAULT_REPORT_PATH = 'data/runtime/eth_carry_data_vision_derivatives_materialize.latest.json'
const JOB_ID = 'eth_carry_data_vision_derivatives_materialize'

const ARCHIVE_SPECS: ArchiveSpec[] = [
  {
    dataType: 'fundingRate',
    sourceEndpoint: '/fapi/v1/fundingRate',
    directory: 'market/binance-public/eth-carry-core-fundingRate',
  },
  {
    dataType: 'markPriceKlines',
    sourceEndpoint: '/fapi/v1/premiumIndex',
    directory: 'market/binance-public/eth-carry-core-markPriceKlines-1h',
  },
  {
    dataType: 'indexPriceKlines',
    sourceEndpoint: '/fapi/v1/premiumIndex',
    directory: 'market/binance-public/eth-carry-core-indexPriceKlines-1h',
  },
  {
    dataType: 'premiumIndexKlines',
    sourceEndpoint: '/fapi/v1/premiumIndex',
    directory: 'market/binance-public/eth-carry-core-premiumIndexKlines-1h',
  },
]

async function main(): Promise<void> {
  const args = parseMaterializeEthCarryDataVisionDerivativesArgs(process.argv.slice(2))
  const report = await runMaterializeEthCarryDataVisionDerivatives(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseMaterializeEthCarryDataVisionDerivativesArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const warehouseRoot = resolve(raw.get('warehouseRoot') ?? raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT ?? DEFAULT_WAREHOUSE_ROOT)
  return {
    warehouseRoot,
    outputPath: resolve(
      raw.get('outputPath') ??
      raw.get('output') ??
      resolve(warehouseRoot, 'normalized/derivatives/binance_usdm_eth_carry_data_vision_core.normalized.jsonl'),
    ),
    reportPath: parseNullablePath(raw.get('reportPath') ?? raw.get('report') ?? DEFAULT_REPORT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runMaterializeEthCarryDataVisionDerivatives(
  args: CliArgs,
): Promise<MaterializeEthCarryDataVisionDerivativesReport> {
  const startedAt = new Date()
  const generatedAt = new Date().toISOString()
  const reportPath = args.reportPath ? resolve(args.reportPath) : null
  const manifestRecords = readAllArchiveManifestRecords(args.warehouseRoot)
  const materialized = materializeRowsFromArchiveCsvs({
    generatedAt,
    reportPath,
    manifestRecords,
    readCsvText: readZipCsvText,
  })
  const rows = materialized.rows.sort((left, right) =>
    left.eventTimeMs - right.eventTimeMs ||
    left.symbol.localeCompare(right.symbol) ||
    left.endpointId.localeCompare(right.endpointId),
  )
  const payload = rows.map(row => JSON.stringify(row)).join('\n')
  const outputPayload = payload ? `${payload}\n` : ''
  const outputHash = outputPayload ? sha256Hex(outputPayload) : null
  await mkdir(dirname(args.outputPath), { recursive: true })
  await writeFile(args.outputPath, outputPayload, 'utf-8')
  await writeEvidenceManifestForArtifact({
    job: JOB_ID,
    artifactPath: args.outputPath,
    startedAt,
    finishedAt: new Date(),
    exitCode: rows.length > 0 ? 0 : 1,
    businessStatus: rows.length > 0 ? 'warn' : 'fail',
    recordsIn: materialized.counts.archiveZipFiles,
    recordsOut: rows.length,
    errorClass: rows.length > 0 ? null : 'eth_carry_data_vision_normalized_rows_missing',
    artifactHash: outputHash,
  })

  const eventTimes = rows.map(row => row.eventTime).sort()
  const blockers = uniqueStrings([
    ...(materialized.counts.archiveManifests === ARCHIVE_SPECS.length ? [] : [`archive_manifests_missing:${materialized.counts.archiveManifests}<${ARCHIVE_SPECS.length}`]),
    ...(materialized.counts.normalizedFundingRows > 0 ? [] : ['funding_rows_missing']),
    ...(materialized.counts.normalizedBasisRows > 0 ? [] : ['basis_rows_missing']),
    ...(rows.length > 0 ? [] : ['normalized_rows_missing']),
  ])
  const report: MaterializeEthCarryDataVisionDerivativesReport = {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: rows.length === 0 ? 'failed' : blockers.length > 0 ? 'partial' : 'complete',
    sourceArtifacts: {
      warehouseRoot: resolve(args.warehouseRoot),
      outputPath: resolve(args.outputPath),
      reportPath,
    },
    counts: {
      ...materialized.counts,
      rowsPITUsableForPromotion: rows.filter(row => row.rowPITUsableForPromotion).length,
    },
    symbols: uniqueSorted(rows.map(row => row.symbol)),
    observedStartTime: eventTimes[0] ?? null,
    observedEndTime: eventTimes.at(-1) ?? null,
    blockers,
    nextActions: rows.length > 0
      ? [
          'Run research:eth-carry:pit-features against this normalized output, then rerun PIT audit and data-gap status.',
          'Treat these rows as archive-derived research proxy rows; they are not promotion-grade PIT evidence.',
        ]
      : ['Run the ETH carry Data Vision core smoke backfill before materializing normalized derivatives rows.'],
    safetyNotes: [
      'Data Vision archive rows are materialized for research feature reconstruction only.',
      'rowPITUsableForPromotion is false for every row; do not use this artifact to authorize paper or live trading.',
      'availableAt is a conservative archive event-time research proxy, not independently audited exchange publication time.',
    ],
    outputHash,
  }

  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: `${JOB_ID}_report`,
      artifactPath: reportPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: report.status === 'failed' ? 1 : 0,
      businessStatus: report.status === 'complete' ? 'warn' : report.status === 'partial' ? 'warn' : 'fail',
      recordsIn: materialized.counts.archiveZipFiles,
      recordsOut: rows.length,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export function materializeRowsFromArchiveCsvs(input: {
  generatedAt: string
  reportPath: string | null
  manifestRecords: ArchiveManifestRecord[]
  readCsvText: (zipPath: string) => string
}): {
  rows: NormalizedDataVisionDerivativeRow[]
  counts: Omit<MaterializeEthCarryDataVisionDerivativesReport['counts'], 'rowsPITUsableForPromotion'>
} {
  const fundingPoints = input.manifestRecords
    .filter(record => record.dataType === 'fundingRate' && record.status === 'downloaded')
    .flatMap(record => parseFundingCsv(input.readCsvText(record.zipPath), record))
  const markRows = input.manifestRecords
    .filter(record => record.dataType === 'markPriceKlines' && record.status === 'downloaded')
    .flatMap(record => parseKlineCsv(input.readCsvText(record.zipPath), record))
  const indexRows = input.manifestRecords
    .filter(record => record.dataType === 'indexPriceKlines' && record.status === 'downloaded')
    .flatMap(record => parseKlineCsv(input.readCsvText(record.zipPath), record))
  const premiumRows = input.manifestRecords
    .filter(record => record.dataType === 'premiumIndexKlines' && record.status === 'downloaded')
    .flatMap(record => parseKlineCsv(input.readCsvText(record.zipPath), record))
  const fundingRows = fundingPoints.map(point => buildFundingRow(point, input.generatedAt, input.reportPath))
  const basisRows = buildBasisRows({
    generatedAt: input.generatedAt,
    reportPath: input.reportPath,
    fundingPoints,
    markRows,
    indexRows,
    premiumRows,
  })
  return {
    rows: [...fundingRows, ...basisRows],
    counts: {
      archiveManifests: uniqueSorted(input.manifestRecords.map(record => record.manifestPath)).length,
      archiveZipFiles: input.manifestRecords.filter(record => record.status === 'downloaded').length,
      fundingArchiveRows: fundingPoints.length,
      markKlineRows: markRows.length,
      indexKlineRows: indexRows.length,
      premiumKlineRows: premiumRows.length,
      normalizedFundingRows: fundingRows.length,
      normalizedBasisRows: basisRows.length,
      normalizedRows: fundingRows.length + basisRows.length,
    },
  }
}

function readAllArchiveManifestRecords(warehouseRoot: string): ArchiveManifestRecord[] {
  return ARCHIVE_SPECS.flatMap(spec => {
    const manifestPath = resolve(warehouseRoot, spec.directory, 'manifest.fast-binance-download.jsonl')
    if (!existsSync(manifestPath)) return []
    return readFileSync(manifestPath, 'utf-8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => parseArchiveManifestRecord(line, manifestPath))
      .filter((record): record is ArchiveManifestRecord => record != null && record.dataType === spec.dataType)
  })
}

function parseArchiveManifestRecord(line: string, manifestPath: string): ArchiveManifestRecord | null {
  try {
    const record = asRecord(JSON.parse(line))
    const dataType = readDataType(record?.dataType)
    const market = readString(record?.market)
    const symbol = readString(record?.symbol)
    const month = readString(record?.month)
    const key = readString(record?.key) ?? readString(record?.sourcePath)
    const url = readString(record?.url) ?? readString(record?.sourceUrl)
    const zipPath = readString(record?.zipPath)
    const status = readString(record?.status)
    if (!dataType || !market || !symbol || !month || !key || !url || !zipPath || !status) return null
    return {
      market,
      dataType,
      symbol,
      month,
      key,
      url,
      zipPath,
      status,
      collectorObservedAt: readString(record?.collectorObservedAt) ?? readString(record?.observedAt),
      archiveAvailableAt: readString(record?.archiveFileAvailableAt) ?? readString(record?.availableAt),
      sourceUrl: readString(record?.sourceUrl) ?? url,
      sourcePath: readString(record?.sourcePath) ?? key,
      collectionRunId: readString(record?.collectionRunId) ?? readString(record?.jobId) ?? JOB_ID,
      manifestPath,
    }
  } catch {
    return null
  }
}

function parseFundingCsv(csvText: string, manifest: ArchiveManifestRecord): FundingPoint[] {
  return parseCsv(csvText, ['calc_time', 'funding_interval_hours', 'last_funding_rate'])
    .map(row => {
      const fundingTimeMs = readNumber(row.calc_time)
      const fundingRate = readNumber(row.last_funding_rate)
      if (fundingTimeMs == null || fundingRate == null) return null
      return {
        symbol: manifest.symbol,
        fundingTimeMs,
        fundingRate,
        fundingIntervalHours: readNumber(row.funding_interval_hours),
        manifest,
      }
    })
    .filter((row): row is FundingPoint => row != null)
}

function parseKlineCsv(csvText: string, manifest: ArchiveManifestRecord): KlinePoint[] {
  return parseCsv(csvText, [
    'open_time',
    'open',
    'high',
    'low',
    'close',
    'volume',
    'close_time',
    'quote_volume',
    'count',
    'taker_buy_volume',
    'taker_buy_quote_volume',
    'ignore',
  ])
    .map(row => {
      const openTimeMs = readNumber(row.open_time)
      const closeTimeMs = readNumber(row.close_time)
      const open = readNumber(row.open)
      const high = readNumber(row.high)
      const low = readNumber(row.low)
      const close = readNumber(row.close)
      if (openTimeMs == null || closeTimeMs == null || open == null || high == null || low == null || close == null) return null
      return {
        symbol: manifest.symbol,
        openTimeMs,
        closeTimeMs,
        open,
        high,
        low,
        close,
        manifest,
      }
    })
    .filter((row): row is KlinePoint => row != null)
}

function buildFundingRow(
  point: FundingPoint,
  generatedAt: string,
  reportPath: string | null,
): NormalizedDataVisionDerivativeRow {
  const eventTime = new Date(point.fundingTimeMs).toISOString()
  const fields = {
    symbol: point.symbol,
    fundingTime: point.fundingTimeMs,
    fundingRate: point.fundingRate,
    lastFundingRate: point.fundingRate,
    fundingIntervalHours: point.fundingIntervalHours,
    funding_interval_hours: point.fundingIntervalHours,
    calc_time: point.fundingTimeMs,
  }
  return buildNormalizedRow({
    eventTimeMs: point.fundingTimeMs,
    eventTime,
    symbol: point.symbol,
    endpointId: 'fundingRate',
    sourceEndpoint: '/fapi/v1/fundingRate',
    sourceTimestampBasis: 'data_vision_funding_calc_time_research_proxy',
    generatedAt,
    reportPath,
    manifest: point.manifest,
    fields,
  })
}

function buildBasisRows(input: {
  generatedAt: string
  reportPath: string | null
  fundingPoints: FundingPoint[]
  markRows: KlinePoint[]
  indexRows: KlinePoint[]
  premiumRows: KlinePoint[]
}): NormalizedDataVisionDerivativeRow[] {
  const markByKey = new Map(input.markRows.map(row => [klineKey(row), row]))
  const indexByKey = new Map(input.indexRows.map(row => [klineKey(row), row]))
  const fundingBySymbol = new Map<string, FundingPoint[]>()
  for (const point of input.fundingPoints) {
    const rows = fundingBySymbol.get(point.symbol) ?? []
    rows.push(point)
    fundingBySymbol.set(point.symbol, rows)
  }
  for (const rows of fundingBySymbol.values()) rows.sort((left, right) => left.fundingTimeMs - right.fundingTimeMs)

  return input.premiumRows
    .map(premium => {
      const mark = markByKey.get(klineKey(premium))
      const index = indexByKey.get(klineKey(premium))
      if (!mark || !index || index.close <= 0) return null
      const fundingRows = fundingBySymbol.get(premium.symbol) ?? []
      const latestFunding = latestAtOrBefore(fundingRows, premium.closeTimeMs)
      const nextFunding = firstAfter(fundingRows, premium.closeTimeMs)
      const fields = {
        symbol: premium.symbol,
        markPrice: mark.close,
        indexPrice: index.close,
        lastFundingRate: latestFunding?.fundingRate ?? null,
        nextFundingTime: nextFunding?.fundingTimeMs ?? null,
        time: premium.closeTimeMs,
        premiumIndexOpen: premium.open,
        premiumIndexHigh: premium.high,
        premiumIndexLow: premium.low,
        premiumIndexClose: premium.close,
      }
      return buildNormalizedRow({
        eventTimeMs: premium.closeTimeMs,
        eventTime: new Date(premium.closeTimeMs).toISOString(),
        symbol: premium.symbol,
        endpointId: 'premiumIndex',
        sourceEndpoint: '/fapi/v1/premiumIndex',
        sourceTimestampBasis: 'data_vision_premium_mark_index_kline_close_time_research_proxy',
        generatedAt: input.generatedAt,
        reportPath: input.reportPath,
        manifest: premium.manifest,
        fields,
      })
    })
    .filter((row): row is NormalizedDataVisionDerivativeRow => row != null)
}

function buildNormalizedRow(input: {
  eventTimeMs: number
  eventTime: string
  symbol: string
  endpointId: 'fundingRate' | 'premiumIndex'
  sourceEndpoint: '/fapi/v1/fundingRate' | '/fapi/v1/premiumIndex'
  sourceTimestampBasis: string
  generatedAt: string
  reportPath: string | null
  manifest: ArchiveManifestRecord
  fields: Record<string, number | string | null>
}): NormalizedDataVisionDerivativeRow {
  const availableAtMs = input.eventTimeMs + 1
  const availableAt = new Date(availableAtMs).toISOString()
  const rawPayloadHash = sha256Hex(JSON.stringify({
    sourcePath: input.manifest.sourcePath,
    symbol: input.symbol,
    eventTimeMs: input.eventTimeMs,
    fields: input.fields,
  }))
  return {
    schemaVersion: 'openalice.external_derivatives.normalized.v1',
    eventTime: input.eventTime,
    eventTimeMs: input.eventTimeMs,
    exchange: 'binance',
    market: 'usdm',
    symbol: input.symbol,
    endpointId: input.endpointId,
    sourceEndpoint: input.sourceEndpoint,
    sourceTimestamp: input.eventTime,
    sourceTimestampMs: input.eventTimeMs,
    sourceTimestampBasis: input.sourceTimestampBasis,
    fetchedAt: input.manifest.collectorObservedAt,
    observedAt: input.manifest.collectorObservedAt,
    availableAt,
    availableAtMs,
    availableAtBasis: 'derived_archive_event_available_time_research_proxy',
    archiveFileAvailableAt: input.manifest.archiveAvailableAt,
    ingestedAt: input.generatedAt,
    jobId: JOB_ID,
    generatedAt: input.generatedAt,
    lineageStatus: 'data_vision_archive_research_proxy',
    dedupKey: [
      'binance_data_vision_eth_carry',
      input.endpointId,
      input.symbol,
      String(input.eventTimeMs),
      input.manifest.sourcePath,
    ].join('|'),
    rawPayloadHash,
    collectionRunId: `${JOB_ID}:${input.manifest.collectionRunId}`,
    reportPath: input.reportPath,
    manifestPath: input.manifest.manifestPath,
    sourceUrl: input.manifest.sourceUrl,
    sourcePath: input.manifest.sourcePath,
    normalizedPayloadHash: sha256Hex(JSON.stringify(input.fields)),
    rowPITUsableForPromotion: false,
    pitSuitability: 'archive_event_time_research_proxy_not_promotion_grade',
    fields: input.fields,
  }
}

function parseCsv(csvText: string, fallbackHeader: string[]): UnknownRecord[] {
  const lines = csvText.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length === 0) return []
  const first = splitCsvLine(lines[0])
  const hasHeader = first.some(value => /[A-Za-z_]/.test(value))
  const header = hasHeader ? first : fallbackHeader
  const dataLines = hasHeader ? lines.slice(1) : lines
  return dataLines.map(line => {
    const cells = splitCsvLine(line)
    const out: UnknownRecord = {}
    for (let index = 0; index < header.length; index += 1) {
      out[header[index]] = cells[index] ?? null
    }
    return out
  })
}

function splitCsvLine(line: string): string[] {
  return line.split(',').map(cell => cell.trim())
}

function readZipCsvText(zipPath: string): string {
  return execFileSync('unzip', ['-p', zipPath], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

function klineKey(row: KlinePoint): string {
  return `${row.symbol}|${row.openTimeMs}`
}

function latestAtOrBefore(rows: FundingPoint[], timeMs: number): FundingPoint | null {
  let best: FundingPoint | null = null
  for (const row of rows) {
    if (row.fundingTimeMs > timeMs) break
    best = row
  }
  return best
}

function firstAfter(rows: FundingPoint[], timeMs: number): FundingPoint | null {
  return rows.find(row => row.fundingTimeMs > timeMs) ?? null
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

function parseNullablePath(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' ? null : resolve(value)
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function readDataType(value: unknown): DataType | null {
  return value === 'fundingRate' ||
    value === 'markPriceKlines' ||
    value === 'indexPriceKlines' ||
    value === 'premiumIndexKlines'
    ? value
    : null
}

function asRecord(value: unknown): UnknownRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort()
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim() !== ''))]
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function renderConsoleSummary(report: MaterializeEthCarryDataVisionDerivativesReport): string {
  return [
    `eth carry Data Vision derivatives materialize: status=${report.status}`,
    `archives=${report.counts.archiveZipFiles} rows=${report.counts.normalizedRows} funding=${report.counts.normalizedFundingRows} basis=${report.counts.normalizedBasisRows}`,
    `rowPITUsableForPromotion=${report.counts.rowsPITUsableForPromotion} paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `blockers=${report.blockers.join(',')}` : 'blockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('materialize_eth_carry_data_vision_derivatives failed:', error)
    process.exitCode = 1
  })
}
