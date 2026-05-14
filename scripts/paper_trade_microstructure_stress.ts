/**
 * Microstructure stress paper trader (1-second bars).
 *
 * This is a local paper-only lane for high-leverage stress accounts. It never
 * sets exchange leverage and never submits live orders.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defaultSecondLevelUniverseAssets, paperSymbolToCsvFile } from './lib/paper_universe.js'
import {
  FLASH_CONFIDENCE_THRESHOLD_BY_LANE,
  MICROSTRUCTURE_MAX_1S_DATA_AGE_MS,
} from '../src/runtime/market_intel_constants.js'
import {
  isMarketIntelSymbolBanned,
  readMarketIntelContext,
  type MarketIntelContext,
} from '../src/runtime/market_intel_context.js'
import {
  readSystemFuse,
  writeMicrostructureHeartbeat,
  type SystemFuseState,
} from '../src/runtime/system_fuse.js'
import {
  nextMicrostructurePositionState,
  readMicrostructurePositionState,
  writeMicrostructurePositionState,
  type MicrostructurePositionStateEntry,
} from '../src/runtime/paper_microstructure_position_state.js'
import {
  appendPaperTradeResult,
  assertCompletePredictedOpenEvidenceRecord,
  buildPaperTradeMfeMaeEvidence,
  buildPaperTradeCostEvidence,
  buildPaperTradePredictedOpenEvidence,
  withPaperTradeContextCoverage,
  type PaperTradeResult,
  type PaperTradeCloseReason,
} from '../src/runtime/paper_trade_result.js'
import {
  appendPaperPolicyShadowOpen,
  buildPaperPolicyShadowId,
  type AppendPaperPolicyShadowResult,
} from '../src/runtime/paper_policy_shadow_ledger.js'
import {
  buildPaperOpenContextSnapshot,
  paperOpenContextAcceptRejectReasons,
  type PaperOpenContextStatus,
} from '../src/runtime/paper_open_context.js'
import { estimatePaperRoundTripCostPct, roundSignalQualityNumber, PAPER_STALE_MARK_MATCH_PENALTY_BPS } from '../src/runtime/paper_cost_helpers.js'
import { buildOpenCostSnapshot } from '../src/runtime/paper_open_cost_builder.js'

interface Candle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface MicroProfile {
  id: string
  label: string
  mode: 'paper_trade' | 'stress_only'
  cadence: 'second'
  timeframe: '1s'
  strategyLane: 'microstructure_stress'
  leverage: number
  marginFraction: number
  maxPositions: number
  maxHoldingSeconds: number
  minAbsReturnPct: number
  minVolumeRatio: number
  stopLossPct: number
  takeProfitPct: number
}

export interface MicroPosition {
  symbol: string
  direction: 'long' | 'short'
  entryPrice: number
  quantity: number
  entryTime: string
  entryBarTime: number
  stopLossPrice: number
  takeProfitPrice: number
  confidence: number
  accountId: string
  accountLabel: string
  leverage: number
  marginUsd: number
  notionalUsd: number
  liquidationMovePctApprox: number
  contextSnapshotId?: string
  decisionTime?: string
  marketDataWatermarkAtDecisionTime?: string
  watermark?: string
  featuresAvailableAtDecisionTime?: boolean
  featureSchemaVersion?: string
  contextGenerationAtOpen?: number
  contextStatus?: PaperOpenContextStatus | string | null
  flashContextStatus?: PaperOpenContextStatus | string | null
  contextReason?: string | null
  flashEpochAtOpen?: number | null
  flashConfidenceLowAtOpen?: number
  ruleScoreAtOpen?: number
  proEpochAtOpen?: number | null
  marketIntelTriggerAtOpen?: string | null
  volumeRatioAtOpen?: number | null
  return30sPctAtOpen?: number | null
  return60sPctAtOpen?: number | null
  microstructureConfidenceAtOpen?: number | null
  liquidityUsdAtOpen?: number | null
  spreadStatusAtOpen?: 'unknown'
  estimatedRoundTripCostPctAtOpen?: number | null
  estimatedRoundTripCostPctOfMarginAtOpen?: number | null
  expectedGrossEdgePctAtOpen?: number | null
  expectedNetEdgePctAtOpen?: number | null
  expectedEdgeSourceAtOpen?: string | null
  routeCostBpsAtOpen?: number | null
  roundTripCostBpsAtOpen?: number | null
  markPriceAtOpen?: number | null
  markPriceTimestampAtOpen?: string | null
  matchPriceAtOpen?: number | null
  matchPriceSourceAtOpen?: string | null
  markMatchPenaltyBpsAtOpen?: number | null
  markMatchStatusAtOpen?: string | null
}

export interface MicroTrade {
  id: string
  symbol: string
  direction: 'long' | 'short'
  entryPrice: number
  exitPrice: number | null
  entryTime: string
  exitTime: string | null
  quantity: number
  pnl: number | null
  pnlPct: number | null
  reason: string
  accountId: string
  accountLabel: string
  leverage: number
  marginUsd: number
  notionalUsd: number
  liquidationMovePctApprox: number
  liquidated: boolean
  priceSource?: '1s' | '5m' | 'last_known' | 'unavailable'
  priceStale?: boolean
  contextSnapshotId?: string | null
  decisionTime?: string | null
  marketDataWatermarkAtDecisionTime?: string | null
  watermark?: string | null
  featuresAvailableAtDecisionTime?: boolean | null
  featureSchemaVersion?: string | null
  contextGenerationAtOpen?: number | null
  contextStatus?: string | null
  flashContextStatus?: string | null
  contextReason?: string | null
  flashEpochAtOpen?: number | null
  flashConfidenceLowAtOpen?: number | null
  ruleScoreAtOpen?: number | null
  proEpochAtOpen?: number | null
  marketIntelTriggerAtOpen?: string | null
  volumeRatioAtOpen?: number | null
  return30sPctAtOpen?: number | null
  return60sPctAtOpen?: number | null
  microstructureConfidenceAtOpen?: number | null
  liquidityUsdAtOpen?: number | null
  estimatedRoundTripCostPctAtOpen?: number | null
  estimatedRoundTripCostPctOfMarginAtOpen?: number | null
  expectedGrossEdgePctAtOpen?: number | null
  expectedNetEdgePctAtOpen?: number | null
  expectedEdgeSourceAtOpen?: string | null
  routeCostBpsAtOpen?: number | null
  roundTripCostBpsAtOpen?: number | null
  markPriceAtOpen?: number | null
  markPriceTimestampAtOpen?: string | null
  matchPriceAtOpen?: number | null
  matchPriceSourceAtOpen?: string | null
  markMatchPenaltyBpsAtOpen?: number | null
  markMatchStatusAtOpen?: string | null
  spreadStatusAtOpen?: 'unknown'
}

export interface MicroAccount {
  equity: number
  initialEquity: number
  positions: MicroPosition[]
  tradeHistory: MicroTrade[]
}

export interface MicroSignal {
  symbol: string
  direction: 'long' | 'short'
  confidence: number
  price: number
  barTime: number
  return30sPct: number
  return60sPct: number
  volumeRatio: number
  liquidityUsd: number
  reason: string
}

export interface MicroSignalQualityAtOpen {
  volumeRatioAtOpen: number
  return30sPctAtOpen: number
  return60sPctAtOpen: number
  microstructureConfidenceAtOpen: number
  liquidityUsdAtOpen: number
  spreadStatusAtOpen: 'unknown'
}

interface RejectedMicroSignalReport extends MicroSignalQualityAtOpen {
  symbol: string
  direction: 'long' | 'short'
  price: number
  barTime: number
  reason: string
  gateReasons: string[]
}

interface DataFreshness {
  latestTs: number | null
  ageMs: number | null
  stale: boolean
}

export interface PaperRuntimeGate {
  allowNew: boolean
  closeMode: 'none' | 'soft_close' | 'hard_close'
  closeReason: PaperTradeCloseReason | null
  reasons: string[]
  context: MarketIntelContext
  fuse: SystemFuseState
  dataFreshness: DataFreshness
}

export const MICRO_PROFILES: MicroProfile[] = [
  {
    id: 'stress_10x',
    label: 'Stress 10x',
    mode: 'paper_trade',
    cadence: 'second',
    timeframe: '1s',
    strategyLane: 'microstructure_stress',
    leverage: 10,
    marginFraction: 0.01,
    maxPositions: 2,
    maxHoldingSeconds: 120,
    minAbsReturnPct: 0.20,
    minVolumeRatio: 3.0,
    stopLossPct: 0.50,
    takeProfitPct: 0.50,
  },
  {
    id: 'liquidation_probe_100x',
    label: 'Liquidation probe 100x',
    mode: 'stress_only',
    cadence: 'second',
    timeframe: '1s',
    strategyLane: 'microstructure_stress',
    leverage: 100,
    marginFraction: 0.001,
    maxPositions: 1,
    maxHoldingSeconds: 30,
    minAbsReturnPct: 0.15,
    minVolumeRatio: 4.0,
    stopLossPct: 0.08,
    takeProfitPct: 0.12,
  },
]

const CSV_HEADER = 'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange'

function accountPath(profile: MicroProfile): string {
  return join(import.meta.dirname ?? '.', '..', 'data', 'paper_trading', `account_ms_${profile.id}.json`)
}

function createEmptyAccount(): MicroAccount {
  return { equity: 100_000, initialEquity: 100_000, positions: [], tradeHistory: [] }
}

function normalizeAccount(value: unknown): MicroAccount {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return createEmptyAccount()
  const raw = value as Partial<MicroAccount>
  return {
    equity: typeof raw.equity === 'number' && Number.isFinite(raw.equity) ? raw.equity : 100_000,
    initialEquity: typeof raw.initialEquity === 'number' && Number.isFinite(raw.initialEquity)
      ? raw.initialEquity
      : 100_000,
    positions: Array.isArray(raw.positions) ? raw.positions : [],
    tradeHistory: Array.isArray(raw.tradeHistory) ? raw.tradeHistory : [],
  }
}

function loadAccount(profile: MicroProfile): MicroAccount {
  if (profile.mode === 'stress_only') {
    return createEmptyAccount()
  }
  try {
    return normalizeAccount(JSON.parse(readFileSync(accountPath(profile), 'utf-8')))
  } catch {
    return createEmptyAccount()
  }
}

function profileLane(profile: MicroProfile): 'microstructure_10x' | 'microstructure_100x' {
  return profile.leverage >= 100 ? 'microstructure_100x' : 'microstructure_10x'
}

async function saveAccount(profile: MicroProfile, account: MicroAccount): Promise<void> {
  if (profile.mode === 'stress_only') return
  const dir = join(import.meta.dirname ?? '.', '..', 'data', 'paper_trading')
  await mkdir(dir, { recursive: true })
  await writeFile(accountPath(profile), `${JSON.stringify(account, null, 2)}\n`, 'utf-8')
}

async function saveRuntimeReport(report: unknown): Promise<void> {
  const dir = join(import.meta.dirname ?? '.', '..', 'data', 'runtime')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'paper_microstructure_stress.latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
}

export function shouldAllowUngatedPaperLane(argv: string[]): boolean {
  const raw = parseRawArgs(argv)
  return parseBool(raw.get('allowUngatedPaperLane'), false)
}

export function shouldDryRun(argv: string[]): boolean {
  const raw = parseRawArgs(argv)
  return parseBool(raw.get('dryRun'), true)
}

async function loadCandles(path: string): Promise<Candle[]> {
  const raw = await readFile(path, 'utf-8')
  const lines = raw.trim().split('\n').filter(Boolean)
  const header = (lines[0] || CSV_HEADER).split(',')
  const timestampIndex = header.indexOf('timestamp')
  const openIndex = header.indexOf('open')
  const highIndex = header.indexOf('high')
  const lowIndex = header.indexOf('low')
  const closeIndex = header.indexOf('close')
  const volumeIndex = header.indexOf('volume')
  return lines.slice(1)
    .map((line) => {
      const cols = line.split(',')
      return {
        timestamp: Number(cols[timestampIndex]),
        open: Number(cols[openIndex]),
        high: Number(cols[highIndex]),
        low: Number(cols[lowIndex]),
        close: Number(cols[closeIndex]),
        volume: Number(cols[volumeIndex]),
      }
    })
    .filter(candle => Number.isFinite(candle.timestamp) && candle.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp)
}

function sumVolume(candles: Candle[]): number {
  return candles.reduce((sum, candle) => sum + Math.max(0, candle.volume), 0)
}

export function evaluateMicroSignal(symbol: string, candles: Candle[]): MicroSignal | null {
  if (candles.length < 121) return null
  const latest = candles[candles.length - 1]
  const prev30 = candles[candles.length - 31]
  const prev60 = candles[candles.length - 61]
  const recent = candles.slice(-10)
  const baseline = candles.slice(-120, -10)
  const baselinePer10s = sumVolume(baseline) / Math.max(1, baseline.length / 10)
  const recentVolume = sumVolume(recent)
  const volumeRatio = baselinePer10s > 0 ? recentVolume / baselinePer10s : 0
  const return30sPct = (latest.close / prev30.close - 1) * 100
  const return60sPct = (latest.close / prev60.close - 1) * 100
  const impulsePct = Math.abs(return30sPct) >= Math.abs(return60sPct) * 0.6
    ? return30sPct
    : return60sPct
  const direction = impulsePct >= 0 ? 'long' : 'short'
  const strength = Math.max(Math.abs(return30sPct), Math.abs(return60sPct))
  const confidence = Math.min(1, (strength / 0.2) * Math.min(2, volumeRatio) / 2)

  return {
    symbol,
    direction,
    confidence,
    price: latest.close,
    barTime: latest.timestamp,
    return30sPct,
    return60sPct,
    volumeRatio,
    liquidityUsd: recentVolume * latest.close,
    reason: `1s impulse ${direction}: r30=${return30sPct.toFixed(3)}%, r60=${return60sPct.toFixed(3)}%, vol=${volumeRatio.toFixed(2)}x`,
  }
}

export function buildMicroSignalQualityAtOpen(signal: MicroSignal): MicroSignalQualityAtOpen {
  return {
    volumeRatioAtOpen: signal.volumeRatio,
    return30sPctAtOpen: signal.return30sPct,
    return60sPctAtOpen: signal.return60sPct,
    microstructureConfidenceAtOpen: signal.confidence,
    liquidityUsdAtOpen: signal.liquidityUsd,
    spreadStatusAtOpen: 'unknown',
  }
}

function buildRejectedMicroSignalReport(signal: MicroSignal, gate: PaperRuntimeGate): RejectedMicroSignalReport {
  return {
    symbol: signal.symbol,
    direction: signal.direction,
    price: signal.price,
    barTime: signal.barTime,
    reason: signal.reason,
    gateReasons: gate.reasons,
    ...buildMicroSignalQualityAtOpen(signal),
  }
}

export function recordRejectedMicroSignalShadowOpenForTest(
  profile: MicroProfile,
  signal: MicroSignal,
  reason: string,
  gate: PaperRuntimeGate,
): AppendPaperPolicyShadowResult | null {
  return recordRejectedMicroSignalShadowOpen(profile, signal, reason, gate)
}

export function openMicroPositionsForTest(
  profile: MicroProfile,
  account: MicroAccount,
  signals: MicroSignal[],
  gate: PaperRuntimeGate,
): ReturnType<typeof openPositions> {
  return openPositions(profile, account, signals, gate)
}

function recordRejectedMicroSignalShadowOpen(
  profile: MicroProfile,
  signal: MicroSignal,
  reason: string,
  gate: PaperRuntimeGate,
): AppendPaperPolicyShadowResult | null {
  if (!isFiniteMicroSignalForOpenEvidence(signal)) return null
  const lane = profileLane(profile)
  const openContext = buildPaperOpenContextSnapshot(gate.context, lane, new Date(), signal.symbol)
  const stopLossPrice = signal.direction === 'long'
    ? signal.price * (1 - profile.stopLossPct / 100)
    : signal.price * (1 + profile.stopLossPct / 100)
  const cost = buildMicroCostSnapshot(profile.leverage, signal.price, signal.symbol, openContext.decisionTime)
  const edge = buildMicroExpectedEdgeSnapshot(signal, cost.estimatedRoundTripCostPctAtOpen)
  assertCompleteMicroPredictedOpenEvidence('shadow_open', {
    ...cost,
    ...edge,
  })
  const shadowTradeId = [
    'microstructure',
    lane,
    signal.symbol,
    signal.barTime,
    signal.direction,
  ].join(':')
  return appendPaperPolicyShadowOpen({
    counterfactualType: 'trade_level_shadow',
    eventType: 'open',
    shadowId: buildPaperPolicyShadowId({
      tradeId: shadowTradeId,
      shadowPolicyVersion: 'microstructure_shadow_v1',
      entryTs: signal.barTime,
      policyId: lane,
    }),
    lane,
    symbol: signal.symbol,
    side: signal.direction,
    entryPrice: signal.price,
    openTs: new Date(signal.barTime).toISOString(),
    openBarTime: signal.barTime,
    horizonMs: profile.maxHoldingSeconds * 1000,
    notionalUsd: null,
    stopLossPrice,
    blockReasons: reason.split(';').map(part => part.trim()).filter(Boolean),
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
    quality: buildMicroSignalQualityAtOpen(signal),
    cost: {
      ...cost,
      ...edge,
    },
  })
}

function signalPassesProfile(signal: MicroSignal, profile: MicroProfile): boolean {
  return isFiniteMicroSignalForOpenEvidence(signal)
    && Math.max(Math.abs(signal.return30sPct), Math.abs(signal.return60sPct)) >= profile.minAbsReturnPct
    && signal.volumeRatio >= profile.minVolumeRatio
    && signal.confidence >= 0.15
}

function isFiniteMicroSignalForOpenEvidence(signal: MicroSignal): boolean {
  return Number.isFinite(signal.price) && signal.price > 0
    && Number.isFinite(signal.confidence)
    && Number.isFinite(signal.volumeRatio)
    && Number.isFinite(signal.return30sPct)
    && Number.isFinite(signal.return60sPct)
    && Number.isFinite(signal.liquidityUsd)
}

function liquidationMovePctApprox(leverage: number): number {
  return leverage > 0 ? 100 / leverage : 100
}

function buildMicroCostSnapshot(
  leverage: number,
  matchPrice: number,
  symbol?: string,
  decisionTime?: string | Date | number | null,
): Pick<
  MicroPosition,
  | 'estimatedRoundTripCostPctAtOpen'
  | 'estimatedRoundTripCostPctOfMarginAtOpen'
  | 'routeCostBpsAtOpen'
  | 'roundTripCostBpsAtOpen'
  | 'markPriceAtOpen'
  | 'markPriceTimestampAtOpen'
  | 'matchPriceAtOpen'
  | 'matchPriceSourceAtOpen'
  | 'markMatchPenaltyBpsAtOpen'
  | 'markMatchStatusAtOpen'
> {
  return buildOpenCostSnapshot(leverage, matchPrice, symbol, decisionTime)
}

function buildMicroExpectedEdgeSnapshot(
  signal: MicroSignal,
  estimatedRoundTripCostPctAtOpen: number | null,
): Pick<
  MicroPosition,
  | 'expectedGrossEdgePctAtOpen'
  | 'expectedNetEdgePctAtOpen'
  | 'expectedEdgeSourceAtOpen'
> {
  const impulsePct = Math.max(Math.abs(signal.return30sPct), Math.abs(signal.return60sPct))
  const grossEdge = Number.isFinite(impulsePct) && Number.isFinite(signal.confidence)
    ? roundSignalQualityNumber(impulsePct * Math.max(0, signal.confidence))
    : null
  return {
    expectedGrossEdgePctAtOpen: grossEdge,
    expectedNetEdgePctAtOpen: grossEdge == null || estimatedRoundTripCostPctAtOpen == null
      ? null
      : roundSignalQualityNumber(grossEdge - estimatedRoundTripCostPctAtOpen),
    expectedEdgeSourceAtOpen: grossEdge == null ? null : 'microstructure_impulse_pct_x_confidence_minus_paper_route_cost',
  }
}

function copyMicroCostSnapshotFromPosition(pos: MicroPosition): Pick<
  MicroPosition,
  | 'estimatedRoundTripCostPctAtOpen'
  | 'estimatedRoundTripCostPctOfMarginAtOpen'
  | 'expectedGrossEdgePctAtOpen'
  | 'expectedNetEdgePctAtOpen'
  | 'expectedEdgeSourceAtOpen'
  | 'routeCostBpsAtOpen'
  | 'roundTripCostBpsAtOpen'
  | 'markPriceAtOpen'
  | 'markPriceTimestampAtOpen'
  | 'matchPriceAtOpen'
  | 'matchPriceSourceAtOpen'
  | 'markMatchPenaltyBpsAtOpen'
  | 'markMatchStatusAtOpen'
> {
  return {
    estimatedRoundTripCostPctAtOpen: pos.estimatedRoundTripCostPctAtOpen ?? null,
    estimatedRoundTripCostPctOfMarginAtOpen: pos.estimatedRoundTripCostPctOfMarginAtOpen ?? null,
    expectedGrossEdgePctAtOpen: pos.expectedGrossEdgePctAtOpen ?? null,
    expectedNetEdgePctAtOpen: pos.expectedNetEdgePctAtOpen ?? null,
    expectedEdgeSourceAtOpen: pos.expectedEdgeSourceAtOpen ?? null,
    routeCostBpsAtOpen: pos.routeCostBpsAtOpen ?? null,
    roundTripCostBpsAtOpen: pos.roundTripCostBpsAtOpen ?? null,
    markPriceAtOpen: pos.markPriceAtOpen ?? null,
    markPriceTimestampAtOpen: pos.markPriceTimestampAtOpen ?? null,
    matchPriceAtOpen: pos.matchPriceAtOpen ?? null,
    matchPriceSourceAtOpen: pos.matchPriceSourceAtOpen ?? null,
    markMatchPenaltyBpsAtOpen: pos.markMatchPenaltyBpsAtOpen ?? null,
    markMatchStatusAtOpen: pos.markMatchStatusAtOpen ?? null,
  }
}

export function assertCompleteMicroPredictedOpenEvidenceForTest(
  kind: 'position' | 'trade' | 'shadow_open',
  value: Partial<MicroPosition>,
): void {
  assertCompleteMicroPredictedOpenEvidence(kind, value)
}

function assertCompleteMicroPredictedOpenEvidence(
  kind: 'position' | 'trade' | 'shadow_open',
  value: Partial<MicroPosition>,
): void {
  assertCompletePredictedOpenEvidenceRecord({
    errorPrefix: 'microstructure',
    kind,
    value,
  })
}

function copyMicroOpenContextFromPosition(pos: MicroPosition): Pick<
  MicroTrade,
  | 'contextSnapshotId'
  | 'decisionTime'
  | 'marketDataWatermarkAtDecisionTime'
  | 'watermark'
  | 'featuresAvailableAtDecisionTime'
  | 'featureSchemaVersion'
  | 'contextGenerationAtOpen'
  | 'contextStatus'
  | 'flashContextStatus'
  | 'contextReason'
  | 'flashEpochAtOpen'
  | 'flashConfidenceLowAtOpen'
  | 'ruleScoreAtOpen'
  | 'proEpochAtOpen'
  | 'marketIntelTriggerAtOpen'
> {
  const watermark = pos.watermark ?? pos.marketDataWatermarkAtDecisionTime ?? null
  const flashContextStatus = pos.flashContextStatus ?? pos.contextStatus ?? null
  return {
    contextSnapshotId: pos.contextSnapshotId ?? null,
    decisionTime: pos.decisionTime ?? null,
    marketDataWatermarkAtDecisionTime: pos.marketDataWatermarkAtDecisionTime ?? watermark,
    watermark,
    featuresAvailableAtDecisionTime: pos.featuresAvailableAtDecisionTime ?? null,
    featureSchemaVersion: pos.featureSchemaVersion ?? null,
    contextGenerationAtOpen: pos.contextGenerationAtOpen ?? null,
    contextStatus: pos.contextStatus ?? null,
    flashContextStatus,
    contextReason: pos.contextReason ?? null,
    flashEpochAtOpen: pos.flashEpochAtOpen ?? null,
    flashConfidenceLowAtOpen: pos.flashConfidenceLowAtOpen ?? null,
    ruleScoreAtOpen: pos.ruleScoreAtOpen ?? pos.confidence ?? null,
    proEpochAtOpen: pos.proEpochAtOpen ?? null,
    marketIntelTriggerAtOpen: pos.marketIntelTriggerAtOpen ?? null,
  }
}

function closePositions(
  profile: MicroProfile,
  account: MicroAccount,
  assetMap: Map<string, Candle[]>,
  gate: PaperRuntimeGate,
): MicroTrade[] {
  const trades: MicroTrade[] = []
  const nowIso = new Date().toISOString()
  const nowMs = Date.now()
  for (const position of [...account.positions]) {
    const candles = assetMap.get(position.symbol)
    if (!candles || candles.length === 0) continue
    const latest = candles[candles.length - 1]
    const priceReturn = position.direction === 'long'
      ? (latest.close / position.entryPrice - 1)
      : (position.entryPrice / latest.close - 1)
    const pnl = priceReturn * position.notionalUsd
    const pnlPct = priceReturn * 100
    const holdingSeconds = (latest.timestamp - position.entryBarTime) / 1000
    const adverseMovePct = Math.max(0, -pnlPct)
    const liquidated = adverseMovePct >= position.liquidationMovePctApprox * 0.9
    const hitStop = position.direction === 'long'
      ? latest.close <= position.stopLossPrice
      : latest.close >= position.stopLossPrice
    const hitTakeProfit = position.direction === 'long'
      ? latest.close >= position.takeProfitPrice
      : latest.close <= position.takeProfitPrice
    const expired = holdingSeconds >= profile.maxHoldingSeconds
    const bannedSymbol = isMarketIntelSymbolBanned(gate.context, position.symbol)

    if (!bannedSymbol && !liquidated && !hitStop && !hitTakeProfit && !expired) continue

    const reason = bannedSymbol
      ? 'banned_symbol'
      : liquidated
        ? `virtual_liquidation_guard:${adverseMovePct.toFixed(3)}%>=${(position.liquidationMovePctApprox * 0.9).toFixed(3)}%`
        : hitStop
          ? `stop_loss:${pnlPct.toFixed(3)}%`
          : hitTakeProfit
            ? `take_profit:${pnlPct.toFixed(3)}%`
            : `holding_expired:${holdingSeconds.toFixed(0)}s`

    const contextAtOpen = copyMicroOpenContextFromPosition(position)
    const costAtOpen = copyMicroCostSnapshotFromPosition(position)
    const trade: MicroTrade = {
      id: `close_${profile.id}_${position.symbol}_${nowMs}`,
      symbol: position.symbol,
      direction: position.direction,
      entryPrice: position.entryPrice,
      exitPrice: latest.close,
      entryTime: position.entryTime,
      exitTime: nowIso,
      quantity: position.quantity,
      pnl: liquidated ? -Math.abs(position.marginUsd) : pnl,
      pnlPct,
      reason,
      accountId: profile.id,
      accountLabel: profile.label,
      leverage: profile.leverage,
      marginUsd: position.marginUsd,
      notionalUsd: position.notionalUsd,
      liquidationMovePctApprox: position.liquidationMovePctApprox,
      liquidated,
      ...contextAtOpen,
      volumeRatioAtOpen: position.volumeRatioAtOpen ?? null,
      return30sPctAtOpen: position.return30sPctAtOpen ?? null,
      return60sPctAtOpen: position.return60sPctAtOpen ?? null,
      microstructureConfidenceAtOpen: position.microstructureConfidenceAtOpen ?? null,
      liquidityUsdAtOpen: position.liquidityUsdAtOpen ?? null,
      spreadStatusAtOpen: position.spreadStatusAtOpen ?? 'unknown',
      ...costAtOpen,
    }
    account.equity += trade.pnl ?? 0
    account.tradeHistory.push(trade)
    account.positions = account.positions.filter(item => item !== position)
    appendClosedTradeResult(profile, position, trade, mapCloseReason(reason), gate, '1s', gate.dataFreshness.stale, candles)
    trades.push(trade)
  }
  return trades
}

function hardClosePositions(
  profile: MicroProfile,
  account: MicroAccount,
  assetMap: Map<string, Candle[]>,
  gate: PaperRuntimeGate,
): MicroTrade[] {
  if (gate.closeMode !== 'hard_close' || !gate.closeReason) return []
  const trades: MicroTrade[] = []
  const nowIso = new Date().toISOString()
  const nowMs = Date.now()
  for (const position of [...account.positions]) {
    const closePrice = resolveHardClosePrice(position, assetMap)
    if (closePrice.price === null) continue
    const priceReturn = position.direction === 'long'
      ? closePrice.price / position.entryPrice - 1
      : position.entryPrice / closePrice.price - 1
    const pnl = priceReturn * position.notionalUsd
    const pnlPct = priceReturn * 100
    const contextAtOpen = copyMicroOpenContextFromPosition(position)
    const costAtOpen = copyMicroCostSnapshotFromPosition(position)
    const trade: MicroTrade = {
      id: `hard_close_${profile.id}_${position.symbol}_${nowMs}`,
      symbol: position.symbol,
      direction: position.direction,
      entryPrice: position.entryPrice,
      exitPrice: closePrice.price,
      entryTime: position.entryTime,
      exitTime: nowIso,
      quantity: position.quantity,
      pnl,
      pnlPct,
      reason: gate.closeReason,
      accountId: profile.id,
      accountLabel: profile.label,
      leverage: profile.leverage,
      marginUsd: position.marginUsd,
      notionalUsd: position.notionalUsd,
      liquidationMovePctApprox: position.liquidationMovePctApprox,
      liquidated: false,
      priceSource: closePrice.source,
      priceStale: closePrice.stale,
      ...contextAtOpen,
      volumeRatioAtOpen: position.volumeRatioAtOpen ?? null,
      return30sPctAtOpen: position.return30sPctAtOpen ?? null,
      return60sPctAtOpen: position.return60sPctAtOpen ?? null,
      microstructureConfidenceAtOpen: position.microstructureConfidenceAtOpen ?? null,
      liquidityUsdAtOpen: position.liquidityUsdAtOpen ?? null,
      spreadStatusAtOpen: position.spreadStatusAtOpen ?? 'unknown',
      ...costAtOpen,
    }
    account.equity += pnl
    account.tradeHistory.push(trade)
    account.positions = account.positions.filter(item => item !== position)
    appendClosedTradeResult(profile, position, trade, gate.closeReason, gate, closePrice.source, closePrice.stale, closePrice.candles)
    trades.push(trade)
  }
  return trades
}

function resolveHardClosePrice(
  position: MicroPosition,
  assetMap: Map<string, Candle[]>,
): { price: number | null; source: '1s' | '5m' | 'last_known' | 'unavailable'; stale: boolean; candles: Candle[] } {
  const candles = assetMap.get(position.symbol)
  const latest = candles?.[candles.length - 1]
  if (latest && latest.close > 0) return { price: latest.close, source: '1s', stale: true, candles }
  const fiveMinute = loadLatestFiveMinutePrice(position.symbol)
  if (fiveMinute !== null) return { price: fiveMinute, source: '5m', stale: true, candles: [] }
  if (position.entryPrice > 0) return { price: position.entryPrice, source: 'last_known', stale: true, candles: [] }
  return { price: null, source: 'unavailable', stale: true, candles: [] }
}

function loadLatestFiveMinutePrice(symbol: string): number | null {
  try {
    const path = join(import.meta.dirname ?? '.', '..', 'data', 'market', 'live_5m', paperSymbolToCsvFile(symbol, '5m'))
    const raw = readFileSync(path, 'utf-8').trim()
    const lines = raw.split('\n').filter(Boolean)
    if (lines.length < 2) return null
    const header = lines[0].split(',')
    const closeIndex = header.indexOf('close')
    const cols = lines[lines.length - 1].split(',')
    const close = Number(cols[closeIndex])
    return Number.isFinite(close) && close > 0 ? close : null
  } catch {
    return null
  }
}

function openPositions(
  profile: MicroProfile,
  account: MicroAccount,
  signals: MicroSignal[],
  gate: PaperRuntimeGate,
): {
  proposedOrders: MicroSignal[]
  executedTrades: MicroTrade[]
  rejectedSignals: RejectedMicroSignalReport[]
} {
  if (!gate.allowNew) {
    for (const signal of signals) {
      recordRejectedMicroSignalShadowOpen(
        profile,
        signal,
        gate.reasons.length > 0 ? gate.reasons.join('; ') : 'profile_gate_blocked',
        gate,
      )
    }
    return {
      proposedOrders: [],
      executedTrades: [],
      rejectedSignals: signals.map(signal => buildRejectedMicroSignalReport(signal, gate)),
    }
  }
  const lane = profileLane(profile)
  const minConfidence = Math.max(
    0.15,
    gate.context.suggestedRuleThresholdByLane[lane] ?? 0,
  )
  const proposedOrders = signals.filter(signal => signalPassesProfile(signal, profile)
    && !isMarketIntelSymbolBanned(gate.context, signal.symbol)
    && signal.confidence >= minConfidence)
  if (profile.mode === 'stress_only') {
    const rejectedSignals = signals
      .filter(signal => !proposedOrders.includes(signal))
      .map(signal => {
        const reasons = rejectedMicroSignalReasons(signal, profile, gate, minConfidence)
        recordRejectedMicroSignalShadowOpen(profile, signal, reasons.join('; '), gate)
        return buildRejectedMicroSignalReport(signal, {
          ...gate,
          reasons: [...gate.reasons, ...reasons],
        })
      })
    return { proposedOrders, executedTrades: [], rejectedSignals }
  }
  const executedTrades: MicroTrade[] = []
  const rejectedSignals = signals
    .filter(signal => !proposedOrders.includes(signal))
    .map(signal => {
      const reasons = rejectedMicroSignalReasons(signal, profile, gate, minConfidence)
      recordRejectedMicroSignalShadowOpen(profile, signal, reasons.join('; '), gate)
      return buildRejectedMicroSignalReport(signal, {
        ...gate,
        reasons: [...gate.reasons, ...reasons],
      })
    })
  const nowIso = new Date().toISOString()
  const nowMs = Date.now()
  for (const signal of proposedOrders) {
    if (account.positions.length >= profile.maxPositions) break
    if (account.positions.some(position => position.symbol === signal.symbol)) continue
    const marginUsd = account.equity * profile.marginFraction
    const notionalUsd = marginUsd * profile.leverage
    const quantity = notionalUsd / signal.price
    const stopLossPrice = signal.direction === 'long'
      ? signal.price * (1 - profile.stopLossPct / 100)
      : signal.price * (1 + profile.stopLossPct / 100)
    const takeProfitPrice = signal.direction === 'long'
      ? signal.price * (1 + profile.takeProfitPct / 100)
      : signal.price * (1 - profile.takeProfitPct / 100)
    const liquidationMove = liquidationMovePctApprox(profile.leverage)
    const lane = profileLane(profile)
    const openContext = buildPaperOpenContextSnapshot(gate.context, lane, new Date(), signal.symbol)
    const contextRejectReasons = paperOpenContextAcceptRejectReasons(openContext)
    if (contextRejectReasons.length > 0) {
      recordRejectedMicroSignalShadowOpen(
        profile,
        signal,
        contextRejectReasons.join('; '),
        gate,
      )
      rejectedSignals.push(buildRejectedMicroSignalReport(signal, {
        ...gate,
        reasons: [...gate.reasons, ...contextRejectReasons],
      }))
      continue
    }
    const signalQuality = buildMicroSignalQualityAtOpen(signal)
    const costAtOpen = buildMicroCostSnapshot(profile.leverage, signal.price, signal.symbol, openContext.decisionTime)
    const edgeAtOpen = buildMicroExpectedEdgeSnapshot(signal, costAtOpen.estimatedRoundTripCostPctAtOpen)
    const position: MicroPosition = {
      symbol: signal.symbol,
      direction: signal.direction,
      entryPrice: signal.price,
      quantity,
      entryTime: nowIso,
      entryBarTime: signal.barTime,
      stopLossPrice,
      takeProfitPrice,
      confidence: signal.confidence,
      accountId: profile.id,
      accountLabel: profile.label,
      leverage: profile.leverage,
      marginUsd,
      notionalUsd,
      liquidationMovePctApprox: liquidationMove,
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
      flashConfidenceLowAtOpen: openContext.flashConfidenceLowAtOpen ?? undefined,
      ruleScoreAtOpen: signal.confidence,
      proEpochAtOpen: openContext.proEpochAtOpen,
      marketIntelTriggerAtOpen: openContext.marketIntelTriggerAtOpen,
      ...signalQuality,
      ...edgeAtOpen,
      ...costAtOpen,
    }
    const trade: MicroTrade = {
      id: `open_${profile.id}_${signal.symbol}_${nowMs}`,
      symbol: signal.symbol,
      direction: signal.direction,
      entryPrice: signal.price,
      exitPrice: null,
      entryTime: nowIso,
      exitTime: null,
      quantity,
      pnl: null,
      pnlPct: null,
      reason: signal.reason,
      accountId: profile.id,
      accountLabel: profile.label,
      leverage: profile.leverage,
      marginUsd,
      notionalUsd,
      liquidationMovePctApprox: liquidationMove,
      liquidated: false,
      ...copyMicroOpenContextFromPosition(position),
      ...signalQuality,
      ...edgeAtOpen,
      ...costAtOpen,
    }
    assertCompleteMicroPredictedOpenEvidence('position', position)
    assertCompleteMicroPredictedOpenEvidence('trade', trade)
    account.positions.push(position)
    account.tradeHistory.push(trade)
    executedTrades.push(trade)
  }
  return { proposedOrders, executedTrades, rejectedSignals }
}

function rejectedMicroSignalReasons(
  signal: MicroSignal,
  profile: MicroProfile,
  gate: PaperRuntimeGate,
  minConfidence: number,
): string[] {
  const reasons: string[] = []
  const maxAbsReturnPct = Math.max(Math.abs(signal.return30sPct), Math.abs(signal.return60sPct))
  if (!Number.isFinite(signal.price) || signal.price <= 0) reasons.push('invalid_price')
  if (!Number.isFinite(signal.return30sPct) || !Number.isFinite(signal.return60sPct)) {
    reasons.push('invalid_return_window')
  }
  if (!Number.isFinite(signal.volumeRatio)) reasons.push('invalid_volume_ratio')
  if (!Number.isFinite(signal.confidence)) reasons.push('invalid_confidence')
  if (!Number.isFinite(signal.liquidityUsd)) reasons.push('invalid_liquidity_usd')
  if (maxAbsReturnPct < profile.minAbsReturnPct) {
    reasons.push(`profile_min_abs_return ${maxAbsReturnPct.toFixed(3)} < ${profile.minAbsReturnPct}`)
  }
  if (signal.volumeRatio < profile.minVolumeRatio) {
    reasons.push(`profile_min_volume_ratio ${signal.volumeRatio.toFixed(3)} < ${profile.minVolumeRatio}`)
  }
  if (signal.confidence < 0.15) reasons.push(`micro_confidence ${signal.confidence.toFixed(3)} < 0.15`)
  if (signal.confidence < minConfidence) {
    reasons.push(`profile_min_confidence ${signal.confidence.toFixed(3)} < ${minConfidence}`)
  }
  if (isMarketIntelSymbolBanned(gate.context, signal.symbol)) reasons.push('market_intel_symbol_blocked')
  return reasons.length > 0 ? reasons : ['profile_filter_rejected']
}

function buildRuntimeGate(
  profile: MicroProfile,
  context: MarketIntelContext,
  fuse: SystemFuseState,
  dataFreshness: DataFreshness,
): PaperRuntimeGate {
  const lane = profileLane(profile)
  const reasons: string[] = []
  let closeMode: PaperRuntimeGate['closeMode'] = 'none'
  let closeReason: PaperTradeCloseReason | null = null
  const nowMs = Date.now()
  const validUntilMs = Date.parse(context.validUntil)
  const contextStale = !Number.isFinite(validUntilMs) || validUntilMs <= nowMs
  const confidenceLow = context.flashConfidenceByLane[lane]?.confidenceLow
  const confidenceThreshold = FLASH_CONFIDENCE_THRESHOLD_BY_LANE[lane]
  let allowNew = true

  if (fuse.status === 'risk_off') {
    reasons.push(`system_fuse:${fuse.reason ?? 'risk_off'}`)
    closeMode = 'hard_close'
    closeReason = 'fuse'
    allowNew = false
  }
  if (context.newsRiskRegime === 'severe') {
    reasons.push('severe_news')
    closeMode = 'hard_close'
    closeReason = closeReason ?? 'severe_news'
    allowNew = false
  }
  if (!context.semanticValidation.passed) {
    reasons.push('semantic_validation_block')
    closeMode = 'hard_close'
    closeReason = closeReason ?? 'stale_context'
    allowNew = false
  }
  if (contextStale) {
    reasons.push('context_stale')
    closeMode = closeMode === 'hard_close' ? closeMode : 'soft_close'
    closeReason = closeReason ?? 'stale_context'
    allowNew = false
  }
  if (context.coldStartRoundsRemaining > 0) {
    reasons.push(`cold_start:${context.coldStartRoundsRemaining}`)
    allowNew = false
  }
  if (dataFreshness.stale) {
    reasons.push(`stale_1s_data:${dataFreshness.ageMs ?? 'unknown'}ms`)
    allowNew = false
  }
  if (context.riskMode === 'risk_off' && closeMode !== 'hard_close') {
    reasons.push('risk_off')
    closeMode = 'soft_close'
    closeReason = closeReason ?? 'stale_context'
    allowNew = false
  }
  if (context.allowNewPositionsByLane[lane] !== true) {
    reasons.push(`lane_not_allowed:${lane}`)
    allowNew = false
  }
  if (typeof confidenceLow !== 'number' || confidenceLow <= confidenceThreshold) {
    reasons.push(`confidence_low:${confidenceLow ?? 'missing'}<=${confidenceThreshold}`)
    allowNew = false
  }

  return { allowNew, closeMode, closeReason, reasons, context, fuse, dataFreshness }
}

function recheckContextBeforeOpen(profile: MicroProfile, gate: PaperRuntimeGate): PaperRuntimeGate {
  const latest = readMarketIntelContext()
  if (latest.contextGeneration === gate.context.contextGeneration) return gate
  return buildRuntimeGate(profile, latest, gate.fuse, gate.dataFreshness)
}

function computeDataFreshness(assetMap: Map<string, Candle[]>): DataFreshness {
  let latestTs: number | null = null
  for (const candles of assetMap.values()) {
    const latest = candles[candles.length - 1]
    if (!latest) continue
    latestTs = Math.max(latestTs ?? 0, latest.timestamp)
  }
  const ageMs = latestTs === null ? null : Date.now() - latestTs
  return {
    latestTs,
    ageMs,
    stale: ageMs === null || ageMs > MICROSTRUCTURE_MAX_1S_DATA_AGE_MS,
  }
}

function mapCloseReason(reason: string): PaperTradeCloseReason {
  if (reason.startsWith('banned_symbol')) return 'banned_symbol'
  if (reason.startsWith('virtual_liquidation_guard')) return 'virtual_liquidation_guard'
  if (reason.startsWith('stop_loss')) return 'stop_loss'
  if (reason.startsWith('take_profit')) return 'take_profit'
  if (reason.startsWith('holding_expired')) return 'holding_expired'
  return 'signal'
}

function appendClosedTradeResult(
  profile: MicroProfile,
  position: MicroPosition,
  trade: MicroTrade,
  closeReason: PaperTradeCloseReason,
  gate: PaperRuntimeGate,
  priceSource: '1s' | '5m' | 'last_known' | 'unavailable',
  priceStale = gate.dataFreshness.stale,
  candles: Candle[] = [],
): void {
  appendPaperTradeResult(buildClosedPaperTradeResult({
    profile,
    position,
    trade,
    closeReason,
    priceSource,
    priceStale,
    candles,
  }))
}

export function buildClosedPaperTradeResult(input: {
  profile: MicroProfile
  position: MicroPosition
  trade: MicroTrade
  closeReason: PaperTradeCloseReason
  priceSource: '1s' | '5m' | 'last_known' | 'unavailable'
  priceStale: boolean
  candles?: Candle[]
}): PaperTradeResult {
  const { profile, position, trade, closeReason, priceSource, priceStale } = input
  const costAtOpen = copyMicroCostSnapshotFromPosition(position)
  const predictedOpenEvidenceInput: Partial<PaperTradeResult> = {
    openTs: trade.entryTime,
    ...costAtOpen,
  }
  return withPaperTradeContextCoverage({
    tradeId: trade.id,
    lane: profileLane(profile),
    symbol: trade.symbol,
    leverage: profile.leverage,
    side: trade.direction,
    openTs: trade.entryTime,
    closeTs: trade.exitTime,
    openPrice: trade.entryPrice,
    closePrice: trade.exitPrice,
    pnlPct: trade.pnlPct,
    pnlUsd: trade.pnl,
    closeReason,
    priceSource,
    priceStale,
    contextSnapshotId: position.contextSnapshotId ?? null,
    decisionTime: position.decisionTime ?? null,
    marketDataWatermarkAtDecisionTime: position.marketDataWatermarkAtDecisionTime ?? null,
    watermark: position.watermark ?? position.marketDataWatermarkAtDecisionTime ?? null,
    featuresAvailableAtDecisionTime: position.featuresAvailableAtDecisionTime ?? null,
    featureSchemaVersion: position.featureSchemaVersion ?? null,
    contextGenerationAtOpen: position.contextGenerationAtOpen ?? null,
    contextStatus: position.contextStatus ?? null,
    flashContextStatus: position.flashContextStatus ?? position.contextStatus ?? null,
    contextReason: position.contextReason ?? null,
    flashEpochAtOpen: position.flashEpochAtOpen ?? null,
    flashConfidenceLowAtOpen: position.flashConfidenceLowAtOpen ?? null,
    ruleScoreAtOpen: position.ruleScoreAtOpen ?? null,
    proEpochAtOpen: position.proEpochAtOpen ?? null,
    marketIntelTriggerAtOpen: position.marketIntelTriggerAtOpen ?? null,
    volumeRatioAtOpen: position.volumeRatioAtOpen ?? null,
    return30sPctAtOpen: position.return30sPctAtOpen ?? null,
    return60sPctAtOpen: position.return60sPctAtOpen ?? null,
    microstructureConfidenceAtOpen: position.microstructureConfidenceAtOpen ?? null,
    liquidityUsdAtOpen: position.liquidityUsdAtOpen ?? null,
    spreadStatusAtOpen: position.spreadStatusAtOpen ?? 'unknown',
    ...costAtOpen,
    ...buildPaperTradePredictedOpenEvidence(predictedOpenEvidenceInput),
    ...buildPaperTradeCostEvidence(costAtOpen),
    ...buildPaperTradeMfeMaeEvidence({
      side: trade.direction,
      openTs: trade.entryTime,
      closeTs: trade.exitTime,
      openPrice: trade.entryPrice,
      closeReason,
      priceSource,
      candles: input.candles ?? [],
    }),
  })
}

function positionStateKey(accountId: string, symbol: string, openedAt: string): string {
  return `${accountId}:${symbol}:${openedAt}`
}

function buildPositionStateEntry(input: {
  profile: MicroProfile
  position: MicroPosition
  gate: PaperRuntimeGate
  previous?: MicrostructurePositionStateEntry
}): MicrostructurePositionStateEntry {
  const lane = profileLane(input.profile)
  const nowIso = new Date().toISOString()
  const previous = input.previous
  const intervalMs = lane === 'microstructure_100x' ? 30_000 : 60_000
  const previousValidationMs = previous?.lastValidatedAt ? Date.parse(previous.lastValidatedAt) : 0
  const shouldValidate = !Number.isFinite(previousValidationMs) || previousValidationMs <= 0 ||
    Date.now() - previousValidationMs >= intervalMs
  return {
    accountId: input.profile.id,
    symbol: input.position.symbol,
    lane,
    openedAt: input.position.entryTime,
    openedWithGeneration: input.position.contextGenerationAtOpen ?? input.gate.context.contextGeneration,
    lastValidatedAt: shouldValidate ? nowIso : previous?.lastValidatedAt ?? null,
    lastValidationGeneration: shouldValidate
      ? input.gate.context.contextGeneration
      : previous?.lastValidationGeneration ?? null,
    closeMode: input.gate.closeMode,
    closeReason: input.gate.closeReason ?? undefined,
  }
}

async function main(): Promise<void> {
  if (shouldDryRun(process.argv.slice(2))) {
    console.log(JSON.stringify({
      family: 'microstructure_stress',
      command: 'paper_trade_microstructure_stress',
      executionMode: {
        dryRun: true,
        writesHeartbeat: false,
        writesPaperAccounts: false,
        writesPaperTradeResults: false,
        writesShadowLedger: false,
        writesRuntimeReport: false,
        writesPositionState: false,
        placesOrders: false,
      },
      optIn: {
        runPaperMutation: '--dryRun false',
        allowUngatedPaperLane: '--allowUngatedPaperLane true',
      },
    }, null, 2))
    return
  }
  writeMicrostructureHeartbeat()
  if (!shouldAllowUngatedPaperLane(process.argv.slice(2))) {
    const blockReason = 'promotion_v2_required_for_paper_lane'
    await saveRuntimeReport({
      generatedAt: new Date().toISOString(),
      status: 'blocked',
      blockReason,
      universeSize: 0,
      signalCount: 0,
      signals: [],
      profiles: [],
      notes: [
        'paper:microstructure-stress is not promotion-v2 gated',
        'run with --allowUngatedPaperLane true only for research diagnostics',
      ],
    })
    console.log(`Blocked: ${blockReason}`)
    return
  }

  const dataDir = join(import.meta.dirname ?? '.', '..', 'data', 'market', 'live_1s')
  const assetMap = new Map<string, Candle[]>()
  for (const asset of defaultSecondLevelUniverseAssets()) {
    try {
      const candles = await loadCandles(join(dataDir, paperSymbolToCsvFile(asset.paperSymbol, '1s')))
      if (candles.length >= 121) assetMap.set(asset.paperSymbol, candles)
    } catch {
      // Missing assets are allowed in this bounded diagnostics lane.
    }
  }
  const dataFreshness = computeDataFreshness(assetMap)
  const context = readMarketIntelContext()
  const fuse = readSystemFuse()
  const previousPositionState = readMicrostructurePositionState()
  const previousPositionStateByKey = new Map(
    previousPositionState.positions.map(position => [positionStateKey(position.accountId, position.symbol, position.openedAt), position]),
  )

  const signals = [...assetMap.entries()]
    .map(([symbol, candles]) => evaluateMicroSignal(symbol, candles))
    .filter((signal): signal is MicroSignal => signal !== null)
    .sort((a, b) => b.confidence - a.confidence)

  const profileReports = []
  const nextPositionStateEntries: MicrostructurePositionStateEntry[] = []
  for (const profile of MICRO_PROFILES) {
    const account = loadAccount(profile)
    const gate = buildRuntimeGate(profile, context, fuse, dataFreshness)
    const hardClosedTrades = hardClosePositions(profile, account, assetMap, gate)
    const closedTrades = closePositions(profile, account, assetMap, gate)
    const latestGate = recheckContextBeforeOpen(profile, gate)
    const { proposedOrders, executedTrades, rejectedSignals } = openPositions(profile, account, signals, latestGate)
    await saveAccount(profile, account)
    for (const position of account.positions) {
      nextPositionStateEntries.push(buildPositionStateEntry({
        profile,
        position,
        gate: latestGate,
        previous: previousPositionStateByKey.get(positionStateKey(profile.id, position.symbol, position.entryTime)),
      }))
    }
    profileReports.push({
      id: profile.id,
      label: profile.label,
      mode: profile.mode,
      cadence: profile.cadence,
      timeframe: profile.timeframe,
      strategyLane: profile.strategyLane,
      minDecisionIntervalMs: 1_000,
      leverage: profile.leverage,
      equity: account.equity,
      initialEquity: account.initialEquity,
      openPositions: account.positions.length,
      totalTrades: account.tradeHistory.length,
      returnPct: (account.equity / account.initialEquity - 1) * 100,
      proposedOrders,
      rejectedSignals,
      executedTrades: [...hardClosedTrades, ...closedTrades, ...executedTrades],
      gate: {
        allowNew: latestGate.allowNew,
        closeMode: latestGate.closeMode,
        closeReason: latestGate.closeReason,
        reasons: latestGate.reasons,
        contextGeneration: latestGate.context.contextGeneration,
      },
      risk: {
        liquidationMovePctApprox: liquidationMovePctApprox(profile.leverage),
        marginFraction: profile.marginFraction,
        maxHoldingSeconds: profile.maxHoldingSeconds,
        stopLossPct: profile.stopLossPct,
        takeProfitPct: profile.takeProfitPct,
      },
    })
  }
  writeMicrostructurePositionState(
    nextMicrostructurePositionState(previousPositionState, nextPositionStateEntries),
    { expectedGeneration: previousPositionState.generation },
  )

  await saveRuntimeReport({
    generatedAt: new Date().toISOString(),
    status: profileReports.some(profile => profile.executedTrades.length > 0) ? 'traded' : 'no_signal',
    universeSize: assetMap.size,
    signalCount: signals.length,
    dataFreshness,
    context: {
      contextGeneration: context.contextGeneration,
      riskMode: context.riskMode,
      newsRiskRegime: context.newsRiskRegime,
      coldStartRoundsRemaining: context.coldStartRoundsRemaining,
      validUntil: context.validUntil,
      bannedSymbols: context.bannedSymbols,
    },
    systemFuse: fuse,
    signals,
    profiles: profileReports,
    notes: [
      'paper-only 1s microstructure stress lane',
      '10x and 100x are local virtual accounts only',
      'no exchange leverage or live-money execution is changed',
    ],
  })
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
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
      i++
    } else {
      out.set(withoutPrefix, 'true')
    }
  }
  return out
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error(`Invalid boolean value: ${value}`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
