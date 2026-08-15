import { createHmac, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import {
  classifyError,
  createCcxtExchange,
  fetchRuntimeFeeRowsFromCcxt,
  okxProductionHostCandidates,
  parseRuntimeFeeSnapshotArgs,
  redactRuntimeFeeErrorMessage,
  type CcxtExchangeLike,
  type RuntimeFeeError,
  type RuntimeFeeSnapshotArgs,
} from './publish_runtime_fee_snapshot.js'

type ProbeMode = 'production' | 'demoTrading' | 'sandbox'
type ProbeStatus = 'auth_ok' | 'auth_failed' | 'credential_missing' | 'api_not_supported' | 'unknown_failed'
type AuthCheckStatus = 'auth_ok' | 'auth_failed' | 'credential_missing' | 'unknown_failed'
type ChecklistStatus = 'passed_local_check' | 'needs_user_check' | 'blocked' | 'not_applicable'

export interface DirectOkxRestAuthAttempt {
  host: string
  status: AuthCheckStatus
  code: string | null
  message: string | null
  errorClass: string | null
}

interface CliArgs {
  outputPath: string | null
  envPath: string | null
  exchange: string
  marketType: string
  symbol: string
  timeoutMs: number
  proxyUrl: string | null
  okxHosts: string[]
  apiKeyEnv: string
  secretEnv: string
  passwordEnv: string
  json: boolean
}

export interface OkxPrivateAuthProbe {
  mode: ProbeMode
  sandbox: boolean
  demoTrading: boolean
  status: ProbeStatus
  directRestStatus: AuthCheckStatus
  directRestHost: string | null
  directRestCode: string | null
  directRestMessage: string | null
  directRestErrorClass: string | null
  directRestAttempts: DirectOkxRestAuthAttempt[]
  authCheckStatus: AuthCheckStatus
  authCheckHost: string | null
  authCheckErrorClass: string | null
  authCheckRedactedError: string | null
  privateFeeStatus: ProbeStatus
  checkedSymbol: string
  rowsFetched: number
  blockers: string[]
  errorClasses: string[]
  redactedErrors: RuntimeFeeError[]
  notes: string[]
}

export interface OkxPrivateAuthChecklistItem {
  id: string
  status: ChecklistStatus
  evidence: string[]
  action: string
}

export interface OkxPrivateAuthEnvFileDiagnostic {
  label: string
  path: string
  selectedForDiagnosis: boolean
  exists: boolean
  readable: boolean
  restricted: boolean | null
  ownerCurrentUser: boolean | null
  mode: string | null
  credentialPresence: {
    apiKey: boolean
    secret: boolean
    password: boolean
  }
  credentialFingerprints: {
    apiKey: string | null
    secret: string | null
    password: string | null
  }
  blockers: string[]
  notes: string[]
}

export interface OkxPrivateAuthNetworkDiagnostic {
  source: string
  status: 'available' | 'unavailable'
  checkedAt: string
  publicEgressIp: string | null
  proxyConfigured: boolean
  timeoutMs: number
  errorClass: string | null
  redactedError: string | null
  notes: string[]
}

export interface OkxPrivateAuthRegionalDomainDiagnostic {
  officialSource: string
  hostsTried: string[]
  hostsReturning50119: string[]
  interpretation: string
  nextCheck: string
}

export interface OkxPrivateAuthEnvSyncDiagnostic {
  selectedEnvPath: string | null
  launchdEnvPath: string | null
  status: 'in_sync' | 'mismatch' | 'not_applicable'
  mismatchedFields: string[]
  action: string
}

export interface OkxPrivateAuthDiagnosisReport {
  schemaVersion: 1
  generatedAt: string
  diagnosticOnly: true
  promotionAllowed: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  exchange: string
  marketType: string
  symbol: string
  proxyConfigured: boolean
  envPath: string | null
  credentialPresence: {
    apiKey: boolean
    secret: boolean
    password: boolean
  }
  credentialFingerprints: {
    apiKey: string | null
    secret: string | null
    password: string | null
  }
  envFileDiagnostics: OkxPrivateAuthEnvFileDiagnostic[]
  networkDiagnostics: OkxPrivateAuthNetworkDiagnostic
  probes: OkxPrivateAuthProbe[]
  bestMode: ProbeMode | null
  status: 'auth_available' | 'blocked'
  blockers: string[]
  regionalDomainDiagnostic: OkxPrivateAuthRegionalDomainDiagnostic
  envSyncDiagnostic: OkxPrivateAuthEnvSyncDiagnostic
  accountSideChecklist: OkxPrivateAuthChecklistItem[]
  nextActions: string[]
  notes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/okx_private_auth_diagnosis.latest.json'
const DEFAULT_SYMBOL = 'BTC/USDT:USDT'

async function main(): Promise<void> {
  const args = parseOkxPrivateAuthDiagnosisArgs(process.argv.slice(2))
  const report = await runOkxPrivateAuthDiagnosis(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }
}

export function parseOkxPrivateAuthDiagnosisArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const feeArgs = parseRuntimeFeeSnapshotArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    envPath: feeArgs.envPath,
    exchange: raw.get('exchange') ?? 'okx',
    marketType: feeArgs.marketType,
    symbol: raw.get('symbol') ?? DEFAULT_SYMBOL,
    timeoutMs: feeArgs.timeoutMs,
    proxyUrl: feeArgs.proxyUrl,
    okxHosts: feeArgs.okxHosts,
    apiKeyEnv: feeArgs.apiKeyEnv,
    secretEnv: feeArgs.secretEnv,
    passwordEnv: feeArgs.passwordEnv,
    json: feeArgs.json,
  }
}

export async function runOkxPrivateAuthDiagnosis(args: CliArgs): Promise<OkxPrivateAuthDiagnosisReport> {
  const startedAt = new Date()
  const env = await readRuntimeEnv(args.envPath)
  const envFileDiagnostics = await buildEnvFileDiagnostics(args)
  const credentials = {
    apiKey: readCredential(env, args.apiKeyEnv),
    secret: readCredential(env, args.secretEnv),
    password: readCredential(env, args.passwordEnv),
  }
  const effectiveArgs = {
    ...args,
    proxyUrl: args.proxyUrl ?? readProxyUrl(env),
  }
  const networkDiagnosticsPromise = buildNetworkDiagnostics(effectiveArgs)
  const probes: OkxPrivateAuthProbe[] = []
  for (const mode of ['production', 'demoTrading', 'sandbox'] as ProbeMode[]) {
    probes.push(await runProbe(effectiveArgs, mode, credentials))
  }
  const networkDiagnostics = await networkDiagnosticsPromise
  const okProbe = probes.find(probe => probe.status === 'auth_ok') ?? null
  const blockers = okProbe
    ? []
    : buildGlobalBlockers(credentials, probes)
  const regionalDomainDiagnostic = buildRegionalDomainDiagnostic(probes)
  const envSyncDiagnostic = buildEnvSyncDiagnostic(envFileDiagnostics)
  const accountSideChecklist = buildAccountSideChecklist({
    args: effectiveArgs,
    credentials,
    probes,
    blockers,
    okProbe,
    networkDiagnostics,
  })
  const report: OkxPrivateAuthDiagnosisReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    diagnosticOnly: true,
    promotionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    exchange: args.exchange,
    marketType: args.marketType,
    symbol: args.symbol,
    proxyConfigured: effectiveArgs.proxyUrl != null,
    envPath: args.envPath ? resolve(args.envPath) : null,
    credentialPresence: {
      apiKey: credentials.apiKey != null,
      secret: credentials.secret != null,
      password: credentials.password != null,
    },
    credentialFingerprints: {
      apiKey: credentialFingerprint(credentials.apiKey),
      secret: credentialFingerprint(credentials.secret),
      password: credentialFingerprint(credentials.password),
    },
    envFileDiagnostics,
    networkDiagnostics,
    probes,
    bestMode: okProbe?.mode ?? null,
    status: okProbe ? 'auth_available' : 'blocked',
    blockers,
    regionalDomainDiagnostic,
    envSyncDiagnostic,
    accountSideChecklist,
    nextActions: okProbe
      ? [
          `Run fees:runtime:snapshot with ${modeFlag(okProbe.mode)} to publish a runtime-verified fee snapshot.`,
          'Rerun route-cost, incubation, and status artifacts after fee snapshot publication.',
        ]
      : [
          regionalDomainDiagnostic.hostsReturning50119.length > 0
            ? regionalDomainDiagnostic.nextCheck
            : 'Create or paste a current OKX read-only API key/secret/passphrase for the correct environment.',
          ...(envSyncDiagnostic.status === 'mismatch' ? [envSyncDiagnostic.action] : []),
          'Verify the passphrase belongs to the same key and that the key has read permission.',
          'Rerun this diagnosis before rerunning fees:runtime:snapshot.',
        ],
    notes: [
      'This artifact stores only credential presence and short salted fingerprints; it never writes raw API secrets.',
      'envFileDiagnostics inspects only env-file metadata, credential presence, and salted fingerprints; it never stores raw env values.',
      'Direct signed REST probes use the configured proxy URL or standard proxy environment variables when present.',
      'The probes are private read-only metadata checks. They do not place orders, cancel orders, modify leverage, or authorize execution.',
      'auth_available here is not a profitability claim and does not bypass promotion or paper/live gates.',
    ],
  }

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'okx_private_auth_diagnosis',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: report.status === 'auth_available' ? 0 : 1,
      businessStatus: report.status === 'auth_available' ? 'pass' : 'fail',
      recordsIn: report.probes.length,
      recordsOut: report.probes.filter(probe => probe.status === 'auth_ok').length,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

async function runProbe(
  args: CliArgs,
  mode: ProbeMode,
  credentials: { apiKey: string | null; secret: string | null; password: string | null },
): Promise<OkxPrivateAuthProbe> {
  const feeArgs: RuntimeFeeSnapshotArgs = {
    exchange: args.exchange,
    marketType: args.marketType,
    symbols: [args.symbol],
    symbolScope: 'okx_private_auth_probe',
    instrumentType: 'crypto_perpetual',
    accountTier: null,
    outputPath: null,
    statusPath: null,
    ttlHours: 1,
    timeoutMs: args.timeoutMs,
    proxyUrl: args.proxyUrl,
    okxHosts: args.okxHosts,
    sandbox: mode === 'sandbox',
    demoTrading: mode === 'demoTrading',
    apiKeyEnv: args.apiKeyEnv,
    secretEnv: args.secretEnv,
    passwordEnv: args.passwordEnv,
    envPath: args.envPath,
    dryRun: true,
    json: true,
  }
  const authCheck = await runPrivateReadOnlyAuthCheck(feeArgs, credentials)
  const directRestCheck = await runDirectOkxRestAuthCheck(args, mode, credentials)
  const result = await fetchRuntimeFeeRowsFromCcxt(feeArgs)
  const errorClasses = Array.from(new Set(result.errors.map(error => error.errorClass)))
  const privateFeeStatus = classifyProbeStatus(result.blockers, errorClasses, result.rows.length)
  return {
    mode,
    sandbox: feeArgs.sandbox,
    demoTrading: feeArgs.demoTrading,
    status: authCheck.status === 'auth_ok' || directRestCheck.status === 'auth_ok'
      ? 'auth_ok'
      : classifyCombinedProbeStatus(
        mostSpecificAuthStatus(authCheck.status, directRestCheck.status),
        classifyProbeStatus(result.blockers, errorClasses, result.rows.length),
      ),
    directRestStatus: directRestCheck.status,
    directRestHost: directRestCheck.host,
    directRestCode: directRestCheck.code,
    directRestMessage: directRestCheck.message,
    directRestErrorClass: directRestCheck.errorClass,
    directRestAttempts: directRestCheck.attempts,
    authCheckStatus: authCheck.status,
    authCheckHost: authCheck.host,
    authCheckErrorClass: authCheck.errorClass,
    authCheckRedactedError: authCheck.redactedError,
    privateFeeStatus,
    checkedSymbol: args.symbol,
    rowsFetched: result.rows.length,
    blockers: result.blockers,
    errorClasses,
    redactedErrors: result.errors.map(error => ({
      ...error,
      message: redactDiagnosticText(error.message),
    })),
    notes: [
      ...(directRestCheck.status === 'auth_ok'
        ? [`Direct signed OKX REST account config returned successfully${directRestCheck.host ? ` via ${directRestCheck.host}` : ''}.`]
        : [`Direct signed OKX REST account config did not return successfully: ${directRestCheck.code ?? directRestCheck.errorClass ?? 'unknown'}.`]),
      ...(authCheck.status === 'auth_ok'
        ? [`Read-only private account configuration returned successfully${authCheck.host ? ` via ${authCheck.host}` : ''}.`]
        : ['Read-only private account configuration did not return successfully.']),
      ...(result.rows.length > 0
        ? ['Private fee metadata returned at least one usable row for this mode.']
        : ['No usable private fee row returned for this mode.']),
    ],
  }
}

async function runDirectOkxRestAuthCheck(
  args: CliArgs,
  mode: ProbeMode,
  credentials: { apiKey: string | null; secret: string | null; password: string | null },
): Promise<{
  status: AuthCheckStatus
  host: string | null
  code: string | null
  message: string | null
  errorClass: string | null
  attempts: DirectOkxRestAuthAttempt[]
}> {
  const credentialBlockers = [
    ...(!credentials.apiKey ? ['apiKey'] : []),
    ...(!credentials.secret ? ['secret'] : []),
    ...(!credentials.password ? ['password'] : []),
  ]
  if (credentialBlockers.length > 0) {
    return {
      status: 'credential_missing',
      host: null,
      code: 'credential_missing',
      message: `missing:${credentialBlockers.join(',')}`,
      errorClass: 'credential_missing',
      attempts: [],
    }
  }
  const hosts = mode === 'production'
    ? args.okxHosts.length > 0 ? args.okxHosts : ['www.okx.com', 'aws.okx.com', 'eea.okx.com', 'us.okx.com']
    : ['www.okx.com']
  let last: {
    status: AuthCheckStatus
    host: string | null
    code: string | null
    message: string | null
    errorClass: string | null
  } | null = null
  const attempts: DirectOkxRestAuthAttempt[] = []
  for (const host of hosts) {
    const result = await fetchDirectOkxAccountConfig({
      host,
      mode,
      timeoutMs: args.timeoutMs,
      proxyUrl: args.proxyUrl,
      credentials: {
        apiKey: credentials.apiKey as string,
        secret: credentials.secret as string,
        password: credentials.password as string,
      },
    })
    attempts.push({
      host,
      status: result.status,
      code: result.code,
      message: result.message,
      errorClass: result.errorClass,
    })
    if (result.status === 'auth_ok') return { ...result, attempts }
    last = result
  }
  return last
    ? { ...last, attempts }
    : {
        status: 'unknown_failed',
        host: null,
        code: null,
        message: null,
        errorClass: 'unknown',
        attempts,
      }
}

async function fetchDirectOkxAccountConfig(input: {
  host: string
  mode: ProbeMode
  timeoutMs: number
  proxyUrl: string | null
  credentials: { apiKey: string; secret: string; password: string }
}): Promise<{
  status: AuthCheckStatus
  host: string | null
  code: string | null
  message: string | null
  errorClass: string | null
}> {
  const requestPath = '/api/v5/account/config'
  const method = 'GET'
  const timestamp = new Date().toISOString()
  const signature = createHmac('sha256', input.credentials.secret)
    .update(`${timestamp}${method}${requestPath}`)
    .digest('base64')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
  const dispatcher = buildUndiciDispatcher(input.proxyUrl)
  try {
    const response = await undiciFetch(`https://${input.host}${requestPath}`, {
      method,
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
      headers: {
        'OK-ACCESS-KEY': input.credentials.apiKey,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': input.credentials.password,
        ...okxSimulatedTradingHeaderForMode(input.mode),
      },
    })
    const payload = await readJsonResponse(response)
    const body = asRecord(payload)
    const code = readString(body?.code) ?? String(response.status)
    const message = redactDiagnosticText(readString(body?.msg) ?? response.statusText)
    if (response.ok && code === '0') {
      return { status: 'auth_ok', host: input.host, code, message, errorClass: null }
    }
    const errorClass = classifyDirectRestCode(code, message, response.status)
    return {
      status: errorClass === 'auth' ? 'auth_failed' : 'unknown_failed',
      host: input.host,
      code,
      message,
      errorClass,
    }
  } catch (error) {
    const message = redactDiagnosticText(error instanceof Error ? error.message : String(error))
    return {
      status: 'unknown_failed',
      host: input.host,
      code: null,
      message,
      errorClass: /abort|timeout/i.test(message)
        ? 'network_timeout'
        : /fetch failed|network|ECONN|EHOST/i.test(message)
          ? 'network'
          : 'client_error',
    }
  } finally {
    clearTimeout(timeout)
  }
}

function buildUndiciDispatcher(proxyUrl: string | null): Dispatcher | null {
  try {
    return proxyUrl ? new ProxyAgent(proxyUrl) : new EnvHttpProxyAgent()
  } catch {
    return null
  }
}

async function readJsonResponse(response: Awaited<ReturnType<typeof undiciFetch>>): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return { code: String(response.status), msg: text.slice(0, 240) }
  }
}

function classifyDirectRestCode(code: string, message: string, httpStatus: number): string {
  if (['50119', '50113', '50114', '50115', '50116', '50117'].includes(code)) return 'auth'
  if (/api key|signature|passphrase|doesn'?t exist|invalid/i.test(message)) return 'auth'
  if (httpStatus === 401 || httpStatus === 403) return 'auth'
  if (httpStatus === 404) return 'api_not_supported'
  if (httpStatus >= 500) return 'exchange'
  return 'unknown'
}

export function okxSimulatedTradingHeaderForMode(mode: ProbeMode): Record<string, '1'> {
  return mode === 'production' ? {} : { 'x-simulated-trading': '1' }
}

async function runPrivateReadOnlyAuthCheck(
  args: RuntimeFeeSnapshotArgs,
  credentials: { apiKey: string | null; secret: string | null; password: string | null },
): Promise<{ status: AuthCheckStatus; host: string | null; errorClass: string | null; redactedError: string | null }> {
  const credentialBlockers = [
    ...(!credentials.apiKey ? ['apiKey'] : []),
    ...(!credentials.secret ? ['secret'] : []),
    ...(args.exchange.toLowerCase() === 'okx' && !credentials.password ? ['password'] : []),
  ]
  if (credentialBlockers.length > 0) {
    return {
      status: 'credential_missing',
      host: null,
      errorClass: 'credential_missing',
      redactedError: `missing:${credentialBlockers.join(',')}`,
    }
  }

  let exchange: CcxtExchangeLike | null = null
  try {
    exchange = createCcxtExchange(args, {
      apiKey: credentials.apiKey as string,
      secret: credentials.secret as string,
      password: credentials.password,
    })
    const hosts = okxProductionHostCandidates(exchange, args)
    if (hosts.length === 0) {
      await fetchOkxPrivateAccountConfig(exchange)
      return { status: 'auth_ok', host: null, errorClass: null, redactedError: null }
    }

    let lastError: { errorClass: string; redactedError: string } | null = null
    for (const host of hosts) {
      try {
        exchange.hostname = host
        await fetchOkxPrivateAccountConfig(exchange)
        return { status: 'auth_ok', host, errorClass: null, redactedError: null }
      } catch (error) {
        lastError = {
          errorClass: classifyError(error),
          redactedError: redactRuntimeFeeErrorMessage(error instanceof Error ? error.message : String(error)),
        }
      }
    }
    return {
      status: lastError?.errorClass === 'auth' ? 'auth_failed' : 'unknown_failed',
      host: null,
      errorClass: lastError?.errorClass ?? 'exchange_or_unknown',
      redactedError: lastError?.redactedError ?? null,
    }
  } catch (error) {
    const errorClass = classifyError(error)
    return {
      status: errorClass === 'auth' ? 'auth_failed' : 'unknown_failed',
      host: null,
      errorClass,
      redactedError: redactRuntimeFeeErrorMessage(error instanceof Error ? error.message : String(error)),
    }
  } finally {
    await exchange?.close?.().catch(() => undefined)
  }
}

async function fetchOkxPrivateAccountConfig(exchange: CcxtExchangeLike): Promise<unknown> {
  const method = (exchange as unknown as { privateGetAccountConfig?: () => Promise<unknown> }).privateGetAccountConfig
  if (typeof method !== 'function') {
    throw new Error('okx privateGetAccountConfig() is not supported by this ccxt exchange instance')
  }
  return await method.call(exchange)
}

function classifyCombinedProbeStatus(authStatus: AuthCheckStatus, privateFeeStatus: ProbeStatus): ProbeStatus {
  if (authStatus === 'credential_missing') return 'credential_missing'
  if (authStatus === 'auth_failed') return 'auth_failed'
  if (privateFeeStatus === 'api_not_supported') return 'api_not_supported'
  return privateFeeStatus === 'auth_failed' ? 'auth_failed' : 'unknown_failed'
}

function mostSpecificAuthStatus(left: AuthCheckStatus, right: AuthCheckStatus): AuthCheckStatus {
  if (left === 'auth_failed' || right === 'auth_failed') return 'auth_failed'
  if (left === 'credential_missing' || right === 'credential_missing') return 'credential_missing'
  if (left === 'auth_ok' || right === 'auth_ok') return 'auth_ok'
  return 'unknown_failed'
}

function classifyProbeStatus(blockers: string[], errorClasses: string[], rowsFetched: number): ProbeStatus {
  if (rowsFetched > 0 && !blockers.some(blocker => blocker.includes('auth'))) return 'auth_ok'
  if (blockers.some(blocker => blocker.startsWith('fee_snapshot_credential_missing:'))) return 'credential_missing'
  if (errorClasses.includes('auth')) return 'auth_failed'
  if (errorClasses.length > 0 && errorClasses.every(errorClass => errorClass === 'api_not_supported')) {
    return 'api_not_supported'
  }
  return 'unknown_failed'
}

function buildGlobalBlockers(
  credentials: { apiKey: string | null; secret: string | null; password: string | null },
  probes: OkxPrivateAuthProbe[],
): string[] {
  const blockers: string[] = []
  if (!credentials.apiKey) blockers.push('okx_auth_api_key_missing')
  if (!credentials.secret) blockers.push('okx_auth_secret_missing')
  if (!credentials.password) blockers.push('okx_auth_passphrase_missing')
  if (credentials.apiKey && credentials.secret && credentials.password) {
    blockers.push('okx_auth_not_recognized_any_mode')
  }
  blockers.push(...probes
    .filter(probe => probe.directRestCode != null || probe.directRestErrorClass === 'auth')
    .map(probe => `direct_rest:${probe.mode}:${probe.directRestCode ?? probe.directRestErrorClass}`))
  blockers.push(...probes.flatMap(probe => probe.blockers.map(blocker => `${probe.mode}:${blocker}`)))
  return Array.from(new Set(blockers))
}

function buildRegionalDomainDiagnostic(probes: OkxPrivateAuthProbe[]): OkxPrivateAuthRegionalDomainDiagnostic {
  const attempts = probes.flatMap(probe =>
    probe.directRestAttempts.map(attempt => ({
      mode: probe.mode,
      ...attempt,
    })),
  )
  const hostsTried = uniqueStrings(attempts.map(attempt => attempt.host))
  const hostsReturning50119 = uniqueStrings(
    attempts
      .filter(attempt => attempt.code === '50119')
      .map(attempt => `${attempt.mode}@${attempt.host}`),
  )
  const triedUs = attempts.some(attempt => attempt.host === 'us.okx.com')
  const triedEea = attempts.some(attempt => attempt.host === 'eea.okx.com')
  const triedWww = attempts.some(attempt => attempt.host === 'www.okx.com')
  const coveredOfficialRegionalHosts = triedUs && triedEea && triedWww
  return {
    officialSource: 'https://www.okx.com/en-us/help/api-faq#50119-api-key-doesnt-exist',
    hostsTried,
    hostsReturning50119,
    interpretation: hostsReturning50119.length > 0
      ? coveredOfficialRegionalHosts
        ? 'OKX 50119 means the presented API key is not recognized on the probed account region/domain. Because www.okx.com, eea.okx.com, and us.okx.com were all checked, the next likely causes are a stale or mismatched key/secret/passphrase tuple, wrong main/sub-account, wrong OKX entity, or wrong production/demo environment.'
        : 'OKX 50119 means the presented API key is not recognized on the probed account region/domain. Check whether the key was created for the API domain being used.'
      : 'No direct REST 50119 response was observed in the latest probe.',
    nextCheck: coveredOfficialRegionalHosts
      ? 'Verify the key in OKX UI belongs to the same account/sub-account/entity and replace api key, secret, and passphrase together with a fresh read-only key if any value is uncertain.'
      : 'Verify the OKX registration region and rerun with the matching official API domain: us.okx.com for app.okx.com US/AU accounts, eea.okx.com for my.okx.com EU accounts, or www.okx.com for global accounts.',
  }
}

function buildEnvSyncDiagnostic(envFileDiagnostics: OkxPrivateAuthEnvFileDiagnostic[]): OkxPrivateAuthEnvSyncDiagnostic {
  const selected = envFileDiagnostics.find(item => item.label === 'selected_env_file') ?? null
  const launchd = envFileDiagnostics.find(item => item.label === 'launchd_default_env_file') ?? null
  if (!selected || !launchd || selected.path === launchd.path) {
    return {
      selectedEnvPath: selected?.path ?? null,
      launchdEnvPath: launchd?.path ?? null,
      status: 'not_applicable',
      mismatchedFields: [],
      action: 'No separate launchd default env file was compared for OKX credential sync.',
    }
  }
  const mismatchedFields = (['apiKey', 'secret', 'password'] as const).filter(field =>
    selected.credentialFingerprints[field] !== launchd.credentialFingerprints[field],
  )
  return {
    selectedEnvPath: selected.path,
    launchdEnvPath: launchd.path,
    status: mismatchedFields.length > 0 ? 'mismatch' : 'in_sync',
    mismatchedFields,
    action: mismatchedFields.length > 0
      ? `Sync the OKX credential tuple into ${launchd.path} or set OPENALICE_ENV_FILE to ${selected.path} before relying on launchd cron private-auth jobs. Replace api key, secret, and passphrase together; do not paste raw secrets into logs.`
      : 'Selected env file and launchd default env file have matching OKX credential fingerprints.',
  }
}

function buildAccountSideChecklist(input: {
  args: CliArgs
  credentials: { apiKey: string | null; secret: string | null; password: string | null }
  probes: OkxPrivateAuthProbe[]
  blockers: string[]
  okProbe: OkxPrivateAuthProbe | null
  networkDiagnostics: OkxPrivateAuthNetworkDiagnostic
}): OkxPrivateAuthChecklistItem[] {
  const credentialPresence = {
    apiKey: input.credentials.apiKey != null,
    secret: input.credentials.secret != null,
    password: input.credentials.password != null,
  }
  const attempts = input.probes.flatMap(probe =>
    probe.directRestAttempts.map(attempt => ({
      mode: probe.mode,
      ...attempt,
    })),
  )
  const hostsTried = uniqueStrings(attempts.map(attempt => attempt.host))
  const direct50119Modes = uniqueStrings(
    attempts
      .filter(attempt => attempt.code === '50119')
      .map(attempt => `${attempt.mode}@${attempt.host}`),
  )
  const authErrorCodes = uniqueStrings(
    attempts
      .filter(attempt => attempt.errorClass === 'auth' && attempt.code)
      .map(attempt => `${attempt.mode}:${attempt.code}`),
  )
  const anyNetworkErrors = attempts.some(attempt =>
    attempt.errorClass === 'network' ||
    attempt.errorClass === 'network_timeout' ||
    attempt.errorClass === 'client_error',
  )
  const allCredentialsPresent = credentialPresence.apiKey && credentialPresence.secret && credentialPresence.password

  return [
    {
      id: 'credential_tuple_present',
      status: allCredentialsPresent ? 'passed_local_check' : 'blocked',
      evidence: [
        `apiKeyPresent:${credentialPresence.apiKey}`,
        `secretPresent:${credentialPresence.secret}`,
        `passphrasePresent:${credentialPresence.password}`,
      ],
      action: allCredentialsPresent
        ? 'Local .env contains all three credential fields; next verify they are one OKX API key tuple.'
        : 'Fill EXCHANGE_API_KEY, EXCHANGE_API_SECRET, and EXCHANGE_PASSWORD before diagnosing OKX private auth.',
    },
    {
      id: 'passphrase_is_api_passphrase',
      status: credentialPresence.password ? 'needs_user_check' : 'blocked',
      evidence: [
        `passwordEnv:${input.args.passwordEnv}`,
        'local_check:presence_only',
      ],
      action: 'Verify EXCHANGE_PASSWORD is the API passphrase created with this exact OKX key, not the OKX login password and not another key passphrase.',
    },
    {
      id: 'environment_mode_matches_key',
      status: input.okProbe ? 'passed_local_check' : 'needs_user_check',
      evidence: input.probes.map(probe =>
        `${probe.mode}:status=${probe.status},direct=${probe.directRestStatus},code=${probe.directRestCode ?? 'none'}`,
      ),
      action: 'Verify whether the key was created for production, demo trading, or sandbox; create a fresh read-only key in the same environment the bot is probing.',
    },
    {
      id: 'account_region_domain_matches_key',
      status: direct50119Modes.length > 0 ? 'needs_user_check' : input.okProbe ? 'passed_local_check' : 'needs_user_check',
      evidence: [
        `hostsTried:${hostsTried.join(',') || 'none'}`,
        `direct50119:${direct50119Modes.join(',') || 'none'}`,
        'officialRegionalDomains:app.okx.com->us.okx.com,my.okx.com->eea.okx.com,global->www.okx.com',
      ],
      action: 'Verify the OKX account entity/region and API domain match the account; OKX documents 50119 as commonly caused by domain/region mismatch.',
    },
    {
      id: 'main_or_sub_account_matches_key',
      status: input.okProbe ? 'passed_local_check' : 'needs_user_check',
      evidence: [
        `authErrorCodes:${authErrorCodes.join(',') || 'none'}`,
        `bestMode:${input.okProbe?.mode ?? 'none'}`,
      ],
      action: 'Verify the key belongs to the intended main account or sub-account and that the same account is selected in the OKX API management page.',
    },
    {
      id: 'ip_allowlist_matches_current_egress',
      status: input.okProbe ? 'passed_local_check' : 'needs_user_check',
      evidence: [
        `proxyConfigured:${input.args.proxyUrl != null}`,
        `publicEgressIp:${input.networkDiagnostics.publicEgressIp ?? 'unknown'}`,
        `egressIpStatus:${input.networkDiagnostics.status}`,
        `networkErrorsObserved:${anyNetworkErrors}`,
      ],
      action: `Verify the OKX API key IP allowlist includes the current proxy/egress IP${input.networkDiagnostics.publicEgressIp ? ` ${input.networkDiagnostics.publicEgressIp}` : ''}, or temporarily use a fresh read-only key with the correct allowlist for diagnosis.`,
    },
    {
      id: 'permissions_are_read_only_private',
      status: input.okProbe ? 'passed_local_check' : 'needs_user_check',
      evidence: [
        `marketType:${input.args.marketType}`,
        `symbol:${input.args.symbol}`,
        `privateRowsFetched:${input.probes.map(probe => `${probe.mode}:${probe.rowsFetched}`).join(',')}`,
      ],
      action: 'Verify the key has read permission for the intended OKX account; trading/withdrawal permission is not needed for this diagnosis.',
    },
    {
      id: 'fresh_key_recommended_after_50119',
      status: direct50119Modes.length > 0 ? 'needs_user_check' : 'not_applicable',
      evidence: [
        `direct50119:${direct50119Modes.join(',') || 'none'}`,
        `globalBlockers:${input.blockers.slice(0, 6).join(',') || 'none'}`,
      ],
      action: 'If the OKX UI shows a key but diagnosis still returns 50119, create a new read-only API key/passphrase in the correct environment and replace all three env values together.',
    },
  ]
}

async function buildNetworkDiagnostics(args: CliArgs): Promise<OkxPrivateAuthNetworkDiagnostic> {
  const checkedAt = new Date().toISOString()
  const timeoutMs = Math.max(1, Math.min(args.timeoutMs, 5_000))
  const sources = [
    { source: 'api.ipify.org', url: 'https://api.ipify.org' },
    { source: 'checkip.amazonaws.com', url: 'https://checkip.amazonaws.com' },
    { source: 'ifconfig.me/ip', url: 'https://ifconfig.me/ip' },
  ]
  const failures: string[] = []
  for (const source of sources) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const dispatcher = buildUndiciDispatcher(args.proxyUrl)
    try {
      const response = await undiciFetch(source.url, {
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {}),
        headers: {
          accept: 'text/plain',
        },
      })
      const text = (await response.text()).trim()
      const publicEgressIp = normalizeIpLiteral(text)
      if (response.ok && publicEgressIp) {
        return {
          source: source.source,
          status: 'available',
          checkedAt,
          publicEgressIp,
          proxyConfigured: args.proxyUrl != null,
          timeoutMs,
          errorClass: null,
          redactedError: null,
          notes: [
            'Use this public egress IP when checking the OKX API key IP allowlist for the same proxy/network path.',
            `IP lookup used ${source.source}; fallback sources are tried when earlier services time out.`,
          ],
        }
      }
      failures.push(`${source.source}:${response.ok ? 'invalid_ip_response' : `http_${response.status}`}`)
    } catch (error) {
      const message = redactDiagnosticText(error instanceof Error ? error.message : String(error))
      failures.push(`${source.source}:${classifyNetworkDiagnosticError(message)}`)
    } finally {
      clearTimeout(timeout)
    }
  }
  return {
    source: 'api.ipify.org,checkip.amazonaws.com,ifconfig.me/ip',
    status: 'unavailable',
    checkedAt,
    publicEgressIp: null,
    proxyConfigured: args.proxyUrl != null,
    timeoutMs,
    errorClass: 'ip_lookup_failed',
    redactedError: failures.join('|') || null,
    notes: [
      'Public egress IP lookup failed across all configured sources; OKX IP allowlist must be checked manually.',
    ],
  }
}

async function buildEnvFileDiagnostics(args: CliArgs): Promise<OkxPrivateAuthEnvFileDiagnostic[]> {
  const selectedPath = args.envPath ? resolve(args.envPath) : null
  const repoEnvPath = resolve('.env')
  const launchdEnvPath = resolve(homedir(), '.config/openalice/openalice.env')
  const candidates: Array<{ label: string; path: string; selectedForDiagnosis: boolean }> = []
  if (selectedPath) {
    candidates.push({
      label: 'selected_env_file',
      path: selectedPath,
      selectedForDiagnosis: true,
    })
  }
  for (const candidate of [
    { label: 'repo_default_env_file', path: repoEnvPath },
    { label: 'launchd_default_env_file', path: launchdEnvPath },
  ]) {
    const resolvedPath = resolve(candidate.path)
    if (candidates.some(existing => existing.path === resolvedPath)) continue
    candidates.push({
      label: candidate.label,
      path: resolvedPath,
      selectedForDiagnosis: selectedPath === resolvedPath,
    })
  }
  const diagnostics: OkxPrivateAuthEnvFileDiagnostic[] = []
  for (const candidate of candidates) {
    diagnostics.push(await inspectEnvFileForOkxCredentials({
      ...candidate,
      apiKeyEnv: args.apiKeyEnv,
      secretEnv: args.secretEnv,
      passwordEnv: args.passwordEnv,
    }))
  }
  return diagnostics
}

async function inspectEnvFileForOkxCredentials(input: {
  label: string
  path: string
  selectedForDiagnosis: boolean
  apiKeyEnv: string
  secretEnv: string
  passwordEnv: string
}): Promise<OkxPrivateAuthEnvFileDiagnostic> {
  const base = {
    label: input.label,
    path: input.path,
    selectedForDiagnosis: input.selectedForDiagnosis,
    credentialPresence: {
      apiKey: false,
      secret: false,
      password: false,
    },
    credentialFingerprints: {
      apiKey: null,
      secret: null,
      password: null,
    },
  }
  if (!existsSync(input.path)) {
    return {
      ...base,
      exists: false,
      readable: false,
      restricted: null,
      ownerCurrentUser: null,
      mode: null,
      blockers: ['env_file_missing'],
      notes: [
        'File does not exist; this is allowed for non-selected comparison paths but credentials cannot be read from it.',
      ],
    }
  }

  try {
    const fileStat = await stat(input.path)
    const modeNumber = fileStat.mode & 0o777
    const mode = `0o${modeNumber.toString(8).padStart(3, '0')}`
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : fileStat.uid
    const ownerCurrentUser = fileStat.uid === currentUid
    const restricted = ownerCurrentUser && (modeNumber & 0o077) === 0
    const blockers: string[] = []
    const notes: string[] = [
      'Only credential presence and salted fingerprints are reported; raw env values are never written.',
    ]
    if (!ownerCurrentUser) blockers.push('env_file_not_owned_by_current_user')
    if ((modeNumber & 0o077) !== 0) blockers.push('env_file_group_or_other_accessible')
    if (!restricted) {
      return {
        ...base,
        exists: true,
        readable: false,
        restricted,
        ownerCurrentUser,
        mode,
        blockers,
        notes: [
          ...notes,
          'Credential values were not read because the env file is not restricted to the current user.',
        ],
      }
    }

    const rawEnv = await readRawEnvFile(input.path)
    const credentials = {
      apiKey: readCredential(rawEnv, input.apiKeyEnv),
      secret: readCredential(rawEnv, input.secretEnv),
      password: readCredential(rawEnv, input.passwordEnv),
    }
    if (!credentials.apiKey) blockers.push(`credential_missing:${input.apiKeyEnv}`)
    if (!credentials.secret) blockers.push(`credential_missing:${input.secretEnv}`)
    if (!credentials.password) blockers.push(`credential_missing:${input.passwordEnv}`)
    return {
      ...base,
      exists: true,
      readable: true,
      restricted,
      ownerCurrentUser,
      mode,
      credentialPresence: {
        apiKey: credentials.apiKey != null,
        secret: credentials.secret != null,
        password: credentials.password != null,
      },
      credentialFingerprints: {
        apiKey: credentialFingerprint(credentials.apiKey),
        secret: credentialFingerprint(credentials.secret),
        password: credentialFingerprint(credentials.password),
      },
      blockers,
      notes,
    }
  } catch (error) {
    return {
      ...base,
      exists: true,
      readable: false,
      restricted: null,
      ownerCurrentUser: null,
      mode: null,
      blockers: ['env_file_read_failed'],
      notes: [
        redactDiagnosticText(error instanceof Error ? error.message : String(error)),
      ],
    }
  }
}

async function readRuntimeEnv(envPath: string | null): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...process.env } as Record<string, string>
  if (!envPath) return out
  const resolved = resolve(envPath)
  if (!existsSync(resolved)) return out
  await assertRestrictedEnvFile(resolved)
  const fileEnv = await readRawEnvFile(resolved)
  for (const [key, value] of Object.entries(fileEnv)) {
    if (out[key]) continue
    out[key] = value
  }
  return out
}

async function readRawEnvFile(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const raw = await readFile(path, 'utf-8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
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

function readCredential(env: Record<string, string>, key: string): string | null {
  const value = env[key]?.trim()
  return value ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function normalizeIpLiteral(value: string): string | null {
  const trimmed = value.trim()
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(trimmed)) {
    const octets = trimmed.split('.').map(part => Number(part))
    return octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? trimmed : null
  }
  if (/^[0-9a-f:]+$/i.test(trimmed) && trimmed.includes(':')) {
    return trimmed
  }
  return null
}

function classifyNetworkDiagnosticError(message: string): string {
  if (/abort|timeout/i.test(message)) return 'network_timeout'
  if (/fetch failed|network|ECONN|EHOST|ENOTFOUND|EAI_AGAIN/i.test(message)) return 'network'
  return 'client_error'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readProxyUrl(env: Record<string, string>): string | null {
  return readCredential(env, 'OPENALICE_FEE_SNAPSHOT_PROXY_URL') ??
    readCredential(env, 'HTTPS_PROXY') ??
    readCredential(env, 'https_proxy') ??
    readCredential(env, 'HTTP_PROXY') ??
    readCredential(env, 'http_proxy')
}

function credentialFingerprint(value: string | null): string | null {
  if (!value) return null
  return `sha256:${createHash('sha256').update(`openalice-okx-auth-diagnosis:${value}`).digest('hex').slice(0, 12)}:len${value.length}`
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

function redactDiagnosticText(value: string): string {
  let out = value
  out = out.replace(/(api[-_ ]?key|secret|password|passphrase)[^,}\s]*/gi, '$1:[redacted]')
  out = out.replace(/[A-Za-z0-9_-]{24,}/g, '[redacted-token]')
  return out
}

function modeFlag(mode: ProbeMode): string {
  if (mode === 'demoTrading') return '--demoTrading true'
  if (mode === 'sandbox') return '--sandbox true'
  return 'no sandbox/demo flag'
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

function parseNullablePath(raw: string | undefined): string | null {
  if (raw == null) return null
  const normalized = raw.trim().toLowerCase()
  return normalized === '' || normalized === 'null' || normalized === 'none' ? null : raw
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

function renderConsoleSummary(report: OkxPrivateAuthDiagnosisReport): string {
  return [
    `okx private auth diagnosis: status=${report.status} bestMode=${report.bestMode ?? 'none'}`,
    `credentials=apiKey:${report.credentialPresence.apiKey},secret:${report.credentialPresence.secret},password:${report.credentialPresence.password}`,
    ...report.probes.map(probe =>
      `${probe.mode}: status=${probe.status} rows=${probe.rowsFetched} errors=${probe.errorClasses.join('|') || 'none'} blockers=${probe.blockers.join('|') || 'none'}`,
    ),
    `blockers=${report.blockers.join('|') || 'none'}`,
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('diagnose_okx_private_auth failed:', error)
    process.exit(1)
  })
}
