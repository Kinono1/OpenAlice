import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type RegistryStatus = 'complete' | 'partial' | 'missing' | 'failed'
type BinanceMarket = 'spot' | 'um'

interface CliArgs {
  warehouseRoot: string
  binanceRoot: string
  registryPath: string
  outputPath: string | null
  json: boolean
}

interface BinanceManifestRow {
  market?: string
  dataType?: string
  symbol?: string
  month?: string
  key?: string
  url?: string
  status?: string
}

interface AssetDraft {
  exchange: 'binance'
  market: BinanceMarket
  symbol: string
  baseAsset: string
  quoteAsset: string | null
  dataTypes: Set<string>
  timeframes: Set<string>
  datasetIds: Set<string>
  firstDataMonth: string | null
  lastDataMonth: string | null
  sourceUrls: Set<string>
  manifestStatuses: Set<string>
}

export interface OpenAliceAssetMetadataEntry {
  assetId: string
  exchange: 'binance'
  market: BinanceMarket
  instrumentType: 'spot' | 'usdm_futures'
  symbol: string
  baseAsset: string
  quoteAsset: string | null
  exchangeSymbol: string
  canonicalSymbol: string
  marketType: 'spot' | 'perpetual_futures'
  firstDataMonth: string | null
  lastDataMonth: string | null
  listingDate: string | null
  listingDatePrecision: 'month_from_data_vision_manifest' | 'unknown'
  delistingDate: string | null
  delistingDatePrecision: 'unknown'
  contractAddress: string | null
  contractAddressStatus: 'unknown_not_onchain_resolved'
  decimals: number | null
  decimalsStatus: 'unknown_not_onchain_resolved'
  timestampPrecisionPolicy: string
  dataTypes: string[]
  timeframes: string[]
  datasetIds: string[]
  sourceUrls: string[]
  provenanceStatus: 'manifest_derived_partial'
  blockers: string[]
}

export interface OpenAliceAssetMetadataRegistry {
  schemaVersion: 1
  generatedAt: string
  status: RegistryStatus
  statusReason: string
  source: {
    name: 'binance_data_vision_manifest'
    binanceRoot: string
    manifestFilesRead: number
    manifestRowsRead: number
    manifestRowsParsed: number
    manifestRowsSkipped: number
    manifestDigest: string | null
  }
  summary: {
    assets: number
    spotAssets: number
    usdmAssets: number
    missingContractAddresses: number
    missingDecimals: number
    earliestObservedMonth: string | null
    latestObservedMonth: string | null
  }
  entries: OpenAliceAssetMetadataEntry[]
  blockers: string[]
  nextActions: string[]
  notes: string[]
}

export interface OpenAliceAssetMetadataRegistryReport {
  schemaVersion: 1
  generatedAt: string
  status: RegistryStatus
  registryPath: string
  warehouseRoot: string
  binanceRoot: string
  summary: OpenAliceAssetMetadataRegistry['summary'] & {
    manifestFilesRead: number
    manifestRowsRead: number
    manifestRowsParsed: number
    manifestRowsSkipped: number
  }
  blockers: string[]
  nextActions: string[]
  registryManifestPath: string | null
  notes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/openalice_asset_metadata_registry.latest.json'
const QUOTE_ASSETS = [
  'USDT',
  'FDUSD',
  'USDC',
  'TUSD',
  'BUSD',
  'BTC',
  'ETH',
  'BNB',
  'TRY',
  'EUR',
  'BRL',
  'AUD',
  'GBP',
]

export function parseOpenAliceAssetMetadataRegistryArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const warehouseRoot = resolve(
    raw.get('warehouseRoot') ??
    raw.get('dataRoot') ??
    process.env.OPENALICE_DATA_ROOT ??
    '/Volumes/shield/cryptoData/openalice-data',
  )
  return {
    warehouseRoot,
    binanceRoot: resolve(raw.get('binanceRoot') ?? resolve(warehouseRoot, 'market/binance-public')),
    registryPath: resolve(
      raw.get('registryPath') ??
      raw.get('registry') ??
      resolve(warehouseRoot, 'metadata/assets/openalice_asset_registry.latest.json'),
    ),
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runOpenAliceAssetMetadataRegistry(
  args: CliArgs,
): Promise<OpenAliceAssetMetadataRegistryReport> {
  const startedAt = new Date()
  const registry = await buildOpenAliceAssetMetadataRegistry({
    binanceRoot: args.binanceRoot,
  })
  await mkdir(dirname(args.registryPath), { recursive: true })
  await writeFile(args.registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8')
  const registryManifest = await writeEvidenceManifestForArtifact({
    job: 'openalice_asset_metadata_registry_warehouse',
    artifactPath: args.registryPath,
    startedAt,
    finishedAt: new Date(),
    exitCode: 0,
    businessStatus: registry.status === 'complete' ? 'pass' : 'warn',
    recordsIn: registry.source.manifestRowsParsed,
    recordsOut: registry.entries.length,
    errorClass: registry.blockers[0] ?? null,
  })
  const report = buildRegistryReport({
    registry,
    registryPath: args.registryPath,
    warehouseRoot: args.warehouseRoot,
    binanceRoot: args.binanceRoot,
    registryManifestPath: registryManifest.manifestPath,
    generatedAt: new Date().toISOString(),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'openalice_asset_metadata_registry_report',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'complete' ? 'pass' : 'warn',
      recordsIn: registry.source.manifestRowsParsed,
      recordsOut: registry.entries.length,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export async function buildOpenAliceAssetMetadataRegistry(input: {
  binanceRoot: string
  generatedAt?: string
}): Promise<OpenAliceAssetMetadataRegistry> {
  const binanceRoot = resolve(input.binanceRoot)
  const manifestFiles = await listBinanceDatasetManifestFiles(binanceRoot)
  const drafts = new Map<string, AssetDraft>()
  const digest = createHash('sha256')
  let rowsRead = 0
  let rowsParsed = 0
  let rowsSkipped = 0

  for (const manifestFile of manifestFiles) {
    const rl = createInterface({
      input: createReadStream(manifestFile),
      crlfDelay: Number.POSITIVE_INFINITY,
    })
    for await (const line of rl) {
      if (!line.trim()) continue
      rowsRead += 1
      digest.update(line).update('\n')
      let row: BinanceManifestRow
      try {
        row = JSON.parse(line) as BinanceManifestRow
      } catch {
        rowsSkipped += 1
        continue
      }
      const market = normalizeBinanceMarket(row.market)
      const symbol = typeof row.symbol === 'string' ? row.symbol.trim().toUpperCase() : null
      if (!market || !symbol) {
        rowsSkipped += 1
        continue
      }
      rowsParsed += 1
      const key = `binance:${market}:${symbol}`
      const parsedSymbol = parseSymbol(symbol)
      const draft = drafts.get(key) ?? {
        exchange: 'binance',
        market,
        symbol,
        baseAsset: parsedSymbol.baseAsset,
        quoteAsset: parsedSymbol.quoteAsset,
        dataTypes: new Set<string>(),
        timeframes: new Set<string>(),
        datasetIds: new Set<string>(),
        firstDataMonth: null,
        lastDataMonth: null,
        sourceUrls: new Set<string>(),
        manifestStatuses: new Set<string>(),
      }
      if (row.dataType) draft.dataTypes.add(row.dataType)
      const timeframe = parseTimeframeFromKey(row.key)
      if (timeframe) draft.timeframes.add(timeframe)
      draft.datasetIds.add(datasetIdForManifestFile(manifestFile))
      if (row.month) {
        draft.firstDataMonth = minMonth(draft.firstDataMonth, row.month)
        draft.lastDataMonth = maxMonth(draft.lastDataMonth, row.month)
      }
      if (row.url) draft.sourceUrls.add(row.url)
      if (row.status) draft.manifestStatuses.add(row.status)
      drafts.set(key, draft)
    }
  }

  const entries = [...drafts.values()]
    .map(draftToEntry)
    .sort((left, right) => left.assetId.localeCompare(right.assetId))
  const missingContractAddresses = entries.filter(entry => entry.contractAddress == null).length
  const missingDecimals = entries.filter(entry => entry.decimals == null).length
  const blockers = buildBlockers({
    manifestFilesRead: manifestFiles.length,
    entries,
    missingContractAddresses,
    missingDecimals,
  })
  const status: RegistryStatus = blockers.length === 0 ? 'complete' : entries.length > 0 ? 'partial' : 'missing'

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    status,
    statusReason: status === 'complete'
      ? 'all required asset metadata fields are resolved'
      : entries.length > 0
        ? 'registry is manifest-derived and still lacks chain contract metadata'
        : 'no asset metadata could be derived from local manifests',
    source: {
      name: 'binance_data_vision_manifest',
      binanceRoot,
      manifestFilesRead: manifestFiles.length,
      manifestRowsRead: rowsRead,
      manifestRowsParsed: rowsParsed,
      manifestRowsSkipped: rowsSkipped,
      manifestDigest: rowsRead > 0 ? digest.digest('hex') : null,
    },
    summary: {
      assets: entries.length,
      spotAssets: entries.filter(entry => entry.market === 'spot').length,
      usdmAssets: entries.filter(entry => entry.market === 'um').length,
      missingContractAddresses,
      missingDecimals,
      earliestObservedMonth: minNonNull(entries.map(entry => entry.firstDataMonth)),
      latestObservedMonth: maxNonNull(entries.map(entry => entry.lastDataMonth)),
    },
    entries,
    blockers,
    nextActions: buildNextActions(blockers),
    notes: [
      'This registry is derived from local Binance Data Vision manifest rows and is safe to rebuild from disk.',
      'Listing dates are month-level first-observed data months, not exchange listing announcements.',
      'Contract address and decimals are intentionally unknown until an on-chain or metadata source is connected.',
    ],
  }
}

function buildRegistryReport(input: {
  registry: OpenAliceAssetMetadataRegistry
  registryPath: string
  warehouseRoot: string
  binanceRoot: string
  registryManifestPath: string | null
  generatedAt: string
}): OpenAliceAssetMetadataRegistryReport {
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    status: input.registry.status,
    registryPath: resolve(input.registryPath),
    warehouseRoot: resolve(input.warehouseRoot),
    binanceRoot: resolve(input.binanceRoot),
    summary: {
      ...input.registry.summary,
      manifestFilesRead: input.registry.source.manifestFilesRead,
      manifestRowsRead: input.registry.source.manifestRowsRead,
      manifestRowsParsed: input.registry.source.manifestRowsParsed,
      manifestRowsSkipped: input.registry.source.manifestRowsSkipped,
    },
    blockers: input.registry.blockers,
    nextActions: input.registry.nextActions,
    registryManifestPath: input.registryManifestPath,
    notes: input.registry.notes,
  }
}

function draftToEntry(draft: AssetDraft): OpenAliceAssetMetadataEntry {
  const listingDate = draft.firstDataMonth ? `${draft.firstDataMonth}-01` : null
  return {
    assetId: `binance:${draft.market}:${draft.symbol}`,
    exchange: 'binance',
    market: draft.market,
    instrumentType: draft.market === 'spot' ? 'spot' : 'usdm_futures',
    symbol: draft.symbol,
    baseAsset: draft.baseAsset,
    quoteAsset: draft.quoteAsset,
    exchangeSymbol: draft.symbol,
    canonicalSymbol: draft.quoteAsset ? `${draft.baseAsset}/${draft.quoteAsset}` : draft.symbol,
    marketType: draft.market === 'spot' ? 'spot' : 'perpetual_futures',
    firstDataMonth: draft.firstDataMonth,
    lastDataMonth: draft.lastDataMonth,
    listingDate,
    listingDatePrecision: listingDate ? 'month_from_data_vision_manifest' : 'unknown',
    delistingDate: null,
    delistingDatePrecision: 'unknown',
    contractAddress: null,
    contractAddressStatus: 'unknown_not_onchain_resolved',
    decimals: null,
    decimalsStatus: 'unknown_not_onchain_resolved',
    timestampPrecisionPolicy: draft.market === 'spot'
      ? 'spot_data_vision_timestamp_precision_requires_parser_guard_for_2025_microsecond_transition'
      : 'usdm_data_vision_timestamp_precision_parser_guard_required',
    dataTypes: [...draft.dataTypes].sort(),
    timeframes: [...draft.timeframes].sort(sortTimeframes),
    datasetIds: [...draft.datasetIds].sort(),
    sourceUrls: [...draft.sourceUrls].sort().slice(0, 5),
    provenanceStatus: 'manifest_derived_partial',
    blockers: [
      'contract_address_unknown',
      'decimals_unknown',
      'listing_date_is_first_data_month_not_exchange_announcement',
    ],
  }
}

async function listBinanceDatasetManifestFiles(binanceRoot: string): Promise<string[]> {
  if (!(await pathExists(binanceRoot))) return []
  const entries = await readdir(binanceRoot, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifestPath = resolve(binanceRoot, entry.name, 'manifest.fast-binance-download.jsonl')
    if (existsSync(manifestPath)) files.push(manifestPath)
  }
  return files.sort()
}

function datasetIdForManifestFile(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 2] ?? path
}

function normalizeBinanceMarket(value: unknown): BinanceMarket | null {
  if (value === 'spot' || value === 'um') return value
  return null
}

function parseSymbol(symbol: string): { baseAsset: string; quoteAsset: string | null } {
  const quoteAsset = QUOTE_ASSETS.find(quote => symbol.endsWith(quote)) ?? null
  if (!quoteAsset) return { baseAsset: symbol, quoteAsset: null }
  return {
    baseAsset: symbol.slice(0, -quoteAsset.length),
    quoteAsset,
  }
}

function parseTimeframeFromKey(key: unknown): string | null {
  if (typeof key !== 'string') return null
  const parts = key.split('/')
  const zipName = parts[parts.length - 1] ?? ''
  if (!zipName.endsWith('.zip')) return null
  if (parts.length >= 2 && /^[0-9]+[smhdw]$|^[0-9]+mo$/.test(parts[parts.length - 2] ?? '')) {
    return parts[parts.length - 2] ?? null
  }
  const match = zipName.match(/^[A-Z0-9]+-([0-9]+(?:s|m|h|d|w|mo))-/)
  return match?.[1] ?? null
}

function minMonth(left: string | null, right: string): string {
  return left == null || right < left ? right : left
}

function maxMonth(left: string | null, right: string): string {
  return left == null || right > left ? right : left
}

function minNonNull(values: Array<string | null>): string | null {
  return values.filter((value): value is string => value != null).sort()[0] ?? null
}

function maxNonNull(values: Array<string | null>): string | null {
  return values.filter((value): value is string => value != null).sort().at(-1) ?? null
}

function buildBlockers(input: {
  manifestFilesRead: number
  entries: OpenAliceAssetMetadataEntry[]
  missingContractAddresses: number
  missingDecimals: number
}): string[] {
  const blockers: string[] = []
  if (input.manifestFilesRead === 0) blockers.push('binance_manifest_files_missing')
  if (input.entries.length === 0) blockers.push('asset_registry_empty')
  if (input.missingContractAddresses > 0) {
    blockers.push(`contract_address_unknown:${input.missingContractAddresses}`)
  }
  if (input.missingDecimals > 0) blockers.push(`decimals_unknown:${input.missingDecimals}`)
  if (input.entries.some(entry => entry.listingDatePrecision !== 'month_from_data_vision_manifest')) {
    blockers.push('listing_date_precision_unknown')
  }
  return blockers
}

function buildNextActions(blockers: string[]): string[] {
  const actions: string[] = []
  if (blockers.some(blocker => blocker.startsWith('contract_address_unknown'))) {
    actions.push('Join CoinGecko, CoinMarketCap, DefiLlama, or chain-specific token lists for contract addresses.')
  }
  if (blockers.some(blocker => blocker.startsWith('decimals_unknown'))) {
    actions.push('Resolve decimals from token contract metadata or vetted asset metadata providers.')
  }
  if (blockers.includes('binance_manifest_files_missing')) {
    actions.push('Run Binance Data Vision downloads before rebuilding the asset metadata registry.')
  }
  if (actions.length === 0) actions.push('Keep registry refreshed when new Binance datasets are downloaded.')
  return actions
}

function sortTimeframes(left: string, right: string): number {
  return timeframeRank(left) - timeframeRank(right) || left.localeCompare(right)
}

function timeframeRank(value: string): number {
  const match = value.match(/^(\d+)(s|m|h|d|w|mo)$/)
  if (!match) return Number.MAX_SAFE_INTEGER
  const amount = Number(match[1])
  const unit = match[2]
  const multiplier = unit === 's'
    ? 1
    : unit === 'm'
      ? 60
      : unit === 'h'
        ? 3600
        : unit === 'd'
          ? 86400
          : unit === 'w'
            ? 604800
            : 2592000
  return amount * multiplier
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [key, inlineValue] = token.slice(2).split('=', 2)
    if (inlineValue !== undefined) {
      out.set(key, inlineValue)
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(key, next)
      index += 1
    } else {
      out.set(key, 'true')
    }
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (value == null) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' || normalized === 'false' ? null : value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.trim().toLowerCase())
}

export function renderOpenAliceAssetMetadataRegistryMarkdown(
  report: OpenAliceAssetMetadataRegistryReport,
): string {
  const lines: string[] = []
  lines.push('# OpenAlice Asset Metadata Registry')
  lines.push('')
  lines.push(`Generated: \`${report.generatedAt}\``)
  lines.push(`Status: \`${report.status}\``)
  lines.push(`Registry: \`${report.registryPath}\``)
  lines.push(`Assets: ${report.summary.assets} spot=${report.summary.spotAssets} usdm=${report.summary.usdmAssets}`)
  lines.push(`Observed months: ${report.summary.earliestObservedMonth ?? 'unknown'} -> ${report.summary.latestObservedMonth ?? 'unknown'}`)
  lines.push(`Missing contract addresses: ${report.summary.missingContractAddresses}`)
  lines.push(`Missing decimals: ${report.summary.missingDecimals}`)
  lines.push('')
  if (report.blockers.length > 0) {
    lines.push('## Blockers')
    lines.push('')
    for (const blocker of report.blockers) lines.push(`- \`${blocker}\``)
    lines.push('')
  }
  lines.push('## Next Actions')
  lines.push('')
  for (const action of report.nextActions) lines.push(`- ${action}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseOpenAliceAssetMetadataRegistryArgs(argv)
  const report = await runOpenAliceAssetMetadataRegistry(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderOpenAliceAssetMetadataRegistryMarkdown(report))
  if (report.status === 'failed') process.exitCode = 2
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_openalice_asset_metadata_registry failed:', error)
    process.exit(1)
  })
}
