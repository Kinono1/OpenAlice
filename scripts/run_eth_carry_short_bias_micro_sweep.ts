import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateReleaseGate } from '../src/backtest/release_gate.js'
import { evaluateRiskSimulation } from '../src/backtest/risk_simulation.js'
import {
  buildTrialLedgerSummary,
  evaluateSignificanceGate,
} from '../src/backtest/statistical_significance.js'
import { buildCarrySignalSeries, loadFundingHistory } from './lib/derivatives_history.ts'
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

interface MicroSweepRow {
  candidateId: string
  longSpread: number
  longZ: number
  persistenceBars: number
  maxHoldingBars: number
  tradeCount: number
  recent90dTradeCount: number
  netExpectancyPct: number
  totalReturnPct: number
  sharpe: number
  errorRate: number | null
  recent90dErrorRate: number | null
  shortTradeCount: number
  longTradeCount: number
  wfoPassed: boolean
  failedWindows: number
  significancePassed: boolean
  pbo: number
  dsrValue: number
  riskPassed: boolean
  paper: boolean
  live: boolean
}

interface MicroEvaluation {
  candidate: CarryBacktestCandidate
  backtest: CarryBacktestResult
  row: MicroSweepRow
  wfo: { overallPassed: boolean; failedWindows: number }
  riskSimulation: ReturnType<typeof evaluateRiskSimulation>
}

interface PairFamilyRow {
  baselineCandidateId: string
  partnerCandidateId: string
  selectedCandidateId: string
  maxEntryOverlap: number
  selectedNetExpectancyPct: number
  selectedSharpe: number
  selectedTradeCount: number
  selectedFailedWindows: number
  selectedPbo: number
  selectedDsrValue: number
  selectedPaper: boolean
  selectedLive: boolean
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
      family: 'eth_carry_short_bias_micro_sweep',
      searchSpace: {
        longSpread: [0.00012, 0.00014, 0.00016],
        longZ: [1.2, 1.3],
        persistenceBars: [4, 8, 12],
        maxHoldingBars: [24, 36],
      },
      fixedShortEntry: {
        minAbsFundingSpread: 0.0001,
        minAbsFundingZScore: 1.2,
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

  const [ethFunding, btcFunding] = await Promise.all([
    loadFundingHistory(args.ethFundingPath),
    loadFundingHistory(args.btcFundingPath),
  ])
  const carrySignals = buildCarrySignalSeries({
    leaderFunding: ethFunding,
    hedgeFunding: btcFunding,
    zScoreLookback: ZSCORE_LOOKBACK,
  })

  const candidates = buildMicroSweepCandidates()
  const backtests = candidates.map((candidate) =>
    runCarryBacktest({
      candles: pairCandles,
      carrySignals,
      candidate,
    }),
  )
  const candidateReturns = backtests.map((backtest) => backtest.returns)

  const evaluations: MicroEvaluation[] = backtests.map((backtest, index) => {
    const candidate = candidates[index]
    const wfo = runMicroWalkForward({
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
      trialLedger: buildTrialLedgerSummary({
        rawM: candidateReturns.length,
        effectiveM: candidateReturns.length,
        survivingTrialCount: 1,
        rawMComplete: true,
        includesFailedTrials: true,
      }),
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
      economics: buildEconomics(backtest),
    })
    const row = toMicroSweepRow({
      candidate,
      backtest,
      wfo,
      significance,
      riskSimulation,
      releaseGate,
    })
    return {
      candidate,
      backtest,
      row,
      wfo,
      riskSimulation,
    }
  })

  const rows = evaluations.map((evaluation) => evaluation.row)
  rows.sort(compareRows)
  const diverseFamily = buildDiverseFamily(evaluations, 5, 0.85)
  const pairFamilies = buildPairFamilies(
    evaluations,
    'micro_ls0.00016_lz1.3_pb8_mh24',
    0.95,
  )

  const generatedAt = new Date().toISOString().replaceAll(':', '-')
  const outputDir = resolve(`data/research/standalone_eth_carry_short_bias/${generatedAt}`)
  await mkdir(outputDir, { recursive: true })
  const outputPath = resolve(outputDir, 'eth_carry_short_bias_micro_sweep.json')
  await writeFile(
    outputPath,
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      family: 'eth_carry_short_bias_micro_sweep',
      researchArtifact: buildCarryResearchArtifactMetadata({
        artifactKind: 'research_micro_sweep',
        summaryKind: 'micro_family_sweep',
        candidateCount: rows.length,
        significanceTrialCount: rows.length,
      }),
      candidateCount: rows.length,
      topCandidates: rows.slice(0, args.topK),
      paperCandidates: rows.filter((row) => row.paper),
      diverseFamily,
      pairFamilies: pairFamilies.slice(0, args.topK),
      artifactPolicy: {
        dryRun: args.dryRun,
        artifactKind: 'research_micro_sweep',
        promotionEligible: false,
        note: 'Micro sweep output is research-only and must not be used as promotion evidence.',
      },
    }, null, 2)}\n`,
    'utf-8',
  )
  console.log(outputPath)
}

function buildMicroSweepCandidates(): CarryBacktestCandidate[] {
  const out: CarryBacktestCandidate[] = []
  for (const longSpread of [0.00012, 0.00014, 0.00016]) {
    for (const longZ of [1.2, 1.3]) {
      for (const persistenceBars of [4, 8, 12]) {
        for (const maxHoldingBars of [24, 36]) {
          out.push({
            id: `micro_ls${longSpread}_lz${longZ}_pb${persistenceBars}_mh${maxHoldingBars}`,
            minAbsFundingSpread: 0.0001,
            minAbsFundingZScore: 1.2,
            shortEntry: { minAbsFundingSpread: 0.0001, minAbsFundingZScore: 1.2 },
            longEntry: { minAbsFundingSpread: longSpread, minAbsFundingZScore: longZ },
            maxHoldingBars,
            stopLossPct: 0.018,
            positionPctOfEquity: 0.015,
            signalPersistenceBars: persistenceBars,
          })
        }
      }
    }
  }
  return out
}

function runMicroWalkForward(input: {
  candles: ReturnType<typeof buildRelativeValueCandles>
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
  return buildCarryEconomics(backtest)
}

function toMicroSweepRow(input: {
  candidate: CarryBacktestCandidate
  backtest: CarryBacktestResult
  wfo: { overallPassed: boolean; failedWindows: number }
  significance: ReturnType<typeof evaluateSignificanceGate>
  riskSimulation: ReturnType<typeof evaluateRiskSimulation>
  releaseGate: ReturnType<typeof evaluateReleaseGate>
}): MicroSweepRow {
  const trades = input.backtest.trades
  const wins = trades.filter((trade) => trade.netReturnPct > 0).length
  const lastExit = trades.length > 0 ? Math.max(...trades.map((trade) => trade.exitTime)) : 0
  const recent90dTrades =
    lastExit > 0
      ? trades.filter((trade) => trade.exitTime >= lastExit - 90 * 24 * 3600)
      : []
  const recent90dWins = recent90dTrades.filter((trade) => trade.netReturnPct > 0).length
  const shortTrades = trades.filter((trade) => trade.direction === 'short_pair')
  const longTrades = trades.filter((trade) => trade.direction === 'long_pair')

  return {
    candidateId: input.candidate.id,
    longSpread: input.candidate.longEntry?.minAbsFundingSpread ?? input.candidate.minAbsFundingSpread,
    longZ: input.candidate.longEntry?.minAbsFundingZScore ?? input.candidate.minAbsFundingZScore ?? 0,
    persistenceBars: input.candidate.signalPersistenceBars ?? 0,
    maxHoldingBars: input.candidate.maxHoldingBars,
    tradeCount: trades.length,
    recent90dTradeCount: recent90dTrades.length,
    netExpectancyPct: input.backtest.metrics.netExpectancyPct,
    totalReturnPct: input.backtest.metrics.totalReturnPct,
    sharpe: input.backtest.metrics.sharpe,
    errorRate: trades.length > 0 ? (trades.length - wins) / trades.length : null,
    recent90dErrorRate: recent90dTrades.length > 0 ? (recent90dTrades.length - recent90dWins) / recent90dTrades.length : null,
    shortTradeCount: shortTrades.length,
    longTradeCount: longTrades.length,
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

function compareRows(left: MicroSweepRow, right: MicroSweepRow): number {
  if (Number(left.paper) !== Number(right.paper)) {
    return Number(right.paper) - Number(left.paper)
  }
  if (left.failedWindows !== right.failedWindows) {
    return left.failedWindows - right.failedWindows
  }
  if ((left.errorRate ?? 1) !== (right.errorRate ?? 1)) {
    return (left.errorRate ?? 1) - (right.errorRate ?? 1)
  }
  if ((left.recent90dErrorRate ?? 1) !== (right.recent90dErrorRate ?? 1)) {
    return (left.recent90dErrorRate ?? 1) - (right.recent90dErrorRate ?? 1)
  }
  if (left.netExpectancyPct !== right.netExpectancyPct) {
    return right.netExpectancyPct - left.netExpectancyPct
  }
  return right.sharpe - left.sharpe
}

function computeEntryOverlap(left: CarryBacktestResult, right: CarryBacktestResult): number {
  const leftEntries = new Set(left.trades.map((trade) => trade.entryTime))
  const rightEntries = new Set(right.trades.map((trade) => trade.entryTime))
  if (leftEntries.size === 0 && rightEntries.size === 0) return 1
  if (leftEntries.size === 0 || rightEntries.size === 0) return 0
  let intersection = 0
  for (const entry of leftEntries) {
    if (rightEntries.has(entry)) intersection += 1
  }
  const union = new Set([...leftEntries, ...rightEntries]).size
  return union === 0 ? 0 : intersection / union
}

function buildDiverseFamily(
  evaluations: MicroEvaluation[],
  maxFamilySize: number,
  maxEntryOverlap: number,
) {
  const ranked = [...evaluations].sort((left, right) => compareRows(left.row, right.row))
  const selected: MicroEvaluation[] = []
  for (const evaluation of ranked) {
    const overlaps = selected.map((existing) => computeEntryOverlap(existing.backtest, evaluation.backtest))
    const maxObservedOverlap = overlaps.length > 0 ? Math.max(...overlaps) : 0
    if (maxObservedOverlap > maxEntryOverlap) {
      continue
    }
    selected.push(evaluation)
    if (selected.length >= maxFamilySize) break
  }

  const familyReturns = selected.map((evaluation) => evaluation.backtest.returns)
  const rows = selected.map((evaluation) => {
    const significance = evaluateSignificanceGate({
      candidateReturns: familyReturns,
      selectedReturns: evaluation.backtest.returns,
      partitions: 6,
      pboThreshold: 0.2,
      dsrMin: 0,
      trialCount: familyReturns.length,
      trialLedger: buildTrialLedgerSummary({
        rawM: familyReturns.length,
        effectiveM: familyReturns.length,
        survivingTrialCount: 1,
        rawMComplete: true,
        includesFailedTrials: true,
      }),
    })
    const releaseGate = evaluateReleaseGate({
      wfo: evaluation.wfo,
      significance,
      riskSimulation: evaluation.riskSimulation,
      economics: buildEconomics(evaluation.backtest),
    })
    return {
      candidateId: evaluation.candidate.id,
      longSpread: evaluation.candidate.longEntry?.minAbsFundingSpread ?? evaluation.candidate.minAbsFundingSpread,
      longZ: evaluation.candidate.longEntry?.minAbsFundingZScore ?? evaluation.candidate.minAbsFundingZScore ?? 0,
      persistenceBars: evaluation.candidate.signalPersistenceBars ?? 0,
      maxHoldingBars: evaluation.candidate.maxHoldingBars,
      tradeCount: evaluation.backtest.metrics.tradeCount,
      netExpectancyPct: evaluation.backtest.metrics.netExpectancyPct,
      sharpe: evaluation.backtest.metrics.sharpe,
      failedWindows: evaluation.wfo.failedWindows,
      pbo: significance.pboResult.pbo,
      dsrValue: significance.dsrResult.dsrValue,
      paper: releaseGate.allowPaperTrading,
      live: releaseGate.allowLiveTrading,
    }
  })

  return {
    maxFamilySize,
    maxEntryOverlap,
    familySize: rows.length,
    paperCandidates: rows.filter((row) => row.paper),
    candidates: rows,
  }
}

function buildPairFamilies(
  evaluations: MicroEvaluation[],
  baselineCandidateId: string,
  maxAllowedOverlap: number,
): PairFamilyRow[] {
  const baseline = evaluations.find((evaluation) => evaluation.candidate.id === baselineCandidateId)
  if (!baseline) return []

  const rows: PairFamilyRow[] = []
  for (const evaluation of evaluations) {
    if (evaluation.candidate.id === baselineCandidateId) continue
    const overlap = computeEntryOverlap(baseline.backtest, evaluation.backtest)
    if (overlap > maxAllowedOverlap) continue

    const ordered = [baseline, evaluation].sort((left, right) => compareRows(left.row, right.row))
    const selected = ordered[0]
    const significance = evaluateSignificanceGate({
      candidateReturns: [baseline.backtest.returns, evaluation.backtest.returns],
      selectedReturns: selected.backtest.returns,
      partitions: 6,
      pboThreshold: 0.2,
      dsrMin: 0,
      trialCount: 2,
      trialLedger: buildTrialLedgerSummary({
        rawM: 2,
        effectiveM: 2,
        survivingTrialCount: 1,
        rawMComplete: true,
        includesFailedTrials: true,
      }),
    })
    const releaseGate = evaluateReleaseGate({
      wfo: selected.wfo,
      significance,
      riskSimulation: selected.riskSimulation,
      economics: buildEconomics(selected.backtest),
    })

    rows.push({
      baselineCandidateId,
      partnerCandidateId: evaluation.candidate.id,
      selectedCandidateId: selected.candidate.id,
      maxEntryOverlap: overlap,
      selectedNetExpectancyPct: selected.backtest.metrics.netExpectancyPct,
      selectedSharpe: selected.backtest.metrics.sharpe,
      selectedTradeCount: selected.backtest.metrics.tradeCount,
      selectedFailedWindows: selected.wfo.failedWindows,
      selectedPbo: significance.pboResult.pbo,
      selectedDsrValue: significance.dsrResult.dsrValue,
      selectedPaper: releaseGate.allowPaperTrading,
      selectedLive: releaseGate.allowLiveTrading,
    })
  }

  return rows.sort((left, right) => {
    if (Number(left.selectedPaper) !== Number(right.selectedPaper)) {
      return Number(right.selectedPaper) - Number(left.selectedPaper)
    }
    if (left.selectedPbo !== right.selectedPbo) {
      return left.selectedPbo - right.selectedPbo
    }
    if (left.selectedFailedWindows !== right.selectedFailedWindows) {
      return left.selectedFailedWindows - right.selectedFailedWindows
    }
    if (left.selectedNetExpectancyPct !== right.selectedNetExpectancyPct) {
      return right.selectedNetExpectancyPct - left.selectedNetExpectancyPct
    }
    return right.selectedSharpe - left.selectedSharpe
  })
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

export {
  buildMicroSweepCandidates,
  parseArgs,
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
