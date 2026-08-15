import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type RawRecord = Record<string, unknown>

interface CliArgs {
  paperDir: string
  outputPath: string | null
  lookbackHours: number | null
  baselineSlippageBps: number
  maxSlippageBps: number
  json: boolean
}

interface NormalizedClosedTrade {
  tradeId: string
  source: string
  lane: string
  symbol: string
  side: 'long' | 'short' | 'unknown'
  openTs: string
  closeTs: string
  openPrice: number | null
  closePrice: number | null
  pnlPct: number
  routeCostBpsAtOpen: number | null
  roundTripCostBpsAtOpen: number | null
  estimatedRoundTripCostPctAtOpen: number | null
  realizedRoundTripCostBps: number | null
  realizedCostBps: number | null
  fillAdjustedCostBps: number | null
  fillAdjustedCostPct: number | null
  costEvidenceSource: string | null
  costEvidenceStatus: string | null
  paperFillTelemetryStatus: string | null
  paperFillModelSource: string | null
  paperFillExpectedCostBps: number | null
  paperFillExpectedCostPct: number | null
  paperFillSimulatedSlippageBps: number | null
  paperFillRouteCostBps: number | null
  paperFillIsExchangeReconciled: boolean | null
  predictedOpenEvidenceStatus: string | null
  matchPriceAtOpen: number | null
  matchPriceSourceAtOpen: string | null
}

export interface PaperExecutionQualityReport {
  generatedAt: string
  recentOrderCount: number
  slippageViolationCount: number
  actualToSimulatedCostRatio: number
  missedFillRate: number
  decayCircuitBreakerTriggered: false
  counterfactuals: []
  diagnosticOnly: true
  researchOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  sourceArtifacts: {
    paperDir: string
  }
  thresholds: {
    baselineSlippageBps: number
    maxSlippageBps: number
    lookbackHours: number | null
  }
  evidence: {
    closedTrades: number
    loadedRows: number
    duplicateTradesSkipped: number
    skippedOpenRows: number
    tradesWithAnyPredictedCost: number
    tradesWithCompletePredictedOpenEvidence: number
    tradesWithRealizedCostEvidence: number
    tradesWithFillAdjustedCostEvidence: number
    tradesWithExchangeReconciledCostEvidence: number
    paperModelOnlyCostEvidence: number
    simulatedFillMatchPriceTrades: number
    tradesWithPaperFillTelemetry: number
    tradesWithPaperFillExpectedCost: number
    tradesWithPaperFillSimulatedSlippage: number
    tradesWithPaperFillRouteCost: number
    paperFillExchangeReconciledFalse: number
    latestCloseTs: string | null
  }
  quality: {
    volumeWeightedSlippageBps: number | null
    maxObservedSlippageBps: number | null
    paperModelMeanExpectedCostBps: number | null
    paperModelMaxExpectedCostBps: number | null
    paperModelMeanSimulatedSlippageBps: number | null
    paperModelMaxSimulatedSlippageBps: number | null
    fillAdjustedCoveragePct: number
    exchangeReconciledCoveragePct: number
    paperFillTelemetryCoveragePct: number
    completePredictedOpenEvidenceCoveragePct: number
  }
  blockers: string[]
  safetyNotes: string[]
  outputHash: string | null
}

const DEFAULT_PAPER_DIR = 'data/paper_trading'
const DEFAULT_OUTPUT_PATH = 'data/runtime/execution_quality.latest.json'
const DEFAULT_BASELINE_SLIPPAGE_BPS = 8
const DEFAULT_MAX_SLIPPAGE_BPS = 25

async function main(): Promise<void> {
  const args = parsePaperExecutionQualityArgs(process.argv.slice(2))
  const report = await runPaperExecutionQuality(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parsePaperExecutionQualityArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    paperDir: raw.get('paperDir') ?? DEFAULT_PAPER_DIR,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    lookbackHours: parseNullablePositiveNumber(raw.get('lookbackHours'), null, 'lookbackHours'),
    baselineSlippageBps: parsePositiveNumber(raw.get('baselineSlippageBps'), DEFAULT_BASELINE_SLIPPAGE_BPS, 'baselineSlippageBps'),
    maxSlippageBps: parsePositiveNumber(raw.get('maxSlippageBps'), DEFAULT_MAX_SLIPPAGE_BPS, 'maxSlippageBps'),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runPaperExecutionQuality(args: CliArgs): Promise<PaperExecutionQualityReport> {
  const startedAt = new Date()
  const paperDir = resolve(args.paperDir)
  const loaded = await loadClosedPaperTrades(paperDir, args.lookbackHours)
  const report = buildPaperExecutionQualityReport({
    generatedAt: new Date().toISOString(),
    paperDir,
    args,
    loaded,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    const withoutHash = `${JSON.stringify({ ...report, outputHash: null }, null, 2)}\n`
    const outputHash = sha256Hex(withoutHash)
    const finalPayload = `${JSON.stringify({ ...report, outputHash }, null, 2)}\n`
    await writeFile(outputPath, finalPayload, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'paper_execution_quality',
      artifactPath: outputPath,
      manifestPath: `${outputPath}.manifest.json`,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.blockers.length > 0 ? 'fail' : 'pass',
      recordsIn: loaded.loadedRows,
      recordsOut: report.evidence.closedTrades,
      errorClass: report.blockers[0] ?? null,
      artifactHash: sha256Hex(finalPayload),
    })
    return { ...report, outputHash }
  }

  return report
}

export function buildPaperExecutionQualityReport(input: {
  generatedAt: string
  paperDir: string
  args: Pick<CliArgs, 'lookbackHours' | 'baselineSlippageBps' | 'maxSlippageBps'>
  loaded: Awaited<ReturnType<typeof loadClosedPaperTrades>>
}): PaperExecutionQualityReport {
  const trades = input.loaded.closedTrades
  const predictedCost = trades.filter(hasAnyPredictedCost)
  const completePredicted = trades.filter(hasCompletePredictedOpenEvidence)
  const realizedCost = trades.filter(hasRealizedCostEvidence)
  const fillAdjustedCost = trades.filter(hasFillAdjustedCostEvidence)
  const exchangeReconciled = trades.filter(trade => trade.costEvidenceSource === 'exchange_reconciled_fill')
  const paperModelOnly = trades.filter(trade => trade.costEvidenceSource === 'paper_cost_model_at_open')
  const simulatedFillMatchPrice = trades.filter(trade => trade.matchPriceSourceAtOpen === 'simulated_fill')
  const paperFillTelemetry = trades.filter(hasPaperFillTelemetry)
  const paperFillExpectedCosts = trades
    .map(trade => trade.paperFillExpectedCostBps)
    .filter((value): value is number => value != null && Number.isFinite(value) && value >= 0)
  const paperFillSimulatedSlippage = trades
    .map(trade => trade.paperFillSimulatedSlippageBps)
    .filter((value): value is number => value != null && Number.isFinite(value) && value >= 0)
  const paperFillRouteCosts = trades
    .map(trade => trade.paperFillRouteCostBps)
    .filter((value): value is number => value != null && Number.isFinite(value) && value >= 0)
  const slippageBps = trades.flatMap(trade => observedSlippageBps(trade) == null ? [] : [observedSlippageBps(trade) as number])
  const maxObservedSlippageBps = slippageBps.length > 0 ? Math.max(...slippageBps.map(Math.abs)) : null
  const volumeWeightedSlippageBps = slippageBps.length > 0 ? mean(slippageBps) : null
  const slippageViolationCount = slippageBps.filter(value => Math.abs(value) > input.args.maxSlippageBps).length
  const actualToSimulatedCostRatio = computeActualToSimulatedCostRatio(trades, input.args.baselineSlippageBps)
  const latestCloseTs = trades
    .map(trade => Date.parse(trade.closeTs))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0]
  const blockers = uniqueStrings([
    ...(trades.length > 0 ? [] : ['paper_execution_trades_missing']),
    ...(completePredicted.length > 0 ? [] : ['paper_execution_complete_predicted_open_evidence_missing']),
    ...(fillAdjustedCost.length > 0 ? [] : ['paper_execution_fill_adjusted_cost_evidence_missing']),
    ...(exchangeReconciled.length > 0 ? [] : ['paper_execution_exchange_reconciled_cost_evidence_missing']),
    ...(slippageBps.length > 0 ? [] : ['paper_execution_observed_slippage_unavailable']),
    ...(slippageViolationCount === 0 ? [] : [`paper_execution_slippage_violations:${slippageViolationCount}`]),
  ])

  return {
    generatedAt: input.generatedAt,
    recentOrderCount: trades.length,
    slippageViolationCount,
    actualToSimulatedCostRatio,
    missedFillRate: 0,
    decayCircuitBreakerTriggered: false,
    counterfactuals: [],
    diagnosticOnly: true,
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    sourceArtifacts: {
      paperDir: input.paperDir,
    },
    thresholds: {
      baselineSlippageBps: input.args.baselineSlippageBps,
      maxSlippageBps: input.args.maxSlippageBps,
      lookbackHours: input.args.lookbackHours,
    },
    evidence: {
      closedTrades: trades.length,
      loadedRows: input.loaded.loadedRows,
      duplicateTradesSkipped: input.loaded.duplicateTradesSkipped,
      skippedOpenRows: input.loaded.skippedOpenRows,
      tradesWithAnyPredictedCost: predictedCost.length,
      tradesWithCompletePredictedOpenEvidence: completePredicted.length,
      tradesWithRealizedCostEvidence: realizedCost.length,
      tradesWithFillAdjustedCostEvidence: fillAdjustedCost.length,
      tradesWithExchangeReconciledCostEvidence: exchangeReconciled.length,
      paperModelOnlyCostEvidence: paperModelOnly.length,
      simulatedFillMatchPriceTrades: simulatedFillMatchPrice.length,
      tradesWithPaperFillTelemetry: paperFillTelemetry.length,
      tradesWithPaperFillExpectedCost: paperFillExpectedCosts.length,
      tradesWithPaperFillSimulatedSlippage: paperFillSimulatedSlippage.length,
      tradesWithPaperFillRouteCost: paperFillRouteCosts.length,
      paperFillExchangeReconciledFalse: trades.filter(trade => trade.paperFillIsExchangeReconciled === false).length,
      latestCloseTs: latestCloseTs == null ? null : new Date(latestCloseTs).toISOString(),
    },
    quality: {
      volumeWeightedSlippageBps,
      maxObservedSlippageBps,
      paperModelMeanExpectedCostBps: paperFillExpectedCosts.length > 0 ? roundMetric(mean(paperFillExpectedCosts)) : null,
      paperModelMaxExpectedCostBps: paperFillExpectedCosts.length > 0 ? roundMetric(Math.max(...paperFillExpectedCosts)) : null,
      paperModelMeanSimulatedSlippageBps: paperFillSimulatedSlippage.length > 0 ? roundMetric(mean(paperFillSimulatedSlippage)) : null,
      paperModelMaxSimulatedSlippageBps: paperFillSimulatedSlippage.length > 0 ? roundMetric(Math.max(...paperFillSimulatedSlippage)) : null,
      fillAdjustedCoveragePct: coveragePct(fillAdjustedCost.length, trades.length),
      exchangeReconciledCoveragePct: coveragePct(exchangeReconciled.length, trades.length),
      paperFillTelemetryCoveragePct: coveragePct(paperFillTelemetry.length, trades.length),
      completePredictedOpenEvidenceCoveragePct: coveragePct(completePredicted.length, trades.length),
    },
    blockers,
    safetyNotes: [
      'This artifact is paper execution telemetry only; it is not exchange-reconciled unless costEvidenceSource=exchange_reconciled_fill is present on source rows.',
      'Paper-model-only cost evidence remains diagnostic and must not be counted as promotion-grade fill evidence.',
      'paperFillTelemetryStatus=paper_model_not_exchange_reconciled is useful for future paper diagnostics but does not satisfy observed slippage or exchange reconciliation gates.',
      'This producer never authorizes paper, live, promotion, or execution.',
    ],
    outputHash: null,
  }
}

async function loadClosedPaperTrades(
  paperDir: string,
  lookbackHours: number | null,
): Promise<{
  closedTrades: NormalizedClosedTrade[]
  loadedRows: number
  duplicateTradesSkipped: number
  skippedOpenRows: number
}> {
  const cutoffMs = lookbackHours == null ? null : Date.now() - lookbackHours * 60 * 60 * 1000
  const closedTrades: NormalizedClosedTrade[] = []
  const seen = new Set<string>()
  let loadedRows = 0
  let duplicateTradesSkipped = 0
  let skippedOpenRows = 0

  const add = (record: RawRecord, source: string): void => {
    loadedRows += 1
    const trade = normalizeClosedTrade(record, source)
    if (!trade) {
      skippedOpenRows += 1
      return
    }
    if (cutoffMs != null && Date.parse(trade.closeTs) < cutoffMs) return
    if (seen.has(trade.tradeId)) {
      duplicateTradesSkipped += 1
      return
    }
    seen.add(trade.tradeId)
    closedTrades.push(trade)
  }

  for (const record of await readJsonl(join(paperDir, 'paper_trade_result.jsonl'))) add(record, 'paper_trade_result.jsonl')
  for (const path of await discoverAccountJsonFiles(paperDir)) {
    const json = await readJson(path)
    const history = Array.isArray(json?.tradeHistory) ? json.tradeHistory : []
    for (const record of history) {
      if (isRecord(record)) add(record, path)
    }
  }
  for (const path of await discoverTradeLogFiles(paperDir)) {
    for (const record of await readJsonl(path)) add(record, path)
  }

  return { closedTrades, loadedRows, duplicateTradesSkipped, skippedOpenRows }
}

function normalizeClosedTrade(record: RawRecord, source: string): NormalizedClosedTrade | null {
  const closeTs = stringOrNull(record.closeTs ?? record.exitTime)
  const pnlPct = numberOrNull(record.pnlPct)
  if (!closeTs || pnlPct == null) return null
  const tradeId = stringOrNull(record.tradeId ?? record.id) ??
    `${source}:${stringOrNull(record.symbol) ?? 'unknown'}:${closeTs}`
  return {
    tradeId,
    source,
    lane: stringOrNull(record.lane) ?? inferLane(record, source),
    symbol: stringOrNull(record.symbol) ?? 'unknown',
    side: parseSide(record.side ?? record.direction),
    openTs: stringOrNull(record.openTs ?? record.entryTime) ?? closeTs,
    closeTs,
    openPrice: numberOrNull(record.openPrice ?? record.entryPrice),
    closePrice: numberOrNull(record.closePrice ?? record.exitPrice),
    pnlPct,
    routeCostBpsAtOpen: numberOrNull(record.routeCostBpsAtOpen ?? record.routeCostBps),
    roundTripCostBpsAtOpen: numberOrNull(record.roundTripCostBpsAtOpen ?? record.roundTripCostBps),
    estimatedRoundTripCostPctAtOpen: numberOrNull(record.estimatedRoundTripCostPctAtOpen),
    realizedRoundTripCostBps: numberOrNull(record.realizedRoundTripCostBps),
    realizedCostBps: numberOrNull(record.realizedCostBps),
    fillAdjustedCostBps: numberOrNull(record.fillAdjustedCostBps),
    fillAdjustedCostPct: numberOrNull(record.fillAdjustedCostPct),
    costEvidenceSource: stringOrNull(record.costEvidenceSource),
    costEvidenceStatus: stringOrNull(record.costEvidenceStatus),
    paperFillTelemetryStatus: stringOrNull(record.paperFillTelemetryStatus),
    paperFillModelSource: stringOrNull(record.paperFillModelSource),
    paperFillExpectedCostBps: numberOrNull(record.paperFillExpectedCostBps),
    paperFillExpectedCostPct: numberOrNull(record.paperFillExpectedCostPct),
    paperFillSimulatedSlippageBps: numberOrNull(record.paperFillSimulatedSlippageBps),
    paperFillRouteCostBps: numberOrNull(record.paperFillRouteCostBps),
    paperFillIsExchangeReconciled: booleanOrNull(record.paperFillIsExchangeReconciled),
    predictedOpenEvidenceStatus: stringOrNull(record.predictedOpenEvidenceStatus),
    matchPriceAtOpen: numberOrNull(record.matchPriceAtOpen ?? record.matchPrice),
    matchPriceSourceAtOpen: stringOrNull(record.matchPriceSourceAtOpen ?? record.matchPriceSource),
  }
}

function hasAnyPredictedCost(trade: NormalizedClosedTrade): boolean {
  return trade.routeCostBpsAtOpen != null ||
    trade.roundTripCostBpsAtOpen != null ||
    trade.estimatedRoundTripCostPctAtOpen != null
}

function hasCompletePredictedOpenEvidence(trade: NormalizedClosedTrade): boolean {
  return trade.predictedOpenEvidenceStatus === 'ok'
}

function hasRealizedCostEvidence(trade: NormalizedClosedTrade): boolean {
  if (trade.costEvidenceSource === 'paper_cost_model_at_open') return false
  return trade.realizedRoundTripCostBps != null ||
    trade.realizedCostBps != null ||
    trade.fillAdjustedCostBps != null ||
    trade.fillAdjustedCostPct != null
}

function hasFillAdjustedCostEvidence(trade: NormalizedClosedTrade): boolean {
  if (trade.costEvidenceSource === 'paper_cost_model_at_open') return false
  return trade.fillAdjustedCostBps != null || trade.fillAdjustedCostPct != null
}

function hasPaperFillTelemetry(trade: NormalizedClosedTrade): boolean {
  return trade.paperFillTelemetryStatus === 'paper_model_not_exchange_reconciled' &&
    trade.paperFillIsExchangeReconciled === false &&
    trade.paperFillExpectedCostBps != null
}

function observedSlippageBps(trade: NormalizedClosedTrade): number | null {
  if (trade.costEvidenceSource !== 'exchange_reconciled_fill') return null
  if (trade.realizedCostBps != null && trade.realizedCostBps >= 0) return trade.realizedCostBps
  if (trade.fillAdjustedCostBps != null && trade.fillAdjustedCostBps >= 0) return trade.fillAdjustedCostBps
  if (trade.fillAdjustedCostPct != null && trade.fillAdjustedCostPct >= 0) return trade.fillAdjustedCostPct * 100
  return null
}

function computeActualToSimulatedCostRatio(trades: NormalizedClosedTrade[], baselineSlippageBps: number): number {
  const pairs = trades
    .map(trade => {
      const actual = observedSlippageBps(trade)
      const expected = trade.roundTripCostBpsAtOpen ?? trade.routeCostBpsAtOpen ??
        (trade.estimatedRoundTripCostPctAtOpen == null ? null : trade.estimatedRoundTripCostPctAtOpen * 100)
      if (actual == null || expected == null || expected <= 0) return null
      return actual / expected
    })
    .filter((value): value is number => value != null && Number.isFinite(value))
  if (pairs.length > 0) return roundMetric(mean(pairs))
  return 1
}

async function discoverAccountJsonFiles(paperDir: string): Promise<string[]> {
  const files: string[] = []
  for (const name of await safeReaddir(paperDir)) {
    if (/^account.*\.json$/.test(name)) files.push(join(paperDir, name))
  }
  const accountsDir = join(paperDir, 'accounts')
  for (const accountId of await safeReaddir(accountsDir)) {
    const path = join(accountsDir, accountId, 'account.json')
    if (existsSync(path)) files.push(path)
  }
  return files
}

async function discoverTradeLogFiles(paperDir: string): Promise<string[]> {
  const files: string[] = []
  const rootLog = join(paperDir, 'trade_log.jsonl')
  if (existsSync(rootLog)) files.push(rootLog)
  const accountsDir = join(paperDir, 'accounts')
  for (const accountId of await safeReaddir(accountsDir)) {
    const path = join(accountsDir, accountId, 'trade_log.jsonl')
    if (existsSync(path)) files.push(path)
  }
  return files
}

async function readJsonl(path: string): Promise<RawRecord[]> {
  if (!existsSync(path)) return []
  const raw = await readFile(path, 'utf-8')
  const rows: RawRecord[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (isRecord(parsed)) rows.push(parsed)
    } catch {
      // Ignore partially written rows.
    }
  }
  return rows
}

async function readJson(path: string): Promise<RawRecord | null> {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq >= 0) {
      map.set(arg.slice(2, eq), arg.slice(eq + 1))
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      map.set(key, next)
      i += 1
    } else {
      map.set(key, 'true')
    }
  }
  return map
}

function parseNullablePath(value: string | undefined): string | null {
  if (value == null) return DEFAULT_OUTPUT_PATH
  return value === 'null' || value === 'none' || value === '' ? null : value
}

function parsePositiveNumber(value: string | undefined, fallback: number, name: string): number {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name}_must_be_positive`)
  return parsed
}

function parseNullablePositiveNumber(value: string | undefined, fallback: number | null, name: string): number | null {
  if (value == null || value === '' || value === 'null' || value === 'none') return fallback
  return parsePositiveNumber(value, fallback ?? 1, name)
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  return value === 'true' || value === '1' || value === 'yes'
}

function isRecord(value: unknown): value is RawRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function parseSide(value: unknown): 'long' | 'short' | 'unknown' {
  if (value === 'long' || value === 'buy') return 'long'
  if (value === 'short' || value === 'sell') return 'short'
  return 'unknown'
}

function inferLane(record: RawRecord, source: string): string {
  const accountId = stringOrNull(record.accountId)
  if (accountId?.includes('vb')) return `volume_breakout_${accountId.includes('3x') ? '3x' : '1x'}`
  if (accountId?.includes('stress_10x')) return 'microstructure_10x'
  if (accountId?.includes('liquidation_probe_100x')) return 'microstructure_100x'
  if (source.includes('vb')) return 'volume_breakout'
  return 'cross_sectional'
}

function coveragePct(count: number, total: number): number {
  return total <= 0 ? 0 : roundMetric(count / total * 100)
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function renderConsoleSummary(report: PaperExecutionQualityReport): string {
  return [
    `Paper execution quality: ${report.blockers.length > 0 ? 'blocked' : 'ok'}`,
    `recentOrderCount=${report.recentOrderCount}`,
    `completePredicted=${report.evidence.tradesWithCompletePredictedOpenEvidence}/${report.evidence.closedTrades}`,
    `exchangeReconciled=${report.evidence.tradesWithExchangeReconciledCostEvidence}/${report.evidence.closedTrades}`,
    `paper=false live=false promotion=false execution=false`,
    `topBlockers=${report.blockers.slice(0, 6).join(',') || 'none'}`,
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
