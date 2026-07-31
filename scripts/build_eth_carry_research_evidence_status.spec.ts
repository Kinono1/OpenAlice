import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildEthCarryResearchEvidenceStatusReport,
  parseEthCarryResearchEvidenceStatusArgs,
  runEthCarryResearchEvidenceStatus,
} from './build_eth_carry_research_evidence_status.js'

describe('build_eth_carry_research_evidence_status', () => {
  it('parses defaults and keeps package script wired', () => {
    expect(parseEthCarryResearchEvidenceStatusArgs([
      '--output',
      'null',
      '--json',
      'true',
      '--controlSummaryPath',
      'control.json',
    ])).toMatchObject({
      outputPath: null,
      json: true,
      controlSummaryPath: 'control.json',
      ethFundingPath: 'data/research/derivatives_history/binance_ETH_USDT_USDT_funding_history.json',
      btcFundingPath: 'data/research/derivatives_history/binance_BTC_USDT_USDT_funding_history.json',
      pitFeaturePath: 'data/research/eth_carry_pit_features.latest.json',
      pitAuditPath: 'data/research/eth_carry_pit_audit.latest.json',
      prospectiveEvidenceStatusPath: 'data/research/eth_carry_prospective_evidence_status.latest.json',
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:eth-carry:evidence-status']).toContain('build_eth_carry_research_evidence_status.ts')
  })

  it('blocks a negative legacy carry candidate and refuses profitability claims', () => {
    const report = buildEthCarryResearchEvidenceStatusReport({
      generatedAt: '2026-05-05T00:00:00.000Z',
      inputPaths: makeInputPaths(),
      pipelineRefresh: {
        generatedAt: '2026-05-04T00:00:00.000Z',
        pipelineResult: {
          controlSummaryPath: '/repo/control.json',
          publishedArtifactDir: '/repo/control',
          bundleDir: '/repo/bundle',
        },
      },
      pipelineResult: {
        controlSummaryPath: '/repo/control.json',
        publishedArtifactDir: '/repo/control',
        bundleDir: '/repo/bundle',
      },
      controlSummary: makeSummary({
        summaryPathDir: '/repo/control',
        candidateId: 'carry_24h_z13',
        netExpectancyPct: -0.008,
        tradeCount: 12,
        wfoFailedWindows: 3,
        wfoWindows: 3,
        pbo: 0.6,
        profitProbability: 0.035,
      }),
      shadowSummary: makeSummary({
        summaryPathDir: '/repo/shadow',
        candidateId: 'carry_short_bias_core',
        netExpectancyPct: -0.00058,
        tradeCount: 6,
        wfoFailedWindows: 1,
        wfoWindows: 1,
        pbo: 1,
        profitProbability: 0.475,
      }),
      pairShadowSummary: null,
      validation: makeValidation(),
      runtimeStatus: {
        promotionDecision: 'keep_control',
      },
      ethFundingRows: makeFundingRows('ETH/USDT:USDT'),
      btcFundingRows: makeFundingRows('BTC/USDT:USDT'),
      pitFeatureDataset: null,
      pitAudit: null,
      feeSnapshotStatus: {
        status: 'runtime_verified',
        snapshotWritten: true,
        symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT'],
        perSymbolFees: [{}, {}, {}],
      },
      okxAuth: {
        status: 'auth_available',
        bestMode: 'production',
      },
      nextResearchPlan: {
        planStatus: 'ready_for_research_only_experiments',
        experimentCards: [{
          experimentId: 'funding_carry_rebuild_next_research',
          familyId: 'funding_carry_rebuild',
          decision: 'admit_research_only',
        }],
      },
      prospectiveEvidenceStatus: null,
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-05T00:00:00.000Z',
      researchOnly: true,
      promotionAllowed: false,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'research_only_blocked',
      profitabilityVerdict: 'cannot_claim_profitable',
      selectedCandidate: {
        role: 'control',
        candidateId: 'carry_24h_z13',
        metrics: {
          netExpectancyPct: -0.008,
          tradeCount: 12,
        },
        wfo: {
          overallPassed: false,
          failedWindowRatio: 1,
        },
        releaseGate: {
          allowPaperTrading: false,
          allowLiveTrading: false,
          failedChecks: ['wfo', 'significance', 'risk_simulation', 'economics'],
        },
      },
      bestObservedCandidate: {
        role: 'short_bias_shadow',
        metrics: {
          netExpectancyPct: -0.00058,
        },
      },
      costEvidence: {
        runtimeFeeStatus: 'runtime_verified',
        runtimeFeePerSymbolFees: 3,
        okxPrivateAuthStatus: 'auth_available',
      },
      pitEvidence: {
        fundingAvailableTimeStatus: 'missing_explicit_available_time',
        fundingExplicitAvailableTimeCoveragePct: 0,
        basisAvailableTimeStatus: 'missing_basis_feature',
        source: 'legacy_funding_history',
        pointInTimeUsableForPromotion: false,
      },
      nextResearchAlignment: {
        admittedFundingCarry: true,
        admittedExperimentId: 'funding_carry_rebuild_next_research',
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
      'release_gate_failed:wfo',
      'release_gate_failed:significance',
      'release_gate_failed:risk_simulation',
      'release_gate_failed:economics',
      'net_expectancy_non_positive:-0.008',
      'best_observed_net_expectancy_non_positive:-0.00058',
      'wfo_not_passed',
      'wfo_failed_window_ratio:1>0.3',
      'significance_not_passed:pbo=0.6',
      'risk_simulation_not_passed:profitProbability=0.035<0.55',
      'funding_available_time_missing:ETH:0/3',
      'funding_available_time_missing:BTC:0/3',
      'basis_spread_feature_missing',
      'paper_execution_slippage_telemetry_unavailable',
      'trial_ledger_not_pass:fail',
      'by_fdr_missing',
      'prospective:prospective_evidence_status_missing',
      'pit_audit:pit_audit_report_missing',
    ]))
    expect(report.blockers).not.toContain('runtime_fee_snapshot_not_verified:runtime_verified')
    expect(report.blockers).not.toContain('okx_private_auth_not_available:auth_available')
    expect(report.killCriteriaTriggered).toEqual(expect.arrayContaining([
      'net_carry_after_stressed_unwind_cost<=0',
      'funding_or_basis_available_time_missing',
    ]))
  })

  it('uses PIT carry feature evidence for funding availableAt and basis without authorizing trading', () => {
    const report = buildEthCarryResearchEvidenceStatusReport({
      generatedAt: '2026-05-05T00:00:00.000Z',
      inputPaths: makeInputPaths(),
      pipelineRefresh: {
        generatedAt: '2026-05-04T00:00:00.000Z',
      },
      pipelineResult: null,
      controlSummary: makeSummary({
        summaryPathDir: '/repo/control',
        candidateId: 'carry_24h_z13',
        netExpectancyPct: -0.008,
        tradeCount: 12,
        wfoFailedWindows: 3,
        wfoWindows: 3,
        pbo: 0.6,
        profitProbability: 0.035,
      }),
      shadowSummary: null,
      pairShadowSummary: null,
      validation: makeValidation(),
      runtimeStatus: {
        promotionDecision: 'keep_control',
      },
      ethFundingRows: makeFundingRows('ETH/USDT:USDT'),
      btcFundingRows: makeFundingRows('BTC/USDT:USDT'),
      pitFeatureDataset: makePitFeatureDataset(),
      pitAudit: makePitAuditPass(),
      feeSnapshotStatus: {
        status: 'runtime_verified',
        snapshotWritten: true,
        symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT'],
        perSymbolFees: [{}, {}, {}],
      },
      okxAuth: {
        status: 'auth_available',
        bestMode: 'production',
      },
      nextResearchPlan: {
        planStatus: 'ready_for_research_only_experiments',
        experimentCards: [{
          experimentId: 'funding_carry_rebuild_next_research',
          familyId: 'funding_carry_rebuild',
          decision: 'admit_research_only',
        }],
      },
      prospectiveEvidenceStatus: makeProspectiveEvidenceStatus(),
    })

    expect(report).toMatchObject({
      status: 'research_only_blocked',
      profitabilityVerdict: 'cannot_claim_profitable',
      promotionAllowed: false,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      pitFeatureEvidence: {
        status: 'ready_for_research',
        fundingEvents: 2,
        fundingEventsWithAvailableAt: 2,
        fundingExplicitAvailableTimeCoveragePct: 100,
        basisSnapshots: 2,
        carryFeatureRows: 1,
        validCarryFeatureRows: 1,
        fundingAvailableTimeStatus: 'complete',
        basisAvailableTimeStatus: 'present',
      },
      pitEvidence: {
        fundingAvailableTimeStatus: 'complete',
        fundingExplicitAvailableTimeCoveragePct: 100,
        basisAvailableTimeStatus: 'present',
        source: 'pit_feature_dataset',
        pointInTimeUsableForPromotion: false,
      },
      basisEvidence: {
        available: true,
        validCarryFeatureRows: 1,
      },
      prospectiveEvidence: {
        status: 'collecting',
        openEvents: 1,
        closedOutcomes: 0,
        closedDecisionWindows: 0,
        minClosedOutcomes: 100,
        latestOpenObservationId: 'obs-1',
      },
    })
    expect(report.blockers.some(blocker => blocker.startsWith('funding_available_time_missing'))).toBe(false)
    expect(report.blockers).not.toContain('basis_spread_feature_missing')
    expect(report.blockers).not.toContain('not_pit_audit_validated')
    expect(report.blockers).toEqual(expect.arrayContaining([
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
      'net_expectancy_non_positive:-0.008',
      'wfo_not_passed',
      'paper_execution_slippage_telemetry_unavailable',
      'trial_ledger_not_pass:fail',
      'by_fdr_missing',
      'prospective:prospective_closed_outcomes_low:0<100',
    ]))
    expect(report.killCriteriaTriggered).toEqual(['net_carry_after_stressed_unwind_cost<=0'])
  })

  it('writes a status artifact from pipeline paths and remains research-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-status-'))
    const controlDir = join(root, 'control')
    const shadowDir = join(root, 'shadow')
    const runtimeDir = join(root, 'runtime')
    const researchDir = join(root, 'research')
    await mkdir(controlDir, { recursive: true })
    await mkdir(shadowDir, { recursive: true })
    await mkdir(runtimeDir, { recursive: true })
    await mkdir(researchDir, { recursive: true })
    const controlSummaryPath = join(controlDir, 'eth_carry_summary.json')
    const shadowSummaryPath = join(shadowDir, 'eth_carry_short_bias_summary.json')
    const validationPath = join(controlDir, 'eth_carry.validation.json')
    const pipelinePath = join(runtimeDir, 'eth_carry_pipeline_refresh.json')
    const outputPath = join(researchDir, 'eth_carry_research_evidence_status.latest.json')
    const ethFundingPath = join(researchDir, 'eth_funding.json')
    const btcFundingPath = join(researchDir, 'btc_funding.json')
    const pitFeaturePath = join(researchDir, 'eth_carry_pit_features.latest.json')
    const pitAuditPath = join(researchDir, 'eth_carry_pit_audit.latest.json')
    const prospectiveEvidenceStatusPath = join(researchDir, 'eth_carry_prospective_evidence_status.latest.json')
    const feePath = join(runtimeDir, 'fee_snapshot_refresh.latest.json')
    const authPath = join(runtimeDir, 'okx_private_auth_diagnosis.latest.json')
    const planPath = join(researchDir, 'next_research_hypothesis_plan.latest.json')
    const runtimeStatusPath = join(runtimeDir, 'eth_carry_runtime_status.json')

    await writeJson(controlSummaryPath, makeSummary({
      summaryPathDir: controlDir,
      candidateId: 'carry_24h_z13',
      netExpectancyPct: -0.008,
      tradeCount: 12,
      wfoFailedWindows: 3,
      wfoWindows: 3,
      pbo: 0.6,
      profitProbability: 0.035,
    }))
    await writeJson(shadowSummaryPath, makeSummary({
      summaryPathDir: shadowDir,
      candidateId: 'carry_short_bias_core',
      netExpectancyPct: -0.00058,
      tradeCount: 6,
      wfoFailedWindows: 1,
      wfoWindows: 1,
      pbo: 1,
      profitProbability: 0.475,
    }))
    await writeJson(validationPath, makeValidation())
    await writeJson(pipelinePath, {
      generatedAt: '2026-05-05T01:00:00.000Z',
      pipelineResult: {
        controlSummaryPath,
        shadowSummaryPath,
        publishedArtifactDir: controlDir,
        bundleDir: join(root, 'bundle'),
      },
    })
    await writeJson(ethFundingPath, makeFundingRows('ETH/USDT:USDT'))
    await writeJson(btcFundingPath, makeFundingRows('BTC/USDT:USDT'))
    await writeJson(pitFeaturePath, makePitFeatureDataset())
    await writeJson(pitAuditPath, makePitAuditPass())
    await writeJson(prospectiveEvidenceStatusPath, makeProspectiveEvidenceStatus())
    await writeJson(feePath, { status: 'runtime_verified', snapshotWritten: true, perSymbolFees: [{}, {}, {}] })
    await writeJson(authPath, { status: 'auth_available', bestMode: 'production' })
    await writeJson(planPath, {
      planStatus: 'ready_for_research_only_experiments',
      experimentCards: [{
        experimentId: 'funding_carry_rebuild_next_research',
        familyId: 'funding_carry_rebuild',
        decision: 'admit_research_only',
      }],
    })
    await writeJson(runtimeStatusPath, { promotionDecision: 'keep_control' })

    const report = await runEthCarryResearchEvidenceStatus({
      pipelineRefreshPath: pipelinePath,
      controlSummaryPath: null,
      shadowSummaryPath: null,
      pairShadowSummaryPath: null,
      validationPath: null,
      runtimeStatusPath,
      ethFundingPath,
      btcFundingPath,
      pitFeaturePath,
      pitAuditPath,
      feeSnapshotStatusPath: feePath,
      okxAuthPath: authPath,
      nextResearchPlanPath: planPath,
      prospectiveEvidenceStatusPath,
      outputPath,
      json: false,
    })

    expect(report).toMatchObject({
      status: 'research_only_blocked',
      profitabilityVerdict: 'cannot_claim_profitable',
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      prospectiveEvidence: {
        status: 'collecting',
        openEvents: 1,
        closedOutcomes: 0,
      },
    })
    const written = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(written).toMatchObject({
      researchOnly: true,
      promotionAllowed: false,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'research_only_blocked',
    })
  })
})

function makeInputPaths() {
  return {
    pipelineRefreshPath: '/repo/pipeline.json',
    controlSummaryPath: '/repo/control.json',
    shadowSummaryPath: '/repo/shadow.json',
    pairShadowSummaryPath: null,
    validationPath: '/repo/validation.json',
    runtimeStatusPath: '/repo/runtime_status.json',
    ethFundingPath: '/repo/eth_funding.json',
    btcFundingPath: '/repo/btc_funding.json',
    pitFeaturePath: '/repo/eth_carry_pit_features.latest.json',
    pitAuditPath: '/repo/eth_carry_pit_audit.latest.json',
    feeSnapshotStatusPath: '/repo/fee.json',
    okxAuthPath: '/repo/auth.json',
    nextResearchPlanPath: '/repo/plan.json',
    prospectiveEvidenceStatusPath: '/repo/eth_carry_prospective_evidence_status.latest.json',
  }
}

function makePitAuditPass() {
  return {
    schemaVersion: 1,
    status: 'pass',
    counts: {
      carryFeatureRows: 1,
      auditedRows: 1,
      passingRows: 1,
      failingRows: 0,
    },
    rows: [],
    blockers: [],
  }
}

function makeSummary(input: {
  summaryPathDir: string
  candidateId: string
  netExpectancyPct: number
  tradeCount: number
  wfoFailedWindows: number
  wfoWindows: number
  pbo: number
  profitProbability: number
}) {
  return {
    generatedAt: '2026-05-04T00:00:00.000Z',
    selectedParams: {
      id: input.candidateId,
    },
    selectedMetrics: {
      totalReturnPct: input.netExpectancyPct * input.tradeCount,
      grossExpectancyPct: input.netExpectancyPct + 0.001,
      netExpectancyPct: input.netExpectancyPct,
      tradeCount: input.tradeCount,
      sharpe: -1,
      maxDrawdownPct: 0.12,
      feeExpectancyDragPct: 0.0036,
      slippageExpectancyDragPct: 0.0036,
      fundingExpectancyDragPct: -0.00007,
      longTradeCount: 6,
      shortTradeCount: 6,
    },
    wfo: {
      overallPassed: false,
      failedWindows: input.wfoFailedWindows,
      windows: Array.from({ length: input.wfoWindows }, (_, index) => ({
        windowIndex: index,
        gatePassed: index >= input.wfoFailedWindows,
      })),
    },
    significance: {
      passed: false,
      pboResult: {
        pbo: input.pbo,
      },
      dsrResult: {
        dsrValue: -0.08,
        dsrProbability: 0.004,
      },
    },
    riskSimulation: {
      gatePassed: false,
      profitProbability: input.profitProbability,
      minProfitProbability: 0.55,
      riskOfRuin: 0,
    },
    releaseGate: {
      allowPaperTrading: false,
      allowLiveTrading: false,
      hardFail: true,
      failedChecks: ['wfo', 'significance', 'risk_simulation', 'economics'],
      warningChecks: [],
    },
    validationOutput: `${input.summaryPathDir}/eth_carry.validation.json`,
  }
}

function makeValidation() {
  return {
    validationEvidence: {
      paperExecutionSlippage: {
        available: false,
      },
    },
    decisionSummary: {
      promotion: {
        failedChecks: ['wfo', 'significance', 'risk_simulation', 'economics'],
      },
      statistics: {
        trialLedgerStatus: 'fail',
        fdrQ: null,
      },
      factorIcByHorizon: {
        available: true,
      },
      longShortSideAsymmetry: {
        longNetExpectancyPct: -0.016,
        shortNetExpectancyPct: 0.0007,
      },
    },
  }
}

function makeFundingRows(symbol: string) {
  return [
    { symbol, fundingRate: 0.0001, timestamp: 1_772_092_800_006 },
    { symbol, fundingRate: 0.0002, timestamp: 1_772_121_600_002 },
    { symbol, fundingRate: -0.0001, timestamp: 1_772_150_400_007 },
  ]
}

function makePitFeatureDataset() {
  return {
    schemaVersion: 1,
    status: 'ready_for_research',
    counts: {
      fundingEvents: 2,
      basisSnapshots: 2,
      carryFeatureRows: 1,
      symbolsWithFunding: ['BTCUSDT', 'ETHUSDT'],
      symbolsWithBasis: ['BTCUSDT', 'ETHUSDT'],
      rowsMissingAvailableAt: 0,
    },
    fundingEvents: [
      {
        symbol: 'ETHUSDT',
        availableAt: '2026-05-02T21:17:48.084Z',
        fundingRate: -0.00001658,
      },
      {
        symbol: 'BTCUSDT',
        availableAt: '2026-05-02T21:17:48.086Z',
        fundingRate: 0.00001977,
      },
    ],
    basisSnapshots: [
      {
        symbol: 'ETHUSDT',
        availableAt: '2026-05-02T21:17:48.084Z',
        basisSpreadPct: -0.046582824,
      },
      {
        symbol: 'BTCUSDT',
        availableAt: '2026-05-02T21:17:48.086Z',
        basisSpreadPct: -0.0441587859,
      },
    ],
    carryFeatureRows: [{
      decisionAvailableAt: '2026-05-02T21:17:48.086Z',
      basisSpreadDiffPct: -0.0024240381,
      requiredFields: {
        fundingRateCashflow: true,
        basisSpread: true,
        explicitAvailableAt: true,
      },
      blockers: [],
    }],
    blockers: [],
  }
}

function makeProspectiveEvidenceStatus() {
  return {
    schemaVersion: 1,
    status: 'collecting',
    researchOnly: true,
    prospectiveOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    counts: {
      openEvents: 1,
      closedEvents: 0,
      closedDecisionWindows: 0,
    },
    metrics: {
      closedOutcomes: 0,
      meanGrossCarryPairReturnPct: null,
      winRatePct: null,
      routeCostAdjustedClosedOutcomes: 0,
      fundingCashflowAccountedClosedOutcomes: 0,
    },
    thresholds: {
      minClosedOutcomes: 100,
      minNonOverlappingWindows: 3,
    },
    latestOpen: {
      observationId: 'obs-1',
      decisionTime: '2026-05-06T01:00:00.000Z',
      labelDueTime: '2026-05-06T09:00:00.000Z',
    },
    blockers: [
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
      'prospective_closed_outcomes_low:0<100',
      'prospective_closed_windows_low:0<3',
      'prospective_route_cost_adjusted_labels_missing',
      'prospective_funding_cashflow_labels_missing',
    ],
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}
