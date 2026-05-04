/**
 * Pro policy pre/post paper-trade window analysis.
 *
 * This compares realized historical paper trades before and after a Pro policy
 * boundary. It is not a portfolio counterfactual: post-policy rows are only
 * trades whose own open-time metadata places them after the policy boundary.
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

export interface AnalyzeProPolicyWindowArgs {
  paperDir: string
  policyPath: string
  outputPath: string
  lookbackHours: number | null
}

export interface ProPolicyBoundary {
  path: string
  found: boolean
  generatedAt: string | null
  generatedAtMs: number | null
  proEpoch: number | null
  generation: number | null
  verdict: string | null
  autoApplyPolicy: string | null
}

export type PolicyWindow = 'pre' | 'post' | 'excluded'

export type ContextCoverageBucket =
  | 'ok'
  | 'stale'
  | 'timeout'
  | 'legacy_missing'
  | 'new_missing'

export interface NormalizedTrade {
  tradeId: string
  source: string
  lane: string
  symbol: string
  side: 'long' | 'short' | 'unknown'
  openTs: string | null
  closeTs: string
  pnlPct: number
  pnlUsd: number | null
  closeReason: string
  rawReason: string | null
  contextSnapshotId: string | null
  decisionTime: string | null
  marketDataWatermarkAtDecisionTime: string | null
  watermark: string | null
  featuresAvailableAtDecisionTime: boolean | null
  featureSchemaVersion: string | null
  flashContextStatus: string | null
  contextStatus: string | null
  contextReason: string | null
  contextCoverageStatus: string | null
  contextCoverageReason: string | null
  contextGenerationAtOpen: number | null
  proEpochAtOpen: number | null
  flashConfidenceLowAtOpen: number | null
  ruleScoreAtOpen: number | null
  marketIntelTriggerAtOpen: string | null
  contextCoverageBucket: ContextCoverageBucket
}

export interface WindowAssignment {
  trade: NormalizedTrade
  window: PolicyWindow
  splitBasis:
    | 'openTs_vs_policy_generatedAt'
    | 'proEpochAtOpen_vs_policy_proEpoch'
    | 'contextGenerationAtOpen_vs_policy_generation'
    | 'unclassified'
}

export interface WindowStats {
  key: 'pre' | 'post'
  count: number
  wins: number
  losses: number
  flats: number
  winRate: number
  profitFactor: number | null
  expectancyPct: number
  totalPnlPct: number
  avgPnlPct: number
  stopLossCount: number
  stopLossLossSharePct: number
  contextCoverageBuckets: Record<ContextCoverageBucket, number>
  byRuleScoreBucket: Record<string, number>
  byFlashConfidenceLowBucket: Record<string, number>
}

export interface ProPolicyWindowReport {
  schemaVersion: 1
  generatedAt: string
  counterfactualType: 'historical_baseline'
  inputs: AnalyzeProPolicyWindowArgs
  policy: ProPolicyBoundary
  coverage: {
    closedTradesLoaded: number
    duplicateTradesSkipped: number
    preTrades: number
    postTrades: number
    excludedTrades: number
    splitBasisCounts: Record<WindowAssignment['splitBasis'], number>
  }
  windows: {
    pre: WindowStats
    post: WindowStats
  }
  delta: {
    winRatePctPoints: number | null
    profitFactor: number | null
    expectancyPct: number | null
    stopLossLossSharePctPoints: number | null
  }
  notes: string[]
}

type RawRecord = Record<string, unknown>

const DEFAULT_PAPER_DIR = 'data/paper_trading'
const DEFAULT_POLICY_PATH = 'data/runtime/pro_risk_policy.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/runtime/pro_policy_window.latest.json'
const DEFAULT_CONTEXT_CUTOVER_TS = '2026-05-02T00:00:00.000Z'
const CONTEXT_BUCKETS: ContextCoverageBucket[] = ['ok', 'stale', 'timeout', 'legacy_missing', 'new_missing']

export function parseAnalyzeProPolicyWindowArgs(argv: string[]): AnalyzeProPolicyWindowArgs {
  const raw = parseRawArgs(argv)
  return {
    paperDir: raw.get('paperDir') ?? DEFAULT_PAPER_DIR,
    policyPath: raw.get('policyPath') ?? DEFAULT_POLICY_PATH,
    outputPath: raw.get('outputPath') ?? DEFAULT_OUTPUT_PATH,
    lookbackHours: parseNullablePositiveNumber(raw.get('lookbackHours')),
  }
}

export async function analyzeProPolicyWindow(
  args: AnalyzeProPolicyWindowArgs,
): Promise<ProPolicyWindowReport> {
  const startedAt = new Date()
  const paperDir = resolve(args.paperDir)
  const policyPath = resolve(args.policyPath)
  const outputPath = resolve(args.outputPath)
  const policy = await loadPolicyBoundary(policyPath)
  const loaded = await loadClosedTrades(paperDir, args.lookbackHours)
  const assignments = loaded.trades.map(trade => assignPolicyWindow(trade, policy))
  const preTrades = assignments.filter(item => item.window === 'pre').map(item => item.trade)
  const postTrades = assignments.filter(item => item.window === 'post').map(item => item.trade)
  const excludedTrades = assignments.filter(item => item.window === 'excluded').length
  const splitBasisCounts = countSplitBasis(assignments)
  const pre = computeWindowStats('pre', preTrades)
  const post = computeWindowStats('post', postTrades)
  const delta = computeWindowDelta(pre, post)

  const report: ProPolicyWindowReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    counterfactualType: 'historical_baseline',
    inputs: {
      paperDir,
      policyPath,
      outputPath,
      lookbackHours: args.lookbackHours,
    },
    policy,
    coverage: {
      closedTradesLoaded: loaded.trades.length,
      duplicateTradesSkipped: loaded.duplicateTradesSkipped,
      preTrades: preTrades.length,
      postTrades: postTrades.length,
      excludedTrades,
      splitBasisCounts,
    },
    windows: { pre, post },
    delta,
    notes: [
      'counterfactualType=historical_baseline: this report compares realized pre/post paper trades only',
      'no synthetic portfolio-level counterfactual or retroactive Pro filtering is applied',
      'post-policy trades are identified from policy generatedAt/proEpoch first, then trade proEpoch/contextGeneration metadata when needed',
      ...(pre.count === 0 || post.count === 0
        ? ['pre/post delta is null because at least one realized window has zero trades']
        : []),
    ],
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  await writeEvidenceManifestForArtifact({
    job: 'pro_policy_window',
    artifactPath: outputPath,
    startedAt,
    finishedAt: new Date(),
    exitCode: 0,
    businessStatus: pre.count > 0 && post.count > 0 ? 'pass' : 'warn',
    recordsIn: loaded.trades.length,
    recordsOut: pre.count + post.count,
    errorClass: pre.count === 0 || post.count === 0 ? 'empty_policy_comparison_window' : null,
  })
  return report
}

export async function loadPolicyBoundary(path: string): Promise<ProPolicyBoundary> {
  const resolved = resolve(path)
  const raw = await readJson(resolved)
  if (!raw) {
    return {
      path: resolved,
      found: false,
      generatedAt: null,
      generatedAtMs: null,
      proEpoch: null,
      generation: null,
      verdict: null,
      autoApplyPolicy: null,
    }
  }
  const generatedAt = stringOrNull(raw.generatedAt)
  const generatedAtMs = generatedAt == null ? null : parseFiniteTime(generatedAt)
  return {
    path: resolved,
    found: true,
    generatedAt,
    generatedAtMs,
    proEpoch: nonnegativeNumberOrNull(raw.proEpoch),
    generation: nonnegativeNumberOrNull(raw.generation),
    verdict: stringOrNull(raw.verdict),
    autoApplyPolicy: stringOrNull(raw.autoApplyPolicy),
  }
}

export async function loadClosedTrades(
  paperDir: string,
  lookbackHours: number | null,
): Promise<{ trades: NormalizedTrade[]; duplicateTradesSkipped: number }> {
  const cutoffMs = lookbackHours == null ? null : Date.now() - lookbackHours * 60 * 60 * 1000
  const trades: NormalizedTrade[] = []
  const seen = new Set<string>()
  let duplicateTradesSkipped = 0

  function add(trade: NormalizedTrade | null): void {
    if (!trade) return
    const closeMs = parseFiniteTime(trade.closeTs)
    if (cutoffMs != null && closeMs != null && closeMs < cutoffMs) return
    if (seen.has(trade.tradeId)) {
      duplicateTradesSkipped += 1
      return
    }
    seen.add(trade.tradeId)
    trades.push(trade)
  }

  for (const record of await readJsonl(join(paperDir, 'paper_trade_result.jsonl'))) {
    add(normalizeTradeRecord(record, 'paper_trade_result.jsonl', 'paper_result'))
  }
  for (const path of await discoverAccountJsonFiles(paperDir)) {
    const account = await readJson(path)
    const history = Array.isArray(account?.tradeHistory) ? account.tradeHistory : []
    for (const record of history) {
      if (isRecord(record)) add(normalizeTradeRecord(record, path, 'account_history'))
    }
  }
  for (const path of await discoverTradeLogFiles(paperDir)) {
    for (const record of await readJsonl(path)) {
      add(normalizeTradeRecord(record, path, 'account_history'))
    }
  }

  trades.sort((a, b) => {
    const aMs = parseFiniteTime(a.closeTs) ?? 0
    const bMs = parseFiniteTime(b.closeTs) ?? 0
    return aMs - bMs || a.tradeId.localeCompare(b.tradeId)
  })
  return { trades, duplicateTradesSkipped }
}

export function assignPolicyWindow(
  trade: NormalizedTrade,
  policy: ProPolicyBoundary,
): WindowAssignment {
  const openMs = trade.openTs == null ? null : parseFiniteTime(trade.openTs)
  if (openMs != null && policy.generatedAtMs != null) {
    return {
      trade,
      window: openMs >= policy.generatedAtMs ? 'post' : 'pre',
      splitBasis: 'openTs_vs_policy_generatedAt',
    }
  }

  if (trade.proEpochAtOpen != null && policy.proEpoch != null && policy.proEpoch > 0) {
    return {
      trade,
      window: trade.proEpochAtOpen >= policy.proEpoch ? 'post' : 'pre',
      splitBasis: 'proEpochAtOpen_vs_policy_proEpoch',
    }
  }

  if (trade.contextGenerationAtOpen != null && policy.generation != null) {
    return {
      trade,
      window: trade.contextGenerationAtOpen >= policy.generation ? 'post' : 'pre',
      splitBasis: 'contextGenerationAtOpen_vs_policy_generation',
    }
  }

  return { trade, window: 'excluded', splitBasis: 'unclassified' }
}

export function computeWindowStats(key: 'pre' | 'post', trades: NormalizedTrade[]): WindowStats {
  const wins = trades.filter(trade => trade.pnlPct > 0).length
  const losses = trades.filter(trade => trade.pnlPct < 0).length
  const flats = trades.length - wins - losses
  const winPnl = trades.filter(trade => trade.pnlPct > 0).reduce((sum, trade) => sum + trade.pnlPct, 0)
  const lossPnl = trades.filter(trade => trade.pnlPct < 0).reduce((sum, trade) => sum + Math.abs(trade.pnlPct), 0)
  const stopLossTrades = trades.filter(trade => trade.closeReason === 'stop_loss')
  const stopLossLossPct = stopLossTrades
    .filter(trade => trade.pnlPct < 0)
    .reduce((sum, trade) => sum + Math.abs(trade.pnlPct), 0)

  return {
    key,
    count: trades.length,
    wins,
    losses,
    flats,
    winRate: trades.length > 0 ? wins / trades.length * 100 : 0,
    profitFactor: lossPnl > 0 ? winPnl / lossPnl : (winPnl > 0 ? null : 0),
    expectancyPct: trades.length > 0 ? sum(trades.map(trade => trade.pnlPct)) / trades.length : 0,
    totalPnlPct: sum(trades.map(trade => trade.pnlPct)),
    avgPnlPct: trades.length > 0 ? sum(trades.map(trade => trade.pnlPct)) / trades.length : 0,
    stopLossCount: stopLossTrades.length,
    stopLossLossSharePct: lossPnl > 0 ? stopLossLossPct / lossPnl * 100 : 0,
    contextCoverageBuckets: countContextBuckets(trades),
    byRuleScoreBucket: countBuckets(trades.map(trade => bucketScore(trade.ruleScoreAtOpen))),
    byFlashConfidenceLowBucket: countBuckets(trades.map(trade => bucketScore(trade.flashConfidenceLowAtOpen))),
  }
}

export function computeWindowDelta(
  pre: WindowStats,
  post: WindowStats,
): ProPolicyWindowReport['delta'] {
  if (pre.count === 0 || post.count === 0) {
    return {
      winRatePctPoints: null,
      profitFactor: null,
      expectancyPct: null,
      stopLossLossSharePctPoints: null,
    }
  }
  return {
    winRatePctPoints: post.winRate - pre.winRate,
    profitFactor: pre.profitFactor != null && post.profitFactor != null
      ? post.profitFactor - pre.profitFactor
      : null,
    expectancyPct: post.expectancyPct - pre.expectancyPct,
    stopLossLossSharePctPoints: post.stopLossLossSharePct - pre.stopLossLossSharePct,
  }
}

function normalizeTradeRecord(
  record: RawRecord,
  source: string,
  sourceKind: 'paper_result' | 'account_history',
): NormalizedTrade | null {
  const closeTs = stringOrNull(record.closeTs ?? record.exitTime)
  const pnlPct = numberOrNull(record.pnlPct)
  if (!closeTs || pnlPct == null) return null
  const rawReason = stringOrNull(record.closeReason ?? record.reason)
  const closeReason = normalizeCloseReason(rawReason)
  const contextGenerationAtOpen = nonnegativeNumberOrNull(record.contextGenerationAtOpen)
  const flashConfidenceLowAtOpen = numberOrNull(record.flashConfidenceLowAtOpen)
  const ruleScoreAtOpen = numberOrNull(record.ruleScoreAtOpen ?? record.signalConfidence ?? record.confidence)
  const priceStale = booleanOrNull(record.priceStale)
  const contextSnapshotId = stringOrNull(record.contextSnapshotId)
  const decisionTime = stringOrNull(record.decisionTime)
  const marketDataWatermarkAtDecisionTime = stringOrNull(record.marketDataWatermarkAtDecisionTime)
  const watermark = stringOrNull(record.watermark)
  const featuresAvailableAtDecisionTime = booleanOrNull(record.featuresAvailableAtDecisionTime)
  const featureSchemaVersion = stringOrNull(record.featureSchemaVersion)
  const flashContextStatus = stringOrNull(record.flashContextStatus)
  const contextStatus = stringOrNull(record.contextStatus)
  const contextReason = stringOrNull(record.contextReason)
  const contextCoverageStatus = stringOrNull(record.contextCoverageStatus)
  const contextCoverageReason = stringOrNull(record.contextCoverageReason)
  const openTs = stringOrNull(record.openTs ?? record.entryTime)

  return {
    tradeId: stringOrNull(record.tradeId ?? record.id) ?? `${source}:${stringOrNull(record.symbol) ?? 'unknown'}:${closeTs}`,
    source,
    lane: stringOrNull(record.lane) ?? inferLane(record, source),
    symbol: stringOrNull(record.symbol) ?? 'unknown',
    side: parseSide(record.side ?? record.direction),
    openTs,
    closeTs,
    pnlPct,
    pnlUsd: numberOrNull(record.pnlUsd ?? record.pnl),
    closeReason,
    rawReason,
    contextSnapshotId,
    decisionTime,
    marketDataWatermarkAtDecisionTime,
    watermark,
    featuresAvailableAtDecisionTime,
    featureSchemaVersion,
    flashContextStatus,
    contextStatus,
    contextReason,
    contextCoverageStatus,
    contextCoverageReason,
    contextGenerationAtOpen,
    proEpochAtOpen: nonnegativeNumberOrNull(record.proEpochAtOpen),
    flashConfidenceLowAtOpen,
    ruleScoreAtOpen,
    marketIntelTriggerAtOpen: stringOrNull(record.marketIntelTriggerAtOpen),
    contextCoverageBucket: classifyContextCoverage({
      sourceKind,
      contextCoverageStatus,
      openTs,
      closeReason,
      rawReason,
      priceStale,
      contextSnapshotId,
      decisionTime,
      marketDataWatermarkAtDecisionTime,
      watermark,
      featuresAvailableAtDecisionTime,
      featureSchemaVersion,
      flashContextStatus,
      contextStatus,
      contextGenerationAtOpen,
      flashConfidenceLowAtOpen,
    }),
  }
}

function classifyContextCoverage(input: {
  sourceKind: 'paper_result' | 'account_history'
  contextCoverageStatus: string | null
  openTs: string | null
  closeReason: string
  rawReason: string | null
  priceStale: boolean | null
  contextSnapshotId: string | null
  decisionTime: string | null
  marketDataWatermarkAtDecisionTime: string | null
  watermark: string | null
  featuresAvailableAtDecisionTime: boolean | null
  featureSchemaVersion: string | null
  flashContextStatus: string | null
  contextStatus: string | null
  contextGenerationAtOpen: number | null
  flashConfidenceLowAtOpen: number | null
}): ContextCoverageBucket {
  const explicit = normalizeExplicitContextCoverageStatus(input.contextCoverageStatus)
  if (explicit) return explicit
  const reason = `${input.closeReason} ${input.rawReason ?? ''}`.toLowerCase()
  if (input.closeReason === 'stale_context' || input.priceStale === true || reason.includes('stale_context')) return 'stale'
  if (input.closeReason === 'forced_exit_timeout' || reason.includes('timeout')) return 'timeout'
  if (hasCompleteDecisionTimeContext(input)) return 'ok'
  if (input.sourceKind === 'account_history') return 'legacy_missing'
  return isAfterContextCutover(input.openTs) ? 'new_missing' : 'legacy_missing'
}

function normalizeExplicitContextCoverageStatus(status: string | null): ContextCoverageBucket | null {
  switch (status) {
    case 'ok':
      return 'ok'
    case 'stale':
      return 'stale'
    case 'timeout':
      return 'timeout'
    case 'legacy_missing':
      return 'legacy_missing'
    case 'partial_missing':
      return 'new_missing'
    default:
      return null
  }
}

function isAfterContextCutover(openTs: string | null): boolean {
  const cutoverMs = Date.parse(process.env.OPENALICE_CONTEXT_CUTOVER_TS ?? DEFAULT_CONTEXT_CUTOVER_TS)
  const openMs = openTs ? Date.parse(openTs) : Number.NaN
  if (!Number.isFinite(cutoverMs) || !Number.isFinite(openMs)) return true
  return openMs >= cutoverMs
}

function hasCompleteDecisionTimeContext(input: {
  contextSnapshotId: string | null
  decisionTime: string | null
  marketDataWatermarkAtDecisionTime: string | null
  watermark: string | null
  featuresAvailableAtDecisionTime: boolean | null
  featureSchemaVersion: string | null
  flashContextStatus: string | null
  contextStatus: string | null
  contextGenerationAtOpen: number | null
  flashConfidenceLowAtOpen: number | null
}): boolean {
  const hasWatermark = input.marketDataWatermarkAtDecisionTime != null || input.watermark != null
  const flashStatusOk = input.flashContextStatus != null || input.contextStatus != null
  return Boolean(
    input.contextSnapshotId &&
    input.decisionTime &&
    hasWatermark &&
    input.featuresAvailableAtDecisionTime === true &&
    input.featureSchemaVersion === 'paper_open_context.v3' &&
    flashStatusOk &&
    input.contextGenerationAtOpen != null &&
    input.flashConfidenceLowAtOpen != null,
  )
}

function countSplitBasis(assignments: WindowAssignment[]): Record<WindowAssignment['splitBasis'], number> {
  const out: Record<WindowAssignment['splitBasis'], number> = {
    openTs_vs_policy_generatedAt: 0,
    proEpochAtOpen_vs_policy_proEpoch: 0,
    contextGenerationAtOpen_vs_policy_generation: 0,
    unclassified: 0,
  }
  for (const item of assignments) out[item.splitBasis] += 1
  return out
}

function countContextBuckets(trades: NormalizedTrade[]): Record<ContextCoverageBucket, number> {
  const out = Object.fromEntries(CONTEXT_BUCKETS.map(bucket => [bucket, 0])) as Record<ContextCoverageBucket, number>
  for (const trade of trades) out[trade.contextCoverageBucket] += 1
  return out
}

function countBuckets(values: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const value of values) out[value] = (out[value] ?? 0) + 1
  return out
}

function bucketScore(value: number | null): string {
  if (value == null) return 'missing'
  if (value < 0.2) return '<0.2'
  if (value < 0.4) return '0.2-0.4'
  if (value < 0.6) return '0.4-0.6'
  if (value < 0.8) return '0.6-0.8'
  return '>=0.8'
}

function normalizeCloseReason(value: string | null): string {
  const text = (value ?? '').toLowerCase()
  if (!text) return 'unknown'
  if (text.includes('holding_expired') || text.includes('holding period expired') || text.includes('hold expired')) return 'holding_expired'
  if (text.includes('take_profit') || text.includes('take profit')) return 'take_profit'
  if (text.includes('stop_loss') || text.includes('stop loss')) return 'stop_loss'
  if (text.includes('liquidat')) return 'liquidation'
  if (text.includes('stale_context')) return 'stale_context'
  if (text.includes('forced_exit_timeout')) return 'forced_exit_timeout'
  if (text.includes('signal')) return 'signal'
  return text.replace(/[^a-z0-9_ -]+/g, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'unknown'
}

function inferLane(record: RawRecord, source: string): string {
  const explicit = stringOrNull(record.lane)
  if (explicit) return explicit
  const accountId = stringOrNull(record.accountId) ?? inferAccountIdFromPath(source)
  const leverage = numberOrNull(record.leverage)
  const path = source.toLowerCase()
  if (path.includes('account_ms')) return (leverage ?? 0) >= 100 ? 'microstructure_100x' : 'microstructure_10x'
  if (path.includes('account_vb')) {
    if ((leverage ?? 0) >= 10) return 'volume_breakout_10x'
    if ((leverage ?? 0) >= 3) return 'volume_breakout_3x'
    return 'volume_breakout_1x'
  }
  if (accountId.includes('stress_10x')) return 'cross_sectional_10x'
  if (accountId.includes('liquidation_probe_100x')) return 'cross_sectional_100x'
  return 'cross_sectional'
}

async function discoverAccountJsonFiles(paperDir: string): Promise<string[]> {
  const files: string[] = []
  for (const name of await safeReaddir(paperDir)) {
    if (/^account.*\.json$/.test(name)) files.push(join(paperDir, name))
  }
  const accountsDir = join(paperDir, 'accounts')
  for (const account of await safeReaddir(accountsDir)) {
    const path = join(accountsDir, account, 'account.json')
    if (existsSync(path)) files.push(path)
  }
  return files.sort()
}

async function discoverTradeLogFiles(paperDir: string): Promise<string[]> {
  const files: string[] = []
  const rootLog = join(paperDir, 'trade_log.jsonl')
  if (existsSync(rootLog)) files.push(rootLog)
  const accountsDir = join(paperDir, 'accounts')
  for (const account of await safeReaddir(accountsDir)) {
    const path = join(accountsDir, account, 'trade_log.jsonl')
    if (existsSync(path)) files.push(path)
  }
  return files.sort()
}

function inferAccountIdFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const accountMatch = /\/accounts\/([^/]+)\//.exec(normalized)
  if (accountMatch?.[1]) return accountMatch[1]
  const fileMatch = /account_([^/.]+)\.json$/.exec(normalized)
  return fileMatch?.[1] ?? 'unknown'
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
      // Ignore malformed JSONL rows so diagnostics can run on partial logs.
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
    if (!next || next.startsWith('--')) out.set(withoutPrefix, 'true')
    else {
      out.set(withoutPrefix, next)
      i += 1
    }
  }
  return out
}

function parseNullablePositiveNumber(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function parseFiniteTime(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseSide(value: unknown): 'long' | 'short' | 'unknown' {
  const text = typeof value === 'string' ? value.toLowerCase() : ''
  if (text === 'long' || text === 'buy') return 'long'
  if (text === 'short' || text === 'sell') return 'short'
  return 'unknown'
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nonnegativeNumberOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value)
  return parsed != null && parsed >= 0 ? parsed : null
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function isRecord(value: unknown): value is RawRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  analyzeProPolicyWindow(parseAnalyzeProPolicyWindowArgs(process.argv.slice(2)))
    .then(report => {
      console.log(JSON.stringify({
        status: 'ok',
        outputPath: report.inputs.outputPath,
        preTrades: report.coverage.preTrades,
        postTrades: report.coverage.postTrades,
        counterfactualType: report.counterfactualType,
      }, null, 2))
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
