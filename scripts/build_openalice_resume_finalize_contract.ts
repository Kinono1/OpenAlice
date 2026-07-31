import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type ContractStatus = 'complete' | 'blocked'
type SourceId =
  | 'binance_data_vision'
  | 'binance_usdm_rest_retired_http_451'
  | 'okx_public_derivatives'
  | 'okx_public_market'
  | 'coinmetrics_community'
  | 'ai_scientist_crypto_dl'

interface CliArgs {
  warehouseRoot: string
  repoDataRoot: string
  outputPath: string | null
  json: boolean
}

export interface ResumeFinalizeSourceContract {
  source: SourceId
  sourceClass: 'archive_download' | 'historical_read_only' | 'rest_append_log' | 'runtime_collector' | 'research_candidate_import'
  lifecycle: 'active' | 'offline_manual' | 'retired_http_451'
  automationAllowed: boolean
  dataFamilies: string[]
  stateArtifacts: string[]
  resumeKeys: string[]
  idempotencyKeys: string[]
  requiredNormalizedFields: string[]
  retryPolicy: {
    resumable: boolean
    maxAttemptsField: string | null
    retrySummaryRequired: boolean
    failedItemLedgerRequired: boolean
  }
  partialFilePolicy: {
    partialSuffixes: string[]
    finalizationRequiresNoPartFiles: boolean
  }
  finalizeChecks: string[]
  manifestRequirements: string[]
  status: ContractStatus
  blockers: string[]
}

export interface OpenAliceResumeFinalizeContractReport {
  schemaVersion: 1
  generatedAt: string
  contractVersion: 'openalice.resume_finalize_contract.v1'
  warehouseRoot: string
  repoDataRoot: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  startsDownload: false
  status: ContractStatus
  summary: {
    sources: number
    completeSources: number
    blockedSources: number
    sourceAgnosticResumeContract: boolean
    requiredNormalizedFields: string[]
    requiredFinalizeChecks: string[]
  }
  sources: ResumeFinalizeSourceContract[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
  outputHash: string | null
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/openalice_resume_finalize_contract.latest.json'
const REQUIRED_NORMALIZED_FIELDS = [
  'schemaVersion',
  'source',
  'exchange',
  'symbol_or_asset',
  'eventTime',
  'observedAt_or_fetchedAt',
  'availableAt',
  'generatedAt_or_ingestedAt',
  'jobId_or_runId',
  'sourceEndpoint_or_sourceUrl',
  'quality_or_blockers',
]
const REQUIRED_FINALIZE_CHECKS = [
  'no_part_files',
  'summary_status_complete_or_known_blocked',
  'manifest_sidecar_present',
  'records_in_out_reconciled',
  'dedupe_or_idempotency_key_present',
  'pit_fields_available_before_strategy_use',
  'research_only_outputs_do_not_authorize_execution',
]

async function main(): Promise<void> {
  const args = parseOpenAliceResumeFinalizeContractArgs(process.argv.slice(2))
  const report = await runOpenAliceResumeFinalizeContract(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }
}

export function parseOpenAliceResumeFinalizeContractArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    warehouseRoot: resolve(raw.get('warehouseRoot') ?? raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT ?? 'data'),
    repoDataRoot: resolve(raw.get('repoDataRoot') ?? raw.get('repoData') ?? 'data'),
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runOpenAliceResumeFinalizeContract(args: CliArgs): Promise<OpenAliceResumeFinalizeContractReport> {
  const startedAt = new Date()
  const outputPath = args.outputPath == null ? null : resolve(args.outputPath)
  const report = buildOpenAliceResumeFinalizeContractReport({
    generatedAt: new Date().toISOString(),
    warehouseRoot: args.warehouseRoot,
    repoDataRoot: args.repoDataRoot,
  })

  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true })
    const withoutHash = `${JSON.stringify({ ...report, outputHash: null }, null, 2)}\n`
    const outputHash = sha256Hex(withoutHash)
    const finalPayload = `${JSON.stringify({ ...report, outputHash }, null, 2)}\n`
    await writeFile(outputPath, finalPayload, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'openalice_resume_finalize_contract',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'complete' ? 'pass' : 'fail',
      recordsIn: report.sources.length,
      recordsOut: report.summary.completeSources,
      errorClass: report.blockers[0] ?? null,
      artifactHash: sha256Hex(finalPayload),
    })
    return { ...report, outputHash }
  }

  return report
}

export function buildOpenAliceResumeFinalizeContractReport(input: {
  warehouseRoot: string
  repoDataRoot: string
  generatedAt?: string
}): OpenAliceResumeFinalizeContractReport {
  const warehouseRoot = resolve(input.warehouseRoot)
  const repoDataRoot = resolve(input.repoDataRoot)
  const sources = buildSourceContracts({ warehouseRoot, repoDataRoot })
  const blockers = sources.flatMap(source => source.blockers.map(blocker => `${source.source}:${blocker}`))
  const requiredFinalizeChecks = REQUIRED_FINALIZE_CHECKS
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    contractVersion: 'openalice.resume_finalize_contract.v1',
    warehouseRoot,
    repoDataRoot,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    startsDownload: false,
    status: blockers.length === 0 ? 'complete' : 'blocked',
    summary: {
      sources: sources.length,
      completeSources: sources.filter(source => source.status === 'complete').length,
      blockedSources: sources.filter(source => source.status === 'blocked').length,
      sourceAgnosticResumeContract: blockers.length === 0,
      requiredNormalizedFields: REQUIRED_NORMALIZED_FIELDS,
      requiredFinalizeChecks,
    },
    sources,
    blockers,
    nextActions: blockers.length === 0
      ? ['Apply this source-agnostic contract to new collectors and keep catalog/download monitors refreshed after collectors, normalizers, and audits run.']
      : ['Fill the missing resume/finalize fields before treating any collector as reproducible infrastructure.'],
    safetyNotes: [
      'This artifact defines data-collector resume/finalize requirements only; it does not start downloads or authorize paper/live trading.',
      'A complete contract is not data completeness, PIT validity, profitability evidence, or promotion authority.',
      'Strategy use still requires PIT audit, WFO, FDR, route-cost, slippage, risk simulation, prospective evidence, paper telemetry, and release gates.',
    ],
    outputHash: null,
  }
}

function buildSourceContracts(input: {
  warehouseRoot: string
  repoDataRoot: string
}): ResumeFinalizeSourceContract[] {
  const repoRuntime = resolve(input.repoDataRoot, 'runtime')
  return [
    sourceContract({
      source: 'binance_data_vision',
      sourceClass: 'archive_download',
      lifecycle: 'offline_manual',
      automationAllowed: false,
      dataFamilies: ['spot_klines', 'um_klines', 'aggTrades', 'trades', 'fundingRate', 'mark_index_premium_klines', 'bookTicker'],
      stateArtifacts: [
        resolve(input.warehouseRoot, 'market/binance-public/<dataset>/summary.fast-binance-download.json'),
        resolve(input.warehouseRoot, 'market/binance-public/<dataset>/summary.fast-binance-download.retry.json'),
        resolve(input.warehouseRoot, 'market/binance-public/<dataset>/manifest.fast-binance-download.jsonl'),
      ],
      resumeKeys: ['market', 'dataType', 'timeframe', 'symbol', 'month', 'sourceUrl', 'storagePath'],
      idempotencyKeys: ['sourceUrl', 'storagePath', 'zipFilename'],
      retrySummaryRequired: false,
      failedItemLedgerRequired: true,
    }),
    sourceContract({
      source: 'binance_usdm_rest_retired_http_451',
      sourceClass: 'historical_read_only',
      lifecycle: 'retired_http_451',
      automationAllowed: false,
      dataFamilies: ['funding', 'open_interest', 'premium_index', 'mark_price', 'basis_inputs'],
      stateArtifacts: [
        resolve(input.repoDataRoot, 'external/derivatives/binance_usdm_derivatives_events.jsonl'),
      ],
      resumeKeys: ['exchange', 'market', 'symbol', 'endpointId', 'sourceTimestampMs', 'dedupKey'],
      idempotencyKeys: ['exchange', 'market', 'symbol', 'endpointId', 'sourceTimestampMs'],
      retrySummaryRequired: false,
      failedItemLedgerRequired: false,
      resumable: false,
    }),
    sourceContract({
      source: 'okx_public_derivatives',
      sourceClass: 'rest_append_log',
      lifecycle: 'active',
      automationAllowed: true,
      dataFamilies: ['funding', 'premium_basis', 'open_interest', 'open_interest_history', 'long_short_account_ratio'],
      stateArtifacts: [
        resolve(input.repoDataRoot, 'external/derivatives/okx_swap_derivatives_events.jsonl'),
        resolve(input.repoDataRoot, 'normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl'),
        resolve(repoRuntime, 'external_derivatives_data_collect.latest.json'),
        resolve(repoRuntime, 'external_derivatives_data_normalize.latest.json'),
        resolve(repoRuntime, 'external_derivatives_data_audit.latest.json'),
      ],
      resumeKeys: ['exchange', 'market', 'instrumentId', 'symbol', 'endpointId', 'sourceTimestampMs', 'dedupKey'],
      idempotencyKeys: ['exchange', 'market', 'instrumentId', 'endpointId', 'sourceTimestampMs'],
      retrySummaryRequired: false,
      failedItemLedgerRequired: true,
    }),
    sourceContract({
      source: 'okx_public_market',
      sourceClass: 'runtime_collector',
      lifecycle: 'active',
      automationAllowed: true,
      dataFamilies: ['ohlcv', 'carry_snapshot', 'orderbook_spread', 'route_cost_inputs'],
      stateArtifacts: [
        resolve(repoRuntime, 'live_data_freshness.latest.json'),
        resolve(input.repoDataRoot, 'research/openalice_ohlcv_collector_pit_contract_status.latest.json'),
        resolve(repoRuntime, 'okx_orderbook_spread_snapshot.latest.json'),
        resolve(repoRuntime, 'okx_route_cost_slippage_readiness.latest.json'),
      ],
      resumeKeys: ['exchange', 'symbol', 'timeframe', 'eventTime', 'availableAt', 'jobId'],
      idempotencyKeys: ['exchange', 'symbol', 'timeframe', 'eventTime'],
      retrySummaryRequired: false,
      failedItemLedgerRequired: true,
    }),
    sourceContract({
      source: 'coinmetrics_community',
      sourceClass: 'rest_append_log',
      lifecycle: 'active',
      automationAllowed: true,
      dataFamilies: ['asset_metrics', 'network_metrics', 'supply', 'fees', 'activity'],
      stateArtifacts: [
        resolve(repoRuntime, 'openalice_coinmetrics_onchain_collect.latest.json'),
        resolve(repoRuntime, 'openalice_coinmetrics_onchain_normalize.latest.json'),
        resolve(repoRuntime, 'openalice_coinmetrics_onchain_audit.latest.json'),
      ],
      resumeKeys: ['source', 'asset', 'metric', 'time', 'availableAt', 'jobId'],
      idempotencyKeys: ['source', 'asset', 'metric', 'time'],
      retrySummaryRequired: false,
      failedItemLedgerRequired: true,
    }),
    sourceContract({
      source: 'ai_scientist_crypto_dl',
      sourceClass: 'research_candidate_import',
      lifecycle: 'active',
      automationAllowed: true,
      dataFamilies: ['candidate_runs', 'walk_forward_reports', 'risk_reports', 'strategy_source_manifest'],
      stateArtifacts: [
        resolve(input.repoDataRoot, 'research/ai_scientist_crypto_candidate_intake.latest.json'),
        resolve(input.repoDataRoot, 'research/ai_scientist_openalice_candidate_source_manifest.latest.json'),
        resolve(input.repoDataRoot, 'research/ai_scientist_openalice_second_validation_queue.latest.json'),
        resolve(input.repoDataRoot, 'research/ai_scientist_openalice_pit_contract_status.latest.json'),
      ],
      resumeKeys: ['runId', 'candidateId', 'sourcePath', 'codeSnapshotHash', 'generatedAt'],
      idempotencyKeys: ['runId', 'candidateId', 'codeSnapshotHash'],
      retrySummaryRequired: false,
      failedItemLedgerRequired: true,
    }),
  ]
}

function sourceContract(input: {
  source: SourceId
  sourceClass: ResumeFinalizeSourceContract['sourceClass']
  lifecycle: ResumeFinalizeSourceContract['lifecycle']
  automationAllowed: boolean
  dataFamilies: string[]
  stateArtifacts: string[]
  resumeKeys: string[]
  idempotencyKeys: string[]
  retrySummaryRequired: boolean
  failedItemLedgerRequired: boolean
  resumable?: boolean
}): ResumeFinalizeSourceContract {
  const blockers = [
    ...(input.dataFamilies.length > 0 ? [] : ['data_families_missing']),
    ...(input.stateArtifacts.length > 0 ? [] : ['state_artifacts_missing']),
    ...(input.resumeKeys.length > 0 ? [] : ['resume_keys_missing']),
    ...(input.idempotencyKeys.length > 0 ? [] : ['idempotency_keys_missing']),
    ...(REQUIRED_NORMALIZED_FIELDS.length > 0 ? [] : ['required_normalized_fields_missing']),
    ...(REQUIRED_FINALIZE_CHECKS.length > 0 ? [] : ['required_finalize_checks_missing']),
  ]
  return {
    source: input.source,
    sourceClass: input.sourceClass,
    lifecycle: input.lifecycle,
    automationAllowed: input.automationAllowed,
    dataFamilies: input.dataFamilies,
    stateArtifacts: input.stateArtifacts,
    resumeKeys: input.resumeKeys,
    idempotencyKeys: input.idempotencyKeys,
    requiredNormalizedFields: REQUIRED_NORMALIZED_FIELDS,
    retryPolicy: {
      resumable: input.resumable ?? true,
      maxAttemptsField: input.resumable === false ? null : 'maxRetries',
      retrySummaryRequired: input.retrySummaryRequired,
      failedItemLedgerRequired: input.failedItemLedgerRequired,
    },
    partialFilePolicy: {
      partialSuffixes: ['.part', '.tmp'],
      finalizationRequiresNoPartFiles: true,
    },
    finalizeChecks: REQUIRED_FINALIZE_CHECKS,
    manifestRequirements: [
      'artifactPath',
      'manifestPath',
      'startedAt',
      'finishedAt',
      'businessStatus',
      'recordsIn',
      'recordsOut',
      'artifactHash',
      'errorClass',
    ],
    status: blockers.length === 0 ? 'complete' : 'blocked',
    blockers,
  }
}

function renderConsoleSummary(report: OpenAliceResumeFinalizeContractReport): string {
  return [
    `OpenAlice resume/finalize contract: ${report.status}`,
    `sources=${report.summary.sources} complete=${report.summary.completeSources} blocked=${report.summary.blockedSources}`,
    'startsDownload=false paper=false live=false promotion=false',
    `topBlockers=${report.blockers.slice(0, 8).join(',') || 'none'}`,
  ].join('\n')
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

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_openalice_resume_finalize_contract failed:', error)
    process.exit(1)
  })
}
