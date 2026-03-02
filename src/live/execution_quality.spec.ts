import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  computeDailyExecutionSummary,
  evaluateSlippageDriftGate,
  writeDailyExecutionReport,
  type ExecutionDailySummary,
  type OrderExecutionRecord,
} from './execution_quality.js'

function makeRecord(overrides: Partial<OrderExecutionRecord>): OrderExecutionRecord {
  return {
    orderId: 'order-1',
    symbol: 'AAPL',
    side: 'buy',
    expectedPrice: 100,
    actualPrice: 100,
    requestedQty: 1,
    filledQty: 1,
    submittedAtMs: 0,
    firstFillAtMs: 0,
    completedAtMs: 0,
    ...overrides,
  }
}

function makeSummary(date: string, slippageBps: number | null): ExecutionDailySummary {
  return {
    date,
    orderCount: 1,
    filledOrderCount: 1,
    totalRequestedQty: 1,
    totalFilledQty: 1,
    fillRate: 1,
    volumeWeightedSlippageBps: slippageBps,
    latencyMs: {
      toFirstFill: {
        sampleCount: 1,
        avgMs: 100,
        p50Ms: 100,
        p95Ms: 100,
        minMs: 100,
        maxMs: 100,
      },
      toComplete: {
        sampleCount: 1,
        avgMs: 200,
        p50Ms: 200,
        p95Ms: 200,
        minMs: 200,
        maxMs: 200,
      },
    },
  }
}

describe('execution_quality', () => {
  it('computes volume-weighted slippage in bps across buy and sell fills', () => {
    const summary = computeDailyExecutionSummary('2026-02-01', [
      makeRecord({
        orderId: 'b1',
        side: 'buy',
        expectedPrice: 100,
        actualPrice: 101,
        requestedQty: 10,
        filledQty: 10,
      }), // +100 bps * 10
      makeRecord({
        orderId: 's1',
        side: 'sell',
        expectedPrice: 50,
        actualPrice: 49,
        requestedQty: 30,
        filledQty: 30,
      }), // +200 bps * 30
      makeRecord({
        orderId: 'b2',
        side: 'buy',
        expectedPrice: 200,
        actualPrice: 198,
        requestedQty: 20,
        filledQty: 20,
      }), // -100 bps * 20
      makeRecord({
        orderId: 'ignored',
        expectedPrice: 0,
        requestedQty: 0,
        filledQty: 0,
      }), // invalid for slippage and no fill volume
    ])

    expect(summary.volumeWeightedSlippageBps).toBeCloseTo(83.33333333333333, 12)
  })

  it('computes fill-rate totals and filled-order count deterministically', () => {
    const summary = computeDailyExecutionSummary('2026-02-02', [
      makeRecord({ orderId: 'f1', requestedQty: 100, filledQty: 80 }),
      makeRecord({ orderId: 'f2', requestedQty: 20, filledQty: 5 }),
      makeRecord({ orderId: 'f3', requestedQty: 50, filledQty: 0 }),
    ])

    expect(summary.totalRequestedQty).toBe(170)
    expect(summary.totalFilledQty).toBe(85)
    expect(summary.fillRate).toBe(0.5)
    expect(summary.filledOrderCount).toBe(2)
  })

  it('summarizes latency stats and ignores null/invalid timestamps', () => {
    const summary = computeDailyExecutionSummary('2026-02-03', [
      makeRecord({
        orderId: 'l1',
        submittedAtMs: 1_000,
        firstFillAtMs: 1_100,
        completedAtMs: 1_300,
      }),
      makeRecord({
        orderId: 'l2',
        submittedAtMs: 2_000,
        firstFillAtMs: 2_200,
        completedAtMs: null,
      }),
      makeRecord({
        orderId: 'l3',
        submittedAtMs: 3_000,
        firstFillAtMs: null,
        completedAtMs: 3_500,
      }),
      makeRecord({
        orderId: 'l4',
        submittedAtMs: 4_000,
        firstFillAtMs: 3_900,
        completedAtMs: 3_950,
      }),
    ])

    expect(summary.latencyMs.toFirstFill).toEqual({
      sampleCount: 2,
      avgMs: 150,
      p50Ms: 150,
      p95Ms: 195,
      minMs: 100,
      maxMs: 200,
    })
    expect(summary.latencyMs.toComplete).toEqual({
      sampleCount: 2,
      avgMs: 400,
      p50Ms: 400,
      p95Ms: 490,
      minMs: 300,
      maxMs: 500,
    })
  })

  it('triggers reduce_or_pause only when the latest streak meets consecutive-day threshold', () => {
    const decision = evaluateSlippageDriftGate(
      [
        makeSummary('2026-01-06', 30),
        makeSummary('2026-01-02', 25),
        makeSummary('2026-01-05', 40),
        makeSummary('2026-01-03', 19),
        makeSummary('2026-01-04', 50),
      ],
      {
        driftMultiplierThreshold: 2,
        consecutiveDays: 3,
        baselineSlippageBps: 10,
      },
    )

    expect(decision).toEqual({
      action: 'reduce_or_pause',
      consecutiveBreaches: 3,
      requiredConsecutiveDays: 3,
      breachedDates: ['2026-01-04', '2026-01-05', '2026-01-06'],
      latestDriftMultiplier: 3,
    })
  })

  it('keeps monitoring when there are historical breaches but latest streak is too short', () => {
    const decision = evaluateSlippageDriftGate(
      [
        makeSummary('2026-01-01', 30),
        makeSummary('2026-01-02', 30),
        makeSummary('2026-01-03', 5),
        makeSummary('2026-01-04', 30),
        makeSummary('2026-01-05', 30),
      ],
      {
        driftMultiplierThreshold: 2,
        consecutiveDays: 3,
        baselineSlippageBps: 10,
      },
    )

    expect(decision).toEqual({
      action: 'monitor',
      consecutiveBreaches: 2,
      requiredConsecutiveDays: 3,
      breachedDates: ['2026-01-04', '2026-01-05'],
      latestDriftMultiplier: 3,
    })
  })

  it('writes execution report once and leaves existing report unchanged on repeated writes', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'execution-quality-'))
    const firstSummary = makeSummary('2026-02-06', 12.34)
    const secondSummary = {
      ...firstSummary,
      orderCount: 999,
      totalFilledQty: 999,
    }

    const firstWrite = await writeDailyExecutionReport(firstSummary, { baseDir })
    const secondWrite = await writeDailyExecutionReport(secondSummary, { baseDir })

    expect(firstWrite.written).toBe(true)
    expect(firstWrite.path).toBe(join(baseDir, 'execution_logs', '2026-02-06.json'))
    expect(secondWrite).toEqual({
      path: firstWrite.path,
      written: false,
    })

    const persisted = JSON.parse(await readFile(firstWrite.path, 'utf-8'))
    expect(persisted).toEqual(firstSummary)
  })
})
