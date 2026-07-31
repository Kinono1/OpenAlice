import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildPaperExecutionQualityReport,
  parsePaperExecutionQualityArgs,
  runPaperExecutionQuality,
} from './build_paper_execution_quality.js'

describe('build_paper_execution_quality', () => {
  it('parses defaults and keeps package script wired', () => {
    expect(parsePaperExecutionQualityArgs([
      '--output',
      'null',
      '--json',
      'true',
      '--lookbackHours',
      '24',
    ])).toMatchObject({
      paperDir: 'data/paper_trading',
      outputPath: null,
      lookbackHours: 24,
      baselineSlippageBps: 8,
      maxSlippageBps: 25,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['paper:execution-quality']).toContain('build_paper_execution_quality.ts')
    expect(scripts['status:research-evidence']).toContain('build_paper_execution_quality.ts')
  })

  it('summarizes paper execution quality without treating paper-model costs as exchange reconciled', () => {
    const report = buildPaperExecutionQualityReport({
      generatedAt: '2026-05-07T05:00:00.000Z',
      paperDir: '/repo/data/paper_trading',
      args: {
        lookbackHours: null,
        baselineSlippageBps: 8,
        maxSlippageBps: 25,
      },
      loaded: {
        loadedRows: 3,
        duplicateTradesSkipped: 0,
        skippedOpenRows: 1,
        closedTrades: [
          {
            tradeId: 'paper-model',
            source: 'paper_trade_result.jsonl',
            lane: 'volume_breakout_1x',
            symbol: 'BTC-USDT',
            side: 'long',
            openTs: '2026-05-07T00:00:00.000Z',
            closeTs: '2026-05-07T00:05:00.000Z',
            openPrice: 100,
            closePrice: 101,
            pnlPct: 1,
            routeCostBpsAtOpen: 28,
            roundTripCostBpsAtOpen: 28,
            estimatedRoundTripCostPctAtOpen: 0.28,
            realizedRoundTripCostBps: null,
            realizedCostBps: null,
            fillAdjustedCostBps: null,
            fillAdjustedCostPct: null,
            costEvidenceSource: 'paper_cost_model_at_open',
            costEvidenceStatus: 'paper_model_not_exchange_reconciled',
            paperFillTelemetryStatus: 'paper_model_not_exchange_reconciled',
            paperFillModelSource: 'paper_open_cost_model:simulated_fill',
            paperFillExpectedCostBps: 28,
            paperFillExpectedCostPct: 0.28,
            paperFillSimulatedSlippageBps: 15,
            paperFillRouteCostBps: 28,
            paperFillIsExchangeReconciled: false,
            predictedOpenEvidenceStatus: 'ok',
            matchPriceAtOpen: 100,
            matchPriceSourceAtOpen: 'simulated_fill',
          },
          {
            tradeId: 'exchange-reconciled',
            source: 'paper_trade_result.jsonl',
            lane: 'cross_sectional',
            symbol: 'ETH-USDT',
            side: 'short',
            openTs: '2026-05-07T01:00:00.000Z',
            closeTs: '2026-05-07T01:10:00.000Z',
            openPrice: 200,
            closePrice: 199,
            pnlPct: 0.5,
            routeCostBpsAtOpen: 20,
            roundTripCostBpsAtOpen: 20,
            estimatedRoundTripCostPctAtOpen: 0.2,
            realizedRoundTripCostBps: 18,
            realizedCostBps: 18,
            fillAdjustedCostBps: 18,
            fillAdjustedCostPct: 0.18,
            costEvidenceSource: 'exchange_reconciled_fill',
            costEvidenceStatus: 'exchange_reconciled',
            predictedOpenEvidenceStatus: 'ok',
            matchPriceAtOpen: 200,
            matchPriceSourceAtOpen: 'exchange_fill',
          },
        ],
      },
    })

    expect(report).toMatchObject({
      diagnosticOnly: true,
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      recentOrderCount: 2,
      slippageViolationCount: 0,
      actualToSimulatedCostRatio: 0.9,
      missedFillRate: 0,
      evidence: {
        closedTrades: 2,
        loadedRows: 3,
        skippedOpenRows: 1,
        tradesWithAnyPredictedCost: 2,
        tradesWithCompletePredictedOpenEvidence: 2,
        tradesWithRealizedCostEvidence: 1,
        tradesWithFillAdjustedCostEvidence: 1,
        tradesWithExchangeReconciledCostEvidence: 1,
        paperModelOnlyCostEvidence: 1,
        simulatedFillMatchPriceTrades: 1,
        tradesWithPaperFillTelemetry: 1,
        tradesWithPaperFillExpectedCost: 1,
        tradesWithPaperFillSimulatedSlippage: 1,
        tradesWithPaperFillRouteCost: 1,
        paperFillExchangeReconciledFalse: 1,
        latestCloseTs: '2026-05-07T01:10:00.000Z',
      },
      quality: {
        volumeWeightedSlippageBps: 18,
        maxObservedSlippageBps: 18,
        paperModelMeanExpectedCostBps: 28,
        paperModelMaxExpectedCostBps: 28,
        paperModelMeanSimulatedSlippageBps: 15,
        paperModelMaxSimulatedSlippageBps: 15,
        fillAdjustedCoveragePct: 50,
        exchangeReconciledCoveragePct: 50,
        paperFillTelemetryCoveragePct: 50,
        completePredictedOpenEvidenceCoveragePct: 100,
      },
    })
    expect(report.blockers).toEqual([])
  })

  it('writes artifact and manifest while staying blocked when exchange fill evidence is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-paper-execution-quality-'))
    const paperDir = join(root, 'paper')
    const outputPath = join(root, 'execution_quality.latest.json')
    await mkdir(paperDir, { recursive: true })
    await writeFile(join(paperDir, 'paper_trade_result.jsonl'), [
      JSON.stringify({
        tradeId: 'closed',
        lane: 'cross_sectional',
        symbol: 'BTC-USDT',
        side: 'long',
        openTs: '2026-05-07T00:00:00.000Z',
        closeTs: '2026-05-07T00:05:00.000Z',
        openPrice: 100,
        closePrice: 101,
        pnlPct: 1,
        routeCostBpsAtOpen: 28,
        roundTripCostBpsAtOpen: 28,
        estimatedRoundTripCostPctAtOpen: 0.28,
        costEvidenceSource: 'paper_cost_model_at_open',
        costEvidenceStatus: 'paper_model_not_exchange_reconciled',
        paperFillTelemetryStatus: 'paper_model_not_exchange_reconciled',
        paperFillModelSource: 'paper_open_cost_model:simulated_fill',
        paperFillExpectedCostBps: 28,
        paperFillExpectedCostPct: 0.28,
        paperFillSimulatedSlippageBps: 15,
        paperFillRouteCostBps: 28,
        paperFillIsExchangeReconciled: false,
        predictedOpenEvidenceStatus: 'ok',
        matchPriceAtOpen: 100,
        matchPriceSourceAtOpen: 'simulated_fill',
      }),
    ].join('\n'), 'utf-8')

    const report = await runPaperExecutionQuality({
      paperDir,
      outputPath,
      lookbackHours: null,
      baselineSlippageBps: 8,
      maxSlippageBps: 25,
      json: false,
    })

    expect(report.recentOrderCount).toBe(1)
    expect(report.evidence).toMatchObject({
      tradesWithPaperFillTelemetry: 1,
      tradesWithPaperFillExpectedCost: 1,
      tradesWithPaperFillSimulatedSlippage: 1,
      paperFillExchangeReconciledFalse: 1,
    })
    expect(report.quality).toMatchObject({
      paperModelMeanExpectedCostBps: 28,
      paperModelMeanSimulatedSlippageBps: 15,
      paperFillTelemetryCoveragePct: 100,
      exchangeReconciledCoveragePct: 0,
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'paper_execution_fill_adjusted_cost_evidence_missing',
      'paper_execution_exchange_reconciled_cost_evidence_missing',
      'paper_execution_observed_slippage_unavailable',
    ]))
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      diagnosticOnly: true,
      promotionEligible: false,
      executionAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'paper_execution_quality',
      businessStatus: 'fail',
    })
  })
})
