import {
  evaluateReleaseGate,
  type StrategyPlanEvidenceGateInput,
} from '../../src/backtest/release_gate.js'
import { evaluateRiskSimulation } from '../../src/backtest/risk_simulation.js'
import { evaluateSignificanceGate } from '../../src/backtest/statistical_significance.js'
import {
  sessionAwareSlippageEstimate,
  type IntradayLiquiditySession,
} from '../../src/live/execution_quality.js'
import type { CarrySignalPoint } from './derivatives_history.ts'
import type { PairMarketCandle } from './pair_market_data.ts'

export interface CarryBacktestCandidate {
  id: string
  minAbsFundingSpread: number
  minAbsFundingZScore?: number
  allowLong?: boolean
  allowShort?: boolean
  longEntry?: {
    minAbsFundingSpread: number
    minAbsFundingZScore?: number
  }
  shortEntry?: {
    minAbsFundingSpread: number
    minAbsFundingZScore?: number
  }
  maxHoldingBars: number
  stopLossPct: number
  positionPctOfEquity: number
  signalPersistenceBars?: number
}

export interface CarryTrade {
  direction: 'long_pair' | 'short_pair'
  entryTime: number
  entryPrice?: number
  exitTime: number
  exitPrice?: number
  holdingBars: number
  holdingHours?: number
  rawReturnPct: number
  feeDragPct?: number
  slippageDragPct?: number
  fundingDragPct?: number
  totalCostPct: number
  netReturnPct: number
  fundingSpreadAtEntry: number
}

export interface CarryBacktestMetrics {
  initialCapital?: number
  finalEquity?: number
  totalReturnPct: number
  grossExpectancyPct?: number
  netExpectancyPct: number
  feeExpectancyDragPct?: number
  slippageExpectancyDragPct?: number
  fundingExpectancyDragPct?: number
  totalCostsPaid?: number
  totalFeesPaid?: number
  totalSlippagePaid?: number
  totalFundingPaid?: number
  costDragPctOfInitialCapital?: number
  totalTurnoverUsd?: number
  turnoverPctOfInitialCapital?: number
  averageTurnoverPctPerTrade?: number
  tradeCount: number
  longTradeCount?: number
  shortTradeCount?: number
  averageHoldingBars?: number
  averageHoldingHours: number
  medianHoldingBars?: number
  medianHoldingHours?: number
  maxDrawdownPct: number
  sharpe: number
  sortino?: number
}

export interface CarryBacktestResult {
  candidate: CarryBacktestCandidate
  trades: CarryTrade[]
  equityCurve: Array<{ time: number; equity: number }>
  returns: number[]
  metrics: CarryBacktestMetrics
}

export interface CarryWindowResult {
  windowIndex: number
  selectedCandidate: string
  inSampleSharpe: number
  outOfSampleSharpe: number
  degradationRate: number | null
  gatePassed: boolean
  gateReason?: 'is_non_positive_sharpe' | 'degradation_exceeded' | 'insufficient_oos_trades'
}

export interface CarryValidationSummary {
  selectedCandidate: CarryBacktestCandidate
  selectedMetrics: CarryBacktestMetrics
  selectedInSampleMetrics?: CarryBacktestMetrics
  trades: CarryTrade[]
  wfo: {
    overallPassed: boolean
    failedWindows: number
    windows: CarryWindowResult[]
  }
  significance: ReturnType<typeof evaluateSignificanceGate>
  riskSimulation: ReturnType<typeof evaluateRiskSimulation>
  releaseGate: ReturnType<typeof evaluateReleaseGate>
  strategyPlanEvidence: StrategyPlanEvidenceGateInput
  equityCurve: Array<{ time: number; equity: number }>
  sampleSplit: {
    selectedOn: 'selection'
    evaluatedOn: 'holdout'
    selectionBars: number
    holdoutBars: number
    selectionLeakageCheck: {
      passed: boolean
      reason: string
    }
  }
}

interface ActiveCarryTrade {
  entryIndex: number
  entryTime: number
  entryPrice: number
  direction: 1 | -1
  positionPctOfEquity: number
  fundingSpreadAtEntry: number
  feeCostRate: number
  slippageCostRate: number
  fundingCostRate: number
}

const FEE_RATE = 0.0006
const SLIPPAGE_RATE = 6 / 10_000
const BASELINE_SLIPPAGE_BPS = 6
const LEG_COUNT = 2
const INITIAL_CAPITAL = 1

export function buildCarryEconomics(backtest: CarryBacktestResult) {
  const tradeCount = backtest.metrics.tradeCount
  const initialCapital = backtest.metrics.initialCapital ?? INITIAL_CAPITAL
  const grossExpectancyPct =
    backtest.metrics.grossExpectancyPct
    ?? average(backtest.trades.map((trade) => trade.rawReturnPct))
  const feeExpectancyDragPct =
    backtest.metrics.feeExpectancyDragPct
    ?? average(backtest.trades.map((trade) => trade.feeDragPct ?? trade.totalCostPct / 2))
  const slippageExpectancyDragPct =
    backtest.metrics.slippageExpectancyDragPct
    ?? average(backtest.trades.map((trade) => trade.slippageDragPct ?? trade.totalCostPct / 2))
  const fundingExpectancyDragPct =
    backtest.metrics.fundingExpectancyDragPct
    ?? average(backtest.trades.map((trade) => trade.fundingDragPct ?? 0))
  const totalFeesPaid =
    backtest.metrics.totalFeesPaid
    ?? sum(backtest.trades.map((trade) => ((trade.feeDragPct ?? trade.totalCostPct / 2) / 100) * initialCapital))
  const totalSlippagePaid =
    backtest.metrics.totalSlippagePaid
    ?? sum(backtest.trades.map((trade) => ((trade.slippageDragPct ?? trade.totalCostPct / 2) / 100) * initialCapital))
  const totalFundingPaid =
    backtest.metrics.totalFundingPaid
    ?? sum(backtest.trades.map((trade) => ((trade.fundingDragPct ?? 0) / 100) * initialCapital))
  const totalCostsPaid =
    backtest.metrics.totalCostsPaid
    ?? (totalFeesPaid + totalSlippagePaid + totalFundingPaid)
  const costDragPctOfInitialCapital =
    backtest.metrics.costDragPctOfInitialCapital
    ?? (initialCapital > 0 ? (totalCostsPaid / initialCapital) * 100 : 0)

  return {
    grossExpectancyPct,
    netExpectancyPct: backtest.metrics.netExpectancyPct,
    feeExpectancyDragPct,
    slippageExpectancyDragPct,
    fundingExpectancyDragPct,
    totalCostsPaid,
    costDragPctOfInitialCapital,
    averageHoldingHours: backtest.metrics.averageHoldingHours,
    medianHoldingHours:
      backtest.metrics.medianHoldingHours
      ?? median(backtest.trades.map((trade) => trade.holdingHours ?? trade.holdingBars)),
    tradeCount,
  }
}

export function runCarryValidation(input: {
  candles: PairMarketCandle[]
  carrySignals: CarrySignalPoint[]
  candidates: CarryBacktestCandidate[]
  trainBars: number
  testBars: number
  stepBars: number
  riskSimulationCount: number
}): CarryValidationSummary {
  const holdoutBars = Math.max(1, Math.min(input.testBars, Math.floor(input.candles.length * 0.2)))
  const selectionCandles = input.candles.slice(0, input.candles.length - holdoutBars)
  const holdoutCandles = input.candles.slice(input.candles.length - holdoutBars)
  if (selectionCandles.length < 1 || holdoutCandles.length < 1) {
    throw new Error('Not enough candles to create non-overlapping carry selection and holdout samples.')
  }
  const selectionSignals = filterSignals(input.carrySignals, selectionCandles)
  const holdoutSignals = filterSignals(input.carrySignals, holdoutCandles)

  const candidateResults = input.candidates.map((candidate) =>
    runCarryBacktest({
      candles: selectionCandles,
      carrySignals: selectionSignals,
      candidate,
    }),
  )

  const selected = selectCarryCandidate(candidateResults, 3)
  const selectedCandidateIndex = candidateResults.indexOf(selected)
  if (selectedCandidateIndex < 0) {
    throw new Error('Selected carry candidate was not found in the candidate result set.')
  }
  const holdoutResults = input.candidates.map((candidate) =>
    runCarryBacktest({
      candles: holdoutCandles,
      carrySignals: holdoutSignals,
      candidate,
    }),
  )
  const selectedEvaluation = holdoutResults[selectedCandidateIndex]
  const wfo = runCarryWalkForward({
    candles: input.candles,
    carrySignals: input.carrySignals,
    candidates: input.candidates,
    trainBars: input.trainBars,
    testBars: input.testBars,
    stepBars: input.stepBars,
    minTradesForSelection: 2,
  })
  const significance = evaluateSignificanceGate({
    candidateReturns: holdoutResults.map((result) => result.returns),
    selectedReturns: selectedEvaluation.returns,
    partitions: 6,
    pboThreshold: 0.2,
    dsrMin: 0,
    trialCount: input.candidates.length,
  })
  const riskSimulation = evaluateRiskSimulation(selectedEvaluation.returns, {
    simulations: input.riskSimulationCount,
    horizonBars: input.testBars,
    blockSize: 24,
    ruinDrawdownPct: 30,
    maxRuinProbability: 0.02,
    minProfitProbability: 0.55,
  })
  const strategyPlanEvidence = buildCarryStrategyPlanEvidence(selectedEvaluation)
  const releaseGate = evaluateReleaseGate({
    wfo,
    significance,
    riskSimulation,
    economics: buildCarryEconomics(selectedEvaluation),
    strategyPlanEvidence,
  })

  return {
    selectedCandidate: selected.candidate,
    selectedMetrics: selectedEvaluation.metrics,
    selectedInSampleMetrics: selected.metrics,
    trades: selectedEvaluation.trades,
    wfo,
    significance,
    riskSimulation,
    releaseGate,
    strategyPlanEvidence,
    equityCurve: selectedEvaluation.equityCurve,
    sampleSplit: {
      selectedOn: 'selection',
      evaluatedOn: 'holdout',
      selectionBars: selectionCandles.length,
      holdoutBars: holdoutCandles.length,
      selectionLeakageCheck: {
        passed: true,
        reason: 'selectedOn and evaluatedOn are non-overlapping samples',
      },
    },
  }
}

export function runCarryBacktest(input: {
  candles: PairMarketCandle[]
  carrySignals: CarrySignalPoint[]
  candidate: CarryBacktestCandidate
}): CarryBacktestResult {
  const signalByTime = new Map(
    input.carrySignals
      .filter((point) => signalPassesCarryCandidate(point, input.candidate))
      .map((point) => [point.time, point]),
  )
  const fundingSpreadByTime = new Map(input.carrySignals.map((point) => [point.time, point.fundingSpread]))
  const barSeconds = estimateBarSeconds(input.candles)

  let equity = INITIAL_CAPITAL
  let peak = INITIAL_CAPITAL
  let maxDrawdownPct = 0
  let totalFeesPaid = 0
  let totalSlippagePaid = 0
  let totalFundingPaid = 0
  let totalTurnoverUsd = 0
  let openTrade: ActiveCarryTrade | null = null

  const trades: CarryTrade[] = []
  const returns: number[] = []
  const equityCurve: Array<{ time: number; equity: number }> = input.candles.length > 0
    ? [{ time: input.candles[0].time, equity }]
    : []

  for (let index = 1; index < input.candles.length; index += 1) {
    const previous = input.candles[index - 1]
    const current = input.candles[index]
    const stepStartEquity = equity

    if (!openTrade) {
      const entrySignal = resolveEntrySignal({
        signalByTime,
        currentTime: previous.time,
        persistenceBars: input.candidate.signalPersistenceBars ?? 8,
        barSeconds,
      })
      if (entrySignal) {
        const entryTurnoverUsd = stepStartEquity * input.candidate.positionPctOfEquity * LEG_COUNT
        totalTurnoverUsd += entryTurnoverUsd
        openTrade = {
          entryIndex: index - 1,
          entryTime: previous.time,
          entryPrice: previous.close,
          direction: entrySignal.fundingSpread > 0 ? -1 : 1,
          positionPctOfEquity: input.candidate.positionPctOfEquity,
          fundingSpreadAtEntry: entrySignal.fundingSpread,
          feeCostRate: 0,
          slippageCostRate: 0,
          fundingCostRate: 0,
        }
        const entryFeeRate = input.candidate.positionPctOfEquity * LEG_COUNT * FEE_RATE
        const entrySlippageRate = input.candidate.positionPctOfEquity * LEG_COUNT * SLIPPAGE_RATE
        totalFeesPaid += stepStartEquity * entryFeeRate
        totalSlippagePaid += stepStartEquity * entrySlippageRate
        openTrade.feeCostRate += entryFeeRate
        openTrade.slippageCostRate += entrySlippageRate
        equity = Math.max(0, equity * (1 - entryFeeRate - entrySlippageRate))
      }
    }

    if (openTrade) {
      const stepPriceReturn =
        openTrade.direction
        * priceReturn(previous.close, current.close)
        * openTrade.positionPctOfEquity
      equity = Math.max(0, equity * (1 + stepPriceReturn))

      const fundingSpread = fundingSpreadByTime.get(current.time)
      if (typeof fundingSpread === 'number' && Number.isFinite(fundingSpread)) {
        const fundingCostRate = openTrade.direction * fundingSpread * openTrade.positionPctOfEquity
        const fundingBaseEquity = equity
        totalFundingPaid += fundingBaseEquity * fundingCostRate
        openTrade.fundingCostRate += fundingCostRate
        equity = Math.max(0, equity * (1 - fundingCostRate))
      }

      const cumulativeRawReturn =
        openTrade.direction
        * priceReturn(openTrade.entryPrice, current.close)
        * openTrade.positionPctOfEquity
      const holdingBars = index - openTrade.entryIndex
      const stopHit = cumulativeRawReturn <= -input.candidate.stopLossPct * openTrade.positionPctOfEquity
      const timedExit = holdingBars >= input.candidate.maxHoldingBars
      const signalExit =
        signalByTime.has(current.time)
        && Math.sign(signalByTime.get(current.time)!.fundingSpread) !== Math.sign(openTrade.fundingSpreadAtEntry)

      if (stopHit || timedExit || signalExit) {
        totalTurnoverUsd += equity * input.candidate.positionPctOfEquity * LEG_COUNT
        const exitFeeRate = openTrade.positionPctOfEquity * LEG_COUNT * FEE_RATE
        const exitSlippageRate = openTrade.positionPctOfEquity * LEG_COUNT * SLIPPAGE_RATE
        totalFeesPaid += equity * exitFeeRate
        totalSlippagePaid += equity * exitSlippageRate
        openTrade.feeCostRate += exitFeeRate
        openTrade.slippageCostRate += exitSlippageRate
        equity = Math.max(0, equity * (1 - exitFeeRate - exitSlippageRate))
        trades.push(closeCarryTrade(openTrade, current.time, current.close, index, barSeconds))
        openTrade = null
      }
    }

    peak = Math.max(peak, equity)
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct(peak, equity))
    returns.push(stepStartEquity > 0 ? equity / stepStartEquity - 1 : 0)
    equityCurve.push({ time: current.time, equity })
  }

  if (openTrade && input.candles.length > 0) {
    const last = input.candles[input.candles.length - 1]
    totalTurnoverUsd += equity * input.candidate.positionPctOfEquity * LEG_COUNT
    const exitFeeRate = openTrade.positionPctOfEquity * LEG_COUNT * FEE_RATE
    const exitSlippageRate = openTrade.positionPctOfEquity * LEG_COUNT * SLIPPAGE_RATE
    totalFeesPaid += equity * exitFeeRate
    totalSlippagePaid += equity * exitSlippageRate
    openTrade.feeCostRate += exitFeeRate
    openTrade.slippageCostRate += exitSlippageRate
    equity = Math.max(0, equity * (1 - exitFeeRate - exitSlippageRate))
    trades.push(closeCarryTrade(openTrade, last.time, last.close, input.candles.length - 1, barSeconds))
    peak = Math.max(peak, equity)
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct(peak, equity))
    if (equityCurve.length > 0) {
      equityCurve[equityCurve.length - 1] = { time: last.time, equity }
    } else {
      equityCurve.push({ time: last.time, equity })
    }
  }

  const longTradeCount = trades.filter((trade) => trade.direction === 'long_pair').length
  const shortTradeCount = trades.filter((trade) => trade.direction === 'short_pair').length
  const holdingBars = trades.map((trade) => trade.holdingBars).sort((left, right) => left - right)
  const holdingHours = trades
    .map((trade) => trade.holdingHours ?? (trade.holdingBars * barSeconds) / 3600)
    .sort((left, right) => left - right)
  const feeExpectancyDragPct = average(trades.map((trade) => trade.feeDragPct ?? trade.totalCostPct / 2))
  const slippageExpectancyDragPct = average(trades.map((trade) => trade.slippageDragPct ?? trade.totalCostPct / 2))
  const fundingExpectancyDragPct = average(trades.map((trade) => trade.fundingDragPct ?? 0))
  const grossExpectancyPct = average(trades.map((trade) => trade.rawReturnPct))
  const netExpectancyPct = average(trades.map((trade) => trade.netReturnPct))
  const totalCostsPaid = totalFeesPaid + totalSlippagePaid + totalFundingPaid
  const turnoverPctOfInitialCapital =
    INITIAL_CAPITAL > 0 ? (totalTurnoverUsd / INITIAL_CAPITAL) * 100 : 0

  return {
    candidate: input.candidate,
    trades,
    equityCurve,
    returns,
    metrics: {
      initialCapital: INITIAL_CAPITAL,
      finalEquity: equity,
      totalReturnPct: (equity - INITIAL_CAPITAL) * 100,
      grossExpectancyPct,
      netExpectancyPct,
      feeExpectancyDragPct,
      slippageExpectancyDragPct,
      fundingExpectancyDragPct,
      totalCostsPaid,
      totalFeesPaid,
      totalSlippagePaid,
      totalFundingPaid,
      costDragPctOfInitialCapital: INITIAL_CAPITAL > 0 ? (totalCostsPaid / INITIAL_CAPITAL) * 100 : 0,
      totalTurnoverUsd,
      turnoverPctOfInitialCapital,
      averageTurnoverPctPerTrade: trades.length > 0 ? turnoverPctOfInitialCapital / trades.length : 0,
      tradeCount: trades.length,
      longTradeCount,
      shortTradeCount,
      averageHoldingBars: average(holdingBars),
      averageHoldingHours: average(holdingHours),
      medianHoldingBars: median(holdingBars),
      medianHoldingHours: median(holdingHours),
      maxDrawdownPct,
      sharpe: sharpe(returns),
      sortino: sortino(returns),
    },
  }
}

export function buildCarryStrategyPlanEvidence(
  backtest: CarryBacktestResult,
): StrategyPlanEvidenceGateInput {
  return {
    sessionAwareSlippageEstimate: summarizeCarrySessionAwareSlippage({
      trades: backtest.trades,
      baselineSlippageBps: BASELINE_SLIPPAGE_BPS,
    }),
  }
}

export function summarizeCarrySessionAwareSlippage(input: {
  trades: CarryTrade[]
  baselineSlippageBps: number
}) {
  const estimates = input.trades.map((trade) =>
    sessionAwareSlippageEstimate(trade.entryTime * 1000, input.baselineSlippageBps),
  )
  const bySession = (['asia', 'europe', 'us', 'off_hours'] as const).map((session) => {
    const bucket = estimates.filter((estimate) => estimate.session === session)
    return {
      session,
      tradeCount: bucket.length,
      averageEstimatedSlippageBps: average(bucket.map((estimate) => estimate.estimatedSlippageBps)),
      maxEstimatedSlippageBps:
        bucket.length > 0 ? Math.max(...bucket.map((estimate) => estimate.estimatedSlippageBps)) : 0,
      handoffTradeCount: bucket.filter((estimate) => estimate.handoffPenaltyBps > 0).length,
    }
  })

  return {
    available: estimates.length > 0,
    tradeCount: estimates.length,
    baselineSlippageBps: input.baselineSlippageBps,
    averageEstimatedSlippageBps: average(estimates.map((estimate) => estimate.estimatedSlippageBps)),
    maxEstimatedSlippageBps:
      estimates.length > 0
        ? Math.max(...estimates.map((estimate) => estimate.estimatedSlippageBps))
        : 0,
    dominantSession: selectDominantLiquiditySession(bySession),
    bySession,
    reason:
      estimates.length > 0
        ? null
        : 'No holdout trades were available for session-aware slippage estimation.',
  }
}

function selectDominantLiquiditySession(
  bySession: Array<{
    session: IntradayLiquiditySession
    tradeCount: number
    averageEstimatedSlippageBps: number
  }>,
): IntradayLiquiditySession | null {
  const active = bySession.filter((bucket) => bucket.tradeCount > 0)
  if (active.length === 0) {
    return null
  }
  return [...active].sort((left, right) => right.tradeCount - left.tradeCount)[0].session
}

export function signalPassesCarryCandidate(
  point: CarrySignalPoint,
  candidate: CarryBacktestCandidate,
): boolean {
  const entry = resolveDirectionalEntry(point.fundingSpread, candidate)
  if (!entry) {
    return false
  }
  if (Math.abs(point.fundingSpread) < entry.minAbsFundingSpread) {
    return false
  }
  if (
    typeof entry.minAbsFundingZScore === 'number'
    && Math.abs(point.fundingSpreadZScore) < entry.minAbsFundingZScore
  ) {
    return false
  }
  return true
}

function resolveDirectionalEntry(
  fundingSpread: number,
  candidate: CarryBacktestCandidate,
): { minAbsFundingSpread: number; minAbsFundingZScore?: number } | null {
  if (fundingSpread > 0) {
    if (candidate.allowShort === false) {
      return null
    }
    return candidate.shortEntry ?? {
      minAbsFundingSpread: candidate.minAbsFundingSpread,
      minAbsFundingZScore: candidate.minAbsFundingZScore,
    }
  }
  if (fundingSpread < 0) {
    if (candidate.allowLong === false) {
      return null
    }
    return candidate.longEntry ?? {
      minAbsFundingSpread: candidate.minAbsFundingSpread,
      minAbsFundingZScore: candidate.minAbsFundingZScore,
    }
  }
  return null
}

function resolveEntrySignal(input: {
  signalByTime: Map<number, CarrySignalPoint>
  currentTime: number
  persistenceBars: number
  barSeconds: number
}): CarrySignalPoint | undefined {
  const direct = input.signalByTime.get(input.currentTime)
  if (direct && signalObservedBeforeDecision(direct, input.currentTime)) return direct

  for (let offset = 1; offset <= input.persistenceBars; offset += 1) {
    const candidateTime = input.currentTime - offset * input.barSeconds
    const signal = input.signalByTime.get(candidateTime)
    if (signal && signalObservedBeforeDecision(signal, input.currentTime)) return signal
  }
  return undefined
}

function signalObservedBeforeDecision(
  signal: CarrySignalPoint,
  decisionTime: number,
): boolean {
  return typeof signal.observedAt === 'number'
    ? signal.observedAt < decisionTime
    : true
}

function estimateBarSeconds(candles: PairMarketCandle[]): number {
  if (candles.length < 2) return 3600
  return Math.max(1, candles[1].time - candles[0].time)
}

function closeCarryTrade(
  activeTrade: ActiveCarryTrade,
  exitTime: number,
  exitPrice: number,
  exitIndex: number,
  barSeconds: number,
): CarryTrade {
  const rawReturn =
    activeTrade.direction
    * priceReturn(activeTrade.entryPrice, exitPrice)
    * activeTrade.positionPctOfEquity
  const holdingBars = Math.max(1, exitIndex - activeTrade.entryIndex)
  const holdingHours = (holdingBars * barSeconds) / 3600
  const feeDragPct = activeTrade.feeCostRate * 100
  const slippageDragPct = activeTrade.slippageCostRate * 100
  const fundingDragPct = activeTrade.fundingCostRate * 100
  const totalCostPct = feeDragPct + slippageDragPct + fundingDragPct

  return {
    direction: activeTrade.direction === 1 ? 'long_pair' : 'short_pair',
    entryTime: activeTrade.entryTime,
    entryPrice: activeTrade.entryPrice,
    exitTime,
    exitPrice,
    holdingBars,
    holdingHours,
    rawReturnPct: rawReturn * 100,
    feeDragPct,
    slippageDragPct,
    fundingDragPct,
    totalCostPct,
    netReturnPct: rawReturn * 100 - totalCostPct,
    fundingSpreadAtEntry: activeTrade.fundingSpreadAtEntry,
  }
}

function runCarryWalkForward(input: {
  candles: PairMarketCandle[]
  carrySignals: CarrySignalPoint[]
  candidates: CarryBacktestCandidate[]
  trainBars: number
  testBars: number
  stepBars: number
  minTradesForSelection: number
}) {
  const windows: CarryWindowResult[] = []
  for (
    let trainStart = 0;
    trainStart + input.trainBars + input.testBars <= input.candles.length;
    trainStart += input.stepBars
  ) {
    const trainEnd = trainStart + input.trainBars
    const testEnd = trainEnd + input.testBars
    const trainCandles = input.candles.slice(trainStart, trainEnd)
    const testCandles = input.candles.slice(trainEnd, testEnd)
    const trainSignals = filterSignals(input.carrySignals, trainCandles)
    const testSignals = filterSignals(input.carrySignals, testCandles)

    const ranked = input.candidates
      .map((candidate) => runCarryBacktest({
        candles: trainCandles,
        carrySignals: trainSignals,
        candidate,
      }))
    const best = selectCarryCandidate(ranked, input.minTradesForSelection)
    const oos = runCarryBacktest({
      candles: testCandles,
      carrySignals: testSignals,
      candidate: best.candidate,
    })
    const degradationRate =
      best.metrics.sharpe > 0
        ? (best.metrics.sharpe - oos.metrics.sharpe) / Math.abs(best.metrics.sharpe)
        : null
    const gateReason =
      best.metrics.sharpe <= 0
        ? 'is_non_positive_sharpe'
        : oos.metrics.tradeCount < 1
          ? 'insufficient_oos_trades'
          : degradationRate != null && degradationRate > 0.4
            ? 'degradation_exceeded'
            : undefined

    windows.push({
      windowIndex: windows.length,
      selectedCandidate: best.candidate.id,
      inSampleSharpe: best.metrics.sharpe,
      outOfSampleSharpe: oos.metrics.sharpe,
      degradationRate,
      gatePassed: gateReason == null,
      gateReason,
    })
  }

  const failedWindows = windows.filter((window) => !window.gatePassed).length
  return {
    overallPassed: failedWindows === 0,
    failedWindows,
    windows,
  }
}

function selectCarryCandidate(
  results: CarryBacktestResult[],
  minTrades: number,
): CarryBacktestResult {
  const qualified = results.filter((result) => result.metrics.tradeCount >= minTrades)
  const source = qualified.length > 0 ? qualified : results
  return [...source].sort(compareCarryCandidates)[0]
}

function compareCarryCandidates(
  left: CarryBacktestResult,
  right: CarryBacktestResult,
): number {
  if (left.metrics.tradeCount !== right.metrics.tradeCount) {
    return right.metrics.tradeCount - left.metrics.tradeCount
  }
  if (left.metrics.sharpe !== right.metrics.sharpe) {
    return right.metrics.sharpe - left.metrics.sharpe
  }
  return right.metrics.netExpectancyPct - left.metrics.netExpectancyPct
}

function filterSignals(
  signals: CarrySignalPoint[],
  candles: PairMarketCandle[],
): CarrySignalPoint[] {
  const times = new Set(candles.map((candle) => candle.time))
  return signals.filter((signal) => times.has(signal.time))
}

function priceReturn(entryPrice: number, exitPrice: number): number {
  if (!Number.isFinite(entryPrice) || Math.abs(entryPrice) <= Number.EPSILON) {
    return 0
  }
  return (exitPrice - entryPrice) / entryPrice
}

function drawdownPct(peak: number, equity: number): number {
  if (peak <= 0) return 0
  return ((peak - equity) / peak) * 100
}

function sharpe(returns: number[]): number {
  const filtered = returns.filter((value) => Number.isFinite(value))
  if (filtered.length < 2) return 0
  const avg = filtered.reduce((sum, value) => sum + value, 0) / filtered.length
  const variance = filtered.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (filtered.length - 1)
  const std = Math.sqrt(Math.max(variance, 0))
  if (std === 0) return 0
  return (avg / std) * Math.sqrt(24 * 365)
}

function sortino(returns: number[]): number {
  if (returns.length < 2) {
    return 0
  }
  const meanReturn = average(returns)
  const downside = returns.filter((value) => value < 0)
  if (downside.length < 1) {
    return meanReturn > 0 ? Number.POSITIVE_INFINITY : 0
  }
  const downsideVariance =
    downside.reduce((sum, value) => sum + value ** 2, 0) / downside.length
  const downsideDeviation = Math.sqrt(Math.max(downsideVariance, 0))
  return downsideDeviation > 0 ? (meanReturn / downsideDeviation) * Math.sqrt(24 * 365) : 0
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}
