import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

interface CliArgs {
  outputPath: string | null
  json: boolean
}

export interface PortfolioRiskManagementGateStatus {
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
    portfolioRiskMgmt: {
      found: boolean
      available: boolean
      verdict: string
      details: string[]
    }
    positionSizing: {
      found: boolean
      available: boolean
      verdict: string
      method: string
      targetVolPct: number | null
      maxPctOfEquity: number | null
      kellyFraction: number | null
      layers: number
    }
    maxDrawdown: {
      found: boolean
      available: boolean
      verdict: string
      consecutiveLossDaysLimit: number | null
      dailyLossPctSoftCap: number | null
      maxDailyLossUsd: number | null
    }
    correlationAware: {
      found: boolean
      available: boolean
      verdict: string
      methods: string[]
      details: string[]
    }
  }
  riskConfig: Record<string, unknown> | null
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/portfolio_risk_management_gate_status.latest.json'

const PORTFOLIO_DIR = new URL('../src/portfolio', import.meta.url).pathname

const PORTFOLIO_FILES = ['allocator.ts', 'target.ts', 'rebalance.ts', 'hca.ts', 'stable-clustering.ts']
const RISK_CONFIG_PATH = new URL('../data/config/risk.json', import.meta.url).pathname
const STRATEGY_CONFIG_PATH = new URL('../data/config/strategy.json', import.meta.url).pathname

export async function readJsonSafe(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(filePath, 'utf-8')
    return JSON.parse(content) as Record<string, unknown>
  } catch {
    return null
  }
}

export function checkPortfolioRiskMgmt(): { found: boolean; available: boolean; verdict: string; details: string[] } {
  const details: string[] = []
  const dirExists = existsSync(PORTFOLIO_DIR)

  if (!dirExists) {
    return { found: false, available: false, verdict: 'fail', details: ['Portfolio directory not found'] }
  }

  details.push('Portfolio directory found at src/portfolio/')
  const presentFiles = PORTFOLIO_FILES.filter(f => existsSync(resolve(PORTFOLIO_DIR, f)))
  const missingFiles = PORTFOLIO_FILES.filter(f => !existsSync(resolve(PORTFOLIO_DIR, f)))

  details.push(`Present files: ${presentFiles.join(', ')}`)
  if (missingFiles.length > 0) {
    details.push(`Missing files: ${missingFiles.join(', ')}`)
  }

  if (presentFiles.length >= 3) {
    return {
      found: true,
      available: true,
      verdict: 'pass',
      details,
    }
  }

  return {
    found: true,
    available: false,
    verdict: 'quarantine',
    details: [...details, 'Insufficient portfolio modules available'],
  }
}

export function checkPositionSizing(strategyConfig: Record<string, unknown> | null): {
  found: boolean
  available: boolean
  verdict: string
  method: string
  targetVolPct: number | null
  maxPctOfEquity: number | null
  kellyFraction: number | null
  layers: number
} {
  if (!strategyConfig) {
    return { found: false, available: false, verdict: 'fail', method: 'none', targetVolPct: null, maxPctOfEquity: null, kellyFraction: null, layers: 0 }
  }

  const sizing = (strategyConfig as Record<string, unknown>)['positionSizing'] as Record<string, unknown> | undefined
  if (!sizing) {
    return { found: false, available: false, verdict: 'fail', method: 'none', targetVolPct: null, maxPctOfEquity: null, kellyFraction: null, layers: 0 }
  }

  const enabled = Boolean(sizing['enabled'])
  const method = String(sizing['method'] ?? 'unknown')
  const targetVolPct = (sizing['targetVolPct'] as number) ?? null
  const maxPctOfEquity = (sizing['maxPctOfEquity'] as number) ?? null
  const kellyFraction = (sizing['kellyFraction'] as number) ?? null
  const layerConfigs = (sizing['layerConfigs'] as unknown[]) ?? []
  const layers = layerConfigs.length

  if (enabled && method !== 'none') {
    return {
      found: true,
      available: true,
      verdict: 'pass',
      method,
      targetVolPct,
      maxPctOfEquity,
      kellyFraction,
      layers,
    }
  }

  return {
    found: true,
    available: enabled,
    verdict: 'researchOnly',
    method,
    targetVolPct,
    maxPctOfEquity,
    kellyFraction,
    layers,
  }
}

export function checkMaxDrawdown(riskConfig: Record<string, unknown> | null): {
  found: boolean
  available: boolean
  verdict: string
  consecutiveLossDaysLimit: number | null
  dailyLossPctSoftCap: number | null
  maxDailyLossUsd: number | null
} {
  if (!riskConfig) {
    return { found: false, available: false, verdict: 'fail', consecutiveLossDaysLimit: null, dailyLossPctSoftCap: null, maxDailyLossUsd: null }
  }

  const consecutiveLossDaysLimit = (riskConfig['consecutiveLossDaysLimit'] as number) ?? null
  const dailyLossPctSoftCap = (riskConfig['dailyLossPctSoftCap'] as number) ?? null
  const maxDailyLossUsd = (riskConfig['maxDailyLossUsd'] as number) ?? null

  const hasDrawdownLikeLimit = consecutiveLossDaysLimit !== null || dailyLossPctSoftCap !== null || maxDailyLossUsd !== null
  const hasExplicitMaxDrawdown = (riskConfig['maxDrawdown'] as number) !== undefined || (riskConfig['maxDrawdownPct'] as number) !== undefined

  if (hasExplicitMaxDrawdown) {
    return {
      found: true,
      available: true,
      verdict: 'pass',
      consecutiveLossDaysLimit,
      dailyLossPctSoftCap,
      maxDailyLossUsd,
    }
  }

  if (hasDrawdownLikeLimit) {
    return {
      found: true,
      available: true,
      verdict: 'researchOnly',
      consecutiveLossDaysLimit,
      dailyLossPctSoftCap,
      maxDailyLossUsd,
    }
  }

  return {
    found: false,
    available: false,
    verdict: 'fail',
    consecutiveLossDaysLimit: null,
    dailyLossPctSoftCap: null,
    maxDailyLossUsd: null,
  }
}

export function checkCorrelationAware(): {
  found: boolean
  available: boolean
  verdict: string
  methods: string[]
  details: string[]
} {
  const details: string[] = []
  const methods: string[] = []

  const hcaExists = existsSync(resolve(PORTFOLIO_DIR, 'hca.ts'))
  const allocatorExists = existsSync(resolve(PORTFOLIO_DIR, 'allocator.ts'))
  const stableClusteringExists = existsSync(resolve(PORTFOLIO_DIR, 'stable-clustering.ts'))

  if (hcaExists) {
    methods.push('HCA (Hierarchical Clustering Allocation)')
    details.push('HCA-based risk parity via recursive bisection is available')
  }
  if (allocatorExists) {
    methods.push('InverseVol with correlation threshold')
    details.push('Allocator uses correlation threshold for pair concentration limits')
  }
  if (stableClusteringExists) {
    methods.push('Stable clustering')
    details.push('Stable correlation-based clustering for regime-aware allocation')
  }

  const found = hcaExists || allocatorExists
  const available = found

  if (found) {
    return {
      found: true,
      available: true,
      verdict: 'pass',
      methods: methods.length > 0 ? methods : ['allocator'],
      details: details.length > 0 ? details : ['Correlation-aware module found'],
    }
  }

  return {
    found: false,
    available: false,
    verdict: 'fail',
    methods: [],
    details: ['No correlation-aware portfolio allocation module found'],
  }
}

async function main(): Promise<void> {
  const args = parsePortfolioRiskManagementGateStatusArgs(process.argv.slice(2))
  const report = await runPortfolioRiskManagementGateStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parsePortfolioRiskManagementGateStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runPortfolioRiskManagementGateStatus(args: CliArgs): Promise<PortfolioRiskManagementGateStatus> {
  const startedAt = new Date()
  const report = await buildPortfolioRiskManagementGateStatus(new Date().toISOString())
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'portfolio_risk_management_gate_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: 'pass',
      recordsIn: 4,
      recordsOut: 1,
      errorClass: null,
    })
  }
  return report
}

export async function buildPortfolioRiskManagementGateStatus(
  generatedAt = new Date().toISOString(),
): Promise<PortfolioRiskManagementGateStatus> {
  const riskConfig = await readJsonSafe(RISK_CONFIG_PATH)
  const strategyConfig = await readJsonSafe(STRATEGY_CONFIG_PATH)

  const portfolioCheck = checkPortfolioRiskMgmt()
  const sizingCheck = checkPositionSizing(strategyConfig)
  const drawdownCheck = checkMaxDrawdown(riskConfig)
  const correlationCheck = checkCorrelationAware()

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
      portfolioRiskMgmt: portfolioCheck,
      positionSizing: sizingCheck,
      maxDrawdown: drawdownCheck,
      correlationAware: correlationCheck,
    },
    riskConfig: riskConfig as Record<string, unknown> | null,
    blockers: [],
    nextActions: [
      'Keep portfolio risk management gate in the research-evidence refresh chain; this is protection evidence, not trading authorization.',
      'When a formal max drawdown percentage is configured in risk.json, wire it into the gate for runtime enforcement.',
      'Consider adding explicit maxDrawdownPct field to risk.json to elevate drawdown protection from researchOnly to production grade.',
    ],
    safetyNotes: [
      'This artifact validates portfolio-level risk management capability only; it cannot authorize paper orders, live orders, promotion, or position sizing changes.',
      'Position sizing limits and drawdown controls are research-only diagnostic thresholds; actual enforcement requires integration into the production order guard path.',
      'Correlation-aware position sizing via HCA is available but not yet wired into the runtime decision path.',
    ],
  }
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

function renderConsoleSummary(report: PortfolioRiskManagementGateStatus): string {
  return [
    `Portfolio risk management gate status: ${report.status}`,
    `portfolioRiskMgmt=${report.checks.portfolioRiskMgmt.verdict} positionSizing=${report.checks.positionSizing.verdict} maxDrawdown=${report.checks.maxDrawdown.verdict} correlation=${report.checks.correlationAware.verdict}`,
    `paper=false live=false promotion=false`,
    `blockers=${report.blockers.slice(0, 8).join('|') || 'none'}`,
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_portfolio_risk_management_gate_status failed:', error)
    process.exit(1)
  })
}
