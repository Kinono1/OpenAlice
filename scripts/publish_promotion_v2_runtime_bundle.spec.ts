import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  PROMOTION_V2_SCHEMA_VERSION,
  evaluatePromotionReadinessForPaperOrders,
  hashJson,
  sha256Hex,
  type CandidateRegistry,
  type SchemaMeta,
} from '../src/runtime/promotion_v2.js'
import {
  tryLoadValidatedPromotionReadinessV2,
  writePromotionV2RuntimeArtifacts,
} from '../src/runtime/promotion_v2_artifacts.js'
import {
  buildPromotionV2RuntimeArtifactsFromInputs,
  buildP1TradingEvidenceSnapshot,
  buildStrategyLanePolicySnapshot,
  parsePublishPromotionV2Args,
  readP1TradingEvidenceSnapshot,
} from './publish_promotion_v2_runtime_bundle.js'
import {
  buildPaperEvidenceReport,
  paperEvidenceReportToJson,
  type LatestPaperEvidencePointer,
  type PaperEvidenceLedgerEntry,
  type PaperEvidenceReport,
} from '../src/runtime/paper_evidence_ledger.js'

describe('publish_promotion_v2_runtime_bundle', () => {
  it('parses default runtime paths', () => {
    expect(parsePublishPromotionV2Args([])).toMatchObject({
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      bestConfigPath: 'data/research/best_config.json',
      releaseGateStatusPath: 'data/runtime/release_gate_status.json',
      feeSnapshotPath: 'data/runtime/fee_snapshot.latest.json',
      dirtyWorktreeAuditPath: 'data/runtime/dirty_worktree_audit.latest.json',
      dirtyWorktreeManifestPath: 'data/runtime/dirty_worktree_audit.latest.json.manifest.json',
      paperEvidencePointerPath: 'runtime/paper/latest_pointer.json',
      paperEvidenceLedgerPath: 'runtime/paper/evidence_ledger.jsonl',
      p1EvidenceIndexPath: 'data/runtime/p1_trading_evidence/p1_trading_evidence.index.latest.json',
      strategyLanePolicyPath: 'data/runtime/strategy_lane_policy.latest.json',
    })
  })

  it('converts the latest paper decision into a conservative v2.6 artifact bundle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-promotion-v2-'))
    const paperDecisionPath = join(dir, 'paper_decision.latest.json')
    const paperDecision = makePaperDecision()
    const paperDecisionRaw = `${JSON.stringify(paperDecision, null, 2)}\n`
    const paperEvidence = makePaperEvidence(dir, paperDecision)
    await writeFile(paperDecisionPath, paperDecisionRaw, 'utf-8')

    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: dir,
      paperDecisionPath,
      paperDecisionRaw,
      paperDecision,
      bestConfig: {
        experimentId: 'experiment-1',
        config: paperDecision.bestConfigEvidence,
      },
      releaseGateStatus: {
        version: 1,
        generatedAt: '2026-04-30T11:00:00.000Z',
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: [],
        warningChecks: [],
        expiresAt: '2026-05-01T12:00:00.000Z',
      },
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...makeCleanDirtyWorktreeEvidence(),
      ...paperEvidence,
    })

    expect(result.artifacts.evidenceLedger[0]).toMatchObject({
      dataOrigin: 'paper_live_sync',
      artifactPath: paperDecisionPath,
    })
    expect(result.artifacts.evidenceLedger[1]).toMatchObject({
      dataOrigin: 'paper_live_sync',
      evidenceType: 'paper',
      artifactPath: paperEvidence.paperEvidencePointer.path,
      metricSnapshot: {
        paperEvidenceFreshnessStatus: 'fresh',
        paperEvidenceDataMode: 'live_only',
      },
    })
    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).not.toContain(
      'paper_evidence_source_summary_hash_mismatch',
    )
    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).not.toContain(
      'paper_evidence_decision_hash_mismatch',
    )
    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).not.toContain(
      'missing_paper_evidence_ledger',
    )
    expect(result.readiness.finalVerdict).toBe('research_only')
    expect(result.readiness.humanReadableReason).toContain('research:wfo_missing')
    expect(result.artifacts.failureAttribution[0]).toMatchObject({
      candidateId: 'candidate-1',
      primaryFailure: 'benchmark_underperform',
    })

    await writePromotionV2RuntimeArtifacts(dir, result.artifacts)
    const loaded = await tryLoadValidatedPromotionReadinessV2(dir, {
      now: new Date('2026-04-30T12:00:00.000Z'),
    })
    expect(loaded.kind).toBe('invalid')
    expect(loaded.readiness?.finalVerdict).toBe('research_only')
    expect(loaded.error).toContain('monetization:simple_benchmark_pass_count_below_2')
  })

  it('preserves fresh runtime-verified fee snapshots instead of overwriting them with manual fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-promotion-v2-fees-'))
    const paperDecisionPath = join(dir, 'paper_decision.latest.json')
    const paperDecision = makePaperDecision()
    const paperDecisionRaw = `${JSON.stringify(paperDecision, null, 2)}\n`
    const paperEvidence = makePaperEvidence(dir, paperDecision)
    await writeFile(paperDecisionPath, paperDecisionRaw, 'utf-8')

    const runtimeFeeSnapshot = {
      venue: 'okx',
      symbol: 'cross_sectional_universe',
      instrumentType: 'crypto_perpetual',
      accountTier: 'runtime',
      makerFeeBps: 1,
      takerFeeBps: 4,
      source: 'api' as const,
      sourceFetchedAt: '2026-04-30T11:59:00.000Z',
      expiresAt: '2026-04-30T13:00:00.000Z',
      verifiedByRuntime: true,
      fundingIntervalHours: 8,
      fundingCapBps: 0,
      fundingFloorBps: 0,
    }

    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: dir,
      paperDecisionPath,
      paperDecisionRaw,
      paperDecision,
      bestConfig: {
        experimentId: 'experiment-1',
        config: paperDecision.bestConfigEvidence,
      },
      releaseGateStatus: {
        version: 1,
        generatedAt: '2026-04-30T11:00:00.000Z',
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: [],
        warningChecks: [],
        expiresAt: '2026-05-01T12:00:00.000Z',
      },
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      existingFeeSnapshot: runtimeFeeSnapshot,
      ...paperEvidence,
    })

    expect(result.artifacts.feeSnapshot).toMatchObject({
      venue: 'okx',
      source: 'api',
      verifiedByRuntime: true,
      makerFeeBps: 1,
      takerFeeBps: 4,
    })
    expect(result.artifacts.routeCostBudget.feeSnapshot).toMatchObject({
      venue: 'okx',
      source: 'api',
      verifiedByRuntime: true,
    })

    await writePromotionV2RuntimeArtifacts(dir, result.artifacts)
    const loaded = await tryLoadValidatedPromotionReadinessV2(dir, {
      now: new Date('2026-04-30T12:00:00.000Z'),
    })
    expect(loaded.kind).toBe('invalid')
    expect(loaded.error).not.toContain('manual_fee_override_not_allowed_for_paper_or_live')
    expect(loaded.error).not.toContain('fee_snapshot_not_runtime_verified')
  })

  it('aligns monetization selected route with the release-gate economics route when present', () => {
    const paperDecision = makePaperDecision()
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: {
        experimentId: 'experiment-1',
        config: paperDecision.bestConfigEvidence,
      },
      releaseGateStatus: {
        version: 1,
        generatedAt: '2026-04-30T11:00:00.000Z',
        allowPaperTrading: false,
        allowLiveTrading: false,
        failedChecks: ['economics'],
        warningChecks: [],
        checks: [{
          name: 'economics',
          status: 'fail',
          summary: 'Route-cost economics failed.',
          metrics: {
            selectedRoute: 'passive_passive',
            netExpectancyPct: -0.1,
          },
        }],
        expiresAt: '2026-05-01T12:00:00.000Z',
      },
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...makeCleanDirtyWorktreeEvidence(),
      ...makePaperEvidence('data/runtime', paperDecision),
    })

    expect(result.artifacts.strategyPromotion.monetizationGate.metricSnapshot).toMatchObject({
      selectedRoute: 'passive_passive',
      routeTotalExpectedCostBps: 18,
      routeMaxAllowedCostBps: 20,
    })
    expect(result.artifacts.strategyPromotion.monetizationGate.hardBlocks).not.toContain(
      'route_cost_budget_exceeded:taker_taker',
    )
  })

  it('marks auto/backfilled paper decisions as backtest-origin evidence', () => {
    const paperDecision = makePaperDecision({
      promotionReadiness: {
        ...makePaperDecision().promotionReadiness,
        dataMode: 'auto',
      },
    })
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: null,
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...makePaperEvidence('data/runtime', paperDecision),
    })

    expect(result.artifacts.evidenceLedger[0].dataOrigin).toBe('backtest')
    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toContain('paper_evidence_uses_backtest_origin')
  })

  it('fails closed when v4.1 paper evidence pointer is missing', () => {
    const paperDecision = makePaperDecision()
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: null,
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toContain(
      'missing_paper_evidence_report',
    )
    expect(result.artifacts.strategyPromotion.paperGate.metricSnapshot).toMatchObject({
      paperEvidencePointerStatus: 'stale_report_halt',
      paperEvidenceBlockNewOpens: true,
      paperEvidenceForceCloseExisting: false,
      paperEvidenceAlert: true,
    })
  })

  it('fails closed on stale v4.1 paper evidence reports', () => {
    const paperDecision = makePaperDecision()
    const paperEvidence = makePaperEvidence('data/runtime', paperDecision, {
      generatedAt: '2026-04-30T11:44:59.000Z',
      now: new Date('2026-04-30T12:00:00.000Z'),
    })
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: null,
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...paperEvidence,
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toContain(
      'stale_paper_evidence_report',
    )
    expect(result.artifacts.strategyPromotion.paperGate.metricSnapshot).toMatchObject({
      paperEvidencePointerStatus: 'stale_report_halt',
      paperEvidenceFreshnessStatus: 'stale',
      paperEvidenceBlockNewOpens: true,
      paperEvidenceForceCloseExisting: false,
      paperEvidenceAlert: true,
    })
  })

  it('recomputes v4.1 paper evidence freshness at publish time', () => {
    const paperDecision = makePaperDecision()
    const paperEvidence = makePaperEvidence('data/runtime', paperDecision, {
      generatedAt: '2026-04-30T12:00:00.000Z',
      now: new Date('2026-04-30T12:00:30.000Z'),
    })

    expect(paperEvidence.paperEvidenceReport.freshness.status).toBe('fresh')

    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:16:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: null,
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...paperEvidence,
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toContain(
      'stale_paper_evidence_report',
    )
    expect(result.artifacts.strategyPromotion.paperGate.metricSnapshot).toMatchObject({
      paperEvidenceFreshnessStatus: 'stale',
      paperEvidenceAgeSeconds: 960,
    })
    expect(result.artifacts.evidenceLedger[1].metricSnapshot).toMatchObject({
      paperEvidenceFreshnessStatus: 'stale',
      paperEvidenceAgeSeconds: 960,
    })
  })

  it('caps paper gate expiry at the paper evidence freshness deadline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-promotion-v2-paper-expiry-'))
    const paperDecisionPath = join(dir, 'paper_decision.latest.json')
    const paperDecision = makePaperDecision()
    const paperDecisionRaw = `${JSON.stringify(paperDecision, null, 2)}\n`
    const paperEvidence = makePaperEvidence(dir, paperDecision, {
      generatedAt: '2026-04-30T12:00:00.000Z',
      now: new Date('2026-04-30T12:00:30.000Z'),
    })
    await writeFile(paperDecisionPath, paperDecisionRaw, 'utf-8')

    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:30.000Z'),
      runtimeDir: dir,
      paperDecisionPath,
      paperDecisionRaw,
      paperDecision,
      bestConfig: {
        experimentId: 'experiment-1',
        config: paperDecision.bestConfigEvidence,
      },
      releaseGateStatus: {
        version: 1,
        generatedAt: '2026-04-30T12:00:00.000Z',
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: [],
        warningChecks: [],
        expiresAt: '2026-05-01T12:00:00.000Z',
      },
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...paperEvidence,
    })

    expect(result.artifacts.strategyPromotion.paperGate.expiresAt).toBe('2026-04-30T12:15:00.000Z')
    expect(evaluatePromotionReadinessForPaperOrders(result.artifacts.strategyPromotion, {
      now: new Date('2026-04-30T12:16:00.000Z'),
    })).toContain('gate_expired:paper')
  })

  it('fails closed when paper evidence pointer mismatches report or report is not live_only', () => {
    const paperDecision = makePaperDecision()
    const paperEvidence = makePaperEvidence('data/runtime', paperDecision, {
      paperDataMode: 'auto',
    })
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: null,
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...paperEvidence,
      paperEvidencePointer: {
        ...paperEvidence.paperEvidencePointer,
        latestReportId: 'wrong_report_id',
      },
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toEqual(
      expect.arrayContaining([
        'paper_evidence_pointer_report_mismatch',
        'paper_evidence_not_live_only',
      ]),
    )
    expect(result.artifacts.strategyPromotion.paperGate.metricSnapshot).toMatchObject({
      paperEvidencePointerStatus: 'stale_report_halt',
      paperEvidenceFreshnessStatus: 'fresh',
      paperEvidenceBlockNewOpens: true,
      paperEvidenceForceCloseExisting: false,
    })
  })

  it('fails closed when latest paper evidence is missing from append-only ledger', () => {
    const paperDecision = makePaperDecision()
    const paperEvidence = makePaperEvidence('data/runtime', paperDecision)
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: null,
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...paperEvidence,
      paperEvidenceLedgerEntries: [],
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toContain(
      'missing_paper_evidence_ledger',
    )
  })

  it('carries P1 cost-after gate evidence into paper hard blocks', () => {
    const paperDecision = makePaperDecision()
    const p1Evidence = buildP1TradingEvidenceSnapshot({
      gate: {
        gateStatus: 'insufficient_data',
        gateStatusBasis: 'insufficient_data',
        gateStatusDeltaPct: null,
        costAdjusted: {
          acceptedClosedTrades: 937,
          acceptedWithPredictedCost: 0,
          acceptedMissingPredictedCost: 937,
          skippedClosedOutcomes: 1366,
          skippedWithPredictedCost: 1366,
          acceptVsSkipNetDeltaPct: null,
        },
      },
      cost: {
        quarantine: true,
        quarantineReasons: ['low_cost_prediction_sample'],
      },
      mfe: {
        coverage: {
          stopLossTrades: 42,
          ledgerCoveragePct: 0,
        },
        stopLossAttribution: {
          byMfeBpsBucket: [{
            key: 'missing',
            diagnosticsOk: 0,
          }],
        },
      },
      trialLedger: {
        raw_m: 56,
        effective_m: 29,
        rawMComplete: false,
        rawMCompleteness: 'visible_sources_only',
        promotionEligible: false,
        fdrGateStatus: 'blocked_missing_complete_trial_universe',
        status: 'skeleton',
        readinessGaps: {
          blockerSummary: ['pit_proxy_only_trials:9'],
        },
        fdrDiagnostics: {
          status: 'skeleton_no_pvalues',
        },
      },
    })
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: {
        experimentId: 'experiment-1',
        config: paperDecision.bestConfigEvidence,
      },
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...makeCleanDirtyWorktreeEvidence(),
      ...makePaperEvidence('data/runtime', paperDecision),
      p1Evidence,
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toEqual(expect.arrayContaining([
      'p1_gate_not_useful:insufficient_data',
      'p1_gate_not_cost_adjusted:insufficient_data',
      'p1_accepted_cost_coverage_incomplete:0/937',
      'p1_cost_model_quarantine',
      'p1_stop_loss_cluster:42',
      'p1_stop_loss_attribution_incomplete:0/42',
      'p1_trial_ledger_not_valid:skeleton',
      'p1_trial_ledger_raw_m_incomplete:visible_sources_only',
      'p1_trial_ledger_not_promotion_eligible',
      'p1_trial_ledger_fdr_not_ready:blocked_missing_complete_trial_universe',
      'p1_trial_ledger_fdr_status_not_ready:skeleton_no_pvalues',
      'p1_trial_ledger_readiness:pit_proxy_only_trials:9',
    ]))
    expect(result.artifacts.strategyPromotion.paperGate.metricSnapshot).toMatchObject({
      p1GateStatus: 'insufficient_data',
      p1GateStatusBasis: 'insufficient_data',
      p1AcceptedCostCoverage: '0/937',
      p1CostNewWindowStatus: 'missing',
      p1CostNewWindowCoverage: '0/0',
      p1CostQuarantine: true,
      p1StopLossTrades: 42,
      p1StopLossDiagnosticsOk: 0,
      p1StopLossDiagnosticsCoveragePct: 0,
      p1TrialLedgerStatus: 'skeleton',
      p1TrialLedgerRawM: 56,
      p1TrialLedgerEffectiveM: 29,
      p1TrialLedgerRawMCompleteness: 'visible_sources_only',
      p1TrialLedgerFdrGateStatus: 'blocked_missing_complete_trial_universe',
      p1TrialLedgerFdrStatus: 'skeleton_no_pvalues',
      p1TrialLedgerReadinessBlockers: ['pit_proxy_only_trials:9'],
    })
  })

  it('distinguishes failed release research checks from missing research artifacts', () => {
    const paperDecision = makePaperDecision()
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: {
        experimentId: 'experiment-1',
        config: paperDecision.bestConfigEvidence,
      },
      releaseGateStatus: {
        version: 1,
        generatedAt: '2026-04-30T11:00:00.000Z',
        allowPaperTrading: false,
        allowLiveTrading: false,
        failedChecks: ['wfo', 'significance'],
        warningChecks: [],
        checks: [
          {
            name: 'wfo',
            status: 'fail',
            summary: 'WFO gate failed.',
            metrics: {
              overallPassed: false,
              failedWindows: 3,
              windowCount: 3,
              failedWindowRatio: 1,
            },
          },
          {
            name: 'significance',
            status: 'fail',
            summary: 'Statistical significance gate failed.',
            metrics: {
              pboStatus: 'indeterminate',
              dsrStatus: 'fail',
              fdrStatus: 'missing',
              trialLedgerStatus: 'fail',
              trialLedgerBlocks: 'trial_ledger_missing',
            },
          },
        ],
      },
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...makeCleanDirtyWorktreeEvidence(),
      ...makePaperEvidence('data/runtime', paperDecision),
    })

    const researchBlocks = result.artifacts.strategyPromotion.researchGate.hardBlocks
    expect(researchBlocks).toEqual(expect.arrayContaining([
      'wfo_failed',
      'pbo_indeterminate',
      'dsr_failed',
      'fdr_missing',
      'trial_ledger_fail:trial_ledger_missing',
    ]))
    expect(researchBlocks).not.toContain('wfo_missing')
    expect(result.readiness.humanReadableReason).toContain('research:wfo_failed')
  })

  it('does not let legacy cost gaps block when post-enforcement cost evidence is complete', () => {
    const paperDecision = makePaperDecision()
    const p1Evidence = buildP1TradingEvidenceSnapshot({
      gate: {
        gateStatus: 'useful',
        gateStatusBasis: 'cost_adjusted_accept_vs_skip_net_delta',
        gateStatusDeltaPct: 0.8,
        costAdjusted: {
          acceptedClosedTrades: 937,
          acceptedWithPredictedCost: 0,
          acceptedMissingPredictedCost: 937,
          skippedClosedOutcomes: 1366,
          skippedWithPredictedCost: 1366,
          acceptVsSkipNetDeltaPct: 0.8,
        },
      },
      cost: {
        quarantine: false,
        quarantineReasons: [],
        newWindow: {
          status: 'ok',
          closedTrades: 2,
          tradesWithCompletePredictedOpenEvidence: 2,
          tradesMissingCompletePredictedOpenEvidence: 0,
          completePredictedOpenEvidenceCoveragePct: 100,
        },
      },
      mfe: {
        coverage: {
          stopLossTrades: 1,
          ledgerCoveragePct: 100,
        },
        stopLossSummary: {
          diagnosticsOk: 1,
        },
      },
      trialLedger: {
        raw_m: 56,
        effective_m: 29,
        rawMComplete: true,
        rawMCompleteness: 'complete_trial_universe',
        promotionEligible: true,
        fdrGateStatus: 'ready_explanatory_only',
        status: 'valid',
        fdrDiagnostics: {
          status: 'ready',
        },
      },
    })
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: {
        experimentId: 'experiment-1',
        config: paperDecision.bestConfigEvidence,
      },
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...makeCleanDirtyWorktreeEvidence(),
      ...makePaperEvidence('data/runtime', paperDecision),
      p1Evidence,
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).not.toContain(
      'p1_accepted_cost_coverage_incomplete:0/937',
    )
    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).not.toContain(
      'p1_new_window_predicted_open_evidence_incomplete:2/2',
    )
    expect(result.artifacts.strategyPromotion.paperGate.metricSnapshot).toMatchObject({
      p1CostNewWindowStatus: 'ok',
      p1CostNewWindowCoverage: '2/2',
      p1CostNewWindowCoveragePct: 100,
    })
  })

  it('fails closed when post-enforcement cost evidence is incomplete', () => {
    const paperDecision = makePaperDecision()
    const p1Evidence = buildP1TradingEvidenceSnapshot({
      gate: {
        gateStatus: 'useful',
        gateStatusBasis: 'cost_adjusted_accept_vs_skip_net_delta',
        gateStatusDeltaPct: 0.8,
        costAdjusted: {
          acceptedClosedTrades: 937,
          acceptedWithPredictedCost: 0,
          acceptedMissingPredictedCost: 937,
          skippedClosedOutcomes: 1366,
          skippedWithPredictedCost: 1366,
          acceptVsSkipNetDeltaPct: 0.8,
        },
      },
      cost: {
        quarantine: false,
        quarantineReasons: [],
        newWindow: {
          status: 'missing',
          closedTrades: 2,
          tradesWithCompletePredictedOpenEvidence: 1,
          tradesMissingCompletePredictedOpenEvidence: 1,
          completePredictedOpenEvidenceCoveragePct: 50,
        },
      },
      mfe: {
        coverage: {
          stopLossTrades: 1,
          ledgerCoveragePct: 100,
        },
        stopLossSummary: {
          diagnosticsOk: 1,
        },
      },
      trialLedger: {
        raw_m: 56,
        effective_m: 29,
        rawMComplete: true,
        rawMCompleteness: 'complete_trial_universe',
        promotionEligible: true,
        fdrGateStatus: 'ready_explanatory_only',
        status: 'valid',
        fdrDiagnostics: {
          status: 'ready',
        },
      },
    })
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: {
        experimentId: 'experiment-1',
        config: paperDecision.bestConfigEvidence,
      },
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...makeCleanDirtyWorktreeEvidence(),
      ...makePaperEvidence('data/runtime', paperDecision),
      p1Evidence,
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toContain(
      'p1_new_window_predicted_open_evidence_incomplete:1/2',
    )
    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).not.toContain(
      'p1_accepted_cost_coverage_incomplete:0/937',
    )
    expect(result.artifacts.strategyPromotion.paperGate.metricSnapshot).toMatchObject({
      p1CostNewWindowStatus: 'missing',
      p1CostNewWindowCoverage: '1/2',
      p1CostNewWindowCoveragePct: 50,
    })
  })

  it('blocks P1 evidence when any consumed manifest is quarantined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-p1-trust-quarantine-'))
    const indexPath = await writeP1EvidenceFixture(dir, {
      gateManifestOverrides: {
        evidenceTrust: 'quarantine',
        dqStatus: 'quarantine',
      },
    })
    const p1Evidence = await readP1TradingEvidenceSnapshot(indexPath)
    expect(p1Evidence).toMatchObject({
      evidenceTrustStatus: 'blocked',
    })
    expect(p1Evidence?.evidenceTrustReasons).toContain(
      'p1_evidence_trust_not_pass:gateEffectiveness:quarantine:quarantine',
    )

    const paperDecision = makePaperDecision()
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: dir,
      paperDecisionPath: join(dir, 'paper_decision.latest.json'),
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: null,
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...makeCleanDirtyWorktreeEvidence(),
      ...makePaperEvidence(dir, paperDecision),
      p1Evidence,
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toContain(
      'p1_evidence_trust_not_pass:gateEffectiveness:quarantine:quarantine',
    )
  })

  it('blocks paper promotion on stop-loss risk policy recommendations', () => {
    const paperDecision = makePaperDecision()
    const p1Evidence = {
      evidenceTrustStatus: 'pass' as const,
      evidenceTrustReasons: [],
      trialLedgerStatus: 'valid',
      trialLedgerRawM: 10,
      trialLedgerEffectiveM: 8,
      trialLedgerRawMComplete: true,
      trialLedgerRawMCompleteness: 'complete_trial_universe',
      trialLedgerPromotionEligible: true,
      trialLedgerFdrGateStatus: 'ready_explanatory_only',
      trialLedgerFdrStatus: 'ready',
      gateStatus: 'useful',
      gateStatusBasis: 'cost_adjusted_accept_vs_skip_net_delta',
      gateStatusDeltaPct: 1,
      acceptedClosedTrades: 10,
      acceptedWithPredictedCost: 10,
      acceptedMissingPredictedCost: 0,
      costNewWindowStatus: 'insufficient_data',
      costNewWindowClosedTrades: 0,
      costNewWindowCompletePredictedOpenEvidence: 0,
      costNewWindowMissingCompletePredictedOpenEvidence: 0,
      costNewWindowCompletePredictedOpenEvidenceCoveragePct: 0,
      skippedClosedOutcomes: 10,
      skippedWithPredictedCost: 10,
      acceptVsSkipNetDeltaPct: 1,
      costQuarantine: false,
      costQuarantineReasons: [],
      stopLossTrades: 1,
      stopLossDiagnosticsOk: 1,
      stopLossDiagnosticsCoveragePct: 100,
      stopLossCoveragePct: 100,
      stoplossRiskPolicyStatus: 'blocked',
      stoplossRiskPolicyPromotionBlocked: true,
      stoplossRiskPolicyBlockedBy: [
        'stoploss_lane:microstructure_100x:block',
        'stoploss_symbol:WIF-USDT:cooldown',
      ],
      stoplossRiskPolicyHighestSeverity: 'critical',
    }

    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: null,
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...makeCleanDirtyWorktreeEvidence(),
      ...makePaperEvidence('data/runtime', paperDecision),
      p1Evidence,
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toContain(
      'p1_stoploss_risk_policy_blocked:stoploss_lane:microstructure_100x:block,stoploss_symbol:WIF-USDT:cooldown',
    )
    expect(result.artifacts.strategyPromotion.paperGate.metricSnapshot).toMatchObject({
      p1StoplossRiskPolicyStatus: 'blocked',
      p1StoplossRiskPolicyHighestSeverity: 'critical',
      p1StoplossRiskPolicyBlockedBy: [
        'stoploss_lane:microstructure_100x:block',
        'stoploss_symbol:WIF-USDT:cooldown',
      ],
    })
  })

  it('carries diagnostic lane policy into paper hard blocks without approving execution', () => {
    const paperDecision = makePaperDecision()
    const strategyLanePolicy = {
      diagnosticOnly: true,
      policyMutationAllowed: false,
      paperExecutionAllowed: false,
      liveExecutionAllowed: false,
      globalBlockers: ['best_config_no_passing_config'],
      summary: {
        lanesReviewed: 3,
        blockNewOrders: 1,
        shadowOnly: 1,
        probation: 1,
        worstLane: 'cross_sectional',
        bestPositiveLowSampleLane: 'cross_sectional_10x',
      },
      lanes: [
        {
          lane: 'cross_sectional',
          action: 'block_new_orders',
          severity: 'high',
        },
        {
          lane: 'microstructure_10x',
          action: 'shadow_only',
          severity: 'medium',
        },
        {
          lane: 'cross_sectional_10x',
          action: 'probation',
          severity: 'low',
        },
      ],
    }

    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: null,
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...makeCleanDirtyWorktreeEvidence(),
      ...makePaperEvidence('data/runtime', paperDecision),
      strategyLanePolicy: buildStrategyLanePolicySnapshot(strategyLanePolicy),
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toEqual(expect.arrayContaining([
      'strategy_lane_global_blocker:best_config_no_passing_config',
      'strategy_lane_block:cross_sectional',
    ]))
    expect(result.artifacts.strategyPromotion.paperGate.advisoryWarnings).toEqual(expect.arrayContaining([
      'strategy_lane_shadow_only:microstructure_10x',
      'strategy_lane_probation:cross_sectional_10x',
    ]))
    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).not.toContain(
      'strategy_lane_policy_allows_paper_execution',
    )
    expect(result.artifacts.strategyPromotion.paperGate.metricSnapshot).toMatchObject({
      strategyLanePolicyStatus: 'loaded',
      strategyLanePolicyDiagnosticOnly: true,
      strategyLanePolicyPolicyMutationAllowed: false,
      strategyLanePolicyPaperExecutionAllowed: false,
      strategyLanePolicyLiveExecutionAllowed: false,
      strategyLanePolicyLanesReviewed: 3,
      strategyLanePolicyBlockNewOrders: 1,
      strategyLanePolicyShadowOnly: 1,
      strategyLanePolicyProbation: 1,
      strategyLanePolicyWorstLane: 'cross_sectional',
      strategyLanePolicyBestPositiveLowSampleLane: 'cross_sectional_10x',
      strategyLanePolicyTopBlockedLanes: 'cross_sectional',
      strategyLanePolicyShadowLanes: 'microstructure_10x',
      strategyLanePolicyProbationLanes: 'cross_sectional_10x',
    })
    expect(result.readiness.finalVerdict).not.toBe('paper_ready')
  })

  it('blocks paper promotion when stratified gate diagnostics require cost coverage', () => {
    const paperDecision = makePaperDecision()
    const p1Evidence = {
      evidenceTrustStatus: 'pass' as const,
      evidenceTrustReasons: [],
      trialLedgerStatus: 'valid',
      trialLedgerRawM: 10,
      trialLedgerEffectiveM: 8,
      trialLedgerRawMComplete: true,
      trialLedgerRawMCompleteness: 'complete_trial_universe',
      trialLedgerPromotionEligible: true,
      trialLedgerFdrGateStatus: 'ready_explanatory_only',
      trialLedgerFdrStatus: 'ready',
      gateStatus: 'insufficient_data',
      gateStatusBasis: 'insufficient_data',
      gateStatusDeltaPct: null,
      gateStratifiedItems: 181,
      gateStratifiedCostCoverageRequired: 175,
      gateStratifiedCollectMoreData: 6,
      gateStratifiedKeepBlocked: 0,
      gateStratifiedTopHarmfulKeys: [],
      acceptedClosedTrades: 937,
      acceptedWithPredictedCost: 0,
      acceptedMissingPredictedCost: 937,
      costNewWindowStatus: 'insufficient_data',
      costNewWindowClosedTrades: 0,
      costNewWindowCompletePredictedOpenEvidence: 0,
      costNewWindowMissingCompletePredictedOpenEvidence: 0,
      costNewWindowCompletePredictedOpenEvidenceCoveragePct: 0,
      skippedClosedOutcomes: 1375,
      skippedWithPredictedCost: 1375,
      acceptVsSkipNetDeltaPct: null,
      costQuarantine: false,
      costQuarantineReasons: [],
      stopLossTrades: 1,
      stopLossDiagnosticsOk: 1,
      stopLossDiagnosticsCoveragePct: 100,
      stopLossCoveragePct: 100,
      stoplossRiskPolicyStatus: 'clear',
      stoplossRiskPolicyPromotionBlocked: false,
      stoplossRiskPolicyBlockedBy: [],
      stoplossRiskPolicyHighestSeverity: null,
    }

    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: null,
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...makeCleanDirtyWorktreeEvidence(),
      ...makePaperEvidence('data/runtime', paperDecision),
      p1Evidence,
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toContain(
      'p1_gate_stratified_cost_coverage_required:175/181',
    )
    expect(result.artifacts.strategyPromotion.paperGate.metricSnapshot).toMatchObject({
      p1GateStratifiedItems: 181,
      p1GateStratifiedCostCoverageRequired: 175,
      p1GateStratifiedCollectMoreData: 6,
      p1GateStratifiedKeepBlocked: 0,
    })
  })

  it('blocks P1 evidence when a consumed manifest is missing or hash-mismatched', async () => {
    const missingDir = await mkdtemp(join(tmpdir(), 'openalice-p1-trust-missing-'))
    const missingIndexPath = await writeP1EvidenceFixture(missingDir, {
      omitCostManifestPath: true,
    })
    const missingSnapshot = await readP1TradingEvidenceSnapshot(missingIndexPath)
    expect(missingSnapshot?.evidenceTrustReasons).toContain(
      'p1_evidence_manifest_missing:costModelDiagnostics',
    )

    const tamperedDir = await mkdtemp(join(tmpdir(), 'openalice-p1-trust-tamper-'))
    const tamperedIndexPath = await writeP1EvidenceFixture(tamperedDir)
    const tamperedIndex = JSON.parse(await readFile(tamperedIndexPath, 'utf-8')) as {
      artifacts: { gateEffectiveness: string }
    }
    await writeFile(tamperedIndex.artifacts.gateEffectiveness, '{"tampered":true}\n', 'utf-8')
    const tamperedSnapshot = await readP1TradingEvidenceSnapshot(tamperedIndexPath)
    expect(tamperedSnapshot?.evidenceTrustReasons).toContain(
      'p1_evidence_hash_mismatch:gateEffectiveness',
    )
  })

  it('fails closed when paper evidence ledger entry does not match pointer path', () => {
    const paperDecision = makePaperDecision()
    const paperEvidence = makePaperEvidence('data/runtime', paperDecision)
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: null,
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...paperEvidence,
      paperEvidenceLedgerEntries: [{
        ...paperEvidence.paperEvidenceLedgerEntries[0],
        path: 'data/runtime/paper/reports/different.json',
      }],
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toContain(
      'paper_evidence_ledger_path_mismatch',
    )
  })

  it('fails closed when paper evidence ledger cannot be parsed', () => {
    const paperDecision = makePaperDecision()
    const paperEvidence = makePaperEvidence('data/runtime', paperDecision)
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: null,
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...paperEvidence,
      paperEvidenceLedgerReadError: 'CORRUPT_PAPER_EVIDENCE_LEDGER',
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toContain(
      'corrupt_paper_evidence_ledger',
    )
  })

  it('fails closed when paper evidence ledger path points at a shadow ledger', () => {
    const paperDecision = makePaperDecision()
    const paperEvidence = makePaperEvidence('data/runtime', paperDecision)
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: null,
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...paperEvidence,
      paperEvidenceLedgerReadError: 'PAPER_EVIDENCE_LEDGER_PATH_IS_SHADOW_LEDGER',
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toContain(
      'paper_evidence_ledger_path_is_shadow_ledger',
    )
  })

  it('fails closed when paper evidence ledger path is not canonical', () => {
    const paperDecision = makePaperDecision()
    const paperEvidence = makePaperEvidence('data/runtime', paperDecision)
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: null,
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...paperEvidence,
      paperEvidenceLedgerReadError: 'PAPER_EVIDENCE_LEDGER_PATH_NOT_CANONICAL',
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toContain(
      'paper_evidence_ledger_path_not_canonical',
    )
  })

  it('fails closed when paper evidence report is not bound to the current paper decision', () => {
    const paperDecision = makePaperDecision()
    const paperEvidence = makePaperEvidence('data/runtime', {
      ...paperDecision,
      status: 'different_decision',
    })
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: null,
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...paperEvidence,
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toContain(
      'paper_evidence_decision_hash_mismatch',
    )
  })

  it('fails closed when current paper decision raw JSON cannot be parsed for evidence binding', () => {
    const paperDecision = makePaperDecision()
    const paperEvidence = makePaperEvidence('data/runtime', paperDecision)
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: '{',
      paperDecision,
      bestConfig: null,
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...paperEvidence,
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toContain(
      'paper_decision_raw_invalid_json_for_evidence_binding',
    )
  })

  it('fails closed when paper evidence source summary hash is internally inconsistent', () => {
    const paperDecision = makePaperDecision()
    const paperEvidence = makePaperEvidence('data/runtime', paperDecision)
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: null,
      releaseGateStatus: null,
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...paperEvidence,
      paperEvidenceReport: {
        ...paperEvidence.paperEvidenceReport,
        sourceSummaryHash: 'sha256:wrong',
      },
    })

    expect(result.artifacts.strategyPromotion.paperGate.hardBlocks).toContain(
      'paper_evidence_source_summary_hash_mismatch',
    )
  })

  it('quarantines promotion artifacts when dirty-worktree evidence is not trusted', () => {
    const paperDecision = makePaperDecision()
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: {
        experimentId: 'experiment-1',
        config: paperDecision.bestConfigEvidence,
      },
      releaseGateStatus: {
        version: 1,
        generatedAt: '2026-04-30T11:00:00.000Z',
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: [],
        warningChecks: [],
        expiresAt: '2026-05-01T12:00:00.000Z',
      },
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      dirtyWorktreeEvidenceManifest: {
        job: 'dirty_worktree_audit',
        evidenceTrust: 'quarantine',
        dqStatus: 'quarantine',
        businessStatus: 'warn',
      },
      ...makePaperEvidence('data/runtime', paperDecision),
    })

    expect(result.artifacts.quarantine).toMatchObject({
      strategyId: 'cross_sectional_v2',
      triggerReason: 'dirty_worktree_evidence_quarantine',
      frozenExperimentId: 'experiment-1',
      exitStatus: 'blocked',
    })
    expect(result.readiness.finalVerdict).toBe('quarantined')
    expect(result.readiness.humanReadableReason).toContain(
      'quarantine_blocks_orders:dirty_worktree_evidence_quarantine',
    )
  })

  it('quarantines promotion artifacts when the dirty-worktree audit still blocks P2 despite a pass manifest', () => {
    const paperDecision = makePaperDecision()
    const dirtyAudit = makeDirtyWorktreeAudit({
      counts: {
        total: 2,
        byProtocolClass: { A: 0, B: 2, C: 0, D: 0 },
      },
      governance: {
        evidenceTrust: 'quarantine',
        p2PromotionAllowed: false,
        monetizationConclusionAllowed: false,
        runtimeArtifactsQuarantined: true,
      },
    })
    const dirtyAuditRaw = `${JSON.stringify(dirtyAudit, null, 2)}\n`
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: {
        experimentId: 'experiment-1',
        config: paperDecision.bestConfigEvidence,
      },
      releaseGateStatus: {
        version: 1,
        generatedAt: '2026-04-30T11:00:00.000Z',
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: [],
        warningChecks: [],
        expiresAt: '2026-05-01T12:00:00.000Z',
      },
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      dirtyWorktreeAuditPath: 'data/runtime/dirty_worktree_audit.latest.json',
      dirtyWorktreeAuditRaw: dirtyAuditRaw,
      dirtyWorktreeAudit: dirtyAudit,
      dirtyWorktreeEvidenceManifest: makeDirtyWorktreeManifest({
        auditRaw: dirtyAuditRaw,
        evidenceTrust: 'pass',
        dqStatus: 'pass',
      }),
      ...makePaperEvidence('data/runtime', paperDecision),
    })

    expect(result.artifacts.quarantine).toMatchObject({
      triggerReason: 'dirty_worktree_audit_evidence_not_pass:quarantine',
      exitStatus: 'blocked',
    })
    expect(result.artifacts.quarantine?.exitRequiredArtifacts).toEqual(expect.arrayContaining([
      'dirty_worktree_audit.latest.json:counts.total=0,governance.p2PromotionAllowed=true,governance.runtimeArtifactsQuarantined=false',
      'dirty_worktree_audit.latest.json.manifest.json:evidenceTrust=pass,dqStatus=pass,artifactHash=match',
    ]))
    expect(result.readiness.finalVerdict).toBe('quarantined')
    expect(result.readiness.humanReadableReason).toContain(
      'quarantine_blocks_orders:dirty_worktree_audit_evidence_not_pass:quarantine',
    )
  })

  it('quarantines promotion artifacts when dirty-worktree audit hash mismatches its manifest', () => {
    const paperDecision = makePaperDecision()
    const cleanEvidence = makeCleanDirtyWorktreeEvidence()
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: {
        experimentId: 'experiment-1',
        config: paperDecision.bestConfigEvidence,
      },
      releaseGateStatus: {
        version: 1,
        generatedAt: '2026-04-30T11:00:00.000Z',
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: [],
        warningChecks: [],
        expiresAt: '2026-05-01T12:00:00.000Z',
      },
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      ...cleanEvidence,
      dirtyWorktreeAuditRaw: `${JSON.stringify({ ...cleanEvidence.dirtyWorktreeAudit, generatedAt: 'tampered' }, null, 2)}\n`,
      ...makePaperEvidence('data/runtime', paperDecision),
    })

    expect(result.artifacts.quarantine).toMatchObject({
      triggerReason: 'dirty_worktree_audit_hash_mismatch',
      exitStatus: 'blocked',
    })
    expect(result.readiness.humanReadableReason).toContain(
      'quarantine_blocks_orders:dirty_worktree_audit_hash_mismatch',
    )
  })

  it('quarantines promotion artifacts when dirty-worktree evidence is missing', () => {
    const paperDecision = makePaperDecision()
    const result = buildPromotionV2RuntimeArtifactsFromInputs({
      now: new Date('2026-04-30T12:00:00.000Z'),
      runtimeDir: 'data/runtime',
      paperDecisionPath: 'data/runtime/paper_decision.latest.json',
      paperDecisionRaw: `${JSON.stringify(paperDecision)}\n`,
      paperDecision,
      bestConfig: {
        experimentId: 'experiment-1',
        config: paperDecision.bestConfigEvidence,
      },
      releaseGateStatus: {
        version: 1,
        generatedAt: '2026-04-30T11:00:00.000Z',
        allowPaperTrading: true,
        allowLiveTrading: false,
        failedChecks: [],
        warningChecks: [],
        expiresAt: '2026-05-01T12:00:00.000Z',
      },
      candidateRegistry: makeCandidateRegistry('candidate_registry', false),
      graveyard: makeCandidateRegistry('graveyard', true),
      dirtyWorktreeEvidenceManifest: null,
      ...makePaperEvidence('data/runtime', paperDecision),
    })

    expect(result.artifacts.quarantine).toMatchObject({
      strategyId: 'cross_sectional_v2',
      triggerReason: 'dirty_worktree_evidence_missing',
      frozenExperimentId: 'experiment-1',
      exitStatus: 'blocked',
    })
    expect(result.readiness.finalVerdict).toBe('quarantined')
    expect(result.readiness.humanReadableReason).toContain(
      'quarantine_blocks_orders:dirty_worktree_evidence_missing',
    )
  })
})

function makePaperDecision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generatedAt: '2026-04-30T12:00:00.000Z',
    status: 'updated_positions',
    dataMode: 'live_only',
    estimatedRoundTripCostPct: 0.2,
    bestConfigEvidence: {
      avgSpreadPct: 0.5,
      winRatePct: 55,
      signals: 30,
      score: 10,
      assetCount: 6,
    },
    promotionReadiness: {
      ready: true,
      reasons: [],
      grossAvgSpreadPct: 0.5,
      estimatedRoundTripCostPct: 0.2,
      netEdgePct: 0.3,
      grossToCostRatio: 2.5,
      dataMode: 'live_only',
      paperDaysObserved: 14,
      paperTradesObserved: 20,
      liveOnlyAssetsGood: 6,
      liveOnlyAssetsRequired: 6,
    },
    accountSnapshot: {
      equity: 101_000,
      initialEquity: 100_000,
      totalTrades: 20,
    },
    signals: [
      { symbol: 'BTC-USDT', signal: 1 },
      { symbol: 'ETH-USDT', signal: -1 },
    ],
    proposedOrders: [
      { symbol: 'BTC-USDT', notionalUsd: 15_000 },
    ],
    executedTrades: [],
    dataQuality: [
      { symbol: 'BTC-USDT', state: 'good' },
      { symbol: 'ETH-USDT', state: 'good' },
    ],
    liveDataQuality: [
      { symbol: 'BTC-USDT', state: 'good', staleHours: 0.05 },
      { symbol: 'ETH-USDT', state: 'good', staleHours: 0.05 },
    ],
    ...overrides,
  }
}

function makePaperEvidence(
  root: string,
  paperDecision: Record<string, unknown>,
  options: {
    generatedAt?: string
    now?: Date
    paperDataMode?: 'auto' | 'live_only'
  } = {},
): {
  paperEvidencePointer: LatestPaperEvidencePointer
  paperEvidenceLedgerEntries: PaperEvidenceLedgerEntry[]
  paperEvidenceReport: PaperEvidenceReport
  paperEvidenceReportRaw: string
} {
  const summary = {
    generatedAt: options.generatedAt ?? '2026-04-30T12:00:00.000Z',
    paperDataMode: options.paperDataMode ?? 'live_only',
    status: 'passed',
    paperDecision,
  }
  const paperEvidenceReport = buildPaperEvidenceReport({
    summary,
    summaryPath: join(root, 'paper_shadow_loop.latest.json'),
    paperDecisionPath: join(root, 'paper_decision.latest.json'),
    paperDecision,
    now: options.now ?? new Date('2026-04-30T12:00:30.000Z'),
  })
  const reportPath = join(root, 'paper/reports', `${paperEvidenceReport.reportId}.json`)
  const paperEvidenceLedgerEntries: PaperEvidenceLedgerEntry[] = [{
    schemaVersion: 'paper_evidence_ledger.v4_1',
    reportId: paperEvidenceReport.reportId,
    generatedAt: paperEvidenceReport.generatedAt,
    path: reportPath,
    sourceRunId: paperEvidenceReport.sourceRunId,
    paperDataMode: paperEvidenceReport.paperDataMode,
    freshnessStatus: paperEvidenceReport.freshness.status,
    sourceSummaryHash: paperEvidenceReport.sourceSummaryHash,
  }]
  return {
    paperEvidencePointer: {
      schemaVersion: 'paper_evidence_latest_pointer.v4_1',
      latestReportId: paperEvidenceReport.reportId,
      path: reportPath,
      updatedAt: '2026-04-30T12:00:30.000Z',
    },
    paperEvidenceLedgerEntries,
    paperEvidenceReport,
    paperEvidenceReportRaw: `${JSON.stringify(paperEvidenceReportToJson(paperEvidenceReport), null, 2)}\n`,
  }
}

function makeCandidateRegistry(schemaName: 'candidate_registry' | 'graveyard', graveyard: boolean): CandidateRegistry {
  const generatedAt = '2026-04-30T12:00:00.000Z'
  const entries = graveyard
    ? [{
        candidateId: 'candidate-old',
        experimentId: 'experiment-1',
        strategyId: 'cross_sectional_v2',
        generatedAt,
        scriptName: 'optimize:cross-sectional',
        parameterHash: hashJson({ old: true }),
        status: 'graveyard' as const,
      }]
    : [{
        candidateId: 'candidate-1',
        experimentId: 'experiment-1',
        strategyId: 'cross_sectional_v2',
        generatedAt,
        scriptName: 'optimize:cross-sectional',
        parameterHash: hashJson({ active: true }),
        status: 'active' as const,
      }]
  return {
    schemaMeta: makeSchemaMeta(schemaName),
    registryId: schemaName,
    candidateCount: entries.length,
    entries,
    graveyardCandidateCount: entries.filter((entry) => entry.status === 'graveyard').length,
  }
}

function makeCleanDirtyWorktreeEvidence(): {
  dirtyWorktreeAuditPath: string
  dirtyWorktreeAuditRaw: string
  dirtyWorktreeAudit: Record<string, unknown>
  dirtyWorktreeEvidenceManifest: Record<string, unknown>
} {
  const auditPath = 'data/runtime/dirty_worktree_audit.latest.json'
  const audit = makeDirtyWorktreeAudit()
  const auditRaw = `${JSON.stringify(audit, null, 2)}\n`
  return {
    dirtyWorktreeAuditPath: auditPath,
    dirtyWorktreeAuditRaw: auditRaw,
    dirtyWorktreeAudit: audit,
    dirtyWorktreeEvidenceManifest: makeDirtyWorktreeManifest({
      auditPath,
      auditRaw,
      evidenceTrust: 'pass',
      dqStatus: 'pass',
    }),
  }
}

function makeDirtyWorktreeAudit(overrides: {
  counts?: Partial<Record<string, unknown>>
  governance?: Partial<Record<string, unknown>>
} = {}): Record<string, unknown> {
  return {
    generatedAt: '2026-04-30T12:00:00.000Z',
    repoRoot: '/repo',
    isDirty: false,
    counts: {
      total: 0,
      byPathGroup: {
        src: 0,
        scripts: 0,
        docs: 0,
        data: 0,
        logs: 0,
        secrets: 0,
        other: 0,
      },
      byStatusKind: {
        modified: 0,
        deleted: 0,
        untracked: 0,
        added: 0,
        renamed: 0,
        copied: 0,
        typechange: 0,
        unmerged: 0,
      },
      byProtocolClass: {
        A: 0,
        B: 0,
        C: 0,
        D: 0,
      },
      ...overrides.counts,
    },
    entries: [],
    protocol: {},
    governance: {
      evidenceTrust: 'pass',
      p2PromotionAllowed: true,
      monetizationConclusionAllowed: true,
      runtimeArtifactsQuarantined: false,
      reviewProtocol: 'clean',
      blockingReasons: [],
      requiredActions: ['No dirty worktree action required.'],
      p2RequiredEvidence: [
        'data/runtime/dirty_worktree_audit.latest.json:governance.p2PromotionAllowed=true',
        'data/runtime/dirty_worktree_audit.latest.json.manifest.json:evidenceTrust=pass',
      ],
      ...overrides.governance,
    },
  }
}

function makeDirtyWorktreeManifest(options: {
  auditPath?: string
  auditRaw: string
  evidenceTrust: string
  dqStatus: string
}): Record<string, unknown> {
  const auditPath = options.auditPath ?? 'data/runtime/dirty_worktree_audit.latest.json'
  return {
    schemaVersion: 1,
    job: 'dirty_worktree_audit',
    artifactPath: auditPath,
    manifestPath: `${auditPath}.manifest.json`,
    evidenceTrust: options.evidenceTrust,
    dqStatus: options.dqStatus,
    businessStatus: options.evidenceTrust === 'pass' ? 'pass' : 'warn',
    exitCode: 0,
    artifactHash: sha256Hex(options.auditRaw),
  }
}

function makeSchemaMeta(schemaName: string): SchemaMeta {
  return {
    schemaName,
    schemaVersion: PROMOTION_V2_SCHEMA_VERSION,
    createdBy: 'test',
    createdAt: '2026-04-30T12:00:00.000Z',
    codeCommit: 'test',
  }
}

async function writeP1EvidenceFixture(
  dir: string,
  options: {
    gateManifestOverrides?: Record<string, unknown>
    trialLedger?: Record<string, unknown>
    trialLedgerManifestOverrides?: Record<string, unknown>
    omitCostManifestPath?: boolean
    omitTrialLedgerManifestPath?: boolean
  } = {},
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const trialLedgerPath = join(dir, 'trial_ledger.latest.json')
  const gatePath = join(dir, 'gate_effectiveness_report.latest.json')
  const costPath = join(dir, 'cost_model_diagnostics.latest.json')
  const mfePath = join(dir, 'mfe_mae_stoploss_report.latest.json')
  const stoplossRiskPath = join(dir, 'stoploss_risk_policy.latest.json')
  const indexPath = join(dir, 'p1_trading_evidence.index.latest.json')
  const trialLedger = {
    raw_m: 10,
    effective_m: 8,
    rawMComplete: true,
    rawMCompleteness: 'complete_trial_universe',
    promotionEligible: true,
    fdrGateStatus: 'ready_explanatory_only',
    status: 'valid',
    fdrDiagnostics: {
      status: 'ready',
    },
    ...options.trialLedger,
  }
  const gate = {
    gateStatus: 'useful',
    gateStatusBasis: 'cost_adjusted_accept_vs_skip_net_delta',
    gateStatusDeltaPct: 1,
    costAdjusted: {
      acceptedClosedTrades: 10,
      acceptedWithPredictedCost: 10,
      acceptedMissingPredictedCost: 0,
      skippedClosedOutcomes: 10,
      skippedWithPredictedCost: 10,
      acceptVsSkipNetDeltaPct: 1,
    },
    stratifiedDiagnostics: {
      summary: {
        items: 0,
        costCoverageRequired: 0,
        collectMoreData: 0,
        keepBlocked: 0,
        topHarmfulKeys: [],
      },
    },
  }
  const cost = {
    quarantine: false,
    quarantineReasons: [],
    newWindow: {
      status: 'insufficient_data',
      closedTrades: 0,
      tradesWithCompletePredictedOpenEvidence: 0,
      tradesMissingCompletePredictedOpenEvidence: 0,
      completePredictedOpenEvidenceCoveragePct: 0,
    },
  }
  const mfe = { coverage: { stopLossTrades: 1, ledgerCoveragePct: 100 } }
  const stoplossRiskPolicy = {
    status: 'clear',
    summary: {
      promotionBlocked: false,
      promotionBlockedBy: [],
      highestSeverity: null,
    },
  }
  await writeJson(trialLedgerPath, trialLedger)
  await writeJson(gatePath, gate)
  await writeJson(costPath, cost)
  await writeJson(mfePath, mfe)
  await writeJson(stoplossRiskPath, stoplossRiskPolicy)

  const manifestPaths = {
    trialLedger: `${trialLedgerPath}.manifest.json`,
    gateEffectiveness: `${gatePath}.manifest.json`,
    costModelDiagnostics: `${costPath}.manifest.json`,
    mfeMaeStoploss: `${mfePath}.manifest.json`,
    stoplossRiskPolicy: `${stoplossRiskPath}.manifest.json`,
    index: `${indexPath}.manifest.json`,
  }
  const index = {
    schemaVersion: 1,
    generatedAt: '2026-04-30T12:00:00.000Z',
    outputDir: dir,
    artifacts: {
      trialLedger: trialLedgerPath,
      gateEffectiveness: gatePath,
      costModelDiagnostics: costPath,
      mfeMaeStoploss: mfePath,
      stoplossRiskPolicy: stoplossRiskPath,
      index: indexPath,
    },
    manifestPaths: {
      ...manifestPaths,
      ...(options.omitCostManifestPath ? { costModelDiagnostics: undefined } : {}),
      ...(options.omitTrialLedgerManifestPath ? { trialLedger: undefined } : {}),
    },
    notes: [],
  }
  await writeJson(indexPath, index)

  await writeManifest(manifestPaths.trialLedger, trialLedgerPath, options.trialLedgerManifestOverrides)
  await writeManifest(manifestPaths.gateEffectiveness, gatePath, options.gateManifestOverrides)
  await writeManifest(manifestPaths.costModelDiagnostics, costPath)
  await writeManifest(manifestPaths.mfeMaeStoploss, mfePath)
  await writeManifest(manifestPaths.stoplossRiskPolicy, stoplossRiskPath)
  await writeManifest(manifestPaths.index, indexPath)
  return indexPath
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

async function writeManifest(
  manifestPath: string,
  artifactPath: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const raw = await readFile(artifactPath, 'utf-8')
  await writeJson(manifestPath, {
    schemaVersion: 1,
    job: 'test',
    artifactPath,
    manifestPath,
    evidenceTrust: 'pass',
    dqStatus: 'pass',
    exitCode: 0,
    artifactHash: sha256Hex(raw),
    ...overrides,
  })
}
