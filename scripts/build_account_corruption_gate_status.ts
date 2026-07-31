import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

interface CliArgs {
  outputPath: string | null
  json: boolean
  accountStateDir: string
}

interface AccountFileCheck {
  file: string
  corrupt: boolean
  error: string | null
}

export interface AccountCorruptionGateStatus {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: 'pass' | 'block'
  checks: {
    accountFilesExist: { found: boolean; count: number; verdict: string }
    corruptFiles: { found: boolean; corruptCount: number; verdict: string }
    failClosedMechanism: { found: boolean; verdict: string }
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/account_corruption_gate_status.latest.json'
const ACCOUNT_STATE_DIR = 'data/paper_trading'

export async function scanAccountStateFiles(dir: string): Promise<AccountFileCheck[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const jsonFiles = entries.filter(f => extname(f).toLowerCase() === '.json')
  const results: AccountFileCheck[] = []

  for (const file of jsonFiles) {
    const filePath = resolve(dir, file)
    try {
      const content = await readFile(filePath, 'utf-8')
      JSON.parse(content)
      results.push({ file, corrupt: false, error: null })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      results.push({ file, corrupt: true, error: message })
    }
  }

  return results
}

async function main(): Promise<void> {
  const args = parseAccountCorruptionGateStatusArgs(process.argv.slice(2))
  const report = await runAccountCorruptionGateStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseAccountCorruptionGateStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
    accountStateDir: raw.get('accountStateDir') ?? raw.get('account-state-dir') ?? ACCOUNT_STATE_DIR,
  }
}

export async function runAccountCorruptionGateStatus(args: CliArgs): Promise<AccountCorruptionGateStatus> {
  const startedAt = new Date()
  const report = await buildAccountCorruptionGateStatus(new Date().toISOString(), args.accountStateDir)
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'account_corruption_gate_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'pass' ? 'pass' : 'fail',
      recordsIn: report.checks.accountFilesExist.count,
      recordsOut: 1,
      errorClass: null,
    })
  }
  return report
}

export async function buildAccountCorruptionGateStatus(
  generatedAt = new Date().toISOString(),
  accountStateDir = ACCOUNT_STATE_DIR,
): Promise<AccountCorruptionGateStatus> {
  const accountDir = resolve(accountStateDir)
  const fileChecks = await scanAccountStateFiles(accountDir)

  const totalFiles = fileChecks.length
  const corruptFiles = fileChecks.filter(f => f.corrupt)
  const anyCorruptFiles = corruptFiles.length > 0

  const accountFilesExist = {
    found: totalFiles > 0,
    count: totalFiles,
    verdict: totalFiles > 0
      ? `${totalFiles} account state file(s) found`
      : 'No state files found in data/paper_trading (this is normal)',
  }

  const corruptCheck = {
    found: anyCorruptFiles,
    corruptCount: corruptFiles.length,
    verdict: anyCorruptFiles
      ? `${corruptFiles.length} corrupt file(s) detected: ${corruptFiles.map(f => f.file).join(', ')}`
      : `All ${totalFiles} account state file(s) parsed successfully`,
  }

  const failClosedMechanism = {
    found: anyCorruptFiles,
    verdict: anyCorruptFiles
      ? 'Corrupt files detected; fail-closed mechanism should block execution'
      : 'No corruption detected; fail-closed mechanism not triggered',
  }

  const blockers: string[] = []
  if (anyCorruptFiles) {
    blockers.push(`Account state corruption detected: ${corruptFiles.length} file(s) failed integrity check`)
  }

  return {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: anyCorruptFiles ? 'block' : 'pass',
    checks: {
      accountFilesExist,
      corruptFiles: corruptCheck,
      failClosedMechanism,
    },
    blockers,
    nextActions: [
      'Keep account corruption gate in the research-evidence refresh chain; this is integrity evidence, not trading authorization.',
      'If corrupt files are detected, investigate and restore from backup before clearing the gate.',
    ],
    safetyNotes: [
      'This artifact validates account state file integrity only; it cannot authorize paper orders, live orders, promotion, or best_config mutation.',
      'Corrupt account state files may indicate disk issues or concurrent write conflicts; manual investigation required.',
      'An empty data/paper_trading directory is normal (no paper trading has occurred yet).',
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

function renderConsoleSummary(report: AccountCorruptionGateStatus): string {
  return [
    `Account corruption gate status: ${report.status}`,
    `files=${report.checks.accountFilesExist.count} corrupt=${report.checks.corruptFiles.corruptCount}`,
    `paper=false live=false promotion=false`,
    `blockers=${report.blockers.slice(0, 8).join('|') || 'none'}`,
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_account_corruption_gate_status failed:', error)
    process.exit(1)
  })
}
