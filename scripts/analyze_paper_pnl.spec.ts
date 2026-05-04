import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { analyzePaperPnl, computeStats, type NormalizedPaperTrade } from './analyze_paper_pnl'

describe('analyze_paper_pnl', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'openalice-pnl-diagnostics-'))
    roots.push(root)
    return root
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

  it('deduplicates closed paper result rows against account trade history', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    const runtimeDir = join(root, 'runtime')
    mkdirSync(paperDir, { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(paperDir, 'paper_trade_result.jsonl'), [
      JSON.stringify({
        tradeId: 't1',
        lane: 'microstructure_10x',
        symbol: 'DOGE-USDT',
        leverage: 10,
        side: 'long',
        openTs: '2026-05-01T00:00:00.000Z',
        closeTs: '2026-05-01T00:01:00.000Z',
        openPrice: 1,
        closePrice: 0.99,
        pnlPct: -1,
        pnlUsd: -10,
        closeReason: 'holding_expired',
        ...completeContext(101, { flashConfidenceLowAtOpen: 0.2 }),
        ruleScoreAtOpen: 0.1,
      }),
      JSON.stringify({
        tradeId: 't2',
        lane: 'volume_breakout_1x',
        symbol: 'ETH-USDT',
        leverage: 1,
        side: 'short',
        openTs: '2026-05-01T01:00:00.000Z',
        closeTs: '2026-05-01T01:30:00.000Z',
        openPrice: 100,
        closePrice: 99,
        pnlPct: 1,
        pnlUsd: 5,
        closeReason: 'take_profit',
        ...completeContext(102, { flashConfidenceLowAtOpen: 0.8 }),
        ruleScoreAtOpen: 0.7,
        rankAtOpen: 1,
        rankSpreadPctAtOpen: 7.5,
        estimatedRoundTripCostPctAtOpen: 0.28,
        estimatedRoundTripCostPctOfMarginAtOpen: 0.84,
        routeCostBpsAtOpen: 28,
        roundTripCostBpsAtOpen: 28,
        realizedCostBps: null,
        fillAdjustedCostBps: null,
        fillAdjustedCostPct: null,
        costEvidenceSource: 'paper_cost_model_at_open',
        costEvidenceStatus: 'paper_model_not_exchange_reconciled',
        markMatchStatusAtOpen: 'stale_or_missing',
        mfeBps: 120,
        maeBps: 35,
        timeToMfeSec: 300,
        timeToMaeSec: 60,
        signalConfidenceAtOpen: 0.72,
      }),
    ].join('\n'))
    writeFileSync(join(paperDir, 'account_ms_stress_10x.json'), JSON.stringify({
      equity: 99990,
      initialEquity: 100000,
      positions: [{ symbol: 'BTC-USDT', entryTime: '2026-05-01T00:00:00.000Z' }],
      tradeHistory: [{
        id: 't1',
        symbol: 'DOGE-USDT',
        direction: 'long',
        entryTime: '2026-05-01T00:00:00.000Z',
        exitTime: '2026-05-01T00:01:00.000Z',
        entryPrice: 1,
        exitPrice: 0.99,
        pnlPct: -1,
        pnl: -10,
        reason: 'holding_expired:60s',
        accountId: 'stress_10x',
        leverage: 10,
      }],
    }))

    const report = await analyzePaperPnl({
      paperDir,
      runtimeDir,
      outputPath: join(root, 'diagnostics.json'),
      lookbackHours: null,
      topN: 5,
    })

    expect(report.coverage.closedTrades).toBe(2)
    expect(report.coverage.duplicateTradesSkipped).toBe(1)
    expect(report.openRisk.totalOpenPositions).toBe(1)
    expect(report.openRisk.evidence).toMatchObject({
      completeV3Context: 0,
      completeCost: 0,
      legacyMissingContext: 1,
      newMissingContext: 0,
      missingCost: 1,
      risk: 'legacy_will_close_dirty',
    })
    expect(report.byLane.find(group => group.key === 'microstructure_10x')?.totalPnlPct).toBe(-1)
    expect(report.byRuleScoreBucket.find(group => group.key === '<0.2')?.count).toBe(1)
    expect(report.byFlashConfidenceLowBucket.find(group => group.key === '>=0.8')?.count).toBe(1)
    expect(report.byRankBucket.find(group => group.key === '1')?.count).toBe(1)
    expect(report.byRankSpreadBucket.find(group => group.key === '5-10')?.count).toBe(1)
    expect(report.byEstimatedRoundTripCostBucket.find(group => group.key === '0.25-0.5')?.count).toBe(1)
    expect(report.byEstimatedRoundTripCostOfMarginBucket.find(group => group.key === '0.5-1')?.count).toBe(1)
    expect(report.bySignalConfidenceBucket.find(group => group.key === '0.6-0.8')?.count).toBe(1)
    expect(report.coverage.costEvidence).toMatchObject({
      status: 'partial',
      closedTrades: 2,
      tradesWithAnyPredictedCost: 1,
      tradesMissingAnyPredictedCost: 1,
      tradesWithRouteCostBps: 1,
      tradesWithRoundTripCostBps: 1,
      tradesWithEstimatedRoundTripCostPct: 1,
      tradesWithAnyRealizedCost: 0,
      tradesWithFillAdjustedCost: 0,
      tradesWithPaperModelCostEvidence: 1,
      tradesWithExchangeReconciledCostEvidence: 0,
      staleOrMissingMarkMatchTrades: 1,
    })
    expect(report.coverage.costEvidence.anyPredictedCostCoveragePct).toBe(50)
    expect(report.coverage.costEvidence.byLane.find(lane => lane.lane === 'volume_breakout_1x')).toMatchObject({
      closedTrades: 1,
      coveredTrades: 1,
      missingTrades: 0,
      coveragePct: 100,
    })
    expect(report.coverage.mfeMaeEvidence).toMatchObject({
      status: 'partial',
      closedTrades: 2,
      tradesWithMfeBps: 1,
      tradesWithMaeBps: 1,
      tradesWithBothMfeMaeBps: 1,
      tradesMissingBothMfeMaeBps: 1,
    })
    expect(report.coverage.mfeMaeEvidence.bothMfeMaeCoveragePct).toBe(50)
    expect(report.coverage.okContextTrades).toBe(2)
    expect(report.byContextCoverageBucket.find(group => group.key === 'ok')?.count).toBe(2)
  })

  it('distinguishes context coverage buckets for legacy, new missing, stale, timeout, and ok rows', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    const runtimeDir = join(root, 'runtime')
    mkdirSync(paperDir, { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(paperDir, 'paper_trade_result.jsonl'), [
      JSON.stringify({
        tradeId: 'ok',
        lane: 'microstructure_10x',
        symbol: 'BTC-USDT',
        side: 'long',
        openTs: '2026-05-01T00:00:00.000Z',
        closeTs: '2026-05-01T00:10:00.000Z',
        pnlPct: 0.5,
        closeReason: 'take_profit',
        ...completeContext(100),
      }),
      JSON.stringify({
        tradeId: 'stale',
        lane: 'microstructure_10x',
        symbol: 'ETH-USDT',
        side: 'long',
        openTs: '2026-05-01T01:00:00.000Z',
        closeTs: '2026-05-01T01:10:00.000Z',
        pnlPct: -0.5,
        closeReason: 'stale_context',
        priceStale: true,
      }),
      JSON.stringify({
        tradeId: 'timeout',
        lane: 'volume_breakout_1x',
        symbol: 'SOL-USDT',
        side: 'short',
        openTs: '2026-05-01T02:00:00.000Z',
        closeTs: '2026-05-01T02:10:00.000Z',
        pnlPct: -0.25,
        closeReason: 'forced_exit_timeout',
      }),
      JSON.stringify({
        tradeId: 'new-missing',
        lane: 'volume_breakout_1x',
        symbol: 'XRP-USDT',
        side: 'long',
        openTs: '2026-05-02T03:00:00.000Z',
        closeTs: '2026-05-02T03:10:00.000Z',
        pnlPct: -0.1,
        closeReason: 'holding_expired',
      }),
    ].join('\n'))
    writeFileSync(join(paperDir, 'account_legacy.json'), JSON.stringify({
      equity: 100000,
      initialEquity: 100000,
      positions: [],
      tradeHistory: [{
        id: 'legacy',
        symbol: 'DOGE-USDT',
        direction: 'long',
        entryTime: '2026-05-01T04:00:00.000Z',
        exitTime: '2026-05-01T04:10:00.000Z',
        pnlPct: -0.2,
        reason: 'holding_expired',
      }],
    }))

    const report = await analyzePaperPnl({
      paperDir,
      runtimeDir,
      outputPath: join(root, 'diagnostics.json'),
      lookbackHours: null,
      topN: 5,
    })

    expect(report.coverage.closedTrades).toBe(5)
    expect(report.coverage.okContextTrades).toBe(1)
    expect(report.coverage.staleContextTrades).toBe(1)
    expect(report.coverage.timeoutContextTrades).toBe(1)
    expect(report.coverage.newMissingContextTrades).toBe(1)
    expect(report.coverage.legacyMissingContextTrades).toBe(1)
    expect(report.coverage.contextEnforcementWindow).toMatchObject({
      cutoverTs: '2026-05-02T00:00:00.000Z',
      enforcementTs: '2026-05-02T06:30:00.000Z',
      status: 'insufficient_data',
      closedTrades: 0,
      newMissingContextTrades: 0,
      dirtyHistoricalNewMissingTrades: 1,
      contextCoveragePct: 0,
    })
    expect(report.coverage.contextBuckets.find(bucket => bucket.bucket === 'new_missing')?.sharePct).toBe(20)
    expect(report.byContextCoverageBucket.map(group => group.key).sort()).toEqual([
      'legacy_missing',
      'new_missing',
      'ok',
      'stale',
      'timeout',
    ])
    const manifest = JSON.parse(readFileSync(join(root, 'diagnostics.json.manifest.json'), 'utf-8'))
    expect(manifest.errorClass).toBeNull()
  })

  it('requires strict ok statuses and PIT-safe watermark before counting v3 context as ok', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    const runtimeDir = join(root, 'runtime')
    mkdirSync(paperDir, { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(paperDir, 'paper_trade_result.jsonl'), [
      JSON.stringify({
        tradeId: 'risk-off-status',
        lane: 'microstructure_10x',
        symbol: 'BTC-USDT',
        side: 'long',
        openTs: '2026-05-02T07:00:00.000Z',
        closeTs: '2026-05-02T07:10:00.000Z',
        pnlPct: -0.1,
        closeReason: 'holding_expired',
        contextCoverageStatus: 'ok',
        ...completeContext(801, {
          decisionTime: '2026-05-02T07:00:00.000Z',
          marketDataWatermarkAtDecisionTime: '2026-05-02T07:00:00.000Z',
          contextStatus: 'risk_off',
          flashContextStatus: 'ok',
        }),
      }),
      JSON.stringify({
        tradeId: 'future-watermark',
        lane: 'microstructure_10x',
        symbol: 'ETH-USDT',
        side: 'short',
        openTs: '2026-05-02T07:15:00.000Z',
        closeTs: '2026-05-02T07:25:00.000Z',
        pnlPct: 0.1,
        closeReason: 'take_profit',
        ...completeContext(802, {
          decisionTime: '2026-05-02T07:15:00.000Z',
          marketDataWatermarkAtDecisionTime: '2026-05-02T07:16:00.000Z',
        }),
      }),
      JSON.stringify({
        tradeId: 'strict-ok',
        lane: 'microstructure_10x',
        symbol: 'SOL-USDT',
        side: 'long',
        openTs: '2026-05-02T07:30:00.000Z',
        closeTs: '2026-05-02T07:40:00.000Z',
        pnlPct: 0.2,
        closeReason: 'take_profit',
        ...completeContext(803, {
          decisionTime: '2026-05-02T07:30:00.000Z',
          marketDataWatermarkAtDecisionTime: '2026-05-02T07:29:59.000Z',
        }),
      }),
    ].join('\n'))

    const report = await analyzePaperPnl({
      paperDir,
      runtimeDir,
      outputPath: join(root, 'diagnostics.json'),
      lookbackHours: null,
      topN: 5,
    })

    expect(report.coverage.okContextTrades).toBe(1)
    expect(report.coverage.newMissingContextTrades).toBe(2)
    expect(report.coverage.contextEnforcementWindow).toMatchObject({
      status: 'new_missing',
      closedTrades: 3,
      okContextTrades: 1,
      newMissingContextTrades: 2,
    })
    expect(report.byContextCoverageBucket.find(group => group.key === 'ok')?.count).toBe(1)
    expect(report.byContextCoverageBucket.find(group => group.key === 'new_missing')?.count).toBe(2)
  })

  it('uses the context enforcement window to distinguish current missing-context failures', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    const runtimeDir = join(root, 'runtime')
    mkdirSync(paperDir, { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(paperDir, 'paper_trade_result.jsonl'), [
      JSON.stringify({
        tradeId: 'historical-new-missing',
        lane: 'volume_breakout_1x',
        symbol: 'JUP-USDT',
        side: 'long',
        openTs: '2026-05-02T05:52:01.708Z',
        closeTs: '2026-05-02T06:22:01.825Z',
        pnlPct: -0.1,
        closeReason: 'holding_expired',
      }),
      JSON.stringify({
        tradeId: 'post-enforcement-ok',
        lane: 'volume_breakout_1x',
        symbol: 'BTC-USDT',
        side: 'long',
        openTs: '2026-05-02T07:00:00.000Z',
        closeTs: '2026-05-02T07:10:00.000Z',
        pnlPct: 0.1,
        closeReason: 'holding_expired',
        ...completeContext(901, {
          decisionTime: '2026-05-02T07:00:00.000Z',
          marketDataWatermarkAtDecisionTime: '2026-05-02T07:00:00.000Z',
          watermark: '2026-05-02T07:00:00.000Z',
        }),
      }),
    ].join('\n'))

    const report = await analyzePaperPnl({
      paperDir,
      runtimeDir,
      outputPath: join(root, 'diagnostics.json'),
      lookbackHours: null,
      topN: 5,
    })

    expect(report.coverage.newMissingContextTrades).toBe(1)
    expect(report.coverage.contextEnforcementWindow).toMatchObject({
      status: 'ok',
      closedTrades: 1,
      okContextTrades: 1,
      newMissingContextTrades: 0,
      dirtyHistoricalNewMissingTrades: 1,
      contextCoveragePct: 100,
    })
    expect(report.recommendations.join('\n')).toContain('historical dirty evidence')
    const manifest = JSON.parse(readFileSync(join(root, 'diagnostics.json.manifest.json'), 'utf-8'))
    expect(manifest.errorClass).toBeNull()
  })

  it('separates new-window predicted open evidence from legacy missing cost rows', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    const runtimeDir = join(root, 'runtime')
    mkdirSync(paperDir, { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(paperDir, 'paper_trade_result.jsonl'), [
      JSON.stringify({
        tradeId: 'legacy-missing-cost',
        lane: 'volume_breakout_1x',
        symbol: 'ETH-USDT',
        side: 'long',
        openTs: '2026-05-01T00:00:00.000Z',
        closeTs: '2026-05-01T00:10:00.000Z',
        pnlPct: -0.1,
        closeReason: 'holding_expired',
        ...completeContext(100),
      }),
      JSON.stringify({
        tradeId: 'new-complete-cost',
        lane: 'volume_breakout_1x',
        symbol: 'BTC-USDT',
        side: 'long',
        openTs: '2026-05-02T07:00:00.000Z',
        closeTs: '2026-05-02T07:10:00.000Z',
        pnlPct: 0.1,
        closeReason: 'holding_expired',
        ...completeContext(101, {
          decisionTime: '2026-05-02T07:00:00.000Z',
          marketDataWatermarkAtDecisionTime: '2026-05-02T07:00:00.000Z',
          watermark: '2026-05-02T07:00:00.000Z',
        }),
        routeCostBpsAtOpen: 28,
        roundTripCostBpsAtOpen: 43,
        expectedGrossEdgePctAtOpen: 0.8,
        expectedNetEdgePctAtOpen: 0.37,
        expectedEdgeSourceAtOpen: 'test_edge_minus_cost',
        matchPriceAtOpen: 100,
        matchPriceSourceAtOpen: 'simulated_fill',
        markMatchPenaltyBpsAtOpen: 15,
        markMatchStatusAtOpen: 'stale_or_missing',
      }),
    ].join('\n'))

    const report = await analyzePaperPnl({
      paperDir,
      runtimeDir,
      outputPath: join(root, 'diagnostics.json'),
      lookbackHours: null,
      topN: 5,
    })

    expect(report.coverage.costEvidence.status).toBe('partial')
    expect(report.coverage.costEvidence.tradesWithCompletePredictedOpenEvidence).toBe(1)
    expect(report.coverage.costEvidence.newWindow).toMatchObject({
      enforcementTs: '2026-05-02T06:30:00.000Z',
      status: 'ok',
      closedTrades: 1,
      transitionalDirtyMissingPredictedOpenEvidence: 0,
      producerGuardMissingPredictedOpenEvidence: 0,
      tradesWithCompletePredictedOpenEvidence: 1,
      tradesMissingCompletePredictedOpenEvidence: 0,
      completePredictedOpenEvidenceCoveragePct: 100,
    })
  })

  it('keeps pre-producer-guard predicted-open gaps as transitional dirty evidence', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    const runtimeDir = join(root, 'runtime')
    mkdirSync(paperDir, { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(paperDir, 'paper_trade_result.jsonl'), [
      JSON.stringify({
        tradeId: 'transitional-dirty-close',
        lane: 'cross_sectional',
        symbol: 'DOGE-USDT',
        side: 'long',
        openTs: '2026-05-02T12:17:05.427Z',
        closeTs: '2026-05-03T12:17:05.427Z',
        pnlPct: -0.1,
        closeReason: 'holding_expired',
        ...completeContext(102, {
          decisionTime: '2026-05-02T12:17:05.427Z',
          marketDataWatermarkAtDecisionTime: '2026-05-02T12:17:05.000Z',
        }),
        routeCostBpsAtOpen: 28,
        roundTripCostBpsAtOpen: 28,
        matchPriceAtOpen: 0.1,
        matchPriceSourceAtOpen: 'simulated_fill',
        markMatchStatusAtOpen: 'stale_or_missing',
        predictedOpenEvidenceStatus: 'transitional_dirty_open',
        predictedOpenEvidenceReason: 'missing:expectedGrossEdgePctAtOpen,expectedNetEdgePctAtOpen,expectedEdgeSourceAtOpen,markMatchPenaltyBpsAtOpen',
      }),
      JSON.stringify({
        tradeId: 'producer-guard-missing-close',
        lane: 'cross_sectional',
        symbol: 'DOGE-USDT',
        side: 'long',
        openTs: '2026-05-04T02:00:00.000Z',
        closeTs: '2026-05-04T03:00:00.000Z',
        pnlPct: -0.2,
        closeReason: 'holding_expired',
        ...completeContext(103, {
          decisionTime: '2026-05-04T02:00:00.000Z',
          marketDataWatermarkAtDecisionTime: '2026-05-04T02:00:00.000Z',
        }),
        routeCostBpsAtOpen: 28,
        roundTripCostBpsAtOpen: 28,
        matchPriceAtOpen: 0.1,
        matchPriceSourceAtOpen: 'simulated_fill',
        markMatchStatusAtOpen: 'stale_or_missing',
        predictedOpenEvidenceStatus: 'missing',
        predictedOpenEvidenceReason: 'missing:expectedGrossEdgePctAtOpen,expectedNetEdgePctAtOpen,expectedEdgeSourceAtOpen,markMatchPenaltyBpsAtOpen',
      }),
    ].join('\n'))

    const report = await analyzePaperPnl({
      paperDir,
      runtimeDir,
      outputPath: join(root, 'diagnostics.json'),
      lookbackHours: null,
      topN: 5,
    })

    expect(report.coverage.costEvidence.newWindow).toMatchObject({
      status: 'missing',
      closedTrades: 2,
      tradesWithCompletePredictedOpenEvidence: 0,
      tradesMissingCompletePredictedOpenEvidence: 2,
      transitionalDirtyMissingPredictedOpenEvidence: 1,
      producerGuardMissingPredictedOpenEvidence: 1,
    })
  })

  it('separates ledger MFE/MAE coverage from P1 read-only path diagnostics', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    const runtimeDir = join(root, 'runtime')
    const p1Dir = join(runtimeDir, 'p1_trading_evidence')
    mkdirSync(paperDir, { recursive: true })
    mkdirSync(p1Dir, { recursive: true })
    writeFileSync(join(paperDir, 'paper_trade_result.jsonl'), [
      JSON.stringify({
        tradeId: 'path-ok-no-ledger-fields',
        lane: 'microstructure_10x',
        symbol: 'BTC-USDT',
        leverage: 10,
        side: 'long',
        openTs: '2026-05-02T00:00:00.000Z',
        closeTs: '2026-05-02T00:01:00.000Z',
        openPrice: 100,
        closePrice: 99,
        pnlPct: -1,
        pnlUsd: -100,
        closeReason: 'stop_loss',
        ...completeContext(501),
      }),
    ].join('\n'))
    writeFileSync(join(p1Dir, 'mfe_mae_stoploss_report.latest.json'), JSON.stringify({
      schemaVersion: 1,
      diagnostics: [{
        tradeId: 'path-ok-no-ledger-fields',
        diagnosticStatus: 'ok',
        mfeBps: 35,
        maeBps: -110,
        closeReason: 'stop_loss',
      }],
    }))

    const report = await analyzePaperPnl({
      paperDir,
      runtimeDir,
      outputPath: join(root, 'diagnostics.json'),
      lookbackHours: null,
      topN: 5,
    })

    expect(report.coverage.mfeMaeEvidence).toMatchObject({
      status: 'missing',
      ledgerStatus: 'missing',
      closedTrades: 1,
      tradesWithBothMfeMaeBps: 0,
      pathDiagnostics: {
        status: 'ok',
        matchedTrades: 1,
        missingTradeDiagnostics: 0,
        unmatchedDiagnostics: 0,
        diagnosticsOk: 1,
        stopLossTrades: 1,
        stopLossDiagnosticsOk: 1,
      },
    })
    expect(report.recommendations.join('\n')).toContain('MFE/MAE ledger coverage is missing')
    expect(report.recommendations.join('\n')).not.toContain('MFE/MAE path diagnostics are ok')
  })

  it('flags post-cutover open positions missing v3 context or cost separately from legacy opens', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    const runtimeDir = join(root, 'runtime')
    mkdirSync(paperDir, { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(paperDir, 'paper_trade_result.jsonl'), '')
    writeFileSync(join(paperDir, 'account_open_risk.json'), JSON.stringify({
      equity: 100000,
      initialEquity: 100000,
      positions: [
        {
          symbol: 'LEGACY-USDT',
          direction: 'long',
          entryTime: '2026-05-01T00:00:00.000Z',
        },
        {
          symbol: 'NEW-MISSING-USDT',
          direction: 'long',
          entryTime: '2026-05-02T01:00:00.000Z',
        },
        {
          symbol: 'OK-USDT',
          direction: 'long',
          entryTime: '2026-05-02T02:00:00.000Z',
          estimatedRoundTripCostPctAtOpen: 0.28,
          routeCostBpsAtOpen: 28,
          ...completeContext(701, {
            decisionTime: '2026-05-02T02:00:00.000Z',
            marketDataWatermarkAtDecisionTime: '2026-05-02T02:00:00.000Z',
            flashConfidenceLowAtOpen: 0.6,
          }),
        },
      ],
    }))

    const report = await analyzePaperPnl({
      paperDir,
      runtimeDir,
      outputPath: join(root, 'diagnostics.json'),
      lookbackHours: null,
      topN: 5,
    })

    expect(report.openRisk).toMatchObject({
      totalOpenPositions: 3,
      evidence: {
        completeV3Context: 1,
        completeCost: 1,
        legacyMissingContext: 1,
        newMissingContext: 1,
        missingCost: 2,
        risk: 'new_missing_context_or_cost',
      },
    })
    expect(report.recommendations.join('\n')).toContain('Open-position evidence risk=new_missing_context_or_cost')
  })

  it('parses signal-quality fields into report buckets', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    const runtimeDir = join(root, 'runtime')
    mkdirSync(paperDir, { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(paperDir, 'paper_trade_result.jsonl'), [
      JSON.stringify({
        tradeId: 'quality-1',
        lane: 'volume_breakout_1x',
        symbol: 'BTC-USDT',
        side: 'long',
        openTs: '2026-05-01T00:00:00.000Z',
        closeTs: '2026-05-01T00:10:00.000Z',
        pnlPct: -0.5,
        closeReason: 'stop_loss',
        ...completeContext(11),
        breakQualityAtOpen: 'Weak',
        liquidityStatusAtOpen: 'thin',
        spreadStatusAtOpen: 'wide',
        spreadBpsAtOpen: 32,
        volumeRatioAtOpen: 6,
      }),
      JSON.stringify({
        tradeId: 'quality-2',
        lane: 'volume_breakout_1x',
        symbol: 'ETH-USDT',
        side: 'short',
        openTs: '2026-05-01T01:00:00.000Z',
        closeTs: '2026-05-01T01:10:00.000Z',
        pnlPct: 0.25,
        closeReason: 'take_profit',
        ...completeContext(12),
        breakQualityAtOpen: 'strong',
        liquidityStatusAtOpen: 'deep',
        spreadStatusAtOpen: 'normal',
        spreadBpsAtOpen: 3,
        volumeRatioAtOpen: 1.5,
      }),
      JSON.stringify({
        tradeId: 'quality-3',
        lane: 'volume_breakout_1x',
        symbol: 'SOL-USDT',
        side: 'long',
        openTs: '2026-05-01T02:00:00.000Z',
        closeTs: '2026-05-01T02:10:00.000Z',
        pnlPct: -0.1,
        closeReason: 'holding_expired',
        ...completeContext(13),
        breakQualityAtOpen: 0.3,
        spreadBpsAtOpen: 12,
        volumeRatioAtOpen: 0.8,
      }),
      JSON.stringify({
        tradeId: 'quality-4',
        lane: 'volume_breakout_1x',
        symbol: 'XRP-USDT',
        side: 'short',
        openTs: '2026-05-01T03:00:00.000Z',
        closeTs: '2026-05-01T03:10:00.000Z',
        pnlPct: 0.1,
        closeReason: 'holding_expired',
        ...completeContext(14),
        breakQualityAtOpen: 0.7,
        spreadBpsAtOpen: 60,
        volumeRatioAtOpen: 2.5,
      }),
      JSON.stringify({
        tradeId: 'quality-5',
        lane: 'volume_breakout_1x',
        symbol: 'DOGE-USDT',
        side: 'long',
        openTs: '2026-05-01T04:00:00.000Z',
        closeTs: '2026-05-01T04:10:00.000Z',
        pnlPct: 0,
        closeReason: 'holding_expired',
        ...completeContext(15),
        breakQualityAtOpen: '   ',
        spreadBpsAtOpen: null,
        volumeRatioAtOpen: null,
      }),
    ].join('\n'))

    const report = await analyzePaperPnl({
      paperDir,
      runtimeDir,
      outputPath: join(root, 'diagnostics.json'),
      lookbackHours: null,
      topN: 5,
    })

    expect(report.byVolumeRatioBucket.find(group => group.key === '>=5')?.count).toBe(1)
    expect(report.byVolumeRatioBucket.find(group => group.key === '1-2')?.count).toBe(1)
    expect(report.byBreakQualityBucket.find(group => group.key === 'weak')?.count).toBe(1)
    expect(report.byBreakQualityBucket.find(group => group.key === 'strong')?.count).toBe(1)
    expect(report.byBreakQualityBucket.find(group => group.key === 'failed')?.count).toBe(1)
    expect(report.byBreakQualityBucket.find(group => group.key === 'medium')?.count).toBe(1)
    expect(report.byBreakQualityBucket.find(group => group.key === 'missing')?.count).toBe(1)
    expect(report.byLiquidityStatus.find(group => group.key === 'thin')?.count).toBe(1)
    expect(report.byLiquidityStatus.find(group => group.key === 'deep')?.count).toBe(1)
    expect(report.bySpreadStatus.find(group => group.key === 'wide')?.count).toBe(1)
    expect(report.bySpreadStatus.find(group => group.key === 'normal')?.count).toBe(1)
    expect(report.bySpreadBpsBucket.find(group => group.key === '25-50')?.count).toBe(1)
    expect(report.bySpreadBpsBucket.find(group => group.key === '<5')?.count).toBe(1)
  })

  it('triggers rolling stop-loss diagnostics when 7-day scoped thresholds are met', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    const runtimeDir = join(root, 'runtime')
    mkdirSync(paperDir, { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    const start = Date.parse('2026-05-01T00:00:00.000Z')
    const rows = Array.from({ length: 50 }, (_, i) => {
      const closeTs = new Date(start + i * 2 * 60 * 60 * 1000).toISOString()
      const openTs = new Date(start + i * 2 * 60 * 60 * 1000 - 10 * 60 * 1000).toISOString()
      return JSON.stringify({
        tradeId: `trade-${i}`,
        lane: 'microstructure_10x',
        symbol: 'DOGE-USDT',
        side: i % 2 === 0 ? 'long' : 'short',
        openTs,
        closeTs,
        pnlPct: i < 20 ? -2 : i < 40 ? -1 : 1,
        pnlUsd: i < 20 ? -20 : i < 40 ? -10 : 10,
        closeReason: i < 20 ? 'stop_loss' : 'holding_expired',
        volumeRatioAtOpen: i < 20 ? 3 : 0.8,
        breakQualityAtOpen: i < 20 ? 'weak' : 'strong',
        liquidityUsdAtOpen: i < 20 ? 25_000 : 1_500_000,
        liquidityStatusAtOpen: i < 20 ? 'thin' : 'deep',
        spreadStatusAtOpen: i < 20 ? 'wide' : 'normal',
        spreadBpsAtOpen: i < 20 ? 31 : 4,
        routeCostBpsAtOpen: i < 20 ? 43 : 8,
        roundTripCostBpsAtOpen: i < 20 ? 43 : 8,
        markMatchPenaltyBpsAtOpen: i < 20 ? 15 : 0,
        markMatchStatusAtOpen: i < 20 ? 'stale_or_missing' : 'ok',
        mfeBps: i < 20 ? 12 : 120,
        maeBps: i < 20 ? -140 : -20,
        timeToStopSec: i < 20 ? 45 : null,
        mfeBeforeStop: i < 20 ? false : null,
        regimeAtOpen: i < 20 ? 'vol-stress' : 'trend-follow',
        ...completeContext(200 + i),
        ruleScoreAtOpen: 0.6,
      })
    })
    writeFileSync(join(paperDir, 'paper_trade_result.jsonl'), rows.join('\n'))

    const report = await analyzePaperPnl({
      paperDir,
      runtimeDir,
      outputPath: join(root, 'diagnostics.json'),
      lookbackHours: null,
      topN: 5,
    })

    expect(report.stopLossRollingDiagnostics.triggered).toBe(true)
    expect(report.stopLossRollingDiagnostics.thresholds).toEqual({
      stopLossCount: 20,
      stopLossLossSharePct: 40,
      closedTrades: 50,
    })
    expect(report.stopLossRollingDiagnostics).toMatchObject({
      diagnosticUse: 'descriptive_worst_window_scan',
      promotionEligible: false,
      maxSelectionBias: true,
      scopesSearched: 8,
    })
    expect(report.stopLossRollingDiagnostics.windowsSearched).toBe(300)
    const laneSymbolTrigger = report.stopLossRollingDiagnostics.triggers.find(
      trigger => trigger.scopeType === 'lane_symbol' && trigger.scopeKey === 'microstructure_10x|DOGE-USDT',
    )
    expect(laneSymbolTrigger).toBeDefined()
    expect(laneSymbolTrigger?.closedTrades).toBe(50)
    expect(laneSymbolTrigger?.stopLossCount).toBe(20)
    expect(laneSymbolTrigger?.stopLossLossSharePct).toBeCloseTo(66.666, 2)
    const attribution = report.stopLossRollingDiagnostics.clusterAttribution
    expect(attribution.status).toBe('triggered')
    expect(attribution.blockedBy).toContain('diagnostic_only_not_trading_gate')
    expect(attribution.nextAction).toContain('paper-only replay')
    expect(attribution.topOffenders.lanes[0]).toMatchObject({
      dimension: 'lane',
      key: 'microstructure_10x',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.symbols[0]).toMatchObject({
      dimension: 'symbol',
      key: 'DOGE-USDT',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.sides[0]).toMatchObject({
      dimension: 'side',
      key: 'long',
      stopLossCount: 10,
    })
    expect(attribution.topOffenders.laneSymbolSides[0]).toMatchObject({
      dimension: 'lane_symbol_side',
      key: 'microstructure_10x|DOGE-USDT|long',
      stopLossCount: 10,
    })
    expect(attribution.topOffenders.regimes[0]).toMatchObject({
      dimension: 'regime',
      key: 'vol-stress',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.contextBuckets[0]).toMatchObject({
      dimension: 'context_bucket',
      key: 'ok',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.volumeRatioBuckets[0]).toMatchObject({
      dimension: 'volume_ratio_bucket',
      key: '2-5',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.breakQualityBuckets[0]).toMatchObject({
      dimension: 'break_quality_bucket',
      key: 'weak',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.liquidityUsdBuckets[0]).toMatchObject({
      dimension: 'liquidity_usd_bucket',
      key: '10k-50k',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.liquidityStatuses[0]).toMatchObject({
      dimension: 'liquidity_status',
      key: 'thin',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.spreadStatuses[0]).toMatchObject({
      dimension: 'spread_status',
      key: 'wide',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.spreadBpsBuckets[0]).toMatchObject({
      dimension: 'spread_bps_bucket',
      key: '25-50',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.routeCostBpsBuckets[0]).toMatchObject({
      dimension: 'route_cost_bps_bucket',
      key: '30-50',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.roundTripCostBpsBuckets[0]).toMatchObject({
      dimension: 'round_trip_cost_bps_bucket',
      key: '30-50',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.markMatchStatuses[0]).toMatchObject({
      dimension: 'mark_match_status',
      key: 'stale_or_missing',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.markMatchPenaltyBpsBuckets[0]).toMatchObject({
      dimension: 'mark_match_penalty_bps_bucket',
      key: '15-30',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.mfeBpsBuckets[0]).toMatchObject({
      dimension: 'mfe_bps_bucket',
      key: '<25',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.maeBpsBuckets[0]).toMatchObject({
      dimension: 'mae_bps_bucket',
      key: '100-250',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.mfeBeforeStopBuckets[0]).toMatchObject({
      dimension: 'mfe_before_stop',
      key: 'false',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.timeToStopBuckets[0]).toMatchObject({
      dimension: 'time_to_stop_bucket',
      key: '30-120s',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.holdingBuckets[0]).toMatchObject({
      dimension: 'holding_bucket',
      key: '10-30m',
      stopLossCount: 20,
    })
    expect(attribution.topOffenders.lanes[0].blockedBy).toContain('needs_counterfactual_replay_or_pro_review')
    expect(JSON.stringify(attribution)).not.toContain('expectedEdge')
    expect(report.recommendations[0]).toContain('nextAction=')
    expect(report.recommendations[1]).toContain('blockedBy=diagnostic_only_not_trading_gate')
  })

  it('computes max consecutive losses chronologically', () => {
    const baseTrade: NormalizedPaperTrade = {
      tradeId: 'base',
      source: 'test',
      lane: 'test',
      accountId: null,
      accountLabel: null,
      symbol: 'BTC-USDT',
      side: 'long',
      leverage: 1,
      openTs: '2026-05-01T00:00:00.000Z',
      closeTs: '2026-05-01T00:00:00.000Z',
      openPrice: 1,
      closePrice: 1,
      pnlPct: 0,
      pnlUsd: 0,
      closeReason: 'test',
      rawReason: null,
      holdingSeconds: 1,
      closeHourUtc: 0,
      priceSource: null,
      priceStale: null,
      volumeRatioAtOpen: null,
      breakQualityAtOpen: null,
      liquidityUsdAtOpen: null,
      liquidityStatusAtOpen: null,
      spreadStatusAtOpen: null,
      spreadBpsAtOpen: null,
      rankAtOpen: null,
      rankSpreadPctAtOpen: null,
      estimatedRoundTripCostPctAtOpen: null,
      estimatedRoundTripCostPctOfMarginAtOpen: null,
      routeCostBpsAtOpen: null,
      roundTripCostBpsAtOpen: null,
      markPriceAtOpen: null,
      markPriceTimestampAtOpen: null,
      matchPriceAtOpen: null,
      matchPriceSourceAtOpen: null,
      markMatchPenaltyBpsAtOpen: null,
      markMatchStatusAtOpen: null,
      realizedRoundTripCostBps: null,
      realizedCostBps: null,
      fillAdjustedCostBps: null,
      fillAdjustedCostPct: null,
      costEvidenceSource: null,
      costEvidenceStatus: null,
      mfeBps: null,
      maeBps: null,
      timeToMfeSec: null,
      timeToMaeSec: null,
      timeToStopSec: null,
      mfeBeforeStop: null,
      signalConfidenceAtOpen: null,
      contextSnapshotId: null,
      decisionTime: null,
      marketDataWatermarkAtDecisionTime: null,
      watermark: null,
      featuresAvailableAtDecisionTime: null,
      featureSchemaVersion: null,
      flashContextStatus: null,
      contextStatus: null,
      contextReason: null,
      contextCoverageStatus: null,
      contextCoverageReason: null,
      contextGenerationAtOpen: null,
      flashConfidenceLowAtOpen: null,
      ruleScoreAtOpen: null,
      proEpochAtOpen: null,
      marketIntelTriggerAtOpen: null,
      regimeAtOpen: null,
      contextCoverageBucket: 'legacy_missing',
      liquidated: false,
    }
    const stats = computeStats('test', [
      { ...baseTrade, tradeId: 'a', closeTs: '2026-05-01T00:00:00.000Z', pnlPct: -1 },
      { ...baseTrade, tradeId: 'b', closeTs: '2026-05-01T00:01:00.000Z', pnlPct: -1 },
      { ...baseTrade, tradeId: 'c', closeTs: '2026-05-01T00:02:00.000Z', pnlPct: 1 },
      { ...baseTrade, tradeId: 'd', closeTs: '2026-05-01T00:03:00.000Z', pnlPct: -1 },
    ])

    expect(stats.maxConsecutiveLosses).toBe(2)
    expect(stats.count).toBe(4)
    expect(stats.winRate).toBe(25)
  })
})
