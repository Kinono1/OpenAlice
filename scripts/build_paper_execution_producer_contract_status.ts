import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>
type ContractStatus = 'blocked' | 'ready_future_only'

interface CliArgs {
  outputPath: string | null
  paperTradeResultPath: string
  paperExecutionQualityPath: string
  executionQualityPath: string
  crossSectionalProducerPath: string
  volumeBreakoutProducerPath: string
  microstructureProducerPath: string
  json: boolean
}

interface SourceSnapshot {
  path: string
  exists: boolean
  text: string
}

export interface PaperExecutionProducerContractStatusReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  futureProducerOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: ContractStatus
  sourceArtifacts: {
    paperTradeResultPath: string
    paperExecutionQualityPath: string
    executionQualityPath: string
    crossSectionalProducerPath: string
    volumeBreakoutProducerPath: string
    microstructureProducerPath: string
  }
  producerContract: {
    schemaHasPaperFillTelemetryFields: boolean
    sharedCostBuilderEmitsPaperFillTelemetry: boolean
    executionQualityConsumesPaperFillTelemetry: boolean
    crossSectionalClosePathUsesSharedCostBuilder: boolean
    volumeBreakoutClosePathUsesSharedCostBuilder: boolean
    microstructureClosePathUsesSharedCostBuilder: boolean
    futurePaperCloseRowsReady: boolean
  }
  historicalExecutionQuality: {
    exists: boolean
    closedTrades: number
    tradesWithPaperFillTelemetry: number
    paperFillTelemetryCoveragePct: number | null
    tradesWithCompletePredictedOpenEvidence: number
    completePredictedOpenEvidenceCoveragePct: number | null
    tradesWithExchangeReconciledCostEvidence: number
    observedSlippageAvailable: boolean
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
  outputHash: string | null
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/paper_execution_producer_contract_status.latest.json'

async function main(): Promise<void> {
  const args = parsePaperExecutionProducerContractStatusArgs(process.argv.slice(2))
  const report = await runPaperExecutionProducerContractStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parsePaperExecutionProducerContractStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    paperTradeResultPath: raw.get('paperTradeResultPath') ?? 'src/runtime/paper_trade_result.ts',
    paperExecutionQualityPath: raw.get('paperExecutionQualityPath') ?? 'scripts/build_paper_execution_quality.ts',
    executionQualityPath: raw.get('executionQualityPath') ?? 'data/runtime/execution_quality.latest.json',
    crossSectionalProducerPath: raw.get('crossSectionalProducerPath') ?? 'scripts/paper_trade_cross_sectional.ts',
    volumeBreakoutProducerPath: raw.get('volumeBreakoutProducerPath') ?? 'scripts/paper_trade_volume_breakout.ts',
    microstructureProducerPath: raw.get('microstructureProducerPath') ?? 'scripts/paper_trade_microstructure_stress.ts',
    json: parseBool(raw.get('json'), false),
  }
}

export async function runPaperExecutionProducerContractStatus(
  args: CliArgs,
): Promise<PaperExecutionProducerContractStatusReport> {
  const startedAt = new Date()
  const sourceArtifacts = {
    paperTradeResultPath: resolve(args.paperTradeResultPath),
    paperExecutionQualityPath: resolve(args.paperExecutionQualityPath),
    executionQualityPath: resolve(args.executionQualityPath),
    crossSectionalProducerPath: resolve(args.crossSectionalProducerPath),
    volumeBreakoutProducerPath: resolve(args.volumeBreakoutProducerPath),
    microstructureProducerPath: resolve(args.microstructureProducerPath),
  }
  const report = buildPaperExecutionProducerContractStatusReport({
    generatedAt: new Date().toISOString(),
    sourceArtifacts,
    sources: {
      paperTradeResult: await readSource(sourceArtifacts.paperTradeResultPath),
      paperExecutionQuality: await readSource(sourceArtifacts.paperExecutionQualityPath),
      crossSectionalProducer: await readSource(sourceArtifacts.crossSectionalProducerPath),
      volumeBreakoutProducer: await readSource(sourceArtifacts.volumeBreakoutProducerPath),
      microstructureProducer: await readSource(sourceArtifacts.microstructureProducerPath),
    },
    executionQuality: asRecord(await readJsonIfExists(sourceArtifacts.executionQualityPath)),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    const withoutHash = `${JSON.stringify({ ...report, outputHash: null }, null, 2)}\n`
    const outputHash = sha256Hex(withoutHash)
    const finalPayload = `${JSON.stringify({ ...report, outputHash }, null, 2)}\n`
    await writeFile(outputPath, finalPayload, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'paper_execution_producer_contract_status',
      artifactPath: outputPath,
      manifestPath: `${outputPath}.manifest.json`,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'ready_future_only' ? 'warn' : 'fail',
      recordsIn: 6,
      recordsOut: 1,
      errorClass: report.blockers[0] ?? null,
      artifactHash: sha256Hex(finalPayload),
    })
    return { ...report, outputHash }
  }

  return report
}

export function buildPaperExecutionProducerContractStatusReport(input: {
  generatedAt: string
  sourceArtifacts: PaperExecutionProducerContractStatusReport['sourceArtifacts']
  sources: {
    paperTradeResult: SourceSnapshot
    paperExecutionQuality: SourceSnapshot
    crossSectionalProducer: SourceSnapshot
    volumeBreakoutProducer: SourceSnapshot
    microstructureProducer: SourceSnapshot
  }
  executionQuality: UnknownRecord | null
}): PaperExecutionProducerContractStatusReport {
  const schemaHasPaperFillTelemetryFields = input.sources.paperTradeResult.exists &&
    [
      'paperFillTelemetryStatus',
      'paperFillModelSource',
      'paperFillExpectedCostBps',
      'paperFillSimulatedSlippageBps',
      'paperFillIsExchangeReconciled',
    ].every(token => input.sources.paperTradeResult.text.includes(token))
  const sharedCostBuilderEmitsPaperFillTelemetry = input.sources.paperTradeResult.exists &&
    input.sources.paperTradeResult.text.includes('buildPaperTradeCostEvidence') &&
    input.sources.paperTradeResult.text.includes('paper_model_not_exchange_reconciled') &&
    input.sources.paperTradeResult.text.includes('paperFillExpectedCostBps') &&
    input.sources.paperTradeResult.text.includes('paperFillIsExchangeReconciled: false')
  const executionQualityConsumesPaperFillTelemetry = input.sources.paperExecutionQuality.exists &&
    input.sources.paperExecutionQuality.text.includes('tradesWithPaperFillTelemetry') &&
    input.sources.paperExecutionQuality.text.includes('paperFillTelemetryCoveragePct') &&
    input.sources.paperExecutionQuality.text.includes('paperModelMeanExpectedCostBps')
  const crossSectionalClosePathUsesSharedCostBuilder = closePathUsesSharedCostBuilder(input.sources.crossSectionalProducer.text)
  const volumeBreakoutClosePathUsesSharedCostBuilder = closePathUsesSharedCostBuilder(input.sources.volumeBreakoutProducer.text)
  const microstructureClosePathUsesSharedCostBuilder = closePathUsesSharedCostBuilder(input.sources.microstructureProducer.text)
  const futurePaperCloseRowsReady = schemaHasPaperFillTelemetryFields &&
    sharedCostBuilderEmitsPaperFillTelemetry &&
    executionQualityConsumesPaperFillTelemetry &&
    crossSectionalClosePathUsesSharedCostBuilder &&
    volumeBreakoutClosePathUsesSharedCostBuilder &&
    microstructureClosePathUsesSharedCostBuilder

  const evidence = asRecord(input.executionQuality?.evidence)
  const quality = asRecord(input.executionQuality?.quality)
  const closedTrades = readNumber(evidence?.closedTrades) ?? 0
  const tradesWithPaperFillTelemetry = readNumber(evidence?.tradesWithPaperFillTelemetry) ?? 0
  const tradesWithExchangeReconciledCostEvidence = readNumber(evidence?.tradesWithExchangeReconciledCostEvidence) ?? 0
  const observedSlippageAvailable =
    readNumber(quality?.volumeWeightedSlippageBps) != null ||
    readNumber(quality?.maxObservedSlippageBps) != null
  const blockers = uniqueStrings([
    ...(schemaHasPaperFillTelemetryFields ? [] : ['paper_trade_result_schema_missing_paper_fill_telemetry_fields']),
    ...(sharedCostBuilderEmitsPaperFillTelemetry ? [] : ['shared_cost_builder_missing_paper_fill_telemetry']),
    ...(executionQualityConsumesPaperFillTelemetry ? [] : ['execution_quality_missing_paper_fill_telemetry_consumer']),
    ...(crossSectionalClosePathUsesSharedCostBuilder ? [] : ['cross_sectional_close_path_missing_shared_cost_builder']),
    ...(volumeBreakoutClosePathUsesSharedCostBuilder ? [] : ['volume_breakout_close_path_missing_shared_cost_builder']),
    ...(microstructureClosePathUsesSharedCostBuilder ? [] : ['microstructure_close_path_missing_shared_cost_builder']),
    ...(input.executionQuality ? [] : ['execution_quality_artifact_missing']),
    ...(closedTrades > 0 && tradesWithPaperFillTelemetry < closedTrades
      ? [`historical_paper_fill_telemetry_coverage_low:${tradesWithPaperFillTelemetry}/${closedTrades}`]
      : []),
    ...(tradesWithExchangeReconciledCostEvidence > 0 ? [] : ['exchange_reconciled_cost_evidence_missing']),
    ...(observedSlippageAvailable ? [] : ['observed_slippage_unavailable']),
  ])

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    futureProducerOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: futurePaperCloseRowsReady ? 'ready_future_only' : 'blocked',
    sourceArtifacts: input.sourceArtifacts,
    producerContract: {
      schemaHasPaperFillTelemetryFields,
      sharedCostBuilderEmitsPaperFillTelemetry,
      executionQualityConsumesPaperFillTelemetry,
      crossSectionalClosePathUsesSharedCostBuilder,
      volumeBreakoutClosePathUsesSharedCostBuilder,
      microstructureClosePathUsesSharedCostBuilder,
      futurePaperCloseRowsReady,
    },
    historicalExecutionQuality: {
      exists: input.executionQuality != null,
      closedTrades,
      tradesWithPaperFillTelemetry,
      paperFillTelemetryCoveragePct: readNumber(quality?.paperFillTelemetryCoveragePct),
      tradesWithCompletePredictedOpenEvidence: readNumber(evidence?.tradesWithCompletePredictedOpenEvidence) ?? 0,
      completePredictedOpenEvidenceCoveragePct: readNumber(quality?.completePredictedOpenEvidenceCoveragePct),
      tradesWithExchangeReconciledCostEvidence,
      observedSlippageAvailable,
    },
    blockers,
    nextActions: [
      futurePaperCloseRowsReady
        ? 'Let future gated paper/shadow close rows accumulate paperFillTelemetry; do not backfill old rows as promotion evidence.'
        : 'Fix every paper close producer so it uses buildPaperTradeCostEvidence and emits paper fill telemetry.',
      'Keep exchange-reconciled fill evidence and observed slippage blockers separate from paper-model diagnostics.',
      'Refresh paper:execution-quality after new paper/shadow rows close.',
    ],
    safetyNotes: [
      'This contract only verifies producer shape for future paper rows; it is not execution evidence.',
      'paperFillTelemetryStatus=paper_model_not_exchange_reconciled must not satisfy exchange-reconciled cost evidence or observed slippage gates.',
      'This artifact never authorizes paper, live, promotion, leverage changes, or best_config mutations.',
    ],
    outputHash: null,
  }
}

function closePathUsesSharedCostBuilder(text: string): boolean {
  return text.includes('appendPaperTradeResult') &&
    text.includes('buildPaperTradeCostEvidence') &&
    text.includes('buildPaperTradePredictedOpenEvidence')
}

async function readSource(path: string): Promise<SourceSnapshot> {
  try {
    return { path, exists: true, text: await readFile(path, 'utf-8') }
  } catch {
    return { path, exists: false, text: '' }
  }
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as unknown
  } catch {
    return null
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg?.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq >= 0) {
      out.set(arg.slice(2, eq), arg.slice(eq + 1))
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out.set(key, next)
      i += 1
    } else {
      out.set(key, 'true')
    }
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (value == null) return DEFAULT_OUTPUT_PATH
  const normalized = value.trim().toLowerCase()
  return normalized === '' || normalized === 'null' || normalized === 'none' ? null : value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  return ['true', '1', 'yes', 'y'].includes(value.trim().toLowerCase())
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function renderConsoleSummary(report: PaperExecutionProducerContractStatusReport): string {
  return [
    `Paper execution producer contract: ${report.status}`,
    `futureRowsReady=${report.producerContract.futurePaperCloseRowsReady}`,
    `historicalPaperFillTelemetry=${report.historicalExecutionQuality.tradesWithPaperFillTelemetry}/${report.historicalExecutionQuality.closedTrades}`,
    `exchangeReconciled=${report.historicalExecutionQuality.tradesWithExchangeReconciledCostEvidence}`,
    `paper=false live=false promotion=false execution=false`,
    `topBlockers=${report.blockers.slice(0, 8).join(',') || 'none'}`,
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
