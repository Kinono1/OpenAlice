import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { evaluateReleaseGate } from '../src/backtest/release_gate.js'
import { buildTrialLedgerSummary } from '../src/backtest/statistical_significance.js'
import {
  DATA_LINEAGE_SCHEMA_VERSION,
  dataLineageGraphFromJson,
  validateDataLineageGraph,
} from '../src/data/data_lineage.js'
import type { BacktestMetrics } from '../src/backtest/strategy-validation/backtest.js'
import type {
  StrategyParams,
  StrategyRegimeLabel,
} from '../src/backtest/strategy-validation/types.js'
import {
  appendCompleteTrialUniverseMarkerIfReady,
  buildFeatureAvailabilityAudit,
  buildPromotionGradePitAudit,
  buildRecommendedCandidate,
  evaluateSignificanceGateForReport,
} from './run_validation_pipeline.ts'

function makeMetrics(overrides: Partial<BacktestMetrics> = {}): BacktestMetrics {
  return {
    initialCapital: 10_000,
    finalEquity: 10_000,
    totalReturnPct: 0,
    annualizedReturnPct: 0,
    maxDrawdownPct: 10,
    sharpe: 0,
    sortino: 0,
    calmar: 0,
    winRatePct: 0,
    profitFactor: 0,
    payoffRatio: 0,
    averageWinPct: 0,
    averageLossPct: 0,
    grossExpectancyPct: 0,
    feeExpectancyDragPct: 0,
    slippageExpectancyDragPct: 0,
    fundingExpectancyDragPct: 0,
    netExpectancyPct: 0,
    expectancyPct: 0,
    tradeCount: 20,
    longTradeCount: 10,
    shortTradeCount: 10,
    averageHoldingBars: 1,
    averageHoldingHours: 1,
    medianHoldingBars: 1,
    medianHoldingHours: 1,
    totalFeesPaid: 0,
    totalSlippagePaid: 0,
    totalFundingPaid: 0,
    totalCostsPaid: 0,
    costDragPctOfInitialCapital: 0,
    totalTurnoverUsd: 0,
    turnoverPctOfInitialCapital: 0,
    averageTurnoverPctPerTrade: 0,
    sideSummary: {
      long: {
        tradeCount: 0,
        winRatePct: 0,
        grossExpectancyPct: 0,
        netExpectancyPct: 0,
        totalGrossReturnPct: 0,
        totalNetReturnPct: 0,
        averageHoldingHours: 0,
      },
      short: {
        tradeCount: 0,
        winRatePct: 0,
        grossExpectancyPct: 0,
        netExpectancyPct: 0,
        totalGrossReturnPct: 0,
        totalNetReturnPct: 0,
        averageHoldingHours: 0,
      },
    },
    regimeSummary: {},
    ...overrides,
  }
}

function makeBaselineReport(netExpectancyPct = 0) {
  return {
    expectancyAfterCost: { netExpectancyPct },
  }
}

function makeDelta(overrides: Partial<Record<string, number | Record<string, number>>> = {}) {
  return {
    totalReturnPct: 0,
    netExpectancyPct: 0,
    maxDrawdownPct: 0,
    tradeCount: 0,
    sharpe: 0,
    sortino: 0,
    calmar: 0,
    byRegimeNetExpectancyPct: {},
    ...overrides,
  }
}

function makeArm(input: {
  armId: string
  label?: string
  rank?: number
  metrics?: BacktestMetrics
  diagnostics?: Record<string, unknown>
  selection?: Record<string, unknown>
  gate?: { allowedEntryRegimes: StrategyRegimeLabel[]; exitOnMismatch?: boolean }
}) {
  const metrics = input.metrics ?? makeMetrics()
  return {
    armId: input.armId,
    label: input.label ?? input.armId,
    rank: input.rank ?? 1,
    metrics,
    baselineReport: makeBaselineReport(metrics.netExpectancyPct),
    delta: makeDelta(),
    diagnostics: input.diagnostics,
    selection: input.selection,
    gate: input.gate,
  }
}

function makePitAuditContract(input: {
  requiredFeatures: Array<{
    featureId: string
    required: true
    availableTimePolicy: 'available_time <= decision_time'
    qualityStatusesAllowed: ['ok'] | ['ok', 'degraded']
  }>
  failureModes: Array<'PIT_PROXY_ONLY' | 'PIT_VIOLATION'>
}) {
  return {
    familyId: 'unit_pit_contract',
    role: 'alpha' as const,
    requiredFeatures: input.requiredFeatures,
    decisionHorizon: '1m',
    labelHorizon: '5m',
    allowedUniverse: ['BTC-USDT'],
    maxTurnover: 1,
    maxLeverage: 1,
    promotionEligibility: 'paper_candidate' as const,
    failureModes: input.failureModes,
    nextMutationAllowed: 'retry_after_pit_fix' as const,
    paperEvidenceRequirement: {
      minLiveOnlyDays: 14,
      minDecisionCount: 30,
      minExecutedTradeCount: 10,
      minEventCount: 0,
      maxReportAgeSeconds: 900,
    },
  }
}

function runValidationPipeline(args: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      './node_modules/.bin/tsx',
      ['scripts/run_validation_pipeline.ts', ...args],
      {
        cwd: resolve('.'),
        stdio: 'ignore',
      },
    )

    child.on('close', (code) => {
      if (code == null) {
        reject(new Error('run_validation_pipeline exited without a code'))
        return
      }
      resolvePromise(code)
    })
    child.on('error', reject)
  })
}

async function writeSyntheticMarketCsv(
  root: string,
  filename = 'market.csv',
  options: { priceOffset?: number; phaseShift?: number } = {},
): Promise<string> {
  const path = join(root, filename)
  const rows = ['timestamp,open,high,low,close,volume']
  const priceOffset = options.priceOffset ?? 0
  const phaseShift = options.phaseShift ?? 0
  let previousClose = 10_000 + priceOffset
  for (let index = 0; index < 1_600; index += 1) {
    const timestamp = 1_700_000_000 + index * 3_600
    const cycle = Math.sin(index / 18 + phaseShift) * 220
    const slowerCycle = Math.sin(index / 95 + phaseShift / 2) * 480
    const drift = index * (0.9 + phaseShift * 0.05)
    const shock = index % 360 > 310 ? -260 + (index % 360 - 310) * 8 : 0
    const close = 10_000 + priceOffset + drift + cycle + slowerCycle + shock
    const open = previousClose
    const high = Math.max(open, close) + 35 + (index % 7)
    const low = Math.min(open, close) - 35 - (index % 5)
    const volume = 1_000 + (index % 48) * 12 + Math.abs(cycle)
    rows.push([
      timestamp,
      open.toFixed(4),
      high.toFixed(4),
      low.toFixed(4),
      close.toFixed(4),
      volume.toFixed(4),
    ].join(','))
    previousClose = close
  }
  await writeFile(path, `${rows.join('\n')}\n`, 'utf-8')
  return path
}

describe('run_validation_pipeline', () => {
  it('passes promotion-grade PIT audit only when every required feature is available before decision time', () => {
    const strategyFamilyContract = makePitAuditContract({
      requiredFeatures: [
        {
          featureId: 'spread_bps',
          required: true,
          availableTimePolicy: 'available_time <= decision_time',
          qualityStatusesAllowed: ['ok'],
        },
        {
          featureId: 'liquidity_usd',
          required: true,
          availableTimePolicy: 'available_time <= decision_time',
          qualityStatusesAllowed: ['ok', 'degraded'],
        },
      ],
      failureModes: ['PIT_PROXY_ONLY'],
    })

    const audit = buildPromotionGradePitAudit({
      strategyFamilyContract,
      rows: [
        {
          rowId: 'decision-1',
          decisionTime: '2026-05-04T00:00:00.000Z',
          features: [
            {
              featureId: 'spread_bps',
              availableTime: '2026-05-03T23:59:59.900Z',
              qualityStatus: 'ok',
            },
            {
              featureId: 'liquidity_usd',
              availableTime: '2026-05-04T00:00:00.000Z',
              qualityStatus: 'degraded',
            },
          ],
        },
      ],
    })

    expect(audit).toMatchObject({
      status: 'pass',
      promotion_grade: true,
      promotion_grade_source_available: true,
      row_count: 1,
      required_feature_count: 2,
      checked_required_feature_count: 2,
      available_after_decision_count: 0,
      missing_required_feature_count: 0,
      quality_status_violation_count: 0,
      blocking_reasons: [],
    })
  })

  it('blocks promotion-grade PIT audit when a feature arrives after decision time', () => {
    const strategyFamilyContract = makePitAuditContract({
      requiredFeatures: [
        {
          featureId: 'spread_bps',
          required: true,
          availableTimePolicy: 'available_time <= decision_time',
          qualityStatusesAllowed: ['ok'],
        },
      ],
      failureModes: ['PIT_VIOLATION'],
    })

    const audit = buildPromotionGradePitAudit({
      strategyFamilyContract,
      rows: [
        {
          rowId: 'decision-1',
          decisionTime: '2026-05-04T00:00:00.000Z',
          features: [
            {
              featureId: 'spread_bps',
              availableTime: '2026-05-04T00:00:00.001Z',
              qualityStatus: 'ok',
            },
          ],
        },
      ],
    })

    expect(audit.status).toBe('fail')
    expect(audit.promotion_grade).toBe(false)
    expect(audit.available_after_decision_count).toBe(1)
    expect(audit.blocking_reasons).toContainEqual(expect.objectContaining({
      code: 'FEATURE_AVAILABLE_TIME_AFTER_DECISION_TIME',
      row_id: 'decision-1',
      feature_id: 'spread_bps',
    }))
  })

  it('keeps CSV-only feature availability audit blocked as proxy-only evidence', () => {
    const strategyFamilyContract = makePitAuditContract({
      requiredFeatures: [
        {
          featureId: 'spread_bps',
          required: true,
          availableTimePolicy: 'available_time <= decision_time',
          qualityStatusesAllowed: ['ok'],
        },
      ],
      failureModes: ['PIT_PROXY_ONLY'],
    })
    const audit = buildFeatureAvailabilityAudit({
      meta: {
        evidence_id: 'sha256:test',
        strategy_family: 'unit_pit_contract',
        candidate_id: 'candidate_test',
        created_at: '2026-05-04T00:00:00.000Z',
      },
      dataLineageGraph: {
        schemaVersion: DATA_LINEAGE_SCHEMA_VERSION,
        generatedAt: '2026-05-04T00:00:00.000Z',
        nodes: [
          {
            id: 'feature_node',
            type: 'feature',
            qualityStatus: 'ok',
            availableTimePolicy: 'available_time <= decision_time',
          },
        ],
      },
      strategyFamilyContract,
      holdoutCandles: [
        { time: 1_777_852_800, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { time: 1_777_856_400, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ],
    }) as {
      status: string
      row_level_proxy_audit: Record<string, unknown>
      promotion_grade_row_level_audit: Record<string, unknown>
      blocking_reasons: Array<{ code: string }>
    }

    expect(audit.status).toBe('blocked')
    expect(audit.row_level_proxy_audit).toMatchObject({
      proxy_status: 'pass',
      promotion_grade: false,
    })
    expect(audit.promotion_grade_row_level_audit).toMatchObject({
      status: 'not_available',
      promotion_grade: false,
      promotion_grade_source_available: false,
    })
    expect(audit.blocking_reasons.map((reason) => reason.code)).toContain('PIT_PROXY_ONLY')
  })

  it('leaves p-value null when explanatory FDR p-value is uncomputable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-validation-pipeline-fdr-failclosed-'))
    const inputCsv = await writeSyntheticMarketCsv(root)
    const outputPath = join(root, 'validation.json')
    const evidenceRoot = join(root, 'runtime', 'research')
    const trialRegistryPath = join(evidenceRoot, 'trial_registry.jsonl')

    const exitCode = await runValidationPipeline([
      '--inputCsv',
      inputCsv,
      '--symbol',
      'BTC/USD',
      '--strategy',
      'trend',
      '--lookbackBars',
      '1500',
      '--trainBars',
      '720',
      '--testBars',
      '240',
      '--stepBars',
      '240',
      '--riskSimulationCount',
      '100',
      '--candidatesJson',
      JSON.stringify([{ trendFastPeriod: 20, trendSlowPeriod: 50 }]),
      '--output',
      outputPath,
      '--evidenceOutputRoot',
      evidenceRoot,
      '--trialRegistryPath',
      trialRegistryPath,
    ])

    expect([0, 2]).toContain(exitCode)

    const report = JSON.parse(await readFile(outputPath, 'utf-8')) as {
      evidenceOsV4: {
        trialRegistryAppend: {
          appended: boolean
          reason: string
          trialId: string
        }
        completeTrialUniverseMarker: {
          appended: boolean
          reason: string
          trialId: string | null
        }
        artifactPaths: {
          fdrReport: string
          trialRecord: string
          trialRegistry: string
        }
      }
    }
    const fdrReport = JSON.parse(await readFile(report.evidenceOsV4.artifactPaths.fdrReport, 'utf-8')) as {
      status: string
      promotion_allowed: boolean
      p_values_available: boolean
      missing_p_value_count: number
      p_value: number | null
      p_value_method: string | null
      p_value_scope: string | null
      p_value_is_promotion_grade: boolean
      benchmark_candidate_index: number | null
      p_adjusted_by_raw_m: number | null
      p_adjusted_by_effective_m: number | null
      p_adjusted_bh_secondary: number | null
      blocking_reasons: Array<{ code: string; source: string; observed: string }>
    }
    const trialRecord = JSON.parse(await readFile(report.evidenceOsV4.artifactPaths.trialRecord, 'utf-8')) as {
      p_value: number | null
      promotion_eligible: boolean
      failure_codes: string[]
      metadata: Record<string, unknown>
    }
    const registryRow = JSON.parse((await readFile(report.evidenceOsV4.artifactPaths.trialRegistry, 'utf-8')).trim()) as {
      p_value: number | null
      promotion_eligible: boolean
      metadata: Record<string, unknown>
    }

    expect(fdrReport).toMatchObject({
      status: 'blocked_inputs_incomplete',
      promotion_allowed: false,
      p_values_available: false,
      missing_p_value_count: 1,
      p_value: null,
      p_value_method: null,
      p_value_scope: null,
      p_value_is_promotion_grade: false,
      benchmark_candidate_index: null,
      p_adjusted_by_raw_m: null,
      p_adjusted_by_effective_m: null,
      p_adjusted_bh_secondary: null,
    })
    expect(fdrReport.blocking_reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'FDR_INPUTS_INCOMPLETE',
        source: 'validation_runner',
        observed: 'need_at_least_two_candidate_return_series',
      }),
    ]))
    expect(trialRecord).toMatchObject({
      p_value: null,
      promotion_eligible: false,
      failure_codes: ['FDR_INPUTS_INCOMPLETE', 'PIT_PROXY_ONLY'],
    })
    expect(trialRecord.metadata).toMatchObject({
      p_value_source: 'missing',
      fdr_p_values_available: false,
      fdr_missing_p_value_count: 1,
      fdr_p_value_blocked_reason: 'need_at_least_two_candidate_return_series',
      fdr_p_value_method: null,
      fdr_p_value_scope: null,
      fdr_p_value_is_promotion_grade: false,
    })
    expect(registryRow).toMatchObject({
      p_value: null,
      promotion_eligible: false,
    })
    expect(registryRow.metadata).toMatchObject({
      fdr_p_values_available: false,
      fdr_missing_p_value_count: 1,
      fdr_p_value_blocked_reason: 'need_at_least_two_candidate_return_series',
      fdr_p_value_method: null,
      fdr_p_value_is_promotion_grade: false,
    })
    expect(report.evidenceOsV4.completeTrialUniverseMarker).toEqual({
      appended: false,
      reason: 'raw_m_complete_false',
      trialId: null,
    })
    expect(report.evidenceOsV4.trialRegistryAppend).toMatchObject({
      appended: true,
      reason: 'trial_record_appended',
    })
  }, 15_000)

  it('does not append to the runtime trial registry unless trialRegistryPath is explicit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-validation-pipeline-registry-opt-in-'))
    const inputCsv = await writeSyntheticMarketCsv(root)
    const outputPath = join(root, 'validation.json')
    const evidenceRoot = join(root, 'runtime', 'research')

    const exitCode = await runValidationPipeline([
      '--inputCsv',
      inputCsv,
      '--symbol',
      'BTC/USD',
      '--strategy',
      'trend',
      '--lookbackBars',
      '1500',
      '--trainBars',
      '720',
      '--testBars',
      '240',
      '--stepBars',
      '240',
      '--riskSimulationCount',
      '100',
      '--candidatesJson',
      JSON.stringify([{ trendFastPeriod: 20, trendSlowPeriod: 50 }]),
      '--output',
      outputPath,
      '--evidenceOutputRoot',
      evidenceRoot,
    ])

    expect([0, 2]).toContain(exitCode)

    const report = JSON.parse(await readFile(outputPath, 'utf-8')) as {
      evidenceOsV4: {
        artifactPaths: {
          trialRegistry: string | null
        }
        trialRegistryAppend: {
          appended: boolean
          reason: string
          trialId: string
        }
        completeTrialUniverseMarker: {
          appended: boolean
          reason: string
          trialId: string | null
        }
      }
    }

    expect(report.evidenceOsV4.artifactPaths.trialRegistry).toBeNull()
    expect(report.evidenceOsV4.trialRegistryAppend).toMatchObject({
      appended: false,
      reason: 'trial_registry_path_not_configured',
    })
    expect(report.evidenceOsV4.completeTrialUniverseMarker).toEqual({
      appended: false,
      reason: 'raw_m_complete_false',
      trialId: null,
    })
  }, 15_000)

  it('appends a complete trial-universe marker only when the ledger is complete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-validation-pipeline-trial-marker-'))
    const trialRegistryPath = join(root, 'trial_registry.jsonl')
    const significance = evaluateSignificanceGateForReport({
      candidateReturns: [
        [0.01, 0.02, 0.03, 0.01],
        [0.02, 0.01, 0.04, 0.02],
      ],
      selectedReturns: [0.02, 0.01, 0.04, 0.02],
      partitions: 2,
      trialCount: 5,
      trialLedger: buildTrialLedgerSummary({
        rawM: 5,
        effectiveM: 3,
        survivingTrialCount: 2,
        rawMComplete: true,
        includesFailedTrials: true,
      }),
    })

    const first = await appendCompleteTrialUniverseMarkerIfReady({
      significance,
      evidenceId: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      fdrFamily: 'test_family',
      batchId: 'batch_test',
      createdAt: '2026-05-04T00:00:00.000Z',
      trialRegistryPath,
    })
    const second = await appendCompleteTrialUniverseMarkerIfReady({
      significance,
      evidenceId: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      fdrFamily: 'test_family',
      batchId: 'batch_test',
      createdAt: '2026-05-04T00:00:00.000Z',
      trialRegistryPath,
    })

    const rows = (await readFile(trialRegistryPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row) as {
        trial_id: string
        trial_type: string
        strategy_family: string
        candidate_id: string
        included_in_fdr: boolean
        promotion_eligible: boolean
        metadata: Record<string, unknown>
      })

    expect(first).toMatchObject({
      appended: true,
      reason: 'complete_trial_universe_marker_appended',
    })
    expect(second).toMatchObject({
      appended: false,
      reason: 'complete_trial_universe_marker_already_exists',
      trialId: first.trialId,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      trial_id: first.trialId,
      trial_type: 'diagnostic_factor',
      strategy_family: 'trial_universe',
      candidate_id: 'complete_trial_universe',
      included_in_fdr: false,
      promotion_eligible: false,
    })
    expect(rows[0].metadata).toMatchObject({
      trial_universe_marker: true,
      trial_universe_marker_type: 'complete_trial_universe',
      raw_m_complete: true,
      includes_failed_trials: true,
      raw_m: 5,
      effective_m: 3,
      included_trial_count: 5,
      failed_trial_count: 3,
      surviving_trial_count: 2,
    })
  })

  it('reads explicit row-level PIT rows without using CSV proxy as promotion-grade evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-validation-pipeline-pit-rows-'))
    const inputCsv = await writeSyntheticMarketCsv(root)
    const outputPath = join(root, 'validation.json')
    const evidenceRoot = join(root, 'runtime', 'research')
    const pitRowsPath = join(root, 'pit_rows.json')
    await writeFile(pitRowsPath, JSON.stringify({
      rows: Array.from({ length: 240 }, (_, index) => ({
        row_id: `row-${index}`,
        decision_time: new Date((1_700_000_000 + (1_600 - 240 + index) * 3_600) * 1000).toISOString(),
        features: [
          {
            feature_id: 'trend_validation_features',
            available_time: new Date((1_700_000_000 + (1_600 - 240 + index) * 3_600) * 1000 - 1).toISOString(),
            quality_status: 'ok',
          },
        ],
      })),
    }), 'utf-8')

    const exitCode = await runValidationPipeline([
      '--inputCsv',
      inputCsv,
      '--symbol',
      'BTC/USD',
      '--strategy',
      'trend',
      '--lookbackBars',
      '1500',
      '--trainBars',
      '720',
      '--testBars',
      '240',
      '--stepBars',
      '240',
      '--riskSimulationCount',
      '100',
      '--candidatesJson',
      JSON.stringify([{ trendFastPeriod: 20, trendSlowPeriod: 50 }]),
      '--output',
      outputPath,
      '--evidenceOutputRoot',
      evidenceRoot,
      '--promotionGradePitRowsPath',
      pitRowsPath,
    ])

    expect([0, 2]).toContain(exitCode)

    const report = JSON.parse(await readFile(outputPath, 'utf-8')) as {
      evidenceOsV4: {
        failureCodes: string[]
        artifactPaths: {
          featureAvailabilityAudit: string
          validationResult: string
        }
      }
    }
    const featureAvailabilityAudit = JSON.parse(
      await readFile(report.evidenceOsV4.artifactPaths.featureAvailabilityAudit, 'utf-8'),
    ) as {
      status: string
      row_level_proxy_audit: Record<string, unknown>
      promotion_grade_row_level_audit: Record<string, unknown>
      blocking_reasons: Array<{ code: string }>
    }
    const validationResult = JSON.parse(
      await readFile(report.evidenceOsV4.artifactPaths.validationResult, 'utf-8'),
    ) as {
      verdict: string
      blocking_reasons: Array<{ code: string }>
    }

    expect(featureAvailabilityAudit.status).toBe('pass')
    expect(featureAvailabilityAudit.row_level_proxy_audit).toMatchObject({
      promotion_grade: false,
      proxy_type: 'csv_bar_event_time_as_decision_time',
    })
    expect(featureAvailabilityAudit.promotion_grade_row_level_audit).toMatchObject({
      status: 'pass',
      promotion_grade: true,
      promotion_grade_source_available: true,
      row_count: 240,
      available_after_decision_count: 0,
    })
    expect(featureAvailabilityAudit.blocking_reasons).toEqual([])
    expect(report.evidenceOsV4.failureCodes).toEqual(['FDR_INPUTS_INCOMPLETE'])
    expect(validationResult.verdict).toBe('blocked')
    expect(validationResult.blocking_reasons.map((reason) => reason.code)).toContain('FDR_INPUTS_INCOMPLETE')
  }, 15_000)

  it('emits additive regime-gate and meta-label quantile A/B outputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-validation-pipeline-'))
    const inputCsv = await writeSyntheticMarketCsv(root)
    const ethPeerCsv = await writeSyntheticMarketCsv(root, 'eth.csv', {
      priceOffset: -7_000,
      phaseShift: 0.15,
    })
    const outputPath = join(root, 'validation.json')
    const statusPath = join(root, 'release-gate-status.json')
    const missingAlphaPoolPath = join(root, 'missing-alpha-pool.json')
    const evidenceRoot = join(root, 'runtime', 'research')
    const trialRegistryPath = join(evidenceRoot, 'trial_registry.jsonl')

    const exitCode = await runValidationPipeline([
      '--inputCsv',
      inputCsv,
      '--symbol',
      'BTC/USD',
      '--strategy',
      'factorMeanReversion',
      '--peerCsvJson',
      JSON.stringify({ 'ETH/USD': ethPeerCsv }),
      '--lookbackBars',
      '1500',
      '--trainBars',
      '720',
      '--testBars',
      '240',
      '--stepBars',
      '240',
      '--riskSimulationCount',
      '100',
      '--output',
      outputPath,
      '--releaseGateStatusPath',
      statusPath,
      '--alphaPoolPath',
      missingAlphaPoolPath,
      '--evidenceOutputRoot',
      evidenceRoot,
      '--trialRegistryPath',
      trialRegistryPath,
    ])

    expect([0, 2]).toContain(exitCode)

    const report = JSON.parse(await readFile(outputPath, 'utf-8')) as {
      sampleSplit: {
        selection: { startTime: number | null; endTime: number | null; bars: number }
        holdout: { startTime: number | null; endTime: number | null; bars: number }
      }
      selectionLeakageCheck: {
        selectedOn: string
        evaluatedOn: string
        passed: boolean
        selectionBars: number
        holdoutBars: number
      }
      selectedParams: StrategyParams
      selectedMetrics: BacktestMetrics
      selectedInSampleMetrics: BacktestMetrics
      baselineReport: {
        expectancyAfterCost: { netExpectancyPct: number }
      }
      validationEvidence: {
        turnover: {
          available: boolean
          totalTurnoverUsd: number
          turnoverPctOfInitialCapital: number
          averageTurnoverPctPerTrade: number
          tradeCount: number
        }
        costAdjustedReturn: {
          available: boolean
          totalReturnPct: number
          grossExpectancyPct: number
          netExpectancyPct: number
          totalCostsPaid: number
          costDragPctOfInitialCapital: number
        }
        strategyPlanEvidence: {
          regimeIdentityTracking: {
            available: boolean
            runtimeHmmEnabled: boolean
            coldStartMode: string | null
            effectiveSampleSize: number
            latestRegime: null | {
              regime: string
              confidence: number
              method: string | null
              reasons: string[]
            }
            stateIdentity: null | {
              method: string
              rawStateName: string
              matchedStateName: string
              wassersteinDistance: number
              identityConfidence: number
              activeStateCount: number
            }
            reason: string | null
          }
          crossAssetRegimeConsistency: {
            available: boolean
            result: {
              consistent: boolean
              highConfidenceCount: number
              disagreementCount: number
              anchorDisagreement: boolean
              reasons: string[]
            }
            reason: string | null
          }
          alphaFactorAdmission: {
            available: boolean
            path: string
            totalCandidates: number
            admissionGatePassedCount: number
            admissionGateFailedCount: number
            runtimeAcceptedAdmissionGateFailedCount: number
            reason: string | null
          }
          rollingSharpeUniverseSelection: {
            available: boolean
            selection: {
              longSymbols: string[]
              shortSymbols: string[]
              scores: Array<{
                symbol: string
                sampleCount: number
                rollingSharpe: number | null
                longEligible: boolean
                shortEligible: boolean
              }>
            }
          }
          stableCorrelationClustering: {
            available: boolean
            clusters: Array<{
              clusterId: number
              symbols: string[]
              representative: string
            }>
            reason: string | null
          }
          sessionAwareSlippageEstimate: {
            available: boolean
            tradeCount: number
            baselineSlippageBps: number
            averageEstimatedSlippageBps: number
            maxEstimatedSlippageBps: number
            dominantSession: string | null
            bySession: Array<{
              session: string
              tradeCount: number
              averageEstimatedSlippageBps: number
              maxEstimatedSlippageBps: number
              handoffTradeCount: number
            }>
            reason: string | null
          }
        }
      }
      candidateMetrics: Array<{
        candidateIndex: number
        params: StrategyParams
        metrics: BacktestMetrics
        baselineReport: {
          expectancyAfterCost: { netExpectancyPct: number }
        }
      }>
      candidateHoldoutMetrics: Array<{
        candidateIndex: number
        params: StrategyParams
        metrics: BacktestMetrics
        baselineReport: {
          expectancyAfterCost: { netExpectancyPct: number }
        }
      }>
      canonicalScoreboard: {
        controlArm: {
          label: string
          source: string
          metrics: { netExpectancyPct: number; maxDrawdownPct: number; tradeCount: number }
          baselineReport: {
            expectancyAfterCost: { netExpectancyPct: number }
          }
        }
        selectedCandidate: {
          source: string
          selectionBasis: string
          candidateIndex: number
          params: StrategyParams
          metrics: { netExpectancyPct: number; maxDrawdownPct: number; tradeCount: number }
          baselineReport: {
            expectancyAfterCost: { netExpectancyPct: number }
          }
        }
        recommendation: {
          action: 'promote_candidate' | 'stay_on_baseline'
          targetSource: string
          targetArmId: string | null
          targetLabel: string
          fallbackToBaseline: boolean
          reasonCodes: string[]
          regimeCollapseWarnings: Array<{
            regime: string
            selectedCandidateCollapseCount: number
            selectedCandidateCount: number
            realizedTradeCount: number
            realizedSelectedCandidatePct: number
            isWeakestRegime: boolean
            warning: string
          }>
        }
        wfo: {
          overallPassed: boolean
          failedWindows: number
          windowCount: number
          failedWindowRatio: number
          windows: Array<{
            windowIndex: number
            selectedCandidate: string
            inSampleSharpe: number
            outOfSampleSharpe: number
            degradationRate: number
            gatePassed: boolean
            gateReason: string | null
          }>
        }
        significance: {
          passed: boolean
          pbo: number
          pboThreshold: number
          dsrValue: number
          dsrProbability: number
          dsrMin: number
        }
        risk: {
          method: string
          simulations: number
          horizonBars: number
          ruinDrawdownPct: number
          maxRuinProbability: number
          minProfitProbability: number
          confidenceLevel: number
          profitProbability: number
          riskOfRuin: number
          expectedFinalReturnPct: number
          medianFinalReturnPct: number
          confidenceInterval: {
            finalReturnPct: [number, number]
            maxDrawdownPct: [number, number]
          }
          gatePassed: boolean
        }
        releaseGate: {
          allowPaperTrading: boolean
          allowLiveTrading: boolean
          hardFail: boolean
          failedChecks: string[]
          warningChecks: string[]
          checks: Array<{
            name: string
            status: string
            summary: string
          }>
        }
      }
      deployableStrategyTarget: {
        controlArm: {
          label: string
          source: string
          description: string
          metrics: { netExpectancyPct: number; maxDrawdownPct: number }
          baselineReport: {
            expectancyAfterCost: { netExpectancyPct: number }
          }
        }
        optimizationTarget: {
          primaryMetric: string
          objective: string
          measurement: string
          requirePositiveDeltaVsControlArm: boolean
        }
        robustnessTarget: {
          releaseGate: {
            currentStatus: {
              allowPaperTrading: boolean
              allowLiveTrading: boolean
              failedChecks: string[]
              warningChecks: string[]
            }
            paperTrading: { requireAllowPaperTrading: boolean; blockingChecks: string[] }
            liveTrading: { requireAllowLiveTrading: boolean; blockingChecks: string[] }
          }
        }
        practicalConstraints: {
          drawdown: {
            requireNoWorseThanControlArm: boolean
            maxDrawdownPctControlArm: number
          }
          tradeCount: {
            regimeGateMinRetentionPct: number
            metaLabelMinRetentionPct: number
          }
        }
      }
      abExperiments: {
        regimeGate: {
          enabled: boolean
          bestArm: { armId: string; gate: { allowedEntryRegimes: string[] } } | null
        }
        metaLabel: {
          enabled: boolean
          baseLabel: string
          evaluatedArmCount: number
          qualifiedArmCount: number
          selectionConstraints: { selectionModes: string[] }
          arms: Array<{
            selection: {
              mode: string
              coveragePct: number
              selectedCandidateCount: number
              minScoreIncluded: number
              maxScoreIncluded: number
              byRegime: Array<{
                regime: string
                rawCandidateCount: number
                selectedCandidateCount: number
                realizedTradeCount: number
                selectedCoveragePct: number
                realizedSelectedCandidatePct: number
                selectedCandidateCollapseCount: number
              }>
            }
            diagnostics: {
              qualifies: boolean
              realizedTradeCount: number
              realizedSelectedCandidatePct: number
              selectedCandidateCollapseCount: number
            }
          }>
          bestArm: {
            selection: {
              mode: string
              coveragePct: number
              selectedCandidateCount: number
              minScoreIncluded: number
              maxScoreIncluded: number
              byRegime: Array<{
                regime: string
                rawCandidateCount: number
                selectedCandidateCount: number
                realizedTradeCount: number
                selectedCoveragePct: number
                realizedSelectedCandidatePct: number
                selectedCandidateCollapseCount: number
              }>
            }
            diagnostics: {
              qualifies: boolean
              realizedTradeCount: number
              realizedSelectedCandidatePct: number
              selectedCandidateCollapseCount: number
            }
          } | null
          quantileDiagnostics: {
            netReturnAfterCost: { buckets: Array<unknown> }
            tripleBarrierReturn: { buckets: Array<unknown> }
          }
        }
        metaLabelWithBestRegimeGate: {
          enabled: boolean
          reason?: string
          regimeGateSelection: {
            source: 'winner' | 'bestArm'
            gate: { allowedEntryRegimes: string[] }
            parentArmId: string | null
            parentArmQualified: boolean | null
            bootstrappedFromUnqualifiedBestArm: boolean
          } | null
          evaluatedArmCount: number
          qualifiedArmCount: number
          selectionConstraints: { selectionModes: string[] }
          arms: Array<{
            selection: {
              mode: string
              coveragePct: number
              selectedCandidateCount: number
              minScoreIncluded: number
              maxScoreIncluded: number
              byRegime: Array<{
                regime: string
                rawCandidateCount: number
                selectedCandidateCount: number
                realizedTradeCount: number
                selectedCoveragePct: number
                realizedSelectedCandidatePct: number
                selectedCandidateCollapseCount: number
              }>
            }
            diagnostics: {
              qualifies: boolean
              realizedTradeCount: number
              realizedSelectedCandidatePct: number
              selectedCandidateCollapseCount: number
            }
          }>
          bestArm: {
            selection: {
              mode: string
              coveragePct: number
              selectedCandidateCount: number
              minScoreIncluded: number
              maxScoreIncluded: number
              byRegime: Array<{
                regime: string
                rawCandidateCount: number
                selectedCandidateCount: number
                realizedTradeCount: number
                selectedCoveragePct: number
                realizedSelectedCandidatePct: number
                selectedCandidateCollapseCount: number
              }>
            }
            diagnostics: {
              qualifies: boolean
              realizedTradeCount: number
              realizedSelectedCandidatePct: number
              selectedCandidateCollapseCount: number
            }
          } | null
          quantileDiagnostics: {
            netReturnAfterCost: { buckets: Array<unknown> }
            tripleBarrierReturn: { buckets: Array<unknown> }
          }
        }
      }
      recommendedCandidate: {
        controlArm: {
          label: string
          source: string
        }
        candidatesBySource: {
          regimeGate: null | { source: string; armId: string }
          metaLabel: null | {
            source: string
            armId: string
            diagnostics: {
              qualifies: boolean
              tradeCountRetentionPct: number
              realizedTradeCount: number
              realizedSelectedCandidatePct: number
              selectedCandidateCollapseCount: number
            } | null
            selection: {
              mode: string
              coveragePct: number
              selectedCandidateCount: number
              minScoreIncluded: number
              maxScoreIncluded: number
              byRegime: Array<{
                regime: string
                rawCandidateCount: number
                selectedCandidateCount: number
                realizedTradeCount: number
                selectedCoveragePct: number
                realizedSelectedCandidatePct: number
                selectedCandidateCollapseCount: number
              }>
            } | null
          }
          metaLabelWithBestRegimeGate: null | {
            source: string
            armId: string
            diagnostics: {
              qualifies: boolean
              tradeCountRetentionPct: number
              realizedTradeCount: number
              realizedSelectedCandidatePct: number
              selectedCandidateCollapseCount: number
            } | null
            selection: {
              mode: string
              coveragePct: number
              selectedCandidateCount: number
              minScoreIncluded: number
              maxScoreIncluded: number
              byRegime: Array<{
                regime: string
                rawCandidateCount: number
                selectedCandidateCount: number
                realizedTradeCount: number
                selectedCoveragePct: number
                realizedSelectedCandidatePct: number
                selectedCandidateCollapseCount: number
              }>
            } | null
            regimeGateSelection: {
              source: 'winner' | 'bestArm'
              gate: { allowedEntryRegimes: string[] }
              parentArmId: string | null
              parentArmQualified: boolean | null
              bootstrappedFromUnqualifiedBestArm: boolean
            } | null
          }
        }
        candidateCount: number
        qualifiedCandidateCount: number
        champion: null | {
          source: string
          armId: string
          label: string
          diagnostics: {
            qualifies: boolean
            tradeCountRetentionPct: number
            realizedTradeCount: number
            realizedSelectedCandidatePct: number
            selectedCandidateCollapseCount: number
          } | null
          selection: {
            mode: string
            coveragePct: number
            selectedCandidateCount: number
            minScoreIncluded: number
            maxScoreIncluded: number
            byRegime: Array<{
              regime: string
              rawCandidateCount: number
              selectedCandidateCount: number
              realizedTradeCount: number
              selectedCoveragePct: number
              realizedSelectedCandidatePct: number
              selectedCandidateCollapseCount: number
            }>
          } | null
          regimeGateSelection: {
            source: 'winner' | 'bestArm'
            gate: { allowedEntryRegimes: string[] }
            parentArmId: string | null
            parentArmQualified: boolean | null
            bootstrappedFromUnqualifiedBestArm: boolean
          } | null
        }
        combinedWinnerEvidence: null | {
          champion: {
            source: string
            armId: string
            label: string
          }
          provenance: {
            parentRegimeGateSelectionSource: 'winner' | 'bestArm' | null
            parentRegimeGateArmId: string | null
            parentRegimeGateQualified: boolean | null
            bootstrappedFromUnqualifiedBestArm: boolean
          }
          summary: {
            beatsBothStandaloneArms: boolean
            beatsBothStandaloneArmsOnTotalReturn: boolean
            noWorseThanStandaloneArmsOnDrawdown: boolean
          }
          versusStandalone: {
            regimeGate: null | {
              comparator: { source: string; armId: string; label: string }
              delta: {
                netExpectancyPct: number
                totalReturnPct: number
                maxDrawdownPct: number
                tradeCount: number
                tradeCountRetentionPct: number
              }
              summary: {
                beatsOnNetExpectancy: boolean
                beatsOnTotalReturn: boolean
                noWorseDrawdown: boolean
                higherTradeCount: boolean
                higherTradeRetention: boolean
              }
            }
            metaLabel: null | {
              comparator: { source: string; armId: string; label: string }
              delta: {
                netExpectancyPct: number
                totalReturnPct: number
                maxDrawdownPct: number
                tradeCount: number
                tradeCountRetentionPct: number
              }
              summary: {
                beatsOnNetExpectancy: boolean
                beatsOnTotalReturn: boolean
                noWorseDrawdown: boolean
                higherTradeCount: boolean
                higherTradeRetention: boolean
              }
            }
          }
        }
        selectionDiagnosticsSummary: null | {
          source: string
          armId: string
          label: string
          mode: string | null
          coveragePct: number | null
          selectedCandidateCount: number
          realizedTradeCount: number
          realizedSelectedCandidatePct: number
          selectedCandidateCollapseCount: number
          weakestRegime: null | {
            regime: string
            rawCandidateCount: number
            selectedCandidateCount: number
            realizedTradeCount: number
            selectedCoveragePct: number
            realizedSelectedCandidatePct: number
            selectedCandidateCollapseCount: number
          }
          weakRegimes: Array<{
            regime: string
            rawCandidateCount: number
            selectedCandidateCount: number
            realizedTradeCount: number
            selectedCoveragePct: number
            realizedSelectedCandidatePct: number
            selectedCandidateCollapseCount: number
          }>
          byRegime: Array<{
            regime: string
            rawCandidateCount: number
            selectedCandidateCount: number
            realizedTradeCount: number
            selectedCoveragePct: number
            realizedSelectedCandidatePct: number
            selectedCandidateCollapseCount: number
          }>
        }
        releaseGateStatus: {
          allowPaperTrading: boolean
          allowLiveTrading: boolean
          failedChecks: string[]
          warningChecks: string[]
        }
        recommendation: {
          action: 'promote_candidate' | 'stay_on_baseline'
          targetSource: string
          targetArmId: string | null
          targetLabel: string
          fallbackToBaseline: boolean
          reasonCodes: string[]
          regimeCollapseWarnings: Array<{
            regime: string
            selectedCandidateCollapseCount: number
            selectedCandidateCount: number
            realizedTradeCount: number
            realizedSelectedCandidatePct: number
            isWeakestRegime: boolean
            warning: string
          }>
        }
        canonicalScoreboard: {
          controlArm: {
            label: string
            source: string
            metrics: { netExpectancyPct: number; maxDrawdownPct: number; tradeCount: number }
            baselineReport: {
              expectancyAfterCost: { netExpectancyPct: number }
            }
          }
          selectedCandidate: {
            source: string
            selectionBasis: string
            candidateIndex: number
            params: StrategyParams
            metrics: { netExpectancyPct: number; maxDrawdownPct: number; tradeCount: number }
            baselineReport: {
              expectancyAfterCost: { netExpectancyPct: number }
            }
          }
          recommendation: {
            action: 'promote_candidate' | 'stay_on_baseline'
            targetSource: string
            targetArmId: string | null
            targetLabel: string
            fallbackToBaseline: boolean
            reasonCodes: string[]
            regimeCollapseWarnings: Array<{
              regime: string
              selectedCandidateCollapseCount: number
              selectedCandidateCount: number
              realizedTradeCount: number
              realizedSelectedCandidatePct: number
              isWeakestRegime: boolean
              warning: string
            }>
          }
          wfo: {
            overallPassed: boolean
            failedWindows: number
            windowCount: number
            failedWindowRatio: number
            windows: Array<{
              windowIndex: number
              selectedCandidate: string
              inSampleSharpe: number
              outOfSampleSharpe: number
              degradationRate: number
              gatePassed: boolean
              gateReason: string | null
            }>
          }
          significance: {
            passed: boolean
            pbo: number
            pboThreshold: number
            dsrValue: number
            dsrProbability: number
            dsrMin: number
          }
          risk: {
            method: string
            simulations: number
            horizonBars: number
            ruinDrawdownPct: number
            maxRuinProbability: number
            minProfitProbability: number
            confidenceLevel: number
            profitProbability: number
            riskOfRuin: number
            expectedFinalReturnPct: number
            medianFinalReturnPct: number
            confidenceInterval: {
              finalReturnPct: [number, number]
              maxDrawdownPct: [number, number]
            }
            gatePassed: boolean
          }
          releaseGate: {
            allowPaperTrading: boolean
            allowLiveTrading: boolean
            hardFail: boolean
            failedChecks: string[]
            warningChecks: string[]
            checks: Array<{
              name: string
              status: string
              summary: string
            }>
          }
        }
      }
      releaseGate: {
        allowPaperTrading: boolean
        allowLiveTrading: boolean
        failedChecks: string[]
        warningChecks: string[]
        checks: Array<{
          name: string
          status: string
          metrics: Record<string, number | string | boolean | null>
        }>
      }
      evidenceOsV4: {
        version: string
        evidenceId: string
        evidenceKey: string
        artifactDir: string
        trialId: string
        strategyFamily: string
        candidateId: string
        verdict: string
        status: string
        promotionEligible: boolean
        dataLineageHash: string
        artifactPaths: {
          dataManifest: string
          dataLineage: string
          fdrReport: string
          validationResult: string
          trialRecord: string
          featureAvailabilityAudit: string
          promotionVerdictProvenance: string
          trialRegistry: string
        }
        failureCodes: string[]
      }
    }
    const status = JSON.parse(await readFile(statusPath, 'utf-8')) as {
      sourceReportPath: string
    }

    expect(report.selectionLeakageCheck).toEqual({
      selectedOn: 'selection',
      evaluatedOn: 'holdout',
      passed: true,
      selectionBars: report.sampleSplit.selection.bars,
      holdoutBars: report.sampleSplit.holdout.bars,
    })
    expect(report.sampleSplit.selection.bars).toBeGreaterThan(0)
    expect(report.sampleSplit.holdout.bars).toBeGreaterThan(0)
    expect(report.sampleSplit.selection.endTime).not.toBeNull()
    expect(report.sampleSplit.holdout.startTime).not.toBeNull()
    expect(report.sampleSplit.selection.endTime ?? 0).toBeLessThan(
      report.sampleSplit.holdout.startTime ?? 0,
    )

    expect(report.candidateMetrics.length).toBeGreaterThan(1)
    expect(report.candidateHoldoutMetrics).toHaveLength(report.candidateMetrics.length)
    const selectedCandidateIndex = report.canonicalScoreboard.selectedCandidate.candidateIndex
    const bestSelectionSharpeIndex = report.candidateMetrics.reduce(
      (bestIndex, candidate, index) =>
        candidate.metrics.sharpe > report.candidateMetrics[bestIndex]!.metrics.sharpe
          ? index
          : bestIndex,
      0,
    )
    expect(selectedCandidateIndex).toBe(bestSelectionSharpeIndex)
    expect(report.selectedParams).toEqual(report.candidateMetrics[selectedCandidateIndex]?.params)
    expect(report.selectedInSampleMetrics).toEqual(
      report.candidateMetrics[selectedCandidateIndex]?.metrics,
    )
    expect(report.selectedMetrics).toEqual(
      report.candidateHoldoutMetrics[selectedCandidateIndex]?.metrics,
    )
    expect(report.baselineReport).toEqual(
      report.candidateHoldoutMetrics[selectedCandidateIndex]?.baselineReport,
    )
    expect(report.validationEvidence.turnover.available).toBe(true)
    expect(report.validationEvidence.turnover.tradeCount).toBe(report.selectedMetrics.tradeCount)
    expect(report.validationEvidence.costAdjustedReturn.available).toBe(true)
    expect(report.validationEvidence.costAdjustedReturn.netExpectancyPct).toBe(
      report.selectedMetrics.netExpectancyPct,
    )
    expect(report.validationEvidence.strategyPlanEvidence.regimeIdentityTracking.effectiveSampleSize).toBeGreaterThan(
      0,
    )
    expect(report.validationEvidence.strategyPlanEvidence.regimeIdentityTracking.latestRegime).toBeTruthy()
    expect(
      report.validationEvidence.strategyPlanEvidence.crossAssetRegimeConsistency.available,
    ).toBe(true)
    expect(
      report.validationEvidence.strategyPlanEvidence.crossAssetRegimeConsistency.result.highConfidenceCount,
    ).toBeGreaterThanOrEqual(0)
    expect(report.validationEvidence.strategyPlanEvidence.alphaFactorAdmission.available).toBe(false)
    expect(report.validationEvidence.strategyPlanEvidence.alphaFactorAdmission.path).toBe(
      missingAlphaPoolPath,
    )
    expect(
      report.validationEvidence.strategyPlanEvidence.rollingSharpeUniverseSelection.available,
    ).toBe(true)
    expect(
      report.validationEvidence.strategyPlanEvidence.rollingSharpeUniverseSelection.selection.scores,
    ).toHaveLength(2)
    expect(
      report.validationEvidence.strategyPlanEvidence.rollingSharpeUniverseSelection.selection.scores
        .map((score) => score.symbol)
        .sort(),
    ).toEqual(['BTC/USD', 'ETH/USD'])
    expect(
      report.validationEvidence.strategyPlanEvidence.stableCorrelationClustering.available,
    ).toBe(true)
    expect(
      report.validationEvidence.strategyPlanEvidence.stableCorrelationClustering.clusters.some(
        (cluster) => cluster.symbols.includes('BTC/USD') && cluster.symbols.includes('ETH/USD'),
      ),
    ).toBe(true)
    expect(report.validationEvidence.strategyPlanEvidence.sessionAwareSlippageEstimate.bySession).toHaveLength(4)
    expect(
      report.validationEvidence.strategyPlanEvidence.sessionAwareSlippageEstimate.tradeCount,
    ).toBe(report.selectedMetrics.tradeCount)
    expect(
      report.validationEvidence.strategyPlanEvidence.sessionAwareSlippageEstimate.baselineSlippageBps,
    ).toBe(8)

    const strategyPlanEvidenceCheck = report.releaseGate.checks.find(
      (check) => check.name === 'strategy_plan_evidence',
    )
    expect(strategyPlanEvidenceCheck).toBeTruthy()
    expect(strategyPlanEvidenceCheck?.metrics.crossAssetAvailable).toBe(true)
    expect(strategyPlanEvidenceCheck?.metrics.alphaAdmissionAvailable).toBe(false)
    expect(report.releaseGate.failedChecks).not.toContain('strategy_plan_evidence')

    const selectedHoldoutMetrics = report.candidateHoldoutMetrics[selectedCandidateIndex]!.metrics
    const economicsCheck = report.releaseGate.checks.find((check) => check.name === 'economics')
    expect(economicsCheck).toBeTruthy()
    expect(economicsCheck?.metrics.netExpectancyPct).toBe(selectedHoldoutMetrics.netExpectancyPct)
    expect(economicsCheck?.metrics.grossExpectancyPct).toBe(
      selectedHoldoutMetrics.grossExpectancyPct,
    )
    expect(economicsCheck?.metrics.tradeCount).toBe(selectedHoldoutMetrics.tradeCount)
    expect(economicsCheck?.metrics.costDragPctOfInitialCapital).toBe(
      selectedHoldoutMetrics.costDragPctOfInitialCapital,
    )

    expect(report.deployableStrategyTarget.controlArm.label).toBe('current_runtime_baseline')
    expect(report.deployableStrategyTarget.controlArm.source).toBe('selected_runtime_baseline')
    expect(
      report.deployableStrategyTarget.controlArm.baselineReport.expectancyAfterCost.netExpectancyPct,
    ).toBe(report.deployableStrategyTarget.controlArm.metrics.netExpectancyPct)
    expect(report.deployableStrategyTarget.optimizationTarget.primaryMetric).toBe('netExpectancyPct')
    expect(report.deployableStrategyTarget.optimizationTarget.requirePositiveDeltaVsControlArm).toBe(true)
    expect(
      report.deployableStrategyTarget.robustnessTarget.releaseGate.paperTrading.blockingChecks,
    ).toEqual(['wfo', 'significance', 'risk_simulation', 'economics'])
    expect(
      report.deployableStrategyTarget.robustnessTarget.releaseGate.liveTrading.blockingChecks,
    ).toEqual([
      'wfo',
      'significance',
      'risk_simulation',
      'economics',
      'execution_quality',
      'ramp_up',
      'regime_shift',
    ])
    expect(
      report.deployableStrategyTarget.robustnessTarget.releaseGate.paperTrading.requireAllowPaperTrading,
    ).toBe(true)
    expect(
      report.deployableStrategyTarget.robustnessTarget.releaseGate.liveTrading.requireAllowLiveTrading,
    ).toBe(true)
    expect(
      report.deployableStrategyTarget.practicalConstraints.drawdown.requireNoWorseThanControlArm,
    ).toBe(true)
    expect(
      report.deployableStrategyTarget.practicalConstraints.drawdown.maxDrawdownPctControlArm,
    ).toBe(report.deployableStrategyTarget.controlArm.metrics.maxDrawdownPct)
    expect(report.deployableStrategyTarget.practicalConstraints.tradeCount.regimeGateMinRetentionPct).toBe(30)
    expect(report.deployableStrategyTarget.practicalConstraints.tradeCount.metaLabelMinRetentionPct).toBe(5)

    expect(report.abExperiments.regimeGate.enabled).toBe(true)
    expect(report.abExperiments.regimeGate.bestArm?.gate.allowedEntryRegimes.length).toBeGreaterThan(0)

    expect(report.abExperiments.metaLabel.enabled).toBe(true)
    expect(report.abExperiments.metaLabel.baseLabel).toBe('baseline')
    expect(report.abExperiments.metaLabel.evaluatedArmCount).toBe(10)
    expect(report.abExperiments.metaLabel.qualifiedArmCount).toBe(0)
    expect(report.abExperiments.metaLabel.selectionConstraints.selectionModes).toEqual([
      'global',
      'perRegime',
    ])
    expect(report.abExperiments.metaLabel.arms).toHaveLength(10)
    expect(
      report.abExperiments.metaLabel.arms
        .map((arm) => `${arm.selection.mode}:${arm.selection.coveragePct}`)
        .sort(),
    ).toEqual([
      'global:10',
      'global:20',
      'global:30',
      'global:5',
      'global:50',
      'perRegime:10',
      'perRegime:20',
      'perRegime:30',
      'perRegime:5',
      'perRegime:50',
    ])
    expect(report.abExperiments.metaLabel.quantileDiagnostics.netReturnAfterCost.buckets).toHaveLength(5)
    expect(report.abExperiments.metaLabel.quantileDiagnostics.tripleBarrierReturn.buckets).toHaveLength(5)
    for (const arm of report.abExperiments.metaLabel.arms) {
      expect(arm.selection.byRegime).toHaveLength(4)
      expect(arm.selection.byRegime.reduce((sum, regime) => sum + regime.selectedCandidateCount, 0)).toBe(
        arm.selection.selectedCandidateCount,
      )
      expect(arm.selection.byRegime.reduce((sum, regime) => sum + regime.realizedTradeCount, 0)).toBe(
        arm.diagnostics.realizedTradeCount,
      )
      expect(
        arm.selection.byRegime.every((regime) => regime.selectedCandidateCount <= regime.rawCandidateCount),
      ).toBe(true)
      expect(
        arm.selection.byRegime.every((regime) => regime.realizedTradeCount <= regime.selectedCandidateCount),
      ).toBe(true)
      expect(
        arm.selection.byRegime.every((regime) => regime.selectedCoveragePct >= 0 && regime.selectedCoveragePct <= 100),
      ).toBe(true)
      expect(
        arm.selection.byRegime.every(
          (regime) =>
            regime.realizedSelectedCandidatePct >= 0 && regime.realizedSelectedCandidatePct <= 100,
        ),
      ).toBe(true)
      expect(
        arm.selection.byRegime.every(
          (regime) =>
            regime.selectedCandidateCollapseCount ===
            regime.selectedCandidateCount - regime.realizedTradeCount,
        ),
      ).toBe(true)
    }
    expect(report.abExperiments.metaLabel.bestArm?.selection.coveragePct).toBeGreaterThan(0)
    expect(report.abExperiments.metaLabel.bestArm?.selection.mode).toMatch(/^(global|perRegime)$/)
    expect(report.abExperiments.metaLabel.bestArm?.selection.maxScoreIncluded).toBeGreaterThanOrEqual(
      report.abExperiments.metaLabel.bestArm?.selection.minScoreIncluded ?? 0,
    )
    expect(report.abExperiments.metaLabel.bestArm?.diagnostics.realizedTradeCount).toBeLessThanOrEqual(
      report.abExperiments.metaLabel.bestArm?.selection.selectedCandidateCount ?? 0,
    )
    expect(report.abExperiments.metaLabel.bestArm?.selection.byRegime).toHaveLength(4)
    expect(
      report.abExperiments.metaLabel.bestArm?.selection.byRegime.reduce(
        (sum, regime) => sum + regime.selectedCandidateCount,
        0,
      ),
    ).toBe(report.abExperiments.metaLabel.bestArm?.selection.selectedCandidateCount)
    expect(
      report.abExperiments.metaLabel.bestArm?.selection.byRegime.reduce(
        (sum, regime) => sum + regime.realizedTradeCount,
        0,
      ),
    ).toBe(report.abExperiments.metaLabel.bestArm?.diagnostics.realizedTradeCount)
    expect(
      report.abExperiments.metaLabel.bestArm?.selection.byRegime.every(
        (regime) => regime.realizedTradeCount <= regime.selectedCandidateCount,
      ),
    ).toBe(true)
    expect(
      report.abExperiments.metaLabel.bestArm?.selection.byRegime.every(
        (regime) =>
          regime.selectedCandidateCollapseCount ===
          regime.selectedCandidateCount - regime.realizedTradeCount,
      ),
    ).toBe(true)
    expect(report.abExperiments.metaLabel.bestArm?.diagnostics.realizedSelectedCandidatePct).toBeLessThanOrEqual(100)
    expect(report.abExperiments.metaLabel.bestArm?.diagnostics.selectedCandidateCollapseCount).toBeGreaterThanOrEqual(0)
    const perRegimeArm = report.abExperiments.metaLabel.arms.find(
      (arm) => arm.selection.mode === 'perRegime' && arm.selection.coveragePct === 30,
    )
    expect(perRegimeArm?.selection.byRegime).toHaveLength(4)
    expect(
      perRegimeArm?.selection.byRegime.every(
        (bucket) =>
          bucket.selectedCandidateCount <= bucket.rawCandidateCount &&
          bucket.realizedTradeCount <= bucket.selectedCandidateCount &&
          bucket.selectedCandidateCollapseCount ===
            bucket.selectedCandidateCount - bucket.realizedTradeCount,
      ),
    ).toBe(true)

    if (!report.abExperiments.metaLabelWithBestRegimeGate.enabled) {
      expect(report.abExperiments.metaLabelWithBestRegimeGate.reason).toMatch(
        /needs at least 5 baseline trades|No regime gate arm available/,
      )
      return
    }

    expect(report.abExperiments.metaLabelWithBestRegimeGate.regimeGateSelection).toBeTruthy()
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.regimeGateSelection?.source,
    ).toMatch(/^(winner|bestArm)$/)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.regimeGateSelection?.gate.allowedEntryRegimes.length,
    ).toBeGreaterThan(0)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.regimeGateSelection?.parentArmId,
    ).toBe(report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateArmId ?? null)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.regimeGateSelection?.parentArmQualified,
    ).toBe(report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateQualified ?? null)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.regimeGateSelection?.bootstrappedFromUnqualifiedBestArm,
    ).toBe(false)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.regimeGateSelection?.parentArmQualified,
    ).toBe(true)
    expect(
      report.recommendedCandidate.champion?.regimeGateSelection?.parentArmId,
    ).toBe(report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateArmId ?? null)
    expect(
      report.recommendedCandidate.champion?.regimeGateSelection?.parentArmQualified,
    ).toBe(report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateQualified ?? null)
    expect(
      report.recommendedCandidate.champion?.regimeGateSelection?.bootstrappedFromUnqualifiedBestArm,
    ).toBe(false)
    expect(report.abExperiments.metaLabelWithBestRegimeGate.evaluatedArmCount).toBe(10)
    expect(report.abExperiments.metaLabelWithBestRegimeGate.qualifiedArmCount).toBeGreaterThan(0)
    expect(report.abExperiments.metaLabelWithBestRegimeGate.selectionConstraints.selectionModes).toEqual([
      'global',
      'perRegime',
    ])
    expect(report.abExperiments.metaLabelWithBestRegimeGate.arms).toHaveLength(10)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.arms
        .map((arm) => `${arm.selection.mode}:${arm.selection.coveragePct}`)
        .sort(),
    ).toEqual([
      'global:10',
      'global:20',
      'global:30',
      'global:5',
      'global:50',
      'perRegime:10',
      'perRegime:20',
      'perRegime:30',
      'perRegime:5',
      'perRegime:50',
    ])
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.quantileDiagnostics.netReturnAfterCost.buckets,
    ).toHaveLength(5)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.quantileDiagnostics.tripleBarrierReturn.buckets,
    ).toHaveLength(5)
    for (const arm of report.abExperiments.metaLabelWithBestRegimeGate.arms) {
      expect(arm.selection.byRegime).toHaveLength(4)
      expect(arm.selection.byRegime.reduce((sum, regime) => sum + regime.selectedCandidateCount, 0)).toBe(
        arm.selection.selectedCandidateCount,
      )
      expect(arm.selection.byRegime.reduce((sum, regime) => sum + regime.realizedTradeCount, 0)).toBe(
        arm.diagnostics.realizedTradeCount,
      )
      expect(
        arm.selection.byRegime.every((regime) => regime.selectedCandidateCount <= regime.rawCandidateCount),
      ).toBe(true)
      expect(
        arm.selection.byRegime.every((regime) => regime.realizedTradeCount <= regime.selectedCandidateCount),
      ).toBe(true)
      expect(
        arm.selection.byRegime.every(
          (regime) => regime.selectedCoveragePct >= 0 && regime.selectedCoveragePct <= 100,
        ),
      ).toBe(true)
      expect(
        arm.selection.byRegime.every(
          (regime) =>
            regime.realizedSelectedCandidatePct >= 0 && regime.realizedSelectedCandidatePct <= 100,
        ),
      ).toBe(true)
      expect(
        arm.selection.byRegime.every(
          (regime) =>
            regime.selectedCandidateCollapseCount ===
            regime.selectedCandidateCount - regime.realizedTradeCount,
        ),
      ).toBe(true)
    }
    expect(report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.coveragePct).toBeGreaterThan(0)
    expect(report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.mode).toMatch(
      /^(global|perRegime)$/,
    )
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.maxScoreIncluded,
    ).toBeGreaterThanOrEqual(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.minScoreIncluded ?? 0,
    )
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.diagnostics.realizedTradeCount,
    ).toBeLessThanOrEqual(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.selectedCandidateCount ?? 0,
    )
    expect(report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.byRegime).toHaveLength(4)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.byRegime.reduce(
        (sum, regime) => sum + regime.selectedCandidateCount,
        0,
      ),
    ).toBe(report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.selectedCandidateCount)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.byRegime.reduce(
        (sum, regime) => sum + regime.realizedTradeCount,
        0,
      ),
    ).toBe(report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.diagnostics.realizedTradeCount)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.byRegime.every(
        (regime) => regime.realizedTradeCount <= regime.selectedCandidateCount,
      ),
    ).toBe(true)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.byRegime.every(
        (regime) =>
          regime.selectedCandidateCollapseCount ===
          regime.selectedCandidateCount - regime.realizedTradeCount,
      ),
    ).toBe(true)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.diagnostics.realizedSelectedCandidatePct,
    ).toBeLessThanOrEqual(100)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.diagnostics.selectedCandidateCollapseCount,
    ).toBeGreaterThanOrEqual(0)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.byRegime,
    ).toHaveLength(4)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.byRegime.every(
        (bucket) =>
          bucket.selectedCandidateCount <= bucket.rawCandidateCount &&
          bucket.realizedTradeCount <= bucket.selectedCandidateCount &&
          bucket.selectedCandidateCollapseCount ===
            bucket.selectedCandidateCount - bucket.realizedTradeCount,
      ),
    ).toBe(true)
    expect(
      report.recommendedCandidate.champion?.selection?.byRegime,
    ).toHaveLength(4)

    const recommendedMetaLabel = report.recommendedCandidate.candidatesBySource.metaLabel
    const recommendedCombined = report.recommendedCandidate.candidatesBySource.metaLabelWithBestRegimeGate
    const combinedBestArm = report.abExperiments.metaLabelWithBestRegimeGate.bestArm
    const combinedRegimeGateSelection = report.abExperiments.metaLabelWithBestRegimeGate.regimeGateSelection

    expect(report.recommendedCandidate.controlArm.label).toBe('current_runtime_baseline')
    expect(report.recommendedCandidate.controlArm.source).toBe('selected_runtime_baseline')
    expect(report.recommendedCandidate.candidateCount).toBeGreaterThan(0)
    expect(report.recommendedCandidate.qualifiedCandidateCount).toBeGreaterThan(0)
    expect(report.recommendedCandidate.candidatesBySource.regimeGate?.source).toBe('regimeGate')
    expect(recommendedMetaLabel?.source).toBe('metaLabel')
    expect(recommendedMetaLabel?.diagnostics?.realizedTradeCount).toBeGreaterThan(0)
    expect(recommendedMetaLabel?.diagnostics?.realizedSelectedCandidatePct).toBeGreaterThan(0)
    expect(recommendedMetaLabel?.diagnostics?.selectedCandidateCollapseCount).toBeGreaterThanOrEqual(0)
    expect(recommendedMetaLabel?.selection?.byRegime).toHaveLength(4)
    expect(
      recommendedMetaLabel?.selection?.byRegime.reduce(
        (sum, regime) => sum + regime.realizedTradeCount,
        0,
      ),
    ).toBe(recommendedMetaLabel?.diagnostics?.realizedTradeCount)
    expect(
      recommendedMetaLabel?.selection?.byRegime.every(
        (regime) =>
          regime.selectedCandidateCollapseCount ===
          regime.selectedCandidateCount - regime.realizedTradeCount,
      ),
    ).toBe(true)
    expect(combinedBestArm).toBeTruthy()
    expect(combinedRegimeGateSelection).toBeTruthy()
    expect(recommendedCombined?.source).toBe('metaLabelWithBestRegimeGate')
    expect(recommendedCombined?.armId).toBe(combinedBestArm?.armId)
    expect(recommendedCombined?.selection?.mode).toBe(combinedBestArm?.selection.mode)
    expect(recommendedCombined?.selection?.coveragePct).toBe(combinedBestArm?.selection.coveragePct)
    expect(recommendedCombined?.selection?.selectedCandidateCount).toBe(
      combinedBestArm?.selection.selectedCandidateCount,
    )
    expect(recommendedCombined?.selection?.minScoreIncluded).toBe(
      combinedBestArm?.selection.minScoreIncluded,
    )
    expect(recommendedCombined?.selection?.maxScoreIncluded).toBe(
      combinedBestArm?.selection.maxScoreIncluded,
    )
    expect(recommendedCombined?.selection?.byRegime).toEqual(combinedBestArm?.selection.byRegime)
    expect(recommendedCombined?.diagnostics?.qualifies).toBe(combinedBestArm?.diagnostics.qualifies)
    expect(recommendedCombined?.diagnostics?.realizedTradeCount).toBe(
      combinedBestArm?.diagnostics.realizedTradeCount,
    )
    expect(recommendedCombined?.diagnostics?.realizedSelectedCandidatePct).toBe(
      combinedBestArm?.diagnostics.realizedSelectedCandidatePct,
    )
    expect(recommendedCombined?.diagnostics?.selectedCandidateCollapseCount).toBe(
      combinedBestArm?.diagnostics.selectedCandidateCollapseCount,
    )
    expect(recommendedCombined?.diagnostics?.tradeCountRetentionPct).toBeGreaterThan(0)
    expect(recommendedCombined?.selection?.byRegime).toHaveLength(4)
    expect(
      recommendedCombined?.selection?.byRegime.reduce(
        (sum, regime) => sum + regime.realizedTradeCount,
        0,
      ),
    ).toBe(recommendedCombined?.diagnostics?.realizedTradeCount)
    expect(recommendedCombined?.regimeGateSelection).toEqual(combinedRegimeGateSelection)
    expect(
      recommendedCombined?.selection?.byRegime.every(
        (regime) =>
          regime.selectedCandidateCollapseCount ===
          regime.selectedCandidateCount - regime.realizedTradeCount,
      ),
    ).toBe(true)
    expect(report.recommendedCandidate.champion).toBeTruthy()
    expect(report.recommendedCandidate.champion?.source).toBe('metaLabelWithBestRegimeGate')
    expect(report.recommendedCandidate.champion?.armId).toBe(recommendedCombined?.armId)
    expect(report.recommendedCandidate.champion?.armId).toMatch(
      /^meta_label_(global|perRegime)_top_\d+pct$/,
    )
    expect(report.recommendedCandidate.champion?.diagnostics).toEqual(recommendedCombined?.diagnostics ?? null)
    expect(report.recommendedCandidate.champion?.selection).toEqual(recommendedCombined?.selection ?? null)
    expect(report.recommendedCandidate.champion?.regimeGateSelection).toEqual(
      recommendedCombined?.regimeGateSelection ?? null,
    )
    expect(report.recommendedCandidate.champion?.diagnostics?.realizedTradeCount).toBe(10)
    expect(report.recommendedCandidate.champion?.diagnostics?.realizedSelectedCandidatePct).toBeGreaterThan(0)
    expect(report.recommendedCandidate.champion?.selection?.maxScoreIncluded).toBeGreaterThanOrEqual(
      report.recommendedCandidate.champion?.selection?.minScoreIncluded ?? 0,
    )
    expect(report.recommendedCandidate.champion?.selection?.coveragePct).toBeGreaterThan(0)
    expect(report.recommendedCandidate.champion?.selection?.mode).toBe('perRegime')
    expect(report.recommendedCandidate.champion?.selection?.byRegime).toHaveLength(4)
    expect(
      report.recommendedCandidate.champion?.selection?.byRegime.reduce(
        (sum, regime) => sum + regime.realizedTradeCount,
        0,
      ),
    ).toBe(report.recommendedCandidate.champion?.diagnostics?.realizedTradeCount)
    expect(report.recommendedCandidate.champion?.regimeGateSelection).toBeTruthy()
    expect(
      report.recommendedCandidate.champion?.regimeGateSelection?.source,
    ).toMatch(/^(winner|bestArm)$/)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.champion.source,
    ).toBe(recommendedCombined?.source)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.champion.armId,
    ).toBe(recommendedCombined?.armId)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateSelectionSource,
    ).toBe(combinedRegimeGateSelection?.source ?? null)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateArmId,
    ).toBe(combinedRegimeGateSelection?.parentArmId ?? null)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateQualified,
    ).toBe(combinedRegimeGateSelection?.parentArmQualified ?? null)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.provenance.bootstrappedFromUnqualifiedBestArm,
    ).toBe(combinedRegimeGateSelection?.bootstrappedFromUnqualifiedBestArm ?? false)
    expect(report.recommendedCandidate.combinedWinnerEvidence).toBeTruthy()
    expect(report.recommendedCandidate.combinedWinnerEvidence?.champion.source).toBe(
      'metaLabelWithBestRegimeGate',
    )
    expect(report.recommendedCandidate.combinedWinnerEvidence?.champion.armId).toBe(
      report.recommendedCandidate.champion?.armId,
    )
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateSelectionSource,
    ).toMatch(/^(winner|bestArm)$/)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateArmId,
    ).toBe(report.recommendedCandidate.candidatesBySource.regimeGate?.armId ?? null)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateQualified,
    ).toBe(true)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.provenance.bootstrappedFromUnqualifiedBestArm,
    ).toBe(false)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.summary.beatsBothStandaloneArms,
    ).toBe(true)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.summary
        .noWorseThanStandaloneArmsOnDrawdown,
    ).toBe(true)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.summary
        .beatsBothStandaloneArmsOnTotalReturn,
    ).toBe(false)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.versusStandalone.regimeGate?.comparator.source,
    ).toBe('regimeGate')
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.versusStandalone.regimeGate?.summary
        .beatsOnNetExpectancy,
    ).toBe(true)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.versusStandalone.regimeGate?.delta
        .netExpectancyPct,
    ).toBeGreaterThan(0)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.versusStandalone.metaLabel?.comparator.source,
    ).toBe('metaLabel')
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.versusStandalone.metaLabel?.summary
        .beatsOnNetExpectancy,
    ).toBe(true)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.versusStandalone.metaLabel?.delta
        .netExpectancyPct,
    ).toBeGreaterThan(0)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.versusStandalone.metaLabel?.summary
        .noWorseDrawdown,
    ).toBe(true)
    expect(report.recommendedCandidate.selectionDiagnosticsSummary).toBeTruthy()
    expect(report.recommendedCandidate.selectionDiagnosticsSummary?.armId).toBe(
      report.recommendedCandidate.champion?.armId,
    )
    expect(report.recommendedCandidate.selectionDiagnosticsSummary?.source).toBe(
      report.recommendedCandidate.champion?.source,
    )
    expect(report.recommendedCandidate.selectionDiagnosticsSummary?.mode).toBe(
      report.recommendedCandidate.champion?.selection?.mode ?? null,
    )
    expect(report.recommendedCandidate.selectionDiagnosticsSummary?.coveragePct).toBe(
      report.recommendedCandidate.champion?.selection?.coveragePct ?? null,
    )
    expect(report.recommendedCandidate.selectionDiagnosticsSummary?.realizedTradeCount).toBe(
      report.recommendedCandidate.champion?.diagnostics?.realizedTradeCount ?? 0,
    )
    expect(report.recommendedCandidate.selectionDiagnosticsSummary?.realizedSelectedCandidatePct).toBe(
      report.recommendedCandidate.champion?.diagnostics?.realizedSelectedCandidatePct ?? 0,
    )
    expect(report.recommendedCandidate.selectionDiagnosticsSummary?.selectedCandidateCollapseCount).toBe(
      report.recommendedCandidate.champion?.selection?.byRegime.reduce(
        (sum, regime) => sum + regime.selectedCandidateCollapseCount,
        0,
      ) ?? 0,
    )
    expect(report.recommendedCandidate.selectionDiagnosticsSummary?.byRegime).toHaveLength(4)
    expect(
      report.recommendedCandidate.selectionDiagnosticsSummary?.byRegime.reduce(
        (sum, regime) => sum + regime.realizedTradeCount,
        0,
      ),
    ).toBe(report.recommendedCandidate.selectionDiagnosticsSummary?.realizedTradeCount)
    expect(
      report.recommendedCandidate.selectionDiagnosticsSummary?.byRegime.reduce(
        (sum, regime) => sum + regime.selectedCandidateCount,
        0,
      ),
    ).toBe(report.recommendedCandidate.selectionDiagnosticsSummary?.selectedCandidateCount)
    expect(
      report.recommendedCandidate.selectionDiagnosticsSummary?.weakRegimes.every(
        (regime) => regime.selectedCandidateCollapseCount > 0,
      ),
    ).toBe(true)
    expect(
      report.recommendedCandidate.selectionDiagnosticsSummary?.weakestRegime?.selectedCandidateCollapseCount ?? 0,
    ).toBeGreaterThanOrEqual(0)
    expect(
      report.recommendedCandidate.selectionDiagnosticsSummary?.weakestRegime?.selectedCandidateCollapseCount,
    ).toBe(
      report.recommendedCandidate.selectionDiagnosticsSummary?.byRegime[0]?.selectedCandidateCollapseCount,
    )

    expect(report.recommendedCandidate.releaseGateStatus.allowLiveTrading).toBe(false)
    expect(report.recommendedCandidate.releaseGateStatus.warningChecks).toEqual([])
    expect(report.recommendedCandidate.recommendation.action).toBe('stay_on_baseline')
    expect(report.recommendedCandidate.recommendation.targetSource).toBe('baseline')
    expect(report.recommendedCandidate.recommendation.targetArmId).toBeNull()
    expect(report.recommendedCandidate.recommendation.targetLabel).toBe('current_runtime_baseline')
    expect(report.recommendedCandidate.recommendation.fallbackToBaseline).toBe(true)
    expect(report.recommendedCandidate.recommendation.reasonCodes).toContain('PAPER_RELEASE_GATE_BLOCKED')
    expect(report.recommendedCandidate.recommendation.reasonCodes).toContain('LIVE_RELEASE_GATE_BLOCKED')
    expect(report.recommendedCandidate.recommendation.reasonCodes).toContain('CHAMPION_LOW_TRADE_RETENTION')
    expect(report.recommendedCandidate.recommendation.regimeCollapseWarnings).toHaveLength(
      report.recommendedCandidate.selectionDiagnosticsSummary?.weakRegimes.length ?? 0,
    )
    expect(report.recommendedCandidate.recommendation.regimeCollapseWarnings[0]?.regime).toBe(
      report.recommendedCandidate.selectionDiagnosticsSummary?.weakestRegime?.regime,
    )
    expect(
      report.recommendedCandidate.recommendation.regimeCollapseWarnings[0]?.selectedCandidateCollapseCount,
    ).toBe(
      report.recommendedCandidate.selectionDiagnosticsSummary?.weakestRegime?.selectedCandidateCollapseCount,
    )
    expect(
      report.recommendedCandidate.recommendation.regimeCollapseWarnings.every(
        (warning) => warning.selectedCandidateCollapseCount > 0,
      ),
    ).toBe(true)
    expect(
      report.recommendedCandidate.recommendation.regimeCollapseWarnings.filter(
        (warning) => warning.isWeakestRegime,
      ),
    ).toHaveLength(report.recommendedCandidate.recommendation.regimeCollapseWarnings.length > 0 ? 1 : 0)

    expect(report.canonicalScoreboard.controlArm.label).toBe(
      report.deployableStrategyTarget.controlArm.label,
    )
    expect(report.canonicalScoreboard.controlArm.source).toBe(
      report.deployableStrategyTarget.controlArm.source,
    )
    expect(report.canonicalScoreboard.controlArm.metrics).toEqual(
      report.deployableStrategyTarget.controlArm.metrics,
    )
    expect(report.canonicalScoreboard.controlArm.baselineReport).toEqual(
      report.deployableStrategyTarget.controlArm.baselineReport,
    )
    expect(report.canonicalScoreboard.selectedCandidate.candidateIndex).toBeGreaterThanOrEqual(0)
    expect(report.canonicalScoreboard.selectedCandidate.params).toEqual(report.selectedParams)
    expect(report.canonicalScoreboard.selectedCandidate.metrics.netExpectancyPct).toBe(
      report.selectedMetrics.netExpectancyPct,
    )
    expect(report.canonicalScoreboard.selectedCandidate.metrics.maxDrawdownPct).toBe(
      report.selectedMetrics.maxDrawdownPct,
    )
    expect(report.canonicalScoreboard.selectedCandidate.metrics.tradeCount).toBe(
      report.selectedMetrics.tradeCount,
    )
    expect(report.canonicalScoreboard.selectedCandidate.baselineReport).toEqual(report.baselineReport)
    expect(report.canonicalScoreboard.recommendation).toEqual(
      report.recommendedCandidate.recommendation,
    )
    expect(report.canonicalScoreboard.wfo.overallPassed).toBe(report.wfo.overallPassed)
    expect(report.canonicalScoreboard.wfo.failedWindows).toBe(report.wfo.failedWindows)
    expect(report.canonicalScoreboard.wfo.windowCount).toBe(report.wfo.windows.length)
    expect(report.canonicalScoreboard.wfo.failedWindowRatio).toBeCloseTo(
      report.wfo.windows.length > 0 ? report.wfo.failedWindows / report.wfo.windows.length : 0,
    )
    expect(report.canonicalScoreboard.wfo.windows).toHaveLength(report.wfo.windows.length)
    expect(report.canonicalScoreboard.wfo.windows[0]?.selectedCandidate).toBe(
      report.wfo.windows[0]?.selectedCandidate,
    )
    expect(report.canonicalScoreboard.significance).toEqual({
      passed: report.significance.passed,
      pbo: report.significance.pbo,
      pboThreshold: 0.2,
      dsrValue: report.significance.dsrValue,
      dsrProbability: report.significance.dsrProbability,
      dsrMin: 0,
    })
    expect(report.canonicalScoreboard.risk.gatePassed).toBe(report.riskSimulation.gatePassed)
    expect(report.canonicalScoreboard.risk.profitProbability).toBe(report.riskSimulation.profitProbability)
    expect(report.canonicalScoreboard.risk.riskOfRuin).toBe(report.riskSimulation.riskOfRuin)
    expect(report.canonicalScoreboard.releaseGate.allowPaperTrading).toBe(
      report.releaseGate.allowPaperTrading,
    )
    expect(report.canonicalScoreboard.releaseGate.allowLiveTrading).toBe(
      report.releaseGate.allowLiveTrading,
    )
    expect(report.canonicalScoreboard.releaseGate.failedChecks).toEqual(
      report.releaseGate.failedChecks,
    )
    expect(report.canonicalScoreboard.releaseGate.warningChecks).toEqual(
      report.releaseGate.warningChecks,
    )
    expect(report.canonicalScoreboard.releaseGate.checks.map((check) => check.name)).toEqual(
      report.releaseGate.checks.map((check) => check.name),
    )

    expect(report.evidenceOsV4.version).toBe('v4.0')
    expect(report.evidenceOsV4.evidenceId).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(report.evidenceOsV4.evidenceKey).toMatch(/^[a-f0-9]{64}$/)
    expect(report.evidenceOsV4.artifactDir).not.toContain('sha256:')
    expect(report.evidenceOsV4.selectedCandidateIndex).toBe(
      report.canonicalScoreboard.selectedCandidate.candidateIndex,
    )
    expect(report.evidenceOsV4.verdict).toBe('blocked')
    expect(report.evidenceOsV4.status).toBe('blocked_fdr_inputs_incomplete')
    expect(report.evidenceOsV4.promotionEligible).toBe(false)
    expect(report.evidenceOsV4.failureCodes).toEqual([
      'FDR_INPUTS_INCOMPLETE',
      'PIT_PROXY_ONLY',
    ])
    expect(report.evidenceOsV4.strategyFamilyContract).toMatchObject({
      family_id: 'trend',
      role: 'research',
      promotion_eligibility: 'research_only',
      next_mutation_allowed: 'retry_after_new_hypothesis',
    })
    expect(report.evidenceOsV4.strategyFamilyContractValidation).toEqual({
      passed: true,
      blockingReasons: [],
    })
    const validationResult = JSON.parse(
      await readFile(report.evidenceOsV4.artifactPaths.validationResult, 'utf-8'),
    ) as {
      evidence_id: string
      data_lineage_hash: string
      strategy_family_contract: {
        family_id: string
        promotion_eligibility: string
      }
      strategy_family_contract_validation: {
        passed: boolean
        blocking_reasons: string[]
      }
      verdict: string
      blocking_reasons: Array<{ code: string }>
    }
    const fdrReport = JSON.parse(
      await readFile(report.evidenceOsV4.artifactPaths.fdrReport, 'utf-8'),
    ) as {
      evidence_id: string
      status: string
      promotion_allowed: boolean
      fdr_method_primary: string
      raw_m_complete: boolean
      includes_failed_trials: boolean
      p_values_available: boolean
      p_value: number | null
      p_value_method: string | null
      p_value_scope: string | null
      p_value_is_promotion_grade: boolean
      benchmark_candidate_index: number | null
      bootstrap_samples: number | null
      bootstrap_block_size: number | null
      bootstrap_block_size_set: number[]
      bootstrap_direction_stable: boolean | null
      p_value_block_sensitivity: Array<{
        block_size: number
        observed_mean_excess: number
        p_value: number
        passed: boolean
      }>
      observed_mean_excess: number | null
      p_adjusted_by_raw_m: number | null
      p_adjusted_by_effective_m: number | null
      p_adjusted_bh_secondary: number | null
      blocking_reasons: Array<{ code: string; source: string }>
    }
    const trialRecord = JSON.parse(
      await readFile(report.evidenceOsV4.artifactPaths.trialRecord, 'utf-8'),
    ) as {
      trial_id: string
      evidence_id: string
      status: string
      promotion_eligible: boolean
      p_value: number | null
      failure_codes: string[]
      metadata: Record<string, unknown>
    }
    const featureAvailabilityAudit = JSON.parse(
      await readFile(report.evidenceOsV4.artifactPaths.featureAvailabilityAudit, 'utf-8'),
    ) as {
      evidence_id: string
      data_lineage_hash: string
      status: string
      checks: Array<{ id: string; status: string }>
      blocking_reasons: Array<{ code: string }>
    }
    const promotionProvenance = JSON.parse(
      await readFile(report.evidenceOsV4.artifactPaths.promotionVerdictProvenance, 'utf-8'),
    ) as {
      verdict: string
      blocking_reasons: Array<{ code: string }>
      excluded_evidence_ids: Array<{ evidence_id: string; reason: string }>
    }
    const registryRows = (await readFile(report.evidenceOsV4.artifactPaths.trialRegistry, 'utf-8'))
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row) as { trial_id: string; evidence_id: string })
    const dataLineage = dataLineageGraphFromJson(
      JSON.parse(await readFile(report.evidenceOsV4.artifactPaths.dataLineage, 'utf-8')) as unknown,
    )
    const dataLineageValidation = validateDataLineageGraph(dataLineage)

    expect(validationResult.evidence_id).toBe(report.evidenceOsV4.evidenceId)
    expect(validationResult.data_lineage_hash).toBe(report.evidenceOsV4.dataLineageHash)
    expect(validationResult.strategy_family_contract).toMatchObject({
      family_id: 'trend',
      promotion_eligibility: 'research_only',
    })
    expect(validationResult.strategy_family_contract_validation).toEqual({
      passed: true,
      blocking_reasons: [],
    })
    expect(validationResult.verdict).toBe('blocked')
    expect(validationResult.blocking_reasons.map((reason) => reason.code)).toEqual([
      'FDR_INPUTS_INCOMPLETE',
      'PIT_PROXY_ONLY',
    ])
    expect(fdrReport).toMatchObject({
      evidence_id: report.evidenceOsV4.evidenceId,
      status: 'blocked_inputs_incomplete',
      promotion_allowed: false,
      fdr_method_primary: 'BY_raw_m',
      raw_m_complete: false,
      includes_failed_trials: false,
      p_values_available: true,
      p_value_is_promotion_grade: false,
      p_value_method: 'spa_like_moving_block_selected_vs_deterministic_holdout_benchmark_v1',
      p_value_scope: 'explanatory_selected_vs_holdout_benchmark',
    })
    expect(typeof fdrReport.p_value).toBe('number')
    expect(fdrReport.p_value).toBeGreaterThanOrEqual(0)
    expect(fdrReport.p_value).toBeLessThanOrEqual(1)
    expect(fdrReport.benchmark_candidate_index).not.toBeNull()
    expect(fdrReport.benchmark_candidate_index).not.toBe(report.evidenceOsV4.selectedCandidateIndex)
    expect(fdrReport.bootstrap_samples).toBe(400)
    expect(fdrReport.bootstrap_block_size).toBeGreaterThanOrEqual(2)
    expect(fdrReport.bootstrap_block_size_set.length).toBeGreaterThanOrEqual(2)
    expect(fdrReport.bootstrap_direction_stable).not.toBeNull()
    expect(fdrReport.p_value_block_sensitivity.length).toBeGreaterThanOrEqual(2)
    expect(fdrReport.observed_mean_excess).not.toBeNull()
    expect(typeof fdrReport.p_adjusted_by_raw_m).toBe('number')
    expect(typeof fdrReport.p_adjusted_by_effective_m).toBe('number')
    expect(typeof fdrReport.p_adjusted_bh_secondary).toBe('number')
    expect(fdrReport.blocking_reasons.map((reason) => reason.code)).toEqual([
      'FDR_INPUTS_INCOMPLETE',
      'FDR_INPUTS_INCOMPLETE',
    ])
    expect(trialRecord.trial_id).toBe(report.evidenceOsV4.trialId)
    expect(trialRecord.evidence_id).toBe(report.evidenceOsV4.evidenceId)
    expect(trialRecord.status).toBe('failed_validation')
    expect(trialRecord.promotion_eligible).toBe(false)
    expect(trialRecord.p_value).toBe(fdrReport.p_value)
    expect(trialRecord.failure_codes).toEqual([
      'FDR_INPUTS_INCOMPLETE',
      'PIT_PROXY_ONLY',
    ])
    expect(trialRecord.failure_codes).toEqual([
      ...new Set([
        ...fdrReport.blocking_reasons.map((reason) => reason.code),
        ...featureAvailabilityAudit.blocking_reasons.map((reason) => reason.code),
      ]),
    ])
    expect(trialRecord.metadata.p_value_source).toBe('fdr_report')
    expect(trialRecord.metadata.fdr_report_path_source).toBe('generated_artifact')
    expect(trialRecord.metadata.fdr_report_status).toBe('blocked_inputs_incomplete')
    expect(trialRecord.metadata.fdr_p_value_method).toBe(fdrReport.p_value_method)
    expect(trialRecord.metadata.fdr_p_value_is_promotion_grade).toBe(false)
    expect(trialRecord.metadata.fdr_p_value_promotion_grade_source).toBe('fdr_report')
    expect(trialRecord.metadata.feature_availability_audit_path).toBe(
      report.evidenceOsV4.artifactPaths.featureAvailabilityAudit,
    )
    expect(trialRecord.metadata.pit_audit_path).toBe(
      report.evidenceOsV4.artifactPaths.featureAvailabilityAudit,
    )
    expect(trialRecord.metadata.pit_audit_source).toBe('feature_availability_audit')
    expect(trialRecord.metadata.pit_audit_status).toBe('blocked')
    expect(trialRecord.metadata.pit_audit_promotion_grade).toBe(false)
    expect(trialRecord.metadata.pit_audit_promotion_grade_source).toBe('feature_availability_audit')
    expect(trialRecord.metadata.promotion_decision_source).toBe('fail_closed_validation_pipeline')
    expect(featureAvailabilityAudit.evidence_id).toBe(report.evidenceOsV4.evidenceId)
    expect(featureAvailabilityAudit.data_lineage_hash).toBe(report.evidenceOsV4.dataLineageHash)
    expect(featureAvailabilityAudit.status).toBe('blocked')
    expect(featureAvailabilityAudit.checks.length).toBeGreaterThan(0)
    expect(featureAvailabilityAudit.checks.map((check) => check.id)).toContain(
      'row_level_available_time_audit',
    )
    expect(featureAvailabilityAudit.row_level_proxy_audit).toMatchObject({
      proxy_status: 'pass',
      promotion_grade: false,
      proxy_type: 'csv_bar_event_time_as_decision_time',
      event_time_after_decision_time_count: 0,
    })
    expect(featureAvailabilityAudit.blocking_reasons.map((reason) => reason.code)).toContain(
      'PIT_PROXY_ONLY',
    )
    expect(dataLineage.schemaVersion).toBe(DATA_LINEAGE_SCHEMA_VERSION)
    expect(dataLineageValidation).toMatchObject({
      passed: true,
      hash: report.evidenceOsV4.dataLineageHash,
      blockingReasons: [],
    })
    expect(promotionProvenance.verdict).toBe('blocked')
    expect(promotionProvenance.blocking_reasons.map((reason) => reason.code)).toContain(
      'FDR_INPUTS_INCOMPLETE',
    )
    expect(promotionProvenance.excluded_evidence_ids[0]).toEqual({
      evidence_id: report.evidenceOsV4.evidenceId,
      reason: 'validation_artifact_blocked_fdr_inputs_incomplete',
      source: 'validation_runner',
    })
    expect(registryRows).toHaveLength(1)
    expect(registryRows[0]).toMatchObject({
      trial_id: report.evidenceOsV4.trialId,
      evidence_id: report.evidenceOsV4.evidenceId,
    })

    expect(status.sourceReportPath).toBe(outputPath)
  }, 15_000)

  it('accepts shockFade as a first-class validation strategy and emits additive sweeps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-validation-pipeline-shockfade-'))
    const inputCsv = await writeSyntheticMarketCsv(root)
    const outputPath = join(root, 'validation.json')
    const evidenceRoot = join(root, 'runtime', 'research')
    const trialRegistryPath = join(evidenceRoot, 'trial_registry.jsonl')

    const exitCode = await runValidationPipeline([
      '--inputCsv',
      inputCsv,
      '--symbol',
      'BTC/USD',
      '--strategy',
      'shockFade',
      '--lookbackBars',
      '1500',
      '--trainBars',
      '720',
      '--testBars',
      '240',
      '--stepBars',
      '240',
      '--riskSimulationCount',
      '100',
      '--output',
      outputPath,
      '--evidenceOutputRoot',
      evidenceRoot,
      '--trialRegistryPath',
      trialRegistryPath,
    ])

    expect([0, 2]).toContain(exitCode)

    const report = JSON.parse(await readFile(outputPath, 'utf-8')) as {
      input: { strategy: string }
      candidateMetrics: Array<unknown>
      abExperiments: {
        regimeGate: { enabled: boolean; reason?: string }
        metaLabel: { enabled: boolean; reason?: string }
        metaLabelWithBestRegimeGate: { enabled: boolean; reason?: string }
      }
    }

    expect(report.input.strategy).toBe('shockFade')
    expect(report.candidateMetrics).toHaveLength(3)
    expect(report.abExperiments.regimeGate.enabled).toBe(true)
    if (!report.abExperiments.metaLabel.enabled) {
      expect(report.abExperiments.metaLabel.reason).toMatch(/needs at least 5 baseline trades/)
    } else if (!report.abExperiments.metaLabelWithBestRegimeGate.enabled) {
      expect(report.abExperiments.metaLabelWithBestRegimeGate.reason).toMatch(
        /needs at least 5 baseline trades|No regime gate arm available/,
      )
    } else {
      expect(report.abExperiments.metaLabelWithBestRegimeGate.enabled).toBe(true)
    }
  }, 15_000)

  it('honors a fixed regimeGateJson and disables regime-gate sweep', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-validation-pipeline-fixed-gate-'))
    const inputCsv = await writeSyntheticMarketCsv(root)
    const outputPath = join(root, 'validation.json')
    const evidenceRoot = join(root, 'runtime', 'research')
    const trialRegistryPath = join(evidenceRoot, 'trial_registry.jsonl')

    const exitCode = await runValidationPipeline([
      '--inputCsv',
      inputCsv,
      '--symbol',
      'BTC/USD',
      '--strategy',
      'shockFade',
      '--lookbackBars',
      '1500',
      '--trainBars',
      '720',
      '--testBars',
      '240',
      '--stepBars',
      '240',
      '--riskSimulationCount',
      '100',
      '--regimeGateJson',
      JSON.stringify({
        allowedEntryRegimes: ['HighVolMeanRevert', 'LowVolCarry'],
        exitOnMismatch: true,
      }),
      '--output',
      outputPath,
      '--evidenceOutputRoot',
      evidenceRoot,
      '--trialRegistryPath',
      trialRegistryPath,
    ])

    expect([0, 2]).toContain(exitCode)

    const report = JSON.parse(await readFile(outputPath, 'utf-8')) as {
      configuredGates: {
        regimeGate: {
          allowedEntryRegimes: string[]
          exitOnMismatch?: boolean
        } | null
      }
      abExperiments: {
        regimeGate: { enabled: boolean; reason?: string }
      }
    }

    expect(report.configuredGates.regimeGate).toEqual({
      allowedEntryRegimes: ['HighVolMeanRevert', 'LowVolCarry'],
      exitOnMismatch: true,
    })
    expect(report.abExperiments.regimeGate.enabled).toBe(false)
    expect(report.abExperiments.regimeGate.reason).toContain('fixed regimeGateJson')
  }, 15_000)

  it('persists a fixed volatilityGateJson in configuredGates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-validation-pipeline-fixed-volatility-gate-'))
    const inputCsv = await writeSyntheticMarketCsv(root)
    const outputPath = join(root, 'validation.json')
    const evidenceRoot = join(root, 'runtime', 'research')
    const trialRegistryPath = join(evidenceRoot, 'trial_registry.jsonl')

    const exitCode = await runValidationPipeline([
      '--inputCsv',
      inputCsv,
      '--symbol',
      'BTC/USD',
      '--strategy',
      'shockFade',
      '--lookbackBars',
      '1500',
      '--trainBars',
      '720',
      '--testBars',
      '240',
      '--stepBars',
      '240',
      '--riskSimulationCount',
      '100',
      '--volatilityGateJson',
      JSON.stringify({
        minVolatilityPct: 1.1,
        maxTrendStrengthPct: 0.8,
        exitOnMismatch: false,
      }),
      '--output',
      outputPath,
      '--evidenceOutputRoot',
      evidenceRoot,
      '--trialRegistryPath',
      trialRegistryPath,
    ])

    expect([0, 2]).toContain(exitCode)

    const report = JSON.parse(await readFile(outputPath, 'utf-8')) as {
      configuredGates: {
        volatilityGate: {
          minVolatilityPct?: number
          maxTrendStrengthPct?: number
          exitOnMismatch?: boolean
        } | null
      }
    }

    expect(report.configuredGates.volatilityGate).toEqual({
      minVolatilityPct: 1.1,
      maxTrendStrengthPct: 0.8,
      exitOnMismatch: false,
    })
  }, 15_000)

  it('returns clear unsupported sweep reasons for non-additive strategies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-validation-pipeline-trend-'))
    const inputCsv = await writeSyntheticMarketCsv(root)
    const outputPath = join(root, 'validation.json')
    const evidenceRoot = join(root, 'runtime', 'research')
    const trialRegistryPath = join(evidenceRoot, 'trial_registry.jsonl')

    const exitCode = await runValidationPipeline([
      '--inputCsv',
      inputCsv,
      '--symbol',
      'BTC/USD',
      '--strategy',
      'trend',
      '--lookbackBars',
      '1500',
      '--trainBars',
      '720',
      '--testBars',
      '240',
      '--stepBars',
      '240',
      '--riskSimulationCount',
      '100',
      '--output',
      outputPath,
      '--evidenceOutputRoot',
      evidenceRoot,
      '--trialRegistryPath',
      trialRegistryPath,
    ])

    expect([0, 2]).toContain(exitCode)

    const report = JSON.parse(await readFile(outputPath, 'utf-8')) as {
      abExperiments: {
        regimeGate: { enabled: boolean; reason?: string }
        metaLabel: { enabled: boolean; reason?: string }
        metaLabelWithBestRegimeGate: { enabled: boolean; reason?: string }
      }
    }

    expect(report.abExperiments.regimeGate.enabled).toBe(false)
    expect(report.abExperiments.regimeGate.reason).toContain('factorMeanReversion, shockFade')
    expect(report.abExperiments.metaLabel.enabled).toBe(false)
    expect(report.abExperiments.metaLabel.reason).toContain('factorMeanReversion, shockFade')
    expect(report.abExperiments.metaLabelWithBestRegimeGate.enabled).toBe(false)
  }, 15_000)

  it('reports qualified regime-gate winner provenance for combined champion evidence', () => {
    const report = buildRecommendedCandidate({
      baselineMetrics: makeMetrics(),
      baselineReport: makeBaselineReport(),
      releaseGate: {
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
        checks: [],
      },
      abExperiments: {
        regimeGate: {
          enabled: true,
          winner: makeArm({
            armId: 'regime_gate_winner',
            metrics: makeMetrics({ netExpectancyPct: 0.6, tradeCount: 16 }),
            diagnostics: { qualifies: true, tradeCountRetentionPct: 80 },
            gate: { allowedEntryRegimes: ['HighVolTrend'] },
          }),
        },
        metaLabel: {
          enabled: true,
          winner: makeArm({
            armId: 'meta_label_global_top_50pct',
            metrics: makeMetrics({ netExpectancyPct: 0.5, tradeCount: 12 }),
            diagnostics: { qualifies: true, tradeCountRetentionPct: 60 },
            selection: { mode: 'global', coveragePct: 50 },
          }),
        },
        metaLabelWithBestRegimeGate: {
          enabled: true,
          winner: makeArm({
            armId: 'meta_label_perRegime_top_30pct',
            label: 'baseline_plus_best_regime_gate_plus_meta_label_perRegime_top_30pct',
            metrics: makeMetrics({ netExpectancyPct: 1.2, totalReturnPct: 3, tradeCount: 14 }),
            diagnostics: { qualifies: true, tradeCountRetentionPct: 70 },
            selection: { mode: 'perRegime', coveragePct: 30 },
          }),
          regimeGateSelection: {
            source: 'winner',
            gate: { allowedEntryRegimes: ['HighVolTrend'] },
            parentArmId: 'regime_gate_winner',
            parentArmQualified: true,
            bootstrappedFromUnqualifiedBestArm: false,
          },
        },
      },
    })

    expect(report.champion?.source).toBe('metaLabelWithBestRegimeGate')
    expect(report.champion?.regimeGateSelection?.source).toBe('winner')
    expect(report.champion?.regimeGateSelection?.parentArmId).toBe('regime_gate_winner')
    expect(report.champion?.regimeGateSelection?.parentArmQualified).toBe(true)
    expect(report.champion?.regimeGateSelection?.bootstrappedFromUnqualifiedBestArm).toBe(false)
    expect(report.combinedWinnerEvidence?.provenance.parentRegimeGateSelectionSource).toBe('winner')
    expect(report.combinedWinnerEvidence?.provenance.parentRegimeGateArmId).toBe('regime_gate_winner')
    expect(report.combinedWinnerEvidence?.provenance.parentRegimeGateQualified).toBe(true)
    expect(report.combinedWinnerEvidence?.provenance.bootstrappedFromUnqualifiedBestArm).toBe(false)
    expect(report.selectionDiagnosticsSummary).toBeNull()
  })

  it('reports unqualified bestArm fallback provenance for combined champion evidence', () => {
    const report = buildRecommendedCandidate({
      baselineMetrics: makeMetrics(),
      baselineReport: makeBaselineReport(),
      releaseGate: {
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
        checks: [],
      },
      abExperiments: {
        regimeGate: {
          enabled: true,
          winner: null,
          bestArm: makeArm({
            armId: 'regime_gate_fallback',
            metrics: makeMetrics({ netExpectancyPct: 0.4, tradeCount: 12 }),
            diagnostics: { qualifies: false, tradeCountRetentionPct: 60 },
            gate: { allowedEntryRegimes: ['HighVolTrend'] },
          }),
        },
        metaLabel: {
          enabled: true,
          winner: makeArm({
            armId: 'meta_label_global_top_50pct',
            metrics: makeMetrics({ netExpectancyPct: 0.5, tradeCount: 12 }),
            diagnostics: { qualifies: true, tradeCountRetentionPct: 60 },
            selection: { mode: 'global', coveragePct: 50 },
          }),
        },
        metaLabelWithBestRegimeGate: {
          enabled: true,
          winner: makeArm({
            armId: 'meta_label_perRegime_top_30pct',
            label: 'baseline_plus_best_regime_gate_plus_meta_label_perRegime_top_30pct',
            metrics: makeMetrics({ netExpectancyPct: 1.2, totalReturnPct: 3, tradeCount: 14 }),
            diagnostics: { qualifies: true, tradeCountRetentionPct: 70 },
            selection: { mode: 'perRegime', coveragePct: 30 },
          }),
          regimeGateSelection: {
            source: 'bestArm',
            gate: { allowedEntryRegimes: ['HighVolTrend'] },
            parentArmId: 'regime_gate_fallback',
            parentArmQualified: false,
            bootstrappedFromUnqualifiedBestArm: true,
          },
        },
      },
    })

    expect(report.champion?.source).toBe('metaLabelWithBestRegimeGate')
    expect(report.champion?.regimeGateSelection?.source).toBe('bestArm')
    expect(report.champion?.regimeGateSelection?.parentArmId).toBe('regime_gate_fallback')
    expect(report.champion?.regimeGateSelection?.parentArmQualified).toBe(false)
    expect(report.champion?.regimeGateSelection?.bootstrappedFromUnqualifiedBestArm).toBe(true)
    expect(report.combinedWinnerEvidence?.provenance.parentRegimeGateSelectionSource).toBe('bestArm')
    expect(report.combinedWinnerEvidence?.provenance.parentRegimeGateArmId).toBe('regime_gate_fallback')
    expect(report.combinedWinnerEvidence?.provenance.parentRegimeGateQualified).toBe(false)
    expect(report.combinedWinnerEvidence?.provenance.bootstrappedFromUnqualifiedBestArm).toBe(true)
    expect(report.selectionDiagnosticsSummary).toBeNull()
    expect(report.recommendation.regimeCollapseWarnings).toEqual([])
  })

  it('derives and sorts selection diagnostics summary deterministically', () => {
    const report = buildRecommendedCandidate({
      baselineMetrics: makeMetrics(),
      baselineReport: makeBaselineReport(),
      releaseGate: {
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: ['regime_shift_watch'],
        checks: [],
      },
      abExperiments: {
        regimeGate: {
          enabled: true,
          winner: makeArm({
            armId: 'regime_gate_winner',
            metrics: makeMetrics({ netExpectancyPct: 0.6, tradeCount: 16 }),
            diagnostics: { qualifies: true, tradeCountRetentionPct: 80 },
            gate: { allowedEntryRegimes: ['HighVolTrend'] },
          }),
        },
        metaLabel: {
          enabled: true,
          winner: makeArm({
            armId: 'meta_label_global_top_50pct',
            metrics: makeMetrics({ netExpectancyPct: 0.5, tradeCount: 12 }),
            diagnostics: { qualifies: true, tradeCountRetentionPct: 60 },
            selection: { mode: 'global', coveragePct: 50 },
          }),
        },
        metaLabelWithBestRegimeGate: {
          enabled: true,
          winner: makeArm({
            armId: 'meta_label_perRegime_top_30pct',
            label: 'baseline_plus_best_regime_gate_plus_meta_label_perRegime_top_30pct',
            metrics: makeMetrics({ netExpectancyPct: 1.2, totalReturnPct: 3, tradeCount: 14 }),
            diagnostics: {
              qualifies: true,
              tradeCountRetentionPct: 70,
              realizedTradeCount: 9,
              realizedSelectedCandidatePct: 75,
              selectedCandidateCollapseCount: 3,
            },
            selection: {
              mode: 'perRegime',
              coveragePct: 30,
              selectedCandidateCount: 12,
              byRegime: [
                {
                  regime: 'LowVolTrend',
                  rawCandidateCount: 5,
                  selectedCandidateCount: 3,
                  realizedTradeCount: 2,
                  selectedCoveragePct: 60,
                  realizedSelectedCandidatePct: 66.67,
                  selectedCandidateCollapseCount: 1,
                },
                {
                  regime: 'HighVolChop',
                  rawCandidateCount: 4,
                  selectedCandidateCount: 2,
                  realizedTradeCount: 2,
                  selectedCoveragePct: 50,
                  realizedSelectedCandidatePct: 100,
                  selectedCandidateCollapseCount: 0,
                },
                {
                  regime: 'HighVolTrend',
                  rawCandidateCount: 6,
                  selectedCandidateCount: 4,
                  realizedTradeCount: 2,
                  selectedCoveragePct: 66.67,
                  realizedSelectedCandidatePct: 50,
                },
                {
                  regime: 'LowVolChop',
                  rawCandidateCount: 3,
                  selectedCandidateCount: 3,
                  realizedTradeCount: 3,
                  selectedCoveragePct: 100,
                  realizedSelectedCandidatePct: 100,
                  selectedCandidateCollapseCount: 0,
                },
              ],
            },
          }),
          regimeGateSelection: {
            source: 'winner',
            gate: { allowedEntryRegimes: ['HighVolTrend'] },
            parentArmId: 'regime_gate_winner',
            parentArmQualified: true,
            bootstrappedFromUnqualifiedBestArm: false,
          },
        },
      },
    })

    expect(report.releaseGateStatus.warningChecks).toEqual(['regime_shift_watch'])
    expect(report.champion?.source).toBe('metaLabelWithBestRegimeGate')
    expect(report.champion?.armId).toBe(report.candidatesBySource.metaLabelWithBestRegimeGate?.armId)
    expect(report.champion?.label).toBe(report.candidatesBySource.metaLabelWithBestRegimeGate?.label)
    expect(report.champion?.diagnostics).toEqual(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.diagnostics,
    )
    expect(report.champion?.selection).toEqual(report.candidatesBySource.metaLabelWithBestRegimeGate?.selection)
    expect(report.champion?.regimeGateSelection).toEqual(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.regimeGateSelection,
    )
    expect(report.combinedWinnerEvidence?.champion).toEqual({
      source: report.candidatesBySource.metaLabelWithBestRegimeGate?.source,
      armId: report.candidatesBySource.metaLabelWithBestRegimeGate?.armId,
      label: report.candidatesBySource.metaLabelWithBestRegimeGate?.label,
    })
    expect(report.combinedWinnerEvidence?.provenance.parentRegimeGateSelectionSource).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.regimeGateSelection?.source ?? null,
    )
    expect(report.combinedWinnerEvidence?.provenance.parentRegimeGateArmId).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.regimeGateSelection?.parentArmId ?? null,
    )
    expect(report.combinedWinnerEvidence?.provenance.parentRegimeGateQualified).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.regimeGateSelection?.parentArmQualified ?? null,
    )
    expect(report.combinedWinnerEvidence?.provenance.bootstrappedFromUnqualifiedBestArm).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.regimeGateSelection
        ?.bootstrappedFromUnqualifiedBestArm ?? false,
    )
    expect(report.selectionDiagnosticsSummary?.source).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.source,
    )
    expect(report.selectionDiagnosticsSummary?.armId).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.armId,
    )
    expect(report.selectionDiagnosticsSummary?.label).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.label,
    )
    expect(report.selectionDiagnosticsSummary?.mode).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.selection?.mode ?? null,
    )
    expect(report.selectionDiagnosticsSummary?.coveragePct).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.selection?.coveragePct ?? null,
    )
    expect(report.selectionDiagnosticsSummary?.selectedCandidateCount).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.selection?.selectedCandidateCount ?? 0,
    )
    expect(report.selectionDiagnosticsSummary?.realizedTradeCount).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.diagnostics?.realizedTradeCount ?? 0,
    )
    expect(report.selectionDiagnosticsSummary?.realizedSelectedCandidatePct).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.diagnostics?.realizedSelectedCandidatePct ?? 0,
    )
    expect(report.selectionDiagnosticsSummary?.selectedCandidateCollapseCount).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.diagnostics?.selectedCandidateCollapseCount ?? 0,
    )
    expect(report.selectionDiagnosticsSummary?.realizedSelectedCandidatePct).toBe(75)
    expect(report.selectionDiagnosticsSummary?.selectedCandidateCount).toBe(12)
    expect(report.selectionDiagnosticsSummary?.selectedCandidateCollapseCount).toBe(3)
    expect(report.selectionDiagnosticsSummary?.byRegime.map((regime) => regime.regime)).toEqual([
      'HighVolTrend',
      'LowVolTrend',
      'LowVolChop',
      'HighVolChop',
    ])
    expect(report.selectionDiagnosticsSummary?.byRegime[0]).toEqual({
      regime: 'HighVolTrend',
      rawCandidateCount: 6,
      selectedCandidateCount: 4,
      realizedTradeCount: 2,
      selectedCoveragePct: 66.67,
      realizedSelectedCandidatePct: 50,
      selectedCandidateCollapseCount: 2,
    })
    expect(report.selectionDiagnosticsSummary?.weakestRegime).toEqual(
      report.selectionDiagnosticsSummary?.byRegime[0],
    )
    expect(report.selectionDiagnosticsSummary?.weakRegimes).toEqual([
      {
        regime: 'HighVolTrend',
        rawCandidateCount: 6,
        selectedCandidateCount: 4,
        realizedTradeCount: 2,
        selectedCoveragePct: 66.67,
        realizedSelectedCandidatePct: 50,
        selectedCandidateCollapseCount: 2,
      },
      {
        regime: 'LowVolTrend',
        rawCandidateCount: 5,
        selectedCandidateCount: 3,
        realizedTradeCount: 2,
        selectedCoveragePct: 60,
        realizedSelectedCandidatePct: 66.67,
        selectedCandidateCollapseCount: 1,
      },
    ])
    expect(report.recommendation.regimeCollapseWarnings).toEqual([
      {
        regime: 'HighVolTrend',
        selectedCandidateCollapseCount: 2,
        selectedCandidateCount: 4,
        realizedTradeCount: 2,
        realizedSelectedCandidatePct: 50,
        isWeakestRegime: true,
        warning: 'Selection collapsed 2 of 4 candidates in HighVolTrend.',
      },
      {
        regime: 'LowVolTrend',
        selectedCandidateCollapseCount: 1,
        selectedCandidateCount: 3,
        realizedTradeCount: 2,
        realizedSelectedCandidatePct: 66.67,
        isWeakestRegime: false,
        warning: 'Selection collapsed 1 of 3 candidates in LowVolTrend.',
      },
    ])
  })

  it('surfaces recommendation regime collapse warnings from weak regimes', () => {
    const report = buildRecommendedCandidate({
      baselineMetrics: makeMetrics(),
      baselineReport: makeBaselineReport(),
      releaseGate: {
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
        checks: [],
      },
      abExperiments: {
        regimeGate: {
          enabled: true,
          winner: makeArm({
            armId: 'regime_gate_winner',
            metrics: makeMetrics({ netExpectancyPct: 0.6, tradeCount: 16 }),
            diagnostics: { qualifies: true, tradeCountRetentionPct: 80 },
            gate: { allowedEntryRegimes: ['HighVolTrend'] },
          }),
        },
        metaLabel: {
          enabled: true,
          winner: makeArm({
            armId: 'meta_label_global_top_50pct',
            metrics: makeMetrics({ netExpectancyPct: 0.5, tradeCount: 12 }),
            diagnostics: { qualifies: true, tradeCountRetentionPct: 60 },
            selection: { mode: 'global', coveragePct: 50 },
          }),
        },
        metaLabelWithBestRegimeGate: {
          enabled: true,
          winner: makeArm({
            armId: 'meta_label_perRegime_top_30pct',
            label: 'baseline_plus_best_regime_gate_plus_meta_label_perRegime_top_30pct',
            metrics: makeMetrics({ netExpectancyPct: 1.2, totalReturnPct: 3, tradeCount: 14 }),
            diagnostics: {
              qualifies: true,
              tradeCountRetentionPct: 70,
              realizedTradeCount: 7,
              realizedSelectedCandidatePct: 70,
              selectedCandidateCollapseCount: 3,
            },
            selection: {
              mode: 'perRegime',
              coveragePct: 30,
              selectedCandidateCount: 10,
              byRegime: [
                {
                  regime: 'HighVolTrend',
                  rawCandidateCount: 6,
                  selectedCandidateCount: 4,
                  realizedTradeCount: 1,
                  selectedCoveragePct: 66.67,
                  realizedSelectedCandidatePct: 25,
                  selectedCandidateCollapseCount: 3,
                },
                {
                  regime: 'LowVolTrend',
                  rawCandidateCount: 4,
                  selectedCandidateCount: 3,
                  realizedTradeCount: 3,
                  selectedCoveragePct: 75,
                  realizedSelectedCandidatePct: 100,
                  selectedCandidateCollapseCount: 0,
                },
                {
                  regime: 'HighVolChop',
                  rawCandidateCount: 3,
                  selectedCandidateCount: 2,
                  realizedTradeCount: 2,
                  selectedCoveragePct: 66.67,
                  realizedSelectedCandidatePct: 100,
                  selectedCandidateCollapseCount: 0,
                },
                {
                  regime: 'LowVolChop',
                  rawCandidateCount: 2,
                  selectedCandidateCount: 1,
                  realizedTradeCount: 1,
                  selectedCoveragePct: 50,
                  realizedSelectedCandidatePct: 100,
                  selectedCandidateCollapseCount: 0,
                },
              ],
            },
          }),
          regimeGateSelection: {
            source: 'winner',
            gate: { allowedEntryRegimes: ['HighVolTrend'] },
            parentArmId: 'regime_gate_winner',
            parentArmQualified: true,
            bootstrappedFromUnqualifiedBestArm: false,
          },
        },
      },
    })

    expect(report.selectionDiagnosticsSummary?.weakestRegime?.regime).toBe('HighVolTrend')
    expect(report.recommendation.regimeCollapseWarnings).toEqual([
      {
        regime: 'HighVolTrend',
        selectedCandidateCollapseCount: 3,
        selectedCandidateCount: 4,
        realizedTradeCount: 1,
        realizedSelectedCandidatePct: 25,
        isWeakestRegime: true,
        warning: 'Selection collapsed 3 of 4 candidates in HighVolTrend.',
      },
    ])
  })
})
