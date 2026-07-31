import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>
type ReadinessStatus = 'blocked' | 'watch_only'
interface OrderbookQualityBySymbol {
  symbol: string
  status: string | null
  blockers: string[]
  spreadBps: number | null
  depth5Usd: number | null
  bidNotionalDepth5: number | null
  askNotionalDepth5: number | null
  availableAt: string | null
  eventTime: string | null
}

interface CliArgs {
  outputPath: string | null
  orderbookPath: string
  orderbookRowsPath: string
  feeSnapshotPath: string
  feeSnapshotRefreshPath: string
  routeCostBudgetPath: string
  executionQualityPath: string
  paperPnlDiagnosticsPath: string
  paperFutureTelemetryWatchdogPath: string
  maxOrderbookAgeMs: number
  maxFeeSnapshotAgeMs: number
  maxRouteBudgetAgeMs: number
  minOrderbookRows: number
  requiredOrderbookSymbols: string[]
  minPaperExecutionOrders: number
  minCompletePredictedCostCoveragePct: number
  json: boolean
}

export interface OkxRouteCostSlippageReadinessReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: ReadinessStatus
  sourceArtifacts: {
    orderbookPath: string
    orderbookRowsPath: string
    feeSnapshotPath: string
    feeSnapshotRefreshPath: string
    routeCostBudgetPath: string
    executionQualityPath: string
    paperPnlDiagnosticsPath: string
    paperFutureTelemetryWatchdogPath: string
  }
  thresholds: {
    maxOrderbookAgeMs: number
    maxFeeSnapshotAgeMs: number
    maxRouteBudgetAgeMs: number
    minOrderbookRows: number
    requiredOrderbookSymbols: string[]
    minPaperExecutionOrders: number
    minCompletePredictedCostCoveragePct: number
  }
  orderbook: {
    exists: boolean
    status: string | null
    generatedAt: string | null
    ageMs: number | null
    stale: boolean
    rowsBuilt: number
    blockedRows: number
    maxSpreadBps: number | null
    medianSpreadBps: number | null
    minDepth5Usd: number | null
    qualityBySymbol: OrderbookQualityBySymbol[]
    cacheQualityBySymbol: OrderbookQualityBySymbol[]
    cacheSymbolsUsed: string[]
    cacheFallbackUsed: boolean
    requiredOrderbookSymbols: string[]
    requiredOrderbookPassedSymbols: string[]
    requiredOrderbookBlockedSymbols: string[]
    requiredOrderbookMissingSymbols: string[]
    requiredOrderbookAllPass: boolean
    blockers: string[]
  }
  feeSnapshot: {
    exists: boolean
    source: string | null
    verifiedByRuntime: boolean | null
    sourceFetchedAt: string | null
    expiresAt: string | null
    stale: boolean
    makerFeeBps: number | null
    takerFeeBps: number | null
  }
  feeSnapshotRefresh: {
    exists: boolean
    status: string | null
    generatedAt: string | null
    snapshotWritten: boolean | null
    perSymbolFeesCount: number
    blockers: string[]
  }
  routeCostBudget: {
    exists: boolean
    generatedAt: string | null
    ageMs: number | null
    stale: boolean
    feeSnapshotSource: string | null
    feeSnapshotVerifiedByRuntime: boolean | null
    feeSnapshotExpiresAt: string | null
    feeSnapshotMatchesRuntimeFeeSnapshot: boolean | null
    routeCount: number
    routesOverBudget: string[]
    selectedSafeResearchRoute: string | null
  }
  executionQuality: {
    exists: boolean
    generatedAt: string | null
    recentOrderCount: number
    slippageViolationCount: number | null
    actualToSimulatedCostRatio: number | null
    missedFillRate: number | null
    telemetryShapeComplete: boolean
    observedSlippageAvailable: boolean
    telemetrySufficient: boolean
  }
  paperCostEvidence: {
    exists: boolean
    source: 'execution_quality' | 'paper_pnl_diagnostics' | 'missing'
    closedTrades: number
    tradesWithAnyPredictedCost: number
    tradesWithCompletePredictedOpenEvidence: number
    completePredictedOpenEvidenceCoveragePct: number | null
    tradesWithAnyRealizedCost: number
    tradesWithFillAdjustedCost: number
    tradesWithExchangeReconciledCostEvidence: number
    tradesWithPaperFillTelemetry: number
    paperFillTelemetryCoveragePct: number | null
    status: string | null
  }
  paperFutureTelemetry: {
    exists: boolean
    status: string | null
    monitoringStartedAt: string | null
    futureClosedRows: number
    futureRowsWithPaperFillTelemetry: number
    futureRowsWithCompletePredictedOpenEvidence: number
    futureRowsWithExchangeReconciledCostEvidence: number
    futureRowsWithObservedSlippage: number
    futurePaperFillTelemetryCoveragePct: number | null
    futureNewOpenPredictedOpenEvidenceCoveragePct: number | null
    futureExchangeReconciledCostCoveragePct: number | null
    futureObservedSlippageCoveragePct: number | null
    futurePaperFillTelemetrySufficient: boolean
    futurePredictedOpenEvidenceSufficient: boolean
    futureExchangeReconciledCostEvidenceAvailable: boolean
    futureObservedSlippageAvailable: boolean
    telemetryGapStatus: string | null
    telemetryGapMonitoringAgeMinutes: number | null
    telemetryGapLatestClosedAt: string | null
    telemetryGapLatestClosedBeforeMonitoringStart: boolean | null
    telemetryGapFutureClosedRowsAfterMonitoringStart: number | null
    telemetryGapFutureRowsMissingPaperFillTelemetry: number | null
    telemetryGapFutureNewOpenRowsMissingPredictedOpenEvidence: number | null
    blockers: string[]
    evidenceBlockers: string[]
  }
  readiness: {
    publicOrderbookUsableForResearch: boolean
    runtimeFeeSnapshotUsableForResearch: boolean
    routeCostBudgetRuntimeVerified: boolean
    routeCostBudgetFresh: boolean
    paperExecutionTelemetryAvailable: boolean
    promotionGradeRouteCostEvidence: false
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
  outputHash: string | null
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/okx_route_cost_slippage_readiness.latest.json'
const DEFAULT_ORDERBOOK_PATH = 'data/runtime/okx_orderbook_spread_snapshot.latest.json'
const DEFAULT_ORDERBOOK_ROWS_PATH = 'data/normalized/orderbook/okx_swap_orderbook_spread_live.normalized.jsonl'
const DEFAULT_FEE_SNAPSHOT_PATH = 'data/runtime/fee_snapshot.latest.json'
const DEFAULT_FEE_SNAPSHOT_REFRESH_PATH = 'data/runtime/fee_snapshot_refresh.latest.json'
const DEFAULT_ROUTE_COST_BUDGET_PATH = 'data/runtime/route_cost_budget.latest.json'
const DEFAULT_EXECUTION_QUALITY_PATH = 'data/runtime/execution_quality.latest.json'
const DEFAULT_PAPER_PNL_DIAGNOSTICS_PATH = 'data/research/paper_pnl_diagnostics.latest.json'
const DEFAULT_PAPER_FUTURE_TELEMETRY_WATCHDOG_PATH = 'data/runtime/paper_execution_future_telemetry_watchdog.latest.json'

const DEFAULT_MAX_ORDERBOOK_AGE_MS = 2 * 60 * 60 * 1000
const DEFAULT_MAX_FEE_SNAPSHOT_AGE_MS = 26 * 60 * 60 * 1000
const DEFAULT_MAX_ROUTE_BUDGET_AGE_MS = 26 * 60 * 60 * 1000
const DEFAULT_MIN_ORDERBOOK_ROWS = 3
const DEFAULT_REQUIRED_ORDERBOOK_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
const DEFAULT_MIN_PAPER_EXECUTION_ORDERS = 20
const DEFAULT_MIN_COMPLETE_PREDICTED_COST_COVERAGE_PCT = 95

async function main(): Promise<void> {
  const args = parseOkxRouteCostSlippageReadinessArgs(process.argv.slice(2))
  const report = await runOkxRouteCostSlippageReadiness(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseOkxRouteCostSlippageReadinessArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const dataRoot = raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT
  const defaultOrderbookRowsPath = dataRoot
    ? resolve(dataRoot, 'normalized/orderbook/okx_swap_orderbook_spread_live.normalized.jsonl')
    : DEFAULT_ORDERBOOK_ROWS_PATH
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    orderbookPath: raw.get('orderbookPath') ?? DEFAULT_ORDERBOOK_PATH,
    orderbookRowsPath: raw.get('orderbookRowsPath') ?? defaultOrderbookRowsPath,
    feeSnapshotPath: raw.get('feeSnapshotPath') ?? DEFAULT_FEE_SNAPSHOT_PATH,
    feeSnapshotRefreshPath: raw.get('feeSnapshotRefreshPath') ?? DEFAULT_FEE_SNAPSHOT_REFRESH_PATH,
    routeCostBudgetPath: raw.get('routeCostBudgetPath') ?? DEFAULT_ROUTE_COST_BUDGET_PATH,
    executionQualityPath: raw.get('executionQualityPath') ?? DEFAULT_EXECUTION_QUALITY_PATH,
    paperPnlDiagnosticsPath: raw.get('paperPnlDiagnosticsPath') ?? DEFAULT_PAPER_PNL_DIAGNOSTICS_PATH,
    paperFutureTelemetryWatchdogPath: raw.get('paperFutureTelemetryWatchdogPath') ?? DEFAULT_PAPER_FUTURE_TELEMETRY_WATCHDOG_PATH,
    maxOrderbookAgeMs: parsePositiveInteger(raw.get('maxOrderbookAgeMs'), DEFAULT_MAX_ORDERBOOK_AGE_MS, 'maxOrderbookAgeMs'),
    maxFeeSnapshotAgeMs: parsePositiveInteger(raw.get('maxFeeSnapshotAgeMs'), DEFAULT_MAX_FEE_SNAPSHOT_AGE_MS, 'maxFeeSnapshotAgeMs'),
    maxRouteBudgetAgeMs: parsePositiveInteger(raw.get('maxRouteBudgetAgeMs'), DEFAULT_MAX_ROUTE_BUDGET_AGE_MS, 'maxRouteBudgetAgeMs'),
    minOrderbookRows: parsePositiveInteger(raw.get('minOrderbookRows'), DEFAULT_MIN_ORDERBOOK_ROWS, 'minOrderbookRows'),
    requiredOrderbookSymbols: parseSymbols(raw.get('requiredOrderbookSymbols') ?? raw.get('requiredSymbols'), DEFAULT_REQUIRED_ORDERBOOK_SYMBOLS),
    minPaperExecutionOrders: parsePositiveInteger(raw.get('minPaperExecutionOrders'), DEFAULT_MIN_PAPER_EXECUTION_ORDERS, 'minPaperExecutionOrders'),
    minCompletePredictedCostCoveragePct: parsePositiveNumber(
      raw.get('minCompletePredictedCostCoveragePct'),
      DEFAULT_MIN_COMPLETE_PREDICTED_COST_COVERAGE_PCT,
      'minCompletePredictedCostCoveragePct',
    ),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runOkxRouteCostSlippageReadiness(
  args: CliArgs,
): Promise<OkxRouteCostSlippageReadinessReport> {
  const startedAt = new Date()
  const report = buildOkxRouteCostSlippageReadinessReport({
    generatedAt: new Date().toISOString(),
    asOfMs: Date.now(),
    args,
    orderbook: asRecord(await readJsonIfExists(args.orderbookPath)),
    orderbookRows: readOrderbookRowsIfExists(args.orderbookRowsPath),
    feeSnapshot: asRecord(await readJsonIfExists(args.feeSnapshotPath)),
    feeSnapshotRefresh: asRecord(await readJsonIfExists(args.feeSnapshotRefreshPath)),
    routeCostBudget: asRecord(await readJsonIfExists(args.routeCostBudgetPath)),
    executionQuality: asRecord(await readJsonIfExists(args.executionQualityPath)),
    paperPnlDiagnostics: asRecord(await readJsonIfExists(args.paperPnlDiagnosticsPath)),
    paperFutureTelemetryWatchdog: asRecord(await readJsonIfExists(args.paperFutureTelemetryWatchdogPath)),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    const withoutHash = `${JSON.stringify({ ...report, outputHash: null }, null, 2)}\n`
    const outputHash = sha256Hex(withoutHash)
    const finalPayload = `${JSON.stringify({ ...report, outputHash }, null, 2)}\n`
    await writeFile(outputPath, finalPayload, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'okx_route_cost_slippage_readiness',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'blocked' ? 'fail' : 'warn',
      recordsIn: 6,
      recordsOut: report.blockers.length,
      errorClass: report.blockers[0] ?? null,
      artifactHash: sha256Hex(finalPayload),
    })
    return { ...report, outputHash }
  }

  return report
}

export function buildOkxRouteCostSlippageReadinessReport(input: {
  generatedAt: string
  asOfMs: number
  args: CliArgs
  orderbook: UnknownRecord | null
  orderbookRows?: UnknownRecord[]
  feeSnapshot: UnknownRecord | null
  feeSnapshotRefresh: UnknownRecord | null
  routeCostBudget: UnknownRecord | null
  executionQuality: UnknownRecord | null
  paperPnlDiagnostics: UnknownRecord | null
  paperFutureTelemetryWatchdog: UnknownRecord | null
}): OkxRouteCostSlippageReadinessReport {
  const args = input.args
  const sourceArtifacts = {
    orderbookPath: resolve(args.orderbookPath),
    orderbookRowsPath: resolve(args.orderbookRowsPath),
    feeSnapshotPath: resolve(args.feeSnapshotPath),
    feeSnapshotRefreshPath: resolve(args.feeSnapshotRefreshPath),
    routeCostBudgetPath: resolve(args.routeCostBudgetPath),
    executionQualityPath: resolve(args.executionQualityPath),
    paperPnlDiagnosticsPath: resolve(args.paperPnlDiagnosticsPath),
    paperFutureTelemetryWatchdogPath: resolve(args.paperFutureTelemetryWatchdogPath),
  }

  const orderbookCounts = asRecord(input.orderbook?.counts)
  const spreadSummary = asRecord(input.orderbook?.spreadSummary)
  const orderbookGeneratedAt = readString(input.orderbook?.generatedAt)
  const orderbookAgeMs = ageMs(orderbookGeneratedAt, input.asOfMs)
  const orderbookAllowsExecution = artifactAllowsExecution(input.orderbook)
  const requiredOrderbookSymbols = args.requiredOrderbookSymbols
  const rawOrderbookQualityBySymbol = readOrderbookQualityBySymbol(input.orderbook?.qualityBySymbol)
  const cacheQualityBySymbol = buildRecentOrderbookQualityCache(input.orderbookRows ?? [], requiredOrderbookSymbols, input.asOfMs, args.maxOrderbookAgeMs)
  const rawOrderbookQualityBySymbolMap = new Map(rawOrderbookQualityBySymbol.map(row => [row.symbol, row]))
  const orderbookQualityBySymbol = requiredOrderbookSymbols
    .map(symbol => {
      const raw = rawOrderbookQualityBySymbolMap.get(symbol)
      if (raw?.status === 'pass' && raw.blockers.length === 0 && !isOlderThan(raw.availableAt, input.asOfMs, args.maxOrderbookAgeMs)) return raw
      return cacheQualityBySymbol.find(row => row.symbol === symbol) ?? raw ?? null
    })
    .filter((row): row is OrderbookQualityBySymbol => row != null)
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
  const orderbookQualityBySymbolMap = new Map(orderbookQualityBySymbol.map(row => [row.symbol, row]))
  const orderbookSymbols = uniqueStrings([
    ...readStringArray(input.orderbook?.symbols).map(normalizeSymbol),
    ...orderbookQualityBySymbol.map(row => row.symbol),
  ])
  const hasSymbolScopedOrderbookEvidence = orderbookQualityBySymbol.length > 0 || orderbookSymbols.length > 0
  const requiredOrderbookMissingSymbols = hasSymbolScopedOrderbookEvidence
    ? requiredOrderbookSymbols.filter(symbol => !orderbookSymbols.includes(symbol))
    : []
  const requiredOrderbookBlockedSymbols = orderbookQualityBySymbol.length > 0
    ? requiredOrderbookSymbols.filter(symbol => {
        const quality = orderbookQualityBySymbolMap.get(symbol)
        return quality?.status === 'blocked' || (quality?.blockers.length ?? 0) > 0
      })
    : []
  const requiredOrderbookPassedSymbols = orderbookQualityBySymbol.length > 0
    ? requiredOrderbookSymbols.filter(symbol => orderbookQualityBySymbolMap.get(symbol)?.status === 'pass')
    : hasSymbolScopedOrderbookEvidence
      ? requiredOrderbookSymbols.filter(symbol => orderbookSymbols.includes(symbol))
      : []
  const orderbookBlockedRows = readNumber(orderbookCounts?.blockedRows) ?? 0
  const cacheFallbackUsed = cacheQualityBySymbol.some(row => rawOrderbookQualityBySymbolMap.get(row.symbol) !== row && orderbookQualityBySymbolMap.get(row.symbol) === row)
  const requiredOrderbookAllPass = hasSymbolScopedOrderbookEvidence
    ? requiredOrderbookMissingSymbols.length === 0 &&
      requiredOrderbookBlockedSymbols.length === 0 &&
      (orderbookQualityBySymbol.length > 0 || orderbookBlockedRows === 0)
    : orderbookBlockedRows === 0
  const requiredOrderbookMinRows = Math.min(args.minOrderbookRows, Math.max(1, requiredOrderbookSymbols.length))
  const orderbook = {
    exists: input.orderbook != null,
    status: readString(input.orderbook?.status),
    generatedAt: orderbookGeneratedAt,
    ageMs: orderbookAgeMs,
    stale: orderbookAgeMs == null || orderbookAgeMs > args.maxOrderbookAgeMs,
    rowsBuilt: Math.max(readNumber(orderbookCounts?.rowsBuilt) ?? 0, orderbookQualityBySymbol.length),
    blockedRows: orderbookBlockedRows,
    maxSpreadBps: readNumber(spreadSummary?.maxSpreadBps),
    medianSpreadBps: readNumber(spreadSummary?.medianSpreadBps),
    minDepth5Usd: readNumber(spreadSummary?.minDepth5Usd),
    qualityBySymbol: orderbookQualityBySymbol,
    cacheQualityBySymbol,
    cacheSymbolsUsed: cacheFallbackUsed
      ? cacheQualityBySymbol.filter(row => orderbookQualityBySymbolMap.get(row.symbol) === row).map(row => row.symbol)
      : [],
    cacheFallbackUsed,
    requiredOrderbookSymbols,
    requiredOrderbookPassedSymbols,
    requiredOrderbookBlockedSymbols,
    requiredOrderbookMissingSymbols,
    requiredOrderbookAllPass,
    blockers: cacheFallbackUsed
      ? readStringArray(input.orderbook?.blockers)
        .filter(blocker => !blocker.startsWith('okx_orderbook_spread_rows_missing:') && !blocker.startsWith('okx_orderbook_spread_errors:'))
      : readStringArray(input.orderbook?.blockers),
  }
  const scopedOrderbookBlockerDetails = orderbookQualityBySymbol
    .filter(row => requiredOrderbookBlockedSymbols.includes(row.symbol))
    .flatMap(row => row.blockers.slice(0, 6).map(blocker => `okx_orderbook_required_symbol:${row.symbol}:${blocker}`))
  const aggregateOrderbookBlockersRelevantToScope = orderbookQualityBySymbol.length > 0
    ? orderbook.blockers.filter(blocker => !blocker.startsWith('okx_orderbook_spread_quality_blocked_rows:'))
    : orderbook.blockers

  const feeSourceFetchedAt = readString(input.feeSnapshot?.sourceFetchedAt)
  const feeExpiresAt = readString(input.feeSnapshot?.expiresAt)
  const feeSnapshotStale = isExpired(feeExpiresAt, input.asOfMs) || isOlderThan(feeSourceFetchedAt, input.asOfMs, args.maxFeeSnapshotAgeMs)
  const feeSnapshot = {
    exists: input.feeSnapshot != null,
    source: readString(input.feeSnapshot?.source),
    verifiedByRuntime: readBoolean(input.feeSnapshot?.verifiedByRuntime),
    sourceFetchedAt: feeSourceFetchedAt,
    expiresAt: feeExpiresAt,
    stale: feeSnapshotStale,
    makerFeeBps: readNumber(input.feeSnapshot?.makerFeeBps),
    takerFeeBps: readNumber(input.feeSnapshot?.takerFeeBps),
  }

  const perSymbolFees = Array.isArray(input.feeSnapshotRefresh?.perSymbolFees) ? input.feeSnapshotRefresh.perSymbolFees : []
  const feeSnapshotRefresh = {
    exists: input.feeSnapshotRefresh != null,
    status: readString(input.feeSnapshotRefresh?.status),
    generatedAt: readString(input.feeSnapshotRefresh?.generatedAt),
    snapshotWritten: readBoolean(input.feeSnapshotRefresh?.snapshotWritten),
    perSymbolFeesCount: perSymbolFees.length,
    blockers: readStringArray(input.feeSnapshotRefresh?.blockers),
  }

  const routeFeeSnapshot = asRecord(input.routeCostBudget?.feeSnapshot)
  const routes = asRecord(input.routeCostBudget?.routes)
  const routeEntries = routes ? Object.entries(routes).map(([name, value]) => ({ name, value: asRecord(value) })) : []
  const routeCostGeneratedAt = readString(input.routeCostBudget?.generatedAt)
  const routeCostAgeMs = ageMs(routeCostGeneratedAt, input.asOfMs)
  const routesOverBudget = routeEntries
    .filter(({ value }) => {
      const total = readNumber(value?.totalExpectedCostBps)
      const max = readNumber(value?.maxAllowedCostBps)
      return total != null && max != null && total > max
    })
    .map(({ name }) => name)
  const selectedSafeResearchRoute = routeEntries
    .filter(({ value }) => {
      const total = readNumber(value?.totalExpectedCostBps)
      const max = readNumber(value?.maxAllowedCostBps)
      return total != null && max != null && total <= max
    })
    .map(({ name, value }) => ({
      name,
      total: readNumber(value?.totalExpectedCostBps) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((left, right) => left.total - right.total)[0]?.name ?? null
  const routeCostBudget = {
    exists: input.routeCostBudget != null,
    generatedAt: routeCostGeneratedAt,
    ageMs: routeCostAgeMs,
    stale: routeCostAgeMs == null || routeCostAgeMs > args.maxRouteBudgetAgeMs || isExpired(readString(routeFeeSnapshot?.expiresAt), input.asOfMs),
    feeSnapshotSource: readString(routeFeeSnapshot?.source),
    feeSnapshotVerifiedByRuntime: readBoolean(routeFeeSnapshot?.verifiedByRuntime),
    feeSnapshotExpiresAt: readString(routeFeeSnapshot?.expiresAt),
    feeSnapshotMatchesRuntimeFeeSnapshot: input.feeSnapshot && routeFeeSnapshot
      ? sha256Hex(JSON.stringify(input.feeSnapshot)) === sha256Hex(JSON.stringify(routeFeeSnapshot))
      : null,
    routeCount: routeEntries.length,
    routesOverBudget,
    selectedSafeResearchRoute,
  }
  const routeCostBudgetHasSafeRoute = routeCostBudget.selectedSafeResearchRoute != null

  const executionQualityQuality = asRecord(input.executionQuality?.quality)
  const executionQualityMetricsComplete =
    readNumber(input.executionQuality?.slippageViolationCount) != null &&
    readNumber(input.executionQuality?.actualToSimulatedCostRatio) != null &&
    readNumber(input.executionQuality?.missedFillRate) != null
  const observedSlippageAvailable =
    readNumber(executionQualityQuality?.volumeWeightedSlippageBps) != null ||
    readNumber(executionQualityQuality?.maxObservedSlippageBps) != null
  const executionQuality = {
    exists: input.executionQuality != null,
    generatedAt: readString(input.executionQuality?.generatedAt),
    recentOrderCount: readNumber(input.executionQuality?.recentOrderCount) ?? 0,
    slippageViolationCount: readNumber(input.executionQuality?.slippageViolationCount),
    actualToSimulatedCostRatio: readNumber(input.executionQuality?.actualToSimulatedCostRatio),
    missedFillRate: readNumber(input.executionQuality?.missedFillRate),
    telemetryShapeComplete: false,
    observedSlippageAvailable,
    telemetrySufficient: false,
  }
  executionQuality.telemetryShapeComplete =
    executionQuality.recentOrderCount >= args.minPaperExecutionOrders &&
    executionQualityMetricsComplete
  executionQuality.telemetrySufficient =
    executionQuality.telemetryShapeComplete &&
    executionQuality.observedSlippageAvailable

  const executionQualityEvidence = asRecord(input.executionQuality?.evidence)
  const paperPnlCoverage = asRecord(input.paperPnlDiagnostics?.coverage)
  const paperPnlCostEvidence = asRecord(paperPnlCoverage?.costEvidence)
  const useExecutionQualityCostEvidence = executionQualityEvidence != null
  const costEvidence = useExecutionQualityCostEvidence ? executionQualityEvidence : paperPnlCostEvidence
  const costEvidenceSource = useExecutionQualityCostEvidence
    ? 'execution_quality'
    : paperPnlCostEvidence != null
      ? 'paper_pnl_diagnostics'
      : 'missing'
  const paperCostEvidence = {
    exists: costEvidence != null,
    source: costEvidenceSource,
    closedTrades: readNumber(costEvidence?.closedTrades) ?? 0,
    tradesWithAnyPredictedCost: readNumber(costEvidence?.tradesWithAnyPredictedCost) ?? 0,
    tradesWithCompletePredictedOpenEvidence: readNumber(costEvidence?.tradesWithCompletePredictedOpenEvidence) ?? 0,
    completePredictedOpenEvidenceCoveragePct: useExecutionQualityCostEvidence
      ? readNumber(executionQualityQuality?.completePredictedOpenEvidenceCoveragePct)
      : readNumber(costEvidence?.completePredictedOpenEvidenceCoveragePct),
    tradesWithAnyRealizedCost: readNumber(costEvidence?.tradesWithAnyRealizedCostEvidence ?? costEvidence?.tradesWithAnyRealizedCost) ?? 0,
    tradesWithFillAdjustedCost: readNumber(costEvidence?.tradesWithFillAdjustedCostEvidence ?? costEvidence?.tradesWithFillAdjustedCost) ?? 0,
    tradesWithExchangeReconciledCostEvidence: readNumber(costEvidence?.tradesWithExchangeReconciledCostEvidence) ?? 0,
    tradesWithPaperFillTelemetry: readNumber(costEvidence?.tradesWithPaperFillTelemetry) ?? 0,
    paperFillTelemetryCoveragePct: useExecutionQualityCostEvidence
      ? readNumber(executionQualityQuality?.paperFillTelemetryCoveragePct)
      : readNumber(costEvidence?.paperFillTelemetryCoveragePct),
    status: readString(costEvidence?.status) ?? (costEvidence == null ? null : 'partial'),
  }
  const futureTelemetryCounts = asRecord(input.paperFutureTelemetryWatchdog?.counts)
  const futureTelemetryCoverage = asRecord(input.paperFutureTelemetryWatchdog?.coverage)
  const futureTelemetryReadiness = asRecord(input.paperFutureTelemetryWatchdog?.readiness)
  const futureTelemetryGap = asRecord(input.paperFutureTelemetryWatchdog?.telemetryGap)
  const paperFutureTelemetry = {
    exists: input.paperFutureTelemetryWatchdog != null,
    status: readString(input.paperFutureTelemetryWatchdog?.status),
    monitoringStartedAt: readString(input.paperFutureTelemetryWatchdog?.monitoringStartedAt),
    futureClosedRows: readNumber(futureTelemetryCounts?.futureClosedRows) ?? 0,
    futureRowsWithPaperFillTelemetry: readNumber(futureTelemetryCounts?.futureRowsWithPaperFillTelemetry) ?? 0,
    futureRowsWithCompletePredictedOpenEvidence: readNumber(futureTelemetryCounts?.futureRowsWithCompletePredictedOpenEvidence) ?? 0,
    futureRowsWithExchangeReconciledCostEvidence: readNumber(futureTelemetryCounts?.futureRowsWithExchangeReconciledCostEvidence) ?? 0,
    futureRowsWithObservedSlippage: readNumber(futureTelemetryCounts?.futureRowsWithObservedSlippage) ?? 0,
    futurePaperFillTelemetryCoveragePct: readNumber(futureTelemetryCoverage?.futurePaperFillTelemetryCoveragePct),
    futureNewOpenPredictedOpenEvidenceCoveragePct: readNumber(futureTelemetryCoverage?.futureNewOpenPredictedOpenEvidenceCoveragePct),
    futureExchangeReconciledCostCoveragePct: readNumber(futureTelemetryCoverage?.futureExchangeReconciledCostCoveragePct),
    futureObservedSlippageCoveragePct: readNumber(futureTelemetryCoverage?.futureObservedSlippageCoveragePct),
    futurePaperFillTelemetrySufficient: readBoolean(futureTelemetryReadiness?.futurePaperFillTelemetrySufficient) === true,
    futurePredictedOpenEvidenceSufficient: readBoolean(futureTelemetryReadiness?.futurePredictedOpenEvidenceSufficient) === true,
    futureExchangeReconciledCostEvidenceAvailable:
      readBoolean(futureTelemetryReadiness?.exchangeReconciledCostEvidenceAvailable) === true,
    futureObservedSlippageAvailable: readBoolean(futureTelemetryReadiness?.observedSlippageAvailable) === true,
    telemetryGapStatus: readString(futureTelemetryGap?.status),
    telemetryGapMonitoringAgeMinutes: readNumber(futureTelemetryGap?.monitoringAgeMinutes),
    telemetryGapLatestClosedAt: readString(futureTelemetryGap?.latestClosedAt),
    telemetryGapLatestClosedBeforeMonitoringStart: readBoolean(futureTelemetryGap?.latestClosedBeforeMonitoringStart),
    telemetryGapFutureClosedRowsAfterMonitoringStart: readNumber(futureTelemetryGap?.futureClosedRowsAfterMonitoringStart),
    telemetryGapFutureRowsMissingPaperFillTelemetry: readNumber(futureTelemetryGap?.futureRowsMissingPaperFillTelemetry),
    telemetryGapFutureNewOpenRowsMissingPredictedOpenEvidence: readNumber(futureTelemetryGap?.futureNewOpenRowsMissingPredictedOpenEvidence),
    blockers: readStringArray(input.paperFutureTelemetryWatchdog?.blockers),
    evidenceBlockers: readStringArray(input.paperFutureTelemetryWatchdog?.evidenceBlockers),
  }
  const futureWatchdogAllowsExecution = artifactAllowsExecution(input.paperFutureTelemetryWatchdog)

  const publicOrderbookUsableForResearch =
    orderbook.exists &&
    (orderbook.status === 'complete' || orderbook.cacheFallbackUsed) &&
    !orderbook.stale &&
    orderbook.rowsBuilt >= requiredOrderbookMinRows &&
    orderbook.requiredOrderbookAllPass &&
    aggregateOrderbookBlockersRelevantToScope.length === 0 &&
    !orderbookAllowsExecution
  const runtimeFeeSnapshotUsableForResearch =
    feeSnapshot.exists &&
    feeSnapshot.source === 'api' &&
    feeSnapshot.verifiedByRuntime === true &&
    !feeSnapshot.stale &&
    Math.max(feeSnapshot.makerFeeBps ?? 0, feeSnapshot.takerFeeBps ?? 0) > 0
  const routeCostBudgetRuntimeVerified =
    routeCostBudget.exists &&
    routeCostBudget.feeSnapshotSource === 'api' &&
    routeCostBudget.feeSnapshotVerifiedByRuntime === true &&
    routeCostBudget.feeSnapshotMatchesRuntimeFeeSnapshot === true
  const routeCostBudgetFresh = routeCostBudget.exists && !routeCostBudget.stale
  const paperExecutionTelemetryAvailable =
    executionQuality.telemetrySufficient &&
    paperCostEvidence.completePredictedOpenEvidenceCoveragePct != null &&
    paperCostEvidence.completePredictedOpenEvidenceCoveragePct >= args.minCompletePredictedCostCoveragePct &&
    paperCostEvidence.tradesWithExchangeReconciledCostEvidence > 0

  const readiness = {
    publicOrderbookUsableForResearch,
    runtimeFeeSnapshotUsableForResearch,
    routeCostBudgetRuntimeVerified,
    routeCostBudgetFresh,
    paperExecutionTelemetryAvailable,
    promotionGradeRouteCostEvidence: false as const,
  }
  const blockers = uniqueStrings([
    ...(orderbook.exists ? [] : ['okx_orderbook_spread_snapshot_missing']),
    ...(orderbook.status === 'complete' || orderbook.cacheFallbackUsed ? [] : [`okx_orderbook_spread_status:${orderbook.status ?? 'missing'}`]),
    ...(orderbook.stale ? ['okx_orderbook_spread_snapshot_stale'] : []),
    ...(orderbook.rowsBuilt >= requiredOrderbookMinRows || orderbook.cacheFallbackUsed ? [] : [`okx_orderbook_rows_low:${orderbook.rowsBuilt}<${requiredOrderbookMinRows}`]),
    ...(orderbook.requiredOrderbookMissingSymbols.length === 0
      ? []
      : [`okx_orderbook_required_symbols_missing:${orderbook.requiredOrderbookMissingSymbols.join(',')}`]),
    ...(orderbook.requiredOrderbookBlockedSymbols.length === 0
      ? []
      : [`okx_orderbook_required_symbols_blocked:${orderbook.requiredOrderbookBlockedSymbols.join(',')}`]),
    ...(orderbookQualityBySymbol.length > 0 || orderbook.blockedRows === 0 ? [] : [`okx_orderbook_blocked_rows:${orderbook.blockedRows}`]),
    ...(orderbookAllowsExecution ? ['okx_orderbook_artifact_must_not_authorize_execution'] : []),
    ...scopedOrderbookBlockerDetails,
    ...aggregateOrderbookBlockersRelevantToScope.map(blocker => `okx_orderbook:${blocker}`),
    ...(runtimeFeeSnapshotUsableForResearch ? [] : ['runtime_fee_snapshot_not_research_usable']),
    ...(feeSnapshot.exists ? [] : ['fee_snapshot_missing']),
    ...(feeSnapshot.source === 'api' ? [] : [`fee_snapshot_source_not_api:${feeSnapshot.source ?? 'missing'}`]),
    ...(feeSnapshot.verifiedByRuntime === true ? [] : ['fee_snapshot_not_runtime_verified']),
    ...(feeSnapshot.stale ? ['fee_snapshot_stale'] : []),
    ...feeSnapshotRefresh.blockers.map(blocker => `fee_snapshot_refresh:${blocker}`),
    ...(routeCostBudget.exists ? [] : ['route_cost_budget_missing']),
    ...(routeCostBudgetFresh ? [] : ['route_cost_budget_stale']),
    ...(routeCostBudget.feeSnapshotSource === 'api' ? [] : [`route_cost_budget_fee_snapshot_source_not_api:${routeCostBudget.feeSnapshotSource ?? 'missing'}`]),
    ...(routeCostBudget.feeSnapshotVerifiedByRuntime === true ? [] : ['route_cost_budget_fee_snapshot_not_runtime_verified']),
    ...(routeCostBudget.feeSnapshotMatchesRuntimeFeeSnapshot === true ? [] : ['route_cost_budget_fee_snapshot_mismatch']),
    ...(routeCostBudget.routeCount > 0 ? [] : ['route_cost_budget_routes_missing']),
    ...(routeCostBudgetHasSafeRoute ? [] : ['route_cost_budget_no_route_within_budget']),
    ...(executionQuality.recentOrderCount >= args.minPaperExecutionOrders ? [] : [`paper_execution_quality_orders_low:${executionQuality.recentOrderCount}<${args.minPaperExecutionOrders}`]),
    ...(executionQualityMetricsComplete ? [] : ['paper_execution_quality_metrics_incomplete']),
    ...(executionQuality.observedSlippageAvailable ? [] : ['paper_execution_observed_slippage_unavailable']),
    ...(paperExecutionTelemetryAvailable ? [] : ['paper_execution_slippage_telemetry_unavailable']),
    ...(paperCostEvidence.completePredictedOpenEvidenceCoveragePct != null &&
      paperCostEvidence.completePredictedOpenEvidenceCoveragePct >= args.minCompletePredictedCostCoveragePct
      ? []
      : [`paper_predicted_cost_coverage_low:${paperCostEvidence.completePredictedOpenEvidenceCoveragePct ?? 'missing'}<${args.minCompletePredictedCostCoveragePct}`]),
    ...(paperCostEvidence.tradesWithExchangeReconciledCostEvidence > 0 ? [] : ['paper_exchange_reconciled_cost_evidence_missing']),
    ...(paperFutureTelemetry.exists ? [] : ['paper_future_telemetry_watchdog_missing']),
    ...(futureWatchdogAllowsExecution ? ['paper_future_telemetry_watchdog_must_not_authorize_execution'] : []),
    ...paperFutureTelemetry.blockers
      .slice(0, 8)
      .map(blocker => `paper_future_telemetry:${blocker}`),
    ...paperFutureTelemetry.evidenceBlockers
      .filter(blocker => blocker !== 'paper_execution_future_watchdog_diagnostic_only')
      .slice(0, 8)
      .map(blocker => `paper_future_telemetry:${blocker}`),
    'route_cost_slippage_readiness_diagnostic_only',
  ])

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: blockers.length > 0 ? 'blocked' : 'watch_only',
    sourceArtifacts,
    thresholds: {
      maxOrderbookAgeMs: args.maxOrderbookAgeMs,
      maxFeeSnapshotAgeMs: args.maxFeeSnapshotAgeMs,
      maxRouteBudgetAgeMs: args.maxRouteBudgetAgeMs,
      minOrderbookRows: args.minOrderbookRows,
      requiredOrderbookSymbols: args.requiredOrderbookSymbols,
      minPaperExecutionOrders: args.minPaperExecutionOrders,
      minCompletePredictedCostCoveragePct: args.minCompletePredictedCostCoveragePct,
    },
    orderbook,
    feeSnapshot,
    feeSnapshotRefresh,
    routeCostBudget,
    executionQuality,
    paperCostEvidence,
    paperFutureTelemetry,
    readiness,
    blockers,
    nextActions: [
      ...(routeCostBudgetRuntimeVerified
        ? []
        : ['Run research:okx:runtime-route-cost-budget so route_cost_budget embeds the latest runtime-verified fee snapshot without publishing a promotion bundle.']),
      ...(publicOrderbookUsableForResearch
        ? ['Use OKX public spread/depth snapshots as research-only route-cost stress inputs.']
        : ['Refresh OKX order-book snapshots until spread/depth rows are fresh and quality-passing.']),
      'Add per-decision/per-paper-trade spread, slippage, fill-adjusted cost, and exchange-reconciled cost telemetry before any promotion claim.',
      'Let future-only paper execution telemetry watchdog accumulate post-start close rows; do not backfill historical paper rows as promotion evidence.',
      'Keep paper/live disabled until WFO/FDR/PIT/prospective evidence and paper execution gates independently pass.',
    ],
    safetyNotes: [
      'This artifact is a route-cost/slippage readiness monitor only; it cannot authorize paper orders, live orders, promotion, leverage changes, or best_config mutations.',
      'OKX public order-book snapshots are research-only market inputs, not execution telemetry and not profitability proof.',
      'Runtime-verified fees improve cost inputs, but promotion still requires non-stale route budgets, PIT-safe labels, prospective outcomes, and paper execution evidence.',
    ],
    outputHash: null,
  }
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as unknown
  } catch {
    return null
  }
}

function readOrderbookRowsIfExists(path: string): UnknownRecord[] {
  const resolved = resolve(path)
  if (!existsSync(resolved)) return []
  const rows: UnknownRecord[] = []
  for (const line of readFileSync(resolved, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = asRecord(JSON.parse(trimmed))
      if (parsed) rows.push(parsed)
    } catch {
      // Ignore partially written JSONL rows.
    }
  }
  return rows
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg?.startsWith('--')) continue
    const key = arg.slice(2)
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
  return normalized === '' || normalized === 'null' || normalized === 'none' ? null : value
}

function parseSymbols(value: string | undefined, fallback: string[]): string[] {
  if (value == null || value.trim() === '') return fallback
  const symbols = value
    .split(',')
    .map(normalizeSymbol)
    .filter(Boolean)
  return symbols.length > 0 ? uniqueStrings(symbols) : fallback
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function parsePositiveNumber(value: string | undefined, fallback: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`)
  return parsed
}

function asRecord(value: unknown): UnknownRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readNumber(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function normalizeSymbol(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function readOrderbookQualityBySymbol(value: unknown): OrderbookQualityBySymbol[] {
  if (!Array.isArray(value)) return []
  return value
    .map(item => {
      const row = asRecord(item)
      const symbol = readString(row?.symbol)
      if (!symbol) return null
      return {
        symbol: normalizeSymbol(symbol),
        status: readString(row?.status),
        blockers: readStringArray(row?.blockers),
        spreadBps: readNumber(row?.spreadBps),
        depth5Usd: readNumber(row?.depth5Usd),
        bidNotionalDepth5: readNumber(row?.bidNotionalDepth5),
        askNotionalDepth5: readNumber(row?.askNotionalDepth5),
        availableAt: readString(row?.availableAt),
        eventTime: readString(row?.eventTime),
      }
    })
    .filter((row): row is OrderbookQualityBySymbol => row != null)
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
}

function buildRecentOrderbookQualityCache(
  rows: UnknownRecord[],
  requiredSymbols: string[],
  asOfMs: number,
  maxAgeMs: number,
): OrderbookQualityBySymbol[] {
  const bySymbol = new Map<string, OrderbookQualityBySymbol>()
  for (const row of rows) {
    const symbol = normalizeSymbol(readString(row.symbol) ?? '')
    if (!requiredSymbols.includes(symbol)) continue
    const quality = asRecord(row.quality)
    const fields = asRecord(row.fields)
    const availableAt = readString(row.availableAt ?? row.ingestedAt ?? row.generatedAt)
    const eventTime = readString(row.eventTime ?? row.sourceTimestamp)
    const status = readString(quality?.status)
    const blockers = readStringArray(quality?.blockers)
    if (status !== 'pass' || blockers.length > 0 || isOlderThan(availableAt, asOfMs, maxAgeMs)) continue
    const candidate: OrderbookQualityBySymbol = {
      symbol,
      status,
      blockers,
      spreadBps: readNumber(fields?.spreadBps),
      depth5Usd: minFinite(readNumber(fields?.bidNotionalDepth5), readNumber(fields?.askNotionalDepth5)),
      bidNotionalDepth5: readNumber(fields?.bidNotionalDepth5),
      askNotionalDepth5: readNumber(fields?.askNotionalDepth5),
      availableAt,
      eventTime,
    }
    const existing = bySymbol.get(symbol)
    if (!existing || (Date.parse(candidate.availableAt ?? '') || 0) > (Date.parse(existing.availableAt ?? '') || 0)) {
      bySymbol.set(symbol, candidate)
    }
  }
  return [...bySymbol.values()].sort((left, right) => left.symbol.localeCompare(right.symbol))
}

function minFinite(left: number | null, right: number | null): number | null {
  const values = [left, right].filter((value): value is number => value != null && Number.isFinite(value))
  return values.length > 0 ? Math.min(...values) : null
}

function ageMs(value: string | null, asOfMs: number): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.max(0, asOfMs - parsed) : null
}

function isOlderThan(value: string | null, asOfMs: number, maxAgeMs: number): boolean {
  const age = ageMs(value, asOfMs)
  return age == null || age > maxAgeMs
}

function isExpired(value: string | null, asOfMs: number): boolean {
  if (!value) return true
  const parsed = Date.parse(value)
  return !Number.isFinite(parsed) || parsed <= asOfMs
}

function artifactAllowsExecution(root: UnknownRecord | null): boolean {
  return readBoolean(root?.promotionEligible) === true ||
    readBoolean(root?.paperTradingAllowed) === true ||
    readBoolean(root?.liveTradingAllowed) === true ||
    readBoolean(root?.executionAllowed) === true ||
    readBoolean(root?.promotionAllowedByThisArtifact) === true ||
    readBoolean(root?.paperTradingAllowedByThisArtifact) === true ||
    readBoolean(root?.liveTradingAllowedByThisArtifact) === true
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim() !== ''))]
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function renderConsoleSummary(report: OkxRouteCostSlippageReadinessReport): string {
  return [
    `OKX route-cost/slippage readiness: ${report.status}`,
    `orderbook=${report.orderbook.status ?? 'missing'} rows=${report.orderbook.rowsBuilt} stale=${report.orderbook.stale}`,
    `fee=${report.feeSnapshot.source ?? 'missing'} verified=${report.feeSnapshot.verifiedByRuntime ?? false} stale=${report.feeSnapshot.stale}`,
    `routeBudgetFee=${report.routeCostBudget.feeSnapshotSource ?? 'missing'} verified=${report.routeCostBudget.feeSnapshotVerifiedByRuntime ?? false} matchesRuntime=${report.routeCostBudget.feeSnapshotMatchesRuntimeFeeSnapshot ?? false}`,
    `futureTelemetry=${report.paperFutureTelemetry.status ?? 'missing'} futureClosed=${report.paperFutureTelemetry.futureClosedRows}`,
    `paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `topBlockers=${report.blockers.slice(0, 10).join(',')}` : 'topBlockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
