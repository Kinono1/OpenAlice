import { createHash } from 'node:crypto'
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

interface CliArgs {
  inputPath: string
  outputPath: string
  reportPath: string | null
  json: boolean
}

interface EthCarryPitFeatureInput {
  schemaVersion?: number
  generatedAt?: string
  status?: string
  researchOnly?: boolean
  diagnosticOnly?: boolean
  promotionAllowed?: boolean
  paperTradingAllowed?: boolean
  liveTradingAllowed?: boolean
  counts?: {
    carryFeatureRows?: number
  }
  carryFeatureRows?: Array<Record<string, unknown>>
  blockers?: string[]
}

export interface EthCarryFeatureStoreRow {
  schemaVersion: 'openalice.feature_store.eth_carry_pit.v1'
  source: 'openalice_research_eth_carry_pit_features'
  featureStoreFamily: 'feature_backtest_input'
  strategyFamily: 'funding_carry_rebuild'
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  featureId: string
  eventTime: string
  eventTimeMs: number
  observedAt: string
  fetchedAt: string
  availableAt: string
  availableAtMs: number
  generatedAt: string
  jobId: 'eth_carry_feature_store_materialize'
  exchange: string
  market: string
  symbol: 'ETHUSDT/BTCUSDT'
  symbols: {
    leader: 'ETHUSDT'
    hedge: 'BTCUSDT'
  }
  fundingSpread: number | null
  basisSpreadDiffPct: number | null
  ethFundingRate: number | null
  btcFundingRate: number | null
  ethBasisSpreadPct: number | null
  btcBasisSpreadPct: number | null
  pairSkewMs: number | null
  sourceFeatureIds: {
    ethBasisFeatureId: string | null
    btcBasisFeatureId: string | null
  }
  quality: {
    promotionGrade: false
    sourceArtifactStatus: string | null
    requiredFieldsComplete: boolean
    blockers: string[]
  }
  sourceArtifact: {
    path: string
    generatedAt: string | null
    hash: string
  }
}

export interface EthCarryFeatureStoreMaterializeReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: 'complete' | 'blocked'
  inputPath: string
  outputPath: string
  rowsRead: number
  rowsWritten: number
  outputHash: string | null
  observedStartTime: string | null
  observedEndTime: string | null
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_INPUT_PATH = 'data/research/eth_carry_pit_features.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/derived/features/eth_carry_pit_features.research_only.normalized.jsonl'
const DEFAULT_REPORT_PATH = 'data/runtime/eth_carry_feature_store_materialize.latest.json'
const NON_BLOCKING_RESEARCH_QUALITY_BLOCKERS = new Set([
  'feature_store_research_only_not_execution_evidence',
  'requires_strategy_specific_pit_wfo_fdr_route_cost_prospective_paper_gates',
])

async function main(): Promise<void> {
  const args = parseEthCarryFeatureStoreMaterializeArgs(process.argv.slice(2))
  const report = await runEthCarryFeatureStoreMaterialize(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
  if (report.status === 'blocked') process.exitCode = 2
}

export function parseEthCarryFeatureStoreMaterializeArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const dataRoot = raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT
  const defaultOutputPath = dataRoot
    ? join(dataRoot, 'derived/features/eth_carry_pit_features.research_only.normalized.jsonl')
    : DEFAULT_OUTPUT_PATH
  return {
    inputPath: resolve(raw.get('inputPath') ?? raw.get('input') ?? DEFAULT_INPUT_PATH),
    outputPath: resolve(raw.get('outputPath') ?? raw.get('output') ?? defaultOutputPath),
    reportPath: parseNullablePath(raw.get('reportPath') ?? raw.get('report') ?? DEFAULT_REPORT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runEthCarryFeatureStoreMaterialize(
  args: CliArgs,
): Promise<EthCarryFeatureStoreMaterializeReport> {
  const startedAt = new Date()
  const raw = await readFile(args.inputPath, 'utf-8')
  const source = JSON.parse(raw) as EthCarryPitFeatureInput
  const sourceHash = sha256Hex(raw)
  const generatedAt = new Date().toISOString()
  const sourceRows = Array.isArray(source.carryFeatureRows) ? source.carryFeatureRows : []
  const rows = sourceRows
    .map(row => materializeRow({
      row,
      inputPath: args.inputPath,
      sourceGeneratedAt: stringOrNull(source.generatedAt),
      sourceHash,
      sourceStatus: stringOrNull(source.status),
      generatedAt,
    }))
    .filter((row): row is EthCarryFeatureStoreRow => row != null)
    .sort((left, right) => left.availableAtMs - right.availableAtMs || left.featureId.localeCompare(right.featureId))
  const output = rows.map(row => JSON.stringify(row)).join('\n')
  await atomicWrite(args.outputPath, output ? `${output}\n` : '')
  const outputPayload = output ? `${output}\n` : ''
  const outputHash = outputPayload ? sha256Hex(outputPayload) : null
  const blockers = [
    ...(source.status === 'ready_for_research' ? [] : [`eth_carry_pit_features_not_ready:${source.status ?? 'missing'}`]),
    ...(source.researchOnly === true ? [] : ['eth_carry_pit_features_not_research_only']),
    ...(source.promotionAllowed === false ? [] : ['eth_carry_pit_features_promotion_flag_not_false']),
    ...(source.paperTradingAllowed === false ? [] : ['eth_carry_pit_features_paper_flag_not_false']),
    ...(source.liveTradingAllowed === false ? [] : ['eth_carry_pit_features_live_flag_not_false']),
    ...(rows.length > 0 ? [] : ['eth_carry_feature_store_rows_missing']),
    ...rows.flatMap(row => row.quality.blockers
      .filter(blocker => !NON_BLOCKING_RESEARCH_QUALITY_BLOCKERS.has(blocker))
      .map(blocker => `feature_row:${blocker}`)).slice(0, 32),
  ]
  const observedTimes = rows.map(row => row.availableAt).sort()
  const report: EthCarryFeatureStoreMaterializeReport = {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: blockers.length === 0 ? 'complete' : 'blocked',
    inputPath: args.inputPath,
    outputPath: args.outputPath,
    rowsRead: sourceRows.length,
    rowsWritten: rows.length,
    outputHash,
    observedStartTime: observedTimes[0] ?? null,
    observedEndTime: observedTimes.at(-1) ?? null,
    blockers,
    nextActions: [
      'Use this feature-store file only for PIT-safe research backtests where decision time is strictly after availableAt.',
      'Run strategy-specific PIT audit, WFO, FDR, route-cost, slippage stress, risk simulation, prospective ledger, and paper telemetry gates before any promotion review.',
    ],
    safetyNotes: [
      'This materialized feature store is research-only and cannot authorize paper trading, live trading, promotion, leverage changes, or best_config mutations.',
      'Rows are feature inputs, not trading instructions or profitability evidence.',
    ],
  }

  if (args.reportPath) {
    await atomicWrite(args.reportPath, `${JSON.stringify(report, null, 2)}\n`)
    await writeEvidenceManifestForArtifact({
      job: 'eth_carry_feature_store_materialize_report',
      artifactPath: args.reportPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'complete' ? 'warn' : 'fail',
      recordsIn: sourceRows.length,
      recordsOut: rows.length,
      errorClass: report.blockers[0] ?? null,
    })
  }

  await writeEvidenceManifestForArtifact({
    job: 'eth_carry_feature_store_materialize_rows',
    artifactPath: args.outputPath,
    startedAt,
    finishedAt: new Date(),
    exitCode: 0,
    businessStatus: report.status === 'complete' ? 'warn' : 'fail',
    recordsIn: sourceRows.length,
    recordsOut: rows.length,
    errorClass: report.blockers[0] ?? null,
    artifactHash: outputHash,
  })

  return report
}

function materializeRow(input: {
  row: Record<string, unknown>
  inputPath: string
  sourceGeneratedAt: string | null
  sourceHash: string
  sourceStatus: string | null
  generatedAt: string
}): EthCarryFeatureStoreRow | null {
  const featureId = stringOrNull(input.row.featureId)
  const exchange = stringOrNull(input.row.exchange)
  const market = stringOrNull(input.row.market)
  const decisionAvailableAt = stringOrNull(input.row.decisionAvailableAt)
  const decisionAvailableAtMs = numberOrNull(input.row.decisionAvailableAtMs) ?? (decisionAvailableAt ? Date.parse(decisionAvailableAt) : null)
  const symbols = asRecord(input.row.symbols)
  const sourceFeatures = asRecord(input.row.sourceFeatures)
  if (!featureId || !exchange || !market || !decisionAvailableAt || decisionAvailableAtMs == null || !Number.isFinite(decisionAvailableAtMs)) return null
  const requiredFields = asRecord(input.row.requiredFields)
  const rowBlockers = stringArray(input.row.blockers)
  const requiredFieldsComplete = booleanOrFalse(requiredFields?.fundingRateCashflow) &&
    booleanOrFalse(requiredFields?.basisSpread) &&
    booleanOrFalse(requiredFields?.explicitAvailableAt)
  const blockers = [
    ...rowBlockers,
    ...(requiredFieldsComplete ? [] : ['required_fields_incomplete']),
  ]
  return {
    schemaVersion: 'openalice.feature_store.eth_carry_pit.v1',
    source: 'openalice_research_eth_carry_pit_features',
    featureStoreFamily: 'feature_backtest_input',
    strategyFamily: 'funding_carry_rebuild',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    featureId,
    eventTime: decisionAvailableAt,
    eventTimeMs: decisionAvailableAtMs,
    observedAt: input.generatedAt,
    fetchedAt: input.generatedAt,
    availableAt: decisionAvailableAt,
    availableAtMs: decisionAvailableAtMs,
    generatedAt: input.generatedAt,
    jobId: 'eth_carry_feature_store_materialize',
    exchange,
    market,
    symbol: 'ETHUSDT/BTCUSDT',
    symbols: {
      leader: stringOrNull(symbols?.leader) === 'ETHUSDT' ? 'ETHUSDT' : 'ETHUSDT',
      hedge: stringOrNull(symbols?.hedge) === 'BTCUSDT' ? 'BTCUSDT' : 'BTCUSDT',
    },
    fundingSpread: numberOrNull(input.row.fundingSpread),
    basisSpreadDiffPct: numberOrNull(input.row.basisSpreadDiffPct),
    ethFundingRate: numberOrNull(input.row.ethFundingRate),
    btcFundingRate: numberOrNull(input.row.btcFundingRate),
    ethBasisSpreadPct: numberOrNull(input.row.ethBasisSpreadPct),
    btcBasisSpreadPct: numberOrNull(input.row.btcBasisSpreadPct),
    pairSkewMs: numberOrNull(input.row.pairSkewMs),
    sourceFeatureIds: {
      ethBasisFeatureId: stringOrNull(sourceFeatures?.ethBasisFeatureId),
      btcBasisFeatureId: stringOrNull(sourceFeatures?.btcBasisFeatureId),
    },
    quality: {
      promotionGrade: false,
      sourceArtifactStatus: input.sourceStatus,
      requiredFieldsComplete,
      blockers: [
        'feature_store_research_only_not_execution_evidence',
        'requires_strategy_specific_pit_wfo_fdr_route_cost_prospective_paper_gates',
        ...blockers,
      ],
    },
    sourceArtifact: {
      path: input.inputPath,
      generatedAt: input.sourceGeneratedAt,
      hash: input.sourceHash,
    },
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const outputPath = resolve(path)
  await mkdir(dirname(outputPath), { recursive: true })
  const tmpPath = `${outputPath}.${process.pid}.tmp`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, outputPath)
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
  return normalized === 'null' || normalized === 'none' || normalized === 'false' ? null : resolve(value)
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.trim().toLowerCase())
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function booleanOrFalse(value: unknown): boolean {
  return value === true
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function renderConsoleSummary(report: EthCarryFeatureStoreMaterializeReport): string {
  return [
    `ETH carry feature store materialize: ${report.status}`,
    `rows=${report.rowsWritten}/${report.rowsRead}`,
    `paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `blockers=${report.blockers.slice(0, 8).join(',')}` : 'blockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('materialize_eth_carry_feature_store failed:', error)
    process.exitCode = 1
  })
}
