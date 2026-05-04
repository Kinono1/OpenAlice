/**
 * Paper-only retrospective replay for microstructure_100x stop-loss clusters.
 *
 * This script never changes strategy/runtime state. It reads closed paper trades
 * from the existing paper result/account history loader and compares simple
 * diagnostic variants against the realized microstructure_100x baseline.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import {
  loadClosedTrades,
  type NormalizedPaperTrade,
} from './analyze_paper_pnl.js'

export type ReplayVariantName =
  | 'baseline'
  | 'disable_100x'
  | 'cap_leverage_25x'
  | 'cap_leverage_10x'
  | 'stress_stop_loss_loss_1_5x'

export interface MicrostructureStoplossReplayArgs {
  paperDir: string
  outputPath: string | null
  lookbackHours: number | null
  json: boolean
}

export interface ReplayTrade {
  tradeId: string
  lane: string
  symbol: string
  side: NormalizedPaperTrade['side']
  leverage: number | null
  closeReason: string
  closeTs: string
  baselinePnlPct: number
  replayPnlPct: number
  disabled: boolean
  assumptions: string[]
}

export interface ReplayVariantReport {
  name: ReplayVariantName
  label: string
  assumptions: string[]
  metrics: {
    metricBasis: 'price_return_pct'
    trades: number
    sumPriceReturnPct: number
    totalPnlPct: number
    PF: number | null
    profitFactor: number | null
    winRate: number | null
    stopLossCount: number
    stopLossNegativePriceReturnSharePct: number
    stopLossLossSharePct: number
    maxLossPct: number
  }
  deltaVsBaseline: {
    sumPriceReturnPct: number | null
    totalPnlPct: number | null
    PF: number | null
    winRate: number | null
    stopLossCount: number | null
    stopLossNegativePriceReturnSharePct: number | null
    stopLossLossSharePct: number | null
    maxLossPct: number | null
    removedLaneContributionPct?: number | null
  }
  trades: ReplayTrade[]
}

export type ReplayClusterVariantReport = Omit<ReplayVariantReport, 'trades'>

export type ReplayClusterDimension =
  | 'lane'
  | 'symbol'
  | 'side'
  | 'lane_symbol'
  | 'lane_side'
  | 'symbol_side'
  | 'lane_symbol_side'

export interface ReplayClusterDiagnostic {
  diagnosticUse: 'closed_row_cluster_replay'
  promotionEligible: false
  policyMutationAllowed: false
  dimension: ReplayClusterDimension
  key: string
  lane?: string
  symbol?: string
  side?: NormalizedPaperTrade['side']
  coverage: {
    closedTrades: number
    stopLossTrades: number
    earliestCloseTs: string | null
    latestCloseTs: string | null
  }
  variants: ReplayClusterVariantReport[]
}

export interface MicrostructureStoplossReplayReport {
  schemaVersion: 1
  generatedAt: string
  counterfactualType: 'paper_only_retrospective_diagnostic'
  scope: 'microstructure_100x_lane_only'
  metricBasis: 'price_return_pct'
  inputs: {
    paperDir: string
    outputPath: string | null
    lookbackHours: number | null
    source: 'paper_result_and_account_history'
  }
  coverage: {
    closedTradesLoaded: number
    microstructure100xClosedTrades: number
    duplicateTradesSkipped: number
    earliestCloseTs: string | null
    latestCloseTs: string | null
  }
  assumptions: string[]
  variants: ReplayVariantReport[]
  clusterDiagnostics: ReplayClusterDiagnostic[]
  notes: string[]
}

interface VariantConfig {
  name: ReplayVariantName
  label: string
  assumptions: string[]
  transform: (trade: NormalizedPaperTrade) => ReplayTrade | null
}

const DEFAULT_PAPER_DIR = 'data/paper_trading'
const MICROSTRUCTURE_100X_LANE = 'microstructure_100x'

const GLOBAL_ASSUMPTIONS = [
  'paper-only retrospective: no strategy, position state, account, or live execution setting is changed',
  'input uses already-closed paper trades from paper_trade_result.jsonl and account trade histories',
  'metrics are price-return diagnostics from closed rows; they are not account return, margin return, or portfolio PnL',
  'leverage-cap variants linearly scale realized price-return contribution by cap/originalLeverage as an exposure-sensitivity diagnostic, not a fill/liquidation replay',
  'stress_stop_loss_loss_1_5x has no intratrade path after the original stop; it approximates stop-loss loss mass as 1.5x the observed adverse stop-loss price-return and is not a true widened-stop replay',
]

export function parseMicrostructureStoplossReplayArgs(argv: string[]): MicrostructureStoplossReplayArgs {
  const raw = parseRawArgs(argv)
  return {
    paperDir: raw.get('paperDir') ?? DEFAULT_PAPER_DIR,
    outputPath: raw.get('outputPath') ?? raw.get('output') ?? null,
    lookbackHours: parseNullablePositiveNumber(raw.get('lookbackHours')),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runMicrostructureStoplossReplay(
  args: MicrostructureStoplossReplayArgs,
): Promise<MicrostructureStoplossReplayReport> {
  const startedAt = new Date()
  const paperDir = resolve(args.paperDir)
  const loaded = await loadClosedTrades(paperDir, args.lookbackHours)
  const trades = filterMicrostructure100xTrades(loaded.closedTrades)
  const report = buildMicrostructureStoplossReplayReport({
    paperDir,
    outputPath: args.outputPath ? resolve(args.outputPath) : null,
    lookbackHours: args.lookbackHours,
    closedTradesLoaded: loaded.closedTrades.length,
    duplicateTradesSkipped: loaded.duplicateTradesSkipped,
    trades,
  })

  if (report.inputs.outputPath) {
    const rendered = args.json || report.inputs.outputPath.endsWith('.json')
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderMicrostructureStoplossReplayMarkdown(report)
    await mkdir(dirname(report.inputs.outputPath), { recursive: true })
    await writeFile(report.inputs.outputPath, rendered, 'utf-8')
    const baseline = report.variants.find(variant => variant.name === 'baseline')
    await writeEvidenceManifestForArtifact({
      job: 'microstructure_stoploss_replay',
      artifactPath: report.inputs.outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.coverage.microstructure100xClosedTrades > 0 ? 'warn' : 'pass',
      recordsIn: loaded.closedTrades.length,
      recordsOut: report.coverage.microstructure100xClosedTrades,
      errorClass: baseline && baseline.metrics.stopLossCount >= 20 ? 'microstructure_100x_stoploss_cluster' : null,
    })
  }

  return report
}

export function buildMicrostructureStoplossReplayReport(input: {
  paperDir: string
  outputPath?: string | null
  lookbackHours?: number | null
  closedTradesLoaded?: number
  duplicateTradesSkipped?: number
  trades: NormalizedPaperTrade[]
  generatedAt?: string
}): MicrostructureStoplossReplayReport {
  const trades = filterMicrostructure100xTrades(input.trades)
    .sort((a, b) => Date.parse(a.closeTs) - Date.parse(b.closeTs))
  const variants = buildReplayVariants(trades)

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    counterfactualType: 'paper_only_retrospective_diagnostic',
    scope: 'microstructure_100x_lane_only',
    metricBasis: 'price_return_pct',
    inputs: {
      paperDir: resolve(input.paperDir),
      outputPath: input.outputPath ? resolve(input.outputPath) : null,
      lookbackHours: input.lookbackHours ?? null,
      source: 'paper_result_and_account_history',
    },
    coverage: {
      closedTradesLoaded: input.closedTradesLoaded ?? trades.length,
      microstructure100xClosedTrades: trades.length,
      duplicateTradesSkipped: input.duplicateTradesSkipped ?? 0,
      earliestCloseTs: trades[0]?.closeTs ?? null,
      latestCloseTs: trades.at(-1)?.closeTs ?? null,
    },
    assumptions: GLOBAL_ASSUMPTIONS,
    variants,
    clusterDiagnostics: buildClusterDiagnostics(trades),
    notes: [
      'This report is evidence for Pro review only; it must not be used as an automatic strategy or stop-loss parameter update.',
      'disable_100x removes the 100x lane closed-row price-return contribution only; it is not a portfolio-level counterfactual and does not model capital reallocation.',
      'cap_leverage variants diagnose exposure sensitivity from closed rows; they do not model changed fills, liquidation thresholds, rejected signals, or portfolio reallocation.',
      'stress_stop_loss_loss_1_5x is an adverse stop-fill pressure test because post-stop price path is unavailable in closed-trade rows.',
      'clusterDiagnostics are closed-row attribution slices only; they are not promotion evidence and cannot mutate policy, leverage, or stop-loss parameters.',
    ],
  }
}

export function renderMicrostructureStoplossReplayMarkdown(
  report: MicrostructureStoplossReplayReport,
): string {
  const lines: string[] = []
  lines.push('# Microstructure 100x Stop-Loss Replay')
  lines.push('')
  lines.push(`Generated: \`${report.generatedAt}\``)
  lines.push(`Paper dir: \`${report.inputs.paperDir}\``)
  lines.push(`Scope: \`${report.scope}\``)
  lines.push(`Metric basis: \`${report.metricBasis}\``)
  lines.push(`Closed trades loaded: ${report.coverage.closedTradesLoaded}`)
  lines.push(`microstructure_100x closed trades: ${report.coverage.microstructure100xClosedTrades}`)
  lines.push('')
  lines.push('## Assumptions')
  lines.push('')
  for (const assumption of report.assumptions) lines.push(`- ${assumption}`)
  lines.push('')
  lines.push('## Variant Metrics')
  lines.push('')
  lines.push('| variant | trades | sumPriceReturnPct | PF | winRate | stopLossCount | stopLossNegativePriceReturnSharePct | maxLossPct |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const variant of report.variants) {
    const metrics = variant.metrics
    lines.push([
      `| ${variant.name}`,
      String(metrics.trades),
      formatNumber(metrics.sumPriceReturnPct),
      formatNullable(metrics.PF),
      formatNullable(metrics.winRate),
      String(metrics.stopLossCount),
      formatNumber(metrics.stopLossNegativePriceReturnSharePct),
      formatNumber(metrics.maxLossPct),
    ].join(' | ') + ' |')
  }
  lines.push('')
  lines.push('## Cluster Diagnostics')
  lines.push('')
  lines.push('These rows are attribution slices for Pro review only. `promotionEligible=false` and `policyMutationAllowed=false` for every cluster.')
  lines.push('')
  lines.push('| dimension | key | trades | stopLossTrades | baselineSumPriceReturnPct | baselinePF | cap25DeltaPct | cap10DeltaPct | stressStopLossDeltaPct |')
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const cluster of report.clusterDiagnostics) {
    const baseline = cluster.variants.find(variant => variant.name === 'baseline')
    const cap25 = cluster.variants.find(variant => variant.name === 'cap_leverage_25x')
    const cap10 = cluster.variants.find(variant => variant.name === 'cap_leverage_10x')
    const stress = cluster.variants.find(variant => variant.name === 'stress_stop_loss_loss_1_5x')
    lines.push([
      `| ${cluster.dimension}`,
      cluster.key,
      String(cluster.coverage.closedTrades),
      String(cluster.coverage.stopLossTrades),
      formatNullable(baseline?.metrics.sumPriceReturnPct ?? null),
      formatNullable(baseline?.metrics.PF ?? null),
      formatNullable(cap25?.deltaVsBaseline.sumPriceReturnPct ?? null),
      formatNullable(cap10?.deltaVsBaseline.sumPriceReturnPct ?? null),
      formatNullable(stress?.deltaVsBaseline.sumPriceReturnPct ?? null),
    ].join(' | ') + ' |')
  }
  lines.push('')
  lines.push('## Notes')
  lines.push('')
  for (const note of report.notes) lines.push(`- ${note}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

export function filterMicrostructure100xTrades(trades: NormalizedPaperTrade[]): NormalizedPaperTrade[] {
  return trades.filter((trade) =>
    trade.lane === MICROSTRUCTURE_100X_LANE ||
    ((trade.leverage ?? 0) >= 100 && trade.lane.includes('microstructure')),
  )
}

function buildReplayVariants(trades: NormalizedPaperTrade[]): ReplayVariantReport[] {
  const baselineTrades = trades.map(toBaselineReplayTrade)
  const baselineMetrics = computeReplayMetrics(baselineTrades)
  return buildVariantConfigs()
    .map((config) => {
      const replayTrades = trades
        .map(config.transform)
        .filter((trade): trade is ReplayTrade => trade !== null)
      const metrics = computeReplayMetrics(replayTrades)
      return {
        name: config.name,
        label: config.label,
        assumptions: config.assumptions,
        metrics,
        deltaVsBaseline: computeDelta(metrics, baselineMetrics),
        trades: replayTrades,
      }
    })
}

function buildClusterDiagnostics(trades: NormalizedPaperTrade[]): ReplayClusterDiagnostic[] {
  const dimensions: ReplayClusterDimension[] = [
    'lane',
    'symbol',
    'side',
    'lane_symbol',
    'lane_side',
    'symbol_side',
    'lane_symbol_side',
  ]
  const diagnostics: ReplayClusterDiagnostic[] = []
  for (const dimension of dimensions) {
    const groups = groupTradesByClusterDimension(trades, dimension)
    const sortedKeys = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b))
    for (const key of sortedKeys) {
      const groupTrades = groups.get(key) ?? []
      diagnostics.push({
        diagnosticUse: 'closed_row_cluster_replay',
        promotionEligible: false,
        policyMutationAllowed: false,
        dimension,
        key,
        ...clusterIdentity(dimension, groupTrades[0]),
        coverage: {
          closedTrades: groupTrades.length,
          stopLossTrades: groupTrades.filter(trade => trade.closeReason === 'stop_loss').length,
          earliestCloseTs: groupTrades[0]?.closeTs ?? null,
          latestCloseTs: groupTrades.at(-1)?.closeTs ?? null,
        },
        variants: buildReplayVariants(groupTrades).map(toClusterVariantReport),
      })
    }
  }
  return diagnostics
}

function toClusterVariantReport(variant: ReplayVariantReport): ReplayClusterVariantReport {
  const { trades: _trades, ...compact } = variant
  return compact
}

function groupTradesByClusterDimension(
  trades: NormalizedPaperTrade[],
  dimension: ReplayClusterDimension,
): Map<string, NormalizedPaperTrade[]> {
  const groups = new Map<string, NormalizedPaperTrade[]>()
  for (const trade of trades) {
    const key = clusterKey(dimension, trade)
    const group = groups.get(key)
    if (group) {
      group.push(trade)
    } else {
      groups.set(key, [trade])
    }
  }
  return groups
}

function clusterKey(dimension: ReplayClusterDimension, trade: NormalizedPaperTrade): string {
  switch (dimension) {
    case 'lane':
      return trade.lane
    case 'symbol':
      return trade.symbol
    case 'side':
      return trade.side
    case 'lane_symbol':
      return `${trade.lane}|${trade.symbol}`
    case 'lane_side':
      return `${trade.lane}|${trade.side}`
    case 'symbol_side':
      return `${trade.symbol}|${trade.side}`
    case 'lane_symbol_side':
      return `${trade.lane}|${trade.symbol}|${trade.side}`
  }
}

function clusterIdentity(
  dimension: ReplayClusterDimension,
  trade: NormalizedPaperTrade | undefined,
): Pick<ReplayClusterDiagnostic, 'lane' | 'symbol' | 'side'> {
  if (!trade) return {}
  switch (dimension) {
    case 'lane':
      return { lane: trade.lane }
    case 'symbol':
      return { symbol: trade.symbol }
    case 'side':
      return { side: trade.side }
    case 'lane_symbol':
      return { lane: trade.lane, symbol: trade.symbol }
    case 'lane_side':
      return { lane: trade.lane, side: trade.side }
    case 'symbol_side':
      return { symbol: trade.symbol, side: trade.side }
    case 'lane_symbol_side':
      return { lane: trade.lane, symbol: trade.symbol, side: trade.side }
  }
}

function buildVariantConfigs(): VariantConfig[] {
  return [
    {
      name: 'baseline',
      label: 'Realized microstructure_100x closed trades',
      assumptions: ['uses realized closed-trade pnlPct without adjustment'],
      transform: toBaselineReplayTrade,
    },
    {
      name: 'disable_100x',
      label: 'Disable microstructure_100x lane',
      assumptions: ['removes all microstructure_100x closed trades; no capital reallocation is modeled'],
      transform: () => null,
    },
    {
      name: 'cap_leverage_25x',
      label: 'Cap observed leverage at 25x',
      assumptions: ['replayPnlPct = baselinePnlPct * min(1, 25 / observedLeverage)'],
      transform: (trade) => toLeverageCapReplayTrade(trade, 25),
    },
    {
      name: 'cap_leverage_10x',
      label: 'Cap observed leverage at 10x',
      assumptions: ['replayPnlPct = baselinePnlPct * min(1, 10 / observedLeverage)'],
      transform: (trade) => toLeverageCapReplayTrade(trade, 10),
    },
    {
      name: 'stress_stop_loss_loss_1_5x',
      label: 'Stress observed stop-loss loss mass by 1.5x',
      assumptions: [
        'for observed losing stop_loss trades, replayPnlPct = baselinePnlPct * 1.5',
        'for non-stop-loss trades and non-losing stop-loss rows, realized pnlPct is unchanged',
        'no post-stop path, take-profit interaction, or liquidation path is available in closed trade rows',
      ],
      transform: toWidenStopReplayTrade,
    },
  ]
}

function toBaselineReplayTrade(trade: NormalizedPaperTrade): ReplayTrade {
  return {
    tradeId: trade.tradeId,
    lane: trade.lane,
    symbol: trade.symbol,
    side: trade.side,
    leverage: trade.leverage,
    closeReason: trade.closeReason,
    closeTs: trade.closeTs,
    baselinePnlPct: trade.pnlPct,
    replayPnlPct: trade.pnlPct,
    disabled: false,
    assumptions: ['realized paper closed-trade row'],
  }
}

function toLeverageCapReplayTrade(trade: NormalizedPaperTrade, cap: number): ReplayTrade {
  const leverage = trade.leverage ?? cap
  const scale = leverage > 0 ? Math.min(1, cap / leverage) : 1
  return {
    ...toBaselineReplayTrade(trade),
    replayPnlPct: trade.pnlPct * scale,
    assumptions: [`linear leverage exposure scale=${formatNumber(scale)} from observedLeverage=${leverage} to cap=${cap}`],
  }
}

function toWidenStopReplayTrade(trade: NormalizedPaperTrade): ReplayTrade {
  const baseline = toBaselineReplayTrade(trade)
  if (trade.closeReason !== 'stop_loss' || trade.pnlPct >= 0) {
    return {
      ...baseline,
      assumptions: ['unchanged because row is not a losing stop_loss close'],
    }
  }
  return {
    ...baseline,
    replayPnlPct: trade.pnlPct * 1.5,
    assumptions: ['diagnostic approximation: widened stop realizes 1.5x observed adverse stop-loss pnl without post-stop path modeling'],
  }
}

function computeReplayMetrics(trades: ReplayTrade[]): ReplayVariantReport['metrics'] {
  const pnlValues = trades.map((trade) => trade.replayPnlPct)
  const wins = pnlValues.filter((value) => value > 0)
  const losses = pnlValues.filter((value) => value < 0)
  const winPnl = sum(wins)
  const lossPnl = Math.abs(sum(losses))
  const stopLossTrades = trades.filter((trade) => trade.closeReason === 'stop_loss')
  const stopLossLossPct = Math.abs(sum(stopLossTrades.map((trade) => Math.min(0, trade.replayPnlPct))))
  const profitFactor = trades.length === 0
    ? null
    : lossPnl > 0 ? winPnl / lossPnl : (winPnl > 0 ? null : 0)
  return {
    trades: trades.length,
    metricBasis: 'price_return_pct',
    sumPriceReturnPct: sum(pnlValues),
    totalPnlPct: sum(pnlValues),
    PF: profitFactor,
    profitFactor,
    winRate: trades.length > 0 ? wins.length / trades.length * 100 : null,
    stopLossCount: stopLossTrades.length,
    stopLossNegativePriceReturnSharePct: lossPnl > 0 ? stopLossLossPct / lossPnl * 100 : 0,
    stopLossLossSharePct: lossPnl > 0 ? stopLossLossPct / lossPnl * 100 : 0,
    maxLossPct: pnlValues.length > 0 ? Math.min(0, ...pnlValues) : 0,
  }
}

function computeDelta(
  metrics: ReplayVariantReport['metrics'],
  baseline: ReplayVariantReport['metrics'],
): ReplayVariantReport['deltaVsBaseline'] {
  const ratesComparable = metrics.trades > 0 && baseline.trades > 0
  const priceReturnDelta = metrics.sumPriceReturnPct - baseline.sumPriceReturnPct
  return {
    sumPriceReturnPct: priceReturnDelta,
    totalPnlPct: priceReturnDelta,
    PF: nullableDelta(metrics.PF, baseline.PF),
    winRate: ratesComparable && metrics.winRate != null && baseline.winRate != null ? metrics.winRate - baseline.winRate : null,
    stopLossCount: metrics.stopLossCount - baseline.stopLossCount,
    stopLossNegativePriceReturnSharePct: ratesComparable ? metrics.stopLossNegativePriceReturnSharePct - baseline.stopLossNegativePriceReturnSharePct : null,
    stopLossLossSharePct: ratesComparable ? metrics.stopLossLossSharePct - baseline.stopLossLossSharePct : null,
    maxLossPct: ratesComparable ? metrics.maxLossPct - baseline.maxLossPct : null,
    removedLaneContributionPct: metrics.trades === 0 && baseline.trades > 0 ? -baseline.sumPriceReturnPct : null,
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
      i += 1
    } else {
      out.set(withoutPrefix, 'true')
    }
  }
  return out
}

function parseNullablePositiveNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '' || value.trim().toLowerCase() === 'null') return null
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

function nullableDelta(value: number | null, baseline: number | null): number | null {
  return value == null || baseline == null ? null : value - baseline
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0)
}

function formatNullable(value: number | null): string {
  return value == null ? 'null' : formatNumber(value)
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4)
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseMicrostructureStoplossReplayArgs(argv)
  const report = await runMicrostructureStoplossReplay(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderMicrostructureStoplossReplayMarkdown(report))
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
