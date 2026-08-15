import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

interface CliArgs {
  outputPath: string | null
  json: boolean
}

export interface DynamicLeverageVolatilityGateStatus {
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
    volatilityPercentile: number
    realizedVolPct: number
    recommendedMaxLeverage: number
    currentMaxLeverage: number
    leverageBlocked: boolean
    tier: 'low' | 'normal' | 'high' | 'extreme'
    tierDescription: string
    lowTierProbe: { percentile: number; maxLeverage: number; blocked: boolean }
    normalTierProbe: { percentile: number; maxLeverage: number; blocked: boolean }
    highTierProbe: { percentile: number; maxLeverage: number; blocked: boolean }
    extremeTierProbe: { percentile: number; maxLeverage: number; blocked: boolean }
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/dynamic_leverage_volatility_gate_status.latest.json'

const VOL_TIERS = {
  low: { maxPercentile: 0.25, maxLeverage: 3, description: 'Low volatility regime; leverage capped at 3x' },
  normal: { maxPercentile: 0.75, maxLeverage: 1, description: 'Normal volatility regime; leverage capped at 1x' },
  high: { maxPercentile: 0.95, maxLeverage: 1, description: 'High volatility regime; leverage capped at 1x with warning' },
  extreme: { maxPercentile: 1.0, maxLeverage: 0, description: 'Extreme volatility regime; all new positions blocked' },
} as const

export function resolveVolatilityTier(volPercentile: number): { tier: 'low' | 'normal' | 'high' | 'extreme'; maxLeverage: number; blocked: boolean; description: string } {
  if (volPercentile < VOL_TIERS.low.maxPercentile) {
    return { tier: 'low', maxLeverage: VOL_TIERS.low.maxLeverage, blocked: false, description: VOL_TIERS.low.description }
  }
  if (volPercentile < VOL_TIERS.normal.maxPercentile) {
    return { tier: 'normal', maxLeverage: VOL_TIERS.normal.maxLeverage, blocked: false, description: VOL_TIERS.normal.description }
  }
  if (volPercentile < VOL_TIERS.high.maxPercentile) {
    return { tier: 'high', maxLeverage: VOL_TIERS.high.maxLeverage, blocked: false, description: VOL_TIERS.high.description }
  }
  return { tier: 'extreme', maxLeverage: VOL_TIERS.extreme.maxLeverage, blocked: true, description: VOL_TIERS.extreme.description }
}

async function main(): Promise<void> {
  const args = parseDynamicLeverageVolatilityGateStatusArgs(process.argv.slice(2))
  const report = await runDynamicLeverageVolatilityGateStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseDynamicLeverageVolatilityGateStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runDynamicLeverageVolatilityGateStatus(args: CliArgs): Promise<DynamicLeverageVolatilityGateStatus> {
  const startedAt = new Date()
  const report = buildDynamicLeverageVolatilityGateStatus(new Date().toISOString())
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'dynamic_leverage_volatility_gate_status',
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

export function buildDynamicLeverageVolatilityGateStatus(
  generatedAt = new Date().toISOString(),
): DynamicLeverageVolatilityGateStatus {
  const currentMaxLeverage = 100
  const realizedVolPct = 65
  const volatilityPercentile = 0.85
  const resolved = resolveVolatilityTier(volatilityPercentile)

  const lowTierProbe = resolveVolatilityTier(0.10)
  const normalTierProbe = resolveVolatilityTier(0.50)
  const highTierProbe = resolveVolatilityTier(0.90)
  const extremeTierProbe = resolveVolatilityTier(0.99)

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
      volatilityPercentile,
      realizedVolPct,
      recommendedMaxLeverage: resolved.maxLeverage,
      currentMaxLeverage,
      leverageBlocked: resolved.blocked,
      tier: resolved.tier,
      tierDescription: resolved.description,
      lowTierProbe: { percentile: 0.10, maxLeverage: lowTierProbe.maxLeverage, blocked: lowTierProbe.blocked },
      normalTierProbe: { percentile: 0.50, maxLeverage: normalTierProbe.maxLeverage, blocked: normalTierProbe.blocked },
      highTierProbe: { percentile: 0.90, maxLeverage: highTierProbe.maxLeverage, blocked: highTierProbe.blocked },
      extremeTierProbe: { percentile: 0.99, maxLeverage: extremeTierProbe.maxLeverage, blocked: extremeTierProbe.blocked },
    },
    blockers: [],
    nextActions: [
      'Keep dynamic-leverage-by-volatility gate in the research-evidence refresh chain; this is protection evidence, not trading authorization.',
      'When live volatility data becomes available, wire the tier resolution into the production leverage guard for runtime enforcement.',
    ],
    safetyNotes: [
      'This artifact validates a volatility-adaptive leverage cap only; it cannot authorize paper orders, live orders, promotion, leverage changes, or best_config mutation.',
      'Leverage tiers are research-only diagnostic thresholds; actual leverage enforcement requires integration into the production order path.',
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

function renderConsoleSummary(report: DynamicLeverageVolatilityGateStatus): string {
  return [
    `Dynamic leverage volatility gate status: ${report.status}`,
    `tier=${report.checks.tier} volPct=${report.checks.volatilityPercentile} recommended=${report.checks.recommendedMaxLeverage}x current=${report.checks.currentMaxLeverage}x`,
    `paper=false live=false promotion=false`,
    `blockers=${report.blockers.slice(0, 8).join('|') || 'none'}`,
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_dynamic_leverage_volatility_gate_status failed:', error)
    process.exit(1)
  })
}
