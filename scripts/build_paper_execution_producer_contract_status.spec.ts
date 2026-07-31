import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildPaperExecutionProducerContractStatusReport,
  parsePaperExecutionProducerContractStatusArgs,
  runPaperExecutionProducerContractStatus,
} from './build_paper_execution_producer_contract_status.js'

describe('build_paper_execution_producer_contract_status', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parsePaperExecutionProducerContractStatusArgs([
      '--output',
      'null',
      '--json',
      'true',
    ])).toMatchObject({
      outputPath: null,
      paperTradeResultPath: 'src/runtime/paper_trade_result.ts',
      paperExecutionQualityPath: 'scripts/build_paper_execution_quality.ts',
      executionQualityPath: 'data/runtime/execution_quality.latest.json',
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['paper:execution-producer-contract']).toContain('build_paper_execution_producer_contract_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_paper_execution_producer_contract_status.ts')
  })

  it('marks future producers ready while keeping old paper execution evidence blocked', () => {
    const report = buildPaperExecutionProducerContractStatusReport({
      generatedAt: '2026-05-07T06:30:00.000Z',
      sourceArtifacts: sourceArtifacts(),
      sources: {
        paperTradeResult: source('/repo/src/runtime/paper_trade_result.ts', [
          'paperFillTelemetryStatus',
          'paperFillModelSource',
          'paperFillExpectedCostBps',
          'paperFillSimulatedSlippageBps',
          'paperFillIsExchangeReconciled',
          'buildPaperTradeCostEvidence',
          'paper_model_not_exchange_reconciled',
          'paperFillIsExchangeReconciled: false',
        ].join('\n')),
        paperExecutionQuality: source('/repo/scripts/build_paper_execution_quality.ts', [
          'tradesWithPaperFillTelemetry',
          'paperFillTelemetryCoveragePct',
          'paperModelMeanExpectedCostBps',
        ].join('\n')),
        crossSectionalProducer: producerSource('/repo/scripts/paper_trade_cross_sectional.ts'),
        volumeBreakoutProducer: producerSource('/repo/scripts/paper_trade_volume_breakout.ts'),
        microstructureProducer: producerSource('/repo/scripts/paper_trade_microstructure_stress.ts'),
      },
      executionQuality: {
        evidence: {
          closedTrades: 947,
          tradesWithPaperFillTelemetry: 0,
          tradesWithCompletePredictedOpenEvidence: 0,
          tradesWithExchangeReconciledCostEvidence: 0,
        },
        quality: {
          paperFillTelemetryCoveragePct: 0,
          completePredictedOpenEvidenceCoveragePct: 0,
          volumeWeightedSlippageBps: null,
          maxObservedSlippageBps: null,
        },
      },
    })

    expect(report).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      futureProducerOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'ready_future_only',
      producerContract: {
        futurePaperCloseRowsReady: true,
      },
      historicalExecutionQuality: {
        closedTrades: 947,
        tradesWithPaperFillTelemetry: 0,
        tradesWithExchangeReconciledCostEvidence: 0,
        observedSlippageAvailable: false,
      },
    })
    expect(report.blockers).toEqual([
      'historical_paper_fill_telemetry_coverage_low:0/947',
      'exchange_reconciled_cost_evidence_missing',
      'observed_slippage_unavailable',
    ])
  })

  it('blocks when a producer is missing the shared cost builder path', () => {
    const report = buildPaperExecutionProducerContractStatusReport({
      generatedAt: '2026-05-07T06:30:00.000Z',
      sourceArtifacts: sourceArtifacts(),
      sources: {
        paperTradeResult: source('/repo/src/runtime/paper_trade_result.ts', [
          'paperFillTelemetryStatus',
          'paperFillModelSource',
          'paperFillExpectedCostBps',
          'paperFillSimulatedSlippageBps',
          'paperFillIsExchangeReconciled',
          'buildPaperTradeCostEvidence',
          'paper_model_not_exchange_reconciled',
          'paperFillIsExchangeReconciled: false',
        ].join('\n')),
        paperExecutionQuality: source('/repo/scripts/build_paper_execution_quality.ts', [
          'tradesWithPaperFillTelemetry',
          'paperFillTelemetryCoveragePct',
          'paperModelMeanExpectedCostBps',
        ].join('\n')),
        crossSectionalProducer: producerSource('/repo/scripts/paper_trade_cross_sectional.ts'),
        volumeBreakoutProducer: source('/repo/scripts/paper_trade_volume_breakout.ts', 'appendPaperTradeResult\nbuildPaperTradePredictedOpenEvidence'),
        microstructureProducer: producerSource('/repo/scripts/paper_trade_microstructure_stress.ts'),
      },
      executionQuality: null,
    })

    expect(report.status).toBe('blocked')
    expect(report.blockers).toEqual(expect.arrayContaining([
      'volume_breakout_close_path_missing_shared_cost_builder',
      'execution_quality_artifact_missing',
    ]))
  })

  it('writes artifact and manifest sidecar without authorizing execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-paper-producer-contract-'))
    const outputPath = join(root, 'paper_execution_producer_contract_status.latest.json')
    const paperTradeResultPath = join(root, 'paper_trade_result.ts')
    const paperExecutionQualityPath = join(root, 'build_paper_execution_quality.ts')
    const executionQualityPath = join(root, 'execution_quality.latest.json')
    const crossSectionalProducerPath = join(root, 'paper_trade_cross_sectional.ts')
    const volumeBreakoutProducerPath = join(root, 'paper_trade_volume_breakout.ts')
    const microstructureProducerPath = join(root, 'paper_trade_microstructure_stress.ts')
    await mkdir(root, { recursive: true })
    await writeFile(paperTradeResultPath, [
      'paperFillTelemetryStatus',
      'paperFillModelSource',
      'paperFillExpectedCostBps',
      'paperFillSimulatedSlippageBps',
      'paperFillIsExchangeReconciled',
      'buildPaperTradeCostEvidence',
      'paper_model_not_exchange_reconciled',
      'paperFillIsExchangeReconciled: false',
    ].join('\n'), 'utf-8')
    await writeFile(paperExecutionQualityPath, [
      'tradesWithPaperFillTelemetry',
      'paperFillTelemetryCoveragePct',
      'paperModelMeanExpectedCostBps',
    ].join('\n'), 'utf-8')
    await writeFile(crossSectionalProducerPath, producerText(), 'utf-8')
    await writeFile(volumeBreakoutProducerPath, producerText(), 'utf-8')
    await writeFile(microstructureProducerPath, producerText(), 'utf-8')
    await writeFile(executionQualityPath, JSON.stringify({
      evidence: {
        closedTrades: 2,
        tradesWithPaperFillTelemetry: 0,
        tradesWithExchangeReconciledCostEvidence: 0,
      },
      quality: {
        paperFillTelemetryCoveragePct: 0,
        volumeWeightedSlippageBps: null,
        maxObservedSlippageBps: null,
      },
    }), 'utf-8')

    const report = await runPaperExecutionProducerContractStatus({
      outputPath,
      paperTradeResultPath,
      paperExecutionQualityPath,
      executionQualityPath,
      crossSectionalProducerPath,
      volumeBreakoutProducerPath,
      microstructureProducerPath,
      json: false,
    })

    expect(report.status).toBe('ready_future_only')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      futureProducerOnly: true,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'paper_execution_producer_contract_status',
      businessStatus: 'warn',
    })
  })
})

function source(path: string, text: string) {
  return { path, exists: true, text }
}

function producerSource(path: string) {
  return source(path, producerText())
}

function producerText() {
  return 'appendPaperTradeResult\nbuildPaperTradeCostEvidence\nbuildPaperTradePredictedOpenEvidence\n'
}

function sourceArtifacts() {
  return {
    paperTradeResultPath: '/repo/src/runtime/paper_trade_result.ts',
    paperExecutionQualityPath: '/repo/scripts/build_paper_execution_quality.ts',
    executionQualityPath: '/repo/data/runtime/execution_quality.latest.json',
    crossSectionalProducerPath: '/repo/scripts/paper_trade_cross_sectional.ts',
    volumeBreakoutProducerPath: '/repo/scripts/paper_trade_volume_breakout.ts',
    microstructureProducerPath: '/repo/scripts/paper_trade_microstructure_stress.ts',
  }
}
