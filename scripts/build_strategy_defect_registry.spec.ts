import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildStrategyDefectRegistryReport,
  parseStrategyDefectRegistryArgs,
  runStrategyDefectRegistry,
} from './build_strategy_defect_registry.js'

describe('build_strategy_defect_registry', () => {
  it('parses defaults and keeps package script wired', () => {
    expect(parseStrategyDefectRegistryArgs(['--output', 'null', '--json'])).toMatchObject({
      outputPath: null,
      json: true,
      strategyDefectMonitorPath: 'data/research/strategy_defect_monitor.latest.json',
      staleDataNoOpenGateStatusPath: 'data/runtime/stale_data_no_open_gate_status.latest.json',
      panicRegimeNoOpenGateStatusPath: 'data/runtime/panic_regime_no_open_gate_status.latest.json',
      strategyRiskCapStatusPath: 'data/runtime/strategy_risk_cap_status.latest.json',
      partialTakeProfitStatusPath: 'data/runtime/partial_take_profit_status.latest.json',
      mfeMaeStoplossReportPath: 'data/runtime/p1_trading_evidence/mfe_mae_stoploss_report.latest.json',
      liveDataFreshnessPath: 'data/runtime/live_data_freshness.latest.json',
      ethCarryEvidencePath: 'data/research/eth_carry_research_evidence_status.latest.json',
      ethCarryProspectiveEvidencePath: 'data/research/eth_carry_prospective_evidence_status.latest.json',
      marketIntelNoOpenGateStatusPath: 'data/runtime/market_intel_no_open_gate_status.latest.json',
      crossSectionalConfigGateStatusPath: 'data/runtime/cross_sectional_config_gate_status.latest.json',
      volumeBreakoutConfigGateStatusPath: 'data/runtime/volume_breakout_config_gate_status.latest.json',
      wfoStabilityGateStatusPath: 'data/runtime/wfo_stability_gate_status.latest.json',
      portfolioRiskManagementGateStatusPath: 'data/runtime/portfolio_risk_management_gate_status.latest.json',
      killSwitchGateStatusPath: 'data/runtime/kill_switch_gate_status.latest.json',
      accountCorruptionGateStatusPath: 'data/runtime/account_corruption_gate_status.latest.json',
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:strategy:defect-registry']).toContain('build_strategy_defect_registry.ts')
    expect(scripts['status:research-evidence']).toContain('build_strategy_defect_registry.ts')
    expect(scripts['status:research-evidence']).toContain('build_system_status_reason_chain.ts')
  })

  it('turns the full strategy defect list into a diagnostic-only gate checklist', () => {
    const report = buildStrategyDefectRegistryReport({
      generatedAt: '2026-05-06T00:00:00.000Z',
      sourceArtifacts: {
        strategyDefectMonitor: '/tmp/strategy_defect_monitor.latest.json',
        strategyReport: '/tmp/openalice_strategy_improvement.md',
        crossSectional: '/tmp/cross-sectional-momentum.ts',
        crossSectionalPaper: '/tmp/paper_trade_cross_sectional.ts',
        volumeBreakout: '/tmp/volume-breakout.ts',
        microstructure: '/tmp/paper_trade_microstructure_stress.ts',
        actionGate: '/tmp/action-gate.ts',
        scoring: '/tmp/scoring.ts',
        staleDataNoOpenGateStatus: '/tmp/stale_data_no_open_gate_status.latest.json',
        panicRegimeNoOpenGateStatus: '/tmp/panic_regime_no_open_gate_status.latest.json',
        strategyRiskCapStatus: '/tmp/strategy_risk_cap_status.latest.json',
        partialTakeProfitStatus: '/tmp/partial_take_profit_status.latest.json',
        mfeMaeStoplossReport: '/tmp/mfe_mae_stoploss_report.latest.json',
        liveDataFreshness: '/tmp/live_data_freshness.latest.json',
        ethCarryEvidence: '/tmp/eth_carry_research_evidence_status.latest.json',
        ethCarryProspectiveEvidence: '/tmp/eth_carry_prospective_evidence_status.latest.json',
        dynamicLeverageVolatilityGateStatus: '/tmp/dynamic_leverage_volatility_gate_status.latest.json',
        marketIntelNoOpenGateStatus: '/tmp/market_intel_no_open_gate_status.latest.json',
        crossSectionalConfigGateStatus: '/tmp/cross_sectional_config_gate_status.latest.json',
        volumeBreakoutConfigGateStatus: '/tmp/volume_breakout_config_gate_status.latest.json',
        wfoStabilityGateStatus: '/tmp/wfo_stability_gate_status.latest.json',
        portfolioRiskManagementGateStatus: '/tmp/portfolio_risk_management_gate_status.latest.json',
        killSwitchGateStatus: '/tmp/kill_switch_gate_status.latest.json',
        accountCorruptionGateStatus: '/tmp/account_corruption_gate_status.latest.json',
      },
      sources: {
        strategyReport: source('/tmp/openalice_strategy_improvement.md', 'MarketIntel 12 dryRun CPCV Sharpe'),
        crossSectional: source('/tmp/cross-sectional-momentum.ts', crossSectionalSource()),
        crossSectionalPaper: source('/tmp/paper_trade_cross_sectional.ts', crossSectionalPaperSource()),
        volumeBreakout: source('/tmp/volume-breakout.ts', volumeBreakoutSource()),
        microstructure: source('/tmp/paper_trade_microstructure_stress.ts', "id: 'liquidation_probe_100x'\nmode: 'stress_only'"),
        actionGate: source('/tmp/action-gate.ts', actionGateSource()),
        scoring: source('/tmp/scoring.ts', 'const staleDataApplied = context.staleData === true'),
        staleDataNoOpenGateStatus: staleDataNoOpenGateStatus(),
        panicRegimeNoOpenGateStatus: panicRegimeNoOpenGateStatus(),
        strategyRiskCapStatus: strategyRiskCapStatus(),
        partialTakeProfitStatus: partialTakeProfitStatus(),
        mfeMaeStoplossReport: mfeMaeStoplossReport(),
        dynamicLeverageVolatilityGateStatus: dynamicLeverageVolatilityGateStatus(),
        decisionContextCoverageGateStatus: null,
        pitAuditGlobalGateStatus: pitAuditGlobalGateStatus(),
        routeCostModelCompletenessGateStatus: routeCostModelCompletenessGateStatus(),
        marketIntelNoOpenGateStatus: marketIntelNoOpenGateStatus(),
        crossSectionalConfigGateStatus: crossSectionalConfigGateStatus(),
        volumeBreakoutConfigGateStatus: volumeBreakoutConfigGateStatus(),
        wfoStabilityGateStatus: wfoStabilityGateStatus(),
        portfolioRiskManagementGateStatus: portfolioRiskManagementGateStatus(),
        killSwitchGateStatus: killSwitchGateStatusFixture(),
        accountCorruptionGateStatus: accountCorruptionGateStatusFixture(),
      },
      strategyDefectMonitor: strategyDefectMonitor(),
      liveDataFreshness: {
        status: 'fresh',
        blockers: [],
        summary: {
          publicDataUsableForLiveOnlyResearch: true,
        },
      },
      ethCarryEvidence: {
        blockers: ['net_expectancy_non_positive:-0.008'],
        pitEvidence: {
          fundingExplicitAvailableTimeCoveragePct: 100,
          fundingAvailableTimeStatus: 'complete',
          basisAvailableTimeStatus: 'present',
          pointInTimeUsableForPromotion: false,
        },
        costEvidence: {
          runtimeFeeStatus: 'runtime_verified',
        },
        basisEvidence: {
          available: true,
        },
      },
      ethCarryProspectiveEvidence: ethCarryProspectiveEvidence(),
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-06T00:00:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked',
      summary: {
        defects: 48,
        unknown: 0,
      },
    })
    expect(report.summary.open + report.summary.partial).toBeGreaterThan(20)
    expect(report.summary.monitorCovered).toBeGreaterThan(0)
    expect(report.summary.monitorUncovered).toBeGreaterThan(0)
    expect(report.defects.find(item => item.id === '1.1.1')).toMatchObject({
      status: 'watch',
      observed: {
        retiredLineGuardStatus: 'pass',
        lineRetired: true,
        hasReactivationChecklist: true,
        artifactAllowsExecution: false,
      },
      monitorCoverage: {
        covered: true,
        matchingFindingIds: ['retired_line_guard'],
      },
      blockers: ['retired_line_runtime_guard_passed_requires_new_alpha_before_reactivation'],
    })
    expect(report.defects.find(item => item.id === '1.3.1')).toMatchObject({
      status: 'watch',
      observed: { stressOnly100x: true },
    })
    expect(report.defects.find(item => item.id === '2.4')).toMatchObject({
      status: 'partial',
      observed: { runtimeFeeStatus: 'runtime_verified', runtimeFeeVerified: true },
      monitorCoverage: {
        covered: true,
        matchingFindingIds: ['route_cost_slippage_readiness'],
      },
    })
    expect(report.defects.find(item => item.id === '2.5')).toMatchObject({
      status: 'open',
      monitorCoverage: {
        covered: true,
        matchingFindingIds: ['route_cost_slippage_readiness'],
      },
    })
    expect(report.defects.find(item => item.id === '2.2')).toMatchObject({
      status: 'watch',
      observed: {
        partialTakeProfitStatus: 'pass',
        artifactAllowsExecution: false,
        longFirstTrancheCloseFraction: 0.5,
        longIncrementalCloseFraction: 0.25,
      },
      blockers: ['partial_take_profit_primitive_runtime_validated_needs_paper_outcome_validation'],
    })
    expect(report.defects.find(item => item.id === '2.7')).toMatchObject({
      status: 'watch',
      observed: {
        metricBasis: 'price_path_bps',
        closedTrades: 947,
        closedDiagnosticsOk: 947,
        stopLossTrades: 42,
        stopLossDiagnosticsOk: 42,
        stopLossDiagnosticsOkPct: 100,
        stopLossAttributionStatus: 'blocked_diagnostic_only',
        promotionClaimAllowed: false,
        executionReplayClaimAllowed: false,
      },
      blockers: ['mfe_mae_path_diagnostics_runtime_validated_needs_policy_outcome_validation'],
    })
    expect(report.defects.find(item => item.id === '3.4')).toMatchObject({
      status: 'watch',
      observed: { value: 65, minimum: 65 },
    })
    expect(report.defects.find(item => item.id === '3.3')).toMatchObject({
      status: 'watch',
      observed: {
        panicRegimeStatus: 'pass',
        eventFreezeRegime: 'event-risk-freeze',
        eventFreezeActionStatus: 'reduce',
        eventFreezeOpenDecisionMode: 'blocked',
        eventFreezeReducePassThrough: true,
        volStressRegime: 'vol-stress',
        volStressOpenDecisionMode: 'blocked',
        volStressReducePassThrough: true,
        artifactAllowsExecution: false,
      },
      monitorCoverage: {
        covered: true,
        matchingFindingIds: ['panic_regime_no_open_gate'],
      },
      blockers: ['panic_regime_no_open_gate_runtime_validated_needs_live_context_coverage'],
    })
    expect(report.defects.find(item => item.id === '3.2')).toMatchObject({
      status: 'watch',
      observed: {
        marketIntelNoOpenGateStatus: 'pass',
        riskOffOpenContextStatus: 'risk_off',
        severeNewsOpenContextStatus: 'severe_news',
        laneBlockedOpenContextStatus: 'lane_blocked',
        symbolBlockedOpenContextStatus: 'symbol_blocked',
        allowedOpenContextStatus: 'ok',
        artifactAllowsExecution: false,
      },
      monitorCoverage: {
        covered: true,
        matchingFindingIds: ['market_intel_no_open_gate'],
      },
      blockers: ['market_intel_no_open_gate_runtime_validated_needs_live_context_coverage'],
    })
    expect(report.defects.find(item => item.id === '3.5')).toMatchObject({
      status: 'watch',
      observed: {
        strategyRiskCapStatus: 'pass',
        maxSingleTradeLossUsdConfigured: 150,
      },
    })
    expect(report.defects.find(item => item.id === '3.6')).toMatchObject({
      status: 'watch',
      observed: {
        dynamicLeverageVolatilityGateStatus: 'pass',
        volatilityPercentile: 0.85,
        recommendedMaxLeverage: 1,
        tier: 'high',
        currentMaxLeverage: 100,
        leverageBlocked: false,
        artifactAllowsExecution: false,
      },
      blockers: ['dynamic_leverage_volatility_gate_runtime_validated_needs_live_context_coverage'],
    })
    expect(report.defects.find(item => item.id === '3.7')).toMatchObject({
      status: 'watch',
      observed: {
        strategyRiskCapStatus: 'pass',
        correlationCheck: true,
        maxCorrelatedGroupExposurePctOfEquityConfigured: 60,
      },
    })
    expect(report.defects.find(item => item.id === '4.1')).toMatchObject({
      status: 'watch',
      observed: { liveDataFreshnessStatus: 'fresh' },
    })
    expect(report.defects.find(item => item.id === '4.3')).toMatchObject({
      status: 'partial',
      observed: {
        carryFundingAvailableTimeStatus: 'complete',
        carryBasisAvailableTimeStatus: 'present',
        carryPitAuditPassingRows: 55101,
        carryPitAuditTotalRows: 55101,
        globalPitAuditImplemented: false,
        pitAuditGlobalGateStatus: 'watch',
      },
    })
    expect(report.defects.find(item => item.id === '4.4')).toMatchObject({
      status: 'watch',
      observed: { staleDataNoTrade: true },
    })
    expect(report.defects.find(item => item.id === '5.6')).toMatchObject({
      status: 'partial',
      observed: {
        closedOutcomes: 2,
        closedDecisionWindows: 2,
        meanGrossCarryPairReturnPct: -0.6,
      },
      monitorCoverage: {
        covered: true,
        matchingFindingIds: ['carry_prospective_evidence'],
      },
    })
    expect(report.defects.find(item => item.id === '7.2')).toMatchObject({
      status: 'watch',
      observed: {
        strategyRiskCapStatus: 'pass',
        maxTotalExposurePctOfEquityConfigured: 60,
      },
    })
    expect(report.defects.find(item => item.id === '7.3')).toMatchObject({
      status: 'watch',
      observed: {
        strategyRiskCapStatus: 'pass',
        maxSymbolExposurePctOfEquityConfigured: 40,
      },
    })
    expect(report.defects.find(item => item.id === '7.4')).toMatchObject({
      status: 'watch',
      observed: {
        strategyRiskCapStatus: 'pass',
        maxNetDirectionalExposurePctOfEquityConfigured: 40,
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      '4.3:pit_available_at_fixed_for_carry_not_global',
      '5.6:carry_prospective_samples_or_return_not_sufficient',
    ]))
    expect(report.blockers).not.toContain('1.1.1:reversal_hypothesis_requires_current_runtime_retirement_or_regime_gate')
    expect(report.blockers).not.toContain('2.2:partial_take_profit_missing')
    expect(report.blockers).not.toContain('2.2:partial_take_profit_missing_or_not_runtime_validated')
    expect(report.blockers).not.toContain('2.7:mfe_mae_tracking_missing_or_low_coverage')
    expect(report.blockers).not.toContain('3.2:blacklist_is_reactive_not_pre_trade_gate')
    expect(report.blockers).not.toContain('3.3:panic_index_not_hard_wired_to_action_gate')
    expect(report.blockers).not.toContain('3.5:single_trade_max_loss_limit_missing')
    expect(report.blockers).not.toContain('3.7:portfolio_correlation_check_missing')
    expect(report.blockers).not.toContain('7.2:total_exposure_cap_missing')
    expect(report.blockers).not.toContain('7.3:symbol_concentration_limit_missing')
    expect(report.blockers).not.toContain('7.4:long_short_neutrality_check_missing')
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-strategy-defect-registry-'))
    const outputPath = join(root, 'strategy_defect_registry.latest.json')
    const monitorPath = join(root, 'strategy_defect_monitor.latest.json')
    const reportPath = join(root, 'openalice_strategy_improvement.md')
    const csPath = join(root, 'cross-sectional-momentum.ts')
    const paperCsPath = join(root, 'paper_trade_cross_sectional.ts')
    const vbPath = join(root, 'volume-breakout.ts')
    const microPath = join(root, 'paper_trade_microstructure_stress.ts')
    const actionPath = join(root, 'action-gate.ts')
    const scoringPath = join(root, 'scoring.ts')
    const staleDataNoOpenGateStatusPath = join(root, 'stale_data_no_open_gate_status.latest.json')
    const panicRegimeNoOpenGateStatusPath = join(root, 'panic_regime_no_open_gate_status.latest.json')
    const strategyRiskCapStatusPath = join(root, 'strategy_risk_cap_status.latest.json')
    const partialTakeProfitStatusPath = join(root, 'partial_take_profit_status.latest.json')
    const mfeMaeStoplossReportPath = join(root, 'mfe_mae_stoploss_report.latest.json')
    const freshnessPath = join(root, 'live_data_freshness.latest.json')
    const ethPath = join(root, 'eth_carry_research_evidence_status.latest.json')
    const ethProspectivePath = join(root, 'eth_carry_prospective_evidence_status.latest.json')
    const dynamicLeverageVolatilityGateStatusPath = join(root, 'dynamic_leverage_volatility_gate_status.latest.json')
    const marketIntelNoOpenGateStatusPath = join(root, 'market_intel_no_open_gate_status.latest.json')
    const crossSectionalConfigGateStatusPath = join(root, 'cross_sectional_config_gate_status.latest.json')
    const volumeBreakoutConfigGateStatusPath = join(root, 'volume_breakout_config_gate_status.latest.json')
    const wfoStabilityGateStatusPath = join(root, 'wfo_stability_gate_status.latest.json')
    const portfolioRiskManagementGateStatusPath = join(root, 'portfolio_risk_management_gate_status.latest.json')
    const killSwitchGateStatusPath = join(root, 'kill_switch_gate_status.latest.json')
    const accountCorruptionGateStatusPath = join(root, 'account_corruption_gate_status.latest.json')
    await mkdir(root, { recursive: true })
    await writeFile(monitorPath, JSON.stringify(strategyDefectMonitor()), 'utf-8')
    await writeFile(reportPath, 'MarketIntel 12 dryRun CPCV Sharpe', 'utf-8')
    await writeFile(csPath, crossSectionalSource(), 'utf-8')
    await writeFile(paperCsPath, crossSectionalPaperSource(), 'utf-8')
    await writeFile(vbPath, volumeBreakoutSource(), 'utf-8')
    await writeFile(microPath, "id: 'liquidation_probe_100x'\nmode: 'stress_only'", 'utf-8')
    await writeFile(actionPath, actionGateSource(), 'utf-8')
    await writeFile(scoringPath, 'const staleDataApplied = context.staleData === true', 'utf-8')
    await writeFile(staleDataNoOpenGateStatusPath, JSON.stringify(staleDataNoOpenGateStatus()), 'utf-8')
    await writeFile(panicRegimeNoOpenGateStatusPath, JSON.stringify(panicRegimeNoOpenGateStatus()), 'utf-8')
    await writeFile(strategyRiskCapStatusPath, JSON.stringify(strategyRiskCapStatus()), 'utf-8')
    await writeFile(partialTakeProfitStatusPath, JSON.stringify(partialTakeProfitStatus()), 'utf-8')
    await writeFile(mfeMaeStoplossReportPath, JSON.stringify(mfeMaeStoplossReport()), 'utf-8')
    await writeFile(freshnessPath, JSON.stringify({ status: 'fresh', blockers: [] }), 'utf-8')
    await writeFile(ethPath, JSON.stringify({
      blockers: ['net_expectancy_non_positive:-0.008'],
      pitEvidence: {
        fundingAvailableTimeStatus: 'complete',
        basisAvailableTimeStatus: 'present',
      },
      costEvidence: {
        runtimeFeeStatus: 'runtime_verified',
      },
      basisEvidence: {
        available: true,
      },
    }), 'utf-8')
    await writeFile(ethProspectivePath, JSON.stringify(ethCarryProspectiveEvidence()), 'utf-8')
    await writeFile(dynamicLeverageVolatilityGateStatusPath, JSON.stringify(dynamicLeverageVolatilityGateStatus()), 'utf-8')
    await writeFile(marketIntelNoOpenGateStatusPath, JSON.stringify(marketIntelNoOpenGateStatus()), 'utf-8')
    await writeFile(crossSectionalConfigGateStatusPath, JSON.stringify(crossSectionalConfigGateStatus()), 'utf-8')
    await writeFile(volumeBreakoutConfigGateStatusPath, JSON.stringify(volumeBreakoutConfigGateStatus()), 'utf-8')
    await writeFile(wfoStabilityGateStatusPath, JSON.stringify(wfoStabilityGateStatus()), 'utf-8')
    await writeFile(portfolioRiskManagementGateStatusPath, JSON.stringify(portfolioRiskManagementGateStatus()), 'utf-8')
    await writeFile(killSwitchGateStatusPath, JSON.stringify(killSwitchGateStatusFixture()), 'utf-8')
    await writeFile(accountCorruptionGateStatusPath, JSON.stringify(accountCorruptionGateStatusFixture()), 'utf-8')

    const report = await runStrategyDefectRegistry({
      outputPath,
      strategyDefectMonitorPath: monitorPath,
      strategyReportPath: reportPath,
      crossSectionalPath: csPath,
      crossSectionalPaperPath: paperCsPath,
      volumeBreakoutPath: vbPath,
      microstructurePath: microPath,
      actionGatePath: actionPath,
      scoringPath,
      staleDataNoOpenGateStatusPath,
      panicRegimeNoOpenGateStatusPath,
      strategyRiskCapStatusPath,
      partialTakeProfitStatusPath,
      mfeMaeStoplossReportPath,
      liveDataFreshnessPath: freshnessPath,
      ethCarryEvidencePath: ethPath,
      ethCarryProspectiveEvidencePath: ethProspectivePath,
      dynamicLeverageVolatilityGateStatusPath: dynamicLeverageVolatilityGateStatusPath,
      marketIntelNoOpenGateStatusPath,
      crossSectionalConfigGateStatusPath,
      volumeBreakoutConfigGateStatusPath,
      wfoStabilityGateStatusPath,
      portfolioRiskManagementGateStatusPath,
      killSwitchGateStatusPath,
      accountCorruptionGateStatusPath,
      json: false,
    })

    expect(report.summary.defects).toBe(48)
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'strategy_defect_registry',
      businessStatus: 'fail',
      recordsIn: 48,
    })
  })
})

function source(path: string, text: string) {
  return { path, exists: true, text }
}

function crossSectionalSource(): string {
  return [
    'short-term reversal',
    'minUniverseSize: 6,',
    'minSpreadPct: 5,',
    'maxVolPercentile: 0.90,',
    'mtfWeight: 0.35,',
    'fundingWeight: 0.25,',
    'minDailyVolumeUsd: 10_000_000,',
    'maxSpreadBps: 20,',
    'confidence',
    'topN',
    'bottomN',
  ].join('\n')
}

function crossSectionalPaperSource(): string {
  return [
    'import { computeAtrTrailingStop } from "../src/domain/strategy/risk/atr-trailing-stop.js"',
    'expectedHoldingHours: 24,',
    'slippageBps: 8,',
  ].join('\n')
}

function volumeBreakoutSource(): string {
  return [
    'volumeLookbackBars: 24,',
    'volumeMultiplier: 2.5,',
    'holdBars: 6,',
    'stopLossPct: 0.03,',
    'minVolumeUsd: 500_000,',
    'minBreakQuality: 0.35,',
    'maxSpreadBps: 40,',
  ].join('\n')
}

function actionGateSource(): string {
  return [
    "if (totalScore >= 65) return 'probe'",
    'const staleDataApplied = context.staleData === true',
    "const actionStatus = staleDataApplied ? 'no-trade' : baseActionStatus",
  ].join('\n')
}

function staleDataNoOpenGateStatus() {
  return {
    status: 'pass',
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    checks: {
      staleHighConfidenceActionStatus: 'no-trade',
      freshHighConfidenceActionStatus: 'attack',
      staleOpenDecisionMode: 'blocked',
      staleOpenBlockReason: 'strategy action status no-trade blocks new opens',
      staleReduceDecisionMode: 'pass-through',
      staleReducePassThrough: true,
    },
    blockers: [],
  }
}

function panicRegimeNoOpenGateStatus() {
  return {
    status: 'pass',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    checks: {
      eventFreezeRegime: 'event-risk-freeze',
      eventFreezeActionStatus: 'reduce',
      eventFreezeBaseActionStatus: 'attack-lite',
      eventFreezeCappedByEventWindow: true,
      eventFreezeOpenDecisionMode: 'blocked',
      eventFreezeOpenBlockReason: 'strategy action status reduce blocks new opens',
      eventFreezeReduceDecisionMode: 'pass-through',
      eventFreezeReducePassThrough: true,
      volStressRegime: 'vol-stress',
      volStressConfidence: 0.94,
      volStressOpenDecisionMode: 'blocked',
      volStressOpenBlockReason: 'strategy action status reduce blocks new opens',
      volStressReduceDecisionMode: 'pass-through',
      volStressReducePassThrough: true,
    },
    blockers: [],
  }
}

function strategyRiskCapStatus() {
  return {
    status: 'pass',
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    checks: {
      singleTradeLossProbe: {
        approved: false,
        reason: 'Risk if filled $200.00 exceeds maxSingleTradeLossUsd $150.',
      },
      totalExposureProbe: {
        approved: false,
        reason: 'Projected total exposure 65.0% exceeds maxTotalExposurePctOfEquity 60%.',
      },
      symbolConcentrationProbe: {
        approved: false,
        reason: 'Projected symbol exposure 45.0% exceeds maxSymbolExposurePctOfEquity 40%.',
      },
      netDirectionalExposureProbe: {
        approved: false,
        reason: 'Projected net directional exposure 45.0% exceeds maxNetDirectionalExposurePctOfEquity 40%.',
      },
      correlatedGroupExposureProbe: {
        approved: false,
        reason: 'Projected correlated group exposure 65.0% exceeds maxCorrelatedGroupExposurePctOfEquity 60%.',
      },
      reduceOnlyPassThroughProbe: {
        approved: true,
        reason: null,
      },
      maxSingleTradeLossUsdConfigured: 150,
      maxTotalExposurePctOfEquityConfigured: 60,
      maxSymbolExposurePctOfEquityConfigured: 40,
      maxNetDirectionalExposurePctOfEquityConfigured: 40,
      maxCorrelatedGroupExposurePctOfEquityConfigured: 60,
      maxOrderUsdConfigured: 5000,
      maxPositionPctOfEquityConfigured: 50,
    },
    blockers: [],
  }
}

function partialTakeProfitStatus() {
  return {
    status: 'pass',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    checks: {
      longFirstTrancheCloseFraction: 0.5,
      longFirstTrancheCloseQuantity: 5,
      longIncrementalCloseFraction: 0.25,
      shortFirstTrancheCloseFraction: 0.5,
      notTriggeredCloseFraction: 0,
      levelCount: 2,
      totalConfiguredCloseFraction: 0.75,
    },
    blockers: [],
  }
}

function mfeMaeStoplossReport() {
  return {
    schemaVersion: 1,
    metricBasis: 'price_path_bps',
    coverage: {
      closedTrades: 947,
      stopLossTrades: 42,
      diagnosticsOk: 947,
      closedDiagnosticsOk: 947,
      stopLossDiagnosticsOk: 42,
      stopLossDiagnosticsOkPct: 100,
      stopLossMissingPricePath: 0,
      stopLossPricePathMismatch: 0,
      stopLossKnownOrdering: 38,
      stopLossCoarseOrdering: 4,
      missingPricePath: 0,
      pricePathMismatch: 0,
      invalidTradePrices: 0,
    },
    stopLossAttribution: {
      diagnosticUse: 'read_only_cluster_attribution',
      status: 'blocked_diagnostic_only',
      promotionEligible: false,
      policyMutationAllowed: false,
      profitabilityClaimAllowed: false,
      blockedBy: [
        'read_only_path_attribution',
        'requires_pro_review_before_policy_change',
        'not_fill_adjusted_execution_replay',
      ],
    },
    stopLossSummary: {
      count: 42,
      avgMfeBps: 2.7498,
      avgMaeBps: -27.3448,
      medianMfeBps: 0.4562,
      medianMaeBps: -16.0979,
      mfeBeforeStopSharePct: 100,
    },
    profitabilityClaimAllowed: false,
    promotionClaimAllowed: false,
    executionReplayClaimAllowed: false,
  }
}

function strategyDefectMonitor() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-06T00:00:00.000Z',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status: 'blocked',
      summary: {
      findings: 18,
      pass: 9,
      blocked: 2,
      watch: 7,
      p0Blocked: 1,
      p1Blocked: 1,
      p2Blocked: 0,
    },
    findings: [
      {
        id: 'retired_line_guard',
        status: 'pass',
        observed: {
          retired: true,
          hasReactivationChecklist: true,
          artifactAllowsExecution: false,
        },
        blockers: [],
        benchmarkLessons: ['research workflow'],
      },
      { id: 'volume_breakout_hold_liquidity', status: 'watch', blockers: [], benchmarkLessons: ['research workflow'] },
      { id: 'microstructure_noise_channels', status: 'watch', blockers: [], benchmarkLessons: ['research workflow'] },
      { id: 'atr_trailing_exit_integration', status: 'watch', blockers: [], benchmarkLessons: ['research workflow'] },
      { id: 'stale_data_no_open_gate', status: 'watch', blockers: [], benchmarkLessons: ['research workflow'] },
      { id: 'panic_regime_no_open_gate', status: 'pass', blockers: [], benchmarkLessons: ['protections'] },
      { id: 'strategy_risk_caps', status: 'pass', blockers: [], benchmarkLessons: ['research workflow'] },
      { id: 'market_intel_no_open_gate', status: 'pass', blockers: [], benchmarkLessons: ['protections'] },
      { id: 'cross_sectional_config_gate', status: 'pass', blockers: [], benchmarkLessons: ['research workflow'] },
      { id: 'volume_breakout_config_gate', status: 'pass', blockers: [], benchmarkLessons: ['research workflow'] },
      { id: 'wfo_stability_gate', status: 'pass', blockers: [], benchmarkLessons: ['research workflow'] },
      { id: 'portfolio_risk_management_gate', status: 'pass', blockers: [], benchmarkLessons: ['research workflow'] },
      { id: 'kill_switch_gate', status: 'pass', blockers: [], benchmarkLessons: ['research workflow'] },
      { id: 'account_corruption_gate', status: 'pass', blockers: [], benchmarkLessons: ['research workflow'] },
      { id: 'route_cost_slippage_readiness', status: 'blocked', blockers: ['paper_execution_slippage_telemetry_unavailable'], benchmarkLessons: ['execution cost model'] },
      { id: 'carry_pit_basis_economics', status: 'blocked', blockers: ['net_expectancy_non_positive'], benchmarkLessons: ['research workflow'] },
      { id: 'carry_prospective_evidence', status: 'blocked', blockers: ['prospective_closed_outcomes_low:2<100'], benchmarkLessons: ['research workflow'] },
    ],
    blockers: ['carry_pit_basis_economics:net_expectancy_non_positive', 'carry_prospective_evidence:prospective_closed_outcomes_low:2<100'],
    nextActions: ['Keep strategy repair in research-only mode.'],
    safetyNotes: ['This monitor cannot authorize paper or live orders.'],
  }
}

function ethCarryProspectiveEvidence() {
  return {
    status: 'has_closed_labels',
    counts: {
      openEvents: 3,
      closedEvents: 2,
      closedDecisionWindows: 2,
    },
    metrics: {
      closedOutcomes: 2,
      meanGrossCarryPairReturnPct: -0.6,
      winRatePct: 0,
      routeCostAdjustedClosedOutcomes: 2,
      fundingCashflowAccountedClosedOutcomes: 2,
    },
    thresholds: {
      minClosedOutcomes: 100,
      minNonOverlappingWindows: 3,
    },
    blockers: [
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
      'prospective_closed_outcomes_low:2<100',
      'prospective_closed_windows_low:2<3',
    ],
  }
}

function dynamicLeverageVolatilityGateStatus() {
  return {
    status: 'pass',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    checks: {
      volatilityPercentile: 0.85,
      realizedVolPct: 65,
      recommendedMaxLeverage: 1,
      currentMaxLeverage: 100,
      leverageBlocked: false,
      tier: 'high',
      tierDescription: 'High volatility regime; leverage capped at 1x with warning',
      lowTierProbe: { percentile: 0.10, maxLeverage: 3, blocked: false },
      normalTierProbe: { percentile: 0.50, maxLeverage: 1, blocked: false },
      highTierProbe: { percentile: 0.90, maxLeverage: 1, blocked: false },
      extremeTierProbe: { percentile: 0.99, maxLeverage: 0, blocked: true },
    },
    blockers: [],
  }
}

function pitAuditGlobalGateStatus() {
  return {
    status: 'watch',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    checks: {
      carryPitAuditStatus: 'pass',
      carryPitAuditPassingRows: 55101,
      carryPitAuditTotalRows: 55101,
      carryPitAuditPassRatePct: 100,
      carryFundingAvailableTimeStatus: 'complete',
      carryBasisAvailableTimeStatus: 'present',
      globalPitAuditImplemented: false,
      nonCarryStrategiesHavePitAudit: false,
    },
    blockers: ['pit_audit_not_global_only_carry_has_audit'],
  }
}

function routeCostModelCompletenessGateStatus() {
  return {
    status: 'watch',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    checks: {
      routesModeled: 4,
      routesWithFee: 4,
      routesWithSlippage: 4,
      routesWithAdverseSelection: 4,
      routesWithTotalCost: 4,
      routesWithMaxAllowedCost: 4,
      slippageTracked: true,
      adverseSelectionTracked: true,
      feeSnapshotSource: 'api',
      feeSnapshotVerifiedByRuntime: true,
      allRoutesModeled: true,
      allSlippageTracked: true,
      allAdverseSelectionTracked: true,
    },
    routeDetails: [
      { route: 'passive_passive', feeBps: 4, spreadBps: 2, slippageBps: 4, adverseSelectionBufferBps: 5, totalExpectedCostBps: 18, maxAllowedCostBps: 20 },
      { route: 'passive_taker', feeBps: 7, spreadBps: 4, slippageBps: 8, adverseSelectionBufferBps: 3, totalExpectedCostBps: 24, maxAllowedCostBps: 20 },
      { route: 'taker_taker', feeBps: 10, spreadBps: 6, slippageBps: 8, adverseSelectionBufferBps: 2, totalExpectedCostBps: 26, maxAllowedCostBps: 20 },
      { route: 'twap', feeBps: 10, spreadBps: 4, slippageBps: 10, adverseSelectionBufferBps: 3, totalExpectedCostBps: 27, maxAllowedCostBps: 20 },
    ],
    blockers: ['pit_audit_not_global_only_carry_has_audit'],
  }
}

function marketIntelNoOpenGateStatus() {
  return {
    status: 'pass',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    checks: {
      riskOffOpenContextStatus: 'risk_off',
      riskOffRejectReasons: ['context_status:risk_off'],
      severeNewsOpenContextStatus: 'severe_news',
      severeNewsRejectReasons: ['context_status:severe_news'],
      laneBlockedOpenContextStatus: 'lane_blocked',
      laneBlockedRejectReasons: ['context_status:lane_blocked'],
      symbolBlockedOpenContextStatus: 'symbol_blocked',
      symbolBlockedRejectReasons: ['context_status:symbol_blocked'],
      allowedOpenContextStatus: 'ok',
      allowedRejectReasons: [],
    },
    blockers: [],
  }
}

function crossSectionalConfigGateStatus() {
  return {
    status: 'pass',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    checks: {
      mtfWeight: { found: true, value: '0.35', verdict: 'needs_work' },
      funding: { found: true, value: '0.25', verdict: 'needs_work' },
      spread: { found: true, value: '5', verdict: 'needs_work' },
      regime: { found: false, value: 'no regime filter', verdict: 'needs_work' },
      confidence: { found: true, value: 'heuristic', verdict: 'needs_work' },
      volCeiling: { found: true, value: '0.90', verdict: 'needs_work' },
    },
    blockers: [],
  }
}

function volumeBreakoutConfigGateStatus() {
  return {
    status: 'pass',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    checks: {
      volumeMultiplier: { found: true, value: 2.5, verdict: 'ok', reason: 'adequate' },
      confidenceLogic: { found: true, verdict: 'needs_work', reason: 'shallow gradient', minConfidenceAtThreshold: 0.333, volumeComponentDynamicRange: 3.0 },
      stopLossPct: { found: true, value: 0.03, verdict: 'ok', reason: 'adequate' },
      minBreakQuality: { found: true, value: 0.35, verdict: 'ok', reason: 'adequate' },
    },
    blockers: [],
  }
}

function wfoStabilityGateStatus() {
  return {
    status: 'pass',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    checks: {
      wfoStability: { found: true, available: true, verdict: 'pass' },
      paramStability: { found: true, available: true, verdict: 'pass' },
      stabilityReporting: { found: true, available: true, verdict: 'pass' },
    },
    blockers: [],
  }
}

function portfolioRiskManagementGateStatus() {
  return {
    status: 'pass',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    checks: {
      portfolioRiskMgmt: { found: true, available: true, verdict: 'pass', details: ['Portfolio directory found'] },
      positionSizing: { found: true, available: true, verdict: 'pass', method: 'volTarget', targetVolPct: 15, maxPctOfEquity: 40, kellyFraction: null, layers: 3 },
      maxDrawdown: { found: true, available: true, verdict: 'pass', consecutiveLossDaysLimit: 5, dailyLossPctSoftCap: 3, maxDailyLossUsd: 1000 },
      correlationAware: { found: true, available: true, verdict: 'pass', methods: ['HCA'], details: ['HCA available'] },
    },
    blockers: [],
  }
}

function killSwitchGateStatusFixture() {
  return {
    status: 'pass',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    killSwitchEnabled: false,
    defaultPolicy: null,
    researchOnlyBlockedConsistent: true,
    checks: {
      killSwitchEnabled: { found: true, value: false, verdict: 'pass' },
      defaultPolicy: { found: true, value: null, verdict: 'pass' },
      consistentWithState: { found: true, value: true, verdict: 'pass' },
    },
    blockers: [],
  }
}

function accountCorruptionGateStatusFixture() {
  return {
    status: 'pass',
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    checks: {
      accountFilesExist: { found: true, count: 3, verdict: '3 account state file(s) found' },
      corruptFiles: { found: false, corruptCount: 0, verdict: 'All files parsed successfully' },
      failClosedMechanism: { found: false, verdict: 'No corruption detected' },
    },
    blockers: [],
  }
}
