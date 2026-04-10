import {
  classifyStrategyRegimeSnapshot,
  evaluateStrategy,
  getStrategyMinimumBars,
} from './strategies.js'
import type {
  MarketData,
  PositionSignal,
  StrategyDecision,
  StrategyName,
  StrategyParams,
  StrategyRegimeLabel,
} from './types.js'
import { resolveStrategyParams } from './types.js'

export interface BacktestCostModel {
  feeRate: number
  slippageBps: number
  latencyBars: number
  fundingRatePer8h: number
}

export interface BacktestTrade {
  direction: 'long' | 'short'
  entryTime: number
  entryPrice: number
  entryReferencePrice: number
  exitTime: number
  exitPrice: number
  exitReferencePrice: number
  holdingBars: number
  holdingHours: number
  entryRegime: StrategyRegimeLabel
  rawReturnPct: number
  feeDragPct: number
  slippageDragPct: number
  fundingDragPct: number
  totalCostPct: number
  netReturnPct: number
}

export interface BacktestRegimeSummary {
  tradeCount: number
  winRatePct: number
  grossExpectancyPct: number
  feeExpectancyDragPct: number
  slippageExpectancyDragPct: number
  fundingExpectancyDragPct: number
  totalCostExpectancyDragPct: number
  netExpectancyPct: number
  expectancyPct: number
  totalGrossReturnPct: number
  totalNetReturnPct: number
}

export interface BacktestMetrics {
  initialCapital: number
  finalEquity: number
  totalReturnPct: number
  annualizedReturnPct: number
  maxDrawdownPct: number
  sharpe: number
  sortino: number
  calmar: number
  winRatePct: number
  profitFactor: number
  payoffRatio: number
  averageWinPct: number
  averageLossPct: number
  grossExpectancyPct: number
  feeExpectancyDragPct: number
  slippageExpectancyDragPct: number
  fundingExpectancyDragPct: number
  netExpectancyPct: number
  expectancyPct: number
  tradeCount: number
  longTradeCount: number
  shortTradeCount: number
  averageHoldingBars: number
  averageHoldingHours: number
  medianHoldingBars: number
  medianHoldingHours: number
  totalFeesPaid: number
  totalSlippagePaid: number
  totalFundingPaid: number
  totalCostsPaid: number
  costDragPctOfInitialCapital: number
  regimeSummary: Partial<Record<StrategyRegimeLabel, BacktestRegimeSummary>>
}

export interface BacktestResult {
  strategy: StrategyName
  params: Required<StrategyParams>
  costModel: BacktestCostModel
  metrics: BacktestMetrics
  trades: BacktestTrade[]
  equityCurve: Array<{ time: number; equity: number }>
  lastDecision: StrategyDecision
}

export interface StrategyBacktestInput {
  strategy: StrategyName
  candles: MarketData[]
  params?: StrategyParams
  initialCapital?: number
  costModel?: Partial<BacktestCostModel>
  regimeGate?: {
    allowedEntryRegimes: StrategyRegimeLabel[]
    exitOnMismatch?: boolean
  }
  entryGate?: {
    allowedEntryTimes: number[]
  }
}

interface ActiveTrade {
  direction: 'long' | 'short'
  entryTime: number
  entryPrice: number
  entryReferencePrice: number
  entryIndex: number
  exposureFraction: number
  entryRegime: StrategyRegimeLabel
  feeCostRate: number
  slippageCostRate: number
  fundingCostRate: number
}

function exposureFractionForStrategy(
  strategy: StrategyName,
  params: Required<StrategyParams>,
): number {
  if (strategy === 'factorMeanReversion') {
    return params.factorPositionPctOfEquity
  }
  return 1
}

const DEFAULT_COST_MODEL: BacktestCostModel = {
  feeRate: 0.0005,
  slippageBps: 3,
  latencyBars: 1,
  fundingRatePer8h: 0,
}

function validateCandles(candles: MarketData[]): MarketData[] {
  if (!Array.isArray(candles) || candles.length < 3) {
    throw new Error('Backtest requires at least 3 candles.')
  }
  const sorted = [...candles].sort((left, right) => left.time - right.time)
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].time <= sorted[index - 1].time) {
      throw new Error('Candles must have strictly increasing timestamps.')
    }
  }
  return sorted
}

function toExecutionPrice(close: number, delta: number, slippageRate: number): number {
  if (delta > 0) {
    return close * (1 + slippageRate)
  }
  if (delta < 0) {
    return close * (1 - slippageRate)
  }
  return close
}

function closeTrade(
  activeTrade: ActiveTrade,
  exitTime: number,
  exitPrice: number,
  exitReferencePrice: number,
  exitIndex: number,
  barSeconds: number,
  sidePosition: PositionSignal,
): BacktestTrade {
  const multiplier = sidePosition === 1 ? 1 : -1
  const rawReturn =
    multiplier * ((exitReferencePrice - activeTrade.entryReferencePrice) / activeTrade.entryReferencePrice) *
    activeTrade.exposureFraction
  const holdingBars = Math.max(1, exitIndex - activeTrade.entryIndex)
  const feeDragPct = activeTrade.feeCostRate * 100
  const slippageDragPct = activeTrade.slippageCostRate * 100
  const fundingDragPct = activeTrade.fundingCostRate * 100
  const totalCostPct = feeDragPct + slippageDragPct + fundingDragPct
  return {
    direction: activeTrade.direction,
    entryTime: activeTrade.entryTime,
    entryPrice: activeTrade.entryPrice,
    entryReferencePrice: activeTrade.entryReferencePrice,
    exitTime,
    exitPrice,
    exitReferencePrice,
    holdingBars,
    holdingHours: (holdingBars * barSeconds) / 3600,
    entryRegime: activeTrade.entryRegime,
    rawReturnPct: rawReturn * 100,
    feeDragPct,
    slippageDragPct,
    fundingDragPct,
    totalCostPct,
    netReturnPct: rawReturn * 100 - totalCostPct,
  }
}

function isRegimeAllowed(
  regime: StrategyRegimeLabel,
  gate: StrategyBacktestInput['regimeGate'] | undefined,
): boolean {
  if (!gate || gate.allowedEntryRegimes.length < 1) {
    return true
  }
  return gate.allowedEntryRegimes.includes(regime)
}

function isEntryTimeAllowed(
  time: number,
  gate: StrategyBacktestInput['entryGate'] | undefined,
): boolean {
  if (!gate || gate.allowedEntryTimes.length < 1) {
    return true
  }
  return gate.allowedEntryTimes.includes(time)
}

function annualizedSharpe(stepReturns: number[], barsPerYear: number): number {
  if (stepReturns.length < 2) {
    return 0
  }
  const mean =
    stepReturns.reduce((sum, value) => sum + value, 0) / stepReturns.length
  const variance =
    stepReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (stepReturns.length - 1)
  const stdev = Math.sqrt(Math.max(variance, 0))
  if (stdev === 0) {
    return 0
  }
  return (mean / stdev) * Math.sqrt(Math.max(1, barsPerYear))
}

function annualizedSortino(stepReturns: number[], barsPerYear: number): number {
  if (stepReturns.length < 2) {
    return 0
  }
  const avg =
    stepReturns.reduce((sum, value) => sum + value, 0) / stepReturns.length
  const downside = stepReturns.map((value) => Math.min(0, value))
  const downsideVariance =
    downside.reduce((sum, value) => sum + value * value, 0) / stepReturns.length
  const downsideDeviation = Math.sqrt(Math.max(downsideVariance, 0))
  if (downsideDeviation === 0) {
    return 0
  }
  return (avg / downsideDeviation) * Math.sqrt(Math.max(1, barsPerYear))
}

function normalizeTimeDeltaToSeconds(delta: number): number {
  if (!Number.isFinite(delta)) {
    return delta
  }
  const absDelta = Math.abs(delta)
  if (absDelta >= 1000 && absDelta % 1000 === 0) {
    return delta / 1000
  }
  return delta
}

export function runStrategyBacktest(input: StrategyBacktestInput): BacktestResult {
  const candles = validateCandles(input.candles)
  const params = resolveStrategyParams(input.params)
  const minBars = getStrategyMinimumBars(input.strategy, params)
  if (candles.length < minBars + 2) {
    throw new Error(
      `Not enough candles for ${input.strategy}: requires >= ${minBars + 2}, got ${candles.length}.`,
    )
  }

  const costModel: BacktestCostModel = {
    ...DEFAULT_COST_MODEL,
    ...(input.costModel ?? {}),
    latencyBars: Math.max(
      0,
      Math.floor(input.costModel?.latencyBars ?? DEFAULT_COST_MODEL.latencyBars),
    ),
  }
  const feeRate = Math.max(0, costModel.feeRate)
  const slippageRate = Math.max(0, costModel.slippageBps) / 10_000
  const exposureFraction = exposureFractionForStrategy(input.strategy, params)
  const initialCapital = input.initialCapital ?? 10_000
  let equity = initialCapital
  let peakEquity = equity
  let maxDrawdownPct = 0
  let position: PositionSignal = 0
  let activeTrade: ActiveTrade | null = null
  let totalFeesPaid = 0
  let totalSlippagePaid = 0
  let totalFundingPaid = 0
  let lastDecision: StrategyDecision = {
    strategy: input.strategy,
    signal: 0,
    reason: 'No decision yet.',
    indicators: {},
  }

  const pendingSignals = new Map<number, PositionSignal>()
  const trades: BacktestTrade[] = []
  const equityCurve: Array<{ time: number; equity: number }> = [
    { time: candles[0].time, equity },
  ]
  const stepReturns: number[] = []
  const barSeconds =
    candles.length > 1
      ? Math.max(1, normalizeTimeDeltaToSeconds(candles[1].time - candles[0].time))
      : 3600
  const barsPerYear = Math.round((365 * 24 * 3600) / barSeconds)
  const fundingPerBar = costModel.fundingRatePer8h * (barSeconds / (8 * 3600))

  for (let index = 1; index < candles.length; index += 1) {
    const barStart = candles[index - 1]
    const barEnd = candles[index]
    const barRegime = classifyStrategyRegimeSnapshot({
      candles,
      index: Math.max(0, index - 1),
      params,
    })
    const regimeAllowed = isRegimeAllowed(barRegime.label, input.regimeGate)
    const queuedSignal = pendingSignals.get(index)
    let targetPosition: PositionSignal = queuedSignal ?? position
    const entryTimeAllowed = isEntryTimeAllowed(barStart.time, input.entryGate)
    if (queuedSignal !== undefined && position === 0 && targetPosition !== 0 && !entryTimeAllowed) {
      targetPosition = 0
    }
    if (input.regimeGate && !regimeAllowed && targetPosition !== 0) {
      targetPosition =
        position !== 0
          ? (input.regimeGate.exitOnMismatch ?? true)
            ? 0
            : position
          : 0
    }
    if (targetPosition !== position) {
      const previousPosition = position
      position = targetPosition
      const delta = position - previousPosition
      const closingTrade =
        previousPosition !== 0 &&
        (position === 0 || Math.sign(position) !== Math.sign(previousPosition))
      const openingTrade =
        position !== 0 &&
        (previousPosition === 0 || Math.sign(position) !== Math.sign(previousPosition))
      const closeExposure = closingTrade && activeTrade ? activeTrade.exposureFraction : 0
      const openExposure = openingTrade ? exposureFraction : 0
      const deltaExposure = closeExposure + openExposure
      const feeCost = equity * deltaExposure * feeRate
      const slippageCost = equity * deltaExposure * slippageRate
      totalFeesPaid += feeCost
      totalSlippagePaid += slippageCost
      equity -= feeCost + slippageCost

      const executionPrice = toExecutionPrice(barStart.close, delta, slippageRate)
      if (closingTrade && activeTrade) {
        trades.push(
          closeTrade(
            {
              ...activeTrade,
              feeCostRate: activeTrade.feeCostRate + closeExposure * feeRate,
              slippageCostRate:
                activeTrade.slippageCostRate + closeExposure * slippageRate,
            },
            barStart.time,
            executionPrice,
            barStart.close,
            index - 1,
            barSeconds,
            previousPosition,
          ),
        )
        activeTrade = null
      }

      if (openingTrade) {
        const entryRegime = classifyStrategyRegimeSnapshot({
          candles,
          index: Math.max(0, index - 1),
          params,
        })
        activeTrade = {
          direction: position === 1 ? 'long' : 'short',
          entryTime: barStart.time,
          entryPrice: executionPrice,
          entryReferencePrice: barStart.close,
          entryIndex: index - 1,
          exposureFraction,
          entryRegime: entryRegime.label,
          feeCostRate: openExposure * feeRate,
          slippageCostRate: openExposure * slippageRate,
          fundingCostRate: 0,
        }
      }
    }
    if (queuedSignal !== undefined) {
      pendingSignals.delete(index)
    }

    if (input.strategy === 'factorMeanReversion' && activeTrade && position !== 0) {
      const holdingBars = index - activeTrade.entryIndex
      const rawMove = ((barEnd.close - activeTrade.entryPrice) / activeTrade.entryPrice) * position
      const shouldStop =
        params.factorStopLossPct > 0 &&
        rawMove <= -params.factorStopLossPct
      const shouldTimeExit =
        holdingBars >= params.factorMaxHoldingBars
      if (shouldStop || shouldTimeExit) {
        const executionPrice = toExecutionPrice(barEnd.close, -position, slippageRate)
        const feeCost = equity * activeTrade.exposureFraction * feeRate
        const slippageCost = equity * activeTrade.exposureFraction * slippageRate
        totalFeesPaid += feeCost
        totalSlippagePaid += slippageCost
        equity -= feeCost + slippageCost
        trades.push(
          closeTrade(
            {
              ...activeTrade,
              feeCostRate:
                activeTrade.feeCostRate + activeTrade.exposureFraction * feeRate,
              slippageCostRate:
                activeTrade.slippageCostRate + activeTrade.exposureFraction * slippageRate,
            },
            barEnd.time,
            executionPrice,
            barEnd.close,
            index,
            barSeconds,
            position,
          ),
        )
        position = 0
        activeTrade = null
        pendingSignals.delete(index)
      }
    }

    const barReturn =
      position === 0 ? 0 : ((barEnd.close - barStart.close) / barStart.close) * position * exposureFraction
    const fundingCost = Math.abs(position) * exposureFraction * Math.max(0, fundingPerBar) * equity
    totalFundingPaid += fundingCost
    if (activeTrade && position !== 0 && activeTrade.exposureFraction > 0 && equity > 0) {
      activeTrade.fundingCostRate += fundingCost / equity
    }
    equity = Math.max(0, equity * (1 + barReturn) - fundingCost)
    peakEquity = Math.max(peakEquity, equity)
    const drawdownPct =
      peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct)
    stepReturns.push(barReturn)
    equityCurve.push({ time: barEnd.time, equity })

    lastDecision = evaluateStrategy({
      strategy: input.strategy,
      candles,
      index,
      currentPosition: position,
      params,
    })
    // Preserve the original validation-lane semantics: a decision taken on bar N
    // becomes executable on the next bar plus any configured extra latency.
    const executionIndex = index + 1 + Math.max(0, costModel.latencyBars)
    if (executionIndex < candles.length) {
      pendingSignals.set(executionIndex, lastDecision.signal)
    }
  }

  if (activeTrade) {
    trades.push(
      closeTrade(
        activeTrade,
        candles[candles.length - 1].time,
        candles[candles.length - 1].close,
        candles[candles.length - 1].close,
        candles.length - 1,
        barSeconds,
        position,
      ),
    )
  }

  const grossExpectancyPct =
    trades.length > 0
      ? trades.reduce((sum, trade) => sum + trade.rawReturnPct, 0) / trades.length
      : 0
  const feeExpectancyDragPct =
    trades.length > 0
      ? trades.reduce((sum, trade) => sum + trade.feeDragPct, 0) / trades.length
      : 0
  const slippageExpectancyDragPct =
    trades.length > 0
      ? trades.reduce((sum, trade) => sum + trade.slippageDragPct, 0) / trades.length
      : 0
  const fundingExpectancyDragPct =
    trades.length > 0
      ? trades.reduce((sum, trade) => sum + trade.fundingDragPct, 0) / trades.length
      : 0
  const netExpectancyPct =
    trades.length > 0
      ? trades.reduce((sum, trade) => sum + trade.netReturnPct, 0) / trades.length
      : 0

  const totalReturnPct = ((equity - initialCapital) / initialCapital) * 100
  const totalSeconds =
    normalizeTimeDeltaToSeconds(candles[candles.length - 1].time - candles[0].time) ||
    candles.length * barSeconds
  const years = totalSeconds / (365 * 24 * 3600)
  const annualizedReturnPct =
    years > 0
      ? (Math.pow(Math.max(equity, 0) / initialCapital, 1 / years) - 1) * 100
      : totalReturnPct
  const winCount = trades.filter((trade) => trade.netReturnPct > 0).length
  const grossProfit = trades
    .filter((trade) => trade.netReturnPct > 0)
    .reduce((sum, trade) => sum + trade.netReturnPct, 0)
  const grossLoss = Math.abs(
    trades
      .filter((trade) => trade.netReturnPct < 0)
      .reduce((sum, trade) => sum + trade.netReturnPct, 0),
  )
  const winningTrades = trades.filter((trade) => trade.netReturnPct > 0)
  const losingTrades = trades.filter((trade) => trade.netReturnPct < 0)
  const averageWinPct =
    winningTrades.length > 0
      ? winningTrades.reduce((sum, trade) => sum + trade.netReturnPct, 0) /
        winningTrades.length
      : 0
  const averageLossPct =
    losingTrades.length > 0
      ? losingTrades.reduce((sum, trade) => sum + trade.netReturnPct, 0) /
        losingTrades.length
      : 0
  const expectancyPct = netExpectancyPct
  const holdingBars = trades.map((trade) => trade.holdingBars).sort((a, b) => a - b)
  const holdingHours = trades.map((trade) => trade.holdingHours).sort((a, b) => a - b)
  const longTradeCount = trades.filter((trade) => trade.direction === 'long').length
  const shortTradeCount = trades.filter((trade) => trade.direction === 'short').length
  const totalCostsPaid = totalFeesPaid + totalSlippagePaid + totalFundingPaid
  const regimeSummary = buildRegimeSummary(trades)

  return {
    strategy: input.strategy,
    params,
    costModel,
    metrics: {
      initialCapital,
      finalEquity: equity,
      totalReturnPct,
      annualizedReturnPct,
      maxDrawdownPct,
      sharpe: annualizedSharpe(stepReturns, barsPerYear),
      sortino: annualizedSortino(stepReturns, barsPerYear),
      calmar:
        maxDrawdownPct > 0 ? annualizedReturnPct / maxDrawdownPct : 0,
      winRatePct: trades.length > 0 ? (winCount / trades.length) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      payoffRatio:
        averageLossPct < 0 ? averageWinPct / Math.abs(averageLossPct) : 0,
      averageWinPct,
      averageLossPct,
      grossExpectancyPct,
      feeExpectancyDragPct,
      slippageExpectancyDragPct,
      fundingExpectancyDragPct,
      netExpectancyPct,
      expectancyPct,
      tradeCount: trades.length,
      longTradeCount,
      shortTradeCount,
      averageHoldingBars: percentileFromSorted(holdingBars, 0.5, 'mean'),
      averageHoldingHours: percentileFromSorted(holdingHours, 0.5, 'mean'),
      medianHoldingBars: percentileFromSorted(holdingBars, 0.5, 'median'),
      medianHoldingHours: percentileFromSorted(holdingHours, 0.5, 'median'),
      totalFeesPaid,
      totalSlippagePaid,
      totalFundingPaid,
      totalCostsPaid,
      costDragPctOfInitialCapital:
        initialCapital > 0 ? (totalCostsPaid / initialCapital) * 100 : 0,
      regimeSummary,
    },
    trades,
    equityCurve,
    lastDecision,
  }
}

function percentileFromSorted(
  sorted: number[],
  q: number,
  mode: 'mean' | 'median',
): number {
  if (sorted.length < 1) {
    return 0
  }
  if (mode === 'mean') {
    return sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  }
  const pos = (sorted.length - 1) * q
  const low = Math.floor(pos)
  const high = Math.ceil(pos)
  if (low === high) {
    return sorted[low]
  }
  const weight = pos - low
  return sorted[low] * (1 - weight) + sorted[high] * weight
}

function buildRegimeSummary(
  trades: BacktestTrade[],
): Partial<Record<StrategyRegimeLabel, BacktestRegimeSummary>> {
  const groups = new Map<StrategyRegimeLabel, BacktestTrade[]>()
  for (const trade of trades) {
    const bucket = groups.get(trade.entryRegime) ?? []
    bucket.push(trade)
    groups.set(trade.entryRegime, bucket)
  }
  const summary: Partial<Record<StrategyRegimeLabel, BacktestRegimeSummary>> = {}
  for (const [label, bucket] of groups.entries()) {
    const wins = bucket.filter((trade) => trade.netReturnPct > 0).length
    const totalGrossReturnPct = bucket.reduce(
      (sum, trade) => sum + trade.rawReturnPct,
      0,
    )
    const totalNetReturnPct = bucket.reduce(
      (sum, trade) => sum + trade.netReturnPct,
      0,
    )
    const feeExpectancyDragPct =
      bucket.length > 0
        ? bucket.reduce((sum, trade) => sum + trade.feeDragPct, 0) / bucket.length
        : 0
    const slippageExpectancyDragPct =
      bucket.length > 0
        ? bucket.reduce((sum, trade) => sum + trade.slippageDragPct, 0) / bucket.length
        : 0
    const fundingExpectancyDragPct =
      bucket.length > 0
        ? bucket.reduce((sum, trade) => sum + trade.fundingDragPct, 0) / bucket.length
        : 0
    const grossExpectancyPct =
      bucket.length > 0 ? totalGrossReturnPct / bucket.length : 0
    const netExpectancyPct =
      bucket.length > 0 ? totalNetReturnPct / bucket.length : 0
    summary[label] = {
      tradeCount: bucket.length,
      winRatePct: bucket.length > 0 ? (wins / bucket.length) * 100 : 0,
      grossExpectancyPct,
      feeExpectancyDragPct,
      slippageExpectancyDragPct,
      fundingExpectancyDragPct,
      totalCostExpectancyDragPct:
        feeExpectancyDragPct + slippageExpectancyDragPct + fundingExpectancyDragPct,
      netExpectancyPct,
      expectancyPct: netExpectancyPct,
      totalGrossReturnPct,
      totalNetReturnPct,
    }
  }
  return summary
}
