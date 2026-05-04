import { describe, expect, it } from 'vitest'
import { runCarryBacktest, runCarryValidation } from './carry_backtest.ts'

describe('carry_backtest', () => {
  it('opens and closes a carry trade from funding spread events', () => {
    const candles = Array.from({ length: 80 }, (_, index) => ({
      symbol: 'ETH/BTC_CARRY',
      time: index,
      open: 1,
      high: 1.01,
      low: 0.99,
      close: index < 10 ? 1 : index < 30 ? 0.98 : 1.01,
      volume: 1000,
    }))
    const result = runCarryBacktest({
      candles,
      carrySignals: [
        { time: 9, fundingSpread: -0.0002, fundingSpreadZScore: 2 },
      ],
      candidate: {
        id: 'base',
        minAbsFundingSpread: 0.0001,
        minAbsFundingZScore: 0,
        maxHoldingBars: 12,
        stopLossPct: 0.02,
        positionPctOfEquity: 0.02,
        signalPersistenceBars: 6,
      },
    })

    expect(result.metrics.tradeCount).toBeGreaterThanOrEqual(1)
    expect(result.trades[0]?.direction).toBe('long_pair')
  })

  it('accounts for two-leg costs, funding drag, and mark-to-market returns', () => {
    const candles = Array.from({ length: 16 }, (_, index) => ({
      symbol: 'ETH/BTC_CARRY',
      time: index * 3600,
      open: 1,
      high: 1.01,
      low: 0.99,
      close: 1 + index * 0.002,
      volume: 1000,
    }))
    const result = runCarryBacktest({
      candles,
      carrySignals: [
        { time: candles[2].time, fundingSpread: -0.0004, fundingSpreadZScore: -2 },
        { time: candles[10].time, fundingSpread: 0.0004, fundingSpreadZScore: 2 },
      ],
      candidate: {
        id: 'realistic',
        minAbsFundingSpread: 0.0001,
        minAbsFundingZScore: 0,
        maxHoldingBars: 10,
        stopLossPct: 0.05,
        positionPctOfEquity: 0.02,
        signalPersistenceBars: 2,
      },
    })

    expect(result.metrics.tradeCount).toBeGreaterThanOrEqual(1)
    expect(result.metrics.totalFeesPaid).toBeGreaterThan(0)
    expect(result.metrics.totalSlippagePaid).toBeGreaterThan(0)
    expect(Math.abs(result.metrics.totalFundingPaid ?? 0)).toBeGreaterThan(0)
    expect(result.metrics.fundingExpectancyDragPct).not.toBe(0)
    expect(result.trades[0]?.feeDragPct).toBeGreaterThan(0)
    expect(result.trades[0]?.slippageDragPct).toBeGreaterThan(0)
    expect(result.trades[0]?.fundingDragPct).not.toBe(0)
    expect(result.returns.some((value) => value !== 0)).toBe(true)
    expect(result.equityCurve.length).toBe(candles.length)
  })

  it('does not use same-bar funding observations for entries', () => {
    const candles = Array.from({ length: 12 }, (_, index) => ({
      symbol: 'ETH/BTC_CARRY',
      time: index,
      open: 1,
      high: 1.01,
      low: 0.99,
      close: 1 + index * 0.001,
      volume: 1000,
    }))

    const sameBar = runCarryBacktest({
      candles,
      carrySignals: [
        {
          time: candles[2].time,
          observedAt: candles[2].time,
          effectiveAt: candles[2].time,
          fundingSpread: -0.0004,
          fundingSpreadZScore: -2,
        },
      ],
      candidate: {
        id: 'no-lookahead',
        minAbsFundingSpread: 0.0001,
        minAbsFundingZScore: 0,
        maxHoldingBars: 4,
        stopLossPct: 0.05,
        positionPctOfEquity: 0.02,
        signalPersistenceBars: 0,
      },
    })

    const olderObservation = runCarryBacktest({
      candles,
      carrySignals: [
        {
          time: candles[2].time,
          observedAt: candles[1].time,
          effectiveAt: candles[2].time,
          fundingSpread: -0.0004,
          fundingSpreadZScore: -2,
        },
      ],
      candidate: {
        id: 'observed-before-decision',
        minAbsFundingSpread: 0.0001,
        minAbsFundingZScore: 0,
        maxHoldingBars: 4,
        stopLossPct: 0.05,
        positionPctOfEquity: 0.02,
        signalPersistenceBars: 0,
      },
    })

    expect(sameBar.metrics.tradeCount).toBe(0)
    expect(olderObservation.metrics.tradeCount).toBeGreaterThanOrEqual(1)
  })

  it('selects carry candidates on a non-overlapping selection sample and evaluates on holdout', () => {
    const candles = Array.from({ length: 160 }, (_, index) => ({
      symbol: 'ETH/BTC_CARRY',
      time: index * 3600,
      open: 1,
      high: 1.02,
      low: 0.98,
      close: 1 + Math.sin(index / 6) * 0.01 + index * 0.0002,
      volume: 1000 + index,
    }))
    const carrySignals = candles
      .filter((_, index) => index > 4 && index % 4 === 0)
      .map((candle, index) => ({
        time: candle.time,
        observedAt: candle.time - 3600,
        effectiveAt: candle.time,
        fundingSpread: index % 2 === 0 ? -0.0004 : 0.0004,
        fundingSpreadZScore: index % 2 === 0 ? -2 : 2,
      }))

    const result = runCarryValidation({
      candles,
      carrySignals,
      candidates: [
        {
          id: 'fast',
          minAbsFundingSpread: 0.0001,
          minAbsFundingZScore: 0,
          maxHoldingBars: 4,
          stopLossPct: 0.05,
          positionPctOfEquity: 0.02,
          signalPersistenceBars: 1,
        },
        {
          id: 'slow',
          minAbsFundingSpread: 0.0002,
          minAbsFundingZScore: 0,
          maxHoldingBars: 8,
          stopLossPct: 0.05,
          positionPctOfEquity: 0.02,
          signalPersistenceBars: 1,
        },
      ],
      trainBars: 48,
      testBars: 32,
      stepBars: 32,
      riskSimulationCount: 100,
    })

    expect(result.sampleSplit.selectedOn).toBe('selection')
    expect(result.sampleSplit.evaluatedOn).toBe('holdout')
    expect(result.sampleSplit.selectionLeakageCheck.passed).toBe(true)
    expect(result.sampleSplit.selectionBars).toBe(128)
    expect(result.sampleSplit.holdoutBars).toBe(32)
    expect(result.selectedInSampleMetrics).toBeDefined()
    expect(result.selectedMetrics.tradeCount).toBe(result.trades.length)
    expect(result.releaseGate.checks.find((check) => check.name === 'economics')?.metrics.tradeCount)
      .toBe(result.selectedMetrics.tradeCount)
  })
})
