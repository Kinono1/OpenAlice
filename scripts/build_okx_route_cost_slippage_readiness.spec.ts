import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildOkxRouteCostSlippageReadinessReport,
  parseOkxRouteCostSlippageReadinessArgs,
  runOkxRouteCostSlippageReadiness,
} from './build_okx_route_cost_slippage_readiness.js'

describe('build_okx_route_cost_slippage_readiness', () => {
  it('parses defaults and keeps package script wired', () => {
    expect(parseOkxRouteCostSlippageReadinessArgs([
      '--output',
      'null',
      '--json',
      'true',
      '--minPaperExecutionOrders',
      '30',
      '--requiredOrderbookSymbols',
      'BTCUSDT,ETHUSDT',
    ])).toMatchObject({
      outputPath: null,
      orderbookPath: 'data/runtime/okx_orderbook_spread_snapshot.latest.json',
      orderbookRowsPath: 'data/normalized/orderbook/okx_swap_orderbook_spread_live.normalized.jsonl',
      routeCostBudgetPath: 'data/runtime/route_cost_budget.latest.json',
      paperFutureTelemetryWatchdogPath: 'data/runtime/paper_execution_future_telemetry_watchdog.latest.json',
      minPaperExecutionOrders: 30,
      requiredOrderbookSymbols: ['BTCUSDT', 'ETHUSDT'],
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:okx:route-cost-slippage-readiness']).toContain('build_okx_route_cost_slippage_readiness.ts')
    expect(scripts['status:research-evidence']).toContain('build_okx_route_cost_slippage_readiness.ts')
  })

  it('blocks when route budget still embeds stale manual fee snapshot despite fresh OKX orderbook and runtime fees', () => {
    const report = buildOkxRouteCostSlippageReadinessReport({
      generatedAt: '2026-05-07T01:40:00.000Z',
      asOfMs: Date.parse('2026-05-07T01:40:00.000Z'),
      args: makeArgs(),
      orderbook: makeOrderbook(),
      feeSnapshot: makeRuntimeFeeSnapshot(),
      feeSnapshotRefresh: makeFeeSnapshotRefresh(),
      routeCostBudget: makeRouteCostBudget({
        source: 'manual_override',
        verifiedByRuntime: false,
        sourceFetchedAt: '2026-05-05T04:33:45.490Z',
        expiresAt: '2026-05-06T04:33:45.490Z',
        takerFeeBps: 6,
      }),
      executionQuality: {
        generatedAt: '2026-05-07T01:30:00.000Z',
        recentOrderCount: 11,
        slippageViolationCount: 0,
        actualToSimulatedCostRatio: 1,
        missedFillRate: 0,
        quality: {
          volumeWeightedSlippageBps: null,
          maxObservedSlippageBps: null,
        },
      },
      paperPnlDiagnostics: makePaperPnlDiagnostics({
        closedTrades: 947,
        tradesWithAnyPredictedCost: 2,
        tradesWithCompletePredictedOpenEvidence: 0,
        completePredictedOpenEvidenceCoveragePct: 0,
        tradesWithAnyRealizedCost: 0,
        tradesWithFillAdjustedCost: 0,
        tradesWithExchangeReconciledCostEvidence: 0,
      }),
      paperFutureTelemetryWatchdog: makeFutureTelemetryWatchdog(),
    })

    expect(report).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked',
      readiness: {
        publicOrderbookUsableForResearch: true,
        runtimeFeeSnapshotUsableForResearch: true,
        routeCostBudgetRuntimeVerified: false,
        routeCostBudgetFresh: false,
        paperExecutionTelemetryAvailable: false,
        promotionGradeRouteCostEvidence: false,
      },
      orderbook: {
        rowsBuilt: 3,
        blockedRows: 0,
        maxSpreadBps: 1.2,
        minDepth5Usd: 700000,
      },
      feeSnapshot: {
        source: 'api',
        verifiedByRuntime: true,
        stale: false,
      },
      routeCostBudget: {
        feeSnapshotSource: 'manual_override',
        feeSnapshotVerifiedByRuntime: false,
        feeSnapshotMatchesRuntimeFeeSnapshot: false,
        stale: true,
        selectedSafeResearchRoute: 'passive_passive',
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'route_cost_budget_stale',
      'route_cost_budget_fee_snapshot_source_not_api:manual_override',
      'route_cost_budget_fee_snapshot_not_runtime_verified',
      'route_cost_budget_fee_snapshot_mismatch',
      'paper_execution_quality_orders_low:11<20',
      'paper_execution_slippage_telemetry_unavailable',
      'paper_predicted_cost_coverage_low:0<95',
      'paper_exchange_reconciled_cost_evidence_missing',
      'paper_future_telemetry:future_closed_paper_rows_missing',
      'route_cost_slippage_readiness_diagnostic_only',
    ]))
  })

  it('stays watch-only but never promotion-grade when diagnostics are complete', () => {
    const runtimeFee = makeRuntimeFeeSnapshot()
    const report = buildOkxRouteCostSlippageReadinessReport({
      generatedAt: '2026-05-07T01:40:00.000Z',
      asOfMs: Date.parse('2026-05-07T01:40:00.000Z'),
      args: makeArgs(),
      orderbook: makeOrderbook(),
      feeSnapshot: runtimeFee,
      feeSnapshotRefresh: makeFeeSnapshotRefresh(),
      routeCostBudget: {
        generatedAt: '2026-05-07T01:35:00.000Z',
        feeSnapshot: runtimeFee,
        routes: {
          passive_passive: makeRoute('passive_passive', 14, 20),
          passive_taker: makeRoute('passive_taker', 18, 20),
        },
      },
      executionQuality: {
        generatedAt: '2026-05-07T01:30:00.000Z',
        recentOrderCount: 25,
        slippageViolationCount: 0,
        actualToSimulatedCostRatio: 1.1,
        missedFillRate: 0.05,
        evidence: {
          closedTrades: 100,
          tradesWithAnyPredictedCost: 100,
          tradesWithCompletePredictedOpenEvidence: 98,
          tradesWithAnyRealizedCostEvidence: 90,
          tradesWithFillAdjustedCostEvidence: 90,
          tradesWithExchangeReconciledCostEvidence: 90,
        },
        quality: {
          volumeWeightedSlippageBps: 4,
          maxObservedSlippageBps: 12,
          completePredictedOpenEvidenceCoveragePct: 98,
        },
      },
      paperPnlDiagnostics: makePaperPnlDiagnostics({
        closedTrades: 100,
        tradesWithAnyPredictedCost: 100,
        tradesWithCompletePredictedOpenEvidence: 98,
        completePredictedOpenEvidenceCoveragePct: 98,
        tradesWithAnyRealizedCost: 90,
        tradesWithFillAdjustedCost: 90,
        tradesWithExchangeReconciledCostEvidence: 90,
      }),
      paperFutureTelemetryWatchdog: makeFutureTelemetryWatchdog({
        futureClosedRows: 10,
        futureRowsWithPaperFillTelemetry: 10,
        futureRowsWithCompletePredictedOpenEvidence: 10,
        futureRowsWithExchangeReconciledCostEvidence: 0,
        futureRowsWithObservedSlippage: 0,
        futurePaperFillTelemetryCoveragePct: 100,
        futureNewOpenPredictedOpenEvidenceCoveragePct: 100,
        evidenceBlockers: [
          'exchange_reconciled_cost_evidence_missing',
          'observed_slippage_unavailable',
          'paper_execution_future_watchdog_diagnostic_only',
        ],
      }),
    })

    expect(report.status).toBe('blocked')
    expect(report.readiness).toMatchObject({
      publicOrderbookUsableForResearch: true,
      runtimeFeeSnapshotUsableForResearch: true,
      routeCostBudgetRuntimeVerified: true,
      routeCostBudgetFresh: true,
      paperExecutionTelemetryAvailable: true,
      promotionGradeRouteCostEvidence: false,
    })
    expect(report.paperCostEvidence).toMatchObject({
      source: 'execution_quality',
      completePredictedOpenEvidenceCoveragePct: 98,
      tradesWithExchangeReconciledCostEvidence: 90,
    })
    expect(report.paperFutureTelemetry).toMatchObject({
      exists: true,
      status: 'watch_future_paper_model_telemetry_ready',
      futureClosedRows: 10,
      futureRowsWithPaperFillTelemetry: 10,
      futureRowsWithExchangeReconciledCostEvidence: 0,
      futureRowsWithObservedSlippage: 0,
      futurePaperFillTelemetrySufficient: true,
      futurePredictedOpenEvidenceSufficient: true,
      futureExchangeReconciledCostEvidenceAvailable: false,
      futureObservedSlippageAvailable: false,
      telemetryGapStatus: 'paper_model_ready_missing_exchange_reconciled_or_observed_slippage',
      telemetryGapFutureClosedRowsAfterMonitoringStart: 10,
    })
    expect(report.blockers).toEqual([
      'paper_future_telemetry:exchange_reconciled_cost_evidence_missing',
      'paper_future_telemetry:observed_slippage_unavailable',
      'route_cost_slippage_readiness_diagnostic_only',
    ])
  })

  it('keeps research route-cost fee usable from a valid runtime snapshot even when fee refresh is blocked', () => {
    const runtimeFee = makeRuntimeFeeSnapshot()
    const report = buildOkxRouteCostSlippageReadinessReport({
      generatedAt: '2026-05-07T01:40:00.000Z',
      asOfMs: Date.parse('2026-05-07T01:40:00.000Z'),
      args: makeArgs(),
      orderbook: makeOrderbook(),
      feeSnapshot: runtimeFee,
      feeSnapshotRefresh: {
        generatedAt: '2026-05-07T01:35:00.000Z',
        status: 'blocked',
        snapshotWritten: false,
        perSymbolFees: [],
        blockers: [
          'fee_snapshot_no_valid_fee_rows',
          'fee_snapshot_fetch_failed:auth',
        ],
      },
      routeCostBudget: {
        generatedAt: '2026-05-07T01:35:00.000Z',
        feeSnapshot: runtimeFee,
        routes: {
          passive_passive: makeRoute('passive_passive', 14, 20),
        },
      },
      executionQuality: {
        generatedAt: '2026-05-07T01:30:00.000Z',
        recentOrderCount: 25,
        slippageViolationCount: 0,
        actualToSimulatedCostRatio: 1,
        missedFillRate: 0,
        quality: {
          volumeWeightedSlippageBps: null,
          completePredictedOpenEvidenceCoveragePct: 0,
        },
      },
      paperPnlDiagnostics: makePaperPnlDiagnostics({
        closedTrades: 100,
        tradesWithAnyPredictedCost: 0,
        tradesWithCompletePredictedOpenEvidence: 0,
        completePredictedOpenEvidenceCoveragePct: 0,
        tradesWithAnyRealizedCost: 0,
        tradesWithFillAdjustedCost: 0,
        tradesWithExchangeReconciledCostEvidence: 0,
      }),
      paperFutureTelemetryWatchdog: makeFutureTelemetryWatchdog(),
    })

    expect(report.readiness).toMatchObject({
      runtimeFeeSnapshotUsableForResearch: true,
      routeCostBudgetRuntimeVerified: true,
      promotionGradeRouteCostEvidence: false,
    })
    expect(report.blockers).not.toContain('runtime_fee_snapshot_not_research_usable')
    expect(report.blockers).toEqual(expect.arrayContaining([
      'fee_snapshot_refresh:fee_snapshot_no_valid_fee_rows',
      'fee_snapshot_refresh:fee_snapshot_fetch_failed:auth',
      'paper_execution_observed_slippage_unavailable',
      'paper_execution_slippage_telemetry_unavailable',
      'route_cost_slippage_readiness_diagnostic_only',
    ]))
  })

  it('does not treat shaped execution-quality rows as slippage telemetry without observed slippage', () => {
    const runtimeFee = makeRuntimeFeeSnapshot()
    const report = buildOkxRouteCostSlippageReadinessReport({
      generatedAt: '2026-05-07T01:40:00.000Z',
      asOfMs: Date.parse('2026-05-07T01:40:00.000Z'),
      args: makeArgs(),
      orderbook: makeOrderbook(),
      feeSnapshot: runtimeFee,
      feeSnapshotRefresh: makeFeeSnapshotRefresh(),
      routeCostBudget: {
        generatedAt: '2026-05-07T01:35:00.000Z',
        feeSnapshot: runtimeFee,
        routes: {
          passive_passive: makeRoute('passive_passive', 14, 20),
        },
      },
      executionQuality: {
        generatedAt: '2026-05-07T01:30:00.000Z',
        recentOrderCount: 947,
        slippageViolationCount: 0,
        actualToSimulatedCostRatio: 1,
        missedFillRate: 0,
        evidence: {
          closedTrades: 947,
          tradesWithAnyPredictedCost: 2,
          tradesWithCompletePredictedOpenEvidence: 0,
          tradesWithAnyRealizedCostEvidence: 0,
          tradesWithFillAdjustedCostEvidence: 0,
          tradesWithExchangeReconciledCostEvidence: 0,
          tradesWithPaperFillTelemetry: 900,
        },
        quality: {
          volumeWeightedSlippageBps: null,
          maxObservedSlippageBps: null,
          completePredictedOpenEvidenceCoveragePct: 0,
          paperFillTelemetryCoveragePct: 95.036959,
        },
      },
      paperPnlDiagnostics: makePaperPnlDiagnostics({
        closedTrades: 947,
        tradesWithAnyPredictedCost: 2,
        tradesWithCompletePredictedOpenEvidence: 0,
        completePredictedOpenEvidenceCoveragePct: 0,
        tradesWithAnyRealizedCost: 0,
        tradesWithFillAdjustedCost: 0,
        tradesWithExchangeReconciledCostEvidence: 0,
      }),
      paperFutureTelemetryWatchdog: makeFutureTelemetryWatchdog({
        futureClosedRows: 900,
        futureRowsWithPaperFillTelemetry: 900,
        futureRowsWithCompletePredictedOpenEvidence: 0,
        futureRowsWithExchangeReconciledCostEvidence: 0,
        futureRowsWithObservedSlippage: 0,
        futurePaperFillTelemetryCoveragePct: 100,
      }),
    })

    expect(report.executionQuality).toMatchObject({
      recentOrderCount: 947,
      telemetryShapeComplete: true,
      observedSlippageAvailable: false,
      telemetrySufficient: false,
    })
    expect(report.paperCostEvidence).toMatchObject({
      source: 'execution_quality',
      closedTrades: 947,
      completePredictedOpenEvidenceCoveragePct: 0,
      tradesWithExchangeReconciledCostEvidence: 0,
      tradesWithPaperFillTelemetry: 900,
      paperFillTelemetryCoveragePct: 95.036959,
    })
    expect(report.paperFutureTelemetry).toMatchObject({
      telemetryGapStatus: 'paper_model_ready_missing_exchange_reconciled_or_observed_slippage',
      telemetryGapFutureRowsMissingPaperFillTelemetry: 0,
      telemetryGapFutureNewOpenRowsMissingPredictedOpenEvidence: 900,
    })
    expect(report.readiness.paperExecutionTelemetryAvailable).toBe(false)
    expect(report.blockers).toEqual(expect.arrayContaining([
      'paper_execution_observed_slippage_unavailable',
      'paper_execution_slippage_telemetry_unavailable',
      'paper_predicted_cost_coverage_low:0<95',
      'paper_exchange_reconciled_cost_evidence_missing',
      'paper_future_telemetry:exchange_reconciled_cost_evidence_missing',
      'paper_future_telemetry:observed_slippage_unavailable',
    ]))
    expect(report.blockers).not.toContain('paper_execution_quality_orders_low:947<20')
  })

  it('blocks required symbols with row-level orderbook quality without globally lowering thresholds', () => {
    const runtimeFee = makeRuntimeFeeSnapshot()
    const report = buildOkxRouteCostSlippageReadinessReport({
      generatedAt: '2026-05-07T01:40:00.000Z',
      asOfMs: Date.parse('2026-05-07T01:40:00.000Z'),
      args: makeArgs({ requiredOrderbookSymbols: ['BTCUSDT', 'ETHUSDT'] }),
      orderbook: makeOrderbook({
        counts: {
          rowsBuilt: 3,
          blockedRows: 1,
        },
        blockers: ['okx_orderbook_spread_quality_blocked_rows:1'],
        qualityBySymbol: [
          makeOrderbookQualityBySymbol('BTCUSDT', 'pass'),
          makeOrderbookQualityBySymbol('ETHUSDT', 'blocked', ['depth5_usd_low:43884.63<100000']),
          makeOrderbookQualityBySymbol('SOLUSDT', 'pass'),
        ],
      }),
      feeSnapshot: runtimeFee,
      feeSnapshotRefresh: makeFeeSnapshotRefresh(),
      routeCostBudget: {
        generatedAt: '2026-05-07T01:35:00.000Z',
        feeSnapshot: runtimeFee,
        routes: {
          passive_passive: makeRoute('passive_passive', 14, 20),
        },
      },
      executionQuality: {
        generatedAt: '2026-05-07T01:30:00.000Z',
        recentOrderCount: 25,
        slippageViolationCount: 0,
        actualToSimulatedCostRatio: 1,
        missedFillRate: 0,
        evidence: {
          closedTrades: 100,
          tradesWithAnyPredictedCost: 100,
          tradesWithCompletePredictedOpenEvidence: 98,
          tradesWithExchangeReconciledCostEvidence: 90,
        },
        quality: {
          volumeWeightedSlippageBps: 4,
          completePredictedOpenEvidenceCoveragePct: 98,
        },
      },
      paperPnlDiagnostics: makePaperPnlDiagnostics({
        closedTrades: 100,
        tradesWithAnyPredictedCost: 100,
        tradesWithCompletePredictedOpenEvidence: 98,
        completePredictedOpenEvidenceCoveragePct: 98,
        tradesWithAnyRealizedCost: 90,
        tradesWithFillAdjustedCost: 90,
        tradesWithExchangeReconciledCostEvidence: 90,
      }),
      paperFutureTelemetryWatchdog: makeFutureTelemetryWatchdog({
        futureClosedRows: 10,
        futureRowsWithPaperFillTelemetry: 10,
        futureRowsWithCompletePredictedOpenEvidence: 10,
        futureRowsWithExchangeReconciledCostEvidence: 10,
        futureRowsWithObservedSlippage: 10,
        futurePaperFillTelemetryCoveragePct: 100,
        futureNewOpenPredictedOpenEvidenceCoveragePct: 100,
        futureExchangeReconciledCostCoveragePct: 100,
        futureObservedSlippageCoveragePct: 100,
        evidenceBlockers: ['paper_execution_future_watchdog_diagnostic_only'],
      }),
    })

    expect(report.readiness.publicOrderbookUsableForResearch).toBe(false)
    expect(report.orderbook).toMatchObject({
      requiredOrderbookSymbols: ['BTCUSDT', 'ETHUSDT'],
      requiredOrderbookPassedSymbols: ['BTCUSDT'],
      requiredOrderbookBlockedSymbols: ['ETHUSDT'],
      requiredOrderbookMissingSymbols: [],
      requiredOrderbookAllPass: false,
    })
    expect(report.blockers).toEqual([
      'okx_orderbook_required_symbols_blocked:ETHUSDT',
      'okx_orderbook_required_symbol:ETHUSDT:depth5_usd_low:43884.63<100000',
      'route_cost_slippage_readiness_diagnostic_only',
    ])
    expect(report.blockers).not.toContain('okx_orderbook_blocked_rows:1')
    expect(report.blockers).not.toContain('okx_orderbook:okx_orderbook_spread_quality_blocked_rows:1')
  })

  it('does not block scoped readiness for non-required symbol quality failures', () => {
    const runtimeFee = makeRuntimeFeeSnapshot()
    const report = buildOkxRouteCostSlippageReadinessReport({
      generatedAt: '2026-05-07T01:40:00.000Z',
      asOfMs: Date.parse('2026-05-07T01:40:00.000Z'),
      args: makeArgs({ requiredOrderbookSymbols: ['BTCUSDT', 'ETHUSDT'] }),
      orderbook: makeOrderbook({
        counts: {
          rowsBuilt: 3,
          blockedRows: 1,
        },
        blockers: ['okx_orderbook_spread_quality_blocked_rows:1'],
        qualityBySymbol: [
          makeOrderbookQualityBySymbol('BTCUSDT', 'pass'),
          makeOrderbookQualityBySymbol('ETHUSDT', 'pass'),
          makeOrderbookQualityBySymbol('SOLUSDT', 'blocked', ['depth5_usd_low:90000<100000']),
        ],
      }),
      feeSnapshot: runtimeFee,
      feeSnapshotRefresh: makeFeeSnapshotRefresh(),
      routeCostBudget: {
        generatedAt: '2026-05-07T01:35:00.000Z',
        feeSnapshot: runtimeFee,
        routes: {
          passive_passive: makeRoute('passive_passive', 14, 20),
        },
      },
      executionQuality: {
        generatedAt: '2026-05-07T01:30:00.000Z',
        recentOrderCount: 25,
        slippageViolationCount: 0,
        actualToSimulatedCostRatio: 1,
        missedFillRate: 0,
        evidence: {
          closedTrades: 100,
          tradesWithAnyPredictedCost: 100,
          tradesWithCompletePredictedOpenEvidence: 98,
          tradesWithExchangeReconciledCostEvidence: 90,
        },
        quality: {
          volumeWeightedSlippageBps: 4,
          completePredictedOpenEvidenceCoveragePct: 98,
        },
      },
      paperPnlDiagnostics: makePaperPnlDiagnostics({
        closedTrades: 100,
        tradesWithAnyPredictedCost: 100,
        tradesWithCompletePredictedOpenEvidence: 98,
        completePredictedOpenEvidenceCoveragePct: 98,
        tradesWithAnyRealizedCost: 90,
        tradesWithFillAdjustedCost: 90,
        tradesWithExchangeReconciledCostEvidence: 90,
      }),
      paperFutureTelemetryWatchdog: makeFutureTelemetryWatchdog({
        futureClosedRows: 10,
        futureRowsWithPaperFillTelemetry: 10,
        futureRowsWithCompletePredictedOpenEvidence: 10,
        futureRowsWithExchangeReconciledCostEvidence: 10,
        futureRowsWithObservedSlippage: 10,
        futurePaperFillTelemetryCoveragePct: 100,
        futureNewOpenPredictedOpenEvidenceCoveragePct: 100,
        futureExchangeReconciledCostCoveragePct: 100,
        futureObservedSlippageCoveragePct: 100,
        evidenceBlockers: ['paper_execution_future_watchdog_diagnostic_only'],
      }),
    })

    expect(report.readiness.publicOrderbookUsableForResearch).toBe(true)
    expect(report.orderbook).toMatchObject({
      requiredOrderbookPassedSymbols: ['BTCUSDT', 'ETHUSDT'],
      requiredOrderbookBlockedSymbols: [],
      requiredOrderbookAllPass: true,
    })
    expect(report.blockers).toEqual(['route_cost_slippage_readiness_diagnostic_only'])
  })

  it('uses recent pass-quality orderbook rows as research-only cache when latest snapshot is partial', () => {
    const runtimeFee = makeRuntimeFeeSnapshot()
    const report = buildOkxRouteCostSlippageReadinessReport({
      generatedAt: '2026-05-07T01:40:00.000Z',
      asOfMs: Date.parse('2026-05-07T01:40:00.000Z'),
      args: makeArgs(),
      orderbook: makeOrderbook({
        generatedAt: '2026-05-07T01:39:00.000Z',
        status: 'partial',
        counts: {
          rowsBuilt: 1,
          blockedRows: 0,
        },
        symbols: ['ETHUSDT'],
        qualityBySymbol: [makeOrderbookQualityBySymbol('ETHUSDT', 'pass')],
        blockers: [
          'okx_orderbook_spread_rows_missing:1<3',
          'okx_orderbook_spread_errors:2',
        ],
      }),
      orderbookRows: [
        makeOrderbookCacheRow('BTCUSDT', '2026-05-07T01:34:00.000Z'),
        makeOrderbookCacheRow('SOLUSDT', '2026-05-07T01:35:00.000Z'),
        makeOrderbookCacheRow('BTCUSDT', '2026-05-06T20:00:00.000Z'),
      ],
      feeSnapshot: runtimeFee,
      feeSnapshotRefresh: makeFeeSnapshotRefresh(),
      routeCostBudget: {
        generatedAt: '2026-05-07T01:35:00.000Z',
        feeSnapshot: runtimeFee,
        routes: {
          passive_passive: makeRoute('passive_passive', 14, 20),
        },
      },
      executionQuality: {
        generatedAt: '2026-05-07T01:30:00.000Z',
        recentOrderCount: 25,
        slippageViolationCount: 0,
        actualToSimulatedCostRatio: 1,
        missedFillRate: 0,
        quality: {
          volumeWeightedSlippageBps: null,
          completePredictedOpenEvidenceCoveragePct: 0,
        },
      },
      paperPnlDiagnostics: makePaperPnlDiagnostics({
        closedTrades: 100,
        tradesWithAnyPredictedCost: 0,
        tradesWithCompletePredictedOpenEvidence: 0,
        completePredictedOpenEvidenceCoveragePct: 0,
        tradesWithAnyRealizedCost: 0,
        tradesWithFillAdjustedCost: 0,
        tradesWithExchangeReconciledCostEvidence: 0,
      }),
      paperFutureTelemetryWatchdog: makeFutureTelemetryWatchdog(),
    })

    expect(report.readiness.publicOrderbookUsableForResearch).toBe(true)
    expect(report.orderbook).toMatchObject({
      status: 'partial',
      rowsBuilt: 3,
      cacheFallbackUsed: true,
      cacheSymbolsUsed: ['BTCUSDT', 'SOLUSDT'],
      requiredOrderbookPassedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      requiredOrderbookMissingSymbols: [],
      requiredOrderbookAllPass: true,
    })
    expect(report.blockers).not.toContain('okx_orderbook_spread_status:partial')
    expect(report.blockers).not.toContain('okx_orderbook_rows_low:1<3')
    expect(report.blockers).not.toContain('okx_orderbook_required_symbols_missing:BTCUSDT,SOLUSDT')
    expect(report.blockers).toEqual(expect.arrayContaining([
      'paper_execution_observed_slippage_unavailable',
      'paper_execution_slippage_telemetry_unavailable',
    ]))
  })

  it('falls back to paper PnL cost evidence when execution-quality evidence is absent', () => {
    const runtimeFee = makeRuntimeFeeSnapshot()
    const report = buildOkxRouteCostSlippageReadinessReport({
      generatedAt: '2026-05-07T01:40:00.000Z',
      asOfMs: Date.parse('2026-05-07T01:40:00.000Z'),
      args: makeArgs(),
      orderbook: makeOrderbook(),
      feeSnapshot: runtimeFee,
      feeSnapshotRefresh: makeFeeSnapshotRefresh(),
      routeCostBudget: {
        generatedAt: '2026-05-07T01:35:00.000Z',
        feeSnapshot: runtimeFee,
        routes: {
          passive_passive: makeRoute('passive_passive', 14, 20),
        },
      },
      executionQuality: {
        generatedAt: '2026-05-07T01:30:00.000Z',
        recentOrderCount: 25,
        slippageViolationCount: 0,
        actualToSimulatedCostRatio: 1,
        missedFillRate: 0,
        quality: {
          volumeWeightedSlippageBps: 4,
          maxObservedSlippageBps: 12,
        },
      },
      paperPnlDiagnostics: makePaperPnlDiagnostics({
        closedTrades: 100,
        tradesWithAnyPredictedCost: 100,
        tradesWithCompletePredictedOpenEvidence: 96,
        completePredictedOpenEvidenceCoveragePct: 96,
        tradesWithAnyRealizedCost: 80,
        tradesWithFillAdjustedCost: 80,
        tradesWithExchangeReconciledCostEvidence: 80,
      }),
      paperFutureTelemetryWatchdog: makeFutureTelemetryWatchdog({
        futureClosedRows: 25,
        futureRowsWithPaperFillTelemetry: 25,
        futureRowsWithCompletePredictedOpenEvidence: 25,
        futureRowsWithExchangeReconciledCostEvidence: 25,
        futureRowsWithObservedSlippage: 25,
        futurePaperFillTelemetryCoveragePct: 100,
        futureNewOpenPredictedOpenEvidenceCoveragePct: 100,
        futureExchangeReconciledCostCoveragePct: 100,
        futureObservedSlippageCoveragePct: 100,
        evidenceBlockers: ['paper_execution_future_watchdog_diagnostic_only'],
      }),
    })

    expect(report.paperCostEvidence).toMatchObject({
      source: 'paper_pnl_diagnostics',
      completePredictedOpenEvidenceCoveragePct: 96,
      tradesWithFillAdjustedCost: 80,
      tradesWithExchangeReconciledCostEvidence: 80,
    })
    expect(report.readiness.paperExecutionTelemetryAvailable).toBe(true)
    expect(report.blockers).toEqual(['route_cost_slippage_readiness_diagnostic_only'])
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-route-cost-'))
    const outputPath = join(root, 'okx_route_cost_slippage_readiness.latest.json')
    const orderbookPath = join(root, 'okx_orderbook.json')
    const feeSnapshotPath = join(root, 'fee_snapshot.json')
    const feeSnapshotRefreshPath = join(root, 'fee_snapshot_refresh.json')
    const routeCostBudgetPath = join(root, 'route_cost_budget.json')
    const executionQualityPath = join(root, 'execution_quality.json')
    const paperPnlDiagnosticsPath = join(root, 'paper_pnl.json')
    const paperFutureTelemetryWatchdogPath = join(root, 'future_watchdog.json')
    await mkdir(root, { recursive: true })
    await writeJson(orderbookPath, makeOrderbook())
    await writeJson(feeSnapshotPath, makeRuntimeFeeSnapshot())
    await writeJson(feeSnapshotRefreshPath, makeFeeSnapshotRefresh())
    await writeJson(routeCostBudgetPath, makeRouteCostBudget({
      source: 'manual_override',
      verifiedByRuntime: false,
      sourceFetchedAt: '2026-05-05T04:33:45.490Z',
      expiresAt: '2026-05-06T04:33:45.490Z',
      takerFeeBps: 6,
    }))
    await writeJson(executionQualityPath, {
      recentOrderCount: 0,
    })
    await writeJson(paperPnlDiagnosticsPath, makePaperPnlDiagnostics({
      closedTrades: 10,
      tradesWithAnyPredictedCost: 0,
      tradesWithCompletePredictedOpenEvidence: 0,
      completePredictedOpenEvidenceCoveragePct: 0,
      tradesWithAnyRealizedCost: 0,
      tradesWithFillAdjustedCost: 0,
      tradesWithExchangeReconciledCostEvidence: 0,
    }))
    await writeJson(paperFutureTelemetryWatchdogPath, makeFutureTelemetryWatchdog())

    const report = await runOkxRouteCostSlippageReadiness({
      ...makeArgs(),
      outputPath,
      orderbookPath,
      feeSnapshotPath,
      feeSnapshotRefreshPath,
      routeCostBudgetPath,
      executionQualityPath,
      paperPnlDiagnosticsPath,
      paperFutureTelemetryWatchdogPath,
      json: false,
    })

    expect(report.status).toBe('blocked')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      executionAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'okx_route_cost_slippage_readiness',
      businessStatus: 'fail',
    })
  })
})

const DEFAULT_TEST_ARGS = {
  outputPath: null,
  orderbookPath: 'data/runtime/okx_orderbook_spread_snapshot.latest.json',
  orderbookRowsPath: 'data/normalized/orderbook/okx_swap_orderbook_spread_live.normalized.jsonl',
  feeSnapshotPath: 'data/runtime/fee_snapshot.latest.json',
  feeSnapshotRefreshPath: 'data/runtime/fee_snapshot_refresh.latest.json',
  routeCostBudgetPath: 'data/runtime/route_cost_budget.latest.json',
  executionQualityPath: 'data/runtime/execution_quality.latest.json',
  paperPnlDiagnosticsPath: 'data/research/paper_pnl_diagnostics.latest.json',
  paperFutureTelemetryWatchdogPath: 'data/runtime/paper_execution_future_telemetry_watchdog.latest.json',
  maxOrderbookAgeMs: 2 * 60 * 60 * 1000,
  maxFeeSnapshotAgeMs: 26 * 60 * 60 * 1000,
  maxRouteBudgetAgeMs: 26 * 60 * 60 * 1000,
  minOrderbookRows: 3,
  requiredOrderbookSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  minPaperExecutionOrders: 20,
  minCompletePredictedCostCoveragePct: 95,
  json: false,
}

function makeArgs(overrides: Partial<typeof DEFAULT_TEST_ARGS> = {}) {
  return {
    ...DEFAULT_TEST_ARGS,
    ...overrides,
  }
}

function makeOrderbook(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: '2026-05-07T01:29:45.125Z',
    status: 'complete',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    counts: {
      rowsBuilt: 3,
      blockedRows: 0,
    },
    spreadSummary: {
      maxSpreadBps: 1.2,
      medianSpreadBps: 0.05,
      minDepth5Usd: 700000,
    },
    blockers: [],
    qualityBySymbol: [
      makeOrderbookQualityBySymbol('BTCUSDT', 'pass'),
      makeOrderbookQualityBySymbol('ETHUSDT', 'pass'),
      makeOrderbookQualityBySymbol('SOLUSDT', 'pass'),
    ],
    ...overrides,
  }
}

function makeOrderbookQualityBySymbol(symbol: string, status: 'pass' | 'blocked', blockers: string[] = []) {
  return {
    symbol,
    status,
    blockers,
    spreadBps: 0.05,
    depth5Usd: status === 'pass' ? 700000 : 43884.63,
    bidNotionalDepth5: status === 'pass' ? 700000 : 100000,
    askNotionalDepth5: status === 'pass' ? 700000 : 43884.63,
    availableAt: '2026-05-07T01:29:45.125Z',
    eventTime: '2026-05-07T01:29:44.000Z',
  }
}

function makeOrderbookCacheRow(symbol: string, availableAt: string, status: 'pass' | 'blocked' = 'pass') {
  return {
    schemaVersion: 'openalice.orderbook_spread_snapshot.v1',
    eventTime: availableAt,
    exchange: 'okx',
    market: 'swap',
    symbol,
    availableAt,
    ingestedAt: availableAt,
    generatedAt: availableAt,
    quality: {
      status,
      blockers: status === 'pass' ? [] : ['depth5_usd_low:50000<100000'],
    },
    fields: {
      spreadBps: 0.05,
      bidNotionalDepth5: 700000,
      askNotionalDepth5: 700000,
    },
  }
}

function makeRuntimeFeeSnapshot() {
  return {
    venue: 'okx',
    symbol: 'cross_sectional_universe',
    instrumentType: 'crypto_perpetual',
    accountTier: 'runtime_api_max_fee:okx:swap:symbols=3',
    makerFeeBps: 2,
    takerFeeBps: 5,
    source: 'api',
    sourceFetchedAt: '2026-05-07T00:11:17.396Z',
    expiresAt: '2026-05-08T00:11:17.396Z',
    verifiedByRuntime: true,
  }
}

function makeFeeSnapshotRefresh() {
  return {
    generatedAt: '2026-05-07T00:11:17.396Z',
    status: 'runtime_verified',
    snapshotWritten: true,
    perSymbolFees: [{ symbol: 'BTC/USDT:USDT' }],
    blockers: [],
  }
}

function makeRouteCostBudget(feeSnapshot: Record<string, unknown>) {
  return {
    generatedAt: '2026-05-05T04:33:45.490Z',
    feeSnapshot: {
      venue: 'openalice-paper',
      symbol: 'cross_sectional_universe',
      instrumentType: 'crypto_perpetual',
      accountTier: 'unknown',
      makerFeeBps: 2,
      ...feeSnapshot,
    },
    routes: {
      passive_passive: makeRoute('passive_passive', 18, 20),
      taker_taker: makeRoute('taker_taker', 43, 20),
    },
  }
}

function makeRoute(route: string, totalExpectedCostBps: number, maxAllowedCostBps: number) {
  return {
    route,
    feeBps: 4,
    spreadBps: 2,
    slippageBps: 3,
    adverseSelectionBufferBps: 3,
    queueMissBufferBps: 2,
    fundingBps: 0,
    totalExpectedCostBps,
    maxAllowedCostBps,
    breakEvenEdgeBps: totalExpectedCostBps,
  }
}

function makePaperPnlDiagnostics(costEvidence: Record<string, unknown>) {
  return {
    coverage: {
      costEvidence: {
        status: 'partial',
        ...costEvidence,
      },
    },
  }
}

function makeFutureTelemetryWatchdog(input: {
  futureClosedRows?: number
  futureRowsWithPaperFillTelemetry?: number
  futureRowsWithCompletePredictedOpenEvidence?: number
  futureRowsWithExchangeReconciledCostEvidence?: number
  futureRowsWithObservedSlippage?: number
  futurePaperFillTelemetryCoveragePct?: number | null
  futureNewOpenPredictedOpenEvidenceCoveragePct?: number | null
  futureExchangeReconciledCostCoveragePct?: number | null
  futureObservedSlippageCoveragePct?: number | null
  evidenceBlockers?: string[]
  telemetryGapStatus?: string
} = {}) {
  const futureClosedRows = input.futureClosedRows ?? 0
  const futureRowsWithPaperFillTelemetry = input.futureRowsWithPaperFillTelemetry ?? 0
  const futureRowsWithCompletePredictedOpenEvidence = input.futureRowsWithCompletePredictedOpenEvidence ?? 0
  const futureRowsWithExchangeReconciledCostEvidence = input.futureRowsWithExchangeReconciledCostEvidence ?? 0
  const futureRowsWithObservedSlippage = input.futureRowsWithObservedSlippage ?? 0
  return {
    status: futureClosedRows > 0
      ? 'watch_future_paper_model_telemetry_ready'
      : 'watch_waiting_for_future_rows',
    researchOnly: true,
    diagnosticOnly: true,
    futureOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    monitoringStartedAt: '2026-05-07T10:41:12.111Z',
    counts: {
      futureClosedRows,
      futureRowsWithPaperFillTelemetry,
      futureRowsWithCompletePredictedOpenEvidence,
      futureRowsWithExchangeReconciledCostEvidence,
      futureRowsWithObservedSlippage,
    },
    coverage: {
      futurePaperFillTelemetryCoveragePct: input.futurePaperFillTelemetryCoveragePct ?? null,
      futureNewOpenPredictedOpenEvidenceCoveragePct: input.futureNewOpenPredictedOpenEvidenceCoveragePct ?? null,
      futureExchangeReconciledCostCoveragePct: input.futureExchangeReconciledCostCoveragePct ?? null,
      futureObservedSlippageCoveragePct: input.futureObservedSlippageCoveragePct ?? null,
    },
    readiness: {
      futurePaperFillTelemetrySufficient: futureClosedRows > 0 && futureRowsWithPaperFillTelemetry === futureClosedRows,
      futurePredictedOpenEvidenceSufficient: futureClosedRows === 0 ||
        futureRowsWithCompletePredictedOpenEvidence === futureClosedRows,
      exchangeReconciledCostEvidenceAvailable: futureRowsWithExchangeReconciledCostEvidence > 0,
      observedSlippageAvailable: futureRowsWithObservedSlippage > 0,
      promotionGradePaperExecutionEvidence: false,
    },
    telemetryGap: {
      status: input.telemetryGapStatus ?? (futureClosedRows > 0
        ? 'paper_model_ready_missing_exchange_reconciled_or_observed_slippage'
        : 'waiting_for_future_close_rows'),
      monitoringAgeMinutes: 60,
      latestClosedAt: futureClosedRows > 0 ? '2026-05-07T10:55:00.000Z' : '2026-05-06T20:17:02.439Z',
      latestClosedBeforeMonitoringStart: futureClosedRows === 0,
      futureClosedRowsAfterMonitoringStart: futureClosedRows,
      futureRowsMissingPaperFillTelemetry: Math.max(0, futureClosedRows - futureRowsWithPaperFillTelemetry),
      futureNewOpenRowsMissingPredictedOpenEvidence: Math.max(0, futureClosedRows - futureRowsWithCompletePredictedOpenEvidence),
    },
    blockers: [],
    evidenceBlockers: input.evidenceBlockers ?? [
      'future_closed_paper_rows_missing',
      'future_new_open_closed_rows_missing',
      'exchange_reconciled_cost_evidence_missing',
      'observed_slippage_unavailable',
      'paper_execution_future_watchdog_diagnostic_only',
    ],
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}
