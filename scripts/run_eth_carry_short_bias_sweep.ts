import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateSignificanceGate } from '../src/backtest/statistical_significance.js'
import { evaluateRiskSimulation } from '../src/backtest/risk_simulation.js'
import { evaluateReleaseGate } from '../src/backtest/release_gate.js'
import { buildCarrySignalSeries, loadFundingHistory, type CarrySignalPoint } from './lib/derivatives_history.ts'
import { buildCarryResearchArtifactMetadata } from './lib/carry_protocol_artifacts.ts'
import { buildRelativeValueCandles, loadCsvCandles } from './lib/pair_market_data.ts'
import {
  buildCarryEconomics,
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
  topK: number
  selfCheck: boolean
  dryRun: boolean
}

interface AsymmetricThresholds {
  shortSpread: number
  shortZ: number
  longSpread: number
  longZ: number
}

interface SweepRow {
  candidateId: string
  thresholds: AsymmetricThresholds
  tradeCount: number
  winRate: number | null
  errorRate: number | null
  recent90dTradeCount: number
  recent90dWinRate: number | null
  recent90dErrorRate: number | null
  netExpectancyPct: number
  totalReturnPct: number
  sharpe: number
  averageHoldingHours: number
  shortTradeCount: number
  shortErrorRate: number | null
  longTradeCount: number
  longErrorRate: number | null
  wfoPassed: boolean
  failedWindows: number
  significancePassed: boolean
  pbo: number
  dsrValue: number
  riskPassed: boolean
  paper: boolean
  live: boolean
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.selfCheck || args.dryRun) {
    console.log(JSON.stringify({
      family: 'eth_carry_short_bias',
      lookbackBars: args.lookbackBars,
      trainBars: args.trainBars,
      testBars: args.testBars,
      stepBars: args.stepBars,
      riskSimulationCount: args.riskSimulationCount,
      topK: args.topK,
      zscoreLookback: ZSCORE_LOOKBACK,
      searchGrid: {
        shortSpread: [0.00008, 0.0001, 0.00012],
        shortZ: [1.2, 1.3, 1.4, 1.5],
        longSpread: [0.0001, 0.00012, 0.00014, 0.00016, 0.00018],
        longZ: [1.3, 1.5, 1.7, 1.9, 2.1],
      },
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

  const ethFunding = await loadFundingHistory(args.ethFundingPath)
  const btcFunding = await loadFundingHistory(args.btcFundingPath)
  const carrySignals = buildCarrySignalSeries({
    leaderFunding: ethFunding,
    hedgeFunding: btcFunding,
    zScoreLookback: ZSCORE_LOOKBACK,
  })

  const variants = buildShortBiasVariants()
  const filteredSignalsByVariant = variants.map((thresholds) => ({
    thresholds,
    signals: filterAsymmetricCarrySignals(carrySignals, thresholds),
  }))

  const candidateReturns: number[][] = []
  const rows: SweepRow[] = []
  const backtests: Array<{
    thresholds: AsymmetricThresholds
    backtest: CarryBacktestResult
    validation: ReturnType<typeof evaluateVariantValidation>
  }> = []

  for (const variant of filteredSignalsByVariant) {
    const candidate = toSweepCandidate(variant.thresholds)
    const backtest = runCarryBacktest({
      candles: pairCandles,
      carrySignals: variant.signals,
      candidate,
    })
    candidateReturns.push(backtest.returns)
    backtests.push({
      thresholds: variant.thresholds,
      backtest,
      validation: evaluateVariantValidation({
        candles: pairCandles,
        carrySignals: variant.signals,
        candidate,
        riskSimulationCount: args.riskSimulationCount,
        trainBars: args.trainBars,
        testBars: args.testBars,
        stepBars: args.stepBars,
      }),
    })
  }

  for (let index = 0; index < backtests.length; index += 1) {
    const { thresholds, backtest, validation } = backtests[index]
    const significance = evaluateSignificanceGate({
      candidateReturns,
      selectedReturns: backtest.returns,
      partitions: 6,
      pboThreshold: 0.2,
      dsrMin: 0,
      trialCount: candidateReturns.length,
    })
    const releaseGate = evaluateReleaseGate({
      wfo: validation.wfo,
      significance,
      riskSimulation: validation.riskSimulation,
      economics: validation.economics,
    })
    rows.push(buildSweepRow({
      thresholds,
      backtest,
      wfo: validation.wfo,
      significance,
      riskSimulation: validation.riskSimulation,
      releaseGate,
    }))
  }

  rows.sort(compareSweepRows)
  const generatedAt = new Date().toISOString().replaceAll(':', '-')
  const outputDir = resolve(`data/research/standalone_eth_carry_short_bias/${generatedAt}`)
  await mkdir(outputDir, { recursive: true })
  const outputPath = resolve(outputDir, 'eth_carry_short_bias_sweep.json')
  const summary = {
    generatedAt: new Date().toISOString(),
    family: 'eth_carry_short_bias',
    researchArtifact: buildCarryResearchArtifactMetadata({
      artifactKind: 'research_sweep',
      summaryKind: 'coarse_threshold_sweep',
      candidateCount: rows.length,
      significanceTrialCount: rows.length,
    }),
    leaderSymbol: ETH.symbol,
    hedgeSymbol: BTC.symbol,
    syntheticSymbol: PAIR_SYMBOL,
    lookbackBars: args.lookbackBars,
    trainBars: args.trainBars,
    testBars: args.testBars,
    stepBars: args.stepBars,
    riskSimulationCount: args.riskSimulationCount,
    zscoreLookback: ZSCORE_LOOKBACK,
    candidateCount: rows.length,
    topCandidates: rows.slice(0, args.topK),
    artifactPolicy: {
      dryRun: args.dryRun,
      artifactKind: 'research_sweep',
      promotionEligible: false,
      note: 'Coarse threshold sweep output is research-only and must not be used as promotion evidence.',
    },
  }
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8')
  console.log(outputPath)
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
    topK: parseIntArg(raw.get('topK'), 20, 'topK'),
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

function buildShortBiasVariants(): AsymmetricThresholds[] {
  const out: AsymmetricThresholds[] = []
  for (const shortSpread of [0.00008, 0.0001, 0.00012]) {
    for (const shortZ of [1.2, 1.3, 1.4, 1.5]) {
      for (const longSpread of [0.0001, 0.00012, 0.00014, 0.00016, 0.00018]) {
        for (const longZ of [1.3, 1.5, 1.7, 1.9, 2.1]) {
          out.push({ shortSpread, shortZ, longSpread, longZ })
        }
      }
    }
  }
  return out
}

function filterAsymmetricCarrySignals(
  carrySignals: CarrySignalPoint[],
  thresholds: AsymmetricThresholds,
): CarrySignalPoint[] {
  return carrySignals.filter((signal) => {
    if (signal.fundingSpread > 0) {
      return (
        Math.abs(signal.fundingSpread) >= thresholds.shortSpread &&
        Math.abs(signal.fundingSpreadZScore) >= thresholds.shortZ
      )
    }
    if (signal.fundingSpread < 0) {
      return (
        Math.abs(signal.fundingSpread) >= thresholds.longSpread &&
        Math.abs(signal.fundingSpreadZScore) >= thresholds.longZ
      )
    }
    return false
  })
}

function toSweepCandidate(thresholds: AsymmetricThresholds): CarryBacktestCandidate {
  return {
    id: [
      `ss${thresholds.shortSpread}`,
      `sz${thresholds.shortZ}`,
      `ls${thresholds.longSpread}`,
      `lz${thresholds.longZ}`,
    ].join('_'),
    minAbsFundingSpread: 0,
    minAbsFundingZScore: 0,
    maxHoldingBars: 24,
    stopLossPct: 0.015,
    positionPctOfEquity: 0.015,
    signalPersistenceBars: 8,
  }
}

function evaluateVariantValidation(input: {
  candles: ReturnType<typeof buildRelativeValueCandles>
  carrySignals: CarrySignalPoint[]
  candidate: CarryBacktestCandidate
  riskSimulationCount: number
  trainBars: number
  testBars: number
  stepBars: number
}) {
  const wfo = runSweepWalkForward({
    candles: input.candles,
    carrySignals: input.carrySignals,
    candidate: input.candidate,
    trainBars: input.trainBars,
    testBars: input.testBars,
    stepBars: input.stepBars,
  })
  const backtest = runCarryBacktest({
    candles: input.candles,
    carrySignals: input.carrySignals,
    candidate: input.candidate,
  })
  const riskSimulation = evaluateRiskSimulation(backtest.returns, {
    simulations: input.riskSimulationCount,
    horizonBars: input.testBars,
    blockSize: 24,
    ruinDrawdownPct: 30,
    maxRuinProbability: 0.02,
    minProfitProbability: 0.55,
  })
  const economics = buildCarryEconomics(backtest)
  return {
    wfo,
    riskSimulation,
    economics,
  }
}

function runSweepWalkForward(input: {
  candles: ReturnType<typeof buildRelativeValueCandles>
  carrySignals: CarrySignalPoint[]
  candidate: CarryBacktestCandidate
  trainBars: number
  testBars: number
  stepBars: number
}) {
  const windows: Array<{
    degradationRate: number
    gatePassed: boolean
  }> = []
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
    windows.push({
      degradationRate,
      gatePassed,
    })
  }
  const failedWindows = windows.filter((window) => !window.gatePassed).length
  return {
    overallPassed: failedWindows === 0,
    failedWindows,
    windows,
  }
}

function buildSweepRow(input: {
  thresholds: AsymmetricThresholds
  backtest: CarryBacktestResult
  wfo: {
    overallPassed: boolean
    failedWindows: number
    windows: Array<{ degradationRate: number; gatePassed: boolean }>
  }
  significance: ReturnType<typeof evaluateSignificanceGate>
  riskSimulation: ReturnType<typeof evaluateRiskSimulation>
  releaseGate: ReturnType<typeof evaluateReleaseGate>
}): SweepRow {
  const trades = input.backtest.trades
  const wins = trades.filter((trade) => trade.netReturnPct > 0).length
  const losses = trades.length - wins
  const lastExit = trades.length > 0 ? Math.max(...trades.map((trade) => trade.exitTime)) : 0
  const recent90dTrades =
    lastExit > 0
      ? trades.filter((trade) => trade.exitTime >= lastExit - 90 * 24 * 3600)
      : []
  const recent90dWins = recent90dTrades.filter((trade) => trade.netReturnPct > 0).length
  const shortTrades = trades.filter((trade) => trade.direction === 'short_pair')
  const longTrades = trades.filter((trade) => trade.direction === 'long_pair')
  const shortWins = shortTrades.filter((trade) => trade.netReturnPct > 0).length
  const longWins = longTrades.filter((trade) => trade.netReturnPct > 0).length

  return {
    candidateId: input.backtest.candidate.id,
    thresholds: input.thresholds,
    tradeCount: trades.length,
    winRate: trades.length > 0 ? wins / trades.length : null,
    errorRate: trades.length > 0 ? losses / trades.length : null,
    recent90dTradeCount: recent90dTrades.length,
    recent90dWinRate: recent90dTrades.length > 0 ? recent90dWins / recent90dTrades.length : null,
    recent90dErrorRate: recent90dTrades.length > 0 ? (recent90dTrades.length - recent90dWins) / recent90dTrades.length : null,
    netExpectancyPct: input.backtest.metrics.netExpectancyPct,
    totalReturnPct: input.backtest.metrics.totalReturnPct,
    sharpe: input.backtest.metrics.sharpe,
    averageHoldingHours: input.backtest.metrics.averageHoldingHours,
    shortTradeCount: shortTrades.length,
    shortErrorRate: shortTrades.length > 0 ? (shortTrades.length - shortWins) / shortTrades.length : null,
    longTradeCount: longTrades.length,
    longErrorRate: longTrades.length > 0 ? (longTrades.length - longWins) / longTrades.length : null,
    wfoPassed: input.wfo.overallPassed,
    failedWindows: input.wfo.failedWindows,
    significancePassed: input.significance.passed,
    pbo: input.significance.pboResult.pbo,
    dsrValue: input.significance.dsrResult.dsrValue,
    riskPassed: input.riskSimulation.gatePassed,
    paper: input.releaseGate.allowPaperTrading,
    live: input.releaseGate.allowLiveTrading,
  }
}

function compareSweepRows(left: SweepRow, right: SweepRow): number {
  if (Number(left.paper) !== Number(right.paper)) {
    return Number(right.paper) - Number(left.paper)
  }
  if ((left.errorRate ?? 1) !== (right.errorRate ?? 1)) {
    return (left.errorRate ?? 1) - (right.errorRate ?? 1)
  }
  if ((left.recent90dErrorRate ?? 1) !== (right.recent90dErrorRate ?? 1)) {
    return (left.recent90dErrorRate ?? 1) - (right.recent90dErrorRate ?? 1)
  }
  if (left.failedWindows !== right.failedWindows) {
    return left.failedWindows - right.failedWindows
  }
  if (left.netExpectancyPct !== right.netExpectancyPct) {
    return right.netExpectancyPct - left.netExpectancyPct
  }
  return right.sharpe - left.sharpe
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

export {
  buildShortBiasVariants,
  filterAsymmetricCarrySignals,
  parseArgs,
  toSweepCandidate,
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
