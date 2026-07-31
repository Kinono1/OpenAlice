import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ProxyAgent, request } from 'undici'
import { resolveOkxPublicApiBaseUrls, resolveProxyUrl } from '../src/domain/market-data/live-fetcher.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

interface CliArgs {
  outputPath: string | null
  timeoutMs: number
  json: boolean
}

export interface OkxPublicConnectivityAttempt {
  baseUrl: string
  hostname: string
  ok: boolean
  httpStatus: number | null
  okxCode: string | null
  latencyMs: number
  serverTime: string | null
  errorClass: string | null
  errorMessage: string | null
}

export interface OkxPublicConnectivityDiagnosis {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionAllowed: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  status: 'available' | 'blocked'
  publicDataFetchable: boolean
  timeoutMs: number
  proxy: {
    configured: boolean
    protocol: string | null
    hostname: string | null
    port: string | null
    hasUsername: boolean
    hasPassword: boolean
  }
  hosts: string[]
  attempts: OkxPublicConnectivityAttempt[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

type Probe = (baseUrl: string, args: CliArgs, proxyUrl: string | null) => Promise<OkxPublicConnectivityAttempt>

const DEFAULT_OUTPUT_PATH = 'data/runtime/okx_public_connectivity_diagnosis.latest.json'
const DEFAULT_TIMEOUT_MS = 8_000

async function main(): Promise<void> {
  const args = parseOkxPublicConnectivityArgs(process.argv.slice(2))
  const report = await runOkxPublicConnectivityDiagnosis(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseOkxPublicConnectivityArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    timeoutMs: parsePositiveInteger(raw.get('timeoutMs'), DEFAULT_TIMEOUT_MS),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runOkxPublicConnectivityDiagnosis(
  args: CliArgs,
  probe: Probe = probeOkxPublicHost,
): Promise<OkxPublicConnectivityDiagnosis> {
  const startedAt = new Date()
  const proxyUrl = resolveProxyUrl()
  const hosts = resolveOkxPublicApiBaseUrls()
  const attempts: OkxPublicConnectivityAttempt[] = []
  for (const host of hosts) {
    attempts.push(await probe(host, args, proxyUrl))
  }
  const report = buildOkxPublicConnectivityDiagnosis({
    generatedAt: new Date().toISOString(),
    timeoutMs: args.timeoutMs,
    proxyUrl,
    hosts,
    attempts,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'okx_public_connectivity_diagnosis',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'available' ? 'pass' : 'fail',
      recordsIn: hosts.length,
      recordsOut: attempts.filter(attempt => attempt.ok).length,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export function buildOkxPublicConnectivityDiagnosis(input: {
  generatedAt: string
  timeoutMs: number
  proxyUrl: string | null
  hosts: string[]
  attempts: OkxPublicConnectivityAttempt[]
}): OkxPublicConnectivityDiagnosis {
  const publicDataFetchable = input.attempts.some(attempt => attempt.ok)
  const blockers = publicDataFetchable
    ? []
    : [
        'okx_public_connectivity_all_hosts_failed',
        ...input.attempts.map(attempt =>
          `okx_public_host_failed:${attempt.hostname}:${attempt.errorClass ?? 'unknown'}`),
      ]

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status: publicDataFetchable ? 'available' : 'blocked',
    publicDataFetchable,
    timeoutMs: input.timeoutMs,
    proxy: summarizeProxy(input.proxyUrl),
    hosts: input.hosts,
    attempts: input.attempts,
    blockers,
    nextActions: publicDataFetchable
      ? ['Keep OKX public data accumulation scheduled; this connectivity artifact does not authorize trading.']
      : [
          'Check local proxy reachability and OKX domain access, then rerun data:okx-public:diagnose.',
          'Run data:accumulate-5m and data:accumulate-1s only after at least one OKX public host is reachable.',
          'Keep paper/live disabled; public connectivity recovery is necessary but not sufficient for strategy promotion.',
        ],
    safetyNotes: [
      'This artifact probes public OKX endpoints only; it does not use or print API keys, secrets, or passphrases.',
      'Connectivity availability is not profitability evidence and does not authorize paper or live trading.',
    ],
  }
}

async function probeOkxPublicHost(
  baseUrl: string,
  args: CliArgs,
  proxyUrl: string | null,
): Promise<OkxPublicConnectivityAttempt> {
  const started = Date.now()
  const hostname = safeHostname(baseUrl)
  try {
    const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
    const { statusCode, body } = await request(`${baseUrl}/api/v5/public/time`, {
      ...(dispatcher ? { dispatcher } : {}),
      signal: AbortSignal.timeout(args.timeoutMs),
    })
    const raw = await body.json() as { code?: string; data?: Array<{ ts?: string }> }
    const okxCode = typeof raw.code === 'string' ? raw.code : null
    return {
      baseUrl,
      hostname,
      ok: statusCode >= 200 && statusCode < 300 && okxCode === '0',
      httpStatus: statusCode,
      okxCode,
      latencyMs: Date.now() - started,
      serverTime: raw.data?.[0]?.ts ? new Date(Number(raw.data[0].ts)).toISOString() : null,
      errorClass: null,
      errorMessage: null,
    }
  } catch (error) {
    return {
      baseUrl,
      hostname,
      ok: false,
      httpStatus: null,
      okxCode: null,
      latencyMs: Date.now() - started,
      serverTime: null,
      errorClass: classifyError(error),
      errorMessage: redactErrorMessage(error instanceof Error ? error.message : String(error)),
    }
  }
}

function summarizeProxy(proxyUrl: string | null): OkxPublicConnectivityDiagnosis['proxy'] {
  if (!proxyUrl) {
    return {
      configured: false,
      protocol: null,
      hostname: null,
      port: null,
      hasUsername: false,
      hasPassword: false,
    }
  }
  try {
    const parsed = new URL(proxyUrl)
    return {
      configured: true,
      protocol: parsed.protocol || null,
      hostname: parsed.hostname || null,
      port: parsed.port || null,
      hasUsername: parsed.username.length > 0,
      hasPassword: parsed.password.length > 0,
    }
  } catch {
    return {
      configured: true,
      protocol: null,
      hostname: null,
      port: null,
      hasUsername: false,
      hasPassword: false,
    }
  }
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/timeout|aborted|AbortError/i.test(message)) return 'timeout'
  if (/SSL|TLS|secure TLS|socket disconnected/i.test(message)) return 'tls'
  if (/ENOTFOUND|Could not resolve|resolve host/i.test(message)) return 'dns'
  if (/ECONNREFUSED|Failed to connect/i.test(message)) return 'network'
  return 'unknown'
}

function redactErrorMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^@\s]+@/g, 'https://[redacted]@')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]')
    .slice(0, 240)
}

function safeHostname(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return 'invalid_host'
  }
}

function renderConsoleSummary(report: OkxPublicConnectivityDiagnosis): string {
  return [
    `OKX public connectivity: ${report.status}`,
    `fetchable=${report.publicDataFetchable} hosts=${report.hosts.length} proxyConfigured=${report.proxy.configured}`,
    `attempts=${report.attempts.map(attempt => `${attempt.hostname}:${attempt.ok ? 'ok' : attempt.errorClass ?? 'fail'}`).join(',')}`,
    `paper=false live=false promotion=false`,
  ].join('\n')
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

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value == null) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('diagnose_okx_public_connectivity failed:', error)
    process.exit(1)
  })
}
