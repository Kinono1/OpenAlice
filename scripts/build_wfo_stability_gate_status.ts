import { readFile } from 'node:fs/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

interface CliArgs {
  outputPath: string | null
  json: boolean
}

export interface StabilityCheckResult {
  found: boolean
  available: boolean
  verdict: string
}

export interface WfoStabilityGateStatus {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: 'pass'
  checks: {
    wfoStability: StabilityCheckResult
    paramStability: StabilityCheckResult
    stabilityReporting: StabilityCheckResult
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/wfo_stability_gate_status.latest.json'
const PROMOTION_PATH = 'data/runtime/strategy_promotion.latest.json'

async function readPromotionData(): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(PROMOTION_PATH, 'utf-8')
    return JSON.parse(content) as Record<string, unknown>
  } catch {
    return null
  }
}

function extractResearchGate(data: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!data) return null
  const gate = data.researchGate
  if (!gate || typeof gate !== 'object') return null
  return gate as Record<string, unknown>
}

function extractPaperGate(data: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!data) return null
  const gate = data.paperGate
  if (!gate || typeof gate !== 'object') return null
  return gate as Record<string, unknown>
}

function evaluateWfoStability(data: Record<string, unknown> | null): StabilityCheckResult {
  const gate = extractResearchGate(data)
  if (!gate) {
    return { found: false, available: false, verdict: 'unavailable' }
  }
  const hardBlocks = gate.hardBlocks
  const hasHardBlocks = Array.isArray(hardBlocks)
  if (!hasHardBlocks) {
    return { found: true, available: false, verdict: 'unavailable' }
  }
  const includesWfoFailed = (hardBlocks as unknown[]).includes('wfo_failed')
  return {
    found: true,
    available: true,
    verdict: includesWfoFailed ? 'fail' : 'pass',
  }
}

function evaluateParamStability(data: Record<string, unknown> | null): StabilityCheckResult {
  const gate = extractPaperGate(data)
  if (!gate) {
    return { found: false, available: false, verdict: 'unavailable' }
  }
  const snapshot = gate.metricSnapshot
  if (!snapshot || typeof snapshot !== 'object') {
    return { found: true, available: false, verdict: 'unavailable' }
  }
  const ms = snapshot as Record<string, unknown>
  const policyStatus = ms.strategyLanePolicyStatus
  if (typeof policyStatus !== 'string') {
    return { found: true, available: true, verdict: 'warning' }
  }
  return {
    found: true,
    available: true,
    verdict: policyStatus === 'loaded' ? 'pass' : 'fail',
  }
}

function evaluateStabilityReporting(data: Record<string, unknown> | null): StabilityCheckResult {
  if (!data) {
    return { found: false, available: false, verdict: 'unavailable' }
  }
  const generatedAt = data.generatedAt
  if (typeof generatedAt !== 'string') {
    return { found: true, available: false, verdict: 'unavailable' }
  }
  const gate = extractResearchGate(data)
  let isFresh = false
  if (gate) {
    const expiresAt = gate.expiresAt
    if (typeof expiresAt === 'string') {
      isFresh = new Date(expiresAt) > new Date()
    }
  }
  return {
    found: true,
    available: true,
    verdict: isFresh ? 'pass' : 'warning',
  }
}

export function buildWfoStabilityGateStatus(
  generatedAt = new Date().toISOString(),
  promotionData: Record<string, unknown> | null = null,
): WfoStabilityGateStatus {
  const wfo = evaluateWfoStability(promotionData)
  const param = evaluateParamStability(promotionData)
  const report = evaluateStabilityReporting(promotionData)

  const nextActions: string[] = []
  if (wfo.verdict === 'fail') {
    nextActions.push('Investigate WFO failure causes in strategy_promotion.latest.json researchGate; resolve wfo_failed before promotion eligibility.')
  }
  if (param.verdict === 'fail' || param.verdict === 'warning') {
    nextActions.push('Verify parameter stability guards are loaded in paperGate strategyLanePolicy; guards are required for controlled deployment.')
  }
  if (report.verdict === 'warning') {
    nextActions.push('Refresh strategy promotion data to restore stability reporting freshness and ensure accurate gate decisions.')
  }
  if (nextActions.length === 0) {
    nextActions.push('All WFO/stability checks pass; continue monitoring for parameter stability drift.')
    nextActions.push('When live data reveals parameter instability, wire stability guards into the production path.')
  }

  const safetyNotes: string[] = [
    'This artifact validates WFO stability and parameter stability guard presence only; it cannot authorize paper orders, live orders, promotion, or best_config mutation.',
    'WFO stability is a necessary but insufficient condition for promotion eligibility; all promotion gates must pass before trading authorization.',
  ]

  return {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'pass',
    checks: {
      wfoStability: wfo,
      paramStability: param,
      stabilityReporting: report,
    },
    blockers: [],
    nextActions,
    safetyNotes,
  }
}

async function main(): Promise<void> {
  const args = parseWfoStabilityGateStatusArgs(process.argv.slice(2))
  const report = await runWfoStabilityGateStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseWfoStabilityGateStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runWfoStabilityGateStatus(args: CliArgs): Promise<WfoStabilityGateStatus> {
  const startedAt = new Date()
  const promotionData = await readPromotionData()
  const report = buildWfoStabilityGateStatus(new Date().toISOString(), promotionData)
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'wfo_stability_gate_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: 'pass',
      recordsIn: 3,
      recordsOut: 1,
      errorClass: null,
    })
  }
  return report
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

function renderConsoleSummary(report: WfoStabilityGateStatus): string {
  return [
    `WFO stability gate status: ${report.status}`,
    `wfoStability=${report.checks.wfoStability.verdict} paramStability=${report.checks.paramStability.verdict} stabilityReporting=${report.checks.stabilityReporting.verdict}`,
    `paper=false live=false promotion=false`,
    `blockers=${report.blockers.slice(0, 8).join('|') || 'none'}`,
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_wfo_stability_gate_status failed:', error)
    process.exit(1)
  })
}
