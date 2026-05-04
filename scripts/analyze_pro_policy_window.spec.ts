import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  analyzeProPolicyWindow,
  computeWindowDelta,
  assignPolicyWindow,
  computeWindowStats,
  type NormalizedTrade,
  type ProPolicyBoundary,
} from './analyze_pro_policy_window'

describe('analyze_pro_policy_window', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'openalice-pro-policy-window-'))
    roots.push(root)
    return root
  }

  it('splits realized paper trades into pre/post historical baseline windows', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    const policyPath = join(root, 'runtime', 'pro_risk_policy.latest.json')
    const outputPath = join(root, 'runtime', 'pro_policy_window.latest.json')
    mkdirSync(paperDir, { recursive: true })
    mkdirSync(join(root, 'runtime'), { recursive: true })
    writeFileSync(policyPath, JSON.stringify({
      schemaVersion: 1,
      generation: 10,
      proEpoch: 42,
      generatedAt: '2026-05-01T12:00:00.000Z',
      validUntil: '2026-05-02T12:00:00.000Z',
      verdict: 'risk_reduced',
      confidenceScore: 0.8,
      pauseLaneRecommendations: {},
      symbolBlocks: [],
      suggestedRuleThresholdByLane: {},
      riskReductionActions: [],
      autoApplyPolicy: 'risk_reduction_only',
      source: { reportPath: null, model: 'pro' },
    }))
    writeFileSync(join(paperDir, 'paper_trade_result.jsonl'), [
      JSON.stringify({
        tradeId: 'pre-time',
        lane: 'cross_sectional',
        symbol: 'BTC-USDT',
        side: 'long',
        openTs: '2026-05-01T10:00:00.000Z',
        closeTs: '2026-05-01T11:00:00.000Z',
        pnlPct: -2,
        pnlUsd: -20,
        closeReason: 'stop_loss',
        contextGenerationAtOpen: 8,
        proEpochAtOpen: 41,
        ruleScoreAtOpen: 0.3,
        flashConfidenceLowAtOpen: 0.4,
        ...completeContext(8, {
          decisionTime: '2026-05-01T10:00:00.000Z',
          marketDataWatermarkAtDecisionTime: '2026-05-01T10:00:00.000Z',
          watermark: '2026-05-01T10:00:00.000Z',
          proEpochAtOpen: 41,
          ruleScoreAtOpen: 0.3,
          flashConfidenceLowAtOpen: 0.4,
        }),
      }),
      JSON.stringify({
        tradeId: 'post-time',
        lane: 'cross_sectional',
        symbol: 'ETH-USDT',
        side: 'short',
        openTs: '2026-05-01T13:00:00.000Z',
        closeTs: '2026-05-01T14:00:00.000Z',
        pnlPct: 4,
        pnlUsd: 40,
        closeReason: 'take_profit',
        contextGenerationAtOpen: 12,
        proEpochAtOpen: 42,
        ruleScoreAtOpen: 0.9,
        flashConfidenceLowAtOpen: 0.85,
        ...completeContext(12, {
          decisionTime: '2026-05-01T13:00:00.000Z',
          marketDataWatermarkAtDecisionTime: '2026-05-01T13:00:00.000Z',
          watermark: '2026-05-01T13:00:00.000Z',
          proEpochAtOpen: 42,
          ruleScoreAtOpen: 0.9,
          flashConfidenceLowAtOpen: 0.85,
        }),
      }),
      JSON.stringify({
        tradeId: 'pre-epoch',
        lane: 'volume_breakout_1x',
        symbol: 'SOL-USDT',
        side: 'long',
        closeTs: '2026-05-01T15:00:00.000Z',
        pnlPct: 1,
        pnlUsd: 10,
        closeReason: 'signal',
        contextGenerationAtOpen: 9,
        proEpochAtOpen: 41,
        ruleScoreAtOpen: 0.7,
        flashConfidenceLowAtOpen: 0.7,
        ...completeContext(9, {
          decisionTime: '2026-05-01T14:30:00.000Z',
          marketDataWatermarkAtDecisionTime: '2026-05-01T14:30:00.000Z',
          watermark: '2026-05-01T14:30:00.000Z',
          proEpochAtOpen: 41,
          ruleScoreAtOpen: 0.7,
          flashConfidenceLowAtOpen: 0.7,
        }),
      }),
      JSON.stringify({
        tradeId: 'post-context-generation',
        lane: 'volume_breakout_1x',
        symbol: 'XRP-USDT',
        side: 'short',
        closeTs: '2026-05-01T16:00:00.000Z',
        pnlPct: -1,
        pnlUsd: -10,
        closeReason: 'stop_loss',
        contextGenerationAtOpen: 11,
        ruleScoreAtOpen: 0.1,
        ...completeContext(11, {
          decisionTime: '2026-05-01T15:30:00.000Z',
          marketDataWatermarkAtDecisionTime: '2026-05-01T15:30:00.000Z',
          watermark: '2026-05-01T15:30:00.000Z',
          ruleScoreAtOpen: 0.1,
          flashConfidenceLowAtOpen: 0.75,
        }),
      }),
      JSON.stringify({
        tradeId: 'excluded-missing-boundary',
        lane: 'microstructure_10x',
        symbol: 'DOGE-USDT',
        side: 'long',
        closeTs: '2026-05-01T17:00:00.000Z',
        pnlPct: 0.5,
        pnlUsd: 5,
        closeReason: 'signal',
      }),
    ].join('\n'))

    const report = await analyzeProPolicyWindow({
      paperDir,
      policyPath,
      outputPath,
      lookbackHours: null,
    })

    expect(report.counterfactualType).toBe('historical_baseline')
    expect(report.coverage).toMatchObject({
      closedTradesLoaded: 5,
      preTrades: 2,
      postTrades: 2,
      excludedTrades: 1,
      duplicateTradesSkipped: 0,
    })
    expect(report.coverage.splitBasisCounts).toEqual({
      openTs_vs_policy_generatedAt: 2,
      proEpochAtOpen_vs_policy_proEpoch: 1,
      contextGenerationAtOpen_vs_policy_generation: 1,
      unclassified: 1,
    })
    expect(report.windows.pre).toMatchObject({
      count: 2,
      wins: 1,
      losses: 1,
      winRate: 50,
      profitFactor: 0.5,
      expectancyPct: -0.5,
      stopLossCount: 1,
      stopLossLossSharePct: 100,
    })
    expect(report.windows.post).toMatchObject({
      count: 2,
      wins: 1,
      losses: 1,
      winRate: 50,
      profitFactor: 4,
      expectancyPct: 1.5,
      stopLossCount: 1,
      stopLossLossSharePct: 100,
    })
    expect(report.windows.pre.contextCoverageBuckets.ok).toBe(2)
    expect(report.windows.post.contextCoverageBuckets.ok).toBe(2)
    expect(report.windows.pre.byRuleScoreBucket).toMatchObject({
      '0.2-0.4': 1,
      '0.6-0.8': 1,
    })
    expect(report.windows.post.byFlashConfidenceLowBucket).toMatchObject({
      '>=0.8': 1,
      '0.6-0.8': 1,
    })
    expect(report.delta).toMatchObject({
      winRatePctPoints: 0,
      profitFactor: 3.5,
      expectancyPct: 2,
      stopLossLossSharePctPoints: 0,
    })
    expect(report.notes.join('\n')).toContain('no synthetic portfolio-level counterfactual')
  })

  it('classifies post-cutover paper-result trades with incomplete v3 decision context as new_missing', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    const policyPath = join(root, 'runtime', 'pro_risk_policy.latest.json')
    const outputPath = join(root, 'runtime', 'pro_policy_window.latest.json')
    mkdirSync(paperDir, { recursive: true })
    mkdirSync(join(root, 'runtime'), { recursive: true })
    writeFileSync(policyPath, JSON.stringify({
      schemaVersion: 1,
      generation: 10,
      proEpoch: 42,
      generatedAt: '2026-05-01T12:00:00.000Z',
      verdict: 'risk_reduced',
      autoApplyPolicy: 'risk_reduction_only',
    }))
    writeFileSync(join(paperDir, 'paper_trade_result.jsonl'), [
      JSON.stringify({
        tradeId: 'legacy-shaped-new-row',
        lane: 'cross_sectional',
        symbol: 'BTC-USDT',
        side: 'long',
        openTs: '2026-05-02T13:00:00.000Z',
        closeTs: '2026-05-02T14:00:00.000Z',
        pnlPct: 1,
        closeReason: 'signal',
        contextGenerationAtOpen: 12,
        flashConfidenceLowAtOpen: 0.7,
      }),
    ].join('\n'))

    const report = await analyzeProPolicyWindow({
      paperDir,
      policyPath,
      outputPath,
      lookbackHours: null,
    })

    expect(report.coverage).toMatchObject({
      closedTradesLoaded: 1,
      preTrades: 0,
      postTrades: 1,
      excludedTrades: 0,
    })
    expect(report.windows.post.contextCoverageBuckets).toMatchObject({
      ok: 0,
      new_missing: 1,
      legacy_missing: 0,
    })
  })

  it('keeps pre-cutover incomplete paper-result context in legacy_missing unless explicit status says partial_missing', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    const policyPath = join(root, 'runtime', 'pro_risk_policy.latest.json')
    const outputPath = join(root, 'runtime', 'pro_policy_window.latest.json')
    mkdirSync(paperDir, { recursive: true })
    mkdirSync(join(root, 'runtime'), { recursive: true })
    writeFileSync(policyPath, JSON.stringify({
      schemaVersion: 1,
      generation: 10,
      proEpoch: 42,
      generatedAt: '2026-05-01T12:00:00.000Z',
      verdict: 'risk_reduced',
      autoApplyPolicy: 'risk_reduction_only',
    }))
    writeFileSync(join(paperDir, 'paper_trade_result.jsonl'), [
      JSON.stringify({
        tradeId: 'legacy-shaped-pre-cutover-row',
        lane: 'cross_sectional',
        symbol: 'BTC-USDT',
        side: 'long',
        openTs: '2026-05-01T13:00:00.000Z',
        closeTs: '2026-05-01T14:00:00.000Z',
        pnlPct: 1,
        closeReason: 'signal',
        contextGenerationAtOpen: 12,
      }),
      JSON.stringify({
        tradeId: 'explicit-partial-pre-cutover-row',
        lane: 'cross_sectional',
        symbol: 'ETH-USDT',
        side: 'long',
        openTs: '2026-05-01T13:30:00.000Z',
        closeTs: '2026-05-01T14:30:00.000Z',
        pnlPct: 1,
        closeReason: 'signal',
        contextGenerationAtOpen: 12,
        contextCoverageStatus: 'partial_missing',
      }),
    ].join('\n'))

    const report = await analyzeProPolicyWindow({
      paperDir,
      policyPath,
      outputPath,
      lookbackHours: null,
    })

    expect(report.coverage).toMatchObject({
      closedTradesLoaded: 2,
      postTrades: 2,
      excludedTrades: 0,
    })
    expect(report.windows.post.contextCoverageBuckets).toMatchObject({
      ok: 0,
      legacy_missing: 1,
      new_missing: 1,
    })
  })

  it('prefers policy generatedAt over epoch metadata when openTs is available', () => {
    const policy: ProPolicyBoundary = {
      path: '/tmp/policy.json',
      found: true,
      generatedAt: '2026-05-01T12:00:00.000Z',
      generatedAtMs: Date.parse('2026-05-01T12:00:00.000Z'),
      proEpoch: 10,
      generation: 10,
      verdict: 'risk_reduced',
      autoApplyPolicy: 'risk_reduction_only',
    }

    const assignment = assignPolicyWindow({
      ...makeTrade(),
      openTs: '2026-05-01T11:00:00.000Z',
      proEpochAtOpen: 11,
      contextGenerationAtOpen: 11,
    }, policy)

    expect(assignment.window).toBe('pre')
    expect(assignment.splitBasis).toBe('openTs_vs_policy_generatedAt')
  })

  it('computes stop-loss loss share without inventing post-policy fills', () => {
    const stats = computeWindowStats('post', [
      { ...makeTrade(), tradeId: 'a', pnlPct: -1, closeReason: 'stop_loss' },
      { ...makeTrade(), tradeId: 'b', pnlPct: -3, closeReason: 'holding_expired' },
      { ...makeTrade(), tradeId: 'c', pnlPct: 2, closeReason: 'take_profit' },
    ])

    expect(stats.count).toBe(3)
    expect(stats.profitFactor).toBe(0.5)
    expect(stats.expectancyPct).toBeCloseTo(-2 / 3)
    expect(stats.stopLossLossSharePct).toBe(25)
  })

  it('returns null deltas when either realized policy window is empty', () => {
    const pre = computeWindowStats('pre', [
      { ...makeTrade(), tradeId: 'pre', pnlPct: -1, closeReason: 'stop_loss' },
    ])
    const post = computeWindowStats('post', [])

    expect(computeWindowDelta(pre, post)).toEqual({
      winRatePctPoints: null,
      profitFactor: null,
      expectancyPct: null,
      stopLossLossSharePctPoints: null,
    })
  })
})

function makeTrade(): NormalizedTrade {
  return {
    tradeId: 'trade',
    source: 'test',
    lane: 'cross_sectional',
    symbol: 'BTC-USDT',
    side: 'long',
    openTs: null,
    closeTs: '2026-05-01T13:00:00.000Z',
    pnlPct: 1,
    pnlUsd: 10,
    closeReason: 'signal',
    rawReason: 'signal',
    contextSnapshotId: 'context:1',
    decisionTime: '2026-05-01T13:00:00.000Z',
    marketDataWatermarkAtDecisionTime: '2026-05-01T13:00:00.000Z',
    watermark: '2026-05-01T13:00:00.000Z',
    featuresAvailableAtDecisionTime: true,
    featureSchemaVersion: 'paper_open_context.v3',
    flashContextStatus: 'ok',
    contextStatus: 'ok',
    contextReason: null,
    contextGenerationAtOpen: 1,
    proEpochAtOpen: 1,
    flashConfidenceLowAtOpen: 0.5,
    ruleScoreAtOpen: 0.5,
    marketIntelTriggerAtOpen: 'event',
    contextCoverageBucket: 'ok',
  }
}

function completeContext(
  generation: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contextSnapshotId: `context:${generation}`,
    decisionTime: '2026-05-01T00:00:00.000Z',
    marketDataWatermarkAtDecisionTime: '2026-05-01T00:00:00.000Z',
    watermark: '2026-05-01T00:00:00.000Z',
    featuresAvailableAtDecisionTime: true,
    featureSchemaVersion: 'paper_open_context.v3',
    contextGenerationAtOpen: generation,
    contextStatus: 'ok',
    flashContextStatus: 'ok',
    flashConfidenceLowAtOpen: 0.5,
    ...overrides,
  }
}
