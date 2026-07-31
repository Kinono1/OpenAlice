import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>

interface CliArgs {
  pitFeaturePath: string
  outputPath: string | null
  maxPairSkewMs: number
  json: boolean
}

interface PitAuditRow {
  featureId: string
  decisionAvailableAt: string | null
  decisionAvailableAtMs: number | null
  decisionAvailableAtConsistent: boolean
  pairSkewMs: number | null
  pairSkewWithinThreshold: boolean
  explicitAvailableAt: boolean
  fundingRateCashflow: boolean
  basisSpread: boolean
  blockers: string[]
}

export interface EthCarryPitAuditReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionAllowed: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  status: 'pass' | 'blocked'
  pitFeaturePath: string
  thresholds: {
    maxPairSkewMs: number
    requireExplicitAvailableAt: true
    requireFundingRateCashflow: true
    requireBasisSpread: true
  }
  counts: {
    carryFeatureRows: number
    auditedRows: number
    passingRows: number
    failingRows: number
  }
  rows: PitAuditRow[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_PIT_FEATURE_PATH = 'data/research/eth_carry_pit_features.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/research/eth_carry_pit_audit.latest.json'
const DEFAULT_MAX_PAIR_SKEW_MS = 10 * 60_000

async function main(): Promise<void> {
  const args = parseEthCarryPitAuditArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runEthCarryPitAudit(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'eth_carry_pit_audit',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'pass' ? 'pass' : 'fail',
      recordsIn: report.counts.carryFeatureRows,
      recordsOut: report.counts.passingRows,
      errorClass: report.blockers[0] ?? null,
    })
  }
}

export function parseEthCarryPitAuditArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    pitFeaturePath: raw.get('pitFeaturePath') ?? raw.get('featurePath') ?? DEFAULT_PIT_FEATURE_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    maxPairSkewMs: parsePositiveInteger(raw.get('maxPairSkewMs'), DEFAULT_MAX_PAIR_SKEW_MS),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runEthCarryPitAudit(args: CliArgs): Promise<EthCarryPitAuditReport> {
  const startedAt = new Date()
  const pitFeaturePath = resolve(args.pitFeaturePath)
  const dataset = await readJsonIfExists(pitFeaturePath)
  const report = buildEthCarryPitAuditReport({
    generatedAt: new Date().toISOString(),
    pitFeaturePath,
    pitFeatureDataset: dataset,
    maxPairSkewMs: args.maxPairSkewMs,
  })
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'eth_carry_pit_audit',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'pass' ? 'pass' : 'fail',
      recordsIn: report.counts.carryFeatureRows,
      recordsOut: report.counts.passingRows,
      errorClass: report.blockers[0] ?? null,
    })
  }
  return report
}

export function buildEthCarryPitAuditReport(input: {
  generatedAt?: string
  pitFeaturePath: string
  pitFeatureDataset: unknown
  maxPairSkewMs: number
}): EthCarryPitAuditReport {
  const dataset = asRecord(input.pitFeatureDataset)
  const carryFeatureRows = Array.isArray(dataset?.carryFeatureRows)
    ? dataset!.carryFeatureRows.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const rows = carryFeatureRows.map(row => auditRow(row, input.maxPairSkewMs))
  const passingRows = rows.filter(row => row.blockers.length === 0).length
  const blockers = uniqueStrings([
    ...(dataset != null || existsSync(input.pitFeaturePath) ? [] : ['eth_carry_pit_feature_dataset_missing']),
    ...(carryFeatureRows.length > 0 ? [] : ['eth_carry_pit_feature_rows_missing']),
    ...rows.flatMap(row => row.blockers.map(blocker => `${row.featureId}:${blocker}`)),
  ])
  const status: EthCarryPitAuditReport['status'] = blockers.length === 0 ? 'pass' : 'blocked'

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    diagnosticOnly: true,
    promotionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status,
    pitFeaturePath: resolve(input.pitFeaturePath),
    thresholds: {
      maxPairSkewMs: input.maxPairSkewMs,
      requireExplicitAvailableAt: true,
      requireFundingRateCashflow: true,
      requireBasisSpread: true,
    },
    counts: {
      carryFeatureRows: carryFeatureRows.length,
      auditedRows: rows.length,
      passingRows,
      failingRows: rows.length - passingRows,
    },
    rows,
    blockers,
    nextActions: status === 'pass'
      ? ['Keep prospective capture constrained to decision bars strictly after decisionAvailableAt.']
      : [
          'Rebuild PIT features until decisionAvailableAt, pairSkewMs, funding cashflow, and basis spread requirements all pass.',
          'Do not treat PIT feature rows as promotion-grade until this audit is pass and prospective capture continues to enforce decisionTime > availableAt.',
        ],
    safetyNotes: [
      'This PIT audit is research-only and cannot authorize paper or live execution.',
      'Passing this audit does not satisfy WFO, FDR, trial ledger, prospective, or paper execution gates.',
    ],
  }
}

function auditRow(row: UnknownRecord, maxPairSkewMs: number): PitAuditRow {
  const featureId = readString(row.featureId) ?? 'unknown_feature'
  const decisionAvailableAt = readString(row.decisionAvailableAt)
  const decisionAvailableAtMs = readNumber(row.decisionAvailableAtMs)
  const pairSkewMs = readNumber(row.pairSkewMs)
  const requiredFields = asRecord(row.requiredFields)
  const decisionAvailableAtIsoMs =
    decisionAvailableAt != null ? Date.parse(decisionAvailableAt) : Number.NaN
  const decisionAvailableAtConsistent =
    decisionAvailableAtMs != null &&
    Number.isFinite(decisionAvailableAtIsoMs) &&
    decisionAvailableAtMs === decisionAvailableAtIsoMs
  const explicitAvailableAt = readBoolean(requiredFields?.explicitAvailableAt) === true
  const fundingRateCashflow = readBoolean(requiredFields?.fundingRateCashflow) === true
  const basisSpread = readBoolean(requiredFields?.basisSpread) === true
  const pairSkewWithinThreshold = pairSkewMs != null && pairSkewMs <= maxPairSkewMs
  const blockers = uniqueStrings([
    ...(decisionAvailableAt ? [] : ['decision_available_at_missing']),
    ...(decisionAvailableAtMs != null ? [] : ['decision_available_at_ms_missing']),
    ...(decisionAvailableAtConsistent ? [] : ['decision_available_at_inconsistent']),
    ...(pairSkewMs != null ? [] : ['pair_skew_missing']),
    ...(pairSkewWithinThreshold ? [] : [`pair_skew_ms_exceeds_threshold:${pairSkewMs ?? 'missing'}>${maxPairSkewMs}`]),
    ...(explicitAvailableAt ? [] : ['explicit_available_at_missing']),
    ...(fundingRateCashflow ? [] : ['funding_rate_cashflow_missing']),
    ...(basisSpread ? [] : ['basis_spread_missing']),
    ...readStringArray(row.blockers).map(blocker => `carry_feature:${blocker}`),
  ])
  return {
    featureId,
    decisionAvailableAt,
    decisionAvailableAtMs,
    decisionAvailableAtConsistent,
    pairSkewMs,
    pairSkewWithinThreshold,
    explicitAvailableAt,
    fundingRateCashflow,
    basisSpread,
    blockers,
  }
}

function renderConsoleSummary(report: EthCarryPitAuditReport): string {
  return [
    `eth carry pit audit: status=${report.status}`,
    `rows=${report.counts.carryFeatureRows} pass=${report.counts.passingRows} fail=${report.counts.failingRows}`,
    `paper=false live=false promotion=false`,
    `blockers=${report.blockers.slice(0, 8).join(',') || 'none'}`,
  ].join('\n')
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf-8'))
  } catch {
    return null
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [key, inlineValue] = token.slice(2).split('=', 2)
    if (inlineValue !== undefined) {
      out.set(key, inlineValue)
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(key, next)
      index += 1
    } else {
      out.set(key, 'true')
    }
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (value == null) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' || normalized === 'false' ? null : value
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value == null) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

function asRecord(value: unknown): UnknownRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
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

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))]
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_eth_carry_pit_audit failed:', error)
    process.exit(1)
  })
}
