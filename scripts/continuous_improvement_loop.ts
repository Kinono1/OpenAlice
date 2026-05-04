/**
 * Continuous Strategy Improvement Loop.
 *
 * Runs periodically:
 *   1. Load latest market data
 *   2. Sweep parameters for all active strategies
 *   3. Compare vs previous best configs
 *   4. Promote winning configs to production params
 *   5. Generate improvement report
 *
 * Usage: npx tsx scripts/continuous_improvement_loop.ts --dryRun false
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { evaluateCrossSectionalMomentum } from '../src/domain/strategy/cross-sectional-momentum.js'
import type { CrossSectionalAsset } from '../src/domain/strategy/cross-sectional-momentum.js'
import { createModelFromConfig } from '../src/ai-providers/vercel-ai-sdk/model-factory.js'
import { describeQuantLlmModel, resolveQuantLlmModel } from '../src/runtime/llm_model_routing.js'
import { generateZodJsonObject } from '../src/runtime/llm_json_generation.js'
import {
  appendRecommendationAudit,
  calculateAssociatedAvgPnlPct,
  withSuppressionIfIgnored,
} from '../src/runtime/recommendation_audit.js'
import {
  DEFAULT_PRO_RISK_POLICY_PATH,
  PRO_MAX_FALLBACK_AGE_MS,
  RULE_THRESHOLD_FLOOR_BY_LANE,
} from '../src/runtime/market_intel_constants.js'
import {
  nextProRiskPolicy,
  readProRiskPolicy,
  writeProRiskPolicy,
  type ProRiskPolicy,
} from '../src/runtime/pro_risk_policy.js'
import {
  analyzePaperPnl,
  type GroupStats,
  type PaperPnlDiagnosticsReport,
} from './analyze_paper_pnl.js'
import { runStrategyWalkForward, createRollingWindows, type WfoResult, type StrategyWfoInput, type WfoConfig } from '../src/backtest/wfo.js'
import type { StrategyParams, StrategyName, MarketData } from '../src/backtest/wfo.js'

// ==================== Data Layer ====================

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface AssetData { symbol: string; candles: Candle[] }

interface CliArgs {
  dryRun: boolean
  wfoShadow: boolean
  wfoActive: boolean
  fastMode: boolean
  costShadow: boolean
}

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

function computeVol(candles: Candle[], i: number, lookback: number): number {
  const start = Math.max(0, i - lookback)
  const rets: number[] = []
  for (let j = start + 1; j <= i; j++) {
    if (candles[j - 1].close > 0) rets.push(candles[j].close / candles[j - 1].close - 1)
  }
  if (rets.length < 2) return 50
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length
  return Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length * 365 * 24) * 100
}

// ==================== Strategy Evaluator ====================

interface StrategyMetrics {
  lookbackHours: number
  secondaryLookback: number
  forwardHours: number
  mtfWeight: number
  minSpreadPct: number
  maxVolPct: number
  fundingWeight: number
  signals: number
  winRate: number
  spreadCum: number
  avgSpread: number
  sharpeApprox: number
  score: number
}

interface BestConfig {
  config: StrategyMetrics
  discoveredAt: string
  dataRange: { start: string; end: string }
  assetCount: number
}

interface ImprovementReport {
  generatedAt: string
  previousBest: BestConfig | null
  currentBest: BestConfig | null
  paperPnlDiagnostics: PaperPnlDiagnosticsSummary | null
  improvement: { winRateDelta: number; sharpeDelta: number; spreadDelta: number }
  llmAnalysis: {
    enabled: boolean
    lane: 'analysis'
    provider: string | null
    model: string | null
    baseUrl: string | null
    contextWindowTokens: number | null
    status: 'applied' | 'unavailable'
    verdict: string | null
    riskNotes: string[]
    recommendedChanges: string[]
    pauseLaneRecommendations: Record<string, boolean>
    symbolBlocks: string[]
    suggestedRuleThresholdByLane: Record<string, number>
    riskReductionActions: string[]
    confidenceScore: number | null
    error: string | null
  }
  allConfigsTested: number
  topConfigs: StrategyMetrics[]
  nextSteps: string[]
}

interface PaperPnlDiagnosticsSummary {
  generatedAt: string
  coverage: PaperPnlDiagnosticsReport['coverage']
  overall: Pick<GroupStats, 'count' | 'winRate' | 'totalPnlPct' | 'avgPnlPct' | 'profitFactor' | 'maxConsecutiveLosses'>
  worstLanes: Array<Pick<GroupStats, 'key' | 'count' | 'winRate' | 'totalPnlPct' | 'avgPnlPct' | 'profitFactor'>>
  worstSymbols: Array<Pick<GroupStats, 'key' | 'count' | 'winRate' | 'totalPnlPct' | 'avgPnlPct'>>
  worstCloseReasons: Array<Pick<GroupStats, 'key' | 'count' | 'winRate' | 'totalPnlPct' | 'avgPnlPct'>>
  openRisk: PaperPnlDiagnosticsReport['openRisk']
  recommendations: string[]
}

const LlmImprovementReviewSchema = z.object({
  verdict: z.enum(['accept_candidate', 'hold_current', 'requires_more_data', 'reject_candidate']),
  riskNotes: z.array(z.string()).default([]),
  recommendedChanges: z.array(z.string()).default([]),
  pauseLaneRecommendations: z.record(z.string(), z.boolean()).default({}),
  symbolBlocks: z.array(z.string()).default([]),
  suggestedRuleThresholdByLane: z.record(z.string(), z.number().min(0).max(1)).default({}),
  riskReductionActions: z.array(z.string()).default([]),
  confidenceScore: z.number(),
})

function normalizeConfidenceScore(score: number): number {
  if (!Number.isFinite(score)) return 0
  const normalized = score > 1 && score <= 100 ? score / 100 : score
  return Math.max(0, Math.min(1, normalized))
}

function truncateList(values: string[], maxItems: number, maxChars: number): string[] {
  return values
    .map(value => value.trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map(value => value.length > maxChars ? value.slice(0, maxChars - 1).trimEnd() : value)
}

function summarizePaperPnlDiagnostics(
  report: PaperPnlDiagnosticsReport | null,
): PaperPnlDiagnosticsSummary | null {
  if (!report) return null
  return {
    generatedAt: report.generatedAt,
    coverage: report.coverage,
    overall: {
      count: report.overall.count,
      winRate: report.overall.winRate,
      totalPnlPct: report.overall.totalPnlPct,
      avgPnlPct: report.overall.avgPnlPct,
      profitFactor: report.overall.profitFactor,
      maxConsecutiveLosses: report.overall.maxConsecutiveLosses,
    },
    worstLanes: report.byLane.slice(0, 8).map(pickGroupForPro),
    worstSymbols: report.bySymbol.slice(0, 12).map(group => ({
      key: group.key,
      count: group.count,
      winRate: group.winRate,
      totalPnlPct: group.totalPnlPct,
      avgPnlPct: group.avgPnlPct,
    })),
    worstCloseReasons: report.byCloseReason.slice(0, 8).map(group => ({
      key: group.key,
      count: group.count,
      winRate: group.winRate,
      totalPnlPct: group.totalPnlPct,
      avgPnlPct: group.avgPnlPct,
    })),
    openRisk: report.openRisk,
    recommendations: report.recommendations.slice(0, 10),
  }
}

function pickGroupForPro(
  group: GroupStats,
): Pick<GroupStats, 'key' | 'count' | 'winRate' | 'totalPnlPct' | 'avgPnlPct' | 'profitFactor'> {
  return {
    key: group.key,
    count: group.count,
    winRate: group.winRate,
    totalPnlPct: group.totalPnlPct,
    avgPnlPct: group.avgPnlPct,
    profitFactor: group.profitFactor,
  }
}

function normalizeSymbolBlocks(symbols: string[]): string[] {
  return [...new Set(symbols
    .map(symbol => symbol.trim().toUpperCase())
    .filter(symbol => /^[A-Z0-9]+-USDT$/.test(symbol))
  )].slice(0, 20)
}

function buildStructuredRecommendationAuditKeys(
  llmAnalysis: ImprovementReport['llmAnalysis'],
): string[] {
  const out = [...llmAnalysis.recommendedChanges, ...llmAnalysis.riskReductionActions]
  for (const [lane, pause] of Object.entries(llmAnalysis.pauseLaneRecommendations)) {
    if (pause) out.push(`pause_lane:${lane}`)
  }
  for (const symbol of llmAnalysis.symbolBlocks) {
    out.push(`symbol_block:${symbol}`)
  }
  for (const [lane, threshold] of Object.entries(llmAnalysis.suggestedRuleThresholdByLane)) {
    out.push(`threshold:${lane}:${threshold.toFixed(3)}`)
  }
  const seen = new Set<string>()
  return out
    .map(value => value.trim())
    .filter(value => {
      if (!value || seen.has(value)) return false
      seen.add(value)
      return true
    })
}

function hasRiskReductionPolicy(llmAnalysis: ImprovementReport['llmAnalysis']): boolean {
  return Object.values(llmAnalysis.pauseLaneRecommendations).some(Boolean)
    || llmAnalysis.symbolBlocks.length > 0
    || Object.keys(llmAnalysis.suggestedRuleThresholdByLane).length > 0
    || llmAnalysis.riskReductionActions.length > 0
}

function buildProRiskPolicyPatch(input: {
  llmAnalysis: ImprovementReport['llmAnalysis']
  proEpoch: number
  reportPath: string
}): Omit<Partial<ProRiskPolicy>, 'generation' | 'schemaVersion'> {
  const generatedAt = new Date(input.proEpoch).toISOString()
  return {
    proEpoch: input.proEpoch,
    generatedAt,
    validUntil: new Date(input.proEpoch + PRO_MAX_FALLBACK_AGE_MS).toISOString(),
    verdict: input.llmAnalysis.verdict ?? 'unknown',
    confidenceScore: input.llmAnalysis.confidenceScore,
    pauseLaneRecommendations: Object.fromEntries(
      Object.entries(input.llmAnalysis.pauseLaneRecommendations)
        .filter(([, pause]) => pause),
    ),
    symbolBlocks: input.llmAnalysis.symbolBlocks,
    suggestedRuleThresholdByLane: normalizeRiskReductionThresholds(
      input.llmAnalysis.suggestedRuleThresholdByLane,
    ),
    riskReductionActions: input.llmAnalysis.riskReductionActions,
    autoApplyPolicy: 'risk_reduction_only',
    source: {
      reportPath: input.reportPath,
      model: input.llmAnalysis.model,
    },
  }
}

function normalizeRiskReductionThresholds(
  values: Record<string, number>,
): Record<string, number> {
  const floors = RULE_THRESHOLD_FLOOR_BY_LANE as Record<string, number>
  const out: Record<string, number> = {}
  for (const [lane, raw] of Object.entries(values)) {
    if (!Number.isFinite(raw)) continue
    const floor = floors[lane] ?? 0
    const threshold = Math.max(floor, Math.min(1, raw))
    if (threshold <= 0) continue
    out[lane] = threshold
  }
  return out
}

// ==================== Parameter Sweep ====================

function evaluateConfig(assets: AssetData[], params: StrategyMetrics): StrategyMetrics {
  const minBars = Math.max(params.lookbackHours, params.secondaryLookback, params.forwardHours) + 2
  const maxI = Math.min(...assets.map(a => a.candles.length)) - params.forwardHours
  let signals = 0; let wins = 0; let spreadCum = 0

  for (let i = minBars; i < maxI; i++) {
    const fwd = i + params.forwardHours
    const csAssets: CrossSectionalAsset[] = assets.map(({ symbol, candles }) => ({
      symbol,
      currentPrice: candles[i].close,
      returns: {
        [`${params.lookbackHours}h`]: (candles[i].close / candles[i - params.lookbackHours].close - 1) * 100,
        [`${params.secondaryLookback}h`]: i >= params.secondaryLookback
          ? (candles[i].close / candles[i - params.secondaryLookback].close - 1) * 100
          : (candles[i].close / candles[0].close - 1) * 100,
        [`${params.forwardHours}h`]: (candles[fwd].close / candles[i].close - 1) * 100,
      },
      realizedVolPct: computeVol(candles, i, 24),
      avgVolume24h: candles[i].volume,
    }))

    const n = assets.length
    const minUniv = Math.max(2, Math.floor(n / 2))
    const ranks = evaluateCrossSectionalMomentum(csAssets, {
      lookbackHours: params.lookbackHours,
      secondaryLookbackHours: params.secondaryLookback,
      topN: Math.max(1, Math.floor(Math.min(n, 3) / 3)),
      bottomN: Math.max(1, Math.floor(Math.min(n, 3) / 3)),
      minUniverseSize: minUniv,
      maxVolPercentile: params.maxVolPct / 100,
      minSpreadPct: params.minSpreadPct,
      requireVolumeConfirmation: false,
      mtfWeight: params.mtfWeight,
      fundingWeight: params.fundingWeight,
    })

    const longs = ranks.filter(r => r.signal === 1).sort((a, b) => b.confidence - a.confidence)
    const shorts = ranks.filter(r => r.signal === -1).sort((a, b) => b.confidence - a.confidence)
    if (longs.length === 0 || shorts.length === 0) continue

    for (const long of longs.slice(0, 1)) {
      for (const short of shorts.slice(0, 1)) {
        if (long.symbol === short.symbol) continue
        signals++
        const lFwd = csAssets.find(a => a.symbol === long.symbol)!.returns[`${params.forwardHours}h`]
        const sFwd = csAssets.find(a => a.symbol === short.symbol)!.returns[`${params.forwardHours}h`]
        const s = lFwd - sFwd
        spreadCum += s
        if (s > 0) wins++
      }
    }
  }

  const wr = signals > 0 ? wins / signals * 100 : 0
  const avgSpread = signals > 0 ? spreadCum / signals : 0
  const sharpe = signals > 1 ? avgSpread / (spreadCum / Math.max(signals, 1) / Math.sqrt(Math.max(signals, 1))) : 0

  // Composite score: avgSpread * sqrt(signals) — balances return with statistical significance
  const score = Math.max(0, avgSpread) * Math.sqrt(Math.max(signals, 1))

  return { ...params, signals, winRate: wr, spreadCum, avgSpread, sharpeApprox: sharpe, score }
}

// ==================== Main Loop ====================

async function loadBestConfig(): Promise<BestConfig | null> {
  try {
    const raw = await readFile(join(import.meta.dirname, '..', 'data', 'research', 'best_config.json'), 'utf-8')
    return JSON.parse(raw)
  } catch { return null }
}

async function saveBestConfig(config: BestConfig): Promise<void> {
  const dir = join(import.meta.dirname, '..', 'data', 'research')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'best_config.json'), JSON.stringify(config, null, 2))
}

async function saveReport(report: ImprovementReport): Promise<void> {
  const dir = join(import.meta.dirname, '..', 'data', 'research', 'improvement_reports')
  await mkdir(dir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  await writeFile(join(dir, `report_${ts}.json`), JSON.stringify(report, null, 2))
  await writeFile(join(import.meta.dirname, '..', 'data', 'research', 'improvement_report.latest.json'), JSON.stringify(report, null, 2))
}

async function runAnalysisLlmReview(input: {
  previousBest: BestConfig | null
  candidateBest: StrategyMetrics
  topConfigs: StrategyMetrics[]
  assetCount: number
  dataRange: { start: string; end: string }
  paperPnlDiagnostics: PaperPnlDiagnosticsSummary | null
}): Promise<ImprovementReport['llmAnalysis']> {
  const spec = resolveQuantLlmModel('analysis')
  const modelInfo = describeQuantLlmModel(spec)
  const base = {
    enabled: true,
    lane: 'analysis' as const,
    provider: modelInfo.provider,
    model: modelInfo.model,
    baseUrl: modelInfo.baseUrl ?? null,
    contextWindowTokens: modelInfo.contextWindowTokens,
    status: 'unavailable' as const,
    verdict: null,
    riskNotes: [],
    recommendedChanges: [],
    pauseLaneRecommendations: {},
    symbolBlocks: [],
    suggestedRuleThresholdByLane: {},
    riskReductionActions: [],
    confidenceScore: null,
    error: null,
  }

  try {
    const { model, providerName } = await createModelFromConfig(spec)
    const object = await generateZodJsonObject({
      model,
      schema: LlmImprovementReviewSchema,
      temperature: 0.1,
      modelOverride: spec,
      providerName,
      jsonInstruction: `{
  "verdict": "accept_candidate" | "hold_current" | "requires_more_data" | "reject_candidate",
  "riskNotes": string[] // max 5 short items, each under 160 characters,
  "recommendedChanges": string[] // max 5 short items, each under 160 characters,
  "pauseLaneRecommendations": { [lane: string]: boolean } // true only for lanes that should stop new paper entries,
  "symbolBlocks": string[] // symbols to block or heavily downweight in paper only, e.g. "APT-USDT",
  "suggestedRuleThresholdByLane": { [lane: string]: number } // 0..1 minimum signal thresholds, risk-reduction only,
  "riskReductionActions": string[] // max 5 concrete risk-only actions, no live deployment,
  "confidenceScore": number // use 0..1, not 0..100
}`,
      prompt: `You are a conservative quantitative strategy reviewer.
You cannot place trades and cannot approve live-money deployment.
Review this paper-only optimizer result and return only risk-aware parameter guidance.

Previous best:
${JSON.stringify(input.previousBest?.config ?? null)}

Candidate best:
${JSON.stringify(input.candidateBest)}

Top configs:
${JSON.stringify(input.topConfigs.slice(0, 5))}

Paper PnL diagnostics:
${JSON.stringify(input.paperPnlDiagnostics)}

Data:
- assetCount=${input.assetCount}
- start=${input.dataRange.start}
- end=${input.dataRange.end}

Rules:
- Favor robustness over small backtest improvements.
- If paper diagnostics show persistent loss clusters, prefer hold_current/requires_more_data/reject_candidate.
- Risk-reduction suggestions may pause paper lanes, block symbols, or raise thresholds.
- Do not recommend live-money deployment.
- Mention if signal count, thin avg spread, cost drag, stop-loss clusters, or open risk makes the candidate fragile.`,
    })

    return {
      ...base,
      status: 'applied',
      verdict: object.verdict,
      riskNotes: truncateList(object.riskNotes, 5, 160),
      recommendedChanges: truncateList(object.recommendedChanges, 5, 160),
      pauseLaneRecommendations: object.pauseLaneRecommendations,
      symbolBlocks: normalizeSymbolBlocks(object.symbolBlocks),
      suggestedRuleThresholdByLane: object.suggestedRuleThresholdByLane,
      riskReductionActions: truncateList(object.riskReductionActions, 5, 160),
      confidenceScore: normalizeConfidenceScore(object.confidenceScore),
    }
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function refreshPaperPnlDiagnostics(): Promise<PaperPnlDiagnosticsReport | null> {
  try {
    return await analyzePaperPnl({
      paperDir: join(import.meta.dirname, '..', 'data', 'paper_trading'),
      runtimeDir: join(import.meta.dirname, '..', 'data', 'runtime'),
      outputPath: join(import.meta.dirname, '..', 'data', 'research', 'paper_pnl_diagnostics.latest.json'),
      lookbackHours: null,
      topN: 10,
    })
  } catch (error) {
    console.log(`Paper PnL diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

// ── WFO Shadow ─────────────────────────────────────────────────────────────
async function runWfoShadow(
  topConfigs: StrategyMetrics[],
  assets: AssetData[],
): Promise<void> {
  const candleMap: Record<string, MarketData> = {}
  for (const a of assets) {
    candleMap[a.symbol] = {
      symbol: a.symbol,
      timeframe: '1h',
      candles: a.candles.map(c => ({
        time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      })),
    }
  }

  const config: WfoConfig = {
    trainBars: 24 * 90,    // ~90 days train
    testBars: 24 * 30,     // ~30 days test
    embargoBars: 24,
    stepBars: 24 * 30,
    totalBars: Math.min(...assets.map(a => a.candles.length)),
  }

  const wfoResult = runStrategyWalkForward({
    strategy: 'cross-sectional' as StrategyName,
    candles: Object.values(candleMap),
    candidates: topConfigs.map(c => ({
      lookbackHours: c.lookbackHours,
      secondaryLookback: c.secondaryLookback,
      forwardHours: c.forwardHours,
      mtfWeight: c.mtfWeight,
      minSpreadPct: c.minSpreadPct,
      maxVolPct: c.maxVolPct,
      fundingWeight: c.fundingWeight,
    })) as StrategyParams[],
    config,
  })

  const shadowPayload = {
    generated_at: new Date().toISOString(),
    module_mode: 'shadow',
    windows: wfoResult.windows.map((w, i) => ({
      window_id: i,
      train_start: new Date(w.candleRange?.trainStart ?? 0).toISOString(),
      train_end: new Date(w.candleRange?.trainEnd ?? 0).toISOString(),
      test_start: new Date(w.candleRange?.testStart ?? 0).toISOString(),
      test_end: new Date(w.candleRange?.testEnd ?? 0).toISOString(),
      is_sharpe: w.metrics?.sharpeApprox ?? 0,
      oos_sharpe: w.oosMetrics?.sharpeApprox ?? 0,
      oos_is_ratio: (w.oosMetrics?.sharpeApprox ?? 0) / (w.metrics?.sharpeApprox || 1),
      overfit: w.isOverfit ?? false,
    })),
    summary: {
      avg_oos_is_ratio: wfoResult.windows.length > 0
        ? wfoResult.windows.reduce((s, w) => s + ((w.oosMetrics?.sharpeApprox ?? 0) / (w.metrics?.sharpeApprox || 1)), 0) / wfoResult.windows.length
        : 0,
      overfit_window_count: wfoResult.failedWindows,
      verdict: wfoResult.overallPassed ? 'PASS' : 'WATCH',
    },
    reasoning_hint: wfoResult.overallPassed
      ? 'WFO 通过：OOS 表现与 IS 一致'
      : `WFO 警告：${wfoResult.failedWindows} 个窗口过拟合`,
  }

  const outDir = join(import.meta.dirname, '..', 'data', 'runtime')
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'wfo_shadow.latest.json'), JSON.stringify(shadowPayload, null, 2))
  console.log(`WFO shadow: ${wfoResult.windows.length} windows, ${wfoResult.failedWindows} overfit → ${shadowPayload.summary.verdict}`)
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.dryRun) {
    console.log(JSON.stringify({
      family: 'continuous_improvement',
      command: 'continuous_improvement_loop',
      executionMode: {
        dryRun: true,
        loadsMarketData: false,
        refreshesPaperPnlDiagnostics: false,
        callsLlm: false,
        writesBestConfig: false,
        writesImprovementReports: false,
        writesProRiskPolicy: false,
        writesRecommendationAudit: false,
        writesRuntimeShadowArtifacts: false,
        promotionEligible: false,
      },
      requestedShadows: {
        wfoShadow: args.wfoShadow,
        costShadow: args.costShadow,
        wfoActive: args.wfoActive,
      },
      optIn: {
        runImprovementLoop: '--dryRun false',
      },
    }, null, 2))
    return
  }

  console.log('╔════════════════════════════════════════════════════╗')
  console.log('║   Continuous Strategy Improvement Loop            ║')
  console.log(`║   ${new Date().toISOString().slice(0, 19)}                    ║`)
  console.log('╚════════════════════════════════════════════════════╝\n')

  // Load data — all 6 assets from multi_assets/ (Binance deep history, ~10k bars each)
  const dataDir = join(import.meta.dirname, '..', 'data', 'market', 'multi_assets')
  const assetFiles = ['BTC_USDT_USDT_1h.csv', 'ETH_USDT_USDT_1h.csv', 'SOL_USDT_USDT_1h.csv', 'BNB_USDT_USDT_1h.csv', 'XRP_USDT_USDT_1h.csv', 'DOGE_USDT_USDT_1h.csv']
  const assets: AssetData[] = []
  for (const f of assetFiles) {
    try { assets.push({ symbol: f.replace('_USDT_USDT_1h.csv', '-USDT'), candles: await loadCandles(join(dataDir, f)) }) } catch {}
  }

  const dataStart = new Date(Math.min(...assets.map(a => a.candles[0].time))).toISOString()
  const dataEnd = new Date(Math.max(...assets.map(a => a.candles[a.candles.length - 1].time))).toISOString()

  console.log(`Assets: ${assets.length} | Data: ${dataStart.slice(0, 10)} → ${dataEnd.slice(0, 10)}`)
  console.log(`Previous best config: ${(await loadBestConfig())?.config?.winRate.toFixed(1) ?? 'N/A'}% WR\n`)

  const paperPnlDiagnostics = await refreshPaperPnlDiagnostics()
  const paperPnlSummary = summarizePaperPnlDiagnostics(paperPnlDiagnostics)
  if (paperPnlSummary) {
    console.log('Paper PnL diagnostics:')
    console.log(`  Closed trades: ${paperPnlSummary.coverage.closedTrades} | PF: ${paperPnlSummary.overall.profitFactor?.toFixed(3) ?? 'N/A'} | Win rate: ${paperPnlSummary.overall.winRate.toFixed(1)}%`)
    console.log(`  Worst lane: ${paperPnlSummary.worstLanes[0]?.key ?? 'N/A'} (${paperPnlSummary.worstLanes[0]?.totalPnlPct.toFixed(3) ?? '0'}%)`)
    console.log(`  Worst symbol: ${paperPnlSummary.worstSymbols[0]?.key ?? 'N/A'} (${paperPnlSummary.worstSymbols[0]?.totalPnlPct.toFixed(3) ?? '0'}%)\n`)
  }

  // Data-aware sweep: cap all lookbacks to available data
  const minBars = Math.min(...assets.map(a => a.candles.length))
  const maxLookback = Math.min(minBars - 50, 504)
  const availableLookbacks = [72, 120, 168, 240, 336, 504].filter(l => l <= maxLookback)
  if (availableLookbacks.length === 0) availableLookbacks.push(24)
  const availableSecondary = [336, 504, 720, 1008, 24, 72, 168, 240].filter(l => l <= maxLookback)

  const SWEEPS = args.fastMode ? 60 : 300
  const results: StrategyMetrics[] = []

  for (let s = 0; s < SWEEPS; s++) {
    const lb = availableLookbacks[Math.floor(Math.random() * availableLookbacks.length)]
    const sec = availableSecondary[Math.floor(Math.random() * availableSecondary.length)]
    const config: StrategyMetrics = {
      lookbackHours: lb,
      secondaryLookback: Math.max(sec, lb + 1),
      forwardHours: [24, 48][Math.floor(Math.random() * 2)],
      mtfWeight: [0, 0.15, 0.25, 0.35, 0.5][Math.floor(Math.random() * 5)],
      minSpreadPct: [0, 1, 2, 3, 5][Math.floor(Math.random() * 5)],
      maxVolPct: [80, 85, 90, 95, 99][Math.floor(Math.random() * 5)],
      fundingWeight: [0, 0.15, 0.25, 0.35, 0.5][Math.floor(Math.random() * 5)],
      signals: 0, winRate: 0, spreadCum: 0, avgSpread: 0, sharpeApprox: 0, score: 0,
    }
    if (config.secondaryLookback < config.lookbackHours) continue

    const result = evaluateConfig(assets, config)
    if (result.signals > 2) results.push(result)
    if (results.length % 30 === 0) process.stdout.write('.')
  }
  console.log(`\nTested ${results.length} configs\n`)

  // Rank by score
  const ranked = [...results].sort((a, b) => b.score - a.score)
  const best = ranked[0]
  const previousBest = await loadBestConfig()

  // Show top 5
  console.log('Top 5 Configs:')
  for (let i = 0; i < Math.min(5, ranked.length); i++) {
    const r = ranked[i]
    console.log(`  #${i + 1} LB=${r.lookbackHours}h(${(r.lookbackHours/24).toFixed(1)}d) Fwd=${r.forwardHours}h MTF=${r.mtfWeight} Spread≥${r.minSpreadPct}% Vol≤${r.maxVolPct}% FR=${r.fundingWeight}`)
    console.log(`       ${r.signals}sigs | WR: ${r.winRate.toFixed(1)}% | Cum: ${r.spreadCum.toFixed(1)}% | Avg: ${r.avgSpread.toFixed(3)}% | Sharpe: ${r.sharpeApprox.toFixed(1)}`)
  }

  // ── WFO Shadow (parallel, does not change ranking) ────────────────────
  if (args.wfoShadow) {
    try {
      await runWfoShadow(ranked.slice(0, 5), assets)
    } catch (err) {
      console.log(`WFO shadow: skipped — ${err instanceof Error ? err.message : err}`)
    }
  }
  if (args.wfoActive) {
    console.log('WFO active: not implemented — use --wfo-shadow first')
  }

  // ── Cost Score Shadow (parallel, does not change ranking) ─────────────
  if (args.costShadow) {
    const FEE_RATE = 0.0006
    const SLIPPAGE_BPS = 8
    const estimatedRoundTripCostPct = FEE_RATE * 2 * 100 + (SLIPPAGE_BPS / 10000) * 2 * 100
    const costAdjusted = ranked.slice(0, 10).map((r, i) => {
      const netReturnApprox = r.avgSpread * r.winRate / 100 - (1 - r.winRate / 100) * r.avgSpread / 100
      const turnoverCost = estimatedRoundTripCostPct * 0.01
      const costScore = netReturnApprox + 0.5 * (r.sharpeApprox / 10) - 0.5 * 0.2 - turnoverCost
      return { rank: i + 1, config_id: `LB${r.lookbackHours}_FW${r.forwardHours}`, cost_adjusted_score: Math.round(costScore * 1000) / 1000, net_return_approx: Math.round(netReturnApprox * 1000) / 1000, turnover_cost_pct: Math.round(turnoverCost * 1000) / 1000, ranking_changed: false }
    })

    const costPayload = {
      generated_at: new Date().toISOString(),
      module_mode: 'shadow',
      cost_model: { fee_rate: FEE_RATE, slippage_bps: SLIPPAGE_BPS, estimated_round_trip_cost_pct: Math.round(estimatedRoundTripCostPct * 100) / 100 },
      configs: costAdjusted,
      ranking_changed: false,
      reasoning_hint: costAdjusted[0]?.cost_adjusted_score > 0 ? '成本后评分最优配置为正收益' : '成本后评分为负：当前参数无法覆盖交易成本',
    }
    await writeFile(join(import.meta.dirname, '..', 'data', 'runtime', 'cost_score_shadow.latest.json'), JSON.stringify(costPayload, null, 2))
    console.log(`Cost score shadow: top config = ${costAdjusted[0]?.cost_adjusted_score ?? 'N/A'}`)
  }

  // Check improvement
  const improvement = {
    winRateDelta: previousBest ? best.winRate - previousBest.config.winRate : best.winRate,
    sharpeDelta: previousBest ? best.sharpeApprox - previousBest.config.sharpeApprox : best.sharpeApprox,
    spreadDelta: previousBest ? best.avgSpread - previousBest.config.avgSpread : best.avgSpread,
  }
  const scoreDelta = previousBest ? best.score - previousBest.config.score : best.score
  const improved = scoreDelta > 0.5 || improvement.winRateDelta > 0.5 || improvement.sharpeDelta > 1

  const llmAnalysis = await runAnalysisLlmReview({
    previousBest,
    candidateBest: best,
    topConfigs: ranked.slice(0, 10),
    assetCount: assets.length,
    dataRange: { start: dataStart, end: dataEnd },
    paperPnlDiagnostics: paperPnlSummary,
  })
  if (llmAnalysis.status === 'applied') {
    console.log(`\nLLM analysis (${llmAnalysis.model}) verdict: ${llmAnalysis.verdict}`)
    for (const note of llmAnalysis.riskNotes) {
      console.log(`  Risk: ${note}`)
    }
    const pausedLanes = Object.entries(llmAnalysis.pauseLaneRecommendations)
      .filter(([, pause]) => pause)
      .map(([lane]) => lane)
    if (pausedLanes.length > 0) console.log(`  Pause lanes: ${pausedLanes.join(', ')}`)
    if (llmAnalysis.symbolBlocks.length > 0) console.log(`  Symbol blocks: ${llmAnalysis.symbolBlocks.join(', ')}`)
    const thresholds = Object.entries(llmAnalysis.suggestedRuleThresholdByLane)
    if (thresholds.length > 0) {
      console.log(`  Suggested thresholds: ${thresholds.map(([lane, value]) => `${lane}=${value.toFixed(2)}`).join(', ')}`)
    }
  } else {
    console.log(`\nLLM analysis unavailable (${llmAnalysis.model}): ${llmAnalysis.error ?? 'unknown'}`)
  }
  const proEpoch = Date.now()
  let proRiskPolicyApplied = false
  if (llmAnalysis.status === 'applied' && hasRiskReductionPolicy(llmAnalysis)) {
    const previousPolicy = readProRiskPolicy(DEFAULT_PRO_RISK_POLICY_PATH)
    const nextPolicy = nextProRiskPolicy(previousPolicy, buildProRiskPolicyPatch({
      llmAnalysis,
      proEpoch,
      reportPath: join(import.meta.dirname, '..', 'data', 'research', 'improvement_report.latest.json'),
    }))
    proRiskPolicyApplied = writeProRiskPolicy(nextPolicy, {
      path: DEFAULT_PRO_RISK_POLICY_PATH,
      expectedGeneration: previousPolicy.generation,
    })
    console.log(`\nPro risk policy ${proRiskPolicyApplied ? 'applied' : 'not applied'}: ${DEFAULT_PRO_RISK_POLICY_PATH}`)
  }

  const newBest: BestConfig = {
    config: best,
    discoveredAt: new Date().toISOString(),
    dataRange: { start: dataStart, end: dataEnd },
    assetCount: assets.length,
  }
  const llmBlocksPromotion = previousBest !== null
    && llmAnalysis.status === 'applied'
    && llmAnalysis.verdict !== 'accept_candidate'
  const shouldPromote = (improved || !previousBest) && !llmBlocksPromotion
  const currentBestForReport = shouldPromote ? newBest : (previousBest ?? newBest)

  if (shouldPromote) {
    await saveBestConfig(newBest)
    console.log(`\n🆕 NEW BEST CONFIG PROMOTED! WR: ${best.winRate.toFixed(1)}% (${improvement.winRateDelta >= 0 ? '+' : ''}${improvement.winRateDelta.toFixed(1)}%)`)
  } else if (llmBlocksPromotion) {
    console.log(`\n✓ Current best holds. LLM gate blocked promotion: ${llmAnalysis.verdict}`)
  } else {
    console.log(`\n✓ Current best holds. No improvement this cycle.`)
  }

  if (llmAnalysis.status === 'applied') {
    const associatedAvgPnlPct = calculateAssociatedAvgPnlPct(proEpoch)
    const structuredRecommendations = buildStructuredRecommendationAuditKeys(llmAnalysis)
    const recommendations = structuredRecommendations.length > 0
      ? structuredRecommendations
      : [`verdict:${llmAnalysis.verdict ?? 'unknown'}`]
    for (const recommendation of recommendations) {
      const isStructuredRiskPolicy = recommendation.startsWith('pause_lane:')
        || recommendation.startsWith('symbol_block:')
        || recommendation.startsWith('threshold:')
      appendRecommendationAudit(withSuppressionIfIgnored({
        proEpoch,
        recommendationKey: recommendation.slice(0, 120),
        recommendationType: llmAnalysis.verdict ?? 'unknown',
        autoApplied: isStructuredRiskPolicy
          ? proRiskPolicyApplied
          : Boolean(llmBlocksPromotion || (shouldPromote && llmAnalysis.verdict === 'accept_candidate')),
        humanApproved: false,
        ignoredCount: 0,
        associatedAvgPnlPct,
      }))
    }
  }

  // Run paper trading check with current best config
  console.log(`\n--- Paper Trading Check ---`)
  try {
    const { readFile } = await import('node:fs/promises')
    const accountPath = join(import.meta.dirname, '..', 'data', 'paper_trading', 'account.json')
    const account = JSON.parse(await readFile(accountPath, 'utf-8'))
    const positions = account.positions?.length ?? 0
    const equity = account.equity ?? account.initialEquity
    const initialEquity = account.initialEquity ?? 100000
    const totalReturn = ((equity / initialEquity - 1) * 100).toFixed(2)
    const todayPnl = account.dailyPnL?.find((d: any) => d.date === new Date().toISOString().slice(0, 10))
    const todayPnlStr = todayPnl ? `$${todayPnl.pnl.toFixed(2)} (${todayPnl.pnlPct.toFixed(2)}%)` : '$0.00'
    console.log(`  Equity: $${equity.toFixed(2)} | Return: ${totalReturn}% | Positions: ${positions}`)
    console.log(`  Today PnL: ${todayPnlStr}`)
    if (positions > 0) {
      for (const p of account.positions ?? []) {
        console.log(`    ${p.direction.toUpperCase()} ${p.symbol}: conf=${p.signalConfidence.toFixed(2)}`)
      }
    }
  } catch {
    console.log('  No active paper positions. Run pnpm paper:cross-sectional to check for signals.')
  }

  // Generate report
  const report: ImprovementReport = {
    generatedAt: new Date().toISOString(),
    previousBest,
    currentBest: currentBestForReport,
    improvement,
    paperPnlDiagnostics: paperPnlSummary,
    llmAnalysis,
    allConfigsTested: results.length,
    topConfigs: ranked.slice(0, 10),
    nextSteps: [],
  }

  // Generate next steps
  if (assets.length < 6) {
    report.nextSteps.push('Download SOL, BNB, XRP, DOGE data to expand universe (npx tsx scripts/download_multi_assets.ts)')
  }
  if (best.signals < 200) {
    report.nextSteps.push('Signal count low. Consider relaxing spread filter to increase trade frequency.')
  }
  if (best.avgSpread < 0.5) {
    report.nextSteps.push('Average spread below 0.5%. Consider stricter vol filter or longer lookback.')
  }
  report.nextSteps.push('Paper trade the best config for 2 weeks before live deployment.')
  report.nextSteps.push('Re-run this optimizer weekly with fresh data.')

  await saveReport(report)

  console.log('\nNext Steps:')
  for (const step of report.nextSteps) {
    console.log(`  → ${step}`)
  }
  console.log(`\nReport saved. Next run: tomorrow.`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    dryRun: parseBoolArg(raw.get('dryRun'), true),
    wfoShadow: parseBoolArg(raw.get('wfo-shadow'), false),
    wfoActive: parseBoolArg(raw.get('wfo-active'), false),
    fastMode: parseBoolArg(raw.get('fast'), false),
    costShadow: parseBoolArg(raw.get('cost-shadow'), false),
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const withoutPrefix = token.slice(2)
    const eq = withoutPrefix.indexOf('=')
    if (eq >= 0) {
      out.set(withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1))
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(withoutPrefix, next)
      index += 1
    } else {
      out.set(withoutPrefix, 'true')
    }
  }
  return out
}

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error(`Invalid boolean value: ${raw}`)
}

export {
  main,
  parseArgs,
}
