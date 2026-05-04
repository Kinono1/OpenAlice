/**
 * Cross-Sectional Reversal — Paper Trading Engine.
 *
 * Flow:
 *   1. Analyze recent news → if severe risk, skip all trading
 *   2. Load best config from optimization results
 *   3. Compute cross-sectional reversal signals on latest market data
 *   4. Filter signals by news risk regime
 *   5. Execute paper trades (open/close positions)
 *   6. Track PnL, log trades, report daily
 *
 * Trading rhythm: checks signals daily, holds 48h.
 * NOT a high-frequency strategy. 5-day lookback, 2-day forward.
 *
 * Usage: npx tsx scripts/paper_trade_cross_sectional.ts
 */

import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateCrossSectionalMomentum } from '../src/domain/strategy/cross-sectional-momentum.js'
import type { CrossSectionalAsset, CrossSectionalConfig } from '../src/domain/strategy/cross-sectional-momentum.js'
import { fetchLiveFundingRate } from '../src/domain/market-data/live-fetcher.js'
import { runGovernanceContextAgent } from '../src/runtime/governance-context-agent.js'
import { analyzeNewsImpact } from '../src/runtime/news_impact.js'
import type { NewsItem, NewsImpactSummary } from '../src/runtime/news_impact.js'
import { collectSocialSignals, combineNewsAndSocialRisk } from '../src/domain/news/social-signals.js'
import { describeQuantLlmModel, resolveQuantLlmModel } from '../src/runtime/llm_model_routing.js'
import {
  isMarketIntelSymbolBanned,
  readMarketIntelContext,
  type MarketIntelContext,
} from '../src/runtime/market_intel_context.js'
import {
  buildPaperOpenContextSnapshot,
  paperOpenContextAcceptRejectReasons,
} from '../src/runtime/paper_open_context.js'
import { readSystemFuse, type SystemFuseState } from '../src/runtime/system_fuse.js'
import {
  evaluateCandleDataQuality,
  type CandleDataQualityReport,
} from '../src/runtime/data_quality_gate.js'
import {
  defaultPaperUniverseSymbols,
  paperSymbolToCsvFile,
} from './lib/paper_universe.js'
import {
  evaluatePromotionReadinessForPaperOrders,
  type PromotionReadinessV2,
} from '../src/runtime/promotion_v2.js'
import {
  DEFAULT_PROMOTION_READINESS_V2_PATH,
  tryLoadPromotionReadinessV2,
  tryLoadValidatedPromotionReadinessV2,
  type PromotionReadinessV2LoadResult,
  type PromotionReadinessV2ValidatedLoadResult,
} from '../src/runtime/promotion_v2_artifacts.js'
import {
  appendPaperTradeResult,
  assertCompletePredictedOpenEvidenceRecord,
  buildPaperTradeCostEvidence,
  buildPaperTradeMfeMaeEvidence,
  buildPaperTradePredictedOpenEvidence,
  withPaperTradeContextCoverage,
  type PaperTradeCloseReason,
  type PaperTradeResult,
} from '../src/runtime/paper_trade_result.js'
import {
  appendPaperPolicyShadowOpen,
  buildPaperPolicyShadowId,
  type AppendPaperPolicyShadowResult,
} from '../src/runtime/paper_policy_shadow_ledger.js'
import {
  DEFAULT_PAPER_MARK_MATCH_FALLBACK_PENALTY_BPS,
  resolvePaperMarkMatchOpenFields,
  type PaperMarkMatchOpenFields,
} from './lib/paper_mark_match.js'

const PAPER_TRADER_LOCK_DIR = 'data/runtime/locks/paper_trade_cross_sectional.shared.lock'

// ==================== Data Layer ====================

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
type PaperTradePathCandle = { timestamp: number; high: number; low: number; close?: number }

async function loadCandles(path: string): Promise<Candle[]> {
  const raw = await readFile(path, 'utf-8')
  const lines = raw.trim().split('\n')
  const h = lines[0].split(',')
  const ti = h.indexOf('timestamp'); const oi = h.indexOf('open'); const hi = h.indexOf('high')
  const li = h.indexOf('low'); const ci = h.indexOf('close'); const vi = h.indexOf('volume')
  return lines.slice(1).map(l => {
    const c = l.split(',')
    return {
      time: Number(c[ti]),
      open: Number(c[oi]),
      high: Number(c[hi]),
      low: Number(c[li]),
      close: Number(c[ci]),
      volume: Number(c[vi]),
    }
  })
    .filter(c => c.time > 0 && [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite))
    .sort((a, b) => a.time - b.time)
}

function computeVol(candles: Candle[], index: number, lookback: number): number {
  const start = Math.max(0, index - lookback)
  const returns: number[] = []
  for (let i = start + 1; i <= index; i++) {
    if (candles[i - 1].close > 0) returns.push(candles[i].close / candles[i - 1].close - 1)
  }
  if (returns.length < 2) return 50
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
  return Math.sqrt(variance * 365 * 24) * 100
}

// ==================== Paper Account ====================

export interface PaperPosition {
  symbol: string
  direction: 'long' | 'short'
  entryPrice: number
  quantity: number
  entryTime: string
  signalConfidence: number
  accountId?: string
  leverage?: number
  marginUsd?: number
  notionalUsd?: number
  liquidationMovePctApprox?: number
  contextSnapshotId?: string
  decisionTime?: string
  marketDataWatermarkAtDecisionTime?: string
  watermark?: string
  featuresAvailableAtDecisionTime?: boolean
  featureSchemaVersion?: string
  contextGenerationAtOpen?: number
  flashEpochAtOpen?: number
  proEpochAtOpen?: number
  flashConfidenceLowAtOpen?: number | null
  ruleScoreAtOpen?: number
  marketIntelTriggerAtOpen?: string | null
  contextStatus?: string
  flashContextStatus?: string
  contextReason?: string | null
  rankAtOpen?: number | null
  rankSpreadPctAtOpen?: number | null
  estimatedRoundTripCostPctAtOpen?: number
  estimatedRoundTripCostPctOfMarginAtOpen?: number
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
  signalConfidenceAtOpen?: number
}

export interface PaperTrade {
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
  accountId?: string
  accountLabel?: string
  leverage?: number
  marginUsd?: number
  notionalUsd?: number
  liquidationMovePctApprox?: number
  liquidated?: boolean
  contextSnapshotId?: string
  decisionTime?: string
  marketDataWatermarkAtDecisionTime?: string
  watermark?: string
  featuresAvailableAtDecisionTime?: boolean
  featureSchemaVersion?: string
  contextGenerationAtOpen?: number
  flashEpochAtOpen?: number
  proEpochAtOpen?: number
  flashConfidenceLowAtOpen?: number | null
  ruleScoreAtOpen?: number
  marketIntelTriggerAtOpen?: string | null
  contextStatus?: string
  flashContextStatus?: string
  contextReason?: string | null
  rankAtOpen?: number | null
  rankSpreadPctAtOpen?: number | null
  estimatedRoundTripCostPctAtOpen?: number
  estimatedRoundTripCostPctOfMarginAtOpen?: number
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
  signalConfidenceAtOpen?: number
}

export interface PaperAccount {
  equity: number
  initialEquity: number
  positions: PaperPosition[]
  tradeHistory: PaperTrade[]
  dailyPnL: Array<{ date: string; pnl: number; pnlPct: number }>
}

interface PaperCostModel {
  feeRate: number
  slippageBps: number
  fundingRatePer8h: number
  expectedHoldingHours: number
}

export type PaperAccountMode = 'paper_trade' | 'stress_only'
export type PaperProfileCadence = 'hourly' | 'minute' | 'second'
export type PaperProfileTimeframe = '1h' | '5m' | '1s'
export type PaperProfileStrategyLane = 'cross_sectional' | 'volume_breakout' | 'microstructure_stress'

export interface PaperAccountProfile {
  id: string
  label: string
  initialEquity: number
  leverage: number
  maxPositionFraction: number
  mode: PaperAccountMode
  cadence: PaperProfileCadence
  timeframe: PaperProfileTimeframe
  strategyLane: PaperProfileStrategyLane
  minDecisionIntervalMs: number
}

export type PaperProfileStatus = 'blocked' | 'no_signal' | 'traded' | 'updated_positions' | 'stress_only'

export interface PaperAccountSnapshot {
  equity: number
  initialEquity: number
  openPositions: number
  totalTrades: number
  dailyPnl: number
  dailyPnlPct: number
}

export type PaperDataMode = 'auto' | 'live_only'

export interface PaperTraderCliArgs {
  dataMode: PaperDataMode
  requirePromotionV2: boolean
  validatePromotionV2Artifacts: boolean
  promotionReadinessV2Path: string | null
  skipSecondLevel: boolean
  allocatorShadow: boolean
  dryRun: boolean
}

export interface BestConfigEvidence {
  avgSpreadPct: number | null
  winRatePct: number | null
  signals: number | null
  score: number | null
  discoveredAt: string | null
  dataRange: { start: string | null; end: string | null } | null
  assetCount: number | null
}

interface BestConfigLoadResult {
  strategyConfig: CrossSectionalConfig
  evidence: BestConfigEvidence
}

export interface LoadedAssetData {
  symbol: string
  source: 'live_accumulated' | 'multi_assets'
  path: string
  candles: Candle[]
  dataQuality: CandleDataQualityReport
}

export interface AssetSelectionResult {
  selected: LoadedAssetData | null
  blockReason: string | null
  fallbackUsed: boolean
}

export interface ProposedPaperOrder {
  symbol: string
  direction: 'long' | 'short'
  price: number
  accountId?: string
  accountLabel?: string
  accountMode?: PaperAccountMode
  cadence?: PaperProfileCadence
  timeframe?: PaperProfileTimeframe
  strategyLane?: PaperProfileStrategyLane
  leverage?: number
  marginUsd?: number
  notionalUsd: number
  quantity: number
  confidence: number
  reason: string
  rejectReason?: string
  rankAtOpen: number | null
  rankSpreadPctAtOpen: number | null
  estimatedRoundTripCostPct: number
  estimatedRoundTripCostUsd: number
  estimatedRoundTripCostPctOfMargin?: number
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
  liquidationMovePctApprox?: number
  wouldLiquidate?: boolean
  shadowAppendResult?: AppendPaperPolicyShadowResult
}

export interface PromotionReadiness {
  ready: boolean
  reasons: string[]
  grossAvgSpreadPct: number | null
  estimatedRoundTripCostPct: number
  netEdgePct: number | null
  minNetEdgePct: number
  grossToCostRatio: number | null
  minGrossToCostRatio: number
  requiresLiveOnlyEvidence: boolean
  dataMode: PaperDataMode
  liveOnlyBarsAvailable: number
  requiredBars: number | null
  liveOnlyAssetsGood: number
  liveOnlyAssetsRequired: number
  paperDaysObserved: number
  paperDaysRequired: number
  paperTradesObserved: number
  paperTradesRequired: number
  releaseGateAllowsPaperTrading: boolean | null
}

export interface PaperDecisionReport {
  generatedAt: string
  status: 'blocked' | 'no_signal' | 'traded' | 'updated_positions'
  dataMode: PaperDataMode
  requiredBars: number | null
  blockReasons: string[]
  bestConfig: CrossSectionalConfig | null
  bestConfigEvidence: BestConfigEvidence | null
  dataQuality: Array<CandleDataQualityReport & { source: string; path: string }>
  liveDataQuality: Array<CandleDataQualityReport & { source: string; path: string }>
  newsGate: {
    allowTrading: boolean
    riskRegime: string
    exposureMultiplier: number
    flags: string[]
    highRiskNews?: number
    riskScore?: number
  } | null
  combinedRisk: ReturnType<typeof combineNewsAndSocialRisk> | null
 marketIntelContext: {
    contextGeneration: number
    riskMode: MarketIntelContext['riskMode']
    newsRiskRegime: MarketIntelContext['newsRiskRegime']
    validUntil: string
    coldStartRoundsRemaining: number
    bannedSymbols: string[]
    blockReasons: string[]
  } | null
  systemFuse: Pick<SystemFuseState, 'status' | 'reason' | 'generation' | 'heartbeatAgeMs'> | null
  llmGovernance: {
    enabled: boolean
    lane: 'regular'
    provider: string | null
    model: string | null
    baseUrl: string | null
    contextWindowTokens: number | null
    status: 'not_run' | 'applied' | 'unavailable'
    action: string | null
    macroRegime: string | null
    confidenceScore: number | null
    reasoning: string | null
    appliedExposureCap: number | null
    error: string | null
  }
  exposureMultiplier: number
  costModel: PaperCostModel
  estimatedRoundTripCostPct: number
  promotionReadiness: PromotionReadiness
  promotionV2: {
    required: boolean
    path: string | null
    loadStatus: 'provided' | 'not_requested' | PromotionReadinessV2LoadResult['kind'] | PromotionReadinessV2ValidatedLoadResult['kind']
    finalVerdict?: PromotionReadinessV2['finalVerdict']
    error?: string
    validationHardBlocks?: string[]
  }
  signals: Array<{
    symbol: string
    signal: number
    confidence: number
    rank: number
    reason: string
    currentPrice: number | null
  }>
  proposedOrders: ProposedPaperOrder[]
  executedTrades: PaperTrade[]
  accountSnapshot: PaperAccountSnapshot | null
  multiAccount: {
    enabled: boolean
    profiles: PaperAccountProfileReport[]
  }
  notes: string[]
}

export interface PaperAccountProfileReport {
  id: string
  label: string
  mode: PaperAccountMode
  cadence: PaperProfileCadence
  timeframe: PaperProfileTimeframe
  strategyLane: PaperProfileStrategyLane
  minDecisionIntervalMs: number
  leverage: number
  maxPositionFraction: number
  status: PaperProfileStatus
  proposedOrders: ProposedPaperOrder[]
  rejectedOrders: ProposedPaperOrder[]
  executedTrades: PaperTrade[]
  accountSnapshot: PaperAccountSnapshot | null
  risk: {
    liquidationMovePctApprox: number
    estimatedRoundTripCostPctOfMargin: number
    notes: string[]
  }
}

// ==================== News Analysis ====================

async function loadRecentNews(): Promise<NewsItem[]> {
  const newsPath = join(import.meta.dirname ?? '.', '..', 'data', 'news-collector', 'news.jsonl')
  try {
    const raw = await readFile(newsPath, 'utf-8')
    const now = Date.now()
    const recentMs = 24 * 3600_000 // last 24 hours
    return raw.trim().split('\n').map(line => {
      try {
        const item = JSON.parse(line)
        return {
          title: item.title ?? '',
          content: item.content ?? '',
          time: new Date(item.pubTs ?? item.ts ?? now),
          source: item.metadata?.source ?? 'unknown',
        } satisfies NewsItem
      } catch { return null }
    }).filter((item): item is NewsItem =>
      item !== null && item.time.getTime() > now - recentMs,
    )
  } catch {
    return []
  }
}

function evaluateNewsGate(news: NewsItem[]): {
  allowTrading: boolean
  riskRegime: string
  exposureMultiplier: number
  flags: string[]
  summary: NewsImpactSummary
} {
  const summary = analyzeNewsImpact(news, { maxFlags: 5 })
  const overlay = summary.overlay

  if (!overlay) {
    return { allowTrading: true, riskRegime: 'normal', exposureMultiplier: 1.0, flags: [], summary }
  }

  // Severe risk → hard block
  if (overlay.hardVeto || overlay.riskRegime === 'severe') {
    return {
      allowTrading: false,
      riskRegime: overlay.riskRegime,
      exposureMultiplier: 0,
      flags: overlay.reasons,
      summary,
    }
  }

  // Elevated risk → reduce position
  if (overlay.riskRegime === 'elevated') {
    return {
      allowTrading: true,
      riskRegime: overlay.riskRegime,
      exposureMultiplier: overlay.exposureMultiplier,
      flags: overlay.reasons,
      summary,
    }
  }

  return { allowTrading: true, riskRegime: 'normal', exposureMultiplier: 1.0, flags: [], summary }
}

// ==================== Paper Trading Engine ====================

interface PaperTradingConfig {
  equity: number
  maxPositionFraction: number
  minConfidence: number
  minLiveUniverseSize: number
  dataDir: string
  outputDir: string
  symbols: string[]
}

const DEFAULT_CONFIG: PaperTradingConfig = {
  equity: 100_000,
  maxPositionFraction: 0.15,
  minConfidence: 0.3,
  minLiveUniverseSize: 20,
  dataDir: join(import.meta.dirname ?? '.', '..', 'data', 'market', 'multi_assets'),
  outputDir: join(import.meta.dirname ?? '.', '..', 'data', 'paper_trading'),
  symbols: defaultPaperUniverseSymbols(),
}

const DEFAULT_PAPER_ACCOUNT_PROFILES: PaperAccountProfile[] = [
  {
    id: 'spot_1x',
    label: 'Spot 1x baseline',
    initialEquity: DEFAULT_CONFIG.equity,
    leverage: 1,
    maxPositionFraction: 0.15,
    mode: 'paper_trade',
    cadence: 'minute',
    timeframe: '5m',
    strategyLane: 'volume_breakout',
    minDecisionIntervalMs: 5 * 60_000,
  },
  {
    id: 'conservative_3x',
    label: 'Conservative 3x',
    initialEquity: DEFAULT_CONFIG.equity,
    leverage: 3,
    maxPositionFraction: 0.07,
    mode: 'paper_trade',
    cadence: 'minute',
    timeframe: '5m',
    strategyLane: 'volume_breakout',
    minDecisionIntervalMs: 5 * 60_000,
  },
  {
    id: 'stress_10x',
    label: 'Stress 10x',
    initialEquity: DEFAULT_CONFIG.equity,
    leverage: 10,
    maxPositionFraction: 0.03,
    mode: 'paper_trade',
    cadence: 'second',
    timeframe: '1s',
    strategyLane: 'microstructure_stress',
    minDecisionIntervalMs: 1_000,
  },
  {
    id: 'liquidation_probe_100x',
    label: 'Liquidation probe 100x',
    initialEquity: DEFAULT_CONFIG.equity,
    leverage: 100,
    maxPositionFraction: 0.005,
    mode: 'stress_only',
    cadence: 'second',
    timeframe: '1s',
    strategyLane: 'microstructure_stress',
    minDecisionIntervalMs: 1_000,
  },
]

export function defaultPaperAccountProfiles(options: { includeSecondLevel?: boolean } = {}): PaperAccountProfile[] {
  const includeSecondLevel = options.includeSecondLevel ?? true
  return DEFAULT_PAPER_ACCOUNT_PROFILES
    .filter(profile => includeSecondLevel || profile.timeframe !== '1s')
    .map(profile => ({ ...profile }))
}

const PAPER_COST_MODEL: PaperCostModel = {
  feeRate: 0.0006,
  slippageBps: 8,
  fundingRatePer8h: 0,
  expectedHoldingHours: 48,
}
const PAPER_STALE_MARK_MATCH_PENALTY_BPS = DEFAULT_PAPER_MARK_MATCH_FALLBACK_PENALTY_BPS

const DATA_MAX_STALENESS_MS = 6 * 3_600_000

async function loadBestConfig(): Promise<BestConfigLoadResult | null> {
  try {
    const bestPath = join(import.meta.dirname ?? '.', '..', 'data', 'research', 'best_config.json')
    const raw = await readFile(bestPath, 'utf-8')
    const best = JSON.parse(raw)
    const cfg = isRecord(best.config) ? best.config : {}
    return {
      strategyConfig: {
        lookbackHours: readNumber(cfg.lookbackHours),
        secondaryLookbackHours: readNumber(cfg.secondaryLookback),
        topN: 1,
        bottomN: 1,
        minUniverseSize: 2,
        maxVolPercentile: readNumber(cfg.maxVolPct) !== undefined ? readNumber(cfg.maxVolPct)! / 100 : undefined,
        minSpreadPct: readNumber(cfg.minSpreadPct),
        mtfWeight: readNumber(cfg.mtfWeight),
        maxPositionFraction: 0.15,
      },
      evidence: {
        avgSpreadPct: readNumber(cfg.avgSpread) ?? null,
        winRatePct: readNumber(cfg.winRate) ?? null,
        signals: readNumber(cfg.signals) ?? null,
        score: readNumber(cfg.score) ?? null,
        discoveredAt: readString(best.discoveredAt) ?? null,
        dataRange: isRecord(best.dataRange)
          ? {
            start: readString(best.dataRange.start) ?? null,
            end: readString(best.dataRange.end) ?? null,
          }
          : null,
        assetCount: readNumber(best.assetCount) ?? null,
      },
    }
  } catch {
    return null
  }
}

function paperTradingDir(): string {
  return join(import.meta.dirname ?? '.', '..', 'data', 'paper_trading')
}

function legacyAccountPath(): string {
  return join(paperTradingDir(), 'account.json')
}

function legacyTradeLogPath(): string {
  return join(paperTradingDir(), 'trade_log.jsonl')
}

function accountProfileDir(profile: Pick<PaperAccountProfile, 'id'>): string {
  return join(paperTradingDir(), 'accounts', profile.id)
}

function accountProfilePath(profile: Pick<PaperAccountProfile, 'id'>): string {
  return join(accountProfileDir(profile), 'account.json')
}

function accountProfileTradeLogPath(profile: Pick<PaperAccountProfile, 'id'>): string {
  return join(accountProfileDir(profile), 'trade_log.jsonl')
}

function createEmptyAccount(initialEquity: number): PaperAccount {
  return { equity: initialEquity, initialEquity, positions: [], tradeHistory: [], dailyPnL: [] }
}

function normalizeAccount(raw: unknown, initialEquity: number): PaperAccount {
  if (!isRecord(raw)) return createEmptyAccount(initialEquity)
  const equity = readNumber(raw.equity) ?? initialEquity
  const existingInitialEquity = readNumber(raw.initialEquity) ?? initialEquity
  return {
    equity,
    initialEquity: existingInitialEquity,
    positions: Array.isArray(raw.positions)
      ? raw.positions.filter(isRecord).map(position => position as unknown as PaperPosition)
      : [],
    tradeHistory: Array.isArray(raw.tradeHistory)
      ? raw.tradeHistory.filter(isRecord).map(trade => trade as unknown as PaperTrade)
      : [],
    dailyPnL: Array.isArray(raw.dailyPnL)
      ? raw.dailyPnL.filter(isRecord).map(item => ({
        date: readString(item.date) ?? 'unknown',
        pnl: readNumber(item.pnl) ?? 0,
        pnlPct: readNumber(item.pnlPct) ?? 0,
      }))
      : [],
  }
}

function readAccountFromPath(path: string, initialEquity: number): PaperAccount | null {
  try {
    const raw = readFileSync(path, 'utf-8')
    return normalizeAccount(JSON.parse(raw), initialEquity)
  } catch {
    return null
  }
}

function loadAccount(): PaperAccount {
  return readAccountFromPath(legacyAccountPath(), DEFAULT_CONFIG.equity) ?? createEmptyAccount(DEFAULT_CONFIG.equity)
}

export function loadPaperAccount(profile: PaperAccountProfile): PaperAccount {
  if (profile.mode === 'stress_only') return createEmptyAccount(profile.initialEquity)
  const profileAccount = readAccountFromPath(accountProfilePath(profile), profile.initialEquity)
  if (profileAccount) return profileAccount
  if (profile.id === 'spot_1x') return loadAccount()
  return createEmptyAccount(profile.initialEquity)
}

async function saveAccount(account: PaperAccount): Promise<void> {
  const dir = paperTradingDir()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'account.json'), JSON.stringify(account, null, 2))
}

async function saveTradeLog(trade: PaperTrade): Promise<void> {
  const dir = paperTradingDir()
  await mkdir(dir, { recursive: true })
  const line = JSON.stringify(trade) + '\n'
  await appendFile(legacyTradeLogPath(), line)
}

async function savePaperAccount(profile: Pick<PaperAccountProfile, 'id' | 'mode'>, account: PaperAccount): Promise<void> {
  if (profile.mode === 'stress_only') return
  const dir = accountProfileDir(profile)
  await mkdir(dir, { recursive: true })
  await writeFile(accountProfilePath(profile), JSON.stringify(account, null, 2))
  if (profile.id === 'spot_1x') {
    await saveAccount(account)
  }
}

async function saveProfileTradeLog(profile: Pick<PaperAccountProfile, 'id' | 'mode'>, trade: PaperTrade): Promise<void> {
  if (profile.mode === 'stress_only') return
  const dir = accountProfileDir(profile)
  await mkdir(dir, { recursive: true })
  const line = JSON.stringify(trade) + '\n'
  await appendFile(accountProfileTradeLogPath(profile), line)
  if (profile.id === 'spot_1x') {
    await saveTradeLog(trade)
  }
}

async function saveDecisionReport(report: PaperDecisionReport): Promise<void> {
  const dir = join(import.meta.dirname ?? '.', '..', 'data', 'runtime')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'paper_decision.latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
}

function createDecisionReport(now: Date, args: PaperTraderCliArgs): PaperDecisionReport {
  const estimatedRoundTripCostPct = estimateRoundTripCostPct(PAPER_COST_MODEL)
  const profiles = defaultPaperAccountProfiles({ includeSecondLevel: !args.skipSecondLevel })
  return {
    generatedAt: now.toISOString(),
    status: 'blocked',
    dataMode: args.dataMode,
    requiredBars: null,
    blockReasons: [],
    bestConfig: null,
    bestConfigEvidence: null,
    dataQuality: [],
    liveDataQuality: [],
    newsGate: null,
    combinedRisk: null,
    marketIntelContext: null,
    systemFuse: null,
    llmGovernance: {
      enabled: false,
      lane: 'regular',
      provider: null,
      model: null,
      baseUrl: null,
      contextWindowTokens: null,
      status: 'not_run',
      action: null,
      macroRegime: null,
      confidenceScore: null,
      reasoning: null,
      appliedExposureCap: null,
      error: null,
    },
    exposureMultiplier: 0,
    costModel: PAPER_COST_MODEL,
    estimatedRoundTripCostPct,
    promotionReadiness: buildPromotionReadiness({
      dataMode: args.dataMode,
      requiredBars: null,
      selectedDataQuality: [],
      liveDataQuality: [],
      bestConfigEvidence: null,
      estimatedRoundTripCostPct,
      account: null,
      combinedRisk: null,
    }),
    promotionV2: {
      required: args.requirePromotionV2,
      path: args.promotionReadinessV2Path,
      loadStatus: 'not_requested',
    },
    signals: [],
    proposedOrders: [],
    executedTrades: [],
    accountSnapshot: null,
    multiAccount: {
      enabled: true,
      profiles: profiles.map(profile => buildProfileReport({
        profile,
        status: 'blocked',
        proposedOrders: [],
        executedTrades: [],
        accountSnapshot: profile.mode === 'paper_trade'
          ? snapshotAccount(createEmptyAccount(profile.initialEquity), 0, 0)
          : null,
      })),
    },
    notes: [
      'paper-only shadow decision report',
      'not approval for live-money trading',
      'data quality, news risk, and release gates remain authoritative',
      'multi-account profiles are local virtual paper accounts only',
    ],
  }
}

function estimateRoundTripCostPct(costModel: PaperCostModel, markMatchPenaltyBps = PAPER_STALE_MARK_MATCH_PENALTY_BPS): number {
  const feeCost = costModel.feeRate * 2
  const slippageCost = (costModel.slippageBps / 10_000) * 2
  const fundingCost = Math.abs(costModel.fundingRatePer8h) * (costModel.expectedHoldingHours / 8)
  const markMatchPenalty = Math.max(0, markMatchPenaltyBps) / 10_000
  return (feeCost + slippageCost + fundingCost + markMatchPenalty) * 100
}

function buildCrossSectionalCostOpenFields(
  estimatedRoundTripCostPct: number,
  matchPrice: number,
  symbol?: string,
  decisionTime?: string | Date | number | null,
  markMatchOpenFields?: PaperMarkMatchOpenFields,
): Pick<
  PaperPosition,
  | 'routeCostBpsAtOpen'
  | 'roundTripCostBpsAtOpen'
  | 'markPriceAtOpen'
  | 'markPriceTimestampAtOpen'
  | 'matchPriceAtOpen'
  | 'matchPriceSourceAtOpen'
  | 'markMatchPenaltyBpsAtOpen'
  | 'markMatchStatusAtOpen'
> {
  const roundTripCostBpsAtOpen = roundSignalQualityNumber(estimatedRoundTripCostPct * 100)
  const markMatch = markMatchOpenFields ?? (symbol
    ? resolvePaperMarkMatchOpenFields({
        symbol,
        decisionTime,
        matchPrice,
        fallbackPenaltyBps: PAPER_STALE_MARK_MATCH_PENALTY_BPS,
      })
    : resolvePaperMarkMatchOpenFields({
        symbol: '',
        decisionTime: null,
        matchPrice,
        fallbackPenaltyBps: PAPER_STALE_MARK_MATCH_PENALTY_BPS,
      })
    )
  return {
    routeCostBpsAtOpen: roundTripCostBpsAtOpen,
    roundTripCostBpsAtOpen,
    ...markMatch,
  }
}

function buildCrossSectionalExpectedEdgeOpenFields(
  rank: MomentumRank,
  estimatedRoundTripCostPct: number,
): Pick<
  PaperPosition,
  | 'expectedGrossEdgePctAtOpen'
  | 'expectedNetEdgePctAtOpen'
  | 'expectedEdgeSourceAtOpen'
> {
  const grossEdge = rankSpreadPctAtOpen(rank)
  const routeCostPct = Number.isFinite(estimatedRoundTripCostPct)
    ? Math.max(0, estimatedRoundTripCostPct)
    : 0
  if (grossEdge == null) {
    return {
      expectedGrossEdgePctAtOpen: 0,
      expectedNetEdgePctAtOpen: roundSignalQualityNumber(-routeCostPct),
      expectedEdgeSourceAtOpen: 'cross_sectional_missing_rank_spread_conservative_zero_edge',
    }
  }
  return {
    expectedGrossEdgePctAtOpen: grossEdge,
    expectedNetEdgePctAtOpen: roundSignalQualityNumber(grossEdge - routeCostPct),
    expectedEdgeSourceAtOpen: 'rank_spread_pct_minus_paper_route_cost',
  }
}

export interface BuildPromotionReadinessInput {
  dataMode: PaperDataMode
  requiredBars: number | null
  selectedDataQuality: Array<CandleDataQualityReport & { source: string }>
  liveDataQuality?: Array<CandleDataQualityReport & { source: string }>
  bestConfigEvidence: BestConfigEvidence | null
  estimatedRoundTripCostPct: number
  account: PaperAccount | null
  combinedRisk: Pick<ReturnType<typeof combineNewsAndSocialRisk>, 'hardVeto' | 'riskRegime'> | null
  minNetEdgePct?: number
  minGrossToCostRatio?: number
  paperDaysRequired?: number
  paperTradesRequired?: number
  liveOnlyAssetsRequired?: number
}

export function buildPromotionReadiness(input: BuildPromotionReadinessInput): PromotionReadiness {
  const minNetEdgePct = input.minNetEdgePct ?? 0.25
  const minGrossToCostRatio = input.minGrossToCostRatio ?? 2
  const paperDaysRequired = input.paperDaysRequired ?? 14
  const paperTradesRequired = input.paperTradesRequired ?? 20
  const liveOnlyAssetsRequired = input.liveOnlyAssetsRequired ?? DEFAULT_CONFIG.minLiveUniverseSize
  const reasons: string[] = []

  const grossAvgSpreadPct = input.bestConfigEvidence?.avgSpreadPct ?? null
  const netEdgePct = grossAvgSpreadPct === null
    ? null
    : grossAvgSpreadPct - input.estimatedRoundTripCostPct
  const grossToCostRatio = grossAvgSpreadPct === null || input.estimatedRoundTripCostPct <= 0
    ? null
    : grossAvgSpreadPct / input.estimatedRoundTripCostPct

  const liveReports = (input.liveDataQuality ?? input.selectedDataQuality)
    .filter((report) => report.source === 'live_accumulated')
  const liveOnlyBarsAvailable = liveReports.length > 0
    ? Math.min(...liveReports.map((report) => report.barCount))
    : 0
  const liveOnlyAssetsGood = liveReports
    .filter((report) => report.state === 'good' && (input.requiredBars === null || report.barCount >= input.requiredBars))
    .length
  const paperDaysObserved = input.account?.dailyPnL.length ?? 0
  const paperTradesObserved = input.account?.tradeHistory
    .filter((trade) => trade.exitTime !== null || trade.exitPrice !== null || trade.pnl !== null)
    .length ?? 0
  const releaseGateAllowsPaperTrading = input.combinedRisk === null
    ? null
    : input.combinedRisk.hardVeto !== true

  if (input.dataMode !== 'live_only') {
    reasons.push('requires_live_only_shadow_mode')
  }
  if (liveReports.length < liveOnlyAssetsRequired) {
    reasons.push(`insufficient_live_only_assets:${liveReports.length}<${liveOnlyAssetsRequired}`)
  }
  if (input.requiredBars !== null && liveOnlyBarsAvailable < input.requiredBars) {
    reasons.push(`insufficient_live_accumulated_history:${liveOnlyBarsAvailable}<${input.requiredBars}`)
  }
  if (liveReports.length >= liveOnlyAssetsRequired && liveOnlyAssetsGood < liveOnlyAssetsRequired) {
    reasons.push(`live_data_quality_not_all_good:${liveOnlyAssetsGood}<${liveOnlyAssetsRequired}`)
  }
  if (grossAvgSpreadPct === null) {
    reasons.push('missing_best_config_edge_metrics')
  } else {
    if (netEdgePct !== null && netEdgePct < minNetEdgePct) {
      reasons.push(`net_edge_below_threshold:${netEdgePct.toFixed(3)}<${minNetEdgePct.toFixed(3)}`)
    }
    if (grossToCostRatio !== null && grossToCostRatio < minGrossToCostRatio) {
      reasons.push(`gross_to_cost_ratio_below_threshold:${grossToCostRatio.toFixed(2)}<${minGrossToCostRatio.toFixed(2)}`)
    }
  }
  if (paperDaysObserved < paperDaysRequired) {
    reasons.push(`insufficient_paper_days:${paperDaysObserved}<${paperDaysRequired}`)
  }
  if (paperTradesObserved < paperTradesRequired) {
    reasons.push(`insufficient_closed_paper_trades:${paperTradesObserved}<${paperTradesRequired}`)
  }
  if (releaseGateAllowsPaperTrading === false) {
    reasons.push(`risk_gate_blocks_paper_trading:${input.combinedRisk?.riskRegime ?? 'unknown'}`)
  }

  return {
    ready: reasons.length === 0,
    reasons,
    grossAvgSpreadPct,
    estimatedRoundTripCostPct: input.estimatedRoundTripCostPct,
    netEdgePct,
    minNetEdgePct,
    grossToCostRatio,
    minGrossToCostRatio,
    requiresLiveOnlyEvidence: true,
    dataMode: input.dataMode,
    liveOnlyBarsAvailable,
    requiredBars: input.requiredBars,
    liveOnlyAssetsGood,
    liveOnlyAssetsRequired,
    paperDaysObserved,
    paperDaysRequired,
    paperTradesObserved,
    paperTradesRequired,
    releaseGateAllowsPaperTrading,
  }
}

function snapshotAccount(
  account: PaperAccount,
  dailyPnl: number,
  dailyPnlPct: number,
): PaperAccountSnapshot {
  return {
    equity: account.equity,
    initialEquity: account.initialEquity,
    openPositions: account.positions.length,
    totalTrades: account.tradeHistory.length,
    dailyPnl,
    dailyPnlPct,
  }
}

async function loadAssetCandidate(input: {
  symbol: string
  path: string
  source: LoadedAssetData['source']
  minBars: number
  now: Date
}): Promise<LoadedAssetData | null> {
  try {
    const candles = await loadCandles(input.path)
    const qualityWindow = candles.slice(-Math.min(candles.length, Math.max(input.minBars, 120)))
    const dataQuality = evaluateCandleDataQuality(input.symbol, qualityWindow, {
      minBars: input.minBars,
      now: input.now,
      maxStalenessMs: DATA_MAX_STALENESS_MS,
    })
    return {
      symbol: input.symbol,
      source: input.source,
      path: input.path,
      candles,
      dataQuality,
    }
  } catch {
    return null
  }
}

function reportDataQuality(assetData: LoadedAssetData[]): PaperDecisionReport['dataQuality'] {
  return assetData.map(asset => ({
    ...asset.dataQuality,
    source: asset.source,
    path: asset.path,
  }))
}

function buildSignalsReport(
  ranks: ReturnType<typeof evaluateCrossSectionalMomentum>,
  csAssets: CrossSectionalAsset[],
): PaperDecisionReport['signals'] {
  return ranks.map(rank => ({
    symbol: rank.symbol,
    signal: rank.signal,
    confidence: rank.confidence,
    rank: rank.rank,
    reason: rank.reason,
    currentPrice: csAssets.find(asset => asset.symbol === rank.symbol)?.currentPrice ?? null,
  }))
}

type MomentumRank = ReturnType<typeof evaluateCrossSectionalMomentum>[number]

interface MarketIntelOpenContextSnapshot {
  contextSnapshotId?: string
  decisionTime?: string
  marketDataWatermarkAtDecisionTime?: string
  watermark?: string
  featuresAvailableAtDecisionTime?: boolean
  featureSchemaVersion?: string
  contextGenerationAtOpen?: number
  flashEpochAtOpen?: number
  proEpochAtOpen?: number
  flashConfidenceLowAtOpen?: number | null
  ruleScoreAtOpen?: number
  marketIntelTriggerAtOpen?: string | null
  contextStatus?: string
  flashContextStatus?: string
  contextReason?: string | null
}

function applyMarketIntelSymbolBlocks(
  ranks: MomentumRank[],
  context: MarketIntelContext,
): MomentumRank[] {
  return ranks.map(rank => {
    if (!isMarketIntelSymbolBanned(context, rank.symbol)) return rank
    return {
      ...rank,
      signal: 0,
      positionFraction: 0,
      confidence: 0,
      reason: `${rank.reason}; market_intel_symbol_blocked`,
    }
  })
}

function liquidationMovePctApprox(leverage: number): number {
  return leverage > 0 ? 100 / leverage : 100
}

function estimatedRoundTripCostPctOfMargin(leverage: number): number {
  return roundSignalQualityNumber(estimateRoundTripCostPct(PAPER_COST_MODEL) * Math.max(leverage, 1))
}

function estimatedRoundTripCostPctOfMarginFromCost(estimatedRoundTripCostPct: number, leverage: number): number {
  return roundSignalQualityNumber(estimatedRoundTripCostPct * Math.max(leverage, 1))
}

function rankAtOpen(rank: MomentumRank): number | null {
  return Number.isFinite(rank.rank) ? rank.rank : null
}

function roundSignalQualityNumber(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function rankSpreadPctAtOpen(rank: MomentumRank): number | null {
  const match = rank.reason.match(/\bspread\s+(-?\d+(?:\.\d+)?)%/i)
  if (!match) return null
  const spreadPct = Number(match[1])
  return Number.isFinite(spreadPct) ? spreadPct : null
}

function buildProfileRiskNotes(profile: PaperAccountProfile): string[] {
  const notes = [
    `${profile.leverage}x is simulated locally only; no exchange leverage is changed`,
    `maxPositionFraction is margin fraction; notional scales by leverage`,
    `cadence=${profile.cadence}, timeframe=${profile.timeframe}, lane=${profile.strategyLane}`,
  ]
  if (profile.cadence === 'minute') {
    notes.push('minute-level profiles use the 5m paper data lane')
  }
  if (profile.cadence === 'second') {
    notes.push('second-level profiles use the 1s paper data or stress-diagnostic lane')
  }
  if (profile.mode === 'stress_only') {
    notes.push('stress_only profile emits diagnostics but never mutates an account or records fills')
  }
  if (profile.leverage >= 50) {
    notes.push('very high leverage profile is for liquidation sensitivity, not tradable promotion evidence')
  }
  return notes
}

function buildProfileReport(input: {
  profile: PaperAccountProfile
  status: PaperProfileStatus
  proposedOrders: ProposedPaperOrder[]
  rejectedOrders?: ProposedPaperOrder[]
  executedTrades: PaperTrade[]
  accountSnapshot: PaperAccountSnapshot | null
}): PaperAccountProfileReport {
  return {
    id: input.profile.id,
    label: input.profile.label,
    mode: input.profile.mode,
    cadence: input.profile.cadence,
    timeframe: input.profile.timeframe,
    strategyLane: input.profile.strategyLane,
    minDecisionIntervalMs: input.profile.minDecisionIntervalMs,
    leverage: input.profile.leverage,
    maxPositionFraction: input.profile.maxPositionFraction,
    status: input.status,
    proposedOrders: input.proposedOrders,
    rejectedOrders: input.rejectedOrders ?? [],
    executedTrades: input.executedTrades,
    accountSnapshot: input.accountSnapshot,
    risk: {
      liquidationMovePctApprox: liquidationMovePctApprox(input.profile.leverage),
      estimatedRoundTripCostPctOfMargin: estimatedRoundTripCostPctOfMargin(input.profile.leverage),
      notes: buildProfileRiskNotes(input.profile),
    },
  }
}

export function buildProfileProposedOrder(
  profile: PaperAccountProfile,
  rank: MomentumRank,
  direction: 'long' | 'short',
  price: number,
  account: PaperAccount,
  exposureMultiplier: number,
  decisionTime?: string | Date | number | null,
): ProposedPaperOrder {
  const marginUsd = account.equity * profile.maxPositionFraction * exposureMultiplier
  const notionalUsd = marginUsd * profile.leverage
  const quantity = notionalUsd / price
  const markMatchOpenFields = resolvePaperMarkMatchOpenFields({
    symbol: rank.symbol,
    decisionTime,
    matchPrice: price,
    fallbackPenaltyBps: PAPER_STALE_MARK_MATCH_PENALTY_BPS,
  })
  const estimatedRoundTripCostPct = roundSignalQualityNumber(estimateRoundTripCostPct(PAPER_COST_MODEL, markMatchOpenFields.markMatchPenaltyBpsAtOpen))
  const costOpenFields = buildCrossSectionalCostOpenFields(
    estimatedRoundTripCostPct,
    price,
    rank.symbol,
    decisionTime,
    markMatchOpenFields,
  )
  const edgeOpenFields = buildCrossSectionalExpectedEdgeOpenFields(rank, estimatedRoundTripCostPct)
  return {
    symbol: rank.symbol,
    direction,
    price,
    accountId: profile.id,
    accountLabel: profile.label,
    accountMode: profile.mode,
    cadence: profile.cadence,
    timeframe: profile.timeframe,
    strategyLane: profile.strategyLane,
    leverage: profile.leverage,
    marginUsd,
    notionalUsd,
    quantity,
    confidence: rank.confidence,
    reason: rank.reason,
    rankAtOpen: rankAtOpen(rank),
    rankSpreadPctAtOpen: rankSpreadPctAtOpen(rank),
    estimatedRoundTripCostPct,
    estimatedRoundTripCostUsd: notionalUsd * estimatedRoundTripCostPct / 100,
    estimatedRoundTripCostPctOfMargin: estimatedRoundTripCostPctOfMarginFromCost(estimatedRoundTripCostPct, profile.leverage),
    ...edgeOpenFields,
    ...costOpenFields,
    liquidationMovePctApprox: liquidationMovePctApprox(profile.leverage),
    wouldLiquidate: false,
  }
}

function buildMarketIntelOpenContextSnapshot(
  context: MarketIntelContext | undefined,
  ruleScore: number,
  now = new Date(),
): MarketIntelOpenContextSnapshot {
  if (!context) return { ruleScoreAtOpen: ruleScore }
  const shared = buildPaperOpenContextSnapshot(context, 'cross_sectional', now)

  return {
    contextSnapshotId: shared.contextSnapshotId,
    decisionTime: shared.decisionTime,
    marketDataWatermarkAtDecisionTime: shared.marketDataWatermarkAtDecisionTime,
    watermark: shared.watermark,
    featuresAvailableAtDecisionTime: shared.featuresAvailableAtDecisionTime,
    featureSchemaVersion: shared.featureSchemaVersion,
    contextGenerationAtOpen: shared.contextGenerationAtOpen,
    flashEpochAtOpen: shared.flashEpochAtOpen,
    proEpochAtOpen: shared.proEpochAtOpen,
    flashConfidenceLowAtOpen: shared.flashConfidenceLowAtOpen,
    ruleScoreAtOpen: ruleScore,
    marketIntelTriggerAtOpen: shared.marketIntelTriggerAtOpen,
    contextStatus: shared.contextStatus,
    flashContextStatus: shared.flashContextStatus,
    contextReason: shared.contextReason,
  }
}

export function recordRejectedCrossSectionalShadowOpenForTest(input: {
  profile: PaperAccountProfile
  order: ProposedPaperOrder
  rejectReason: string
  marketIntelContext?: MarketIntelContext
  now: Date
  fwdHours: number
}): AppendPaperPolicyShadowResult | null {
  return recordRejectedCrossSectionalShadowOpen(input)
}

function recordRejectedCrossSectionalShadowOpen(input: {
  profile: PaperAccountProfile
  order: ProposedPaperOrder
  rejectReason: string
  marketIntelContext?: MarketIntelContext
  now: Date
  fwdHours: number
}): AppendPaperPolicyShadowResult | null {
  const { profile, order, rejectReason, marketIntelContext, now, fwdHours } = input
  if (order.price <= 0) return null
  const lane = inferPaperResultLane(profile)
  const openContext = buildMarketIntelOpenContextSnapshot(marketIntelContext, order.confidence, now)
  const shadowTradeId = [
    'cross_sectional',
    lane,
    order.symbol,
    now.getTime(),
    order.direction,
  ].join(':')
  return appendPaperPolicyShadowOpen({
    counterfactualType: 'trade_level_shadow',
    eventType: 'open',
    shadowId: buildPaperPolicyShadowId({
      tradeId: shadowTradeId,
      shadowPolicyVersion: 'cross_sectional_shadow_v1',
      entryTs: now.getTime(),
      policyId: lane,
    }),
    lane,
    symbol: order.symbol,
    side: order.direction,
    entryPrice: order.price,
    openTs: now.toISOString(),
    openBarTime: now.getTime(),
    horizonMs: Math.max(1, Math.round(fwdHours * 60 * 60 * 1000)),
    notionalUsd: order.notionalUsd ?? null,
    stopLossPrice: null,
    blockReasons: rejectReason.split(';').map(part => part.trim()).filter(Boolean),
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
      ruleScoreAtOpen: openContext.ruleScoreAtOpen,
    },
    quality: {
      rankAtOpen: order.rankAtOpen,
      rankSpreadPctAtOpen: order.rankSpreadPctAtOpen,
      signalConfidenceAtOpen: order.confidence,
    },
	    cost: {
	      estimatedRoundTripCostPctAtOpen: order.estimatedRoundTripCostPct,
	      estimatedRoundTripCostPctOfMarginAtOpen: order.estimatedRoundTripCostPctOfMargin ?? null,
	      expectedGrossEdgePctAtOpen: order.expectedGrossEdgePctAtOpen ?? null,
	      expectedNetEdgePctAtOpen: order.expectedNetEdgePctAtOpen ?? null,
	      expectedEdgeSourceAtOpen: order.expectedEdgeSourceAtOpen ?? null,
	      routeCostBpsAtOpen: order.routeCostBpsAtOpen ?? null,
      roundTripCostBpsAtOpen: order.roundTripCostBpsAtOpen ?? null,
      markPriceAtOpen: order.markPriceAtOpen ?? null,
      markPriceTimestampAtOpen: order.markPriceTimestampAtOpen ?? null,
      matchPriceAtOpen: order.matchPriceAtOpen ?? null,
      matchPriceSourceAtOpen: order.matchPriceSourceAtOpen ?? null,
      markMatchPenaltyBpsAtOpen: order.markMatchPenaltyBpsAtOpen ?? null,
      markMatchStatusAtOpen: order.markMatchStatusAtOpen ?? null,
    },
  })
}

function copyMarketIntelOpenContextFromPosition(pos: PaperPosition): MarketIntelOpenContextSnapshot {
  return {
    contextSnapshotId: pos.contextSnapshotId,
    decisionTime: pos.decisionTime,
    marketDataWatermarkAtDecisionTime: pos.marketDataWatermarkAtDecisionTime,
    watermark: pos.watermark ?? pos.marketDataWatermarkAtDecisionTime,
    featuresAvailableAtDecisionTime: pos.featuresAvailableAtDecisionTime,
    featureSchemaVersion: pos.featureSchemaVersion,
    contextGenerationAtOpen: pos.contextGenerationAtOpen,
    flashEpochAtOpen: pos.flashEpochAtOpen,
    proEpochAtOpen: pos.proEpochAtOpen,
    flashConfidenceLowAtOpen: pos.flashConfidenceLowAtOpen,
    ruleScoreAtOpen: pos.ruleScoreAtOpen,
    marketIntelTriggerAtOpen: pos.marketIntelTriggerAtOpen,
    contextStatus: pos.contextStatus,
    flashContextStatus: pos.flashContextStatus ?? pos.contextStatus,
    contextReason: pos.contextReason,
  }
}

function copySignalQualityOpenFieldsFromPosition(pos: PaperPosition): Pick<
  PaperTrade,
  | 'rankAtOpen'
	  | 'rankSpreadPctAtOpen'
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
  | 'signalConfidenceAtOpen'
> {
	  return {
	    rankAtOpen: pos.rankAtOpen ?? null,
	    rankSpreadPctAtOpen: pos.rankSpreadPctAtOpen ?? null,
	    estimatedRoundTripCostPctAtOpen: pos.estimatedRoundTripCostPctAtOpen,
	    estimatedRoundTripCostPctOfMarginAtOpen: pos.estimatedRoundTripCostPctOfMarginAtOpen,
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
    signalConfidenceAtOpen: pos.signalConfidenceAtOpen ?? pos.signalConfidence,
  }
}

export function assertCompletePredictedOpenEvidenceForTest(
  kind: 'position' | 'trade',
  value: Partial<PaperPosition>,
): void {
  assertCompletePredictedOpenEvidence(kind, value)
}

function assertCompletePredictedOpenEvidence(
  kind: 'position' | 'trade',
  value: Partial<PaperPosition>,
): void {
  assertCompletePredictedOpenEvidenceRecord({
    errorPrefix: 'cross_sectional',
    kind,
    value,
  })
}

export function mapCrossSectionalCloseReason(trade: Pick<PaperTrade, 'reason' | 'liquidated'>): PaperTradeCloseReason {
  const reason = trade.reason.toLowerCase()
  if (trade.liquidated || reason.includes('liquidation')) return 'virtual_liquidation_guard'
  if (reason.includes('marketintel banned symbol') || reason.includes('banned_symbol')) return 'banned_symbol'
  if (reason.includes('holding period expired') || reason.includes('holding_expired')) return 'holding_expired'
  return 'signal'
}

export function buildClosedCrossSectionalPaperTradeResult(input: {
  profile: PaperAccountProfile
  position: PaperPosition
  trade: PaperTrade
  closeReason: PaperTradeCloseReason
  priceSource: PaperTradeResult['priceSource']
  priceStale: boolean
  candles?: PaperTradePathCandle[]
}): PaperTradeResult {
  const { profile, position, trade, closeReason, priceSource, priceStale } = input
  const costAtOpen = copySignalQualityOpenFieldsFromPosition(position)
  const predictedOpenEvidenceInput: Partial<PaperTradeResult> = {
    openTs: trade.entryTime,
    ...costAtOpen,
  }
  return withPaperTradeContextCoverage({
    tradeId: trade.id,
    lane: inferPaperResultLane(profile),
    symbol: trade.symbol,
    leverage: trade.leverage ?? profile.leverage,
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
    ruleScoreAtOpen: position.ruleScoreAtOpen ?? position.signalConfidence ?? null,
    proEpochAtOpen: position.proEpochAtOpen ?? null,
    marketIntelTriggerAtOpen: position.marketIntelTriggerAtOpen ?? null,
    rankAtOpen: position.rankAtOpen ?? null,
    rankSpreadPctAtOpen: position.rankSpreadPctAtOpen ?? null,
    estimatedRoundTripCostPctAtOpen: position.estimatedRoundTripCostPctAtOpen ?? null,
    estimatedRoundTripCostPctOfMarginAtOpen: position.estimatedRoundTripCostPctOfMarginAtOpen ?? null,
    expectedGrossEdgePctAtOpen: position.expectedGrossEdgePctAtOpen ?? null,
    expectedNetEdgePctAtOpen: position.expectedNetEdgePctAtOpen ?? null,
    expectedEdgeSourceAtOpen: position.expectedEdgeSourceAtOpen ?? null,
    routeCostBpsAtOpen: position.routeCostBpsAtOpen ?? null,
    roundTripCostBpsAtOpen: position.roundTripCostBpsAtOpen ?? null,
    markPriceAtOpen: position.markPriceAtOpen ?? null,
    markPriceTimestampAtOpen: position.markPriceTimestampAtOpen ?? null,
    matchPriceAtOpen: position.matchPriceAtOpen ?? null,
    matchPriceSourceAtOpen: position.matchPriceSourceAtOpen ?? null,
    markMatchPenaltyBpsAtOpen: position.markMatchPenaltyBpsAtOpen ?? null,
    markMatchStatusAtOpen: position.markMatchStatusAtOpen ?? null,
    signalConfidenceAtOpen: position.signalConfidenceAtOpen ?? position.signalConfidence ?? null,
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

function inferPaperResultLane(profile: PaperAccountProfile): string {
  if (profile.id === 'liquidation_probe_100x') return 'cross_sectional_100x'
  if (profile.id === 'stress_10x') return 'cross_sectional_10x'
  return 'cross_sectional'
}

function currentPriceForSymbol(csAssets: CrossSectionalAsset[], symbol: string, fallback: number): number {
  return csAssets.find(asset => asset.symbol === symbol)?.currentPrice ?? fallback
}

function priceReturnForPosition(pos: PaperPosition, currentPrice: number): number {
  return pos.direction === 'long'
    ? (currentPrice - pos.entryPrice) / pos.entryPrice
    : (pos.entryPrice - currentPrice) / pos.entryPrice
}

function positionNotionalUsd(pos: PaperPosition): number {
  return pos.notionalUsd ?? pos.quantity * pos.entryPrice
}

function positionMarginUsd(pos: PaperPosition, profile: PaperAccountProfile): number {
  return pos.marginUsd ?? positionNotionalUsd(pos) / Math.max(pos.leverage ?? profile.leverage, 1)
}

function positionLiquidationMovePct(pos: PaperPosition, profile: PaperAccountProfile): number {
  return pos.liquidationMovePctApprox ?? liquidationMovePctApprox(pos.leverage ?? profile.leverage)
}

function evaluatePositionPnl(
  profile: PaperAccountProfile,
  pos: PaperPosition,
  currentPrice: number,
): {
  priceReturn: number
  rawPnl: number
  pnl: number
  pnlPct: number
  adverseMovePct: number
  wouldLiquidate: boolean
  marginUsd: number
  notionalUsd: number
  liquidationMovePctApprox: number
} {
  const priceReturn = priceReturnForPosition(pos, currentPrice)
  const notionalUsd = positionNotionalUsd(pos)
  const marginUsd = positionMarginUsd(pos, profile)
  const rawPnl = priceReturn * notionalUsd
  const adverseMovePct = Math.max(0, -priceReturn * 100)
  const liquidationMove = positionLiquidationMovePct(pos, profile)
  const wouldLiquidate = profile.leverage > 1 && adverseMovePct >= liquidationMove
  return {
    priceReturn,
    rawPnl,
    pnl: wouldLiquidate ? -Math.abs(marginUsd) : rawPnl,
    pnlPct: priceReturn * 100,
    adverseMovePct,
    wouldLiquidate,
    marginUsd,
    notionalUsd,
    liquidationMovePctApprox: liquidationMove,
  }
}

export interface ApplySignalsToPaperAccountInput {
  profile: PaperAccountProfile
  account: PaperAccount | null
  ranks: MomentumRank[]
  csAssets: CrossSectionalAsset[]
  exposureMultiplier: number
  fwdHours: number
  now: Date
  today: string
  minConfidence?: number
  marketIntelContext?: MarketIntelContext
  allowNewOrders?: boolean
  recordClosedTradeResult?: boolean
  priceSource?: PaperTradeResult['priceSource']
  priceStale?: boolean
  assetCandlesBySymbol?: Map<string, PaperTradePathCandle[]>
}

export interface ApplySignalsToPaperAccountResult {
  profileReport: PaperAccountProfileReport
  account: PaperAccount | null
  closedTrades: PaperTrade[]
}

export function applySignalsToPaperAccount(input: ApplySignalsToPaperAccountInput): ApplySignalsToPaperAccountResult {
  const minConfidence = input.minConfidence ?? DEFAULT_CONFIG.minConfidence
  const longed = input.ranks.filter(rank => rank.signal === 1 && rank.confidence >= minConfidence)
  const shorted = input.ranks.filter(rank => rank.signal === -1 && rank.confidence >= minConfidence)
  const paperAccount = input.account ?? createEmptyAccount(input.profile.initialEquity)

  if (input.profile.mode === 'stress_only') {
    const proposedOrders = [
      ...longed.map(rank => buildProfileProposedOrder(
        input.profile,
        rank,
        'long',
        currentPriceForSymbol(input.csAssets, rank.symbol, 0),
        paperAccount,
        input.exposureMultiplier,
        input.now,
      )),
      ...shorted.map(rank => buildProfileProposedOrder(
        input.profile,
        rank,
        'short',
        currentPriceForSymbol(input.csAssets, rank.symbol, 0),
        paperAccount,
        input.exposureMultiplier,
        input.now,
      )),
    ].filter(order => order.price > 0)

    return {
      account: null,
      closedTrades: [],
      profileReport: buildProfileReport({
        profile: input.profile,
        status: 'stress_only',
        proposedOrders,
        executedTrades: [],
        accountSnapshot: null,
      }),
    }
  }

  const account = paperAccount
  const executedTrades: PaperTrade[] = []
  const closedTrades: PaperTrade[] = []
  const nowMs = input.now.getTime()
  const isoNow = input.now.toISOString()

  for (const pos of [...account.positions]) {
    const entryTime = new Date(pos.entryTime).getTime()
    const holdingHours = (nowMs - entryTime) / 3_600_000
    const currentPrice = currentPriceForSymbol(input.csAssets, pos.symbol, pos.entryPrice)
    const evaluated = evaluatePositionPnl(input.profile, pos, currentPrice)
    const bannedSymbol = input.marketIntelContext
      ? isMarketIntelSymbolBanned(input.marketIntelContext, pos.symbol)
      : false
    const shouldClose = bannedSymbol || holdingHours >= input.fwdHours || evaluated.wouldLiquidate

    if (!shouldClose) continue

    const trade: PaperTrade = {
      id: `${evaluated.wouldLiquidate ? 'liquidate' : bannedSymbol ? 'banned_symbol_close' : 'close'}_${input.profile.id}_${pos.symbol}_${nowMs}`,
      symbol: pos.symbol,
      direction: pos.direction,
      entryPrice: pos.entryPrice,
      exitPrice: currentPrice,
      entryTime: pos.entryTime,
      exitTime: isoNow,
      quantity: pos.quantity,
      pnl: evaluated.pnl,
      pnlPct: evaluated.pnlPct,
      reason: evaluated.wouldLiquidate
        ? `Virtual liquidation threshold reached (${evaluated.adverseMovePct.toFixed(2)}% >= ${evaluated.liquidationMovePctApprox.toFixed(2)}%)`
        : bannedSymbol
          ? 'MarketIntel banned symbol'
          : `Holding period expired (${holdingHours.toFixed(0)}h >= ${input.fwdHours}h)`,
      accountId: input.profile.id,
      accountLabel: input.profile.label,
      leverage: pos.leverage ?? input.profile.leverage,
      marginUsd: evaluated.marginUsd,
      notionalUsd: evaluated.notionalUsd,
      liquidationMovePctApprox: evaluated.liquidationMovePctApprox,
      liquidated: evaluated.wouldLiquidate,
      ...copyMarketIntelOpenContextFromPosition(pos),
      ...copySignalQualityOpenFieldsFromPosition(pos),
    }

    account.equity += evaluated.pnl
    account.tradeHistory.push(trade)
    closedTrades.push(trade)
    executedTrades.push(trade)
    account.positions = account.positions.filter(position => position.symbol !== pos.symbol)
    if (input.recordClosedTradeResult) {
      appendPaperTradeResult(buildClosedCrossSectionalPaperTradeResult({
        profile: input.profile,
        position: pos,
        trade,
        closeReason: mapCrossSectionalCloseReason(trade),
        priceSource: input.priceSource ?? 'last_known',
        priceStale: input.priceStale ?? false,
        candles: input.assetCandlesBySymbol?.get(pos.symbol) ?? [],
      }))
    }
  }

  const proposedOrders = input.allowNewOrders === false
    ? []
    : [
        ...longed
          .filter(long => !account.positions.some(pos => pos.symbol === long.symbol))
          .map(long => buildProfileProposedOrder(
            input.profile,
            long,
            'long',
            currentPriceForSymbol(input.csAssets, long.symbol, 0),
            account,
            input.exposureMultiplier,
            input.now,
          )),
        ...shorted
          .filter(short => !account.positions.some(pos => pos.symbol === short.symbol))
          .map(short => buildProfileProposedOrder(
            input.profile,
            short,
            'short',
            currentPriceForSymbol(input.csAssets, short.symbol, 0),
            account,
            input.exposureMultiplier,
            input.now,
          )),
      ].filter(order => order.price > 0)
  const rejectedOrders: ProposedPaperOrder[] = []

  for (const order of proposedOrders) {
    const openContext = buildMarketIntelOpenContextSnapshot(input.marketIntelContext, order.confidence, input.now)
    const contextRejectReasons = paperOpenContextAcceptRejectReasons(openContext)
    if (contextRejectReasons.length > 0) {
      const rejectReason = contextRejectReasons.join('; ')
      const shadowAppendResult = recordRejectedCrossSectionalShadowOpen({
        profile: input.profile,
        order,
        rejectReason,
        marketIntelContext: input.marketIntelContext,
        now: input.now,
        fwdHours: input.fwdHours,
      })
      rejectedOrders.push({
        ...order,
        rejectReason,
        reason: `${order.reason}; ${rejectReason}`,
        shadowAppendResult: shadowAppendResult ?? undefined,
      })
      continue
    }
    const pos: PaperPosition = {
      symbol: order.symbol,
      direction: order.direction,
      entryPrice: order.price,
      quantity: order.quantity,
      entryTime: isoNow,
      signalConfidence: order.confidence,
      accountId: input.profile.id,
      leverage: input.profile.leverage,
      marginUsd: order.marginUsd,
      notionalUsd: order.notionalUsd,
      liquidationMovePctApprox: order.liquidationMovePctApprox,
      rankAtOpen: order.rankAtOpen,
      rankSpreadPctAtOpen: order.rankSpreadPctAtOpen,
      estimatedRoundTripCostPctAtOpen: order.estimatedRoundTripCostPct,
      estimatedRoundTripCostPctOfMarginAtOpen: order.estimatedRoundTripCostPctOfMargin,
      expectedGrossEdgePctAtOpen: order.expectedGrossEdgePctAtOpen ?? null,
      expectedNetEdgePctAtOpen: order.expectedNetEdgePctAtOpen ?? null,
      expectedEdgeSourceAtOpen: order.expectedEdgeSourceAtOpen ?? null,
      routeCostBpsAtOpen: order.routeCostBpsAtOpen ?? null,
      roundTripCostBpsAtOpen: order.roundTripCostBpsAtOpen ?? null,
      markPriceAtOpen: order.markPriceAtOpen ?? null,
      markPriceTimestampAtOpen: order.markPriceTimestampAtOpen ?? null,
      matchPriceAtOpen: order.matchPriceAtOpen ?? null,
      matchPriceSourceAtOpen: order.matchPriceSourceAtOpen ?? null,
      markMatchPenaltyBpsAtOpen: order.markMatchPenaltyBpsAtOpen ?? null,
      markMatchStatusAtOpen: order.markMatchStatusAtOpen ?? null,
      signalConfidenceAtOpen: order.confidence,
      ...openContext,
    }
    assertCompletePredictedOpenEvidence('position', pos)
    account.positions.push(pos)

    const trade: PaperTrade = {
      id: `open_${input.profile.id}_${order.symbol}_${nowMs}`,
      symbol: order.symbol,
      direction: order.direction,
      entryPrice: order.price,
      exitPrice: null,
      entryTime: isoNow,
      exitTime: null,
      quantity: order.quantity,
      pnl: null,
      pnlPct: null,
      reason: order.reason,
      accountId: input.profile.id,
      accountLabel: input.profile.label,
      leverage: input.profile.leverage,
      marginUsd: order.marginUsd,
      notionalUsd: order.notionalUsd,
      liquidationMovePctApprox: order.liquidationMovePctApprox,
      liquidated: false,
      rankAtOpen: order.rankAtOpen,
      rankSpreadPctAtOpen: order.rankSpreadPctAtOpen,
      estimatedRoundTripCostPctAtOpen: order.estimatedRoundTripCostPct,
      estimatedRoundTripCostPctOfMarginAtOpen: order.estimatedRoundTripCostPctOfMargin,
      expectedGrossEdgePctAtOpen: order.expectedGrossEdgePctAtOpen ?? null,
      expectedNetEdgePctAtOpen: order.expectedNetEdgePctAtOpen ?? null,
      expectedEdgeSourceAtOpen: order.expectedEdgeSourceAtOpen ?? null,
      routeCostBpsAtOpen: order.routeCostBpsAtOpen ?? null,
      roundTripCostBpsAtOpen: order.roundTripCostBpsAtOpen ?? null,
      markPriceAtOpen: order.markPriceAtOpen ?? null,
      markPriceTimestampAtOpen: order.markPriceTimestampAtOpen ?? null,
      matchPriceAtOpen: order.matchPriceAtOpen ?? null,
      matchPriceSourceAtOpen: order.matchPriceSourceAtOpen ?? null,
      markMatchPenaltyBpsAtOpen: order.markMatchPenaltyBpsAtOpen ?? null,
      markMatchStatusAtOpen: order.markMatchStatusAtOpen ?? null,
      signalConfidenceAtOpen: order.confidence,
      ...openContext,
    }
    assertCompletePredictedOpenEvidence('trade', trade)
    account.tradeHistory.push(trade)
    executedTrades.push(trade)
  }

  const dailyPnl = account.positions.reduce((sum, pos) => {
    const currentPrice = currentPriceForSymbol(input.csAssets, pos.symbol, pos.entryPrice)
    return sum + evaluatePositionPnl(input.profile, pos, currentPrice).pnl
  }, 0) + closedTrades.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0)
  const totalPnlPct = (dailyPnl / account.initialEquity) * 100

  const existingDaily = account.dailyPnL.find(item => item.date === input.today)
  if (existingDaily) {
    existingDaily.pnl = dailyPnl
    existingDaily.pnlPct = totalPnlPct
  } else {
    account.dailyPnL.push({ date: input.today, pnl: dailyPnl, pnlPct: totalPnlPct })
  }

  const openedTradeCount = executedTrades.filter(trade => trade.id.startsWith('open_')).length
  const status: PaperProfileStatus = openedTradeCount > 0
    ? 'traded'
    : executedTrades.length > 0
      ? 'updated_positions'
      : 'no_signal'

  return {
    account,
    closedTrades,
    profileReport: buildProfileReport({
      profile: input.profile,
      status,
      proposedOrders,
      rejectedOrders,
      executedTrades,
      accountSnapshot: snapshotAccount(account, dailyPnl, totalPnlPct),
    }),
  }
}

async function applyCloseOnlyForBlockedDataGate(input: {
  decisionReport: PaperDecisionReport
  profileStates: Array<{ profile: PaperAccountProfile; account: PaperAccount | null }>
  assetData: LoadedAssetData[]
  gateReason: string
  fwdHours: number
  now: Date
  today: string
}): Promise<boolean> {
  const paperProfilesWithPositions = input.profileStates.filter(
    state => state.profile.mode === 'paper_trade' && (state.account?.positions.length ?? 0) > 0,
  )
  if (paperProfilesWithPositions.length === 0) return false

  const requiredSymbols = new Set(
    paperProfilesWithPositions.flatMap(state => state.account?.positions.map(pos => pos.symbol) ?? []),
  )
  const usableAssets = input.assetData
    .filter(asset => requiredSymbols.has(asset.symbol) && asset.candles.length > 0)
    .filter(asset => Number.isFinite(asset.candles[asset.candles.length - 1]?.close))
  if (usableAssets.length === 0) return false

  const csAssets = usableAssets.map(asset => {
    const last = asset.candles[asset.candles.length - 1]
    return {
      symbol: asset.symbol,
      currentPrice: last.close,
      returns: { '0h': 0 },
      realizedVolPct: computeVol(asset.candles, asset.candles.length - 1, Math.min(24, asset.candles.length - 1)),
      avgVolume24h: last.volume,
    } satisfies CrossSectionalAsset
  })

  const profileResults = input.profileStates.map(({ profile, account }) => applySignalsToPaperAccount({
    profile,
    account,
    ranks: [],
    csAssets,
    exposureMultiplier: 0,
    fwdHours: input.fwdHours,
    now: input.now,
    today: input.today,
    recordClosedTradeResult: true,
    priceSource: 'last_known',
    priceStale: true,
    assetCandlesBySymbol: new Map(input.assetData.map(asset => [
      asset.symbol,
      asset.candles.map(toPaperTradePathCandle),
    ])),
  }))

  for (const result of profileResults) {
    if (result.account) {
      await savePaperAccount(result.profileReport, result.account)
    }
    for (const trade of result.profileReport.executedTrades) {
      await saveProfileTradeLog(result.profileReport, trade)
    }
  }

  input.decisionReport.multiAccount.profiles = profileResults.map(result => result.profileReport)
  const baselineResult = profileResults.find(result => result.profileReport.id === 'spot_1x') ?? profileResults[0]
  const baselineReport = baselineResult.profileReport
  input.decisionReport.proposedOrders = []
  input.decisionReport.executedTrades = baselineReport.executedTrades
  input.decisionReport.accountSnapshot = baselineReport.accountSnapshot
  input.decisionReport.status = profileResults.some(result => result.profileReport.executedTrades.length > 0)
    ? 'updated_positions'
    : 'blocked'
  input.decisionReport.blockReasons.push(input.gateReason, 'close_only_due_to_data_quality_gate')
  input.decisionReport.notes.push(
    'data quality gate blocked new paper orders but allowed local virtual close/update for existing positions',
    `close_only_assets:${usableAssets.map(asset => asset.symbol).join(',')}`,
  )

  return true
}

async function runRegularLlmGovernance(input: {
  ranks: MomentumRank[]
  decisionReport: PaperDecisionReport
  baselineAccount: PaperAccount | null
  dataQualityState: 'good' | 'degraded' | 'bad' | 'unknown'
  systemAlerts: string[]
}): Promise<PaperDecisionReport['llmGovernance']> {
  const spec = resolveQuantLlmModel('regular')
  const modelInfo = describeQuantLlmModel(spec)
  const base = {
    enabled: true,
    lane: 'regular' as const,
    provider: modelInfo.provider,
    model: modelInfo.model,
    baseUrl: modelInfo.baseUrl ?? null,
    contextWindowTokens: modelInfo.contextWindowTokens,
    status: 'unavailable' as const,
    action: null,
    macroRegime: null,
    confidenceScore: null,
    reasoning: null,
    appliedExposureCap: null,
    error: null,
  }

  const equity = input.baselineAccount?.equity ?? input.baselineAccount?.initialEquity ?? 100_000
  const initialEquity = input.baselineAccount?.initialEquity ?? 100_000
  const recentDrawdown = Math.max(0, (initialEquity - equity) / Math.max(initialEquity, 1))
  const signalSummary = {
    longs: input.ranks.filter(rank => rank.signal === 1).length,
    shorts: input.ranks.filter(rank => rank.signal === -1).length,
    avgConfidence: input.ranks.length > 0
      ? input.ranks.reduce((sum, rank) => sum + rank.confidence, 0) / input.ranks.length
      : 0,
  }

  try {
    const result = await runGovernanceContextAgent({
      currentRegime: input.decisionReport.combinedRisk?.riskRegime ?? 'normal',
      factorICByName: {
        cross_sectional_signal_balance: [
          signalSummary.longs - signalSummary.shorts,
          signalSummary.avgConfidence,
        ],
      },
      dataQualityState: input.dataQualityState,
      recentDrawdown,
      systemAlerts: input.systemAlerts,
    }, spec)

    if (!result) {
      return {
        ...base,
        error: 'regular_llm_governance_unavailable',
      }
    }

    const action = result.override.action
    const exposureCap = action === 'reduce_exposure'
      ? Math.min(0.5, result.override.parameters.volatilityTargetMultiplier ?? 0.5)
      : action === 'increase_caution'
        ? Math.min(0.75, result.override.parameters.volatilityTargetMultiplier ?? 0.75)
        : null

    return {
      ...base,
      status: 'applied',
      action,
      macroRegime: result.override.macroRegime,
      confidenceScore: result.override.confidenceScore,
      reasoning: result.override.reasoning,
      appliedExposureCap: exposureCap,
      error: null,
    }
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function selectAssetDataForMode(input: {
  dataMode: PaperDataMode
  symbol: string
  live: LoadedAssetData | null
  fallback: LoadedAssetData | null
  requiredBars: number
}): AssetSelectionResult {
  if (input.dataMode === 'live_only') {
    return {
      selected: input.live,
      blockReason: input.live && input.live.dataQuality.state === 'good'
        ? null
        : buildLiveOnlyBlockReason(input.symbol, input.live, input.requiredBars),
      fallbackUsed: false,
    }
  }

  const selected = input.live && input.live.dataQuality.state !== 'bad'
    ? input.live
    : input.fallback

  return {
    selected,
    blockReason: null,
    fallbackUsed: selected !== null && selected === input.fallback,
  }
}

function buildLiveOnlyBlockReason(symbol: string, live: LoadedAssetData | null, requiredBars: number): string {
  if (!live) return `live_only_missing:${symbol}`
  const insufficient = live.dataQuality.reasons.find((reason) => reason.startsWith('insufficient_bars:'))
  if (insufficient) {
    return `live_only_insufficient_bars:${symbol}:${insufficient.slice('insufficient_bars:'.length)}`
  }
  if (live.dataQuality.barCount < requiredBars) {
    return `live_only_insufficient_bars:${symbol}:${live.dataQuality.barCount}<${requiredBars}`
  }
  return `live_only_data_quality_${live.dataQuality.state}:${symbol}:${live.dataQuality.reasons.join('|') || 'unknown'}`
}

function countCsvDataRows(path: string): number {
  try {
    return Math.max(0, readFileSync(path, 'utf-8').trim().split('\n').length - 1)
  } catch {
    return 0
  }
}

export function parsePaperTraderArgs(argv: string[]): PaperTraderCliArgs {
  const raw = parseRawArgs(argv)
  const requirePromotionV2 = parseBool(raw.get('requirePromotionV2'), false)
  return {
    dataMode: parseDataMode(raw.get('dataMode'), 'auto'),
    requirePromotionV2,
    validatePromotionV2Artifacts: parseBool(raw.get('validatePromotionV2Artifacts'), requirePromotionV2),
    promotionReadinessV2Path: raw.get('promotionReadinessV2Path') ?? null,
    skipSecondLevel: parseBool(raw.get('skipSecondLevel'), false),
    allocatorShadow: parseBool(raw.get('allocatorShadow'), false),
    dryRun: parseBool(raw.get('dryRun'), true),
  }
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

function parseDataMode(value: string | undefined, fallback: PaperDataMode): PaperDataMode {
  if (value === undefined) return fallback
  if (value === 'auto' || value === 'live_only') return value
  throw new Error(`Invalid dataMode: ${value}. Expected auto or live_only`)
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error(`Invalid boolean value: ${value}`)
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function evaluateMarketIntelBlocks(
  context: MarketIntelContext,
  fuse: SystemFuseState,
): string[] {
  const reasons: string[] = []
  const validUntil = Date.parse(context.validUntil)
  if (fuse.status === 'risk_off') reasons.push(`system_fuse:${fuse.reason ?? 'risk_off'}`)
  if (context.riskMode === 'risk_off') reasons.push('market_intel_risk_off')
  if (context.newsRiskRegime === 'severe') reasons.push('market_intel_severe_news')
  if (!context.semanticValidation.passed) reasons.push('market_intel_semantic_validation_block')
  if (!Number.isFinite(validUntil) || validUntil <= Date.now()) reasons.push('market_intel_context_stale')
  if (context.coldStartRoundsRemaining > 0) reasons.push(`market_intel_cold_start:${context.coldStartRoundsRemaining}`)
  if (context.allowNewPositionsByLane.cross_sectional !== true) reasons.push('market_intel_lane_not_allowed:cross_sectional')
  return reasons
}

export async function resolvePromotionReadinessV2ForPaperTrader(
  args: PaperTraderCliArgs,
  now: Date,
): Promise<{
  readiness: PromotionReadinessV2 | null
  summary: PaperDecisionReport['promotionV2']
}> {
  const shouldLoad = args.requirePromotionV2 || Boolean(args.promotionReadinessV2Path)
  if (!shouldLoad) {
    return {
      readiness: null,
      summary: {
        required: args.requirePromotionV2,
        path: args.promotionReadinessV2Path,
        loadStatus: 'not_requested',
      },
    }
  }

  const path = args.promotionReadinessV2Path ?? DEFAULT_PROMOTION_READINESS_V2_PATH
  const validateArtifacts = args.requirePromotionV2 || args.validatePromotionV2Artifacts
  const result = validateArtifacts
    ? await tryLoadValidatedPromotionReadinessV2(dirname(path), { now })
    : await tryLoadPromotionReadinessV2(path)

  if (result.kind === 'loaded') {
    return {
      readiness: result.readiness,
      summary: {
        required: args.requirePromotionV2,
        path,
        loadStatus: result.kind,
        finalVerdict: result.readiness.finalVerdict,
        validationHardBlocks: 'validation' in result ? result.validation.hardBlocks : undefined,
      },
    }
  }

  return {
    readiness: result.readiness ?? null,
    summary: {
      required: args.requirePromotionV2,
      path,
      loadStatus: result.kind,
      finalVerdict: result.readiness?.finalVerdict,
      error: result.error,
      validationHardBlocks: 'validation' in result ? result.validation?.hardBlocks : undefined,
    },
  }
}

// ==================== Main Trading Logic ====================

export async function main(argv = process.argv.slice(2)) {
  const cliArgs = parsePaperTraderArgs(argv)
  if (cliArgs.dryRun) {
    console.log(JSON.stringify({
      family: 'cross_sectional',
      command: 'paper_trade_cross_sectional',
      executionMode: {
        dryRun: true,
        writesPaperAccounts: false,
        writesPaperTradeResults: false,
        writesShadowLedger: false,
        writesDecisionReport: false,
        placesOrders: false,
      },
      optIn: {
        runPaperMutation: '--dryRun false',
        requirePromotionV2: '--requirePromotionV2 true',
      },
    }, null, 2))
    return
  }
  const runNow = new Date()
  const decisionReport = createDecisionReport(runNow, cliArgs)
  const marketIntelContext = readMarketIntelContext()
  const systemFuse = readSystemFuse()
  const marketIntelBlockReasons = evaluateMarketIntelBlocks(marketIntelContext, systemFuse)
  decisionReport.marketIntelContext = {
    contextGeneration: marketIntelContext.contextGeneration,
    riskMode: marketIntelContext.riskMode,
    newsRiskRegime: marketIntelContext.newsRiskRegime,
    validUntil: marketIntelContext.validUntil,
    coldStartRoundsRemaining: marketIntelContext.coldStartRoundsRemaining,
    bannedSymbols: marketIntelContext.bannedSymbols,
    blockReasons: marketIntelBlockReasons,
  }
  decisionReport.systemFuse = {
    status: systemFuse.status,
    reason: systemFuse.reason,
    generation: systemFuse.generation,
    heartbeatAgeMs: systemFuse.heartbeatAgeMs,
  }
  const profileStates = defaultPaperAccountProfiles({ includeSecondLevel: true })
    .map(profile => ({
      profile,
      account: profile.mode === 'paper_trade' ? loadPaperAccount(profile) : null,
    }))
    .filter(({ profile, account }) => {
      if (!cliArgs.skipSecondLevel || profile.timeframe !== '1s') return true
      return (account?.positions.length ?? 0) > 0
    })
  const baselineProfileState = profileStates.find(state => state.profile.id === 'spot_1x') ?? profileStates[0]
  const baselineAccount = baselineProfileState?.account ?? null
  let bestConfigEvidence: BestConfigEvidence | null = null
  let requiredBars: number | null = null
  const refreshBlockedProfileReports = () => {
    decisionReport.multiAccount.profiles = profileStates.map(({ profile, account }) => buildProfileReport({
      profile,
      status: 'blocked',
      proposedOrders: [],
      executedTrades: [],
      accountSnapshot: account ? snapshotAccount(account, 0, 0) : null,
    }))
    decisionReport.accountSnapshot = decisionReport.multiAccount.profiles
      .find(profile => profile.id === 'spot_1x')
      ?.accountSnapshot ?? null
  }
  const refreshPromotionReadiness = () => {
    decisionReport.promotionReadiness = buildPromotionReadiness({
      dataMode: cliArgs.dataMode,
      requiredBars,
      selectedDataQuality: decisionReport.dataQuality,
      liveDataQuality: decisionReport.liveDataQuality,
      bestConfigEvidence,
      estimatedRoundTripCostPct: decisionReport.estimatedRoundTripCostPct,
      account: baselineAccount,
      combinedRisk: decisionReport.combinedRisk,
    })
  }
  refreshBlockedProfileReports()

  console.log('╔══════════════════════════════════════════╗')
  console.log('║  Cross-Sectional Reversal Paper Trader   ║')
  console.log(`║  ${runNow.toISOString().slice(0, 19)}                     ║`)
  console.log('╚══════════════════════════════════════════╝\n')
  console.log(`Data mode: ${cliArgs.dataMode}\n`)

  // Load config
  const bestConfigLoad = await loadBestConfig()
  if (!bestConfigLoad) {
    console.log('No best config found. Run optimize:cross-sectional first.')
    decisionReport.blockReasons.push('missing_best_config')
    refreshPromotionReadiness()
    await saveDecisionReport(decisionReport)
    return
  }
  const bestConfig = bestConfigLoad.strategyConfig
  bestConfigEvidence = bestConfigLoad.evidence
  decisionReport.bestConfig = bestConfig
  decisionReport.bestConfigEvidence = bestConfigEvidence

  console.log('Best Config:')
  console.log(`  Lookback: ${bestConfig.lookbackHours}h | 2nd: ${bestConfig.secondaryLookbackHours}h`)
  console.log(`  MTF Weight: ${bestConfig.mtfWeight} | Min Spread: ${bestConfig.minSpreadPct}%`)
  console.log(`  Max Vol: ${(bestConfig.maxVolPercentile! * 100).toFixed(0)}%\n`)

  // Load market data — prefer live_accumulated (most recent), fall back to multi_assets
  const liveDir = join(import.meta.dirname ?? '.', '..', 'data', 'market', 'live_accumulated')
  const multiDir = join(import.meta.dirname ?? '.', '..', 'data', 'market', 'multi_assets')
  let lb = bestConfig.lookbackHours ?? 168
  let sec = bestConfig.secondaryLookbackHours ?? lb
  const fwdHours = PAPER_COST_MODEL.expectedHoldingHours
  const today = runNow.toISOString().slice(0, 10)

  // Auto-adjust lookback to fit available live data
  const liveBarCounts = DEFAULT_CONFIG.symbols
    .map(symbol => countCsvDataRows(join(liveDir, paperSymbolToCsvFile(symbol))))
    .filter(count => count > 0)
  const liveBars = liveBarCounts.length > 0 ? Math.min(...liveBarCounts) : 0
  const maxLiveLookback = Math.max(24, liveBars - fwdHours - 10)
  if (liveBars > 0 && (lb > maxLiveLookback || sec > maxLiveLookback)) {
    const origLb = lb; const origSec = sec
    lb = Math.min(lb, maxLiveLookback)
    sec = Math.min(sec, maxLiveLookback)
    console.log(`⚠️  Lookback reduced: ${origLb}h→${lb}h / ${origSec}h→${sec}h (live data has ${liveBars} bars, need ${maxLiveLookback})`)
    // Write reduced config for this run
    bestConfig.lookbackHours = lb
    bestConfig.secondaryLookbackHours = sec
  }

  const requiredBarCount = Math.max(lb, sec, 24) + 2
  requiredBars = requiredBarCount
  decisionReport.requiredBars = requiredBarCount

  const assetData: LoadedAssetData[] = []
  const liveAssetData: LoadedAssetData[] = []
  const liveOnlyBlockReasons: string[] = []
  for (const symbol of DEFAULT_CONFIG.symbols) {
    const fileName = paperSymbolToCsvFile(symbol)
    const live = await loadAssetCandidate({
      symbol,
      path: join(liveDir, fileName),
      source: 'live_accumulated',
      minBars: requiredBarCount,
      now: runNow,
    })
    if (live) liveAssetData.push(live)
    const fallback = cliArgs.dataMode === 'auto' && (!live || live.dataQuality.state === 'bad')
      ? await loadAssetCandidate({
        symbol,
        path: join(multiDir, fileName),
        source: 'multi_assets',
        minBars: requiredBarCount,
        now: runNow,
      })
      : null
    const selection = selectAssetDataForMode({
      dataMode: cliArgs.dataMode,
      symbol,
      live,
      fallback,
      requiredBars: requiredBarCount,
    })
    const selected = selection.selected
    if (selection.blockReason) liveOnlyBlockReasons.push(selection.blockReason)

    if (selected && (cliArgs.dataMode !== 'live_only' || selected.dataQuality.state === 'good')) {
      assetData.push(selected)
      const end = selected.dataQuality.endTime?.slice(0, 16) ?? 'unknown'
      console.log(`Loaded ${symbol}: ${selected.candles.length} bars (${selected.source}, ${selected.dataQuality.state}, end=${end})`)
    } else {
      console.log(`Missing: ${fileName}`)
    }
  }
  decisionReport.dataQuality = reportDataQuality(assetData)
  decisionReport.liveDataQuality = reportDataQuality(liveAssetData)
  refreshPromotionReadiness()

  if (cliArgs.dataMode === 'live_only' && assetData.length < DEFAULT_CONFIG.minLiveUniverseSize) {
    console.log('\nLive-only data gate blocked new paper decisions:')
    console.log(`  insufficient_live_universe:${assetData.length}<${DEFAULT_CONFIG.minLiveUniverseSize}`)
    for (const reason of liveOnlyBlockReasons) {
      console.log(`  ${reason}`)
    }
    const closeOnlyHandled = await applyCloseOnlyForBlockedDataGate({
      decisionReport,
      profileStates,
      assetData: liveAssetData,
      gateReason: `insufficient_live_universe:${assetData.length}<${DEFAULT_CONFIG.minLiveUniverseSize}`,
      fwdHours,
      now: runNow,
      today,
    })
    if (closeOnlyHandled) {
      refreshPromotionReadiness()
      await saveDecisionReport(decisionReport)
      return
    }
    decisionReport.blockReasons.push(
      `insufficient_live_universe:${assetData.length}<${DEFAULT_CONFIG.minLiveUniverseSize}`,
      ...liveOnlyBlockReasons,
    )
    refreshPromotionReadiness()
    await saveDecisionReport(decisionReport)
    return
  }
  if (cliArgs.dataMode === 'live_only' && liveOnlyBlockReasons.length > 0) {
    decisionReport.notes.push(
      `live_universe_partial_coverage:${assetData.length}/${DEFAULT_CONFIG.symbols.length}`,
      ...liveOnlyBlockReasons.slice(0, 20).map(reason => `inactive_asset:${reason}`),
    )
  }

  if (assetData.length < 2) {
    console.log('Need at least 2 assets for cross-sectional. Exiting.')
    const closeOnlyHandled = await applyCloseOnlyForBlockedDataGate({
      decisionReport,
      profileStates,
      assetData: liveAssetData.length > 0 ? liveAssetData : assetData,
      gateReason: `insufficient_assets:${assetData.length}`,
      fwdHours,
      now: runNow,
      today,
    })
    if (closeOnlyHandled) {
      refreshPromotionReadiness()
      await saveDecisionReport(decisionReport)
      return
    }
    decisionReport.blockReasons.push(`insufficient_assets:${assetData.length}`)
    refreshPromotionReadiness()
    await saveDecisionReport(decisionReport)
    return
  }

  const qualityBlocks = assetData.filter(asset => asset.dataQuality.state !== 'good')
  if (qualityBlocks.length > 0) {
    console.log('\nData quality gate blocked new paper decisions:')
    for (const asset of qualityBlocks) {
      console.log(`  ${asset.symbol}: ${asset.dataQuality.state} (${asset.dataQuality.reasons.join(', ') || 'unknown'})`)
    }
    const closeOnlyHandled = await applyCloseOnlyForBlockedDataGate({
      decisionReport,
      profileStates,
      assetData,
      gateReason: `data_quality_blocks:${qualityBlocks.length}`,
      fwdHours,
      now: runNow,
      today,
    })
    if (closeOnlyHandled) {
      refreshPromotionReadiness()
      await saveDecisionReport(decisionReport)
      return
    }
    decisionReport.blockReasons.push(
      ...qualityBlocks.map(asset => `data_quality_${asset.dataQuality.state}:${asset.symbol}:${asset.dataQuality.reasons.join('|') || 'unknown'}`),
    )
    refreshPromotionReadiness()
    await saveDecisionReport(decisionReport)
    return
  }

  if (marketIntelBlockReasons.length > 0 && cliArgs.requirePromotionV2) {
    console.log('\nMarketIntel context blocked new cross-sectional paper decisions:')
    for (const reason of marketIntelBlockReasons) {
      console.log(`  ${reason}`)
    }
    const closeOnlyHandled = await applyCloseOnlyForBlockedDataGate({
      decisionReport,
      profileStates,
      assetData,
      gateReason: `market_intel_blocks:${marketIntelBlockReasons.join('|')}`,
      fwdHours,
      now: runNow,
      today,
    })
    if (closeOnlyHandled) {
      refreshPromotionReadiness()
      await saveDecisionReport(decisionReport)
      return
    }
    decisionReport.blockReasons.push(...marketIntelBlockReasons)
    refreshPromotionReadiness()
    await saveDecisionReport(decisionReport)
    return
  }

  // Get current state: last bar of each asset
  const now = Date.now()
  const minLen = Math.min(...assetData.map(a => a.candles.length))
  const idx = minLen - 1
  if (idx < Math.max(lb, sec)) {
    console.log('Not enough aligned history for current best config. Exiting.')
    decisionReport.blockReasons.push(`insufficient_aligned_history:${idx}<${Math.max(lb, sec)}`)
    refreshPromotionReadiness()
    await saveDecisionReport(decisionReport)
    return
  }

  // Fetch live funding rates for factor overlay
  const fundingRates = new Map<string, number>()
  for (const { symbol } of assetData) {
    try {
      const okxInstId = symbol.replace('-', '-') + '-SWAP'
      const fr = await fetchLiveFundingRate(okxInstId)
      if (fr) fundingRates.set(symbol, fr.fundingRate * 100) // convert decimal to pct
    } catch { /* funding unavailable, will use 0 */ }
  }
  if (fundingRates.size > 0) {
    const entries = [...fundingRates.entries()].map(([s, r]) => `${s}:${r.toFixed(4)}%`).join(' ')
    console.log(`Funding rates (8h): ${entries}`)
  }

  const csAssets: CrossSectionalAsset[] = assetData.map(({ symbol, candles }) => ({
    symbol,
    currentPrice: candles[idx].close,
    returns: {
      [`${lb}h`]: (candles[idx].close / candles[idx - lb].close - 1) * 100,
      [`${sec}h`]: idx >= sec ? (candles[idx].close / candles[idx - sec].close - 1) * 100 : (candles[idx].close / candles[0].close - 1) * 100,
    },
    realizedVolPct: computeVol(candles, idx, 24),
    avgVolume24h: candles[idx].volume,
    fundingRatePct: fundingRates.get(symbol),
  }))

  // ===== News + Social Signals Analysis =====
  console.log('\n--- News & Social Signals ---')

  // Formal news
  const news = await loadRecentNews()
  console.log(`Formal news (24h): ${news.length} items`)
  const newsGate = evaluateNewsGate(news)
  decisionReport.newsGate = {
    allowTrading: newsGate.allowTrading,
    riskRegime: newsGate.riskRegime,
    exposureMultiplier: newsGate.exposureMultiplier,
    flags: newsGate.flags,
    highRiskNews: newsGate.summary.highRiskNews,
    riskScore: newsGate.summary.riskScore,
  }

  // Social signals (Reddit + crypto communities)
  console.log(`Fetching social signals...`)
  let socialResult = { summary: { totalSignals: 0, dominantSentiment: 'neutral' as const, sentimentScore: 0, fudCount: 0, hypeCount: 0, whaleAlertCount: 0, influencerCount: 0, totalSources: 0, topSignals: [] as string[] } }
  try {
    socialResult = await collectSocialSignals({ lookbackHours: 12 })
    console.log(`Social signals (12h): ${socialResult.summary.totalSignals} items from ${socialResult.summary.totalSources} sources`)
    console.log(`  Sentiment: ${socialResult.summary.dominantSentiment} (${socialResult.summary.sentimentScore.toFixed(2)})`)
    console.log(`  FUD: ${socialResult.summary.fudCount} | Hype: ${socialResult.summary.hypeCount} | Whale: ${socialResult.summary.whaleAlertCount} | Influencer: ${socialResult.summary.influencerCount}`)
    if (socialResult.summary.topSignals.length > 0) {
      console.log(`  Top signals: ${socialResult.summary.topSignals.join(', ')}`)
    }
  } catch (err) {
    console.log(`  Social signals unavailable: ${err instanceof Error ? err.message : err}`)
  }

  // Combine formal news + social signals
  const combinedRisk = combineNewsAndSocialRisk(
    newsGate.riskRegime,
    newsGate.riskRegime === 'severe',
    socialResult.summary,
  )
  decisionReport.combinedRisk = combinedRisk
  refreshPromotionReadiness()

  // Use combinedRisk (formal + social) as the authoritative risk signal
  // When social data is unavailable, combinedRisk downgrades severe → elevated
  if (combinedRisk.hardVeto) {
    console.log(`\n🔴 TRADING BLOCKED: ${combinedRisk.riskRegime} risk`)
    console.log(`   Reason: ${combinedRisk.reason}`)
    decisionReport.blockReasons.push(`news_hard_veto:${combinedRisk.reason}`)
    refreshPromotionReadiness()
    await saveDecisionReport(decisionReport)
    return
  } else if (combinedRisk.riskRegime === 'elevated') {
    console.log(`\n⚠️  ELEVATED RISK: trading with 0.5x exposure`)
    console.log(`   Reason: ${combinedRisk.reason}`)
    console.log(`   News flags: ${newsGate.flags.join(', ')}`)
  } else {
    console.log(`\n✅ Risk clear. Trading allowed.`)
  }

  // When risk is elevated (not hard-blocked), use at least 0.25x exposure
  // newsGate.exposureMultiplier may be 0 from formal severe risk that was downgraded
  let exposureMultiplier = combinedRisk.riskRegime === 'elevated'
    ? Math.max(0.25, Math.min(newsGate.exposureMultiplier || 0.5, 0.5))
    : combinedRisk.hardVeto ? 0
    : newsGate.exposureMultiplier || 1.0
  decisionReport.exposureMultiplier = exposureMultiplier

  // Show current returns
  console.log('\nCurrent Returns:')
  for (const a of csAssets) {
    console.log(`  ${a.symbol}: ${lb}h=${a.returns[`${lb}h`]?.toFixed(1)}% vol=${a.realizedVolPct.toFixed(0)}%`)
  }

  // Compute signals
  const config = { ...bestConfig, minUniverseSize: Math.max(2, Math.floor(assetData.length / 2)), topN: 1, bottomN: 1 }
  const rawRanks = evaluateCrossSectionalMomentum(csAssets, config)
  const ranks = applyMarketIntelSymbolBlocks(rawRanks, marketIntelContext)
  const blockedRankSymbols = rawRanks
    .filter(rank => isMarketIntelSymbolBanned(marketIntelContext, rank.symbol) && rank.signal !== 0)
    .map(rank => rank.symbol)
  if (blockedRankSymbols.length > 0) {
    decisionReport.blockReasons.push(`market_intel_symbol_blocks:${[...new Set(blockedRankSymbols)].join(',')}`)
  }

  console.log('\nSignals:')
  for (const r of ranks) {
    const emoji = r.signal === 1 ? '📈 LONG' : r.signal === -1 ? '📉 SHORT' : '➡️  FLAT'
    console.log(`  ${emoji} ${r.symbol}: rank=${r.rank} confidence=${r.confidence.toFixed(2)} reason=${r.reason}`)
  }
  decisionReport.signals = buildSignalsReport(ranks, csAssets)

  decisionReport.llmGovernance = await runRegularLlmGovernance({
    ranks,
    decisionReport,
    baselineAccount,
    dataQualityState: qualityBlocks.length > 0 ? 'degraded' : 'good',
    systemAlerts: decisionReport.blockReasons,
  })
  if (decisionReport.llmGovernance.status === 'applied') {
    const cap = decisionReport.llmGovernance.appliedExposureCap
    if (cap !== null) {
      exposureMultiplier = Math.max(0, Math.min(exposureMultiplier, cap))
      decisionReport.exposureMultiplier = exposureMultiplier
      console.log(`LLM governance (${decisionReport.llmGovernance.model}) capped exposure at ${exposureMultiplier.toFixed(2)}x`)
    } else {
      console.log(`LLM governance (${decisionReport.llmGovernance.model}) action: ${decisionReport.llmGovernance.action}`)
    }
  } else {
    console.log(`LLM governance unavailable (${decisionReport.llmGovernance.model}): ${decisionReport.llmGovernance.error ?? 'unknown'}`)
  }

  const promotionV2Load = await resolvePromotionReadinessV2ForPaperTrader(cliArgs, runNow)
  decisionReport.promotionV2 = promotionV2Load.summary
  const promotionV2Blocks = evaluatePromotionReadinessForPaperOrders(promotionV2Load.readiness, {
    required: cliArgs.requirePromotionV2,
    now: runNow,
  })
  if (
    promotionV2Load.summary.loadStatus !== 'not_requested' &&
    promotionV2Load.readiness === null
  ) {
    promotionV2Blocks.push(`promotion_v2_load_${promotionV2Load.summary.loadStatus}`)
  }
  if (promotionV2Blocks.length > 0) {
    console.log('\nPromotion v2.6 gate blocked new paper orders:')
    for (const reason of promotionV2Blocks) {
      console.log(`  ${reason}`)
    }
    decisionReport.blockReasons.push(...promotionV2Blocks)
    refreshPromotionReadiness()
    await saveDecisionReport(decisionReport)
    return
  }

  // Apply the same signal set to independent local virtual accounts.
  const executionNow = new Date(now)
  const marketIntelMinConfidence = Math.max(
    DEFAULT_CONFIG.minConfidence,
    marketIntelContext.suggestedRuleThresholdByLane.cross_sectional ?? 0,
  )
  const profileResults = profileStates.map(({ profile, account }) => applySignalsToPaperAccount({
    profile,
    account,
    ranks,
    csAssets,
    exposureMultiplier,
    fwdHours,
    now: executionNow,
    today,
    minConfidence: marketIntelMinConfidence,
    marketIntelContext,
    allowNewOrders: !(cliArgs.skipSecondLevel && profile.timeframe === '1s'),
    recordClosedTradeResult: true,
    priceSource: profile.timeframe === '1s' ? '1s' : profile.timeframe === '5m' ? '5m' : 'last_known',
    priceStale: false,
    assetCandlesBySymbol: new Map(assetData.map(asset => [
      asset.symbol,
      asset.candles.map(toPaperTradePathCandle),
    ])),
  }))

  for (const result of profileResults) {
    if (result.account) {
      await savePaperAccount(result.profileReport, result.account)
    }
    for (const trade of result.profileReport.executedTrades) {
      await saveProfileTradeLog(result.profileReport, trade)
    }
  }

  decisionReport.multiAccount.profiles = profileResults.map(result => result.profileReport)
  const baselineResult = profileResults.find(result => result.profileReport.id === 'spot_1x') ?? profileResults[0]
  const baselineReport = baselineResult.profileReport
  decisionReport.proposedOrders = baselineReport.proposedOrders
  decisionReport.executedTrades = baselineReport.executedTrades
  decisionReport.accountSnapshot = baselineReport.accountSnapshot
  decisionReport.status = baselineReport.status === 'stress_only' ? 'no_signal' : baselineReport.status
  if (decisionReport.proposedOrders.length === 0 && decisionReport.executedTrades.length === 0) {
    decisionReport.blockReasons.push('no_tradeable_signal')
  }
  refreshPromotionReadiness()
  await saveDecisionReport(decisionReport)

  // Report
  console.log('\n═══════════════════════════════════')
  console.log('        PAPER TRADING REPORT')
  console.log('═══════════════════════════════════')
  console.log(`Date: ${today}`)
  console.log(`Baseline: ${baselineReport.label}`)
  if (baselineResult.account && baselineReport.accountSnapshot) {
    console.log(`Equity: $${baselineResult.account.equity.toFixed(2)} (Initial: $${baselineResult.account.initialEquity.toFixed(2)})`)
    console.log(`Total Return: ${((baselineResult.account.equity / baselineResult.account.initialEquity - 1) * 100).toFixed(2)}%`)
    console.log(`Daily PnL: $${baselineReport.accountSnapshot.dailyPnl.toFixed(2)} (${baselineReport.accountSnapshot.dailyPnlPct.toFixed(2)}%)`)
    console.log(`Open Positions: ${baselineResult.account.positions.length}`)
    for (const p of baselineResult.account.positions) {
      const currentPrice = csAssets.find(a => a.symbol === p.symbol)?.currentPrice ?? p.entryPrice
      const unrealized = p.direction === 'long'
        ? (currentPrice - p.entryPrice) / p.entryPrice * 100
        : (p.entryPrice - currentPrice) / p.entryPrice * 100
      console.log(`  ${p.direction.toUpperCase()} ${p.symbol}: ${unrealized.toFixed(2)}% (conf: ${p.signalConfidence.toFixed(2)})`)
    }
    console.log(`Total Trades: ${baselineResult.account.tradeHistory.length}`)
  }
  console.log(`Closed PnL: $${baselineResult.closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0).toFixed(2)}`)
  console.log('\nVirtual Account Matrix:')
  for (const profile of decisionReport.multiAccount.profiles) {
    const snapshot = profile.accountSnapshot
    const equity = snapshot ? `$${snapshot.equity.toFixed(2)}` : 'n/a'
    console.log(`  ${profile.id}: ${profile.status}, ${profile.leverage}x, ${profile.timeframe}/${profile.cadence}, lane=${profile.strategyLane}, orders=${profile.proposedOrders.length}, fills=${profile.executedTrades.length}, equity=${equity}`)
  }
}

function toPaperTradePathCandle(candle: Candle): PaperTradePathCandle {
  return {
    timestamp: candle.time > 1e11 ? candle.time : candle.time * 1000,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

async function runCli(): Promise<void> {
  const cliArgs = parsePaperTraderArgs(process.argv.slice(2))
  if (cliArgs.dryRun) {
    await main(process.argv.slice(2))
    return
  }

  const releaseLock = await acquirePaperTraderLock()
  if (!releaseLock) {
    console.log('Skip paper_trade_cross_sectional: another instance is already active')
    return
  }

  try {
    await main()
  } finally {
    await releaseLock()
  }
}

async function acquirePaperTraderLock(): Promise<(() => Promise<void>) | null> {
  await mkdir(dirname(PAPER_TRADER_LOCK_DIR), { recursive: true })
  try {
    await mkdir(PAPER_TRADER_LOCK_DIR)
    await writeFile(join(PAPER_TRADER_LOCK_DIR, 'pid'), `${process.pid}\n`, 'utf-8')
    return async () => {
      await rm(PAPER_TRADER_LOCK_DIR, { recursive: true, force: true })
    }
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error
    const staleRemoved = await removeStalePaperTraderLock()
    return staleRemoved ? acquirePaperTraderLock() : null
  }
}

async function removeStalePaperTraderLock(): Promise<boolean> {
  try {
    const raw = await readFile(join(PAPER_TRADER_LOCK_DIR, 'pid'), 'utf-8')
    const pid = Number.parseInt(raw.trim(), 10)
    if (Number.isFinite(pid) && pid > 0 && processIsAlive(pid)) return false
  } catch {
    // A lock without a readable pid cannot prove a running owner.
  }

  await rm(PAPER_TRADER_LOCK_DIR, { recursive: true, force: true })
  return true
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isErrno(error, 'ESRCH')
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
}
