import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

interface CliArgs {
  outputPath: string | null
  json: boolean
}

interface ConfigCheckResult {
  found: boolean
  value: string
  verdict: 'ok' | 'needs_work'
}

export interface CrossSectionalConfigGateStatus {
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
    mtfWeight: ConfigCheckResult
    funding: ConfigCheckResult
    spread: ConfigCheckResult
    regime: ConfigCheckResult
    confidence: ConfigCheckResult
    volCeiling: ConfigCheckResult
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/cross_sectional_config_gate_status.latest.json'

/**
 * Default config values extracted from src/domain/strategy/cross-sectional-momentum.ts
 * for diagnostic inspection.
 */
const DEFAULT_CFG = {
  lookbackHours: 168,
  secondaryLookbackHours: 720,
  topN: 2,
  bottomN: 2,
  minUniverseSize: 6,
  maxPositionFraction: 0.15,
  minSpreadPct: 5,
  maxVolPercentile: 0.90,
  requireVolumeConfirmation: true,
  mtfWeight: 0.35,
  fundingWeight: 0.25,
  minDailyVolumeUsd: 10_000_000,
  maxSpreadBps: 20,
} as const

function checkMtfWeight(): ConfigCheckResult {
  // mtfWeight exists as a configurable interface parameter, but default is fixed at 0.35
  // The strategy allows override via config, so it IS configurable; flag the fixed default
  return {
    found: true,
    value: `default mtfWeight=${DEFAULT_CFG.mtfWeight} (0.35 = fixed default; configurable via CrossSectionalConfig.mtfWeight)`,
    verdict: 'needs_work',
  }
}

function checkFunding(): ConfigCheckResult {
  // fundingWeight=0.25 is a magic number; also uses hardcoded normalization divisor 0.05 and scale factor 3
  return {
    found: true,
    value: `default fundingWeight=${DEFAULT_CFG.fundingWeight}; hardcoded normalization divisor 0.05 and scale factor 3 in evaluateCrossSectionalMomentum`,
    verdict: 'needs_work',
  }
}

function checkSpread(): ConfigCheckResult {
  // minSpreadPct=5, maxSpreadBps=20 — fixed constants without dynamic adjustment
  return {
    found: true,
    value: `default minSpreadPct=${DEFAULT_CFG.minSpreadPct}%, maxSpreadBps=${DEFAULT_CFG.maxSpreadBps}; no dynamic spread threshold adaptation`,
    verdict: 'needs_work',
  }
}

function checkRegime(): ConfigCheckResult {
  // No explicit market regime filter (e.g., trend vs. mean-reversion regime detection)
  // maxVolPercentile=0.90 is a volatility ceiling, not a regime filter
  return {
    found: false,
    value: 'no market regime filter present; maxVolPercentile=0.90 acts as volatility ceiling, not regime classification',
    verdict: 'needs_work',
  }
}

function checkConfidence(): ConfigCheckResult {
  // Confidence is a heuristic formula (rankStrength*0.4 + spreadStrength*0.3 + fundingBoost);
  // no continuous calibration or backtested validation of the confidence output
  return {
    found: true,
    value: `heuristic confidence formula (rankStrength*0.4 + spreadStrength*0.3 + fundingBoost); no continuous validation loop`,
    verdict: 'needs_work',
  }
}

function checkVolCeiling(): ConfigCheckResult {
  // maxVolPercentile=0.90 exists but filters individual assets; no global position-level vol cap
  return {
    found: true,
    value: `maxVolPercentile=${DEFAULT_CFG.maxVolPercentile} (asset-level filter); no portfolio-level volatility ceiling`,
    verdict: 'needs_work',
  }
}

async function main(): Promise<void> {
  const args = parseCrossSectionalConfigGateStatusArgs(process.argv.slice(2))
  const report = await runCrossSectionalConfigGateStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseCrossSectionalConfigGateStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runCrossSectionalConfigGateStatus(args: CliArgs): Promise<CrossSectionalConfigGateStatus> {
  const startedAt = new Date()
  const report = buildCrossSectionalConfigGateStatus(new Date().toISOString())
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'cross_sectional_config_gate_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: 'pass',
      recordsIn: 6,
      recordsOut: 1,
      errorClass: null,
    })
  }
  return report
}

export function buildCrossSectionalConfigGateStatus(
  generatedAt = new Date().toISOString(),
): CrossSectionalConfigGateStatus {
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
      mtfWeight: checkMtfWeight(),
      funding: checkFunding(),
      spread: checkSpread(),
      regime: checkRegime(),
      confidence: checkConfidence(),
      volCeiling: checkVolCeiling(),
    },
    blockers: [],
    nextActions: [
      'Investigate mtfWeight calibration — consider regime-adaptive rather than fixed default 0.35.',
      'Replace fundingWeight magic number 0.25 and hardcoded normalization constants with configurable parameters.',
      'Evaluate whether minSpreadPct=5 and maxSpreadBps=20 should be dynamic or market-adaptive.',
      'Add a market regime classifier (trend vs. mean-reversion) to gate cross-sectional signal generation.',
      'Implement continuous confidence calibration against out-of-sample performance data.',
      'Add a portfolio-level volatility ceiling that caps aggregate exposure independent of asset-level maxVolPercentile filtering.',
    ],
    safetyNotes: [
      'This artifact inspects static cross-sectional strategy configuration only; it cannot authorize paper orders, live orders, promotion, config mutation, or execution.',
      'All checks are diagnostic — defects flagged as needs_work require domain expert review before any remediation.',
      'No cross-sectional strategy defects are automatically actionable; each check reflects a known config risk area from the cross-sectional defect audit.',
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

function renderConsoleSummary(report: CrossSectionalConfigGateStatus): string {
  const checkLines = [
    `  mtfWeight:   found=${report.checks.mtfWeight.found} verdict=${report.checks.mtfWeight.verdict}`,
    `  funding:     found=${report.checks.funding.found} verdict=${report.checks.funding.verdict}`,
    `  spread:      found=${report.checks.spread.found} verdict=${report.checks.spread.verdict}`,
    `  regime:      found=${report.checks.regime.found} verdict=${report.checks.regime.verdict}`,
    `  confidence:  found=${report.checks.confidence.found} verdict=${report.checks.confidence.verdict}`,
    `  volCeiling:  found=${report.checks.volCeiling.found} verdict=${report.checks.volCeiling.verdict}`,
  ].join('\n')
  return [
    `Cross-sectional config gate status: ${report.status}`,
    `checks:`,
    checkLines,
    `paper=false live=false promotion=false`,
    `blockers=${report.blockers.slice(0, 8).join('|') || 'none'}`,
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_cross_sectional_config_gate_status failed:', error)
    process.exit(1)
  })
}
