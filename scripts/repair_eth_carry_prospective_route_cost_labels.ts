import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { appendJsonlSync } from '../src/runtime/runtime_events.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import {
  readEthCarryProspectiveLedgerEvents,
  type EthCarryProspectiveObservationOutcome,
} from './settle_eth_carry_prospective_observations.js'

type UnknownRecord = Record<string, unknown>

interface CliArgs {
  ledgerPath: string
  feeSnapshotPath: string
  outputPath: string | null
  asOfMs: number | null
  dryRun: boolean
  json: boolean
}

interface RuntimeFeeSnapshotEvidence {
  usable: boolean
  sourceFetchedAt: string | null
  expiresAt: string | null
  makerFeeBps: number | null
  takerFeeBps: number | null
  routeCostPct: number | null
}

export interface EthCarryRouteCostLabelRepairReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  dryRun: boolean
  status: 'repaired' | 'nothing_to_repair' | 'blocked'
  inputs: {
    ledgerPath: string
    feeSnapshotPath: string
    outputPath: string | null
    asOfMs: number | null
  }
  feeEvidence: RuntimeFeeSnapshotEvidence
  counts: {
    closedOutcomesLoaded: number
    missingRouteCostClosedOutcomes: number
    restatementsBuilt: number
    restatementsAppended: number
  }
  restatements: EthCarryProspectiveObservationOutcome[]
  blockers: string[]
  safetyNotes: string[]
}

const DEFAULT_LEDGER_PATH = 'data/research/eth_carry_prospective_observations.jsonl'
const DEFAULT_FEE_SNAPSHOT_PATH = 'data/runtime/fee_snapshot.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/research/eth_carry_prospective_route_cost_label_repair.latest.json'

async function main(): Promise<void> {
  const args = parseEthCarryRouteCostLabelRepairArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runEthCarryRouteCostLabelRepair(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'eth_carry_prospective_route_cost_label_repair',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: report.status === 'blocked' ? 1 : 0,
      businessStatus: report.status === 'blocked' ? 'fail' : 'warn',
      recordsIn: report.counts.closedOutcomesLoaded,
      recordsOut: report.counts.restatementsAppended,
      errorClass: report.blockers[0] ?? null,
    })
  }
}

export function parseEthCarryRouteCostLabelRepairArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    ledgerPath: raw.get('ledgerPath') ?? raw.get('ledger') ?? DEFAULT_LEDGER_PATH,
    feeSnapshotPath: raw.get('feeSnapshotPath') ?? DEFAULT_FEE_SNAPSHOT_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    asOfMs: parseNullableTimestamp(raw.get('asOf')),
    dryRun: parseBool(raw.get('dryRun'), true),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runEthCarryRouteCostLabelRepair(
  args: CliArgs,
): Promise<EthCarryRouteCostLabelRepairReport> {
  const ledgerPath = resolve(args.ledgerPath)
  const feeSnapshotPath = resolve(args.feeSnapshotPath)
  const asOfMs = args.asOfMs ?? Date.now()
  const generatedAt = new Date().toISOString()
  const feeEvidence = readRuntimeFeeSnapshotEvidence(feeSnapshotPath, asOfMs)
  const closed = readEthCarryProspectiveLedgerEvents(ledgerPath).closed
  const blockers = [
    ...(existsSync(ledgerPath) ? [] : ['prospective_observation_ledger_missing']),
    ...(feeEvidence.usable ? [] : ['runtime_fee_snapshot_not_usable_for_restatement']),
  ]
  const missingRouteCost = closed.filter(outcome => outcome.label.routeCostAdjusted !== true)
  const restatements = blockers.length === 0
    ? missingRouteCost.map(outcome => restateOutcome(outcome, feeEvidence, generatedAt))
    : []

  if (!args.dryRun && blockers.length === 0) {
    for (const restatement of restatements) appendJsonlSync(ledgerPath, restatement)
  }

  const report: EthCarryRouteCostLabelRepairReport = {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    dryRun: args.dryRun,
    status: blockers.length > 0
      ? 'blocked'
      : restatements.length > 0
        ? 'repaired'
        : 'nothing_to_repair',
    inputs: {
      ledgerPath,
      feeSnapshotPath,
      outputPath: args.outputPath ? resolve(args.outputPath) : null,
      asOfMs: args.asOfMs,
    },
    feeEvidence,
    counts: {
      closedOutcomesLoaded: closed.length,
      missingRouteCostClosedOutcomes: missingRouteCost.length,
      restatementsBuilt: restatements.length,
      restatementsAppended: args.dryRun || blockers.length > 0 ? 0 : restatements.length,
    },
    restatements,
    blockers,
    safetyNotes: [
      'This repair is append-only: historical ledger rows are not deleted or overwritten.',
      'Restated labels remain research-only prospective evidence and cannot authorize paper or live orders.',
      'The restatement only fills conservative route-cost-adjusted labels from a valid runtime fee snapshot.',
    ],
  }

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  }

  return report
}

function restateOutcome(
  outcome: EthCarryProspectiveObservationOutcome,
  feeEvidence: RuntimeFeeSnapshotEvidence,
  restatedAt: string,
): EthCarryProspectiveObservationOutcome {
  if (feeEvidence.routeCostPct == null) throw new Error('route cost repair requires routeCostPct')
  const fundingCashflowPct = outcome.label.fundingCashflowPct ?? 0
  const routeCostAdjustedNetPct = round(
    outcome.label.grossCarryPairReturnPct + fundingCashflowPct - feeEvidence.routeCostPct,
    10,
  )
  return {
    ...outcome,
    outcomeId: hashId([
      'eth_carry_prospective_outcome_restatement',
      outcome.observationId,
      outcome.outcomeId,
      restatedAt,
    ]),
    label: {
      ...outcome.label,
      routeCostAdjusted: true,
      routeCostPct: feeEvidence.routeCostPct,
      routeCostAdjustedNetPct,
      routeCostAdjustmentStatus: 'adjusted_with_runtime_verified_fee_snapshot',
    },
    blockers: uniqueStrings(outcome.blockers.filter(blocker => blocker !== 'route_cost_adjusted_label_missing')),
    restatement: {
      restatedAt,
      originalOutcomeId: outcome.outcomeId,
      reason: 'route_cost_adjustment_restatement',
      feeSnapshotSourceFetchedAt: feeEvidence.sourceFetchedAt,
      feeSnapshotExpiresAt: feeEvidence.expiresAt,
      routeCostPct: feeEvidence.routeCostPct,
    },
  }
}

function readRuntimeFeeSnapshotEvidence(path: string, asOfMs: number): RuntimeFeeSnapshotEvidence {
  const fallback: RuntimeFeeSnapshotEvidence = {
    usable: false,
    sourceFetchedAt: null,
    expiresAt: null,
    makerFeeBps: null,
    takerFeeBps: null,
    routeCostPct: null,
  }
  if (!existsSync(path)) return fallback
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as UnknownRecord
    const source = readString(parsed.source)
    const verifiedByRuntime = parsed.verifiedByRuntime === true
    const expiresAt = readString(parsed.expiresAt)
    const expiresAtMs = expiresAt == null ? null : Date.parse(expiresAt)
    const makerFeeBps = readNumber(parsed.makerFeeBps)
    const takerFeeBps = readNumber(parsed.takerFeeBps)
    const conservativeLegFeeBps = Math.max(makerFeeBps ?? 0, takerFeeBps ?? 0)
    const usable = source === 'api'
      && verifiedByRuntime
      && expiresAtMs != null
      && Number.isFinite(expiresAtMs)
      && expiresAtMs > asOfMs
      && conservativeLegFeeBps > 0
    return {
      usable,
      sourceFetchedAt: readString(parsed.sourceFetchedAt),
      expiresAt,
      makerFeeBps,
      takerFeeBps,
      routeCostPct: usable ? round((conservativeLegFeeBps * 4) / 100, 10) : null,
    }
  } catch {
    return fallback
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const parsed = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      parsed.set(key, next)
      index += 1
    } else {
      parsed.set(key, 'true')
    }
  }
  return parsed
}

function parseNullablePath(value: string | undefined): string | null {
  if (value == null) return null
  if (value === 'null' || value === 'none' || value === '') return null
  return value
}

function parseNullableTimestamp(value: string | undefined): number | null {
  if (value == null || value === 'null') return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`invalid timestamp: ${value}`)
  return parsed
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  if (['1', 'true', 'yes'].includes(value.toLowerCase())) return true
  if (['0', 'false', 'no'].includes(value.toLowerCase())) return false
  return fallback
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function hashId(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)
}

function renderConsoleSummary(report: EthCarryRouteCostLabelRepairReport): string {
  return [
    `eth carry route-cost label repair: status=${report.status} dryRun=${report.dryRun}`,
    `missing=${report.counts.missingRouteCostClosedOutcomes}, built=${report.counts.restatementsBuilt}, appended=${report.counts.restatementsAppended}`,
    `paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `blockers=${report.blockers.join(',')}` : 'blockers=none',
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('repair_eth_carry_prospective_route_cost_labels failed:', error)
    process.exitCode = 1
  })
}
