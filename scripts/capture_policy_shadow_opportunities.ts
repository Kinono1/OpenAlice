/**
 * Shadow-only no-trade opportunity capture.
 *
 * This is a diagnostic producer for P1 gate effectiveness. It appends bounded
 * trade-level shadow opens and never mutates paper accounts or submits orders.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_VB_CONFIG, evaluateVolumeBreakout, type VolumeBreakoutSignal } from '../src/domain/strategy/volume-breakout.js'
import {
  DEFAULT_PAPER_POLICY_SHADOW_LEDGER_PATH,
  appendPaperPolicyShadowOpen,
  buildPaperPolicyShadowId,
} from '../src/runtime/paper_policy_shadow_ledger.js'
import {
  isMarketIntelSymbolBanned,
  readMarketIntelContext,
  type MarketIntelContext,
} from '../src/runtime/market_intel_context.js'
import { readSystemFuse, type SystemFuseState } from '../src/runtime/system_fuse.js'
import { buildPaperOpenContextSnapshot } from '../src/runtime/paper_open_context.js'
import {
  defaultPaperUniverseSymbols,
  paperSymbolToCsvFile,
} from './lib/paper_universe.js'
import type { RouteCostBudget, RouteName } from '../src/runtime/promotion_v2.js'

const DEFAULT_DATA_DIR = 'data/market/live_5m'
const DEFAULT_OUTPUT_PATH = 'data/runtime/paper_policy_shadow_capture.latest.json'
const DEFAULT_ROUTE_COST_BUDGET_PATH = 'data/runtime/route_cost_budget.latest.json'
const SHADOW_POLICY_VERSION = 'volume_breakout_shadow_capture_v1'
const PAPER_FEE_RATE = 0.0006
const PAPER_SLIPPAGE_BPS = 8
const PAPER_STALE_MARK_MATCH_PENALTY_BPS = 15

interface Candle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface ShadowCaptureArgs {
  dataDir: string
  ledgerPath: string
  outputPath: string | null
  routeCostBudgetPath: string
  symbols: string[]
  maxShadowsPerLane: number
  maxPerReason: number
  maxPerSymbolPerHorizon: number
  nearThresholdBandPct: number
  dryRun: boolean
  json: boolean
}

type Lane = 'volume_breakout_1x' | 'volume_breakout_3x'
type ShadowReasonClass =
  | 'execution_gate_blocked'
  | 'symbol_blocked'
  | 'lane_blocked'
  | 'risk_off'
  | 'context_stale'
  | 'near_threshold'

interface ShadowCandidate {
  lane: Lane
  symbol: string
  side: 'long' | 'short'
  signal: VolumeBreakoutSignal
  reasonClass: ShadowReasonClass
  blockReasons: string[]
  priority: number
}

interface ShadowCaptureReport {
  schemaVersion: 1
  generatedAt: string
  dryRun: boolean
  mode: 'shadow_only_no_account_mutation'
  strategyFamily: 'volume_breakout'
  shadowPolicyVersion: string
  inputs: {
    dataDir: string
    ledgerPath: string
    outputPath: string | null
    routeCostBudgetPath: string
    symbols: string[]
    maxShadowsPerLane: number
    maxPerReason: number
    maxPerSymbolPerHorizon: number
    nearThresholdBandPct: number
  }
  counts: {
    symbolsRequested: number
    assetsLoaded: number
    candidatesSeen: number
    recorded: number
    duplicateSkipped: number
    capDropped: number
    invalidPriceDropped: number
    flatUniverseDropped: number
    missingContextDropped: number
    dryRunWouldRecord: number
  }
  byReasonClass: Array<{ reasonClass: ShadowReasonClass; count: number }>
  appendResults: Array<{
    shadowId: string
    lane: Lane
    symbol: string
    reasonClass: ShadowReasonClass
    appended: boolean
    reason?: string
  }>
  notes: string[]
}

export function parseShadowCaptureArgs(argv: string[]): ShadowCaptureArgs {
  const raw = parseRawArgs(argv)
  return {
    dataDir: raw.get('dataDir') ?? DEFAULT_DATA_DIR,
    ledgerPath: raw.get('ledgerPath') ?? DEFAULT_PAPER_POLICY_SHADOW_LEDGER_PATH,
    outputPath: parseNullableString(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    routeCostBudgetPath: raw.get('routeCostBudgetPath') ?? DEFAULT_ROUTE_COST_BUDGET_PATH,
    symbols: parseSymbols(raw.get('symbols')),
    maxShadowsPerLane: parsePositiveInteger(raw.get('maxShadowsPerLane'), 5),
    maxPerReason: parsePositiveInteger(raw.get('maxPerReason'), 3),
    maxPerSymbolPerHorizon: parsePositiveInteger(raw.get('maxPerSymbolPerHorizon'), 1),
    nearThresholdBandPct: parsePositiveNumber(raw.get('nearThresholdBandPct'), 0.25),
    dryRun: parseBool(raw.get('dryRun'), false),
    json: parseBool(raw.get('json'), false),
  }
}

export async function capturePolicyShadowOpportunities(
  args: ShadowCaptureArgs,
  deps: {
    marketIntelContext?: MarketIntelContext
    systemFuse?: SystemFuseState
    now?: Date
  } = {},
): Promise<ShadowCaptureReport> {
  const now = deps.now ?? new Date()
  const dataDir = resolve(args.dataDir)
  const ledgerPath = resolve(args.ledgerPath)
  const routeCostBudgetPath = resolve(args.routeCostBudgetPath)
  const routeCostBudget = readRouteCostBudget(routeCostBudgetPath)
  const context = deps.marketIntelContext ?? readMarketIntelContext()
  const fuse = deps.systemFuse ?? readSystemFuse()
  const loadedAssets: Array<{ symbol: string; candles: Candle[] }> = []
  let flatUniverseDropped = 0
  let invalidPriceDropped = 0

  for (const symbol of args.symbols) {
    const path = join(dataDir, paperSymbolToCsvFile(symbol, '5m'))
    if (!existsSync(path)) {
      flatUniverseDropped += 1
      continue
    }
    const candles = await loadCandles(path)
    if (candles.length < DEFAULT_VB_CONFIG.volumeLookbackBars + 2) {
      flatUniverseDropped += 1
      continue
    }
    loadedAssets.push({ symbol, candles })
  }

  const signals = loadedAssets.map(asset => evaluateVolumeBreakout(asset.symbol, asset.candles))
  const candidates = buildShadowCandidates(signals, context, fuse, args.nearThresholdBandPct, now)
  const selected: ShadowCandidate[] = []
  const laneCounts = new Map<Lane, number>()
  const reasonCounts = new Map<string, number>()
  const symbolHorizonCounts = new Map<string, number>()
  let capDropped = 0
  let missingContextDropped = 0

  for (const candidate of candidates.sort((a, b) => b.priority - a.priority || a.symbol.localeCompare(b.symbol))) {
    const contextSnapshot = buildPaperOpenContextSnapshot(context, candidate.lane, now)
    if (!contextSnapshot.contextSnapshotId || !contextSnapshot.decisionTime || !contextSnapshot.marketDataWatermarkAtDecisionTime) {
      missingContextDropped += 1
      continue
    }
    if (!Number.isFinite(candidate.signal.entryPrice) || candidate.signal.entryPrice <= 0 || candidate.signal.barTime <= 0) {
      invalidPriceDropped += 1
      continue
    }
    const laneCount = laneCounts.get(candidate.lane) ?? 0
    const reasonKey = `${candidate.lane}|${candidate.reasonClass}`
    const reasonCount = reasonCounts.get(reasonKey) ?? 0
    const horizonKey = `${candidate.lane}|${candidate.symbol}|${candidate.signal.barTime}`
    const symbolHorizonCount = symbolHorizonCounts.get(horizonKey) ?? 0
    if (
      laneCount >= args.maxShadowsPerLane ||
      reasonCount >= args.maxPerReason ||
      symbolHorizonCount >= args.maxPerSymbolPerHorizon
    ) {
      capDropped += 1
      continue
    }
    selected.push(candidate)
    laneCounts.set(candidate.lane, laneCount + 1)
    reasonCounts.set(reasonKey, reasonCount + 1)
    symbolHorizonCounts.set(horizonKey, symbolHorizonCount + 1)
  }

  const appendResults: ShadowCaptureReport['appendResults'] = []
  for (const candidate of selected) {
    const openContext = buildPaperOpenContextSnapshot(context, candidate.lane, now)
    const shadowTradeId = [
      'shadow_capture',
      candidate.lane,
      candidate.symbol,
      candidate.signal.barTime,
      candidate.side,
      candidate.reasonClass,
    ].join(':')
    const shadowId = buildPaperPolicyShadowId({
      tradeId: shadowTradeId,
      shadowPolicyVersion: SHADOW_POLICY_VERSION,
      entryTs: candidate.signal.barTime,
      policyId: candidate.lane,
    })
    const result = args.dryRun
      ? { appended: true, shadowId }
      : appendPaperPolicyShadowOpen({
        counterfactualType: 'trade_level_shadow',
        eventType: 'open',
        shadowId,
        lane: candidate.lane,
        symbol: candidate.symbol,
        side: candidate.side,
        entryPrice: candidate.signal.entryPrice,
        openTs: new Date(candidate.signal.barTime).toISOString(),
        openBarTime: candidate.signal.barTime,
        horizonMs: DEFAULT_VB_CONFIG.holdBars * 5 * 60 * 1000,
        notionalUsd: null,
        stopLossPrice: candidate.signal.stopLossPrice > 0 ? candidate.signal.stopLossPrice : null,
        blockReasons: [
          `reason_class:${candidate.reasonClass}`,
          ...candidate.blockReasons,
        ],
        context: {
          contextSnapshotId: openContext.contextSnapshotId,
          decisionTime: openContext.decisionTime,
          marketDataWatermarkAtDecisionTime: openContext.marketDataWatermarkAtDecisionTime,
          watermark: openContext.watermark,
          featuresAvailableAtDecisionTime: openContext.featuresAvailableAtDecisionTime,
          featureSchemaVersion: openContext.featureSchemaVersion,
          contextGenerationAtOpen: openContext.contextGenerationAtOpen,
          contextStatus: openContext.contextStatus,
          flashContextStatus: openContext.flashContextStatus,
          contextReason: openContext.contextReason,
          flashEpochAtOpen: openContext.flashEpochAtOpen,
          flashConfidenceLowAtOpen: openContext.flashConfidenceLowAtOpen,
          proEpochAtOpen: openContext.proEpochAtOpen,
          marketIntelTriggerAtOpen: openContext.marketIntelTriggerAtOpen,
        },
        quality: buildQualitySnapshot(candidate.signal),
        cost: buildCostSnapshot(candidate.signal, laneLeverage(candidate.lane), routeCostBudget, routeCostBudgetPath),
      }, ledgerPath)
    appendResults.push({
      shadowId,
      lane: candidate.lane,
      symbol: candidate.symbol,
      reasonClass: candidate.reasonClass,
      appended: result.appended,
      reason: result.reason,
    })
  }

  const report: ShadowCaptureReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    mode: 'shadow_only_no_account_mutation',
    strategyFamily: 'volume_breakout',
    shadowPolicyVersion: SHADOW_POLICY_VERSION,
    inputs: {
      dataDir,
      ledgerPath,
      outputPath: args.outputPath ? resolve(args.outputPath) : null,
      routeCostBudgetPath,
      symbols: args.symbols,
      maxShadowsPerLane: args.maxShadowsPerLane,
      maxPerReason: args.maxPerReason,
      maxPerSymbolPerHorizon: args.maxPerSymbolPerHorizon,
      nearThresholdBandPct: args.nearThresholdBandPct,
    },
    counts: {
      symbolsRequested: args.symbols.length,
      assetsLoaded: loadedAssets.length,
      candidatesSeen: candidates.length,
      recorded: appendResults.filter(result => result.appended && !args.dryRun).length,
      duplicateSkipped: appendResults.filter(result => result.reason === 'duplicate_shadow_id').length,
      capDropped,
      invalidPriceDropped,
      flatUniverseDropped,
      missingContextDropped,
      dryRunWouldRecord: args.dryRun ? appendResults.length : 0,
    },
    byReasonClass: countByReasonClass(selected),
    appendResults,
    notes: [
      'This producer is shadow-only and must not mutate paper accounts or submit orders.',
      'Outcomes are closed later by paper_policy_shadow_settle; this report does not compute portfolio-level counterfactual PnL.',
      'Candidates are bounded per lane/reason/symbol horizon to prevent flat-universe sample spam.',
    ],
  }

  if (report.inputs.outputPath) {
    await mkdir(dirname(report.inputs.outputPath), { recursive: true })
    await writeFile(report.inputs.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  }
  return report
}

function buildShadowCandidates(
  signals: VolumeBreakoutSignal[],
  context: MarketIntelContext,
  fuse: SystemFuseState,
  nearThresholdBandPct: number,
  now: Date,
): ShadowCandidate[] {
  const out: ShadowCandidate[] = []
  for (const lane of ['volume_breakout_1x', 'volume_breakout_3x'] as const) {
    const minConfidence = Math.max(0.2, context.suggestedRuleThresholdByLane[lane] ?? 0)
    const laneAllowed = context.allowNewPositionsByLane[lane] === true
    const contextFresh = Number.isFinite(Date.parse(context.validUntil)) && Date.parse(context.validUntil) > now.getTime()
    for (const signal of signals) {
      if (signal.signal === 0 || signal.entryPrice <= 0) continue
      const side = signal.signal === 1 ? 'long' : 'short'
      const base = { lane, symbol: signal.symbol, side, signal }
      if (isMarketIntelSymbolBanned(context, signal.symbol)) {
        out.push({ ...base, reasonClass: 'symbol_blocked', blockReasons: ['market_intel_symbol_blocked'], priority: 90 + signal.confidence })
        continue
      }
      if (fuse.status === 'risk_off' || context.riskMode === 'risk_off') {
        out.push({ ...base, reasonClass: 'risk_off', blockReasons: [`risk_off:${fuse.reason ?? context.riskMode}`], priority: 80 + signal.confidence })
        continue
      }
      if (!contextFresh) {
        out.push({ ...base, reasonClass: 'context_stale', blockReasons: ['context_stale'], priority: 70 + signal.confidence })
        continue
      }
      if (!laneAllowed || context.newsRiskRegime === 'severe' || !context.semanticValidation.passed) {
        out.push({
          ...base,
          reasonClass: 'lane_blocked',
          blockReasons: [
            !laneAllowed ? `lane_not_allowed:${lane}` : null,
            context.newsRiskRegime === 'severe' ? 'severe_news' : null,
            !context.semanticValidation.passed ? 'semantic_validation_block' : null,
          ].filter((value): value is string => value != null),
          priority: 60 + signal.confidence,
        })
        continue
      }
      const executionReasons = executionGateReasons(signal)
      if (executionReasons.length > 0) {
        out.push({ ...base, reasonClass: 'execution_gate_blocked', blockReasons: executionReasons, priority: 50 + signal.confidence })
        continue
      }
      const lowerBound = minConfidence * (1 - nearThresholdBandPct)
      if (signal.confidence >= lowerBound && signal.confidence < minConfidence) {
        out.push({
          ...base,
          reasonClass: 'near_threshold',
          blockReasons: [`near_threshold_confidence ${signal.confidence.toFixed(3)} < ${minConfidence.toFixed(3)}`],
          priority: 40 + signal.confidence,
        })
      }
    }
  }
  return out
}

function executionGateReasons(signal: VolumeBreakoutSignal): string[] {
  const reasons: string[] = []
  if (signal.confidence < 0.2) reasons.push(`confidence ${signal.confidence.toFixed(3)} < 0.2`)
  if (signal.rangeBreakoutPct < 1) reasons.push(`break ${signal.rangeBreakoutPct.toFixed(3)}% < 1%`)
  if (signal.volumeRatio > 1_000) reasons.push(`volume ratio ${signal.volumeRatio.toFixed(1)}x > 1000x`)
  if ((signal.breakQuality ?? 1) < DEFAULT_VB_CONFIG.minBreakQuality) reasons.push(`break quality ${(signal.breakQuality ?? 0).toFixed(2)} < ${DEFAULT_VB_CONFIG.minBreakQuality}`)
  if (signal.liquidityStatus === 'fail') reasons.push(`liquidity ${(signal.liquidityUsd ?? 0).toFixed(0)} USD < ${DEFAULT_VB_CONFIG.minVolumeUsd}`)
  if (signal.spreadStatus === 'fail') reasons.push(`spread ${(signal.spreadBps ?? 0).toFixed(1)} bps > ${DEFAULT_VB_CONFIG.maxSpreadBps}`)
  return reasons
}

function buildQualitySnapshot(signal: VolumeBreakoutSignal): Record<string, unknown> {
  return {
    confidence: signal.confidence,
    confidenceAtOpen: signal.confidence,
    ruleScoreAtOpen: signal.confidence,
    volumeRatioAtOpen: finiteOrNull(signal.volumeRatio),
    rangeBreakoutPctAtOpen: finiteOrNull(signal.rangeBreakoutPct),
    breakQualityAtOpen: finiteOrNull(signal.breakQuality),
    liquidityUsdAtOpen: finiteOrNull(signal.liquidityUsd),
    liquidityStatusAtOpen: signal.liquidityStatus,
    spreadBpsAtOpen: finiteOrNull(signal.spreadBps),
    spreadStatusAtOpen: signal.spreadStatus,
  }
}

function buildCostSnapshot(
  signal: VolumeBreakoutSignal,
  leverage: number,
  routeCostBudget: RouteCostBudget | null,
  routeCostBudgetPath: string,
): Record<string, unknown> {
  const estimatedRoundTripCostPctAtOpen = roundFinite(((PAPER_FEE_RATE * 2) + (PAPER_SLIPPAGE_BPS / 10_000) * 2 + (PAPER_STALE_MARK_MATCH_PENALTY_BPS / 10_000)) * 100)
  const roundTripCostBpsAtOpen = roundFinite(estimatedRoundTripCostPctAtOpen * 100)
  const edgeSnapshot = buildExpectedEdgeSnapshot(signal, estimatedRoundTripCostPctAtOpen)
  const selectedRoute: RouteName = 'taker_taker'
  const selectedBudget = routeCostBudget?.routes[selectedRoute] ?? null
  const routeBudgetReasons = routeCostBudgetReasons(selectedRoute, selectedBudget, routeCostBudget)
  return {
    estimatedRoundTripCostPctAtOpen,
    estimatedRoundTripCostPctOfMarginAtOpen: roundFinite(estimatedRoundTripCostPctAtOpen * Math.max(leverage, 1)),
    ...edgeSnapshot,
    routeCostBpsAtOpen: roundTripCostBpsAtOpen,
    roundTripCostBpsAtOpen,
    selectedRoute,
    routeBudgetArtifactPathAtOpen: routeCostBudgetPath,
    routeBudgetTotalExpectedCostBpsAtOpen: selectedBudget?.totalExpectedCostBps ?? null,
    routeBudgetMaxAllowedCostBpsAtOpen: selectedBudget?.maxAllowedCostBps ?? null,
    routeBudgetBreakEvenEdgeBpsAtOpen: selectedBudget?.breakEvenEdgeBps ?? null,
    routeBudgetStatusAtOpen: routeCostBudget == null
      ? 'missing'
      : routeBudgetReasons.length > 0
        ? 'exceeded'
        : 'within_budget',
    routeCostShadowEligibilityAtOpen: routeBudgetReasons.length > 0
      ? 'not_route_cost_eligible'
      : 'diagnostic_only',
    routeCostShadowEligibilityReasonsAtOpen: [
      'route_cost_shadow_eligibility_diagnostic_only',
      ...routeBudgetReasons,
    ],
    markPriceAtOpen: null,
    markPriceTimestampAtOpen: null,
    matchPriceAtOpen: signal.entryPrice,
    matchPriceSourceAtOpen: 'simulated_fill',
    markMatchPenaltyBpsAtOpen: PAPER_STALE_MARK_MATCH_PENALTY_BPS,
    markMatchStatusAtOpen: 'stale_or_missing',
  }
}

function buildExpectedEdgeSnapshot(
  signal: VolumeBreakoutSignal,
  estimatedRoundTripCostPctAtOpen: number | null,
): Record<string, unknown> {
  const rangeBreakoutPct = finiteOrNull(signal.rangeBreakoutPct)
  const breakQuality = finiteOrNull(signal.breakQuality)
  const expectedGrossEdgePctAtOpen = rangeBreakoutPct == null ||
    breakQuality == null ||
    rangeBreakoutPct <= 0 ||
    breakQuality <= 0
    ? null
    : roundFinite(rangeBreakoutPct * breakQuality)
  return {
    expectedGrossEdgePctAtOpen,
    expectedNetEdgePctAtOpen: expectedGrossEdgePctAtOpen == null || estimatedRoundTripCostPctAtOpen == null
      ? null
      : roundFinite(expectedGrossEdgePctAtOpen - estimatedRoundTripCostPctAtOpen),
    expectedEdgeSourceAtOpen: expectedGrossEdgePctAtOpen == null
      ? null
      : 'volume_breakout_shadow_range_break_pct_x_quality_minus_paper_route_cost',
  }
}

function readRouteCostBudget(path: string): RouteCostBudget | null {
  if (!existsSync(path)) return null
  try {
    const root = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (!root || typeof root !== 'object' || Array.isArray(root)) return null
    const routes = (root as { routes?: unknown }).routes
    if (!routes || typeof routes !== 'object' || Array.isArray(routes)) return null
    const parsedRoutes: Partial<Record<RouteName, RouteCostBudget['routes'][RouteName]>> = {}
    for (const route of ['passive_passive', 'passive_taker', 'taker_taker', 'twap'] as RouteName[]) {
      const raw = (routes as Record<string, unknown>)[route]
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const record = raw as Record<string, unknown>
      const totalExpectedCostBps = numberOrNull(record.totalExpectedCostBps)
      const maxAllowedCostBps = numberOrNull(record.maxAllowedCostBps)
      const breakEvenEdgeBps = numberOrNull(record.breakEvenEdgeBps)
      if (totalExpectedCostBps == null || maxAllowedCostBps == null || breakEvenEdgeBps == null) return null
      parsedRoutes[route] = {
        route,
        feeBps: numberOrNull(record.feeBps) ?? 0,
        spreadBps: numberOrNull(record.spreadBps) ?? 0,
        slippageBps: numberOrNull(record.slippageBps) ?? 0,
        adverseSelectionBufferBps: numberOrNull(record.adverseSelectionBufferBps) ?? 0,
        queueMissBufferBps: numberOrNull(record.queueMissBufferBps) ?? 0,
        fundingBps: numberOrNull(record.fundingBps) ?? 0,
        totalExpectedCostBps,
        maxAllowedCostBps,
        breakEvenEdgeBps,
      }
    }
    return {
      schemaMeta: (root as RouteCostBudget).schemaMeta,
      generatedAt: typeof (root as { generatedAt?: unknown }).generatedAt === 'string'
        ? (root as { generatedAt: string }).generatedAt
        : new Date(0).toISOString(),
      feeSnapshot: (root as RouteCostBudget).feeSnapshot,
      routes: parsedRoutes as RouteCostBudget['routes'],
    }
  } catch {
    return null
  }
}

function routeCostBudgetReasons(
  selectedRoute: RouteName,
  selectedBudget: RouteCostBudget['routes'][RouteName] | null,
  routeCostBudget: RouteCostBudget | null,
): string[] {
  if (!routeCostBudget) return ['route_cost_budget_missing']
  if (!selectedBudget) return [`selected_route_budget_missing:${selectedRoute}`]
  return selectedBudget.totalExpectedCostBps > selectedBudget.maxAllowedCostBps
    ? [`route_cost_budget_exceeded:${selectedRoute}`]
    : []
}

async function loadCandles(path: string): Promise<Candle[]> {
  const raw = await readFile(path, 'utf-8')
  const lines = raw.trim().split(/\r?\n/)
  if (lines.length < 2) return []
  const header = lines[0].split(',')
  const idx = {
    timestamp: header.indexOf('timestamp'),
    open: header.indexOf('open'),
    high: header.indexOf('high'),
    low: header.indexOf('low'),
    close: header.indexOf('close'),
    volume: header.indexOf('volume'),
  }
  if (Object.values(idx).some(value => value < 0)) return []
  return lines.slice(1)
    .flatMap(line => {
      const cols = line.split(',')
      const candle = {
        timestamp: Number(cols[idx.timestamp]),
        open: Number(cols[idx.open]),
        high: Number(cols[idx.high]),
        low: Number(cols[idx.low]),
        close: Number(cols[idx.close]),
        volume: Number(cols[idx.volume]),
      }
      if (!isCoherentCandle(candle)) return []
      return [candle]
    })
    .sort((a, b) => a.timestamp - b.timestamp)
}

function isCoherentCandle(candle: Candle): boolean {
  return Number.isFinite(candle.timestamp) && candle.timestamp > 0
    && [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)
    && candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0
    && candle.volume >= 0 && candle.high >= candle.low
}

function countByReasonClass(candidates: ShadowCandidate[]): Array<{ reasonClass: ShadowReasonClass; count: number }> {
  const counts = new Map<ShadowReasonClass, number>()
  for (const candidate of candidates) counts.set(candidate.reasonClass, (counts.get(candidate.reasonClass) ?? 0) + 1)
  return [...counts.entries()]
    .map(([reasonClass, count]) => ({ reasonClass, count }))
    .sort((a, b) => b.count - a.count || a.reasonClass.localeCompare(b.reasonClass))
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const withoutPrefix = arg.slice(2)
    const eq = withoutPrefix.indexOf('=')
    if (eq >= 0) {
      out.set(withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out.set(withoutPrefix, next)
      i += 1
    } else {
      out.set(withoutPrefix, 'true')
    }
  }
  return out
}

function parseSymbols(raw: string | undefined): string[] {
  const symbols = raw?.split(',').map(value => value.trim().toUpperCase()).filter(Boolean)
  return symbols?.length ? symbols : defaultPaperUniverseSymbols()
}

function parseNullableString(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' || trimmed.toLowerCase() === 'null' ? null : trimmed
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected positive integer, got ${value}`)
  return parsed
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Expected positive number, got ${value}`)
  return parsed
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error(`Invalid boolean value: ${value}`)
}

function laneLeverage(lane: Lane): number {
  return lane === 'volume_breakout_3x' ? 3 : 1
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function roundFinite(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(10)) : value
}

async function main(): Promise<void> {
  const args = parseShadowCaptureArgs(process.argv.slice(2))
  const report = await capturePolicyShadowOpportunities(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(`paper policy shadow capture: recorded=${report.counts.recorded} duplicate=${report.counts.duplicateSkipped} candidates=${report.counts.candidatesSeen}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
