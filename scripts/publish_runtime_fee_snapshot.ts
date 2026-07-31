import ccxt from 'ccxt'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import type { FeeSnapshot } from '../src/runtime/promotion_v2.js'

const DEFAULT_FEE_SNAPSHOT_PATH = 'data/runtime/fee_snapshot.latest.json'
const DEFAULT_STATUS_PATH = 'data/runtime/fee_snapshot_refresh.latest.json'
const DEFAULT_SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT']
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_TTL_HOURS = 24
const SIDE_EFFECT_POLICY = 'read_only_private_fee_fetch_local_artifact_write'
const DEFAULT_OKX_PRODUCTION_HOSTS = ['www.okx.com', 'aws.okx.com', 'eea.okx.com', 'us.okx.com']

export interface RuntimeFeeSnapshotArgs {
  exchange: string
  marketType: string
  symbols: string[]
  symbolScope: string
  instrumentType: string
  accountTier: string | null
  outputPath: string | null
  statusPath: string | null
  ttlHours: number
  timeoutMs: number
  proxyUrl: string | null
  sandbox: boolean
  demoTrading: boolean
  okxHosts: string[]
  apiKeyEnv: string
  secretEnv: string
  passwordEnv: string
  envPath: string | null
  dryRun: boolean
  json: boolean
}

export interface RuntimeFeeRow {
  symbol: string
  makerFeeBps: number
  takerFeeBps: number
  sourceFetchedAt: string
  rawSource: 'fetchTradingFee' | 'fetchTradingFees'
}

export interface RuntimeFeeError {
  symbol: string
  errorClass: string
  message: string
}

export interface RuntimeFeeSnapshotReport {
  schemaVersion: 1
  generatedAt: string
  status: 'runtime_verified' | 'blocked'
  sideEffectPolicy: typeof SIDE_EFFECT_POLICY
  dryRun: boolean
  exchange: string
  marketType: string
  proxyConfigured: boolean
  sandbox: boolean
  demoTrading: boolean
  symbols: string[]
  symbolScope: string
  outputPath: string | null
  statusPath: string | null
  snapshotWritten: boolean
  statusWritten: boolean
  promotionAllowedByThisArtifact: false
  paperTradingAllowedByThisArtifact: false
  liveTradingAllowedByThisArtifact: false
  feeSnapshot: FeeSnapshot | null
  perSymbolFees: RuntimeFeeRow[]
  errors: RuntimeFeeError[]
  blockers: string[]
  nextActions: string[]
  notes: string[]
}

export interface RuntimeFeeFetchResult {
  rows: RuntimeFeeRow[]
  errors: RuntimeFeeError[]
  blockers: string[]
}

export type RuntimeFeeFetcher = (args: RuntimeFeeSnapshotArgs) => Promise<RuntimeFeeFetchResult>

export interface CcxtExchangeLike {
  hostname?: string
  options?: Record<string, unknown>
  has?: Record<string, unknown>
  loadMarkets: (reload?: boolean) => Promise<unknown>
  fetchTradingFee?: (symbol: string) => Promise<unknown>
  fetchTradingFees?: (symbols?: string[]) => Promise<unknown>
  setSandboxMode?: (enabled: boolean) => void
  enableDemoTrading?: (enabled: boolean) => void
  close?: () => Promise<void>
}

type CcxtExchangeConstructor = new (options: Record<string, unknown>) => CcxtExchangeLike

export function parseRuntimeFeeSnapshotArgs(argv: string[]): RuntimeFeeSnapshotArgs {
  const raw = parseRawArgs(argv)
  return {
    exchange: raw.get('exchange') ?? process.env.OPENALICE_FEE_SNAPSHOT_EXCHANGE ?? 'okx',
    marketType: raw.get('marketType') ?? raw.get('defaultType') ?? 'swap',
    symbols: parseCsv(raw.get('symbols')).length > 0 ? parseCsv(raw.get('symbols')) : DEFAULT_SYMBOLS,
    symbolScope: raw.get('symbolScope') ?? 'cross_sectional_universe',
    instrumentType: raw.get('instrumentType') ?? 'crypto_perpetual',
    accountTier: normalizeNullableString(raw.get('accountTier')),
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_FEE_SNAPSHOT_PATH),
    statusPath: parseNullablePath(raw.get('statusPath') ?? DEFAULT_STATUS_PATH),
    ttlHours: parsePositiveNumber(raw.get('ttlHours'), DEFAULT_TTL_HOURS),
    timeoutMs: parsePositiveNumber(raw.get('timeoutMs'), DEFAULT_TIMEOUT_MS),
    proxyUrl: normalizeNullableString(raw.get('proxyUrl') ?? process.env.OPENALICE_FEE_SNAPSHOT_PROXY_URL ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY),
    sandbox: parseBool(raw.get('sandbox') ?? process.env.OPENALICE_FEE_SNAPSHOT_SANDBOX, false),
    demoTrading: parseBool(raw.get('demoTrading') ?? process.env.OPENALICE_FEE_SNAPSHOT_DEMO_TRADING, false),
    okxHosts: parseOkxHosts(raw.get('okxHosts') ?? raw.get('okxHost') ?? process.env.OPENALICE_OKX_API_HOSTS ?? process.env.OPENALICE_OKX_API_HOST),
    apiKeyEnv: raw.get('apiKeyEnv') ?? 'EXCHANGE_API_KEY',
    secretEnv: raw.get('secretEnv') ?? 'EXCHANGE_API_SECRET',
    passwordEnv: raw.get('passwordEnv') ?? 'EXCHANGE_PASSWORD',
    envPath: parseNullablePath(raw.get('envPath') ?? '.env'),
    dryRun: parseBool(raw.get('dryRun'), false),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runRuntimeFeeSnapshotPublish(
  args: RuntimeFeeSnapshotArgs,
  fetcher: RuntimeFeeFetcher = fetchRuntimeFeeRowsFromCcxt,
): Promise<RuntimeFeeSnapshotReport> {
  const startedAt = new Date()
  const fetched = await fetcher(args)
  const report = buildRuntimeFeeSnapshotReport({
    args,
    generatedAt: new Date().toISOString(),
    rows: fetched.rows,
    errors: fetched.errors,
    blockers: fetched.blockers,
  })

  if (!args.dryRun && report.feeSnapshot && args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report.feeSnapshot, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'runtime_fee_snapshot_publish',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: 'pass',
      recordsIn: report.perSymbolFees.length,
      recordsOut: 1,
    })
    report.snapshotWritten = true
  }

  if (!args.dryRun && args.statusPath) {
    const statusPath = resolve(args.statusPath)
    await mkdir(dirname(statusPath), { recursive: true })
    const statusReport = { ...report, statusWritten: true }
    await writeFile(statusPath, `${JSON.stringify(statusReport, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'runtime_fee_snapshot_refresh_status',
      artifactPath: statusPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: report.status === 'runtime_verified' ? 0 : 1,
      businessStatus: report.status === 'runtime_verified' ? 'pass' : 'fail',
      recordsIn: args.symbols.length,
      recordsOut: report.perSymbolFees.length,
      errorClass: report.blockers[0] ?? null,
    })
    report.statusWritten = true
  }

  return report
}

export function buildRuntimeFeeSnapshotReport(input: {
  args: RuntimeFeeSnapshotArgs
  generatedAt: string
  rows: RuntimeFeeRow[]
  errors?: RuntimeFeeError[]
  blockers?: string[]
}): RuntimeFeeSnapshotReport {
  const rowBySymbol = new Map(input.rows.map(row => [row.symbol, row]))
  const blockers = [...(input.blockers ?? [])]
  const missingSymbols = input.args.symbols.filter(symbol => !rowBySymbol.has(symbol))
  if (input.args.symbols.length === 0) blockers.push('fee_snapshot_symbols_missing')
  if (missingSymbols.length > 0) {
    blockers.push(`fee_snapshot_missing_symbol_rows:${missingSymbols.join(',')}`)
  }

  const invalidRows = input.rows.filter(row =>
    !isValidFeeBps(row.makerFeeBps) ||
    !isValidFeeBps(row.takerFeeBps) ||
    row.takerFeeBps < row.makerFeeBps
  )
  for (const row of invalidRows) {
    blockers.push(`fee_snapshot_invalid_fee_row:${row.symbol}`)
  }

  const usableRows = input.rows.filter(row =>
    input.args.symbols.includes(row.symbol) &&
    isValidFeeBps(row.makerFeeBps) &&
    isValidFeeBps(row.takerFeeBps) &&
    row.takerFeeBps >= row.makerFeeBps
  )
  const status: RuntimeFeeSnapshotReport['status'] =
    blockers.length === 0 && usableRows.length === input.args.symbols.length
      ? 'runtime_verified'
      : 'blocked'
  const expiresAt = new Date(Date.parse(input.generatedAt) + input.args.ttlHours * 3_600_000).toISOString()
  const feeSnapshot: FeeSnapshot | null = status === 'runtime_verified'
    ? {
        venue: input.args.exchange,
        symbol: input.args.symbolScope,
        instrumentType: input.args.instrumentType,
        accountTier: input.args.accountTier ??
          `runtime_api_max_fee:${input.args.exchange}:${input.args.marketType}:symbols=${usableRows.length}`,
        makerFeeBps: roundBps(Math.max(...usableRows.map(row => row.makerFeeBps))),
        takerFeeBps: roundBps(Math.max(...usableRows.map(row => row.takerFeeBps))),
        source: 'api',
        sourceFetchedAt: input.generatedAt,
        expiresAt,
        verifiedByRuntime: true,
        fundingIntervalHours: 8,
        fundingCapBps: 0,
        fundingFloorBps: 0,
      }
    : null

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    status,
    sideEffectPolicy: SIDE_EFFECT_POLICY,
    dryRun: input.args.dryRun,
    exchange: input.args.exchange,
    marketType: input.args.marketType,
    proxyConfigured: input.args.proxyUrl != null,
    sandbox: input.args.sandbox,
    demoTrading: input.args.demoTrading,
    symbols: input.args.symbols,
    symbolScope: input.args.symbolScope,
    outputPath: input.args.outputPath ? resolve(input.args.outputPath) : null,
    statusPath: input.args.statusPath ? resolve(input.args.statusPath) : null,
    snapshotWritten: false,
    statusWritten: false,
    promotionAllowedByThisArtifact: false,
    paperTradingAllowedByThisArtifact: false,
    liveTradingAllowedByThisArtifact: false,
    feeSnapshot,
    perSymbolFees: usableRows.map(row => ({
      ...row,
      makerFeeBps: roundBps(row.makerFeeBps),
      takerFeeBps: roundBps(row.takerFeeBps),
    })),
    errors: input.errors ?? [],
    blockers: dedupeStrings(blockers),
    nextActions: buildNextActions(status),
    notes: [
      'This script fetches private fee metadata only; it does not place orders, cancel orders, modify leverage, or authorize execution.',
      'The snapshot is promotion-v2 compatible only when status=runtime_verified and verifiedByRuntime=true.',
      'Per-symbol fees are collapsed conservatively by taking the maximum maker/taker bps across the requested universe sample.',
      'Paper/live execution remains controlled by release, P1 evidence, allocator, and promotion gates.',
    ],
  }
}

export async function fetchRuntimeFeeRowsFromCcxt(args: RuntimeFeeSnapshotArgs): Promise<RuntimeFeeFetchResult> {
  let exchange: CcxtExchangeLike | null = null
  try {
    const env = await readRuntimeEnv(args.envPath)
    const credentials = {
      apiKey: readCredential(env, args.apiKeyEnv),
      secret: readCredential(env, args.secretEnv),
      password: readCredential(env, args.passwordEnv),
    }
    const credentialBlockers = buildCredentialBlockers(args.exchange, args, credentials)
    if (credentialBlockers.length > 0) {
      return { rows: [], errors: [], blockers: credentialBlockers }
    }
    const verifiedCredentials = {
      apiKey: credentials.apiKey as string,
      secret: credentials.secret as string,
      password: credentials.password,
    }

    exchange = createCcxtExchange(args, verifiedCredentials)
    return await fetchRuntimeFeeRowsWithRuntimeFallback(exchange, args)
  } catch (error) {
    const errorClass = classifyError(error)
    return {
      rows: [],
      errors: [{
        symbol: '*',
        errorClass,
        message: redactRuntimeFeeErrorMessage(error instanceof Error ? error.message : String(error)),
      }],
      blockers: [`fee_snapshot_fetch_failed:${errorClass}`],
    }
  } finally {
    await exchange?.close?.().catch(() => undefined)
  }
}

export async function fetchRuntimeFeeRowsWithRuntimeFallback(
  exchange: CcxtExchangeLike,
  args: RuntimeFeeSnapshotArgs,
): Promise<RuntimeFeeFetchResult> {
  const hosts = okxProductionHostCandidates(exchange, args)
  if (hosts.length === 0) {
    await exchange.loadMarkets(true)
    return await fetchRuntimeFeeRowsFromExchange(exchange, args.symbols)
  }

  const host50119Results: RuntimeFeeFetchResult[] = []
  let lastLoadMarketsError: RuntimeFeeError | null = null
  for (const host of hosts) {
    try {
      exchange.hostname = host
      await exchange.loadMarkets(true)
      const result = await fetchRuntimeFeeRowsFromExchange(exchange, args.symbols)
      if (result.rows.length > 0 || !isOkxApiKeyDoesNotExistResult(result)) {
        return result
      }
      host50119Results.push(result)
    } catch (error) {
      lastLoadMarketsError = {
        symbol: '*',
        errorClass: classifyError(error),
        message: redactRuntimeFeeErrorMessage(error instanceof Error ? error.message : String(error)),
      }
      if (lastLoadMarketsError.errorClass !== 'timeout' && lastLoadMarketsError.errorClass !== 'network') {
        break
      }
    }
  }

  const fallbackResult = host50119Results.at(-1)
  if (fallbackResult) {
    return {
      rows: fallbackResult.rows,
      errors: fallbackResult.errors,
      blockers: dedupeStrings([
        ...fallbackResult.blockers,
        `fee_snapshot_okx_region_hosts_exhausted_50119:${hosts.join(',')}`,
      ]),
    }
  }
  if (lastLoadMarketsError) {
    return {
      rows: [],
      errors: [lastLoadMarketsError],
      blockers: [`fee_snapshot_fetch_failed:${lastLoadMarketsError.errorClass}`],
    }
  }
  return {
    rows: [],
    errors: [],
    blockers: ['fee_snapshot_no_okx_region_hosts_configured'],
  }
}

export async function fetchRuntimeFeeRowsFromExchange(
  exchange: CcxtExchangeLike,
  symbols: string[],
): Promise<RuntimeFeeFetchResult> {
  const rows: RuntimeFeeRow[] = []
  const errors: RuntimeFeeError[] = []
  const fetchedAt = new Date().toISOString()

  if (typeof exchange.fetchTradingFees === 'function') {
    try {
      const raw = await exchange.fetchTradingFees(symbols)
      const feesBySymbol = asRecord(raw)
      for (const symbol of symbols) {
        const parsed = parseCcxtFeeRow(symbol, feesBySymbol?.[symbol], fetchedAt, 'fetchTradingFees')
        if (parsed) rows.push(parsed)
      }
    } catch (error) {
      errors.push({
        symbol: '*',
        errorClass: classifyError(error),
        message: redactRuntimeFeeErrorMessage(error instanceof Error ? error.message : String(error)),
      })
    }
  }

  const missingSymbols = symbols.filter(symbol => !rows.some(row => row.symbol === symbol))
  if (missingSymbols.length > 0 && typeof exchange.fetchTradingFee === 'function') {
    for (const symbol of missingSymbols) {
      try {
        const raw = await exchange.fetchTradingFee(symbol)
        const parsed = parseCcxtFeeRow(symbol, raw, new Date().toISOString(), 'fetchTradingFee')
        if (parsed) rows.push(parsed)
      } catch (error) {
        errors.push({
          symbol,
          errorClass: classifyError(error),
          message: redactRuntimeFeeErrorMessage(error instanceof Error ? error.message : String(error)),
        })
      }
    }
  }

  const blockers: string[] = []
  const stillMissingSymbols = symbols.filter(symbol => !rows.some(row => row.symbol === symbol))
  if (typeof exchange.fetchTradingFee !== 'function' && typeof exchange.fetchTradingFees !== 'function') {
    blockers.push('fee_snapshot_exchange_fee_api_missing')
  }
  if (rows.length === 0) blockers.push('fee_snapshot_no_valid_fee_rows')
  const blockingErrorClasses = errors
    .filter(error => error.symbol === '*' ? stillMissingSymbols.length > 0 : stillMissingSymbols.includes(error.symbol))
    .map(error => `fee_snapshot_fetch_failed:${error.errorClass}`)
  blockers.push(...dedupeStrings(blockingErrorClasses))
  return { rows, errors, blockers }
}

export async function loadMarketsWithRuntimeFallback(
  exchange: CcxtExchangeLike,
  args: RuntimeFeeSnapshotArgs,
): Promise<string | null> {
  const hosts = okxProductionHostCandidates(exchange, args)
  if (hosts.length === 0) {
    await exchange.loadMarkets(true)
    return null
  }

  let lastError: unknown
  for (const host of hosts) {
    try {
      exchange.hostname = host
      await exchange.loadMarkets(true)
      return host
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('loadMarkets failed for all runtime fee hosts')
}

export function okxProductionHostCandidates(
  exchange: Pick<CcxtExchangeLike, 'hostname'>,
  args: Pick<RuntimeFeeSnapshotArgs, 'exchange' | 'sandbox' | 'demoTrading' | 'okxHosts'>,
): string[] {
  if (args.exchange.toLowerCase() !== 'okx' || args.sandbox || args.demoTrading) return []
  return dedupeStrings([
    ...args.okxHosts,
    normalizeOkxHost(exchange.hostname),
    ...DEFAULT_OKX_PRODUCTION_HOSTS,
  ].filter((value): value is string => Boolean(value)))
}

async function main(): Promise<void> {
  const args = parseRuntimeFeeSnapshotArgs(process.argv.slice(2))
  const report = await runRuntimeFeeSnapshotPublish(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }
}

export function createCcxtExchange(
  args: RuntimeFeeSnapshotArgs,
  credentials: { apiKey: string; secret: string; password: string | null },
): CcxtExchangeLike {
  const exchangeCtor = (ccxt as unknown as Record<string, unknown>)[args.exchange]
  if (typeof exchangeCtor !== 'function') {
    throw new Error(`unsupported ccxt exchange: ${args.exchange}`)
  }
  const ExchangeCtor = exchangeCtor as CcxtExchangeConstructor
  const fetchMarketType = ccxtMarketType(args.exchange, args.marketType)
  const exchange = new ExchangeCtor({
    enableRateLimit: true,
    timeout: args.timeoutMs,
    apiKey: credentials.apiKey,
    secret: credentials.secret,
    ...(credentials.password ? { password: credentials.password } : {}),
    ...(args.proxyUrl ? { httpsProxy: args.proxyUrl } : {}),
    options: {
      defaultType: args.marketType,
      fetchMarkets: { types: [fetchMarketType] },
    },
  }) as CcxtExchangeLike
  exchange.has = { ...(exchange.has ?? {}), fetchCurrencies: false }
  exchange.options = {
    ...(exchange.options ?? {}),
    defaultType: args.marketType,
    fetchMarkets: { types: [fetchMarketType] },
  }
  const useOkxSimulatedTradingHeader = args.exchange.toLowerCase() === 'okx' && args.demoTrading
  if (args.sandbox || useOkxSimulatedTradingHeader) {
    if (typeof exchange.setSandboxMode !== 'function') {
      throw new Error(`exchange ${args.exchange} does not support setSandboxMode`)
    }
    exchange.setSandboxMode(true)
  }
  if (args.demoTrading && !useOkxSimulatedTradingHeader) {
    if (typeof exchange.enableDemoTrading !== 'function') {
      throw new Error(`exchange ${args.exchange} does not support enableDemoTrading`)
    }
    exchange.enableDemoTrading(true)
  }
  return exchange
}

function ccxtMarketType(exchange: string, marketType: string): string {
  if (exchange.toLowerCase() === 'binance') {
    if (marketType === 'swap' || marketType === 'future' || marketType === 'linear') return 'linear'
    if (marketType === 'inverse' || marketType === 'delivery') return 'inverse'
  }
  if (marketType === 'swap' || marketType === 'future' || marketType === 'spot' || marketType === 'option') {
    return marketType
  }
  return 'swap'
}

function parseCcxtFeeRow(
  symbol: string,
  raw: unknown,
  fetchedAt: string,
  rawSource: RuntimeFeeRow['rawSource'],
): RuntimeFeeRow | null {
  const root = asRecord(raw)
  const makerRate = numberOrNull(root?.maker)
  const takerRate = numberOrNull(root?.taker)
  if (makerRate == null || takerRate == null) return null
  return {
    symbol,
    makerFeeBps: roundBps(makerRate * 10_000),
    takerFeeBps: roundBps(takerRate * 10_000),
    sourceFetchedAt: fetchedAt,
    rawSource,
  }
}

async function readRuntimeEnv(envPath: string | null): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...process.env } as Record<string, string>
  if (!envPath) return out
  const resolved = resolve(envPath)
  if (!existsSync(resolved)) return out
  await assertRestrictedEnvFile(resolved)
  const raw = await readFile(resolved, 'utf-8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (out[key]) continue
    out[key] = unquoteEnvValue(trimmed.slice(eq + 1).trim())
  }
  return out
}

async function assertRestrictedEnvFile(path: string): Promise<void> {
  const st = await stat(path)
  const mode = st.mode & 0o777
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : st.uid
  if (st.uid !== currentUid || (mode & 0o077) !== 0) {
    throw new Error(`env file must be owned by the current user and must not be group/other-accessible; run chmod 600 ${path}`)
  }
}

function buildCredentialBlockers(
  exchange: string,
  args: RuntimeFeeSnapshotArgs,
  credentials: { apiKey: string | null; secret: string | null; password: string | null },
): string[] {
  const blockers: string[] = []
  if (!credentials.apiKey) blockers.push(`fee_snapshot_credential_missing:${args.apiKeyEnv}`)
  if (!credentials.secret) blockers.push(`fee_snapshot_credential_missing:${args.secretEnv}`)
  if (exchange.toLowerCase() === 'okx' && !credentials.password) {
    blockers.push(`fee_snapshot_credential_missing:${args.passwordEnv}`)
  }
  return blockers
}

function readCredential(env: Record<string, string>, key: string): string | null {
  const value = env[key]?.trim()
  return value ? value : null
}

function renderConsoleSummary(report: RuntimeFeeSnapshotReport): string {
  const fee = report.feeSnapshot
  const feeText = fee
    ? `maker=${fee.makerFeeBps}bps taker=${fee.takerFeeBps}bps source=${fee.source} verified=${fee.verifiedByRuntime}`
    : 'no_verified_snapshot'
  return [
    `runtime fee snapshot: status=${report.status} exchange=${report.exchange} symbols=${report.symbols.length}`,
    `fee: ${feeText}`,
    `snapshotWritten=${report.snapshotWritten} statusWritten=${report.statusWritten}`,
    `blockers=${report.blockers.length > 0 ? report.blockers.join('|') : 'none'}`,
  ].join('\n')
}

function buildNextActions(status: RuntimeFeeSnapshotReport['status']): string[] {
  if (status === 'runtime_verified') {
    return [
      'Republish promotion:v2 so route_cost_budget.latest.json embeds this verified fee snapshot.',
      'Refresh P1 evidence and RankIC route-cost validation so stale/manual fee blockers are removed where applicable.',
      'Keep paper/live disabled until all independent release, P1, allocator, and promotion gates pass.',
    ]
  }
  return [
    'Provide valid read-only exchange API credentials or choose an exchange account that supports fee metadata via ccxt fetchTradingFee(s).',
    'Do not republish route-cost or promotion artifacts as runtime-verified until feeSnapshot.status=runtime_verified.',
    'Keep manual fee snapshots blocked for paper/live promotion paths.',
  ]
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

function parseCsv(raw: string | undefined): string[] {
  return raw?.split(',').map(item => item.trim()).filter(Boolean) ?? []
}

function parseOkxHosts(raw: string | undefined): string[] {
  return raw
    ?.split(/[,\s]+/)
    .map(normalizeOkxHost)
    .filter((value): value is string => Boolean(value)) ?? []
}

function normalizeOkxHost(raw: string | undefined): string | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null
  const withoutScheme = trimmed.replace(/^https?:\/\//i, '')
  const host = withoutScheme.split('/')[0]?.trim().toLowerCase()
  if (!host) return null
  return host
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseNullablePath(raw: string | undefined): string | null {
  if (raw == null) return null
  const normalized = raw.trim().toLowerCase()
  return normalized === '' || normalized === 'null' || normalized === 'none' ? null : raw
}

function normalizeNullableString(raw: string | undefined): string | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  return trimmed.length > 0 && !['null', 'none'].includes(trimmed.toLowerCase()) ? trimmed : null
}

function unquoteEnvValue(raw: string): string {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1)
  }
  return raw
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isValidFeeBps(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1_000
}

function roundBps(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

export function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return 'timeout'
  if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(message)) return 'dns'
  if (/ECONNREFUSED|EHOSTDOWN|network|fetch failed/i.test(message)) return 'network'
  if (/authentication|permission|api[- ]?key|signature|unauthorized|forbidden|invalid key|code\":-2014|401|403/i.test(message)) return 'auth'
  if (/not supported|undefined is not a function/i.test(message)) return 'api_not_supported'
  if (/env file|group\/other-accessible|chmod 600/i.test(message)) return 'env_file_permission'
  return 'exchange_or_unknown'
}

function isOkxApiKeyDoesNotExistResult(result: RuntimeFeeFetchResult): boolean {
  return result.rows.length === 0 && result.errors.some(error => /50119|doesn'?t exist/i.test(error.message))
}

export function redactRuntimeFeeErrorMessage(value: string): string {
  let out = value
  out = out.replace(/(api[-_ ]?key|secret|password|passphrase)[^,}\s]*/gi, '$1:[redacted]')
  out = out.replace(/[A-Za-z0-9_-]{24,}/g, '[redacted-token]')
  return out
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(redactRuntimeFeeErrorMessage(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  })
}
