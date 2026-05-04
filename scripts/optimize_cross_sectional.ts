/**
 * Cross-Sectional Reversal - Automated Parameter Optimizer.
 * Sweeps lookback windows, spread thresholds, MTF weights.
 * Reports best config by win rate, cumulative spread, and Sharpe.
 *
 * Usage: npx tsx scripts/optimize_cross_sectional.ts
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateCrossSectionalMomentum } from '../src/domain/strategy/cross-sectional-momentum.js'
import type { CrossSectionalAsset, CrossSectionalConfig } from '../src/domain/strategy/cross-sectional-momentum.js'
import {
  hashJson,
  PROMOTION_V2_SCHEMA_VERSION,
  type CandidateRegistry,
  type CandidateRegistryEntry,
  type SchemaMeta,
} from '../src/runtime/promotion_v2.js'
import {
  DEFAULT_PROMOTION_V2_RUNTIME_DIR,
  promotionV2ArtifactFileNames,
} from '../src/runtime/promotion_v2_artifacts.js'
import { defaultPaperUniverseSymbols, paperSymbolToCsvFile } from './lib/paper_universe.js'

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface AssetData { symbol: string; candles: Candle[] }

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

export type HardGateStatus = 'pass' | 'fail'

export interface RankScoreComponents {
  winRate: number
  netAvgSpread: number
  sharpe: number
  signalCount: number
  costEfficiency: number
}

export interface SweepResult {
  lookbackHours: number
  secondaryLookback: number
  mtfWeight: number
  minSpreadPct: number
  maxVolPct: number
  forwardHours: number
  signals: number
  winRate: number
  spreadCum: number
  avgSpread: number
  sharpeApprox: number
  estimatedRoundTripCostPct: number
  estimatedRoundTripCostBps: number
  netAvgSpread: number
  netExpectancyPct: number
  netExpectancyBps: number
  hardGateStatus: HardGateStatus
  hardGateReasons: string[]
  rankScore: RankScoreComponents
  filteredCount: number
  score: number
}

export interface OptimizerCliArgs {
  seed: string
  samples: number
  dataDir: string
  runtimeDir: string
  symbols: string[]
  dryRun: boolean
}

export interface OptimizationSweepTrial {
  trialId: string
  candidateId: string
  parameterHash: string
  status: 'active' | 'graveyard' | 'killed'
  includedInRawM: true
  includedInEffectiveM: true
  pValue: null
  pValueUnavailableReason: string
  fdrReportStatus: 'not_computed'
  fdrPValuesAvailable: false
  fdrPValueIsPromotionGrade: false
  pitAuditStatus: 'not_implemented'
  pitAuditPromotionGrade: false
  failureCodes: ['FDR_INPUTS_INCOMPLETE', 'PIT_AUDIT_NOT_IMPLEMENTED']
}

export interface OptimizationSweepArtifact {
  schemaVersion: 'cross_sectional_optimizer_sweep.v2'
  generatedAt: string
  experimentId: string
  seed: string
  candidateCount: number
  hardGatePassedCount: number
  allConfigs: SweepResult[]
  topConfigs: SweepResult[]
  rejectedConfigs: SweepResult[]
  trialUniverse: {
    schemaVersion: 'optimizer_trial_universe.v1'
    source: 'optimize_cross_sectional'
    completeForThisSweep: true
    rawM: number
    effectiveM: number
    includesFailedTrials: true
    fdrMethodPrimary: 'BY_raw_m'
    pValueStatus: 'not_computed'
    pValueUnavailableReason: string
    trials: OptimizationSweepTrial[]
  }
  summary: {
    bestWR: SweepResult | undefined
    bestSpread: SweepResult | undefined
    bestSharpe: SweepResult | undefined
  }
}

const DEFAULT_ESTIMATED_ROUND_TRIP_COST_BPS = 28
const MIN_VALID_SIGNALS = 10
const BREAK_EVEN_WIN_RATE = 50
const OPTIMIZER_P_VALUE_UNAVAILABLE_REASON = 'optimizer_sweep_trial_p_value_not_computed_from_complete_oos_distribution'

function evaluateConfig(
  assets: AssetData[],
  lookbackHours: number,
  secondaryLookback: number,
  forwardHours: number,
  mtfWeight: number,
  minSpreadPct: number,
  maxVolPct: number,
): SweepResult {
  const minBars = Math.max(lookbackHours, secondaryLookback, forwardHours) + 2
  const maxI = Math.min(...assets.map(a => a.candles.length)) - forwardHours
  let signals = 0; let wins = 0; let spreadCum = 0; let filtered = 0
  const signalSpreads: number[] = []

  for (let i = minBars; i < maxI; i++) {
    const fwd = i + forwardHours
    const csAssets: CrossSectionalAsset[] = assets.map(({ symbol, candles }) => ({
      symbol,
      currentPrice: candles[i].close,
      returns: {
        [`${lookbackHours}h`]: (candles[i].close / candles[i - lookbackHours].close - 1) * 100,
        [`${secondaryLookback}h`]: i >= secondaryLookback
          ? (candles[i].close / candles[i - secondaryLookback].close - 1) * 100
          : (candles[i].close / candles[0].close - 1) * 100,
        [`${forwardHours}h`]: (candles[fwd].close / candles[i].close - 1) * 100,
      },
      realizedVolPct: computeVol(candles, i, 24),
      avgVolume24h: candles[i].volume,
    }))

    const n = assets.length
    const ranks = evaluateCrossSectionalMomentum(csAssets, {
      lookbackHours,
      secondaryLookbackHours: secondaryLookback,
      topN: Math.max(1, Math.floor(n / 3)),
      bottomN: Math.max(1, Math.floor(n / 3)),
      minUniverseSize: n,
      maxVolPercentile: maxVolPct / 100,
      minSpreadPct,
      requireVolumeConfirmation: n >= 4,
      mtfWeight,
    })

    const longs = ranks.filter(r => r.signal === 1).sort((a, b) => b.confidence - a.confidence)
    const shorts = ranks.filter(r => r.signal === -1).sort((a, b) => b.confidence - a.confidence)

    if (longs.length === 0 || shorts.length === 0) {
      if (ranks.some(r => r.reason.includes('Filtered') || r.reason.includes('spread') || r.reason.includes('threshold'))) {
        filtered++
      }
      continue
    }

    for (const long of longs.slice(0, 1)) {
      for (const short of shorts.slice(0, 1)) {
        if (long.symbol === short.symbol) continue
        signals++
        const lFwd = csAssets.find(a => a.symbol === long.symbol)!.returns[`${forwardHours}h`]
        const sFwd = csAssets.find(a => a.symbol === short.symbol)!.returns[`${forwardHours}h`]
        const s = lFwd - sFwd
        spreadCum += s
        signalSpreads.push(s)
        if (s > 0) wins++
      }
    }
  }

  const wr = signals > 0 ? wins / signals * 100 : 0
  const avgSpread = signals > 0 ? spreadCum / signals : 0
  const sharpe = computeSignalSharpeApprox(signalSpreads)
  const estimatedRoundTripCostBps = DEFAULT_ESTIMATED_ROUND_TRIP_COST_BPS
  const estimatedRoundTripCostPct = estimatedRoundTripCostBps / 100
  const netAvgSpread = avgSpread - estimatedRoundTripCostPct
  const hardGateReasons = evaluateSweepHardGate({
    signals,
    winRate: wr,
    netAvgSpread,
    sharpeApprox: sharpe,
  })

  return {
    lookbackHours, secondaryLookback, mtfWeight, minSpreadPct, maxVolPct, forwardHours,
    signals,
    winRate: wr,
    spreadCum,
    avgSpread,
    sharpeApprox: sharpe,
    estimatedRoundTripCostPct,
    estimatedRoundTripCostBps,
    netAvgSpread,
    netExpectancyPct: netAvgSpread,
    netExpectancyBps: netAvgSpread * 100,
    hardGateStatus: hardGateReasons.length === 0 ? 'pass' : 'fail',
    hardGateReasons,
    rankScore: emptyRankScore(),
    filteredCount: filtered,
    score: 0,
  }
}

function computeSignalSharpeApprox(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1)
  const stdev = Math.sqrt(Math.max(variance, 0))
  if (stdev === 0) {
    if (mean > 0) return Math.sqrt(values.length)
    if (mean < 0) return -Math.sqrt(values.length)
    return 0
  }
  return (mean / stdev) * Math.sqrt(values.length)
}

function evaluateSweepHardGate(input: {
  signals: number
  winRate: number
  netAvgSpread: number
  sharpeApprox: number
}): string[] {
  const reasons: string[] = []
  if (
    !Number.isFinite(input.winRate) ||
    !Number.isFinite(input.netAvgSpread) ||
    !Number.isFinite(input.sharpeApprox)
  ) {
    reasons.push('non_finite_metric')
  }
  if (input.signals < MIN_VALID_SIGNALS) {
    reasons.push(`insufficient_signals:${input.signals}<${MIN_VALID_SIGNALS}`)
  }
  if (input.winRate <= BREAK_EVEN_WIN_RATE) {
    reasons.push(`win_rate_not_above_break_even:${input.winRate.toFixed(2)}<=${BREAK_EVEN_WIN_RATE}`)
  }
  if (input.netAvgSpread <= 0) {
    reasons.push(`non_positive_net_expectancy:${input.netAvgSpread.toFixed(4)}`)
  }
  return reasons
}

function emptyRankScore(): RankScoreComponents {
  return {
    winRate: 0,
    netAvgSpread: 0,
    sharpe: 0,
    signalCount: 0,
    costEfficiency: 0,
  }
}

export function rankNormalizeSweepResults(results: readonly SweepResult[]): SweepResult[] {
  const scored = results.map((result) => ({ ...result, hardGateReasons: [...result.hardGateReasons] }))
  const eligible = scored.filter((result) => result.hardGateStatus === 'pass')
  const rankByMetric = (metric: (result: SweepResult) => number): Map<SweepResult, number> => {
    const values = eligible.map((result) => ({ result, value: metric(result) }))
    return rankPercentiles(values)
  }

  const winRateRank = rankByMetric((result) => result.winRate)
  const netAvgSpreadRank = rankByMetric((result) => result.netAvgSpread)
  const sharpeRank = rankByMetric((result) => result.sharpeApprox)
  const signalCountRank = rankByMetric((result) => result.signals)
  const costEfficiencyRank = rankByMetric((result) =>
    result.estimatedRoundTripCostPct > 0
      ? result.netAvgSpread / result.estimatedRoundTripCostPct
      : result.netAvgSpread,
  )

  return scored.map((result) => {
    if (result.hardGateStatus !== 'pass') {
      return {
        ...result,
        rankScore: emptyRankScore(),
        score: 0,
      }
    }

    const rankScore = {
      winRate: winRateRank.get(result) ?? 0,
      netAvgSpread: netAvgSpreadRank.get(result) ?? 0,
      sharpe: sharpeRank.get(result) ?? 0,
      signalCount: signalCountRank.get(result) ?? 0,
      costEfficiency: costEfficiencyRank.get(result) ?? 0,
    }
    const score =
      rankScore.netAvgSpread * 0.35 +
      rankScore.winRate * 0.25 +
      rankScore.sharpe * 0.2 +
      rankScore.signalCount * 0.1 +
      rankScore.costEfficiency * 0.1

    return {
      ...result,
      rankScore,
      score,
    }
  })
}

function rankPercentiles<T extends object>(values: Array<{ result: T; value: number }>): Map<T, number> {
  const finiteValues = values.filter((item) => Number.isFinite(item.value))
  const out = new Map<T, number>()
  if (finiteValues.length === 0) return out
  if (finiteValues.length === 1) {
    out.set(finiteValues[0].result, 1)
    return out
  }

  const sorted = [...finiteValues].sort((left, right) => right.value - left.value)
  let index = 0
  while (index < sorted.length) {
    let end = index + 1
    while (end < sorted.length && sorted[end].value === sorted[index].value) {
      end++
    }
    const averageRank = (index + end - 1) / 2
    const percentile = 1 - averageRank / (sorted.length - 1)
    for (let tieIndex = index; tieIndex < end; tieIndex++) {
      out.set(sorted[tieIndex].result, percentile)
    }
    index = end
  }
  return out
}

export function parseOptimizerArgs(argv: string[]): OptimizerCliArgs {
  const raw = parseRawArgs(argv)
  const symbols = (raw.get('symbols') ?? defaultPaperUniverseSymbols().join(','))
    .split(',')
    .map((symbol) => symbol.trim())
    .filter(Boolean)

  return {
    seed: raw.get('seed') ?? 'openalice-cross-sectional-v2.6',
    samples: parsePositiveInt(raw.get('samples'), 200, 'samples'),
    dataDir: raw.get('dataDir') ?? join(import.meta.dirname, '..', 'data', 'market', 'multi_assets'),
    runtimeDir: raw.get('runtimeDir') ?? DEFAULT_PROMOTION_V2_RUNTIME_DIR,
    symbols,
    dryRun: parseBoolArg(raw.get('dryRun'), true),
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

function parsePositiveInt(value: string | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`)
  }
  return parsed
}

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

export function createSeededRng(seedInput: string): () => number {
  let state = 2166136261
  for (const char of seedInput) {
    state ^= char.charCodeAt(0)
    state = Math.imul(state, 16777619)
  }
  return () => {
    state += 0x6D2B79F5
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(items: readonly T[], rng: () => number): T {
  return items[Math.floor(rng() * items.length)]
}

async function loadAssets(dataDir: string, symbols: string[]): Promise<AssetData[]> {
  const assets: AssetData[] = []
  for (const symbol of symbols) {
    try {
      assets.push({
        symbol,
        candles: await loadCandles(join(dataDir, paperSymbolToCsvFile(symbol))),
      })
    } catch {
      // Missing symbols are allowed in research discovery, but they cannot
      // contribute to candidate count or executable PnL attribution.
    }
  }
  return assets
}

function buildSchemaMeta(schemaName: string, generatedAt: string): SchemaMeta {
  return {
    schemaName,
    schemaVersion: PROMOTION_V2_SCHEMA_VERSION,
    createdBy: 'optimize:cross-sectional',
    createdAt: generatedAt,
    codeCommit: process.env.OPENALICE_CODE_COMMIT ?? process.env.GIT_COMMIT ?? 'unknown-local',
  }
}

function resultParameterHash(result: SweepResult, seed: string): string {
  return hashJson({
    seed,
    lookbackHours: result.lookbackHours,
    secondaryLookback: result.secondaryLookback,
    forwardHours: result.forwardHours,
    mtfWeight: result.mtfWeight,
    minSpreadPct: result.minSpreadPct,
    maxVolPct: result.maxVolPct,
  })
}

export function buildOptimizationSweepArtifact(input: {
  generatedAt: string
  experimentId: string
  seed: string
  scoredCandidates: SweepResult[]
  ranked: SweepResult[]
  bestWR: SweepResult | undefined
  bestSpread: SweepResult | undefined
  bestSharpe: SweepResult | undefined
}): OptimizationSweepArtifact {
  const topConfigs = input.ranked.slice(0, 20)
  const topParameterHashes = new Set(topConfigs.map((result) => resultParameterHash(result, input.seed)))
  const trials = input.scoredCandidates.map((candidate) => {
    const parameterHash = resultParameterHash(candidate, input.seed)
    const candidateId = `cross_sectional_v2_${parameterHash.slice(0, 16)}`
    const status: OptimizationSweepTrial['status'] =
      candidate.hardGateStatus === 'fail'
        ? 'killed'
        : topParameterHashes.has(parameterHash)
          ? 'active'
          : 'graveyard'
    return {
      trialId: `optimization_sweep:${input.experimentId}:candidate:${parameterHash}`,
      candidateId,
      parameterHash,
      status,
      includedInRawM: true,
      includedInEffectiveM: true,
      pValue: null,
      pValueUnavailableReason: OPTIMIZER_P_VALUE_UNAVAILABLE_REASON,
      fdrReportStatus: 'not_computed',
      fdrPValuesAvailable: false,
      fdrPValueIsPromotionGrade: false,
      pitAuditStatus: 'not_implemented',
      pitAuditPromotionGrade: false,
      failureCodes: ['FDR_INPUTS_INCOMPLETE', 'PIT_AUDIT_NOT_IMPLEMENTED'],
    }
  })
  return {
    schemaVersion: 'cross_sectional_optimizer_sweep.v2',
    generatedAt: input.generatedAt,
    experimentId: input.experimentId,
    seed: input.seed,
    candidateCount: input.scoredCandidates.length,
    hardGatePassedCount: input.scoredCandidates.filter((result) => result.hardGateStatus === 'pass').length,
    allConfigs: input.scoredCandidates,
    topConfigs,
    rejectedConfigs: input.scoredCandidates.filter((result) => result.hardGateStatus === 'fail'),
    trialUniverse: {
      schemaVersion: 'optimizer_trial_universe.v1',
      source: 'optimize_cross_sectional',
      completeForThisSweep: true,
      rawM: trials.length,
      effectiveM: new Set(trials.map((trial) => trial.parameterHash)).size,
      includesFailedTrials: true,
      fdrMethodPrimary: 'BY_raw_m',
      pValueStatus: 'not_computed',
      pValueUnavailableReason: OPTIMIZER_P_VALUE_UNAVAILABLE_REASON,
      trials,
    },
    summary: {
      bestWR: input.bestWR,
      bestSpread: input.bestSpread,
      bestSharpe: input.bestSharpe,
    },
  }
}

export function buildCandidateRegistries(input: {
  generatedAt: string
  experimentId: string
  seed: string
  candidates: SweepResult[]
  best: SweepResult | undefined
}): { candidateRegistry: CandidateRegistry; graveyard: CandidateRegistry } {
  const bestHash = input.best ? resultParameterHash(input.best, input.seed) : null
  const entries: CandidateRegistryEntry[] = input.candidates.map((candidate, index) => {
    const parameterHash = resultParameterHash(candidate, input.seed)
    return {
      candidateId: `cross_sectional_v2_${parameterHash.slice(0, 16)}`,
      experimentId: input.experimentId,
      strategyId: 'cross_sectional_v2',
      generatedAt: input.generatedAt,
      scriptName: 'optimize:cross-sectional',
      parameterHash,
      status: parameterHash === bestHash ? 'active' : 'graveyard',
    }
  })
  const graveyardEntries = entries.filter((entry) => entry.status === 'graveyard')
  const candidateRegistry: CandidateRegistry = {
    schemaMeta: buildSchemaMeta('candidate_registry', input.generatedAt),
    registryId: `cross-sectional-v2-${input.generatedAt.replace(/[:.]/g, '-')}`,
    candidateCount: entries.length,
    entries,
    graveyardCandidateCount: graveyardEntries.length,
  }
  candidateRegistry.registrySha256 = hashJson({
    registryId: candidateRegistry.registryId,
    entries: candidateRegistry.entries,
    candidateCount: candidateRegistry.candidateCount,
    graveyardCandidateCount: candidateRegistry.graveyardCandidateCount,
  })

  const graveyard: CandidateRegistry = {
    schemaMeta: buildSchemaMeta('graveyard', input.generatedAt),
    registryId: `${candidateRegistry.registryId}-graveyard`,
    candidateCount: graveyardEntries.length,
    entries: graveyardEntries,
    graveyardCandidateCount: graveyardEntries.length,
  }
  graveyard.registrySha256 = hashJson({
    registryId: graveyard.registryId,
    entries: graveyard.entries,
    candidateCount: graveyard.candidateCount,
    graveyardCandidateCount: graveyard.graveyardCandidateCount,
  })

  return { candidateRegistry, graveyard }
}

async function writeCandidateRegistries(
  runtimeDir: string,
  registries: { candidateRegistry: CandidateRegistry; graveyard: CandidateRegistry },
): Promise<void> {
  await mkdir(runtimeDir, { recursive: true })
  await writeFile(
    join(runtimeDir, promotionV2ArtifactFileNames.candidateRegistry),
    `${JSON.stringify(registries.candidateRegistry, null, 2)}\n`,
    'utf-8',
  )
  await writeFile(
    join(runtimeDir, promotionV2ArtifactFileNames.graveyard),
    `${JSON.stringify(registries.graveyard, null, 2)}\n`,
    'utf-8',
  )
}

async function writeBestConfig(input: {
  generatedAt: string
  experimentId: string
  dataRange: { start: string | null; end: string | null }
  assetCount: number
  best: SweepResult
}): Promise<void> {
  const dir = join(import.meta.dirname, '..', 'data', 'research')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'best_config.json'),
    `${JSON.stringify({
      strategyId: 'cross_sectional_v2',
      experimentId: input.experimentId,
      discoveredAt: input.generatedAt,
      dataRange: input.dataRange,
      assetCount: input.assetCount,
      config: input.best,
    }, null, 2)}\n`,
    'utf-8',
  )
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseOptimizerArgs(argv)
  const rng = createSeededRng(args.seed)
  const assets = await loadAssets(args.dataDir, args.symbols)
  if (assets.length < 2) {
    throw new Error(`Need at least 2 assets for cross-sectional optimization, got ${assets.length}`)
  }
  const generatedAt = new Date().toISOString()
  const experimentId = `cross-sectional-v2-${generatedAt.replace(/[:.]/g, '-')}`
  console.log(`Assets: ${assets.length} | Bars: ${assets[0].candles.length}\n`)
  console.log(`Seed: ${args.seed} | Samples: ${args.samples}\n`)

  // Parameter sweep space
  const sweepSpace = {
    lookbackHours: [72, 120, 168, 240, 336, 504, 672], // 3d to 28d
    secondaryLookback: [336, 504, 720, 1008],
    forwardHours: [12, 24, 48],
    mtfWeight: [0, 0.15, 0.25, 0.35, 0.50],
    minSpreadPct: [0, 1, 2, 3, 5],
    maxVolPct: [80, 85, 90, 95, 99],
  }

  const candidates: SweepResult[] = []

  // Sample-based random search for speed (not exhaustive)
  for (let s = 0; s < args.samples; s++) {
    const config: [number, number, number, number, number, number] = [
      pick(sweepSpace.lookbackHours, rng),
      pick(sweepSpace.secondaryLookback, rng),
      pick(sweepSpace.mtfWeight, rng),
      pick(sweepSpace.minSpreadPct, rng),
      pick(sweepSpace.maxVolPct, rng),
      pick(sweepSpace.forwardHours, rng),
    ]
    const [lookback, secLookback, mtfW, minSpread, maxVol, fwd] = config

    // Skip if secondary < primary
    if (secLookback < lookback) continue

    const result = evaluateConfig(assets, lookback, secLookback, fwd, mtfW, minSpread, maxVol)
    candidates.push(result)

    if (candidates.length % 20 === 0) process.stdout.write('.')
  }
  const scoredCandidates = rankNormalizeSweepResults(candidates)
  const results = scoredCandidates.filter((result) => result.hardGateStatus === 'pass')
  console.log(`\nEvaluated ${candidates.length} configs, ${results.length} passed hard gates\n`)

  // Rank only research-validation candidates that pass hard gates. No paper
  // performance input is used to choose the optimizer winner.
  const ranked = [...results].sort((a, b) => {
    return b.score - a.score
  })

  console.log('BEST CONFIGS (ranked by composite)\n')

  for (let i = 0; i < Math.min(10, ranked.length); i++) {
    const r = ranked[i]
    console.log(`#${i + 1} | LB: ${r.lookbackHours}h(${r.lookbackHours/24}d) | 2nd: ${r.secondaryLookback}h | Fwd: ${r.forwardHours}h | MTF: ${r.mtfWeight} | Spread>=${r.minSpreadPct}% | Vol<=${r.maxVolPct}%`)
    console.log(`     Signals: ${r.signals} | WR: ${r.winRate.toFixed(1)}% | CumSpread: ${r.spreadCum.toFixed(1)}% | AvgSpread: ${r.avgSpread.toFixed(3)}% | NetAvg: ${r.netAvgSpread.toFixed(3)}% | Cost: ${r.estimatedRoundTripCostBps.toFixed(1)}bps | Score: ${r.score.toFixed(3)}`)
    console.log()
  }

  const dataRange = {
    start: new Date(Math.min(...assets.map(asset => asset.candles[0].time))).toISOString(),
    end: new Date(Math.max(...assets.map(asset => asset.candles[asset.candles.length - 1].time))).toISOString(),
  }
  const registries = buildCandidateRegistries({
    generatedAt,
    experimentId,
    seed: args.seed,
    candidates: scoredCandidates,
    best: ranked[0],
  })
  if (!args.dryRun) {
    await writeCandidateRegistries(args.runtimeDir, registries)
  }

  // Find best by win rate
  const bestWR = [...results].sort((a, b) => b.winRate - a.winRate)[0]
  if (bestWR) {
    console.log(`Best Win Rate: ${bestWR.winRate.toFixed(1)}% at LB=${bestWR.lookbackHours}h Fwd=${bestWR.forwardHours}h MTF=${bestWR.mtfWeight} Spread>=${bestWR.minSpreadPct}%`)
  }

  // Find best by cumulative spread
  const bestSpread = [...results].sort((a, b) => b.spreadCum - a.spreadCum)[0]
  if (bestSpread) {
    console.log(`Best Spread: ${bestSpread.spreadCum.toFixed(1)}% at LB=${bestSpread.lookbackHours}h Fwd=${bestSpread.forwardHours}h MTF=${bestSpread.mtfWeight}`)
  }

  // Find best by Sharpe
  const bestSharpe = [...results].filter(r => r.signals > 50).sort((a, b) => b.sharpeApprox - a.sharpeApprox)[0]
  if (bestSharpe) console.log(`Best Sharpe: ${bestSharpe.sharpeApprox.toFixed(2)} at LB=${bestSharpe.lookbackHours}h Fwd=${bestSharpe.forwardHours}h`)

  if (ranked[0] && !args.dryRun) {
    await writeBestConfig({
      generatedAt,
      experimentId,
      dataRange,
      assetCount: assets.length,
      best: ranked[0],
    })
  }

  const sweepArtifact = buildOptimizationSweepArtifact({
    generatedAt,
    experimentId,
    seed: args.seed,
    scoredCandidates,
    ranked,
    bestWR,
    bestSpread,
    bestSharpe,
  })
  if (args.dryRun) {
    console.log('\nDry run: optimizer artifacts were not written.')
    console.log(JSON.stringify({
      schemaVersion: sweepArtifact.schemaVersion,
      experimentId,
      candidateCount: sweepArtifact.candidateCount,
      hardGatePassedCount: sweepArtifact.hardGatePassedCount,
      trialUniverse: {
        rawM: sweepArtifact.trialUniverse.rawM,
        effectiveM: sweepArtifact.trialUniverse.effectiveM,
        pValueStatus: sweepArtifact.trialUniverse.pValueStatus,
      },
    }, null, 2))
  } else {
    // Save results.
    const outDir = join(import.meta.dirname, '..', 'data', 'research', 'optimization')
    await mkdir(outDir, { recursive: true })
    await writeFile(
      join(outDir, `sweep_${generatedAt.replace(/[:.]/g, '-')}.json`),
      JSON.stringify(sweepArtifact, null, 2),
    )
    console.log(`\nSaved to ${outDir}`)
    console.log(`Candidate registry: ${join(args.runtimeDir, promotionV2ArtifactFileNames.candidateRegistry)}`)
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
