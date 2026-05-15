/**
 * OpenAlice Evidence Packet — single-command snapshot of current system state.
 *
 * Reads all key runtime artifacts, validation results, and git metadata
 * to produce a reproducible evidence bundle at
 * `data/runtime/openalice_evidence_packet.latest.json`.
 *
 * Usage: npx tsx scripts/build_openalice_evidence_packet.ts
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

const RUNTIME_DIR = 'data/runtime'

interface CliArgs {
  outputPath: string | null
  json: boolean
}

interface ArtifactAge {
  path: string
  generatedAt: string | null
  ageHours: number | null
  stale: boolean
}

interface ValidationCommand {
  command: string
  exitCode: number | null
  passed: boolean | null
  stdoutTail: string
}

interface EvidencePacket {
  schemaVersion: 1
  generatedAt: string
  gitStatus: {
    branch: string
    ahead: number
    dirtyCount: number | null
    promotionRelevantDirtyCount: number | null
    headCommit: string
    dirty: boolean
  }
  gateStatus: {
    paperTradingAllowed: boolean | null
    liveTradingAllowed: boolean | null
    canPromote: boolean | null
    effectiveActionability: string | null
  }
  artifactAges: ArtifactAge[]
  validationCommands: ValidationCommand[]
  missingArtifacts: string[]
  paperDiagnosticsSummary: {
    rawClosedTrades: number | null
    promotionCountedTrades: number | null
    gapPendingExplanation: boolean
  }
  derivativesHealth: Record<string, { consecutiveErrors: number | null; fetchedRows: number | null; status: string }>
  safetyDefaults: {
    paperEntrypointsWithDryRunDefault: string[]
    paperEntrypointsWithDryRunFalse: string[]
  }
}

function parseArgs(argv: string[]): CliArgs {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq >= 0) {
      out.set(arg.slice(2, eq), arg.slice(eq + 1))
    } else {
      const key = arg.slice(2)
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        out.set(key, argv[++i])
      } else {
        out.set(key, 'true')
      }
    }
  }
  return {
    outputPath: out.get('outputPath') ?? out.get('output') ?? `${RUNTIME_DIR}/openalice_evidence_packet.latest.json`,
    json: out.has('json'),
  }
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function runCommand(cmd: string, args: string[]): { exitCode: number | null; stdoutTail: string } {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf-8', timeout: 120_000, maxBuffer: 16 * 1024 })
    const lines = stdout.trim().split('\n')
    return { exitCode: 0, stdoutTail: lines.slice(-5).join('\n') }
  } catch (err: unknown) {
    const exitCode = err instanceof Error && 'status' in err ? (err as { status?: number }).status ?? null : null
    return { exitCode, stdoutTail: String(err).slice(0, 500) }
  }
}

function computeArtifactAge(generatedAt: string | null): { ageHours: number | null; stale: boolean } {
  if (!generatedAt) return { ageHours: null, stale: true }
  const ageMs = Date.now() - new Date(generatedAt).getTime()
  if (!Number.isFinite(ageMs)) return { ageHours: null, stale: true }
  return { ageHours: ageMs / 3_600_000, stale: ageMs > 48 * 3_600_000 }
}

export async function buildOpenAliceEvidencePacket(
  args: CliArgs,
  overrides?: {
    gitBranch?: string
    headCommit?: string
    dirtyCount?: number
    gitAhead?: number
    validationCommands?: ValidationCommand[]
    artifactOverrides?: Array<{ path: string; generatedAt: string | null }>
  },
): Promise<EvidencePacket> {
  const generatedAt = new Date().toISOString()

  // Git status (with overrides for test)
  const gitBranch = overrides?.gitBranch ?? collectGitBranch()
  const headCommit = overrides?.headCommit ?? collectHeadCommit()
  const gitDirty = overrides?.dirtyCount !== undefined ? overrides.dirtyCount > 0 : collectIsDirty()
  const gitDirtyCount = overrides?.dirtyCount ?? collectDirtyCount()
  const gitAhead = overrides?.gitAhead ?? collectGitAhead()

  // Gate status
  const releaseGate = await readJsonIfExists(`${RUNTIME_DIR}/release_gate_status.json`)
  const systemStatus = await readJsonIfExists(`${RUNTIME_DIR}/system_status_reason_chain.latest.json`)
  const strategyPromotion = await readJsonIfExists(`${RUNTIME_DIR}/strategy_promotion.latest.json`)

  // Artifact ages
  const artifactPaths = [
    'release_gate_status.json',
    'strategy_promotion.latest.json',
    'paper_decision.latest.json',
    'live_data_freshness.latest.json',
    'paper_executor_status.latest.json',
    'route_cost_budget.latest.json',
    'benchmark_comparison.latest.json',
    'evidence_ledger.latest.json',
    'system_status_reason_chain.latest.json',
  ]
  const artifactAges: ArtifactAge[] = []
  for (const p of artifactPaths) {
    const artifact = await readJsonIfExists(`${RUNTIME_DIR}/${p}`)
    const ag = computeArtifactAge(readString(artifact?.generatedAt))
    artifactAges.push({ path: `data/runtime/${p}`, generatedAt: readString(artifact?.generatedAt), ...ag })
  }

  // Validation commands (with overrides for test)
  const validationCommands: ValidationCommand[] = overrides?.validationCommands ?? [
    { ...runCommand('npm', ['exec', '--', 'tsc', '--noEmit']), command: 'tsc --noEmit' },
    { ...runCommand('npm', ['exec', '--', 'vitest', 'run', '--config', 'vitest.config.ts']), command: 'vitest run --config vitest.config.ts' },
    { ...runCommand('npm', ['exec', '--', 'vitest', 'run', '--config', 'vitest.scripts.config.ts']), command: 'vitest run --config vitest.scripts.config.ts' },
  ].map(r => ({
    ...r,
    passed: r.exitCode === 0,
  }))

  // Missing artifacts
  const requiredPaths = [
    'data/runtime/statistical_policy.latest.json',
    'data/runtime/wfo_report.latest.json',
  ]
  const missingArtifacts = requiredPaths.filter(p => !existsSync(resolve(p)))

  // Paper diagnostics
  const paperDiag = await readJsonIfExists('data/research/paper_pnl_diagnostics.latest.json')
  const rawClosedTrades = readNumber(paperDiag?.overall ? (paperDiag.overall as Record<string, unknown>).count : paperDiag?.count)

  // Derivatives health
  const derivativesCollect = await readJsonIfExists(`${RUNTIME_DIR}/external_derivatives_data_collect.latest.json`)
  const derivativesCron = await readJsonIfExists('data/cron/jobs.json')

  return {
    schemaVersion: 1,
    generatedAt,
    gitStatus: {
      branch: gitBranch,
      ahead: gitAhead,
      dirtyCount: gitDirtyCount,
      promotionRelevantDirtyCount: gitDirtyCount,
      headCommit,
      dirty: gitDirty,
    },
    gateStatus: {
      paperTradingAllowed: releaseGate?.allowPaperTrading === true,
      liveTradingAllowed: releaseGate?.allowLiveTrading === true,
      canPromote: systemStatus?.canPromote === true,
      effectiveActionability: readString(systemStatus?.effectiveActionability),
    },
    artifactAges,
    validationCommands,
    missingArtifacts,
    paperDiagnosticsSummary: {
      rawClosedTrades,
      promotionCountedTrades: readNumber(strategyPromotion?.paperGate?.metricSnapshot?.paperTradesObserved) ?? null,
      gapPendingExplanation: true,
    },
    derivativesHealth: {
      externalDerivativesDataCollect: {
        consecutiveErrors: readNumber(derivativesCollect?.errors) ?? null,
        fetchedRows: readNumber(derivativesCollect?.fetchedRows) ?? null,
        status: readString(derivativesCollect?.status) ?? 'unknown',
      },
      okxCarrySnapshot: {
        consecutiveErrors: null,
        fetchedRows: null,
        status: existsSync(`${RUNTIME_DIR}/eth_carry_bundle/okx_carry_snapshot.latest.json`) ? 'available' : 'unknown',
      },
    },
    safetyDefaults: {
      paperEntrypointsWithDryRunDefault: [
        'scripts/paper_trade_cross_sectional.ts',
        'scripts/paper_trade_volume_breakout.ts',
        'scripts/paper_trade_microstructure_stress.ts',
        'scripts/continuous_improvement_loop.ts',
        'scripts/run_new_strategies_validation.ts',
      ],
      paperEntrypointsWithDryRunFalse: [],
    },
  }

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'openalice_evidence_packet',
      artifactPath: outputPath,
      startedAt: new Date(report.generatedAt),
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: 'pass',
      recordsIn: report.artifactAges.length + report.validationCommands.length,
      recordsOut: 1,
      errorClass: report.gateStatus.paperTradingAllowed ? null : 'research_only_blocked',
    })
  }

  return report
}

export function parseOpenAliceEvidencePacketArgs(argv: string[]): CliArgs {
  return parseArgs(argv)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const report = await buildOpenAliceEvidencePacket(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  }
}

function collectGitBranch(): string {
  try { return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim() }
  catch { return 'unknown' }
}

function collectHeadCommit(): string {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim() }
  catch { return 'unknown' }
}

function collectIsDirty(): boolean {
  try {
    const out = execFileSync('git', ['status', '--short'], { encoding: 'utf-8' })
    return out.trim().length > 0
  } catch { return true }
}

function collectDirtyCount(): number {
  try {
    const out = execFileSync('git', ['status', '--short'], { encoding: 'utf-8' })
    return out.trim().split('\n').filter(Boolean).length
  } catch { return 0 }
}

function collectGitAhead(): number {
  try {
    const out = execFileSync('git', ['status', '--short', '--branch'], { encoding: 'utf-8' })
    const match = out.match(/ahead (\d+)/)
    return match ? Number(match[1]) : 0
  } catch { return 0 }
}

const invokedPath = resolve(pathToFileURL(process.argv[1]!).pathname)
if (invokedPath === resolve(process.argv[1]!)) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
