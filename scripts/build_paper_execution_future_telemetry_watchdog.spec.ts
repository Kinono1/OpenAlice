import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildPaperExecutionFutureTelemetryWatchdogReport,
  parsePaperExecutionFutureTelemetryWatchdogArgs,
  runPaperExecutionFutureTelemetryWatchdog,
} from './build_paper_execution_future_telemetry_watchdog.js'

describe('build_paper_execution_future_telemetry_watchdog', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parsePaperExecutionFutureTelemetryWatchdogArgs([
      '--output',
      'null',
      '--json',
      'true',
    ])).toMatchObject({
      outputPath: null,
      previousPath: 'data/runtime/paper_execution_future_telemetry_watchdog.latest.json',
      paperTradeResultPath: 'data/paper_trading/paper_trade_result.jsonl',
      producerContractStatusPath: 'data/runtime/paper_execution_producer_contract_status.latest.json',
      executionQualityPath: 'data/runtime/execution_quality.latest.json',
      minFuturePaperFillTelemetryCoveragePct: 95,
      minFuturePredictedOpenEvidenceCoveragePct: 95,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['paper:execution-future-telemetry-watchdog']).toContain('build_paper_execution_future_telemetry_watchdog.ts')
    expect(scripts['research:eth-carry:prospective-tick']).toContain('build_paper_execution_future_telemetry_watchdog.ts')
    expect(scripts['status:research-evidence']).toContain('build_paper_execution_future_telemetry_watchdog.ts')
  })

  it('waits on first run when no future closed rows exist', () => {
    const report = buildPaperExecutionFutureTelemetryWatchdogReport({
      generatedAt: '2026-05-07T10:45:00.000Z',
      args: makeArgs(),
      producerContractStatus: makeProducerContract({ generatedAt: '2026-05-07T10:40:00.000Z' }),
      executionQuality: makeExecutionQuality(),
      previous: null,
      paperRows: paperRows([
        row({ tradeId: 'old-1', openTs: '2026-05-07T09:00:00.000Z', closeTs: '2026-05-07T09:30:00.000Z' }),
      ]),
    })

    expect(report).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      futureOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'watch_waiting_for_future_rows',
      monitoringStartedAt: '2026-05-07T10:40:00.000Z',
      counts: {
        closedRows: 1,
        futureClosedRows: 0,
      },
      readiness: {
        producerReadyForFutureRows: true,
        hasFutureClosedRows: false,
        promotionGradePaperExecutionEvidence: false,
      },
      telemetryGap: {
        status: 'waiting_for_future_close_rows',
        latestClosedAt: '2026-05-07T09:30:00.000Z',
        latestClosedBeforeMonitoringStart: true,
        closedRowsBeforeMonitoringStart: 1,
        futureClosedRowsAfterMonitoringStart: 0,
        futureRowsMissingPaperFillTelemetry: 0,
      },
      blockers: [],
      evidenceBlockers: [
        'future_closed_paper_rows_missing',
        'future_new_open_closed_rows_missing',
        'exchange_reconciled_cost_evidence_missing',
        'observed_slippage_unavailable',
        'paper_execution_future_watchdog_diagnostic_only',
      ],
    })
  })

  it('preserves monitoringStartedAt from the previous artifact', () => {
    const report = buildPaperExecutionFutureTelemetryWatchdogReport({
      generatedAt: '2026-05-07T11:00:00.000Z',
      args: makeArgs(),
      producerContractStatus: makeProducerContract({ generatedAt: '2026-05-07T10:55:00.000Z' }),
      executionQuality: makeExecutionQuality(),
      previous: {
        monitoringStartedAt: '2026-05-07T10:40:00.000Z',
      },
      paperRows: paperRows([]),
    })

    expect(report.monitoringStartedAt).toBe('2026-05-07T10:40:00.000Z')
    expect(report.status).toBe('watch_waiting_for_future_rows')
  })

  it('blocks when future closed rows are missing paper fill telemetry', () => {
    const report = buildPaperExecutionFutureTelemetryWatchdogReport({
      generatedAt: '2026-05-07T11:00:00.000Z',
      args: makeArgs(),
      producerContractStatus: makeProducerContract({ generatedAt: '2026-05-07T10:40:00.000Z' }),
      executionQuality: makeExecutionQuality(),
      previous: null,
      paperRows: paperRows([
        row({
          tradeId: 'future-missing',
          openTs: '2026-05-07T10:45:00.000Z',
          closeTs: '2026-05-07T10:55:00.000Z',
          predictedOpenEvidenceStatus: 'missing',
        }),
      ]),
    })

    expect(report.status).toBe('blocked_future_rows_missing_telemetry')
    expect(report.counts).toMatchObject({
      futureClosedRows: 1,
      futureRowsWithPaperFillTelemetry: 0,
      futureNewOpenRowsWithCompletePredictedOpenEvidence: 0,
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'future_paper_fill_telemetry_coverage_low:0<95',
      'future_predicted_open_evidence_coverage_low:0<95',
    ]))
    expect(report.telemetryGap).toMatchObject({
      status: 'future_close_rows_missing_paper_model_telemetry',
      latestClosedAt: '2026-05-07T10:55:00.000Z',
      latestClosedBeforeMonitoringStart: false,
      latestFutureClosedAt: '2026-05-07T10:55:00.000Z',
      latestFutureNewOpenClosedAt: '2026-05-07T10:55:00.000Z',
      closedRowsBeforeMonitoringStart: 0,
      futureClosedRowsAfterMonitoringStart: 1,
      futureRowsMissingPaperFillTelemetry: 1,
      futureNewOpenRowsMissingPredictedOpenEvidence: 1,
      sampleFutureRowsMissingPaperFillTelemetry: ['future-missing'],
      sampleFutureNewOpenRowsMissingPredictedOpenEvidence: ['future-missing'],
    })
    expect(report.sampleProblemTradeIds).toEqual(['future-missing'])
  })

  it('marks future paper-model telemetry ready without claiming exchange reconciliation', () => {
    const report = buildPaperExecutionFutureTelemetryWatchdogReport({
      generatedAt: '2026-05-07T11:00:00.000Z',
      args: makeArgs(),
      producerContractStatus: makeProducerContract({ generatedAt: '2026-05-07T10:40:00.000Z' }),
      executionQuality: makeExecutionQuality({
        closedTrades: 948,
        tradesWithPaperFillTelemetry: 1,
      }),
      previous: null,
      paperRows: paperRows([
        row({
          tradeId: 'future-paper-model',
          openTs: '2026-05-07T10:45:00.000Z',
          closeTs: '2026-05-07T10:55:00.000Z',
          predictedOpenEvidenceStatus: 'ok',
          paperFillTelemetryStatus: 'paper_model_not_exchange_reconciled',
          paperFillExpectedCostBps: 12,
          paperFillSimulatedSlippageBps: 4,
          paperFillRouteCostBps: 12,
          paperFillIsExchangeReconciled: false,
          costEvidenceSource: 'paper_cost_model_at_open',
          fillAdjustedCostBps: 12,
        }),
      ]),
    })

    expect(report.status).toBe('watch_future_paper_model_telemetry_ready')
    expect(report.blockers).toEqual([])
    expect(report.counts).toMatchObject({
      futureClosedRows: 1,
      futureRowsWithPaperFillTelemetry: 1,
      futureRowsWithCompletePredictedOpenEvidence: 1,
      futureRowsWithExchangeReconciledCostEvidence: 0,
      futureRowsWithObservedSlippage: 0,
    })
    expect(report.coverage).toMatchObject({
      futurePaperFillTelemetryCoveragePct: 100,
      futureNewOpenPredictedOpenEvidenceCoveragePct: 100,
      futureExchangeReconciledCostCoveragePct: 0,
      futureObservedSlippageCoveragePct: 0,
    })
    expect(report.readiness).toMatchObject({
      futurePaperFillTelemetrySufficient: true,
      futurePredictedOpenEvidenceSufficient: true,
      exchangeReconciledCostEvidenceAvailable: false,
      observedSlippageAvailable: false,
      promotionGradePaperExecutionEvidence: false,
    })
    expect(report.telemetryGap).toMatchObject({
      status: 'paper_model_ready_missing_exchange_reconciled_or_observed_slippage',
      latestFutureClosedAt: '2026-05-07T10:55:00.000Z',
      futureClosedRowsAfterMonitoringStart: 1,
      futureRowsMissingPaperFillTelemetry: 0,
      futureNewOpenRowsMissingPredictedOpenEvidence: 0,
    })
    expect(report.evidenceBlockers).toEqual([
      'exchange_reconciled_cost_evidence_missing',
      'observed_slippage_unavailable',
      'paper_execution_future_watchdog_diagnostic_only',
    ])
  })

  it('blocks if an input artifact attempts to authorize execution', () => {
    const report = buildPaperExecutionFutureTelemetryWatchdogReport({
      generatedAt: '2026-05-07T11:00:00.000Z',
      args: makeArgs(),
      producerContractStatus: {
        ...makeProducerContract({ generatedAt: '2026-05-07T10:40:00.000Z' }),
        executionAllowed: true,
      },
      executionQuality: makeExecutionQuality(),
      previous: null,
      paperRows: paperRows([]),
    })

    expect(report.status).toBe('blocked')
    expect(report.blockers).toContain('input_artifact_must_not_authorize_execution')
    expect(report.executionAllowed).toBe(false)
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-paper-future-watchdog-'))
    const outputPath = join(root, 'paper_execution_future_telemetry_watchdog.latest.json')
    const previousPath = join(root, 'previous.json')
    const paperTradeResultPath = join(root, 'paper_trade_result.jsonl')
    const producerContractStatusPath = join(root, 'producer_contract.json')
    const executionQualityPath = join(root, 'execution_quality.json')
    await mkdir(root, { recursive: true })
    await writeFile(paperTradeResultPath, [
      JSON.stringify(row({
        tradeId: 'future-paper-model',
        openTs: '2026-05-07T10:45:00.000Z',
        closeTs: '2026-05-07T10:55:00.000Z',
        predictedOpenEvidenceStatus: 'ok',
        paperFillTelemetryStatus: 'paper_model_not_exchange_reconciled',
        paperFillExpectedCostBps: 12,
        paperFillSimulatedSlippageBps: 4,
        paperFillRouteCostBps: 12,
        paperFillIsExchangeReconciled: false,
        costEvidenceSource: 'paper_cost_model_at_open',
      })),
      '',
    ].join('\n'), 'utf-8')
    await writeFile(producerContractStatusPath, JSON.stringify(makeProducerContract({
      generatedAt: '2026-05-07T10:40:00.000Z',
    })), 'utf-8')
    await writeFile(executionQualityPath, JSON.stringify(makeExecutionQuality()), 'utf-8')

    const report = await runPaperExecutionFutureTelemetryWatchdog({
      ...makeArgs(),
      outputPath,
      previousPath,
      paperTradeResultPath,
      producerContractStatusPath,
      executionQualityPath,
    })

    expect(report.status).toBe('watch_future_paper_model_telemetry_ready')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      futureOnly: true,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'watch_future_paper_model_telemetry_ready',
      outputHash: expect.any(String),
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'paper_execution_future_telemetry_watchdog',
      businessStatus: 'warn',
      recordsIn: 1,
      recordsOut: 1,
    })
  })
})

function makeArgs() {
  return {
    outputPath: null,
    previousPath: null,
    paperTradeResultPath: 'data/paper_trading/paper_trade_result.jsonl',
    producerContractStatusPath: 'data/runtime/paper_execution_producer_contract_status.latest.json',
    executionQualityPath: 'data/runtime/execution_quality.latest.json',
    minFuturePaperFillTelemetryCoveragePct: 95,
    minFuturePredictedOpenEvidenceCoveragePct: 95,
    json: false,
  }
}

function makeProducerContract(input: { generatedAt: string }) {
  return {
    generatedAt: input.generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'ready_future_only',
    producerContract: {
      futurePaperCloseRowsReady: true,
    },
  }
}

function makeExecutionQuality(input: {
  closedTrades?: number
  tradesWithPaperFillTelemetry?: number
  tradesWithExchangeReconciledCostEvidence?: number
} = {}) {
  return {
    generatedAt: '2026-05-07T10:41:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    evidence: {
      closedTrades: input.closedTrades ?? 947,
      tradesWithPaperFillTelemetry: input.tradesWithPaperFillTelemetry ?? 0,
      tradesWithExchangeReconciledCostEvidence: input.tradesWithExchangeReconciledCostEvidence ?? 0,
    },
    quality: {
      volumeWeightedSlippageBps: null,
      maxObservedSlippageBps: null,
    },
  }
}

function paperRows(rows: Array<Record<string, unknown>>) {
  return {
    rows: rows as never[],
    totalLines: rows.length,
    parsedRows: rows.length,
    closedRows: rows.length,
    malformedRows: 0,
  }
}

function row(input: {
  tradeId: string
  openTs: string
  closeTs: string
  predictedOpenEvidenceStatus?: string
  paperFillTelemetryStatus?: string
  paperFillExpectedCostBps?: number
  paperFillSimulatedSlippageBps?: number
  paperFillRouteCostBps?: number
  paperFillIsExchangeReconciled?: boolean
  costEvidenceSource?: string
  realizedCostBps?: number
  fillAdjustedCostBps?: number
}) {
  return {
    tradeId: input.tradeId,
    lane: 'future-watchdog-test',
    symbol: 'ETH/USDT:USDT',
    openTs: input.openTs,
    closeTs: input.closeTs,
    closeMs: Date.parse(input.closeTs),
    openMs: Date.parse(input.openTs),
    predictedOpenEvidenceStatus: input.predictedOpenEvidenceStatus ?? null,
    paperFillTelemetryStatus: input.paperFillTelemetryStatus ?? null,
    paperFillExpectedCostBps: input.paperFillExpectedCostBps ?? null,
    paperFillSimulatedSlippageBps: input.paperFillSimulatedSlippageBps ?? null,
    paperFillRouteCostBps: input.paperFillRouteCostBps ?? null,
    paperFillIsExchangeReconciled: input.paperFillIsExchangeReconciled ?? null,
    costEvidenceSource: input.costEvidenceSource ?? null,
    realizedRoundTripCostBps: null,
    realizedCostBps: input.realizedCostBps ?? null,
    fillAdjustedCostBps: input.fillAdjustedCostBps ?? null,
    fillAdjustedCostPct: null,
  }
}
