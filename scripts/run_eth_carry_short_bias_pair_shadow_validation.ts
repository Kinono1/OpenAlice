import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateReleaseGate } from '../src/backtest/release_gate.js'
import { evaluateRiskSimulation } from '../src/backtest/risk_simulation.js'
import { evaluateSignificanceGate } from '../src/backtest/statistical_significance.js'
import { buildCarrySignalSeries, loadFundingHistory } from './lib/derivatives_history.ts'
import { buildCarryResearchArtifactMetadata } from './lib/carry_protocol_artifacts.ts'
import { buildRelativeValueCandles, loadCsvCandles, type PairMarketCandle } from './lib/pair_market_data.ts'
import {
  buildCarryEconomics,
  buildCarryStrategyPlanEvidence,
  runCarryBacktest,
  type CarryBacktestCandidate,
  type CarryBacktestResult,
} from './lib/carry_backtest.ts'

interface CliArgs {
  ethFundingPath: string
  btcFundingPath: string
  lookbackBars: number
  trainBars: number
  testBars: number
  stepBars: number
  riskSimulationCount: number
  selfCheck: boolean
  dryRun: boolean
}

interface PairShadowEvaluation {
  candidate: CarryBacktestCandidate
  backtest: CarryBacktestResult
  wfo: {
    overallPassed: boolean
    failedWindows: number
    windows: Array<{ degradationRate: number; gatePassed: boolean }>
  }
  significance: ReturnType<typeof evaluateSignificanceGate>
  riskSimulation: ReturnType<typeof evaluateRiskSimulation>
  releaseGate: ReturnType<typeof evaluateReleaseGate>
  errorRate: number | null
  recent90dErrorRate: number | null
}

const ETH = {
  symbol: 'ETH/USDT:USDT',
  csv: 'data/market/gate/ETH_USDT_USDT_1h.csv',
}

const BTC = {
  symbol: 'BTC/USDT:USDT',
  csv: 'data/market/gate/BTC_USDT_USDT_1h.csv',
}

const PAIR_SYMBOL = 'ETH/BTC_CARRY'
const ZSCORE_LOOKBACK = 30

const PAIR_SHADOW_CANDIDATES: CarryBacktestCandidate[] = [
  {
    id: 'carry_short_bias_soft',
    minAbsFundingSpread: 0.0001,
    minAbsFundingZScore: 1.2,
    shortEntry: { minAbsFundingSpread: 0.0001, minAbsFundingZScore: 1.2 },
    longEntry: { minAbsFundingSpread: 0.00016, minAbsFundingZScore: 1.3 },
    maxHoldingBars: 24,
    stopLossPct: 0.018,
    positionPctOfEquity: 0.015,
    signalPersistenceBars: 8,
  },
  {
    id: 'carry_short_bias_fast_confirm',
    minAbsFundingSpread: 0.0001,
    minAbsFundingZScore: 1.2,
    shortEntry: { minAbsFundingSpread: 0.0001, minAbsFundingZScore: 1.2 },
    longEntry: { minAbsFundingSpread: 0.00016, minAbsFundingZScore: 1.2 },
    maxHoldingBars: 24,
    stopLossPct: 0.018,
    positionPctOfEquity: 0.015,
    signalPersistenceBars: 4,
  },
]

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.selfCheck || args.dryRun) {
    console.log(JSON.stringify({
      family: 'eth_carry_short_bias_pair_shadow',
      candidates: PAIR_SHADOW_CANDIDATES,
      zscoreLookback: ZSCORE_LOOKBACK,
      executionMode: {
        selfCheck: args.selfCheck,
        dryRun: args.dryRun,
        writesResearchArtifacts: false,
        writesPromotionRuntimeArtifacts: false,
      },
    }, null, 2))
    return
  }

  const ethCandles = await loadCsvCandles(ETH.csv, ETH.symbol)
  const btcCandles = await loadCsvCandles(BTC.csv, BTC.symbol)
  const pairCandles = buildRelativeValueCandles({
    leader: ethCandles,
    hedge: btcCandles,
    symbol: PAIR_SYMBOL,
  }).slice(-args.lookbackBars)

  const [ethFunding, btcFunding] = await Promise.all([
    loadFundingHistory(args.ethFundingPath),
    loadFundingHistory(args.btcFundingPath),
  ])
  const carrySignals = buildCarrySignalSeries({
    leaderFunding: ethFunding,
    hedgeFunding: btcFunding,
    zScoreLookback: ZSCORE_LOOKBACK,
  })

  const backtests = PAIR_SHADOW_CANDIDATES.map((candidate) =>
    runCarryBacktest({
      candles: pairCandles,
      carrySignals,
      candidate,
    }),
  )
  const candidateReturns = backtests.map((backtest) => backtest.returns)

  const evaluations: PairShadowEvaluation[] = backtests.map((backtest, index) => {
    const candidate = PAIR_SHADOW_CANDIDATES[index]
    const wfo = runWalkForward({
      candles: pairCandles,
      carrySignals,
      candidate,
      trainBars: args.trainBars,
      testBars: args.testBars,
      stepBars: args.stepBars,
    })
    const significance = evaluateSignificanceGate({
      candidateReturns,
      selectedReturns: backtest.returns,
      partitions: 6,
      pboThreshold: 0.2,
      dsrMin: 0,
      trialCount: candidateReturns.length,
    })
    const riskSimulation = evaluateRiskSimulation(backtest.returns, {
      simulations: args.riskSimulationCount,
      horizonBars: args.testBars,
      blockSize: 24,
      ruinDrawdownPct: 30,
      maxRuinProbability: 0.02,
      minProfitProbability: 0.55,
    })
    const releaseGate = evaluateReleaseGate({
      wfo,
      significance,
      riskSimulation,
      economics: buildCarryEconomics(backtest),
      strategyPlanEvidence: buildCarryStrategyPlanEvidence(backtest),
    })
    return {
      candidate,
      backtest,
      wfo,
      significance,
      riskSimulation,
      releaseGate,
      errorRate: computeErrorRate(backtest.trades),
      recent90dErrorRate: computeRecentErrorRate(backtest.trades, 90),
    }
  })

  const selected = [...evaluations].sort(compareEvaluations)[0]
  const generatedAt = new Date().toISOString().replaceAll(':', '-')
  const outputDir = resolve(`data/research/standalone_eth_carry_short_bias/${generatedAt}`)
  await mkdir(outputDir, { recursive: true })
  const outputPath = resolve(outputDir, 'eth_carry_short_bias_pair_shadow_summary.json')
  await writeFile(
    outputPath,
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      family: 'eth_carry_short_bias_pair_shadow',
      researchArtifact: buildCarryResearchArtifactMetadata({
        artifactKind: 'research_pair_shadow',
        summaryKind: 'pair_shadow_validation',
        candidateCount: evaluations.length,
        significanceTrialCount: evaluations.length,
      }),
      leaderSymbol: ETH.symbol,
      hedgeSymbol: BTC.symbol,
      syntheticSymbol: PAIR_SYMBOL,
      selectedParams: selected.candidate,
      selectedMetrics: selected.backtest.metrics,
      topCandidates: evaluations
        .slice()
        .sort(compareEvaluations)
        .map((item) => ({
          candidateId: item.candidate.id,
          thresholds: {
            shortEntry: item.candidate.shortEntry,
            longEntry: item.candidate.longEntry,
            signalPersistenceBars: item.candidate.signalPersistenceBars,
            maxHoldingBars: item.candidate.maxHoldingBars,
          },
          tradeCount: item.backtest.metrics.tradeCount,
          recent90dTradeCount: (() => {
            if (item.backtest.trades.length === 0) return 0
            const maxExit = Math.max(...item.backtest.trades.map((trade) => trade.exitTime))
            return item.backtest.trades.filter((trade) => trade.exitTime >= maxExit - 90 * 24 * 3600).length
          })(),
          errorRate: item.errorRate,
          recent90dErrorRate: item.recent90dErrorRate,
          netExpectancyPct: item.backtest.metrics.netExpectancyPct,
          sharpe: item.backtest.metrics.sharpe,
          wfoPassed: item.wfo.overallPassed,
          failedWindows: item.wfo.failedWindows,
          pbo: item.significance.pboResult.pbo,
          dsrValue: item.significance.dsrResult.dsrValue,
          paper: item.releaseGate.allowPaperTrading,
          live: item.releaseGate.allowLiveTrading,
        })),
      significance: selected.significance,
      wfo: selected.wfo,
      riskSimulation: selected.riskSimulation,
      releaseGate: selected.releaseGate,
      artifactPolicy: {
        dryRun: args.dryRun,
        artifactKind: 'research_pair_shadow',
        promotionEligible: false,
        note: 'Pair shadow output is research-only and must not be used as promotion evidence.',
      },
    }, null, 2)}\n`,
    'utf-8',
  )
  console.log(outputPath)
}

function runWalkForward(input: {
  candles: PairMarketCandle[]
  carrySignals: ReturnType<typeof buildCarrySignalSeries>
  candidate: CarryBacktestCandidate
  trainBars: number
  testBars: number
  stepBars: number
}) {
  const windows: Array<{ degradationRate: number; gatePassed: boolean }> = []
  for (
    let trainStart = 0;
    trainStart + input.trainBars + input.testBars <= input.candles.length;
    trainStart += input.stepBars
  ) {
    const trainEnd = trainStart + input.trainBars
    const testEnd = trainEnd + input.testBars
    const trainCandles = input.candles.slice(trainStart, trainEnd)
    const testCandles = input.candles.slice(trainEnd, testEnd)
    const trainTimes = new Set(trainCandles.map((candle) => candle.time))
    const testTimes = new Set(testCandles.map((candle) => candle.time))
    const trainSignals = input.carrySignals.filter((signal) => trainTimes.has(signal.time))
    const testSignals = input.carrySignals.filter((signal) => testTimes.has(signal.time))
    const trainResult = runCarryBacktest({
      candles: trainCandles,
      carrySignals: trainSignals,
      candidate: input.candidate,
    })
    const testResult = runCarryBacktest({
      candles: testCandles,
      carrySignals: testSignals,
      candidate: input.candidate,
    })
    const degradationRate =
      trainResult.metrics.sharpe > 0
        ? (trainResult.metrics.sharpe - testResult.metrics.sharpe) / Math.abs(trainResult.metrics.sharpe)
        : Number.POSITIVE_INFINITY
    const gatePassed =
      trainResult.metrics.sharpe > 0 &&
      testResult.metrics.tradeCount >= 1 &&
      degradationRate <= 0.4
    windows.push({ degradationRate, gatePassed })
  }
  const failedWindows = windows.filter((window) => !window.gatePassed).length
  return {
    overallPassed: failedWindows === 0,
    failedWindows,
    windows,
  }
}

function buildEconomics(backtest: CarryBacktestResult) {
  return {
    grossExpectancyPct: backtest.trades.length > 0
      ? backtest.trades.reduce((sum, trade) => sum + trade.rawReturnPct, 0) / backtest.trades.length
      : 0,
    netExpectancyPct: backtest.metrics.netExpectancyPct,
    feeExpectancyDragPct: backtest.trades.length > 0
      ? backtest.trades.reduce((sum, trade) => sum + trade.totalCostPct / 2, 0) / backtest.trades.length
      : 0,
    slippageExpectancyDragPct: backtest.trades.length > 0
      ? backtest.trades.reduce((sum, trade) => sum + trade.totalCostPct / 2, 0) / backtest.trades.length
      : 0,
    fundingExpectancyDragPct: 0,
    totalCostsPaid: backtest.trades.reduce((sum, trade) => sum + trade.totalCostPct, 0),
    costDragPctOfInitialCapital: backtest.trades.reduce((sum, trade) => sum + trade.totalCostPct, 0),
    averageHoldingHours: backtest.metrics.averageHoldingHours,
    medianHoldingHours: median(backtest.trades.map((trade) => trade.holdingBars)),
    tradeCount: backtest.metrics.tradeCount,
  }
}

function computeErrorRate(
  trades: CarryBacktestResult['trades'],
): number | null {
  if (trades.length === 0) return null
  const wins = trades.filter((trade) => trade.netReturnPct > 0).length
  return (trades.length - wins) / trades.length
}

function computeRecentErrorRate(
  trades: CarryBacktestResult['trades'],
  days: number,
): number | null {
  if (trades.length === 0) return null
  const maxExit = Math.max(...trades.map((trade) => trade.exitTime))
  const recent = trades.filter((trade) => trade.exitTime >= maxExit - days * 24 * 3600)
  return computeErrorRate(recent)
}

function compareEvaluations(left: PairShadowEvaluation, right: PairShadowEvaluation): number {
  if (Number(left.releaseGate.allowPaperTrading) !== Number(right.releaseGate.allowPaperTrading)) {
    return Number(right.releaseGate.allowPaperTrading) - Number(left.releaseGate.allowPaperTrading)
  }
  if (left.wfo.failedWindows !== right.wfo.failedWindows) {
    return left.wfo.failedWindows - right.wfo.failedWindows
  }
  if (left.significance.pboResult.pbo !== right.significance.pboResult.pbo) {
    return left.significance.pboResult.pbo - right.significance.pboResult.pbo
  }
  if ((left.errorRate ?? 1) !== (right.errorRate ?? 1)) {
    return (left.errorRate ?? 1) - (right.errorRate ?? 1)
  }
  if ((left.recent90dErrorRate ?? 1) !== (right.recent90dErrorRate ?? 1)) {
    return (left.recent90dErrorRate ?? 1) - (right.recent90dErrorRate ?? 1)
  }
  if (left.backtest.metrics.netExpectancyPct !== right.backtest.metrics.netExpectancyPct) {
    return right.backtest.metrics.netExpectancyPct - left.backtest.metrics.netExpectancyPct
  }
  return right.backtest.metrics.sharpe - left.backtest.metrics.sharpe
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    ethFundingPath:
      raw.get('ethFundingPath') ??
      'data/research/derivatives_history/binance_ETH_USDT_USDT_funding_history.json',
    btcFundingPath:
      raw.get('btcFundingPath') ??
      'data/research/derivatives_history/binance_BTC_USDT_USDT_funding_history.json',
    lookbackBars: parseIntArg(raw.get('lookbackBars'), 6000, 'lookbackBars'),
    trainBars: parseIntArg(raw.get('trainBars'), 3600, 'trainBars'),
    testBars: parseIntArg(raw.get('testBars'), 1200, 'testBars'),
    stepBars: parseIntArg(raw.get('stepBars'), 480, 'stepBars'),
    riskSimulationCount: parseIntArg(raw.get('riskSimulationCount'), 200, 'riskSimulationCount'),
    selfCheck: parseBoolArg(raw.get('selfCheck'), false),
    dryRun: parseBoolArg(raw.get('dryRun'), true),
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    index += 1
  }
  return out
}

function parseIntArg(raw: string | undefined, fallback: number, label: string): number {
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return value
}

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

export {
  PAIR_SHADOW_CANDIDATES,
  parseArgs,
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
