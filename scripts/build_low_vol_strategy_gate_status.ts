import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type CheckVerdict = 'pass' | 'block'

interface CliArgs {
  outputPath: string | null
  json: boolean
}

export interface LowVolStrategyGateStatus {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: 'pass' | 'blocked'
  checks: {
    strategy_report_exists: { found: boolean; value: string; verdict: CheckVerdict }
    net_return_positive: { found: boolean; value: string; verdict: CheckVerdict }
    outperforms_btc: { found: boolean; value: string; verdict: CheckVerdict }
    sharpe_positive: { found: boolean; value: string; verdict: CheckVerdict }
    max_drawdown_acceptable: { found: boolean; value: string; verdict: CheckVerdict }
  }
  summary: {
    netAnnualizedReturn: number | null
    sharpeRatio: number | null
    btcReturn: number | null
    maxDrawdown: number | null
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_REPORT_PATH = 'data/research/low_vol_strategy_report.json'
const DEFAULT_OUTPUT_PATH = 'data/runtime/low_vol_strategy_gate_status.latest.json'

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const report = await runLowVolStrategyGateStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runLowVolStrategyGateStatus(args: CliArgs): Promise<LowVolStrategyGateStatus> {
  const startedAt = new Date()
  const generatedAt = startedAt.toISOString()
  const reportData = await readJsonIfExists(DEFAULT_REPORT_PATH) as LowVolStrategyReport | null
  const report = buildLowVolStrategyGateStatus(generatedAt, reportData)
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'low_vol_strategy_gate_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'pass' ? 'pass' : 'fail',
      recordsIn: reportData ? 1 : 0,
      recordsOut: 1,
      errorClass: report.blockers[0] ?? null,
    })
  }
  return report
}

export interface LowVolStrategyReport {
  summary?: {
    netAnnualizedReturn?: number
    sharpeRatio?: number
    btcReturn?: number
    maxDrawdown?: number
  }
  netAnnualizedReturn?: number
  sharpeRatio?: number
  btcReturn?: number
  maxDrawdown?: number
}

export function buildLowVolStrategyGateStatus(
  generatedAt: string,
  report: LowVolStrategyReport | null,
): LowVolStrategyGateStatus {
  // --- strategy_report_exists ---
  const reportExists = report != null

  // Extract metrics defensively — accept both top-level and nested summary
  const netAnnualizedReturn = readNumber(report?.summary?.netAnnualizedReturn ?? report?.netAnnualizedReturn)
  const sharpeRatio = readNumber(report?.summary?.sharpeRatio ?? report?.sharpeRatio)
  const btcReturn = readNumber(report?.summary?.btcReturn ?? report?.btcReturn)
  const maxDrawdown = readNumber(report?.summary?.maxDrawdown ?? report?.maxDrawdown)

  // --- net_return_positive: annualized return > 0 ---
  const netReturnPass = reportExists && netAnnualizedReturn != null && netAnnualizedReturn > 0

  // --- outperforms_btc: strategy return > BTC return ---
  const outperformsBtcPass = reportExists
    && netAnnualizedReturn != null
    && btcReturn != null
    && netAnnualizedReturn > btcReturn

  // --- sharpe_positive: Sharpe ratio > 0 ---
  const sharpePass = reportExists && sharpeRatio != null && sharpeRatio > 0

  // --- max_drawdown_acceptable: drawdown > -30% (i.e. less severe than -30%) ---
  const maxDrawdownPass = reportExists && maxDrawdown != null && maxDrawdown > -0.3

  const checks: LowVolStrategyGateStatus['checks'] = {
    strategy_report_exists: {
      found: reportExists,
      value: reportExists ? 'found' : 'missing',
      verdict: reportExists ? 'pass' : 'block',
    },
    net_return_positive: {
      found: netAnnualizedReturn != null,
      value: netAnnualizedReturn != null ? netAnnualizedReturn.toFixed(6) : 'null',
      verdict: netReturnPass ? 'pass' : 'block',
    },
    outperforms_btc: {
      found: netAnnualizedReturn != null && btcReturn != null,
      value: netAnnualizedReturn != null && btcReturn != null
        ? `strategy=${netAnnualizedReturn.toFixed(6)},btc=${btcReturn.toFixed(6)}`
        : 'null',
      verdict: outperformsBtcPass ? 'pass' : 'block',
    },
    sharpe_positive: {
      found: sharpeRatio != null,
      value: sharpeRatio != null ? sharpeRatio.toFixed(6) : 'null',
      verdict: sharpePass ? 'pass' : 'block',
    },
    max_drawdown_acceptable: {
      found: maxDrawdown != null,
      value: maxDrawdown != null ? maxDrawdown.toFixed(6) : 'null',
      verdict: maxDrawdownPass ? 'pass' : 'block',
    },
  }

  const blockers: string[] = []
  if (!reportExists) blockers.push('strategy_report_missing:data/research/low_vol_strategy_report.json')
  if (!netReturnPass) blockers.push(`net_return_positive_failed:value=${checks.net_return_positive.value}`)
  if (!outperformsBtcPass) blockers.push(`outperforms_btc_failed:${checks.outperforms_btc.value}`)
  if (!sharpePass) blockers.push(`sharpe_positive_failed:value=${checks.sharpe_positive.value}`)
  if (!maxDrawdownPass) blockers.push(`max_drawdown_acceptable_failed:value=${checks.max_drawdown_acceptable.value}`)

  const allPassed = blockers.length === 0

  return {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: allPassed ? 'pass' : 'blocked',
    checks,
    summary: {
      netAnnualizedReturn,
      sharpeRatio,
      btcReturn,
      maxDrawdown,
    },
    blockers,
    nextActions: allPassed
      ? ['Low-vol strategy gate passed. Continue to next research validation stage before any execution consideration.']
      : ['Fix failing low-vol strategy gate conditions before proceeding. Ensure data/research/low_vol_strategy_report.json exists with valid metrics.'],
    safetyNotes: [
      'This artifact validates low-volatility strategy research readiness only; it cannot authorize paper orders, live orders, promotion, leverage, or best_config mutation.',
      'Low-vol strategy is research-only; all execution-allowed flags are false at all times.',
      'Gate remains blocked until strategy report demonstrates positive net return, positive Sharpe, BTC outperformance, and max drawdown within -30% tolerance.',
    ],
  }
}

async function readJsonIfExists(path: string): Promise<unknown> {
  const resolved = resolve(path)
  if (!existsSync(resolved)) return null
  return JSON.parse(await readFile(resolved, 'utf-8'))
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    i += 1
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' ? null : value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function renderConsoleSummary(report: LowVolStrategyGateStatus): string {
  return [
    `Low-vol strategy gate status: ${report.status}`,
    `netReturn=${report.summary.netAnnualizedReturn?.toFixed(6) ?? 'null'} sharpe=${report.summary.sharpeRatio?.toFixed(6) ?? 'null'}`,
    `btcReturn=${report.summary.btcReturn?.toFixed(6) ?? 'null'} maxDrawdown=${report.summary.maxDrawdown?.toFixed(6) ?? 'null'}`,
    `researchOnly=true paper=false live=false promotion=false`,
    `blockers=${report.blockers.slice(0, 8).join('|') || 'none'}`,
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_low_vol_strategy_gate_status failed:', error)
    process.exit(1)
  })
}
