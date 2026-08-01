import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type Status = 'pass' | 'fail'

interface CheckResult<T = unknown> {
  found: boolean
  value: T | null
  verdict: string
}

interface CliArgs {
  outputPath: string | null
  json: boolean
}

export interface KillSwitchGateStatus {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: Status
  killSwitchEnabled: boolean
  defaultPolicy: string | null
  researchOnlyBlockedConsistent: boolean
  checks: {
    killSwitchEnabled: CheckResult<boolean>
    defaultPolicy: CheckResult<string>
    consistentWithState: CheckResult<boolean>
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/kill_switch_gate_status.latest.json'

interface KillSwitchConfig {
  defaultPolicy?: string
}

interface RiskConfig {
  killSwitch?: boolean
}

interface KillSwitchGateSources {
  killSwitchConfig?: KillSwitchConfig | null
  riskConfig?: RiskConfig | null
}

async function main(): Promise<void> {
  const args = parseKillSwitchGateStatusArgs(process.argv.slice(2))
  const report = await runKillSwitchGateStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseKillSwitchGateStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runKillSwitchGateStatus(
  args: CliArgs,
  sources?: KillSwitchGateSources,
): Promise<KillSwitchGateStatus> {
  const startedAt = new Date()
  const report = await buildKillSwitchGateStatus(new Date().toISOString(), sources)
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'kill_switch_gate_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status,
      recordsIn: 2,
      recordsOut: 1,
      errorClass: report.status === 'pass' ? null : 'kill_switch_configuration_incomplete',
    })
  }
  return report
}

export async function buildKillSwitchGateStatus(
  generatedAt = new Date().toISOString(),
  sources?: KillSwitchGateSources,
): Promise<KillSwitchGateStatus> {
  const killSwitchConfig = sources && 'killSwitchConfig' in sources
    ? sources.killSwitchConfig ?? null
    : await readJsonSafe<KillSwitchConfig>('data/config/kill-switch.json')
  const riskConfig = sources && 'riskConfig' in sources
    ? sources.riskConfig ?? null
    : await readJsonSafe<RiskConfig>('data/config/risk.json')

  const killSwitchFound = riskConfig != null && riskConfig.killSwitch !== undefined
  const killSwitchEnabled = killSwitchFound ? Boolean(riskConfig!.killSwitch) : false

  const defaultPolicyFound = killSwitchConfig != null && killSwitchConfig.defaultPolicy !== undefined
  const defaultPolicy = defaultPolicyFound ? (killSwitchConfig!.defaultPolicy ?? null) : null

  const consistentWithStateFound = killSwitchFound && defaultPolicyFound
  const blockingPolicies = ['block_new_only', 'block_all']
  const defaultPolicyValid = defaultPolicy != null && blockingPolicies.includes(defaultPolicy)
  const consistentWithState = consistentWithStateFound && defaultPolicyValid

  const killSwitchCheck: CheckResult<boolean> = {
    found: killSwitchFound,
    value: killSwitchEnabled,
    verdict: killSwitchFound ? 'pass' : 'fail',
  }

  const defaultPolicyCheck: CheckResult<string> = {
    found: defaultPolicyFound,
    value: defaultPolicy,
    verdict: defaultPolicyValid ? 'pass' : 'fail',
  }

  const consistentWithStateCheck: CheckResult<boolean> = {
    found: consistentWithStateFound,
    value: consistentWithState,
    verdict: consistentWithStateFound && consistentWithState ? 'pass' : 'fail',
  }

  const researchOnlyBlockedConsistent = !killSwitchEnabled || consistentWithState
  const blockers = [
    ...(killSwitchFound ? [] : ['risk_config_kill_switch_missing']),
    ...(defaultPolicyFound ? [] : ['kill_switch_default_policy_missing']),
    ...(defaultPolicyFound && !defaultPolicyValid ? [`kill_switch_default_policy_invalid:${defaultPolicy ?? 'null'}`] : []),
    ...(consistentWithStateFound && consistentWithState ? [] : ['kill_switch_state_not_verifiably_consistent']),
  ]
  const status: Status = blockers.length === 0 ? 'pass' : 'fail'

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
    killSwitchEnabled,
    defaultPolicy,
    researchOnlyBlockedConsistent,
    checks: {
      killSwitchEnabled: killSwitchCheck,
      defaultPolicy: defaultPolicyCheck,
      consistentWithState: consistentWithStateCheck,
    },
    blockers,
    nextActions: [
      'Keep kill-switch gate in the research-evidence refresh chain; this is protection evidence, not trading authorization.',
      'If killSwitch state changes or defaultPolicy is updated, re-run this gate to confirm consistency.',
    ],
    safetyNotes: [
      'This artifact validates kill-switch configuration consistency only; it cannot authorize paper orders, live orders, promotion, leverage changes, or best_config mutation.',
      'Kill-switch gates are research-only diagnostic checks; actual kill-switch enforcement requires integration into the production order path.',
    ],
  }
}

async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
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

function renderConsoleSummary(report: KillSwitchGateStatus): string {
  return [
    `Kill-switch gate status: ${report.status}`,
    `killSwitchEnabled=${report.killSwitchEnabled} defaultPolicy=${report.defaultPolicy ?? 'null'} consistent=${report.researchOnlyBlockedConsistent}`,
    `paper=false live=false promotion=false`,
    `blockers=${report.blockers.slice(0, 8).join('|') || 'none'}`,
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_kill_switch_gate_status failed:', error)
    process.exit(1)
  })
}
