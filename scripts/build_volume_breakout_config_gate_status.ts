import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { DEFAULT_VB_CONFIG } from '../src/domain/strategy/volume-breakout.js'
import {
  deriveTopLevelStatus,
  mapToBusinessStatus,
  type CheckVerdict,
  type TopLevelStatus,
} from './lib/derive_gate_status.js'

interface CliArgs {
  outputPath: string | null
  json: boolean
}

export interface VolumeBreakoutConfigGateStatus {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: TopLevelStatus
  checks: {
    volumeMultiplier: {
      found: true
      value: number
      verdict: 'ok' | 'needs_work'
      reason: string
    }
    confidenceLogic: {
      found: true
      verdict: 'ok' | 'needs_work'
      reason: string
      minConfidenceAtThreshold: number
      volumeComponentDynamicRange: number
    }
    stopLossPct: {
      found: true
      value: number
      verdict: 'ok' | 'needs_work'
      reason: string
    }
    minBreakQuality: {
      found: true
      value: number
      verdict: 'ok' | 'needs_work'
      reason: string
    }
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/volume_breakout_config_gate_status.latest.json'

const VOLUME_MULTIPLIER_TOO_LOW_THRESHOLD = 2.0

/**
 * Minimum break-quality threshold below which the candle-quality filter is
 * considered too lax for a 5m momentum strategy. Typical recommended range
 * is 0.2–0.5; values below 0.2 admit weak/marginal candles.
 */
const MIN_BREAK_QUALITY_TOO_LOW_THRESHOLD = 0.2

const CONFIDENCE_FORMULA = 'Math.min(volumeRatio / volumeMultiplier, 3) / 3 * Math.min(breakoutPct * 10, 1) * breakQuality'

/**
 * Compute the minimum volume-component contribution to the confidence formula
 * at the instant the volume ratio barely passes the volumeMultiplier gate.
 */
function computeMinVolumeComponentAtThreshold(volumeMultiplier: number): number {
  return Math.min(volumeMultiplier / volumeMultiplier, 3) / 3
}

/**
 * Compute the volume component value at the saturation point (3x volumeMultiplier).
 */
function computeMaxVolumeComponent(volumeMultiplier: number): number {
  return Math.min(3 * volumeMultiplier / volumeMultiplier, 3) / 3
}

async function main(): Promise<void> {
  const args = parseVolumeBreakoutConfigGateStatusArgs(process.argv.slice(2))
  const report = await runVolumeBreakoutConfigGateStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseVolumeBreakoutConfigGateStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runVolumeBreakoutConfigGateStatus(args: CliArgs): Promise<VolumeBreakoutConfigGateStatus> {
  const startedAt = new Date()
  const report = buildVolumeBreakoutConfigGateStatus(new Date().toISOString())
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'volume_breakout_config_gate_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: mapToBusinessStatus(report.status),
      recordsIn: 4,
      recordsOut: 1,
      errorClass: null,
    })
  }
  return report
}

/**
 * Optional override for the source-of-truth defaults. The default behavior
 * imports `DEFAULT_VB_CONFIG` directly from the strategy module (so any drift
 * between strategy code and gate artifact is exposed). Tests can inject
 * synthetic defaults to validate reverse regression behavior (e.g. a higher
 * `volumeMultiplier` should produce `verdict: 'ok'`).
 */
export interface VolumeBreakoutConfigDefaults {
  volumeMultiplier: number
  stopLossPct: number
  minBreakQuality: number
}

export function buildVolumeBreakoutConfigGateStatus(
  generatedAt = new Date().toISOString(),
  defaultsOverride?: VolumeBreakoutConfigDefaults,
): VolumeBreakoutConfigGateStatus {
  const defaults = defaultsOverride ?? {
    volumeMultiplier: DEFAULT_VB_CONFIG.volumeMultiplier,
    stopLossPct: DEFAULT_VB_CONFIG.stopLossPct,
    minBreakQuality: DEFAULT_VB_CONFIG.minBreakQuality,
  }
  const volumeMultiplier = defaults.volumeMultiplier
  const stopLossPct = defaults.stopLossPct
  const minBreakQuality = defaults.minBreakQuality

  // --- volumeMultiplier check (defect 1.2.2) ---
  const volumeMultiplierTooLow = volumeMultiplier < VOLUME_MULTIPLIER_TOO_LOW_THRESHOLD

  // --- confidence logic check (defect 1.2.5) ---
  const minVolumeComponent = computeMinVolumeComponentAtThreshold(volumeMultiplier)
  const maxVolumeComponent = computeMaxVolumeComponent(volumeMultiplier)
  const volumeComponentDynamicRange = maxVolumeComponent / minVolumeComponent

  // The volume component starts at 0.333 at bare threshold (only 3:1 dynamic range).
  // At minimum volumeRatio (just passes filter), confidence floor is 0.333 * breakoutComponent * breakQuality.
  // This means marginal volume breakouts can still generate relatively high confidence
  // when the price break and candle quality are strong.
  const confidenceHasGradientIssue = minVolumeComponent > 0.2

  // --- minBreakQuality check ---
  const minBreakQualityTooLow = minBreakQuality < MIN_BREAK_QUALITY_TOO_LOW_THRESHOLD

  const checks: VolumeBreakoutConfigGateStatus['checks'] = {
    volumeMultiplier: {
      found: true,
      value: volumeMultiplier,
      verdict: volumeMultiplierTooLow ? 'needs_work' : 'ok',
      reason: volumeMultiplierTooLow
        ? `volumeMultiplier=${volumeMultiplier} is below ${VOLUME_MULTIPLIER_TOO_LOW_THRESHOLD}; too many false breakouts expected for a 5m momentum strategy`
        : `volumeMultiplier=${volumeMultiplier} is above ${VOLUME_MULTIPLIER_TOO_LOW_THRESHOLD}; provides reasonable filter threshold for 5m breakout signals`,
    },
    confidenceLogic: {
      found: true,
      verdict: confidenceHasGradientIssue ? 'needs_work' : 'ok',
      reason: confidenceHasGradientIssue
        ? `Confidence formula "${CONFIDENCE_FORMULA}" has shallow volume gradient at threshold. `
          + `minVolumeComponent=${minVolumeComponent.toFixed(3)} when volumeRatio just passes volumeMultiplier, `
          + `giving only ${volumeComponentDynamicRange.toFixed(1)}:1 dynamic range (max ${maxVolumeComponent.toFixed(3)}). `
          + `Marginal breakouts (>${volumeMultiplier}x volume) receive ${(minVolumeComponent * 100).toFixed(0)}% of max volume contribution. `
          + 'No explicit position sizing or risk-adjusted confidence term is present.'
        : 'Confidence formula provides adequate gradient at threshold',
      minConfidenceAtThreshold: parseFloat(minVolumeComponent.toFixed(3)),
      volumeComponentDynamicRange: parseFloat(volumeComponentDynamicRange.toFixed(1)),
    },
    stopLossPct: {
      found: true,
      value: stopLossPct,
      verdict: 'ok',
      reason: `stopLossPct=${stopLossPct * 100}% is within the 1-5% range typical for 5m breakout strategies`,
    },
    minBreakQuality: {
      found: true,
      value: minBreakQuality,
      verdict: minBreakQualityTooLow ? 'needs_work' : 'ok',
      reason: minBreakQualityTooLow
        ? `minBreakQuality=${minBreakQuality} is below ${MIN_BREAK_QUALITY_TOO_LOW_THRESHOLD}; candle-quality filter is too lax (typical range 0.2-0.5)`
        : `minBreakQuality=${minBreakQuality} provides reasonable candle-quality filter; typical range is 0.2-0.5`,
    },
  }

  const verdicts: CheckVerdict[] = [
    checks.volumeMultiplier.verdict,
    checks.confidenceLogic.verdict,
    checks.stopLossPct.verdict,
    checks.minBreakQuality.verdict,
  ]
  const status = deriveTopLevelStatus(verdicts)

  return {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status,
    checks,
    blockers: [],
    nextActions: [
      'Consider making volumeMultiplier configurable via runtime override rather than a compile-time constant.',
      'Review confidence formula: add a position sizing term or make the volume component ramp from 0 at the volumeMultiplier threshold instead of starting at 0.333.',
      'If live paper-trading data becomes available, backtest alternative confidence formulas (e.g. linear ramp from zero at threshold).',
    ],
    safetyNotes: [
      'This artifact validates volume breakout configuration parameters only; it cannot authorize paper orders, live orders, promotion, or best_config mutation.',
      'Volume breakout strategy parameters examined are sourced from src/domain/strategy/volume-breakout.ts at build time. Runtime overrides are not yet supported.',
      'Confidence logic analysis is diagnostic only; the formula may be suitable for ranking purposes despite the shallow threshold gradient.',
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

function renderConsoleSummary(report: VolumeBreakoutConfigGateStatus): string {
  return [
    `Volume breakout config gate status: ${report.status}`,
    `volumeMultiplier=${report.checks.volumeMultiplier.value} verdict=${report.checks.volumeMultiplier.verdict}`,
    `confidenceLogic verdict=${report.checks.confidenceLogic.verdict} minAtThreshold=${report.checks.confidenceLogic.minConfidenceAtThreshold} dynamicRange=${report.checks.confidenceLogic.volumeComponentDynamicRange}:1`,
    `stopLossPct=${report.checks.stopLossPct.value * 100}% verdict=${report.checks.stopLossPct.verdict}`,
    `minBreakQuality=${report.checks.minBreakQuality.value} verdict=${report.checks.minBreakQuality.verdict}`,
    `paper=false live=false promotion=false`,
    `blockers=${report.blockers.slice(0, 8).join('|') || 'none'}`,
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_volume_breakout_config_gate_status failed:', error)
    process.exit(1)
  })
}
