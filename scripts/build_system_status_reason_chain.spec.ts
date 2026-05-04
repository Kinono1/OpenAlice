import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildSystemStatusReasonChainReport,
  parseSystemStatusReasonChainArgs,
  runSystemStatusReasonChain,
} from './build_system_status_reason_chain.js'

describe('build_system_status_reason_chain', () => {
  it('parses runtime defaults', () => {
    expect(parseSystemStatusReasonChainArgs([])).toMatchObject({
      runtimeDir: 'data/runtime',
      outputPath: 'data/runtime/system_status_reason_chain.latest.json',
      json: false,
    })
    expect(parseSystemStatusReasonChainArgs([
      '--runtimeDir',
      'tmp/runtime',
      '--outputPath',
      'null',
      '--json',
      'true',
    ])).toMatchObject({
      runtimeDir: 'tmp/runtime',
      outputPath: null,
      json: true,
    })
  })

  it('explains PAPER_ONLY blockers without authorizing execution', () => {
    const report = buildSystemStatusReasonChainReport({
      generatedAt: '2026-05-03T00:00:00.000Z',
      strategyPromotion: {
        researchGate: {
          hardBlocks: ['wfo_missing', 'fdr_missing'],
        },
        paperGate: {
          hardBlocks: [
            'p1_trial_ledger_not_valid:skeleton',
            'p1_gate_not_useful:insufficient_data',
            'p1_cost_model_quarantine',
            'p1_stop_loss_cluster:42',
            'p1_stop_loss_attribution_incomplete:0/42',
          ],
        },
      },
      releaseGateStatus: {
        allowPaperTrading: false,
        allowLiveTrading: false,
        failedChecks: ['wfo', 'significance'],
        checks: [{
          name: 'wfo',
          status: 'fail',
          summary: 'WFO gate failed.',
          metrics: {
            overallPassed: false,
            failedWindows: 3,
            windowCount: 3,
            failedWindowRatio: 1,
            failWindowRatioThreshold: 0.3,
          },
        }],
      },
      phaseReadiness: {
        paper: {
          blockingReasons: ['paper_research_not_approved'],
        },
      },
      paperGateStatus: {
        finalAllowPaperTrading: false,
        championLoaded: false,
        policyVersionMatch: false,
        paperExecutorEnabled: false,
        blockingReasons: ['paper_research_not_approved'],
      },
      paperExecutorStatus: {
        executionPlanKind: 'blocked',
        blockingReasons: ['release_gate_not_approved'],
        portfolioPlan: {
          targetSymbolCount: 0,
          rebalanceEntryCount: 0,
          walletOperationCount: 0,
        },
      },
      p1CostModelDiagnostics: {
        quarantine: true,
        quarantineReasons: ['low_cost_prediction_sample'],
        newWindow: {
          status: 'insufficient_data',
          reason: 'awaiting_post_enforcement_closed_trades',
          closedTrades: 0,
        },
        openPositionReadiness: {
          status: 'blocked_new_missing_evidence',
          totalOpenPositions: 4,
          newOpenPositions: 1,
          producerGuardOpenPositions: 1,
          missingPredictedOpenEvidence: 4,
          legacyMissingPredictedOpenEvidence: 3,
          newMissingPredictedOpenEvidence: 1,
          transitionalDirtyMissingPredictedOpenEvidence: 0,
          producerGuardMissingPredictedOpenEvidence: 1,
          newMissingPredictedOpenEvidenceByField: [
            { field: 'expected_gross_edge_pct', missingPositions: 1 },
            { field: 'mark_match_penalty_bps', missingPositions: 1 },
          ],
          legacyOpenPositions: 3,
        },
        routeCostShadowEligibility: {
          diagnosticOnly: true,
          promotionEligible: false,
          paperExecutionAllowed: false,
          routeBudgetStatus: 'exceeded',
          selectedRoute: 'taker_taker',
          blockers: [
            'route_cost_shadow_eligibility_diagnostic_only',
            'route_cost_budget_exceeded:taker_taker',
          ],
        },
      },
      p1GateEffectiveness: {
        gateStatus: 'insufficient_data',
        costCoverageAttribution: {
          topPatchTargets: [
            {
              producerGuardStatus: 'producer_guard_enforced',
              missingPredictedCost: 1,
            },
            {
              producerGuardStatus: 'transitional_dirty_open',
              missingPredictedCost: 1,
            },
          ],
          cohorts: [
            {
              producerGuardMissingCompletePredictedOpenEvidence: 2,
            },
          ],
        },
      },
      p1TrialLedger: {
        status: 'skeleton',
        readinessGaps: {
          blockerSummary: ['pit_proxy_only_trials:9'],
        },
      },
      metaLabelingShadowReadiness: {
        status: 'blocked',
        trainingAllowed: false,
        blockers: [
          'gate_status_not_useful:insufficient_data',
          'accepted_cost_coverage_below_minimum:0<95',
        ],
      },
      icMonitorStatus: {
        status: 'warmup',
        promotionEligible: false,
        sampleCountTotal: 12,
        returnCount: 12,
        factorCount: 2,
        minimumSampleCount: 50,
        warmupWindowsRequired: 3,
        warmupWindowsObserved: 2,
        blockingReasons: ['ic_sample_count_below_minimum:12<50', 'ic_warmup_windows_below_minimum:2<3'],
        nextActions: ['Continue shadow collection until sampleCount and warmup windows meet minimum thresholds.'],
      },
      dirtyWorktreeAudit: {
        counts: {
          total: 594,
        },
      },
      runtimeManifestCoverage: {
        status: 'blocked',
        blockingReasons: [
          'manifest_missing:paperExecutorStatus',
          'manifest_hash_mismatch:phaseReadiness',
        ],
      },
      externalDerivativesCollect: {
        dryRun: false,
        appendedRows: 16,
      },
      paperPolicyShadowSettle: {
        counts: {
          appendedOutcomes: 0,
        },
      },
      cpBridge: {
        generated_at: '2026-05-02T23:59:00.000Z',
        cp_cycle_id: '20260503-000000',
        cp_truth_status: 'unknown',
        source: 'currencypurchases',
        mode: 'observation',
        signals: [
          { signal_id: 'CP-1', target_position_pct: 0, as_of: '2026-05-02T23:59:30.000Z', ttl_ms: 120000 },
          { signal_id: 'CP-2', target_position_pct: 0, as_of: '2026-05-02T23:59:20.000Z', ttl_ms: 120000 },
          { signal_id: 'CP-3', target_position_pct: 0, as_of: '2026-05-02T23:00:00.000Z', ttl_ms: 120000 },
          { signal_id: 'CP-4', target_position_pct: 0, as_of: 'not-a-date', ttl_ms: 120000 },
          { signal_id: 'CP-5', target_position_pct: 0, as_of: '2026-05-02T23:59:00.000Z', ttl_ms: 0 },
        ],
      },
      cpTraceLines: [
        JSON.stringify({ step: 'stale', status: 'alert', meta: { ageMs: 3600001 } }),
        JSON.stringify({ step: 'local_gate', status: 'reject', meta: { reason: 'ttl_expired' } }),
      ],
      sourceArtifacts: {
        strategyPromotion: 'data/runtime/strategy_promotion.latest.json',
        releaseGateStatus: 'data/runtime/release_gate_status.json',
        phaseReadiness: 'data/runtime/phase_readiness.latest.json',
        paperGateStatus: 'data/runtime/paper_gate_status.json',
        paperExecutorStatus: 'data/runtime/paper_executor_status.latest.json',
        p1CostModelDiagnostics: 'data/runtime/p1_trading_evidence/cost_model_diagnostics.latest.json',
        p1GateEffectiveness: 'data/runtime/p1_trading_evidence/gate_effectiveness_report.latest.json',
        p1TrialLedger: 'data/runtime/p1_trading_evidence/trial_ledger.latest.json',
        p1TrialSourceCoverage: 'data/runtime/p1_trading_evidence/trial_source_coverage.latest.json',
        routeCostBudget: 'data/runtime/route_cost_budget.latest.json',
        feeSnapshot: 'data/runtime/fee_snapshot.latest.json',
        metaLabelingShadowReadiness: 'data/runtime/meta_labeling_shadow_readiness.latest.json',
        dirtyWorktreeAudit: 'data/runtime/dirty_worktree_audit.latest.json',
        runtimeManifestCoverage: 'data/runtime/runtime_manifest_coverage.latest.json',
        externalDerivativesCollect: 'data/runtime/external_derivatives_data_collect.latest.json',
        paperPolicyShadowSettle: 'data/runtime/paper_policy_shadow_settle.latest.json',
        cpTrace: 'data/runtime/cp_signal_trace.ndjson',
        cpBridge: '/tmp/openalice_signals.json',
        icRuntimeStatus: 'data/runtime/ic_monitor_status.latest.json',
      },
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-03T00:00:00.000Z',
      declaredStatus: 'PAPER_ONLY',
      effectiveActionability: 'research_only_blocked',
      liveTradingAllowed: false,
      paperTradingAllowed: false,
      canPromote: false,
    })
    expect(report.overallPlanCompletionPct).toBeGreaterThanOrEqual(40)
    expect(report.overallPlanCompletionPct).toBeLessThan(60)
    expect(report.planCompletion.find(phase => phase.phase === 'P0')?.items.find(item => item.id === 'P0-A')).toMatchObject({
      blockers: expect.arrayContaining([
        'dirty_worktree_entries:594',
        'runtime_manifest_coverage_status:blocked',
        'runtime_manifest:manifest_missing:paperExecutorStatus',
        'runtime_manifest:manifest_hash_mismatch:phaseReadiness',
      ]),
      evidencePaths: expect.arrayContaining([
        'data/runtime/dirty_worktree_audit.latest.json',
        'data/runtime/runtime_manifest_coverage.latest.json',
      ]),
    })
    expect(report.governance).toMatchObject({
      promotionAllowedByThisArtifact: false,
      liveTradingAllowedByThisArtifact: false,
      paperExecutionAllowedByThisArtifact: false,
    })
    expect(report.reasonChain.map(reason => [reason.component, reason.status])).toEqual([
      ['WFO', 'not_available'],
      ['IC', 'not_available_warmup'],
      ['Allocator', 'blocked'],
      ['CP bridge', 'observation_only'],
    ])
    expect(report.reasonChain.find(reason => reason.component === 'WFO')?.blockingReasons).toEqual(
      expect.arrayContaining(['release_gate_wfo_status:fail', 'research:wfo_missing']),
    )
    expect(report.reasonChain.find(reason => reason.component === 'WFO')?.metrics).toMatchObject({
      failureMode: 'failed_by_window_ratio',
      passedWindows: 0,
      failedWindows: 3,
      windowCount: 3,
      failedWindowRatio: 1,
      failWindowRatioThreshold: 0.3,
      failedWindowRatioOverThreshold: true,
    })
    expect(report.reasonChain.find(reason => reason.component === 'IC')?.metrics).toMatchObject({
      status: 'warmup',
      promotionEligible: false,
      sampleCountTotal: 12,
      returnCount: 12,
      factorCount: 2,
      minimumSampleCount: 50,
      sampleThresholdPassed: false,
      warmupWindowsRequired: 3,
      warmupWindowsObserved: 2,
      warmupThresholdPassed: false,
      decayedFactorCount: 0,
      decayedSymbolCount: 0,
      decayedPairCount: 0,
    })
    expect(report.reasonChain.find(reason => reason.component === 'Allocator')?.metrics).toMatchObject({
      blockingReasonBuckets: {
        paper_gate: 1,
        promotion_release: 1,
        paper_quality: 0,
        p1_evidence_trust: 1,
        allocator_state: 3,
        config_disabled: 1,
        other: 0,
      },
    })
    expect(report.reasonChain.find(reason => reason.component === 'CP bridge')?.metrics).toMatchObject({
      mode: 'observation',
      signalCount: 5,
      positiveTargets: 0,
      zeroTargetSignalCount: 5,
      ticketIntentSignalCount: 0,
      modeTargetConsistency: 'consistent',
      ticketExecutionCapability: 'not_wired',
      paperExecutionAllowedByCpBridge: false,
      bridgeGeneratedAt: '2026-05-02T23:59:00.000Z',
      cpCycleId: '20260503-000000',
      cpTruthStatus: 'unknown',
      bridgeSource: 'currencypurchases',
      maxSignalAgeMs: 3600001,
      currentPayloadMaxAgeMs: 3600000,
      currentPayloadFreshSignalCount: 2,
      currentPayloadTtlExpiredSignalCount: 1,
      currentPayloadInvalidTimestampCount: 1,
      currentPayloadInvalidTtlCount: 1,
      ttlExpiredSignalCount: 1,
      latestTraceAgeMs: null,
      recentStaleAlerts: 1,
      latestRejectReasons: ['ttl_expired'],
    })
    expect(report.planCompletion.find(phase => phase.phase === 'P0')?.status).toBe('blocked')
    expect(report.planCompletion.find(phase => phase.phase === 'P0')?.items.find(item => item.id === 'P0-E')?.blockers).toEqual(
      expect.arrayContaining([
        'p1_cost_new_window_reason:awaiting_post_enforcement_closed_trades',
        'p1_open_position_readiness:blocked_new_missing_evidence',
        'p1_open_positions_missing_predicted_open_evidence:4',
        'p1_open_positions_legacy_missing_predicted_open_evidence:3',
        'p1_open_positions_new_missing_predicted_open_evidence:1',
        'p1_open_positions_producer_guard_missing_predicted_open_evidence:1',
        'p1_open_positions_new_missing_field:expected_gross_edge_pct:1',
        'p1_open_positions_new_missing_field:mark_match_penalty_bps:1',
      ]),
    )
    expect(report.planCompletion.find(phase => phase.phase === 'P1')?.items.find(item => item.id === 'P1-D')?.blockers).toEqual(
      expect.arrayContaining(['p1_stop_loss_cluster:42', 'p1_stop_loss_attribution_incomplete:0/42']),
    )
    expect(report.planCompletion.find(phase => phase.phase === 'P1')?.items.find(item => item.id === 'P1-A')?.blockers).toEqual(
      expect.arrayContaining(['trial_ledger_readiness:pit_proxy_only_trials:9']),
    )
    expect(report.planCompletion.find(phase => phase.phase === 'P1')?.items.find(item => item.id === 'P1-A')?.evidencePaths).toEqual(
      expect.arrayContaining(['data/runtime/p1_trading_evidence/trial_source_coverage.latest.json']),
    )
    expect(report.planCompletion.find(phase => phase.phase === 'P1')?.items.find(item => item.id === 'P1-A')?.nextActions[0]).toContain(
      'trial_source_coverage.latest.json',
    )
    expect(report.planCompletion.find(phase => phase.phase === 'P1')?.items.find(item => item.id === 'P1-B')).toMatchObject({
      status: 'blocked',
      blockers: expect.arrayContaining([
        'p1_gate_status:insufficient_data',
        'p1_gate_cost_coverage_patch_targets:2',
        'p1_gate_producer_guard_missing_cost_targets:1',
        'p1_gate_producer_guard_missing_complete_predicted_open_evidence:2',
      ]),
    })
    expect(report.planCompletion.find(phase => phase.phase === 'P1')?.items.find(item => item.id === 'P1-C')).toMatchObject({
      status: 'blocked',
      evidencePaths: expect.arrayContaining([
        'data/runtime/p1_trading_evidence/cost_model_diagnostics.latest.json',
        'data/runtime/route_cost_budget.latest.json',
      ]),
      blockers: expect.arrayContaining([
        'low_cost_prediction_sample',
        'route_cost_shadow_budget_status:exceeded',
        'route_cost_shadow_eligibility_diagnostic_only',
        'route_cost_budget_exceeded:taker_taker',
      ]),
    })
    expect(report.planCompletion.find(phase => phase.phase === 'P1.5')?.status).toBe('blocked')
    expect(report.planCompletion.find(phase => phase.phase === 'P1.5')?.items.find(item => item.id === 'P1.5-A')?.blockers).toEqual(
      expect.arrayContaining([
        'meta_labeling_status:blocked',
        'gate_status_not_useful:insufficient_data',
        'accepted_cost_coverage_below_minimum:0<95',
      ]),
    )
    expect(report.planCompletion.find(phase => phase.phase === 'P2')?.status).toBe('blocked')
  })

  it('labels pre-producer-guard open evidence gaps as transitional dirty blockers', () => {
    const report = buildSystemStatusReasonChainReport({
      p1CostModelDiagnostics: {
        newWindow: {
          status: 'insufficient_data',
          reason: 'awaiting_post_enforcement_closed_trades',
          closedTrades: 0,
        },
        openPositionReadiness: {
          status: 'blocked_legacy_dirty_opens',
          totalOpenPositions: 3,
          legacyOpenPositions: 0,
          newOpenPositions: 3,
          producerGuardOpenPositions: 0,
          missingPredictedOpenEvidence: 3,
          legacyMissingPredictedOpenEvidence: 0,
          newMissingPredictedOpenEvidence: 3,
          transitionalDirtyMissingPredictedOpenEvidence: 3,
          producerGuardMissingPredictedOpenEvidence: 0,
          newMissingPredictedOpenEvidenceByField: [
            { field: 'expected_gross_edge_pct', missingPositions: 3 },
          ],
        },
      },
      generatedAt: '2026-05-04T00:00:00.000Z',
    })

    const p0e = report.planCompletion
      .find(phase => phase.phase === 'P0')
      ?.items.find(item => item.id === 'P0-E')
    expect(p0e?.blockers).toEqual(expect.arrayContaining([
      'p1_open_position_readiness:blocked_legacy_dirty_opens',
      'p1_open_positions_new_missing_predicted_open_evidence:3',
      'p1_open_positions_transitional_dirty_missing_predicted_open_evidence:3',
      'p1_open_positions_transitional_dirty_missing_field:expected_gross_edge_pct:3',
    ]))
    expect(p0e?.blockers).not.toContain('p1_open_positions_producer_guard_missing_predicted_open_evidence:3')
    expect(p0e?.nextActions.join('\n')).toContain('transitional dirty opens')
  })

  it('keeps allocator blocked unless production risk policy is a deny-only ready brake', () => {
    const cases = [
      {
        name: 'missing policy',
        productionRiskPolicy: undefined,
        expectedBlocker: 'production_risk_policy_missing',
      },
      {
        name: 'blocked policy',
        productionRiskPolicy: {
          status: 'blocked',
          mode: 'fail_closed_deny_only',
          paperExecutionAllowedByThisArtifact: false,
          liveExecutionAllowedByThisArtifact: false,
          blockers: ['source_evidence_not_trusted:quarantine'],
        },
        expectedBlocker: 'production_risk_policy_not_ready:blocked',
      },
      {
        name: 'quarantined source blocker',
        productionRiskPolicy: {
          status: 'ready_deny_only',
          mode: 'fail_closed_deny_only',
          paperExecutionAllowedByThisArtifact: false,
          liveExecutionAllowedByThisArtifact: false,
          blockers: ['source_evidence_not_trusted:quarantine'],
        },
        expectedBlocker: 'production_risk_policy:source_evidence_not_trusted:quarantine',
      },
      {
        name: 'invalid mode',
        productionRiskPolicy: {
          status: 'ready_deny_only',
          mode: 'authorize_and_trade',
          paperExecutionAllowedByThisArtifact: false,
          liveExecutionAllowedByThisArtifact: false,
          blockers: [],
        },
        expectedBlocker: 'production_risk_policy_mode_invalid:authorize_and_trade',
      },
      {
        name: 'paper authorization attempt',
        productionRiskPolicy: {
          status: 'ready_deny_only',
          mode: 'fail_closed_deny_only',
          paperExecutionAllowedByThisArtifact: true,
          liveExecutionAllowedByThisArtifact: false,
          blockers: [],
        },
        expectedBlocker: 'production_risk_policy_must_not_authorize_execution',
      },
      {
        name: 'live authorization attempt',
        productionRiskPolicy: {
          status: 'ready_deny_only',
          mode: 'fail_closed_deny_only',
          paperExecutionAllowedByThisArtifact: false,
          liveExecutionAllowedByThisArtifact: true,
          blockers: [],
        },
        expectedBlocker: 'production_risk_policy_must_not_authorize_execution',
      },
    ]

    for (const testCase of cases) {
      const report = buildSystemStatusReasonChainReport(buildAllocatorReadyFixture({
        productionRiskPolicy: testCase.productionRiskPolicy,
      }))
      const allocator = getAllocatorReason(report)

      expect(allocator, testCase.name).toMatchObject({
        status: 'blocked',
        usableForPromotion: false,
        usableForPaperExecution: false,
        blockingReasons: expect.arrayContaining([testCase.expectedBlocker]),
        metrics: {
          finalAllowPaperTrading: true,
          championLoaded: true,
          policyVersionMatch: true,
          paperExecutorEnabled: true,
          targetSymbolCount: 2,
          productionRiskPolicyReady: false,
        },
      })
    }
  })

  it('allows allocator availability only when the deny-only production risk brake is ready', () => {
    const report = buildSystemStatusReasonChainReport(buildAllocatorReadyFixture({
      productionRiskPolicy: {
        status: 'ready_deny_only',
        mode: 'fail_closed_deny_only',
        paperExecutionAllowedByThisArtifact: false,
        liveExecutionAllowedByThisArtifact: false,
        blockers: [],
        denyRuleCount: 1,
        cooldownRuleCount: 0,
        downweightRuleCount: 0,
        shadowOnlyRuleCount: 0,
      },
    }))
    const allocator = getAllocatorReason(report)

    expect(allocator).toMatchObject({
      status: 'available',
      usableForPromotion: true,
      usableForPaperExecution: true,
      blockingReasons: [],
      metrics: {
        finalAllowPaperTrading: true,
        championLoaded: true,
        policyVersionMatch: true,
        paperExecutorEnabled: true,
        targetSymbolCount: 2,
        productionRiskPolicyStatus: 'ready_deny_only',
        productionRiskPolicyMode: 'fail_closed_deny_only',
        productionRiskPolicyReady: true,
        paperExecutionAllowedByRiskPolicy: false,
        liveExecutionAllowedByRiskPolicy: false,
      },
    })
  })

  it('keeps CP bridge ticket intent blocked and reports mode/target mismatch diagnostics', () => {
    const sourceArtifacts = {
      strategyPromotion: 'strategy.json',
      releaseGateStatus: 'release.json',
      phaseReadiness: 'phase.json',
      paperGateStatus: 'paper_gate.json',
      paperExecutorStatus: 'executor.json',
      p1CostModelDiagnostics: 'cost.json',
      p1GateEffectiveness: 'gate.json',
      p1TrialLedger: 'ledger.json',
      p1TrialSourceCoverage: 'trial_source.json',
      routeCostBudget: 'route.json',
      feeSnapshot: 'fee.json',
      metaLabelingShadowReadiness: 'meta.json',
      dirtyWorktreeAudit: 'dirty.json',
      runtimeManifestCoverage: 'manifest.json',
      externalDerivativesCollect: 'external.json',
      paperPolicyShadowSettle: 'settle.json',
      cpTrace: 'trace.ndjson',
      cpBridge: 'cp.json',
      icRuntimeStatus: 'ic.json',
    }

    const ticket = buildSystemStatusReasonChainReport({
      generatedAt: '2026-05-04T00:00:00.000Z',
      cpBridge: {
        generated_at: '2026-05-04T00:00:00.000Z',
        mode: 'ticket',
        signals: [{
          signal_id: 'CP-TICKET',
          target_position_pct: 0.1,
          as_of: '2026-05-03T23:59:00.000Z',
          ttl_ms: 120000,
        }],
      },
      cpTraceLines: [],
      sourceArtifacts,
    })
    const ticketReason = ticket.reasonChain.find(reason => reason.component === 'CP bridge')
    expect(ticketReason).toMatchObject({
      status: 'blocked',
      usableForPaperExecution: false,
      blockingReasons: expect.arrayContaining([
        'cp_bridge_mode:ticket',
        'cp_ticket_mode_execution_pipeline_pending',
      ]),
      metrics: {
        positiveTargets: 1,
        ticketIntentSignalCount: 1,
        modeTargetConsistency: 'consistent',
        ticketExecutionCapability: 'not_wired',
        paperExecutionAllowedByCpBridge: false,
        currentPayloadFreshSignalCount: 1,
      },
    })

    const mismatch = buildSystemStatusReasonChainReport({
      generatedAt: '2026-05-04T00:00:00.000Z',
      cpBridge: {
        generated_at: '2026-05-04T00:00:00.000Z',
        mode: 'observation',
        signals: [{
          signal_id: 'CP-MISMATCH',
          target_position_pct: 0.1,
          as_of: '2026-05-03T23:59:00.000Z',
          ttl_ms: 120000,
        }],
      },
      cpTraceLines: [],
      sourceArtifacts,
    })
    const mismatchReason = mismatch.reasonChain.find(reason => reason.component === 'CP bridge')
    expect(mismatchReason).toMatchObject({
      status: 'observation_only',
      usableForPaperExecution: false,
      blockingReasons: expect.arrayContaining([
        'cp_bridge_mode:observation',
        'cp_bridge_mode_target_mismatch:observation_nonzero_target',
        'cp_ticket_mode_execution_pipeline_pending',
      ]),
      metrics: {
        positiveTargets: 1,
        ticketIntentSignalCount: 0,
        modeTargetConsistency: 'observation_nonzero_target',
        paperExecutionAllowedByCpBridge: false,
      },
    })
  })

  it('writes a status artifact and manifest', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'system-status-reason-chain-'))
    const p1Dir = join(runtimeDir, 'p1_trading_evidence')
    await mkdir(p1Dir, { recursive: true })
    await writeJson(join(runtimeDir, 'strategy_promotion.latest.json'), {
      researchGate: { hardBlocks: ['wfo_missing'] },
      paperGate: { hardBlocks: ['p1_gate_not_useful:insufficient_data'] },
    })
    await writeJson(join(runtimeDir, 'release_gate_status.json'), {
      allowPaperTrading: false,
      allowLiveTrading: false,
      failedChecks: ['wfo'],
      checks: [{ name: 'wfo', status: 'fail', summary: 'WFO failed', metrics: {} }],
    })
    await writeJson(join(runtimeDir, 'phase_readiness.latest.json'), {
      paper: { blockingReasons: ['paper_research_not_approved'] },
    })
    await writeJson(join(runtimeDir, 'paper_gate_status.json'), {
      finalAllowPaperTrading: false,
      championLoaded: false,
      policyVersionMatch: false,
      paperExecutorEnabled: false,
      blockingReasons: ['paper_research_not_approved'],
    })
    await writeJson(join(runtimeDir, 'paper_executor_status.latest.json'), {
      executionPlanKind: 'blocked',
      blockingReasons: ['release_gate_not_approved'],
      portfolioPlan: { targetSymbolCount: 0 },
    })
    await writeJson(join(runtimeDir, 'dirty_worktree_audit.latest.json'), { counts: { total: 1 } })
    await writeJson(join(runtimeDir, 'runtime_manifest_coverage.latest.json'), {
      status: 'blocked',
      blockingReasons: ['manifest_missing:paperExecutorStatus'],
    })
    await writeJson(join(runtimeDir, 'external_derivatives_data_collect.latest.json'), { dryRun: false, appendedRows: 1 })
    await writeJson(join(runtimeDir, 'paper_policy_shadow_settle.latest.json'), { counts: { appendedOutcomes: 0 } })
    await writeJson(join(p1Dir, 'cost_model_diagnostics.latest.json'), {
      quarantine: true,
      quarantineReasons: ['low_cost_prediction_sample'],
      newWindow: { status: 'insufficient_data', closedTrades: 0 },
    })
    await writeJson(join(p1Dir, 'gate_effectiveness_report.latest.json'), { gateStatus: 'insufficient_data' })
    await writeJson(join(p1Dir, 'trial_ledger.latest.json'), { status: 'skeleton' })
    await writeJson(join(runtimeDir, 'ic_monitor_status.latest.json'), {
      status: 'missing_snapshot',
      promotionEligible: false,
      sampleCountTotal: 0,
      returnCount: 0,
      factorCount: 0,
      minimumSampleCount: 50,
      warmupWindowsRequired: 3,
      warmupWindowsObserved: 0,
      blockingReasons: ['ic_monitor_snapshot_missing'],
      nextActions: ['Persist runtime icMonitorSnapshot from evaluateRuntimeFactorSnapshot into data/runtime/ic_monitor_snapshot.latest.json.'],
    })
    const cpBridgePath = join(runtimeDir, 'openalice_signals.json')
    await writeJson(cpBridgePath, {
      mode: 'observation',
      signals: [{ target_position_pct: 0 }],
    })
    await writeFile(join(runtimeDir, 'cp_signal_trace.ndjson'), `${JSON.stringify({
      step: 'local_gate',
      status: 'reject',
      meta: { reason: 'ttl_expired' },
    })}\n`, 'utf-8')
    const outputPath = join(runtimeDir, 'system_status_reason_chain.latest.json')

    const report = await runSystemStatusReasonChain({
      runtimeDir,
      outputPath,
      cpBridgePath,
      json: true,
    })

    expect(report.declaredStatus).toBe('PAPER_ONLY')
    const persisted = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(persisted.reasonChain).toHaveLength(4)
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(manifest).toMatchObject({
      job: 'system_status_reason_chain',
      exitCode: 0,
      businessStatus: 'warn',
      recordsIn: 4,
    })
  })

  it('surfaces decayed IC factor/symbol counts without changing fail-closed status', () => {
    const report = buildSystemStatusReasonChainReport({
      generatedAt: '2026-05-03T00:00:00.000Z',
      releaseGateStatus: {
        checks: [{ name: 'wfo', status: 'pass', metrics: { overallPassed: true, failedWindows: 0, windowCount: 3 } }],
      },
      paperGateStatus: {
        finalAllowPaperTrading: false,
        championLoaded: false,
        policyVersionMatch: false,
        paperExecutorEnabled: false,
      },
      paperExecutorStatus: {
        executionPlanKind: 'blocked',
        portfolioPlan: { targetSymbolCount: 0 },
      },
      icMonitorStatus: {
        status: 'decayed',
        promotionEligible: false,
        sampleCountTotal: 2895,
        returnCount: 579,
        factorCount: 5,
        minimumSampleCount: 50,
        warmupWindowsRequired: 3,
        warmupWindowsObserved: 579,
        blockingReasons: [
          'symbol:BTC-USDT:factor:momentum-composite:ic_decay_status:decayed',
          'symbol:ETH-USDT:factor:momentum-composite:ic_decay_status:decayed',
          'symbol:ETH-USDT:factor:mean-reversion:ic_decay_status:decayed',
        ],
      },
      cpBridge: {
        mode: 'observation',
        signals: [],
      },
      cpTraceLines: [],
    })

    expect(report.reasonChain.find(reason => reason.component === 'IC')).toMatchObject({
      status: 'not_available',
      usableForPromotion: false,
      usableForPaperExecution: false,
      metrics: {
        sampleThresholdPassed: true,
        warmupThresholdPassed: true,
        decayedFactorCount: 2,
        decayedSymbolCount: 2,
        decayedPairCount: 3,
        decayedSymbols: ['BTC-USDT', 'ETH-USDT'],
        decayedFactors: ['mean-reversion', 'momentum-composite'],
      },
    })
  })
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

function buildAllocatorReadyFixture(overrides: { productionRiskPolicy?: unknown }) {
  return {
    generatedAt: '2026-05-04T00:00:00.000Z',
    releaseGateStatus: {
      checks: [{ name: 'wfo', status: 'pass', metrics: { overallPassed: true, failedWindows: 0, windowCount: 3 } }],
    },
    paperGateStatus: {
      finalAllowPaperTrading: true,
      championLoaded: true,
      policyVersionMatch: true,
      paperExecutorEnabled: true,
      blockingReasons: [],
    },
    phaseReadiness: {
      paper: {
        blockingReasons: [],
      },
    },
    paperExecutorStatus: {
      executionPlanKind: 'rebalance',
      blockingReasons: [],
      portfolioPlan: {
        targetSymbolCount: 2,
        rebalanceEntryCount: 2,
        walletOperationCount: 0,
      },
    },
    productionRiskPolicy: overrides.productionRiskPolicy,
    icMonitorStatus: {
      status: 'ready',
      promotionEligible: true,
      sampleCountTotal: 120,
      returnCount: 120,
      factorCount: 2,
      minimumSampleCount: 50,
      warmupWindowsRequired: 3,
      warmupWindowsObserved: 3,
      blockingReasons: [],
    },
    cpBridge: {
      mode: 'observation',
      signals: [],
    },
    cpTraceLines: [],
  }
}

function getAllocatorReason(report: ReturnType<typeof buildSystemStatusReasonChainReport>) {
  const allocator = report.reasonChain.find(reason => reason.component === 'Allocator')
  expect(allocator).toBeDefined()
  return allocator!
}
