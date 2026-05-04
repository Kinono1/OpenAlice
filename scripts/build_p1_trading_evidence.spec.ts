import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildCompleteTrialUniverseMarkerRecord,
  trialRecordToJson,
} from '../src/evidence/trial_registry.js'
import {
  buildAlphaHypothesisRegistry,
  buildCostModelDiagnostics,
  buildGateEffectivenessReport,
  buildMfeMaeStoplossReport,
  buildP1TradingEvidence,
  buildStoplossRiskPolicyReport,
  buildTrialLedgerReport,
  buildTrialSourceCoverageReport,
  parseP1TradingEvidenceArgs,
} from './build_p1_trading_evidence.js'
import { evidenceIdToPathKey } from '../src/evidence/evidence_id.js'
import type { TrialLedgerEntry } from './build_p1_trading_evidence.js'
import type { NormalizedPaperTrade } from './analyze_paper_pnl.js'
import type { PaperPolicyShadowLedgerEntry } from '../src/runtime/paper_policy_shadow_ledger.js'

describe('build_p1_trading_evidence', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'openalice-p1-evidence-'))
    roots.push(root)
    return root
  }

  it('parses CLI args with conservative defaults', () => {
    expect(parseP1TradingEvidenceArgs([])).toMatchObject({
      paperDir: 'data/paper_trading',
      dataDir: 'data/market/live_5m',
      oneSecondDataDir: 'data/market/live_1s',
      oneHourDataDir: 'data/market/live_accumulated',
      candidateRegistryPath: 'data/runtime/candidate_registry.latest.json',
      graveyardPath: 'data/runtime/graveyard.latest.json',
      bestConfigPath: 'data/research/best_config.json',
      trialRegistryPath: 'runtime/research/trial_registry.jsonl',
      evidenceOutputRoot: 'runtime/research',
      optimizationDir: 'data/research/optimization',
      validationDir: 'data/research/new_strategies_validation',
      routeCostBudgetPath: 'data/runtime/route_cost_budget.latest.json',
      timeframe: '5m',
      lookbackHours: null,
      json: false,
    })
    expect(parseP1TradingEvidenceArgs([
      '--outputDir',
      'out',
      '--timeframe',
      '1s',
      '--lookbackHours',
      '24',
      '--candidateRegistryPath',
      'candidate.json',
      '--optimizationDir',
      'optim',
      '--trialRegistryPath',
      'trial_registry.jsonl',
      '--routeCostBudgetPath',
      'route_cost_budget.json',
      '--json',
      'true',
    ])).toMatchObject({
      outputDir: 'out',
      candidateRegistryPath: 'candidate.json',
      trialRegistryPath: 'trial_registry.jsonl',
      routeCostBudgetPath: 'route_cost_budget.json',
      optimizationDir: 'optim',
      timeframe: '1s',
      lookbackHours: 24,
      json: true,
    })
  })

  it('registers concrete alpha hypotheses with falsification rules', () => {
    const registry = buildAlphaHypothesisRegistry('2026-05-02T00:00:00.000Z')

    expect(registry.entries.map(entry => entry.familyId)).toEqual([
      'volume_breakout',
      'microstructure',
      'cross_sectional',
    ])
    expect(registry.entries.every(entry => entry.whoPays.length > 0)).toBe(true)
    expect(registry.entries.every(entry => entry.falsificationRule.action)).toBe(true)
  })

  it('keeps trial ledger promotion-blocked while counting visible trial sources', () => {
    const accepted = [
      makeTrade({ lane: 'volume_breakout_1x', symbol: 'ETH-USDT', pnlPct: -1 }),
      makeTrade({ lane: 'cross_sectional', symbol: 'BTC-USDT', pnlPct: 0.5 }),
    ]
    const gate = buildGateEffectivenessReport({
      acceptedTrades: accepted,
      ledgerEntries: [],
      lookbackHours: null,
      generatedAt: '2026-05-02T00:00:00.000Z',
    })
    const alphaRegistry = buildAlphaHypothesisRegistry('2026-05-02T00:00:00.000Z')

    const ledger = buildTrialLedgerReport({
      acceptedTrades: accepted,
      gateEffectiveness: gate,
      alphaRegistry,
      visibleTrialSources: {
        entries: [{
          trialId: 'optimization_sweep:test:topConfig:0:abc',
          familyId: 'cross_sectional',
          policyId: 'cross_sectional_optimizer_abc',
          featureSetHash: 'feature',
          universeHash: 'universe',
          parameterCluster: 'abc',
          status: 'active',
          source: 'optimization_sweep',
          metrics: { score: 1 },
          includedInRawM: true,
          includedInEffectiveM: true,
        }],
        diagnostics: [{
          source: 'optimization_sweep',
          path: '/tmp/sweep.json',
          status: 'loaded',
          recordsIn: 10,
          entriesEmitted: 1,
          notes: ['candidateCount exceeds emitted topConfigs; missing failed/non-top parameter rows keep rawMComplete=false'],
        }],
      },
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(ledger.raw_m).toBe(1)
    expect(ledger.effective_m).toBe(1)
    expect(ledger.rawMComplete).toBe(false)
    expect(ledger.rawMCompleteness).toBe('visible_sources_only')
    expect(ledger.status).toBe('skeleton')
    expect(ledger.promotionEligible).toBe(false)
    expect(ledger.fdrGateStatus).toBe('blocked_missing_complete_trial_universe')
    expect(ledger.fdrDiagnostics).toMatchObject({
      status: 'skeleton_no_pvalues',
      raw_m: 1,
      effective_m: 1,
      fdrComputationEligibleM: 0,
      fdrComputationM: 0,
      excludedFromFdrComputationM: 1,
      excludedMissingPValueTrials: 1,
      fdrComputationSkippedReason: 'complete_trial_universe_required',
    })
    expect(ledger.fdrDiagnostics.entries.find((entry) => entry.policyId === 'volume_breakout_clean_v1')).toMatchObject({
      eligibleForFdrComputation: false,
      includedInFdrComputation: false,
      fdrComputationExclusionReason: 'excluded_from_raw_m',
      reason: 'excluded_from_raw_m',
    })
    expect(ledger.fdrDiagnostics.entries.find((entry) => entry.policyId === 'cross_sectional_optimizer_abc')).toMatchObject({
      eligibleForFdrComputation: false,
      includedInFdrComputation: false,
      fdrComputationExclusionReason: 'missing_p_value',
      reason: 'missing_p_value_p1_skeleton',
    })
    expect(ledger.sourceDiagnostics[0]).toMatchObject({
      source: 'optimization_sweep',
      status: 'loaded',
      recordsIn: 10,
      entriesEmitted: 1,
    })
  })

  it('counts every optimizer v2 trialUniverse row instead of only top configs', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    const dataDir = join(root, 'market')
    const outputDir = join(root, 'out')
    const optimizationDir = join(root, 'optimization')
    const validationDir = join(root, 'new_strategies_validation')
    mkdirSync(paperDir, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(optimizationDir, { recursive: true })
    mkdirSync(validationDir, { recursive: true })

    writeFileSync(join(root, 'candidate_registry.json'), JSON.stringify({ entries: [] }))
    writeFileSync(join(root, 'graveyard.json'), JSON.stringify({ entries: [] }))
    writeFileSync(join(root, 'trial_registry.jsonl'), '')
    writeFileSync(join(root, 'best_config.json'), JSON.stringify({
      assetCount: 3,
      discoveredAt: '2026-05-04T00:00:00.000Z',
      config: { lookbackHours: 72, minSpreadPct: 1 },
    }))
    writeFileSync(join(optimizationDir, 'sweep_trial_universe.json'), JSON.stringify({
      schemaVersion: 'cross_sectional_optimizer_sweep.v2',
      generatedAt: '2026-05-04T00:00:00.000Z',
      experimentId: 'optimizer-v2-test',
      candidateCount: 3,
      topConfigs: [{
        lookbackHours: 72,
        minSpreadPct: 1,
        signals: 40,
        winRate: 55,
        avgSpread: 0.5,
        score: 0.8,
      }],
      trialUniverse: {
        schemaVersion: 'optimizer_trial_universe.v1',
        source: 'optimize_cross_sectional',
        completeForThisSweep: true,
        rawM: 3,
        effectiveM: 3,
        includesFailedTrials: true,
        fdrMethodPrimary: 'BY_raw_m',
        pValueStatus: 'not_computed',
        pValueUnavailableReason: 'optimizer_sweep_trial_p_value_not_computed_from_complete_oos_distribution',
        trials: [
          {
            trialId: 'optimizer-v2-test:trial-active',
            candidateId: 'cross_sectional_v2_active',
            parameterHash: 'optimizer-active-hash',
            status: 'active',
            includedInRawM: true,
            includedInEffectiveM: true,
            pValue: null,
            pValueUnavailableReason: 'optimizer_sweep_trial_p_value_not_computed_from_complete_oos_distribution',
            fdrReportStatus: 'not_computed',
            fdrPValuesAvailable: false,
            fdrPValueIsPromotionGrade: false,
            pitAuditStatus: 'not_implemented',
            pitAuditPromotionGrade: false,
            failureCodes: ['FDR_INPUTS_INCOMPLETE', 'PIT_AUDIT_NOT_IMPLEMENTED'],
            lookbackHours: 72,
            minSpreadPct: 1,
            score: 0.8,
          },
          {
            trialId: 'optimizer-v2-test:trial-killed',
            candidateId: 'cross_sectional_v2_killed',
            parameterHash: 'optimizer-killed-hash',
            status: 'killed',
            includedInRawM: true,
            includedInEffectiveM: true,
            pValue: null,
            pValueUnavailableReason: 'optimizer_sweep_trial_p_value_not_computed_from_complete_oos_distribution',
            fdrReportStatus: 'not_computed',
            fdrPValuesAvailable: false,
            fdrPValueIsPromotionGrade: false,
            pitAuditStatus: 'not_implemented',
            pitAuditPromotionGrade: false,
            failureCodes: ['FDR_INPUTS_INCOMPLETE', 'PIT_AUDIT_NOT_IMPLEMENTED'],
            lookbackHours: 120,
            minSpreadPct: 3,
            score: 0,
          },
          {
            trialId: 'optimizer-v2-test:trial-graveyard',
            candidateId: 'cross_sectional_v2_graveyard',
            parameterHash: 'optimizer-graveyard-hash',
            status: 'graveyard',
            includedInRawM: true,
            includedInEffectiveM: true,
            pValue: null,
            pValueUnavailableReason: 'optimizer_sweep_trial_p_value_not_computed_from_complete_oos_distribution',
            fdrReportStatus: 'not_computed',
            fdrPValuesAvailable: false,
            fdrPValueIsPromotionGrade: false,
            pitAuditStatus: 'not_implemented',
            pitAuditPromotionGrade: false,
            failureCodes: ['FDR_INPUTS_INCOMPLETE', 'PIT_AUDIT_NOT_IMPLEMENTED'],
            lookbackHours: 168,
            minSpreadPct: 5,
            score: 0.1,
          },
        ],
      },
    }))

    const index = await buildP1TradingEvidence({
      paperDir,
      dataDir,
      oneSecondDataDir: dataDir,
      oneHourDataDir: dataDir,
      shadowLedgerPath: join(paperDir, 'missing_shadow.jsonl'),
      outputDir,
      candidateRegistryPath: join(root, 'candidate_registry.json'),
      graveyardPath: join(root, 'graveyard.json'),
      bestConfigPath: join(root, 'best_config.json'),
      trialRegistryPath: join(root, 'trial_registry.jsonl'),
      evidenceOutputRoot: join(root, 'runtime_research'),
      optimizationDir,
      validationDir,
      routeCostBudgetPath: join(root, 'missing_route_cost_budget.json'),
      timeframe: '5m',
      lookbackHours: null,
      json: true,
    })

    const trialLedger = JSON.parse(await readFile(index.artifacts.trialLedger, 'utf-8'))
    const optimizerEntries = trialLedger.entries.filter((entry: any) => entry.source === 'optimization_sweep')
    expect(optimizerEntries).toHaveLength(3)
    expect(optimizerEntries.map((entry: any) => entry.status).sort()).toEqual(['active', 'graveyard', 'killed'])
    expect(optimizerEntries.every((entry: any) => entry.includedInRawM)).toBe(true)
    expect(optimizerEntries.every((entry: any) => entry.metrics.fdrPValueBlockedReason === 'optimizer_sweep_trial_p_value_not_computed_from_complete_oos_distribution')).toBe(true)
    expect(optimizerEntries.every((entry: any) => entry.metrics.failureCodes === 'FDR_INPUTS_INCOMPLETE|PIT_AUDIT_NOT_IMPLEMENTED')).toBe(true)
    expect(trialLedger.sourceDiagnostics.find((item: any) => item.source === 'optimization_sweep')).toMatchObject({
      status: 'loaded',
      recordsIn: 3,
      entriesEmitted: 3,
      notes: expect.arrayContaining([
        'optimizer trialUniverse is complete for this sweep, including failed/non-top rows; p-values may still be unavailable',
      ]),
    })
    expect(trialLedger.readinessGaps).toMatchObject({
      includedRawMTrials: 3,
      visibleFailedTrials: 2,
      missingPValueTrials: 3,
      fdrInputsIncompleteTrials: 3,
      pitAuditNotImplementedTrials: 3,
    })
    expect(trialLedger.readinessGaps.pValueUnavailableReasonCounts).toEqual([
      { reason: 'optimizer_sweep_trial_p_value_not_computed_from_complete_oos_distribution', count: 3 },
    ])
    expect(trialLedger.readinessGaps.blockerSummary).toEqual(expect.arrayContaining([
      'missing_complete_trial_universe_marker',
      'missing_p_value_trials:3',
      'fdr_inputs_incomplete_trials:3',
      'pit_audit_not_implemented_trials:3',
    ]))
  })

  it('keeps trial ledger blocked when p-values exist but raw_m is only visible sources', () => {
    const gate = buildGateEffectivenessReport({
      acceptedTrades: [],
      ledgerEntries: [],
      lookbackHours: null,
      generatedAt: '2026-05-02T00:00:00.000Z',
    })
    const alphaRegistry = emptyAlphaRegistry()

    const ledger = buildTrialLedgerReport({
      acceptedTrades: [],
      gateEffectiveness: gate,
      alphaRegistry,
      visibleTrialSources: {
        entries: [
          makeTrialLedgerEntry({ trialId: 'trial-a', policyId: 'policy-a', pValue: 0.01, status: 'active' }),
          makeTrialLedgerEntry({ trialId: 'trial-b', policyId: 'policy-b', pValue: 0.2, status: 'killed' }),
        ],
        diagnostics: [],
      },
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(ledger.rawMComplete).toBe(false)
    expect(ledger.rawMCompleteness).toBe('visible_sources_only')
    expect(ledger.includesFailedTrials).toBe(false)
    expect(ledger.status).toBe('skeleton')
    expect(ledger.promotionEligible).toBe(false)
    expect(ledger.fdrGateStatus).toBe('blocked_missing_complete_trial_universe')
    expect(ledger.fdrDiagnostics.status).toBe('blocked_missing_complete_trial_universe')
    expect(ledger.fdrDiagnostics.entries.find((entry) => entry.policyId === 'policy-a')).toMatchObject({
      pValue: 0.01,
      eligibleForFdrComputation: true,
      includedInFdrComputation: false,
      fdrComputationExclusionReason: 'complete_trial_universe_required',
      pAdjustedBYRawM: null,
      pAdjustedBHSecondary: null,
      reason: 'complete_trial_universe_required_for_promotion_fdr',
    })
    expect(ledger.readinessGaps).toMatchObject({
      includedRawMTrials: 2,
      visibleFailedTrials: 1,
      visibleSurvivingTrials: 1,
      missingPValueTrials: 0,
      fdrReportPresentTrials: 0,
      fdrReportBlockedTrials: 0,
      missingFdrReportPathTrials: 2,
      missingPitAuditMetadataTrials: 2,
      completeTrialUniverseMarkers: 0,
      blockerSummary: [
        'missing_complete_trial_universe_marker',
        'missing_fdr_report_path_trials:2',
        'missing_pit_audit_metadata_trials:2',
      ],
    })
  })

  it('runs ledger-bound BY raw_m and secondary BH only for complete trial universes with all p-values', () => {
    const gate = buildGateEffectivenessReport({
      acceptedTrades: [],
      ledgerEntries: [],
      lookbackHours: null,
      generatedAt: '2026-05-02T00:00:00.000Z',
    })
    const alphaRegistry = emptyAlphaRegistry()

    const ledger = buildTrialLedgerReport({
      acceptedTrades: [],
      gateEffectiveness: gate,
      alphaRegistry,
      visibleTrialSources: {
        entries: [
          makeTrialLedgerEntry({ trialId: 'trial-a', policyId: 'policy-a', pValue: 0.001, status: 'active' }),
          makeTrialLedgerEntry({ trialId: 'trial-b', policyId: 'policy-b', pValue: 0.02, status: 'killed' }),
          makeTrialLedgerEntry({ trialId: 'trial-c', policyId: 'policy-c', pValue: 0.6, status: 'killed', parameterCluster: 'cluster-c' }),
        ],
        diagnostics: [],
      },
      rawMComplete: true,
      includesFailedTrials: true,
      rawMCompleteness: 'complete_trial_universe',
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(ledger.rawMComplete).toBe(true)
    expect(ledger.rawMCompleteness).toBe('complete_trial_universe')
    expect(ledger.includesFailedTrials).toBe(true)
    expect(ledger.failedTrialCount).toBe(2)
    expect(ledger.survivingTrialCount).toBe(1)
    expect(ledger.status).toBe('valid')
    expect(ledger.promotionEligible).toBe(true)
    expect(ledger.fdrGateStatus).toBe('ready_explanatory_only')
    expect(ledger.fdrDiagnostics).toMatchObject({
      status: 'ready',
      fdrComputationEligibleM: 3,
      fdrComputationM: 3,
      excludedFromFdrComputationM: 0,
      excludedMissingPValueTrials: 0,
      excludedNonPromotionGradePValueTrials: 0,
      fdrComputationSkippedReason: null,
      fdrMethodPrimary: 'BY_raw_m',
      fdrMethodSecondary: 'BY_effective_m',
      secondaryReports: {
        BH_secondary: {
          method: 'bh',
          candidateCount: 3,
        },
      },
    })
    const policyA = ledger.fdrDiagnostics.entries.find((entry) => entry.policyId === 'policy-a')
    expect(policyA?.pAdjustedBYRawM).toBeGreaterThan(0)
    expect(policyA?.pAdjustedBHSecondary).toBeGreaterThan(0)
    expect(policyA?.includedInFdrComputation).toBe(true)
    expect(policyA?.fdrComputationExclusionReason).toBeNull()
    expect(policyA?.reason).toBe('p1_report_explanatory_only')
  })

  it('derives complete trial universe readiness from a runtime marker row', () => {
    const gate = buildGateEffectivenessReport({
      acceptedTrades: [],
      ledgerEntries: [],
      lookbackHours: null,
      generatedAt: '2026-05-02T00:00:00.000Z',
    })
    const alphaRegistry = emptyAlphaRegistry()

    const ledger = buildTrialLedgerReport({
      acceptedTrades: [],
      gateEffectiveness: gate,
      alphaRegistry,
      visibleTrialSources: {
        entries: [
          makeTrialLedgerEntry({ trialId: 'trial-a', policyId: 'policy-a', pValue: 0.001, status: 'active' }),
          makeTrialLedgerEntry({ trialId: 'trial-b', policyId: 'policy-b', pValue: 0.02, status: 'killed' }),
          makeTrialLedgerEntry({
            trialId: 'trial-universe-marker',
            policyId: 'trial-universe-marker',
            pValue: null,
            status: 'registered',
            includedInRawM: false,
            includedInEffectiveM: false,
            metrics: {
              trialUniverseMarker: true,
              trialUniverseMarkerType: 'complete_trial_universe',
              trialLedgerRawMComplete: true,
              trialLedgerIncludesFailedTrials: true,
            },
          }),
        ],
        diagnostics: [],
      },
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(ledger.rawMComplete).toBe(true)
    expect(ledger.rawMCompleteness).toBe('complete_trial_universe')
    expect(ledger.includesFailedTrials).toBe(true)
    expect(ledger.status).toBe('valid')
    expect(ledger.fdrGateStatus).toBe('ready_explanatory_only')
    expect(ledger.readinessGaps.completeTrialUniverseMarkers).toBe(1)
    expect(ledger.readinessGaps.blockerSummary).not.toContain('missing_complete_trial_universe_marker')
    expect(ledger.fdrDiagnostics).toMatchObject({
      status: 'ready',
      raw_m: 2,
      fdrComputationEligibleM: 2,
      fdrComputationM: 2,
      excludedMissingPValueTrials: 0,
      fdrComputationSkippedReason: null,
    })
  })

  it('derives complete trial universe readiness from the registry marker API output', () => {
    const gate = buildGateEffectivenessReport({
      acceptedTrades: [],
      ledgerEntries: [],
      lookbackHours: null,
      generatedAt: '2026-05-04T00:00:00.000Z',
    })
    const alphaRegistry = emptyAlphaRegistry()
    const markerJson = trialRecordToJson(buildCompleteTrialUniverseMarkerRecord({
      trialId: 'trial-universe-marker-api',
      evidenceId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      fdrFamily: '2026Q2_crypto_evidence_os_v4',
      rawM: 2,
      effectiveM: 2,
      includedTrialCount: 2,
      failedTrialCount: 1,
      survivingTrialCount: 1,
      createdAt: '2026-05-04T00:00:00.000Z',
    }))

    const ledger = buildTrialLedgerReport({
      acceptedTrades: [],
      gateEffectiveness: gate,
      alphaRegistry,
      visibleTrialSources: {
        entries: [
          makeTrialLedgerEntry({ trialId: 'trial-a', policyId: 'policy-a', pValue: 0.01, status: 'active' }),
          makeTrialLedgerEntry({ trialId: 'trial-b', policyId: 'policy-b', pValue: 0.2, status: 'killed' }),
          makeTrialLedgerEntry({
            trialId: String(markerJson.trial_id),
            policyId: String(markerJson.candidate_id),
            pValue: null,
            status: 'registered',
            source: 'runtime_trial_registry',
            includedInRawM: false,
            includedInEffectiveM: false,
            metrics: {
              trialUniverseMarker: true,
              trialUniverseMarkerType: 'complete_trial_universe',
              trialLedgerRawMComplete: true,
              trialLedgerIncludesFailedTrials: true,
            },
          }),
        ],
        diagnostics: [],
      },
      generatedAt: '2026-05-04T00:00:00.000Z',
    })
    const coverage = buildTrialSourceCoverageReport({ trialLedger: ledger })

    expect(ledger.rawMComplete).toBe(true)
    expect(ledger.includesFailedTrials).toBe(true)
    expect(ledger.readinessGaps.blockerSummary).not.toContain('missing_complete_trial_universe_marker')
    expect(coverage.summary.primaryBlockers).not.toContain('missing_complete_trial_universe_marker')
  })

  it('keeps complete trial universes blocked when any included FDR p-value is missing', () => {
    const gate = buildGateEffectivenessReport({
      acceptedTrades: [],
      ledgerEntries: [],
      lookbackHours: null,
      generatedAt: '2026-05-02T00:00:00.000Z',
    })
    const alphaRegistry = emptyAlphaRegistry()

    const ledger = buildTrialLedgerReport({
      acceptedTrades: [],
      gateEffectiveness: gate,
      alphaRegistry,
      visibleTrialSources: {
        entries: [
          makeTrialLedgerEntry({ trialId: 'trial-a', policyId: 'policy-a', pValue: 0.01, status: 'active' }),
          makeTrialLedgerEntry({ trialId: 'trial-b', policyId: 'policy-b', pValue: null, status: 'killed' }),
        ],
        diagnostics: [],
      },
      rawMComplete: true,
      includesFailedTrials: true,
      rawMCompleteness: 'complete_trial_universe',
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(ledger.rawMComplete).toBe(true)
    expect(ledger.status).toBe('skeleton')
    expect(ledger.promotionEligible).toBe(false)
    expect(ledger.fdrGateStatus).toBe('blocked_missing_pvalues')
    expect(ledger.fdrDiagnostics.status).toBe('skeleton_no_pvalues')
    expect(ledger.fdrDiagnostics).toMatchObject({
      fdrComputationEligibleM: 1,
      fdrComputationM: 0,
      excludedFromFdrComputationM: 2,
      excludedMissingPValueTrials: 1,
      excludedNonPromotionGradePValueTrials: 0,
      fdrComputationSkippedReason: 'missing_p_values',
    })
    expect(ledger.fdrDiagnostics.entries.find((entry) => entry.policyId === 'policy-a')).toMatchObject({
      pValue: 0.01,
      eligibleForFdrComputation: true,
      includedInFdrComputation: false,
      fdrComputationExclusionReason: 'fdr_inputs_not_ready',
      pAdjustedBYRawM: null,
    })
    expect(ledger.fdrDiagnostics.entries.find((entry) => entry.policyId === 'policy-b')).toMatchObject({
      pValue: null,
      eligibleForFdrComputation: false,
      includedInFdrComputation: false,
      fdrComputationExclusionReason: 'missing_p_value',
      pAdjustedBYRawM: null,
      reason: 'missing_p_value_p1_skeleton',
    })
    expect(ledger.readinessGaps).toMatchObject({
      includedRawMTrials: 2,
      visibleFailedTrials: 1,
      visibleSurvivingTrials: 1,
      missingPValueTrials: 1,
    })
    expect(ledger.readinessGaps.blockerSummary).toContain('missing_p_value_trials:1')
  })

  it('excludes null and non-promotion-grade p-values from FDR adjustment diagnostics', () => {
    const gate = buildGateEffectivenessReport({
      acceptedTrades: [],
      ledgerEntries: [],
      lookbackHours: null,
      generatedAt: '2026-05-02T00:00:00.000Z',
    })
    const alphaRegistry = emptyAlphaRegistry()

    const ledger = buildTrialLedgerReport({
      acceptedTrades: [],
      gateEffectiveness: gate,
      alphaRegistry,
      visibleTrialSources: {
        entries: [
          makeTrialLedgerEntry({ trialId: 'trial-a', policyId: 'finite-promotion-grade', pValue: 0.01, status: 'active' }),
          makeTrialLedgerEntry({ trialId: 'trial-b', policyId: 'missing-pvalue', pValue: null, status: 'killed' }),
          makeTrialLedgerEntry({
            trialId: 'trial-c',
            policyId: 'explanatory-pvalue',
            pValue: 0.02,
            status: 'killed',
            metrics: { fdrPValueIsPromotionGrade: false },
          }),
        ],
        diagnostics: [],
      },
      rawMComplete: true,
      includesFailedTrials: true,
      rawMCompleteness: 'complete_trial_universe',
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(ledger.raw_m).toBe(3)
    expect(ledger.effective_m).toBe(1)
    expect(ledger.status).toBe('skeleton')
    expect(ledger.promotionEligible).toBe(false)
    expect(ledger.fdrGateStatus).toBe('blocked_missing_pvalues')
    expect(ledger.fdrDiagnostics).toMatchObject({
      status: 'skeleton_no_pvalues',
      raw_m: 3,
      effective_m: 1,
      fdrComputationEligibleM: 1,
      fdrComputationM: 0,
      excludedFromFdrComputationM: 3,
      excludedMissingPValueTrials: 1,
      excludedNonPromotionGradePValueTrials: 1,
      excludedPromotionGradeMissingTrials: 2,
      fdrComputationSkippedReason: 'missing_p_values',
    })
    expect(ledger.fdrDiagnostics.entries.find(entry => entry.policyId === 'finite-promotion-grade')).toMatchObject({
      pValue: 0.01,
      eligibleForFdrComputation: true,
      includedInFdrComputation: false,
      fdrComputationExclusionReason: 'fdr_inputs_not_ready',
      pAdjustedBYRawM: null,
      pAdjustedBHSecondary: null,
    })
    expect(ledger.fdrDiagnostics.entries.find(entry => entry.policyId === 'missing-pvalue')).toMatchObject({
      pValue: null,
      eligibleForFdrComputation: false,
      includedInFdrComputation: false,
      fdrComputationExclusionReason: 'missing_p_value',
      pAdjustedBYRawM: null,
      pAdjustedBHSecondary: null,
    })
    expect(ledger.fdrDiagnostics.entries.find(entry => entry.policyId === 'explanatory-pvalue')).toMatchObject({
      pValue: 0.02,
      eligibleForFdrComputation: false,
      includedInFdrComputation: false,
      fdrComputationExclusionReason: 'p_value_not_promotion_grade',
      pAdjustedBYRawM: null,
      pAdjustedBHSecondary: null,
    })
  })

  it('distinguishes emitted fail-closed FDR reports from missing FDR reports', () => {
    const gate = buildGateEffectivenessReport({
      acceptedTrades: [],
      ledgerEntries: [],
      lookbackHours: null,
      generatedAt: '2026-05-02T00:00:00.000Z',
    })
    const alphaRegistry = emptyAlphaRegistry()

    const ledger = buildTrialLedgerReport({
      acceptedTrades: [],
      gateEffectiveness: gate,
      alphaRegistry,
      visibleTrialSources: {
        entries: [
          makeTrialLedgerEntry({
            trialId: 'trial-fdr-artifact',
            policyId: 'policy-fdr-artifact',
            pValue: null,
            status: 'killed',
            metrics: {
              failureCodes: 'FDR_INPUTS_INCOMPLETE|PIT_PROXY_ONLY',
              fdrReportPath: '/tmp/fdr_report.json',
              fdrReportStatus: 'blocked_inputs_incomplete',
              fdrPValueBlockedReason: 'raw_m_complete=false',
              pitAuditStatus: 'blocked',
              trialLedgerRawMComplete: true,
              trialLedgerIncludesFailedTrials: true,
            },
          }),
        ],
        diagnostics: [],
      },
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(ledger.readinessGaps).toMatchObject({
      missingFdrReportTrials: 0,
      fdrInputsIncompleteTrials: 1,
      fdrReportPresentTrials: 1,
      fdrReportBlockedTrials: 1,
      missingFdrReportPathTrials: 0,
      pitAuditNotImplementedTrials: 0,
      pitProxyOnlyTrials: 1,
      missingPitAuditMetadataTrials: 0,
      completeTrialUniverseMarkers: 0,
      pValueUnavailableReasonCounts: [{ reason: 'raw_m_complete=false', count: 1 }],
      fdrBlockedReasonCounts: [{ reason: 'blocked_inputs_incomplete', count: 1 }],
    })
    expect(ledger.readinessGaps.blockerSummary).toEqual(expect.arrayContaining([
      'missing_complete_trial_universe_marker',
      'missing_p_value_trials:1',
      'fdr_inputs_incomplete_trials:1',
      'pit_proxy_only_trials:1',
    ]))
  })

  it('marks explanatory runtime p-values as non-promotion-grade evidence', () => {
    const gate = buildGateEffectivenessReport({
      acceptedTrades: [],
      ledgerEntries: [],
      lookbackHours: null,
      generatedAt: '2026-05-02T00:00:00.000Z',
    })
    const alphaRegistry = emptyAlphaRegistry()

    const ledger = buildTrialLedgerReport({
      acceptedTrades: [],
      gateEffectiveness: gate,
      alphaRegistry,
      visibleTrialSources: {
        entries: [
          makeTrialLedgerEntry({
            trialId: 'runtime-explanatory-pvalue',
            policyId: 'runtime-explanatory-pvalue',
            pValue: 0.42,
            status: 'killed',
            metrics: {
              failureCodes: 'FDR_INPUTS_INCOMPLETE',
              fdrReportPath: '/tmp/fdr_report.json',
              fdrReportPathSource: 'registry_metadata',
              fdrReportStatus: 'blocked_inputs_incomplete',
              pValueSource: 'fdr_report',
              fdrPValuesAvailable: true,
              fdrMissingPValueCount: 0,
              fdrPValueMethod: 'spa_like_moving_block_selected_vs_deterministic_holdout_benchmark_v1',
              fdrPValueScope: 'explanatory_selected_vs_holdout_benchmark',
              fdrPValueIsPromotionGrade: false,
              pitAuditStatus: 'blocked',
              pitAuditSource: 'registry_metadata',
              pitAuditBlockingCodes: 'PIT_PROXY_ONLY',
              pitAuditProxyType: 'csv_bar_event_time_as_decision_time',
              pitAuditPromotionGrade: false,
              pitAuditPromotionGradeSource: 'registry_metadata',
            },
          }),
          makeTrialLedgerEntry({
            trialId: 'runtime-unavailable-pvalue',
            policyId: 'runtime-unavailable-pvalue',
            pValue: null,
            status: 'killed',
            metrics: {
              failureCodes: 'FDR_INPUTS_INCOMPLETE',
              fdrReportPath: '/tmp/fdr_report_2.json',
              fdrReportPathSource: 'registry_metadata',
              fdrReportStatus: 'blocked_inputs_incomplete',
              pValueSource: 'missing',
              fdrPValuesAvailable: false,
              fdrMissingPValueCount: 1,
              fdrPValueBlockedReason: 'selected_candidate_p_value_not_finite',
              pitAuditStatus: 'blocked',
              pitAuditSource: 'registry_metadata',
              pitAuditBlockingCodes: 'PIT_PROXY_ONLY',
              pitAuditProxyType: 'csv_bar_event_time_as_decision_time',
              pitAuditPromotionGrade: false,
              pitAuditPromotionGradeSource: 'registry_metadata',
            },
          }),
        ],
        diagnostics: [],
      },
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    const coverage = buildTrialSourceCoverageReport({ trialLedger: ledger })

    expect(ledger.readinessGaps).toMatchObject({
      fdrReportPresentTrials: 2,
      fdrReportBlockedTrials: 2,
      fdrInputsIncompleteTrials: 2,
      fdrPValueAvailableTrials: 1,
      fdrPValueUnavailableTrials: 1,
      fdrPValueNonPromotionGradeTrials: 1,
      missingPValueTrials: 1,
    })
    expect(ledger.readinessGaps.blockerSummary).toEqual(expect.arrayContaining([
      'fdr_inputs_incomplete_trials:2',
      'fdr_p_value_non_promotion_grade_trials:1',
      'missing_p_value_trials:1',
    ]))
    expect(ledger.readinessGaps.pValueUnavailableReasonCounts).toEqual([
      { reason: 'selected_candidate_p_value_not_finite', count: 1 },
    ])
    expect(ledger.fdrDiagnostics.entries.find(entry => entry.policyId === 'runtime-explanatory-pvalue')).toMatchObject({
      pValue: 0.42,
      eligibleForFdrComputation: false,
      includedInFdrComputation: false,
      fdrComputationExclusionReason: 'p_value_not_promotion_grade',
      pAdjustedBYRawM: null,
      promotionAllowed: false,
      reason: 'p_value_not_promotion_grade',
    })
    expect(ledger.fdrDiagnostics).toMatchObject({
      fdrComputationEligibleM: 0,
      fdrComputationM: 0,
      excludedFromFdrComputationM: 2,
      excludedMissingPValueTrials: 1,
      excludedNonPromotionGradePValueTrials: 1,
      excludedPromotionGradeMissingTrials: 2,
      fdrComputationSkippedReason: 'complete_trial_universe_required',
    })
    expect(coverage.bySource.find(item => item.key === 'runtime_trial_registry')).toMatchObject({
      fdrReportPresentTrials: 2,
      fdrReportBlockedTrials: 2,
      fdrInputsIncompleteTrials: 2,
      fdrPValueAvailableTrials: 1,
      fdrPValueUnavailableTrials: 1,
      fdrPValueNonPromotionGradeTrials: 1,
    })
    expect(coverage.runtimeRegistryDiagnostics).toMatchObject({
      diagnosticOnly: true,
      promotionEligible: false,
      entries: 2,
      includedRawMTrials: 2,
      rowsWithRegistryPValue: 0,
      rowsWithArtifactPValue: 1,
      rowsMissingPValueBecauseFdrArtifactMissing: 0,
      rowsWithExplanatoryOnlyPValue: 1,
      rowsWithMetadataFdrReportPath: 2,
      rowsWithArtifactLinkedFdrReport: 0,
      rowsWithBlockedPitAudit: 2,
      rowsWithDefaultFailClosedPitPromotionGrade: 0,
      metadataCoverage: {
        rowsWithFdrReportPath: 2,
        rowsWithFdrReportStatus: 2,
        rowsWithPitAuditStatus: 2,
        rowsWithPitAuditPromotionGrade: 2,
        rowsWithPromotionGradePitAudit: 0,
      },
      pValueSourceCounts: [
        { source: 'fdr_report', count: 1 },
        { source: 'missing', count: 1 },
      ],
      fdrReportStatusCounts: [{ status: 'blocked_inputs_incomplete', count: 2 }],
      pitAuditStatusCounts: [{ status: 'blocked', count: 2 }],
      pitAuditPromotionGradeCounts: [{ status: 'false', count: 2 }],
    })
  })

  it('prefers explicit runtime trial provenance sources over legacy inference', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    const dataDir = join(root, 'market')
    const outputDir = join(root, 'out')
    mkdirSync(paperDir, { recursive: true })
    mkdirSync(dataDir, { recursive: true })

    const trialRegistryPath = join(root, 'trial_registry.jsonl')
    writeFileSync(join(root, 'candidate_registry.json'), JSON.stringify({ entries: [] }))
    writeFileSync(join(root, 'graveyard.json'), JSON.stringify({ entries: [] }))
    writeFileSync(join(root, 'best_config.json'), JSON.stringify({
      assetCount: 2,
      discoveredAt: '2026-05-04T00:00:00.000Z',
      config: { lookbackHours: 72 },
    }))
    writeFileSync(trialRegistryPath, JSON.stringify({
      trial_id: 'explicit-provenance-trial',
      evidence_id: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      trial_type: 'alpha_candidate',
      strategy_family: 'trend',
      candidate_id: 'explicit-provenance-candidate',
      hypothesis: 'explicit provenance survives loader',
      primary_metric: 'cost_adjusted_net_expectancy_bps',
      secondary_metrics: [],
      p_value: 0.25,
      included_in_fdr: true,
      fdr_family: '2026Q2_crypto_evidence_os_v4',
      promotion_eligible: false,
      status: 'failed_validation',
      failure_codes: ['FDR_INPUTS_INCOMPLETE', 'PIT_PROXY_ONLY'],
      batch_id: 'batch-explicit',
      created_at: '2026-05-04T00:00:00.000Z',
      metadata: {
        p_value_source: 'fdr_report',
        fdr_report_path: '/tmp/fdr_report.json',
        fdr_report_path_source: 'generated_artifact',
        fdr_report_status: 'blocked_inputs_incomplete',
        raw_m_complete: false,
        includes_failed_trials: false,
        fdr_p_values_available: true,
        fdr_missing_p_value_count: 0,
        fdr_p_value_method: 'spa_like',
        fdr_p_value_scope: 'explanatory_selected_vs_holdout_benchmark',
        fdr_p_value_is_promotion_grade: false,
        fdr_p_value_promotion_grade_source: 'fdr_report',
        pit_audit_path: '/tmp/feature_availability_audit.json',
        pit_audit_source: 'feature_availability_audit',
        pit_audit_status: 'blocked',
        pit_audit_blocking_codes: ['PIT_PROXY_ONLY'],
        pit_audit_promotion_grade: false,
        pit_audit_promotion_grade_source: 'feature_availability_audit',
        promotion_decision_source: 'fail_closed_validation_pipeline',
      },
    }) + '\n')

    const index = await buildP1TradingEvidence({
      paperDir,
      dataDir,
      oneSecondDataDir: dataDir,
      oneHourDataDir: dataDir,
      shadowLedgerPath: join(paperDir, 'missing_shadow.jsonl'),
      outputDir,
      candidateRegistryPath: join(root, 'candidate_registry.json'),
      graveyardPath: join(root, 'graveyard.json'),
      bestConfigPath: join(root, 'best_config.json'),
      trialRegistryPath,
      evidenceOutputRoot: join(root, 'runtime_research'),
      optimizationDir: join(root, 'missing_optimization'),
      validationDir: join(root, 'missing_validation'),
      routeCostBudgetPath: join(root, 'missing_route_cost_budget.json'),
      timeframe: '5m',
      lookbackHours: null,
      json: true,
    })

    const trialLedger = JSON.parse(await readFile(index.artifacts.trialLedger, 'utf-8'))
    const entry = trialLedger.entries.find((item: any) => item.source === 'runtime_trial_registry')
    expect(entry.metrics).toMatchObject({
      pValue: 0.25,
      pValueSource: 'fdr_report',
      fdrReportPathSource: 'generated_artifact',
      pitAuditSource: 'feature_availability_audit',
      pitAuditPromotionGradeSource: 'feature_availability_audit',
      fdrPValueIsPromotionGrade: false,
      pitAuditPromotionGrade: false,
    })
    const coverage = JSON.parse(await readFile(index.artifacts.trialSourceCoverage, 'utf-8'))
    expect(coverage.runtimeRegistryDiagnostics.pValueSourceCounts).toContainEqual({ source: 'fdr_report', count: 1 })
    expect(coverage.runtimeRegistryDiagnostics.fdrReportPathSourceCounts).toContainEqual({ source: 'generated_artifact', count: 1 })
    expect(coverage.runtimeRegistryDiagnostics.pitAuditSourceCounts).toContainEqual({ source: 'feature_availability_audit', count: 1 })
    expect(coverage.runtimeRegistryDiagnostics.pitAuditPromotionGradeSourceCounts).toContainEqual({ source: 'feature_availability_audit', count: 1 })
  })

  it('quarantines validation CLI test-harness leaks from runtime raw_m without rewriting registry rows', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    const dataDir = join(root, 'market')
    const outputDir = join(root, 'out')
    mkdirSync(paperDir, { recursive: true })
    mkdirSync(dataDir, { recursive: true })

    const trialRegistryPath = join(root, 'trial_registry.jsonl')
    writeFileSync(join(root, 'candidate_registry.json'), JSON.stringify({ entries: [] }))
    writeFileSync(join(root, 'graveyard.json'), JSON.stringify({ entries: [] }))
    writeFileSync(join(root, 'best_config.json'), JSON.stringify({
      assetCount: 2,
      discoveredAt: '2026-05-04T00:00:00.000Z',
      config: { lookbackHours: 72 },
    }))
    const registryLine = JSON.stringify({
      trial_id: 'leaked-validation-spec-trial',
      evidence_id: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      trial_type: 'alpha_candidate',
      strategy_family: 'shock_fade',
      candidate_id: 'leaked-validation-spec-candidate',
      hypothesis: 'test harness row leaked into runtime registry',
      primary_metric: 'cost_adjusted_net_expectancy_bps',
      secondary_metrics: [],
      p_value: 1,
      included_in_fdr: true,
      fdr_family: '2026Q2_crypto_evidence_os_v4',
      promotion_eligible: false,
      status: 'failed_validation',
      failure_codes: ['FDR_INPUTS_INCOMPLETE', 'PIT_PROXY_ONLY'],
      batch_id: 'batch-test-leak',
      created_at: '2026-05-04T00:00:00.000Z',
      metadata: {
        output_report_path: '/var/folders/k5/example/T/oa-validation-pipeline-shockfade-abc123/validation.json',
        p_value_source: 'fdr_report',
        fdr_report_path: '/tmp/fdr_report.json',
        fdr_report_path_source: 'generated_artifact',
        fdr_report_status: 'blocked_inputs_incomplete',
        raw_m_complete: false,
        includes_failed_trials: false,
        fdr_p_values_available: true,
        fdr_missing_p_value_count: 0,
        fdr_p_value_method: 'spa_like',
        fdr_p_value_scope: 'explanatory_selected_vs_holdout_benchmark',
        fdr_p_value_is_promotion_grade: false,
        fdr_p_value_promotion_grade_source: 'fdr_report',
        pit_audit_path: '/tmp/feature_availability_audit.json',
        pit_audit_source: 'feature_availability_audit',
        pit_audit_status: 'blocked',
        pit_audit_blocking_codes: ['PIT_PROXY_ONLY'],
        pit_audit_promotion_grade: false,
        pit_audit_promotion_grade_source: 'feature_availability_audit',
      },
    })
    writeFileSync(trialRegistryPath, `${registryLine}\n`)

    const index = await buildP1TradingEvidence({
      paperDir,
      dataDir,
      oneSecondDataDir: dataDir,
      oneHourDataDir: dataDir,
      shadowLedgerPath: join(paperDir, 'missing_shadow.jsonl'),
      outputDir,
      candidateRegistryPath: join(root, 'candidate_registry.json'),
      graveyardPath: join(root, 'graveyard.json'),
      bestConfigPath: join(root, 'best_config.json'),
      trialRegistryPath,
      evidenceOutputRoot: join(root, 'runtime_research'),
      optimizationDir: join(root, 'missing_optimization'),
      validationDir: join(root, 'missing_validation'),
      routeCostBudgetPath: join(root, 'missing_route_cost_budget.json'),
      timeframe: '5m',
      lookbackHours: null,
      json: true,
    })

    const persistedRegistry = await readFile(trialRegistryPath, 'utf-8')
    const trialLedger = JSON.parse(await readFile(index.artifacts.trialLedger, 'utf-8'))
    const coverage = JSON.parse(await readFile(index.artifacts.trialSourceCoverage, 'utf-8'))
    const leakedEntry = trialLedger.entries.find((item: any) => item.trialId === 'runtime_trial_registry:leaked-validation-spec-trial')

    expect(persistedRegistry).toBe(`${registryLine}\n`)
    expect(leakedEntry).toMatchObject({
      includedInRawM: false,
      includedInEffectiveM: false,
      metrics: {
        provenanceOnly: true,
        rawMExclusionReason: 'quarantined_test_harness_runtime_trial_registry_leak',
      },
    })
    expect(trialLedger.raw_m).toBe(0)
    expect(trialLedger.readinessGaps).toMatchObject({
      includedRawMTrials: 0,
      fdrInputsIncompleteTrials: 0,
      pitProxyOnlyTrials: 0,
      fdrPValueNonPromotionGradeTrials: 0,
    })
    expect(trialLedger.readinessGaps.blockerSummary).not.toContain('fdr_inputs_incomplete_trials:1')
    expect(trialLedger.readinessGaps.blockerSummary).not.toContain('pit_proxy_only_trials:1')
    expect(coverage.runtimeRegistryDiagnostics).toMatchObject({
      entries: 1,
      includedRawMTrials: 0,
      quarantinedTestHarnessRows: 1,
    })
    expect(coverage.summary).toMatchObject({
      includedRawMTrials: 0,
      fdrInputsIncompleteTrials: 0,
      pitProxyOnlyTrials: 0,
    })
  })

  it('excludes diagnostic-only new strategy validation rows from FDR raw_m when declared', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    const dataDir = join(root, 'market')
    const outputDir = join(root, 'out')
    const validationDir = join(root, 'new_strategies_validation')
    mkdirSync(paperDir, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(validationDir, { recursive: true })

    writeFileSync(join(root, 'candidate_registry.json'), JSON.stringify({ entries: [] }))
    writeFileSync(join(root, 'graveyard.json'), JSON.stringify({ entries: [] }))
    writeFileSync(join(root, 'trial_registry.jsonl'), '')
    writeFileSync(join(root, 'best_config.json'), JSON.stringify({
      assetCount: 2,
      discoveredAt: '2026-05-04T00:00:00.000Z',
      config: { lookbackHours: 72 },
    }))
    writeFileSync(join(validationDir, 'validation_excluded.json'), JSON.stringify({
      generatedAt: '2026-05-04T00:00:00.000Z',
      strategies: [{
        trialId: 'new-strategy-diagnostic-only',
        candidateId: 'liquidationAftermath_BTC_USDT',
        strategy: 'liquidationAftermath',
        symbol: 'BTC-USDT',
        status: 'failed_validation',
        diagnosticOnly: true,
        promotionEligible: false,
        includedInFdr: false,
        includedInEffectiveM: false,
        fdrReportStatus: 'excluded_from_fdr',
        fdrPValuesAvailable: false,
        fdrMissingPValueCount: 1,
        fdrPValueBlockedReason: 'new_strategy_validation_diagnostic_only_not_complete_trial_universe',
        fdrPValueIsPromotionGrade: false,
        fdrExclusionReason: 'new_strategy_validation_diagnostic_only_not_complete_trial_universe',
        pitAuditStatus: 'not_implemented',
        pitAuditPromotionGrade: false,
        failureCodes: [],
        trades: 12,
        winRate: 40,
        totalReturnPct: -1,
        sharpe: -0.5,
        netExpectancyPct: -0.1,
      }],
    }))

    const index = await buildP1TradingEvidence({
      paperDir,
      dataDir,
      oneSecondDataDir: dataDir,
      oneHourDataDir: dataDir,
      shadowLedgerPath: join(paperDir, 'missing_shadow.jsonl'),
      outputDir,
      candidateRegistryPath: join(root, 'candidate_registry.json'),
      graveyardPath: join(root, 'graveyard.json'),
      bestConfigPath: join(root, 'best_config.json'),
      trialRegistryPath: join(root, 'trial_registry.jsonl'),
      evidenceOutputRoot: join(root, 'runtime_research'),
      optimizationDir: join(root, 'missing_optimization'),
      validationDir,
      routeCostBudgetPath: join(root, 'missing_route_cost_budget.json'),
      timeframe: '5m',
      lookbackHours: null,
      json: true,
    })

    const trialLedger = JSON.parse(await readFile(index.artifacts.trialLedger, 'utf-8'))
    const validationEntry = trialLedger.entries.find((entry: any) => entry.source === 'new_strategy_validation')
    expect(validationEntry).toMatchObject({
      trialId: 'new_strategy_validation:new-strategy-diagnostic-only',
      status: 'killed',
      includedInRawM: false,
      includedInEffectiveM: false,
      metrics: {
        diagnosticOnly: true,
        promotionEligible: false,
        fdrReportStatus: 'excluded_from_fdr',
        fdrPValuesAvailable: false,
        fdrPValueBlockedReason: 'new_strategy_validation_diagnostic_only_not_complete_trial_universe',
        fdrExclusionReason: 'new_strategy_validation_diagnostic_only_not_complete_trial_universe',
        pitAuditStatus: 'not_implemented',
        pitAuditPromotionGrade: false,
      },
    })
    const coverage = JSON.parse(await readFile(index.artifacts.trialSourceCoverage, 'utf-8'))
    expect(coverage.bySource.find((item: any) => item.key === 'new_strategy_validation')).toMatchObject({
      entries: 1,
      includedRawMTrials: 0,
      missingPValueTrials: 0,
      fdrInputsIncompleteTrials: 0,
      pitAuditNotImplementedTrials: 0,
    })
  })

  it('summarizes trial source coverage gaps without changing promotion eligibility', () => {
    const gate = buildGateEffectivenessReport({
      acceptedTrades: [],
      ledgerEntries: [],
      lookbackHours: null,
      generatedAt: '2026-05-02T00:00:00.000Z',
    })
    const alphaRegistry = emptyAlphaRegistry()
    const ledger = buildTrialLedgerReport({
      acceptedTrades: [],
      gateEffectiveness: gate,
      alphaRegistry,
      visibleTrialSources: {
        entries: [
          makeTrialLedgerEntry({
            trialId: 'runtime-missing',
            policyId: 'runtime-missing',
            pValue: null,
            status: 'killed',
            metrics: {
              failureCodes: 'MISSING_FDR_REPORT|PIT_AUDIT_NOT_IMPLEMENTED',
            },
          }),
          makeTrialLedgerEntry({
            trialId: 'runtime-fdr-blocked',
            policyId: 'runtime-fdr-blocked',
            pValue: null,
            status: 'killed',
            metrics: {
              failureCodes: 'FDR_INPUTS_INCOMPLETE|PIT_PROXY_ONLY',
              fdrReportPath: '/tmp/fdr.json',
              fdrReportStatus: 'blocked_inputs_incomplete',
              fdrPValueBlockedReason: 'includes_failed_trials=false',
              pitAuditStatus: 'blocked',
            },
          }),
          makeTrialLedgerEntry({
            trialId: 'optimizer-top',
            policyId: 'optimizer-top',
            pValue: null,
            status: 'active',
            source: 'optimization_sweep',
          }),
        ],
        diagnostics: [{
          source: 'runtime_trial_registry',
          path: '/tmp/trial_registry.jsonl',
          status: 'loaded',
          recordsIn: 2,
          entriesEmitted: 2,
          notes: [],
        }],
      },
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    const coverage = buildTrialSourceCoverageReport({ trialLedger: ledger })

    expect(coverage).toMatchObject({
      diagnosticOnly: true,
      promotionEligible: false,
      status: 'blocked',
      sourceArtifact: 'trial_ledger',
      summary: {
        entries: 3,
        missingPValueTrials: 3,
        missingFdrReportTrials: 1,
        fdrInputsIncompleteTrials: 1,
        fdrReportPresentTrials: 1,
        fdrReportBlockedTrials: 1,
        missingFdrReportPathTrials: 1,
        pitAuditNotImplementedTrials: 1,
        pitProxyOnlyTrials: 1,
        missingPitAuditMetadataTrials: 1,
        completeTrialUniverseMarkers: 0,
        pValueUnavailableReasonCounts: [
          { reason: 'unspecified', count: 2 },
          { reason: 'includes_failed_trials=false', count: 1 },
        ],
        fdrBlockedReasonCounts: [
          { reason: 'missing_fdr_report_status', count: 2 },
          { reason: 'blocked_inputs_incomplete', count: 1 },
        ],
      },
    })
    expect(coverage.bySource.find(item => item.key === 'runtime_trial_registry')).toMatchObject({
      entries: 2,
      missingPValueTrials: 2,
      missingFdrReportTrials: 1,
      fdrInputsIncompleteTrials: 1,
      missingFdrReportPathTrials: 1,
      pitAuditNotImplementedTrials: 1,
      pitProxyOnlyTrials: 1,
      missingPitAuditMetadataTrials: 1,
    })
    expect(coverage.bySource.find(item => item.key === 'optimization_sweep')).toMatchObject({
      entries: 1,
      missingPValueTrials: 1,
    })
    expect(coverage.nextPatchTargets[0]).toMatchObject({
      source: 'runtime_trial_registry',
      familyId: 'test_family',
      missingPValueTrials: 2,
      missingFdrReportTrials: 1,
      missingFdrReportPathTrials: 1,
      fdrInputsIncompleteTrials: 1,
      pitAuditNotImplementedTrials: 1,
      pitProxyOnlyTrials: 1,
      missingPitAuditMetadataTrials: 1,
    })
    expect(coverage.nextPatchTargets[0].recommendedPatchPoint).toContain('annotate p_value/FDR/PIT provenance')
    expect(coverage.nextPatchTargets[0].recommendedPatchPoint).not.toContain('emit p_value')
    expect(ledger.promotionEligible).toBe(false)
  })

  it('computes accept-vs-skip gate report from closed trades and shadow outcomes', () => {
    const accepted = [
      makeTrade({ tradeId: 'a1', pnlPct: 1 }),
      makeTrade({ tradeId: 'a2', pnlPct: 0.5 }),
    ]
    const ledger: PaperPolicyShadowLedgerEntry[] = [
      {
        counterfactualType: 'trade_level_shadow',
        eventType: 'open',
        shadowId: 's1',
        lane: 'volume_breakout_1x',
        symbol: 'ETH-USDT',
        side: 'long',
        entryPrice: 100,
        openTs: '2026-05-01T00:00:00.000Z',
        openBarTime: Date.parse('2026-05-01T00:00:00.000Z'),
        horizonMs: 300000,
        notionalUsd: null,
        stopLossPrice: 99,
        blockReasons: ['confidence 0.000 < 0.2'],
        context: completeShadowContext(1),
        quality: {},
        cost: {
          roundTripCostBpsAtOpen: 28,
        },
      },
      {
        counterfactualType: 'trade_level_shadow',
        eventType: 'closed',
        shadowId: 's1',
        lane: 'volume_breakout_1x',
        symbol: 'ETH-USDT',
        side: 'long',
        entryPrice: 100,
        closePrice: 99,
        openTs: '2026-05-01T00:00:00.000Z',
        openBarTime: Date.parse('2026-05-01T00:00:00.000Z'),
        closeTs: '2026-05-01T00:05:00.000Z',
        closeBarTime: Date.parse('2026-05-01T00:05:00.000Z'),
        horizonMs: 300000,
        pnlPct: -1,
        pnlUsd: null,
        closeReason: 'shadow_stop_loss',
      },
    ]

    const report = buildGateEffectivenessReport({
      acceptedTrades: accepted,
      ledgerEntries: ledger,
      lookbackHours: null,
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(report.accepted).toBe(2)
    expect(report.skipped).toBe(1)
    expect(report.skipCounterfactualPnlPct).toBe(-1)
    expect(report.acceptVsSkipDeltaPct).toBe(1.75)
    expect(report.validityCounts.valid).toBe(1)
    expect(report.topRejectReasons[0]).toEqual({ reason: 'confidence 0.000 < 0.2', count: 1 })
    expect(report.costAdjusted).toMatchObject({
      acceptedClosedTrades: 2,
      skippedOpenSignals: 1,
      skippedClosedOutcomes: 1,
      skippedCurrentlyOpenSignals: 0,
      skippedWithPredictedCost: 1,
      skippedOpenWithPredictedCost: 1,
      skippedMissingPredictedCost: 0,
      skippedClosedMissingPredictedCost: 0,
      skippedOpenMissingPredictedCost: 0,
      skipCounterfactualNetPnlPct: -1.28,
    })
    expect(report.gateStatus).toBe('insufficient_data')
    expect(report.bootstrapBlockSensitivity).toMatchObject({
      comparisonDesign: 'unpaired_symbol_day',
      promotionEligible: false,
    })
  })

  it('hydrates skipped shadow outcomes from open quality, context, and cost evidence', () => {
    const ledger: PaperPolicyShadowLedgerEntry[] = [
      {
        counterfactualType: 'trade_level_shadow',
        eventType: 'open',
        shadowId: 's-cost',
        lane: 'volume_breakout_1x',
        symbol: 'ETH-USDT',
        side: 'long',
        entryPrice: 100,
        openTs: '2026-05-01T00:00:00.000Z',
        openBarTime: Date.parse('2026-05-01T00:00:00.000Z'),
        horizonMs: 300000,
        notionalUsd: null,
        stopLossPrice: 99,
        blockReasons: ['reason_class:execution_gate_blocked'],
        context: {
          ...completeShadowContext(42),
          contextGenerationAtOpen: 42,
          contextStatus: 'ok',
          flashConfidenceLowAtOpen: 0.61,
          proEpochAtOpen: 9,
          marketIntelTriggerAtOpen: 'test_market_intel',
        },
        quality: {
          confidenceAtOpen: 0.19,
          volumeRatioAtOpen: 12.5,
          breakQualityAtOpen: 0.82,
          liquidityStatusAtOpen: 'pass',
          spreadBpsAtOpen: 4.2,
          spreadStatusAtOpen: 'pass',
        },
        cost: {
          estimatedRoundTripCostPctAtOpen: 0.28,
          estimatedRoundTripCostPctOfMarginAtOpen: 0.28,
          routeCostBpsAtOpen: 28,
          roundTripCostBpsAtOpen: 28,
          matchPriceAtOpen: 100,
          matchPriceSourceAtOpen: 'simulated_fill',
          markMatchStatusAtOpen: 'stale_or_missing',
        },
      },
      {
        counterfactualType: 'trade_level_shadow',
        eventType: 'closed',
        shadowId: 's-cost',
        lane: 'volume_breakout_1x',
        symbol: 'ETH-USDT',
        side: 'long',
        entryPrice: 100,
        closePrice: 99,
        openTs: '2026-05-01T00:00:00.000Z',
        openBarTime: Date.parse('2026-05-01T00:00:00.000Z'),
        closeTs: '2026-05-01T00:05:00.000Z',
        closeBarTime: Date.parse('2026-05-01T00:05:00.000Z'),
        horizonMs: 300000,
        pnlPct: -1,
        pnlUsd: null,
        closeReason: 'shadow_stop_loss',
      },
    ]

    const gate = buildGateEffectivenessReport({
      acceptedTrades: [makeTrade({ tradeId: 'accepted', pnlPct: 1 })],
      ledgerEntries: ledger,
      lookbackHours: null,
      generatedAt: '2026-05-02T00:00:00.000Z',
    })
    const cost = buildCostModelDiagnostics(
      // buildGateEffectivenessReport keeps skipped cost evidence internal, so this
      // test exercises the same hydrated shadow path through the public report by
      // checking reason stats and running cost diagnostics over an equivalent trade.
      [makeTrade({
        tradeId: 'shadow-equivalent',
        pnlPct: -1,
        estimatedRoundTripCostPctAtOpen: 0.28,
        estimatedRoundTripCostPctOfMarginAtOpen: 0.28,
        routeCostBpsAtOpen: 28,
        roundTripCostBpsAtOpen: 28,
        matchPriceAtOpen: 100,
        matchPriceSourceAtOpen: 'simulated_fill',
        markMatchStatusAtOpen: 'stale_or_missing',
      })],
      '2026-05-02T00:00:00.000Z',
    )

    expect(gate.skippedOutcomeStatsByRejectReason[0]).toMatchObject({
      reason: 'reason_class:execution_gate_blocked',
      count: 1,
      totalPnlPct: -1,
    })
    expect(gate.costAdjusted).toMatchObject({
      skippedWithPredictedCost: 1,
      skippedOpenWithPredictedCost: 1,
      skippedMissingPredictedCost: 0,
      skippedClosedMissingPredictedCost: 0,
      skippedOpenMissingPredictedCost: 0,
      skipCounterfactualNetPnlPct: -1.28,
    })
    expect(cost.tradesWithCostPrediction).toBe(1)
    expect(cost.predictedCostBpsMean).toBe(28)
  })

  it('judges gate status by cost-adjusted accept-vs-skip performance when cost evidence exists', () => {
    const accepted = Array.from({ length: 100 }, (_, index) => {
      const openTs = new Date(Date.parse('2026-05-01T00:00:00.000Z') + index * 60_000).toISOString()
      const closeTs = new Date(Date.parse(openTs) + 5 * 60_000).toISOString()
      return makeTrade({
        tradeId: `accepted-${index}`,
        symbol: `ACCEPT-${index}`,
        openTs,
        closeTs,
        pnlPct: 0.3,
        roundTripCostBpsAtOpen: 80,
      })
    })
    const ledger: PaperPolicyShadowLedgerEntry[] = Array.from({ length: 100 }).flatMap((_, index) => {
      const shadowId = `skipped-${index}`
      const openTs = new Date(Date.parse('2026-05-01T00:00:00.000Z') + index * 60_000).toISOString()
      const closeTs = new Date(Date.parse(openTs) + 5 * 60_000).toISOString()
      return [
        {
          counterfactualType: 'trade_level_shadow',
          eventType: 'open',
          shadowId,
          lane: 'volume_breakout_1x',
          symbol: `SKIP-${index}`,
          side: 'long',
          entryPrice: 100,
          openTs,
          openBarTime: Date.parse(openTs),
          horizonMs: 300_000,
          notionalUsd: null,
          stopLossPrice: 99,
          blockReasons: ['reason_class:test_gate'],
          context: completeShadowContext(index + 1, {
            decisionTime: openTs,
            marketDataWatermarkAtDecisionTime: openTs,
            watermark: openTs,
          }),
          quality: {},
          cost: {
            roundTripCostBpsAtOpen: 10,
          },
        },
        {
          counterfactualType: 'trade_level_shadow',
          eventType: 'closed',
          shadowId,
          lane: 'volume_breakout_1x',
          symbol: `SKIP-${index}`,
          side: 'long',
          entryPrice: 100,
          closePrice: 100.2,
          openTs,
          openBarTime: Date.parse(openTs),
          closeTs,
          closeBarTime: Date.parse(closeTs),
          horizonMs: 300_000,
          pnlPct: 0.2,
          pnlUsd: null,
          closeReason: 'shadow_horizon_expired',
        },
      ] satisfies PaperPolicyShadowLedgerEntry[]
    })

    const report = buildGateEffectivenessReport({
      acceptedTrades: accepted,
      ledgerEntries: ledger,
      lookbackHours: null,
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(report.diagnosticQuality).toBe('ok')
    expect(report.acceptVsSkipDeltaPct).toBeCloseTo(0.1, 8)
    expect(report.costAdjusted.acceptVsSkipNetDeltaPct).toBeLessThan(0)
    expect(report.gateStatus).toBe('harmful')
    expect(report.gateStatusBasis).toBe('cost_adjusted_accept_vs_skip_net_delta')
    expect(report.gateStatusDeltaPct).toBe(report.costAdjusted.acceptVsSkipNetDeltaPct)
    const laneDiagnostic = report.stratifiedDiagnostics.items.find(item =>
      item.dimension === 'lane' && item.key === 'volume_breakout_1x'
    )
    expect(laneDiagnostic).toMatchObject({
      acceptedTrades: 100,
      skippedClosedOutcomes: 100,
      diagnosticQuality: 'ok',
      gateStatus: 'harmful',
      recommendedAction: 'keep_blocked',
      acceptedWithPredictedCost: 100,
      skippedWithPredictedCost: 100,
    })
    expect(report.stratifiedDiagnostics.summary).toMatchObject({
      harmful: expect.any(Number),
      keepBlocked: expect.any(Number),
    })
    expect(report.stratifiedDiagnostics.summary.topHarmfulKeys).toContain('lane:volume_breakout_1x')
  })

  it('does not classify gates from gross accept-vs-skip delta when accepted cost evidence is missing', () => {
    const accepted = Array.from({ length: 100 }, (_, index) => {
      const openTs = new Date(Date.parse('2026-05-01T00:00:00.000Z') + index * 60_000).toISOString()
      const closeTs = new Date(Date.parse(openTs) + 5 * 60_000).toISOString()
      return makeTrade({
        tradeId: `gross-only-accepted-${index}`,
        symbol: `GROSS-ACCEPT-${index}`,
        openTs,
        closeTs,
        pnlPct: 1,
      })
    })
    const ledger: PaperPolicyShadowLedgerEntry[] = Array.from({ length: 100 }).flatMap((_, index) => {
      const shadowId = `gross-only-skipped-${index}`
      const openTs = new Date(Date.parse('2026-05-01T00:00:00.000Z') + index * 60_000).toISOString()
      const closeTs = new Date(Date.parse(openTs) + 5 * 60_000).toISOString()
      return [
        {
          counterfactualType: 'trade_level_shadow',
          eventType: 'open',
          shadowId,
          lane: 'volume_breakout_1x',
          symbol: `GROSS-SKIP-${index}`,
          side: 'long',
          entryPrice: 100,
          openTs,
          openBarTime: Date.parse(openTs),
          horizonMs: 300_000,
          notionalUsd: null,
          stopLossPrice: 99,
          blockReasons: ['reason_class:test_gate'],
          context: completeShadowContext(index + 1, {
            decisionTime: openTs,
            marketDataWatermarkAtDecisionTime: openTs,
            watermark: openTs,
          }),
          quality: {},
          cost: { roundTripCostBpsAtOpen: 10 },
        },
        {
          counterfactualType: 'trade_level_shadow',
          eventType: 'closed',
          shadowId,
          lane: 'volume_breakout_1x',
          symbol: `GROSS-SKIP-${index}`,
          side: 'long',
          entryPrice: 100,
          closePrice: 99.8,
          openTs,
          openBarTime: Date.parse(openTs),
          closeTs,
          closeBarTime: Date.parse(closeTs),
          horizonMs: 300_000,
          pnlPct: -0.2,
          pnlUsd: null,
          closeReason: 'shadow_horizon_expired',
        },
      ] satisfies PaperPolicyShadowLedgerEntry[]
    })

    const report = buildGateEffectivenessReport({
      acceptedTrades: accepted,
      ledgerEntries: ledger,
      lookbackHours: null,
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(report.diagnosticQuality).toBe('ok')
    expect(report.acceptVsSkipDeltaPct).toBeGreaterThan(0)
    expect(report.costAdjusted.acceptVsSkipNetDeltaPct).toBeNull()
    expect(report.gateStatus).toBe('insufficient_data')
    expect(report.gateStatusBasis).toBe('insufficient_data')
    expect(report.gateStatusDeltaPct).toBeNull()
    const laneDiagnostic = report.stratifiedDiagnostics.items.find(item =>
      item.dimension === 'lane' && item.key === 'volume_breakout_1x'
    )
    expect(laneDiagnostic).toMatchObject({
      acceptedTrades: 100,
      skippedClosedOutcomes: 100,
      acceptedWithPredictedCost: 0,
      skippedWithPredictedCost: 100,
      acceptedMissingPredictedCost: 100,
      gateStatus: 'insufficient_data',
      recommendedAction: 'cost_coverage_required',
    })
    expect(laneDiagnostic?.actionReason).toContain('accepted_predicted_cost_missing:100')
    expect(report.stratifiedDiagnostics.summary.costCoverageRequired).toBeGreaterThan(0)
    expect(report.stratifiedDiagnostics.summary).toMatchObject({
      uniqueAcceptedMissingPredictedCostTrades: 100,
      uniqueSkippedClosedMissingPredictedCostTrades: 0,
      costCoverageRequiredByDimension: {
        lane: expect.any(Number),
        symbol: expect.any(Number),
        side: expect.any(Number),
        lane_symbol_side: expect.any(Number),
      },
    })
    expect(report.costAdjusted.acceptedMissingPredictedCostAttribution).toMatchObject({
      diagnosticOnly: true,
      rootCause: 'accepted_closed_predicted_open_evidence_missing',
      uniqueMissingTrades: 100,
    })
    expect(report.costAdjusted.acceptedMissingPredictedCostAttribution.topMissingFields).toEqual(expect.arrayContaining([
      { field: 'predicted_cost_bps', missingTrades: 100 },
      { field: 'expected_gross_edge_pct', missingTrades: 100 },
      { field: 'match_price', missingTrades: 100 },
    ]))
  })

  it('attributes gate cost coverage gaps by cohort, lane, and producer guard window', () => {
    const accepted = [
      makeTrade({
        tradeId: 'legacy-accepted',
        lane: 'volume_breakout_1x',
        openTs: '2026-05-01T00:00:00.000Z',
        closeTs: '2026-05-01T00:05:00.000Z',
        pnlPct: 1,
      }),
      makeTrade({
        tradeId: 'producer-accepted',
        lane: 'volume_breakout_1x',
        openTs: '2026-05-04T02:00:00.000Z',
        closeTs: '2026-05-04T02:05:00.000Z',
        pnlPct: 1,
      }),
      makeTrade({
        tradeId: 'complete-accepted',
        lane: 'cross_sectional_1x',
        openTs: '2026-05-04T01:00:00.000Z',
        closeTs: '2026-05-04T01:05:00.000Z',
        pnlPct: 0.5,
        roundTripCostBpsAtOpen: 28,
        expectedGrossEdgePctAtOpen: 0.5,
        expectedNetEdgePctAtOpen: 0.22,
        expectedEdgeSourceAtOpen: 'test_edge_model',
        matchPriceAtOpen: 100,
        matchPriceSourceAtOpen: 'simulated_fill',
        markMatchPenaltyBpsAtOpen: 2,
        markMatchStatusAtOpen: 'ok',
      }),
    ]
    const ledger: PaperPolicyShadowLedgerEntry[] = [
      {
        counterfactualType: 'trade_level_shadow',
        eventType: 'open',
        shadowId: 'transitional-shadow',
        lane: 'volume_breakout_1x',
        symbol: 'ETH-USDT',
        side: 'long',
        entryPrice: 100,
        openTs: '2026-05-02T12:00:00.000Z',
        openBarTime: Date.parse('2026-05-02T12:00:00.000Z'),
        horizonMs: 300_000,
        notionalUsd: null,
        stopLossPrice: 99,
        blockReasons: ['reason_class:test_gate'],
        context: completeShadowContext(1, {
          decisionTime: '2026-05-02T12:00:00.000Z',
          marketDataWatermarkAtDecisionTime: '2026-05-02T12:00:00.000Z',
          watermark: '2026-05-02T12:00:00.000Z',
        }),
        quality: {},
        cost: {},
      },
      {
        counterfactualType: 'trade_level_shadow',
        eventType: 'open',
        shadowId: 'producer-shadow',
        lane: 'volume_breakout_1x',
        symbol: 'BTC-USDT',
        side: 'long',
        entryPrice: 100,
        openTs: '2026-05-04T02:00:00.000Z',
        openBarTime: Date.parse('2026-05-04T02:00:00.000Z'),
        horizonMs: 300_000,
        notionalUsd: null,
        stopLossPrice: 99,
        blockReasons: ['reason_class:test_gate'],
        context: completeShadowContext(2, {
          decisionTime: '2026-05-04T02:00:00.000Z',
          marketDataWatermarkAtDecisionTime: '2026-05-04T02:00:00.000Z',
          watermark: '2026-05-04T02:00:00.000Z',
        }),
        quality: {},
        cost: { roundTripCostBpsAtOpen: 20 },
      },
    ]

    const report = buildGateEffectivenessReport({
      acceptedTrades: accepted,
      ledgerEntries: ledger,
      lookbackHours: null,
      generatedAt: '2026-05-04T02:00:00.000Z',
    })

    const acceptedCohort = report.costCoverageAttribution.cohorts.find(item => item.cohort === 'accepted_closed')
    expect(acceptedCohort).toMatchObject({
      records: 3,
      withPredictedCost: 1,
      missingPredictedCost: 2,
      withCompletePredictedOpenEvidence: 1,
      missingCompletePredictedOpenEvidence: 2,
      producerGuardMissingPredictedCost: 1,
      producerGuardMissingCompletePredictedOpenEvidence: 1,
    })
    expect(acceptedCohort?.byProducerGuardStatus.map(item => item.key)).toEqual([
      'producer_guard_enforced',
      'legacy_pre_context_enforcement',
    ])
    expect(acceptedCohort?.topMissingFields[0]).toEqual({
      field: 'expected_edge_source',
      missingRecords: 2,
    })

    const skippedOpenCohort = report.costCoverageAttribution.cohorts.find(item => item.cohort === 'skipped_open_shadow')
    expect(skippedOpenCohort).toMatchObject({
      records: 2,
      withPredictedCost: 1,
      missingPredictedCost: 1,
      withCompletePredictedOpenEvidence: 0,
      missingCompletePredictedOpenEvidence: 2,
      producerGuardMissingPredictedCost: 0,
      producerGuardMissingCompletePredictedOpenEvidence: 1,
    })
    expect(report.costCoverageAttribution.topPatchTargets[0]).toMatchObject({
      cohort: 'accepted_closed',
      lane: 'volume_breakout_1x',
      producerGuardStatus: 'producer_guard_enforced',
      missingPredictedCost: 1,
      recommendedPatchPoint: 'scripts/paper_trade_volume_breakout.ts open/close result writer',
    })
    expect(report.costCoverageAttribution.topPatchTargets[1]).toMatchObject({
      cohort: 'skipped_open_shadow',
      lane: 'volume_breakout_1x',
      producerGuardStatus: 'producer_guard_enforced',
      missingPredictedCost: 0,
    })
    expect(report.costCoverageAttribution.actionableProducerGuardPatchTargets).toHaveLength(2)
    expect(report.costCoverageAttribution.legacyQuarantineTargets.every(item =>
      item.recommendedAction.startsWith('quarantine_only')
    )).toBe(true)
    expect(report.costCoverageAttribution.producerGuardMissingPredictedCostTargets).toHaveLength(1)
    expect(report.costCoverageAttribution.producerGuardMissingCompletePredictedOpenEvidenceTargets).toHaveLength(2)
    expect(report.costCoverageAttribution.awaitingPostEnforcementClosedTrades).toBe(false)
    expect(report.costCoverageAttribution.topPatchTargets.some(item =>
      item.producerGuardStatus === 'transitional_dirty_open' &&
      item.recommendedAction.startsWith('quarantine_only')
    )).toBe(true)
    expect(report.costCoverageAttribution).toMatchObject({
      diagnosticOnly: true,
      promotionEligible: false,
      promotionBlocked: true,
      contextEnforcementTs: '2026-05-02T06:30:00.000Z',
      producerGuardEnforcementTs: '2026-05-04T00:44:00.000Z',
    })
  })

  it('keeps incomplete shadow outcomes out of gate-effectiveness skip stats', () => {
    const ledger: PaperPolicyShadowLedgerEntry[] = [
      {
        counterfactualType: 'trade_level_shadow',
        eventType: 'open',
        shadowId: 'legacy-shadow',
        lane: 'volume_breakout_1x',
        symbol: 'ETH-USDT',
        side: 'long',
        entryPrice: 100,
        openTs: '2026-05-01T00:00:00.000Z',
        openBarTime: Date.parse('2026-05-01T00:00:00.000Z'),
        horizonMs: 300000,
        notionalUsd: null,
        stopLossPrice: 99,
        blockReasons: ['reason_class:legacy_context_missing'],
        context: {
          contextGenerationAtOpen: 42,
          contextStatus: 'ok',
          flashConfidenceLowAtOpen: 0.61,
        },
        quality: {},
        cost: {
          roundTripCostBpsAtOpen: 28,
        },
      },
      {
        counterfactualType: 'trade_level_shadow',
        eventType: 'closed',
        shadowId: 'legacy-shadow',
        lane: 'volume_breakout_1x',
        symbol: 'ETH-USDT',
        side: 'long',
        entryPrice: 100,
        closePrice: 99,
        openTs: '2026-05-01T00:00:00.000Z',
        openBarTime: Date.parse('2026-05-01T00:00:00.000Z'),
        closeTs: '2026-05-01T00:05:00.000Z',
        closeBarTime: Date.parse('2026-05-01T00:05:00.000Z'),
        horizonMs: 300000,
        pnlPct: -1,
        pnlUsd: null,
        closeReason: 'shadow_stop_loss',
      },
    ]

    const gate = buildGateEffectivenessReport({
      acceptedTrades: [makeTrade({ tradeId: 'accepted', pnlPct: 1 })],
      ledgerEntries: ledger,
      lookbackHours: null,
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(gate.skipped).toBe(1)
    expect(gate.validityCounts).toEqual({ valid: 0, partial: 1, invalid: 0 })
    expect(gate.shadowContextCoverage).toMatchObject({
      ok: 0,
      newMissing: 1,
      promotionBlocked: true,
    })
    expect(gate.skipStats.count).toBe(0)
    expect(gate.skipCounterfactualPnlPct).toBe(0)
    expect(gate.acceptVsSkipDeltaPct).toBeNull()
    expect(gate.costAdjusted).toMatchObject({
      skippedOpenSignals: 1,
      skippedClosedOutcomes: 0,
      skippedCurrentlyOpenSignals: 1,
      skippedWithPredictedCost: 0,
      skippedOpenWithPredictedCost: 1,
      skipCounterfactualNetPnlPct: null,
    })
    expect(gate.skippedOutcomeStatsByRejectReason).toEqual([])
  })

  it('keeps skipped open signal denominator separate from closed shadow outcomes', () => {
    const ledger: PaperPolicyShadowLedgerEntry[] = [
      {
        counterfactualType: 'trade_level_shadow',
        eventType: 'open',
        shadowId: 's-open-only',
        lane: 'volume_breakout_1x',
        symbol: 'ETH-USDT',
        side: 'long',
        entryPrice: 100,
        openTs: '2026-05-01T00:00:00.000Z',
        openBarTime: Date.parse('2026-05-01T00:00:00.000Z'),
        horizonMs: 300000,
        notionalUsd: null,
        stopLossPrice: 99,
        blockReasons: ['reason_class:near_threshold'],
        context: completeShadowContext(1),
        quality: {},
        cost: {
          roundTripCostBpsAtOpen: 28,
        },
      },
    ]

    const gate = buildGateEffectivenessReport({
      acceptedTrades: [makeTrade({ tradeId: 'accepted', pnlPct: 1 })],
      ledgerEntries: ledger,
      lookbackHours: null,
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(gate.skipped).toBe(1)
    expect(gate.skipStats.count).toBe(0)
    expect(gate.skipCounterfactualPnlPct).toBe(0)
    expect(gate.costAdjusted).toMatchObject({
      skippedOpenSignals: 1,
      skippedClosedOutcomes: 0,
      skippedCurrentlyOpenSignals: 1,
      skippedWithPredictedCost: 0,
      skippedClosedMissingPredictedCost: 0,
      skippedOpenWithPredictedCost: 1,
      skippedOpenMissingPredictedCost: 0,
      skipCounterfactualNetPnlPct: null,
    })
  })

  it('computes MFE/MAE from local OHLC path', async () => {
    const root = makeRoot()
    const dataDir = join(root, 'market')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'ETH_USDT_USDT_5m.csv'), [
      'timestamp,datetime,open,high,low,close,volume',
      `${Date.parse('2026-05-01T00:00:00.000Z')},2026-05-01T00:00:00.000Z,100,101,99.5,100.5,1`,
      `${Date.parse('2026-05-01T00:05:00.000Z')},2026-05-01T00:05:00.000Z,100.5,102,98,99,1`,
    ].join('\n'))

    const report = await buildMfeMaeStoplossReport({
      trades: [makeTrade({
        tradeId: 'sl',
        symbol: 'ETH-USDT',
        side: 'long',
        openPrice: 100,
        closePrice: 99,
        closeReason: 'stop_loss',
        pnlPct: -1,
        liquidityUsdAtOpen: 25_000,
        liquidityStatusAtOpen: 'thin',
        spreadStatusAtOpen: 'wide',
        spreadBpsAtOpen: 31,
        routeCostBpsAtOpen: 43,
        roundTripCostBpsAtOpen: 43,
        markMatchStatusAtOpen: 'stale_or_missing',
        markMatchPenaltyBpsAtOpen: 15,
        regimeAtOpen: 'vol-stress',
      })],
      dataDir,
      timeframe: '5m',
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(report.coverage).toMatchObject({
      closedTrades: 1,
      stopLossTrades: 1,
      diagnosticsOk: 1,
      closedDiagnosticsOk: 1,
      stopLossDiagnosticsOk: 1,
      stopLossDiagnosticsOkPct: 100,
      stopLossKnownOrdering: 0,
      stopLossCoarseOrdering: 1,
    })
    expect(report).toMatchObject({
      profitabilityClaimAllowed: false,
      promotionClaimAllowed: false,
      executionReplayClaimAllowed: false,
    })
    expect(report.stopLossSummary.avgMfeBps).toBe(200)
    expect(report.stopLossSummary.avgMaeBps).toBe(-200)
    expect(report.stopLossSummary.mfeBeforeStopSharePct).toBeNull()
    expect(report.stopLossAttribution).toMatchObject({
      diagnosticUse: 'read_only_cluster_attribution',
      status: 'blocked_diagnostic_only',
      promotionEligible: false,
      policyMutationAllowed: false,
      profitabilityClaimAllowed: false,
      blockerSummary: {
        missingRoundTripCostAtOpenCount: 0,
        missingMarkMatchStatusAtOpenCount: 0,
        legacyOrMissingContextCount: 0,
        coarseOrderingAmbiguousCount: 1,
      },
      blockedBy: [
        'read_only_path_attribution',
        'requires_pro_review_before_policy_change',
        'not_fill_adjusted_execution_replay',
      ],
    })
    expect(report.stopLossAttribution.byLane[0]).toMatchObject({
      dimension: 'lane',
      key: 'volume_breakout_1x',
      count: 1,
      diagnosticsOk: 1,
      avgMfeBps: 200,
      avgMaeBps: -200,
    })
    expect(report.stopLossAttribution.byLaneSymbolSide[0]).toMatchObject({
      dimension: 'lane_symbol_side',
      key: 'volume_breakout_1x|ETH-USDT|long',
      count: 1,
    })
    expect(report.stopLossAttribution.byRegime[0]).toMatchObject({
      dimension: 'regime',
      key: 'vol-stress',
      count: 1,
    })
    expect(report.stopLossAttribution.byLiquidityUsdBucket[0]).toMatchObject({
      dimension: 'liquidity_usd_bucket',
      key: '10k-50k',
      count: 1,
    })
    expect(report.stopLossAttribution.byRouteCostBpsBucket[0]).toMatchObject({
      dimension: 'route_cost_bps_bucket',
      key: '30-50',
      count: 1,
    })
    expect(report.stopLossAttribution.byMarkMatchStatus[0]).toMatchObject({
      dimension: 'mark_match_status',
      key: 'stale_or_missing',
      count: 1,
    })
    expect(report.stopLossAttribution.byMfeBpsBucket[0]).toMatchObject({
      dimension: 'mfe_bps_bucket',
      key: '100-250',
      count: 1,
    })
    expect(report.stopLossAttribution.byMaeBpsBucket[0]).toMatchObject({
      dimension: 'mae_bps_bucket',
      key: '100-250',
      count: 1,
    })
    expect(report.stopLossAttribution.byTimeToStopBucket[0]).toMatchObject({
      dimension: 'time_to_stop_bucket',
      key: '2-10m',
      count: 1,
    })
    expect(report.pathSemantics).toMatchObject({
      candleTimestampConvention: 'bar_open_assumed',
      coarseBarMfeBeforeStopReliable: false,
    })
    expect(report.diagnostics[0]).toMatchObject({
      diagnosticStatus: 'ok',
      mfeBps: 200,
      maeBps: -200,
      timeToStopSec: 300,
      pitStatus: 'coarse_bar_ambiguous',
      orderingStatus: 'coarse_bar_unknown',
      mfeBeforeStop: null,
    })
  })

  it('quarantines MFE/MAE rows when candle prices are out of scale with trade open price', async () => {
    const root = makeRoot()
    const dataDir = join(root, 'market')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'JUP_USDT_USDT_5m.csv'), [
      'timestamp,datetime,open,high,low,close,volume',
      `${Date.parse('2026-05-01T00:00:00.000Z')},2026-05-01T00:00:00.000Z,2026,2026,2026,2026,2026`,
      `${Date.parse('2026-05-01T00:05:00.000Z')},2026-05-01T00:05:00.000Z,2026,2026,2026,2026,2026`,
    ].join('\n'))

    const report = await buildMfeMaeStoplossReport({
      trades: [makeTrade({
        tradeId: 'bad-path',
        symbol: 'JUP-USDT',
        openPrice: 0.1784,
        closePrice: 0.1779,
        closeReason: 'stop_loss',
        pnlPct: -0.28,
      })],
      dataDir,
      timeframe: '5m',
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(report.coverage).toMatchObject({
      closedTrades: 1,
      stopLossTrades: 1,
      diagnosticsOk: 0,
      pricePathMismatch: 1,
    })
    expect(report.stopLossSummary.avgMfeBps).toBeNull()
    expect(report.diagnostics[0]).toMatchObject({
      diagnosticStatus: 'price_path_mismatch',
      mfeBps: null,
      maeBps: null,
    })
  })

  it('uses one-second candle path for one-second paper trades', async () => {
    const root = makeRoot()
    const dataDir = join(root, 'market_5m')
    const oneSecondDataDir = join(root, 'market_1s')
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(oneSecondDataDir, { recursive: true })
    writeFileSync(join(dataDir, 'ETH_USDT_USDT_5m.csv'), [
      'timestamp,datetime,open,high,low,close,volume',
      `${Date.parse('2026-05-01T00:00:00.000Z')},2026-05-01T00:00:00.000Z,2026,2026,2026,2026,2026`,
    ].join('\n'))
    writeFileSync(join(oneSecondDataDir, 'ETH_USDT_USDT_1s.csv'), [
      'timestamp,datetime,open,high,low,close,volume',
      `${Date.parse('2026-05-01T00:00:00.000Z')},2026-05-01T00:00:00.000Z,100,101,99.5,100.5,1`,
      `${Date.parse('2026-05-01T00:00:01.000Z')},2026-05-01T00:00:01.000Z,100.5,102,98,99,1`,
    ].join('\n'))

    const report = await buildMfeMaeStoplossReport({
      trades: [makeTrade({
        tradeId: 'one-second',
        symbol: 'ETH-USDT',
        priceSource: '1s',
        openPrice: 100,
        closePrice: 99,
        closeReason: 'stop_loss',
        closeTs: '2026-05-01T00:00:01.000Z',
      })],
      dataDir,
      dataDirs: { '1s': oneSecondDataDir, '5m': dataDir },
      timeframe: '5m',
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(report.coverage).toMatchObject({
      diagnosticsOk: 1,
      pricePathMismatch: 0,
    })
    expect(report.stopLossSummary.avgMfeBps).toBe(200)
    expect(report.stopLossSummary.avgMaeBps).toBe(-200)
    expect(report.stopLossSummary.mfeBeforeStopSharePct).toBe(100)
    expect(report.diagnostics[0]).toMatchObject({
      pitStatus: 'safe_1s',
      orderingStatus: 'known',
      pricePathTimeframe: '1s',
      mfeBeforeStop: true,
    })
  })

  it('falls back to one-second price path when preferred coarse path is missing', async () => {
    const root = makeRoot()
    const dataDir = join(root, 'market_5m')
    const oneSecondDataDir = join(root, 'market_1s')
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(oneSecondDataDir, { recursive: true })
    writeFileSync(join(oneSecondDataDir, 'AVAX_USDT_USDT_1s.csv'), [
      'timestamp,datetime,open,high,low,close,volume',
      `${Date.parse('2026-04-30T12:00:26.000Z')},2026-04-30T12:00:26.000Z,100,100.5,99.9,100.2,1`,
      `${Date.parse('2026-04-30T12:02:24.000Z')},2026-04-30T12:02:24.000Z,100.2,101,98,99,1`,
    ].join('\n'))

    const report = await buildMfeMaeStoplossReport({
      trades: [makeTrade({
        tradeId: 'legacy-stoploss',
        symbol: 'AVAX-USDT',
        side: 'short',
        priceSource: null,
        openPrice: 100,
        closePrice: 101,
        closeReason: 'stop_loss',
        openTs: '2026-04-30T12:00:26.298Z',
        closeTs: '2026-04-30T12:02:24.936Z',
      })],
      dataDir,
      dataDirs: { '1s': oneSecondDataDir, '5m': dataDir },
      timeframe: '5m',
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(report.coverage).toMatchObject({
      closedTrades: 1,
      stopLossTrades: 1,
      diagnosticsOk: 1,
      missingPricePath: 0,
    })
    expect(report.stopLossSummary.avgMfeBps).toBeCloseTo(204.081633, 6)
    expect(report.stopLossSummary.avgMaeBps).toBeCloseTo(-99.009901, 6)
    expect(report.diagnostics[0]).toMatchObject({
      diagnosticStatus: 'ok',
      pricePathTimeframe: '1s',
      pricePathFallbackUsed: true,
      pricePathFallbackReason: 'preferred_missing_price_path',
      pitStatus: 'safe_1s',
      orderingStatus: 'known',
    })
  })

  it('falls back to one-hour price path as coarse legacy attribution when lower-frequency paths are missing', async () => {
    const root = makeRoot()
    const dataDir = join(root, 'market_5m')
    const oneSecondDataDir = join(root, 'market_1s')
    const oneHourDataDir = join(root, 'market_1h')
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(oneSecondDataDir, { recursive: true })
    mkdirSync(oneHourDataDir, { recursive: true })
    writeFileSync(join(oneHourDataDir, 'WIF_USDT_USDT_1h.csv'), [
      'timestamp,datetime,open,high,low,close,volume',
      `${Date.parse('2026-04-30T12:00:00.000Z')},2026-04-30T12:00:00.000Z,1,1.02,0.98,1.01,1`,
    ].join('\n'))

    const report = await buildMfeMaeStoplossReport({
      trades: [makeTrade({
        tradeId: 'legacy-volume-breakout-stoploss',
        symbol: 'WIF-USDT',
        side: 'short',
        priceSource: null,
        openPrice: 1,
        closePrice: 1.01,
        closeReason: 'stop_loss',
        openTs: '2026-04-30T12:13:40.096Z',
        closeTs: '2026-04-30T12:24:53.425Z',
      })],
      dataDir,
      dataDirs: { '1s': oneSecondDataDir, '5m': dataDir, '1h': oneHourDataDir },
      timeframe: '5m',
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(report.coverage).toMatchObject({
      diagnosticsOk: 1,
      missingPricePath: 0,
    })
    expect(report.diagnostics[0]).toMatchObject({
      diagnosticStatus: 'ok',
      pricePathTimeframe: '1h',
      pricePathFallbackUsed: true,
      pricePathFallbackReason: 'preferred_missing_price_path',
      pitStatus: 'coarse_bar_ambiguous',
      orderingStatus: 'coarse_bar_unknown',
      mfeBeforeStop: null,
    })
  })

  it('converts stop-loss attribution into diagnostic-only risk policy recommendations', async () => {
    const root = makeRoot()
    const dataDir = join(root, 'market_1s')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'DOGE_USDT_USDT_1s.csv'), [
      'timestamp,datetime,open,high,low,close,volume',
      `${Date.parse('2026-05-01T00:00:00.000Z')},2026-05-01T00:00:00.000Z,100,100.2,99.8,100,1`,
      `${Date.parse('2026-05-01T00:01:00.000Z')},2026-05-01T00:01:00.000Z,100,100.3,99.7,99.9,1`,
    ].join('\n'))
    writeFileSync(join(dataDir, 'WIF_USDT_USDT_1s.csv'), [
      'timestamp,datetime,open,high,low,close,volume',
      `${Date.parse('2026-05-01T00:00:00.000Z')},2026-05-01T00:00:00.000Z,1,1.01,0.99,1,1`,
      `${Date.parse('2026-05-01T00:01:00.000Z')},2026-05-01T00:01:00.000Z,1,1.02,0.98,1.01,1`,
    ].join('\n'))
    const trades: NormalizedPaperTrade[] = [
      ...Array.from({ length: 20 }, (_, index) => makeTrade({
        tradeId: `ms-100x-${index}`,
        lane: 'microstructure_100x',
        symbol: 'DOGE-USDT',
        side: 'short',
        priceSource: '1s',
        openPrice: 100,
        closePrice: 100.1,
        openTs: '2026-05-01T00:00:00.000Z',
        closeTs: '2026-05-01T00:01:00.000Z',
        closeReason: 'stop_loss',
        pnlPct: -0.13,
      })),
      ...Array.from({ length: 2 }, (_, index) => makeTrade({
        tradeId: `vb-wif-${index}`,
        lane: 'volume_breakout_1x',
        symbol: 'WIF-USDT',
        side: 'short',
        priceSource: '1s',
        openPrice: 1,
        closePrice: 1.01,
        openTs: '2026-05-01T00:00:00.000Z',
        closeTs: '2026-05-01T00:01:00.000Z',
        closeReason: 'stop_loss',
        pnlPct: -0.85,
      })),
    ]
    const mfe = await buildMfeMaeStoplossReport({
      trades,
      dataDir,
      dataDirs: { '1s': dataDir },
      timeframe: '1s',
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    const policy = buildStoplossRiskPolicyReport({
      mfeMaeReport: mfe,
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(policy).toMatchObject({
      diagnosticOnly: true,
      promotionEligible: false,
      policyMutationAllowed: false,
      status: 'blocked',
      profitabilityClaimAllowed: false,
      promotionClaimAllowed: false,
      executionReplayClaimAllowed: false,
      source: {
        closedTrades: 22,
        closedDiagnosticsOk: 22,
        stopLossTrades: 22,
        stopLossDiagnosticsOk: 22,
        stopLossDiagnosticsOkPct: 100,
        diagnosticsOk: 22,
      },
    })
    const micro100 = policy.recommendations.find(item => item.dimension === 'lane' && item.key === 'microstructure_100x')
    expect(micro100).toMatchObject({
      severity: 'critical',
      recommendedAction: 'block',
      stopLossTrades: 20,
      policyMutationAllowed: false,
      promotionEligible: false,
    })
    expect(micro100?.actionReason).toEqual(expect.arrayContaining([
      'production_forbidden_leverage:100x',
      'stoploss_count_ge_20:20',
    ]))
    const wif = policy.recommendations.find(item => item.dimension === 'symbol' && item.key === 'WIF-USDT')
    expect(wif).toMatchObject({
      severity: 'critical',
      recommendedAction: 'cooldown',
      stopLossTrades: 2,
    })
    expect(wif?.actionReason.some(reason => reason.startsWith('severe_avg_mae_bps:'))).toBe(true)
    expect(policy.summary).toMatchObject({
      promotionBlocked: true,
      highestSeverity: 'critical',
      totalPromotionBlockers: expect.any(Number),
      promotionBlockedByTruncated: expect.any(Boolean),
    })
    expect(policy.summary.totalPromotionBlockers).toBeGreaterThanOrEqual(policy.summary.promotionBlockedBy.length)
    expect(policy.summary.promotionBlockedBy).toEqual(expect.arrayContaining([
      'stoploss_lane:microstructure_100x:block',
    ]))
    expect(policy.failClosedReviewQueue.length).toBeGreaterThan(0)
    const queueItem = policy.failClosedReviewQueue.find(item => item.dimension === 'lane' && item.key === 'microstructure_100x')
    expect(queueItem).toMatchObject({
      failClosedAction: 'block',
      reportOnly: true,
      policyMutationAllowed: false,
      promotionEligible: false,
      stopLossTrades: 20,
      representativeTrades: [
        expect.objectContaining({
          tradeId: 'ms-100x-0',
          lane: 'microstructure_100x',
          symbol: 'DOGE-USDT',
          side: 'short',
          pitStatus: 'safe_1s',
          roundTripCostBpsAtOpen: null,
          routeCostBpsAtOpen: null,
          markMatchPenaltyBpsAtOpen: null,
          markMatchStatusAtOpen: null,
          pricePathFallbackUsed: false,
          pricePathFallbackReason: null,
          orderingStatus: 'known',
          contextCoverageBucket: 'ok',
        }),
        expect.any(Object),
        expect.any(Object),
      ],
    })
    expect(queueItem?.missingEvidence).toEqual(expect.arrayContaining([
      'missing_mark_match_status_at_open',
      'missing_round_trip_cost_bps_at_open',
    ]))
    expect(queueItem?.requiredEvidenceBeforeRelaxation).toEqual(expect.arrayContaining([
      'prospective_accept_vs_skip_delta_after_cost_positive',
      'cost_model_quarantine_false',
    ]))
  })

  it('does not treat predicted margin cost as realized cost diagnostics', () => {
    const report = buildCostModelDiagnostics([
      makeTrade({
        tradeId: 'predicted-only',
        estimatedRoundTripCostPctAtOpen: 0.28,
        estimatedRoundTripCostPctOfMarginAtOpen: 2.8,
        leverage: 10,
      }),
    ], '2026-05-02T00:00:00.000Z')

    expect(report.tradesWithCostPrediction).toBe(1)
    expect(report.predictedCostSourceBreakdown).toMatchObject({
      closedTrades: 1,
      estimatedRoundTripCostPctAtOpen: 1,
    })
    expect(report.tradesWithRealizedCost).toBe(0)
    expect(report.tradesWithPaperModelCostEvidence).toBe(0)
    expect(report.tradesWithExchangeReconciledCostEvidence).toBe(0)
    expect(report.pairedCostSamples).toBe(0)
    expect(report.missingCostPrediction).toBe(0)
    expect(report.missingRealizedCost).toBe(1)
    expect(report.quarantineReasons).toEqual(expect.arrayContaining([
      'missing_realized_cost_sample',
      'low_paired_cost_sample',
    ]))
    expect(report.sampleThresholds).toMatchObject({
      minCostPredictionSamples: 30,
      minRealizedCostSamples: 30,
      minPairedCostSamples: 30,
      minExchangeReconciledCostSamples: 30,
    })
    expect(report.quarantineDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'missing_realized_cost_sample',
        actual: 0,
        required: 30,
        failClosed: true,
        promotionEvidenceAllowed: false,
        paperExecutionAllowed: false,
      }),
      expect.objectContaining({
        code: 'low_paired_cost_sample',
        actual: 0,
        required: 30,
      }),
    ]))
    expect(report).toMatchObject({
      profitabilityClaimAllowed: false,
      promotionClaimAllowed: false,
      executionReplayClaimAllowed: false,
    })
  })

  it('counts paper-model cost evidence separately from exchange reconciliation', () => {
    const report = buildCostModelDiagnostics([
      makeTrade({
        tradeId: 'paper-model-cost',
        estimatedRoundTripCostPctAtOpen: 0.28,
        roundTripCostBpsAtOpen: 28,
        realizedCostBps: null,
        fillAdjustedCostPct: null,
        costEvidenceSource: 'paper_cost_model_at_open',
        costEvidenceStatus: 'paper_model_not_exchange_reconciled',
      }),
      makeTrade({
        tradeId: 'exchange-reconciled-cost',
        estimatedRoundTripCostPctAtOpen: 0.3,
        roundTripCostBpsAtOpen: 30,
        realizedCostBps: 34,
        costEvidenceSource: 'exchange_reconciled_fill',
      }),
    ], '2026-05-02T00:00:00.000Z')

    expect(report.tradesWithCostPrediction).toBe(2)
    expect(report.tradesWithRealizedCost).toBe(1)
    expect(report.tradesWithPaperModelCostEvidence).toBe(1)
    expect(report.tradesWithExchangeReconciledCostEvidence).toBe(1)
    expect(report.pairedCostSamples).toBe(1)
    expect(report.costPredictionErrorBpsMean).toBe(4)
    expect(report.predictedCostSourceBreakdown).toMatchObject({
      closedTrades: 2,
      roundTripCostBpsAtOpen: 2,
      estimatedRoundTripCostPctAtOpen: 2,
      costEvidenceSourceCounts: {
        paper_cost_model_at_open: 1,
        exchange_reconciled_fill: 1,
      },
    })
    expect(report.realizedCostEvidenceIntegrity).toMatchObject({
      diagnosticOnly: true,
      realizedFieldsPresent: 1,
      realizedFieldsPresentButPaperModelOnly: 0,
      realizedFieldsPresentWithoutExchangeSource: 0,
      exchangeReconciledSourceMissingRealizedFields: 0,
      paperModelOnlyIgnoredAsRealized: 1,
    })
    expect(report.quarantineReasons).toContain('low_exchange_reconciled_cost_sample')
  })

  it('reports realized-cost integrity gaps without upgrading them to realized samples', () => {
    const report = buildCostModelDiagnostics([
      makeTrade({
        tradeId: 'paper-realized-looking',
        roundTripCostBpsAtOpen: 20,
        realizedCostBps: 23,
        costEvidenceSource: 'paper_cost_model_at_open',
        costEvidenceStatus: 'paper_model_not_exchange_reconciled',
      }),
      makeTrade({
        tradeId: 'unreconciled-realized-looking',
        roundTripCostBpsAtOpen: 20,
        realizedCostBps: 25,
        costEvidenceSource: 'local_estimate',
      }),
      makeTrade({
        tradeId: 'exchange-source-missing-realized',
        roundTripCostBpsAtOpen: 20,
        costEvidenceSource: 'exchange_reconciled_fill',
      }),
    ], '2026-05-02T00:00:00.000Z')

    expect(report.tradesWithRealizedCost).toBe(1)
    expect(report.tradesWithExchangeReconciledCostEvidence).toBe(1)
    expect(report.pairedCostSamples).toBe(1)
    expect(report.realizedCostEvidenceIntegrity).toMatchObject({
      realizedFieldsPresent: 2,
      realizedFieldsPresentButPaperModelOnly: 1,
      realizedFieldsPresentWithoutExchangeSource: 1,
      exchangeReconciledSourceMissingRealizedFields: 1,
      paperModelOnlyIgnoredAsRealized: 0,
    })
    expect(report.realizedCostEvidenceIntegrity.sampleTrades.map(item => item.reason)).toEqual(expect.arrayContaining([
      'realized_fields_present_but_paper_model_only',
      'realized_fields_present_without_exchange_source',
      'exchange_reconciled_source_missing_realized_fields',
    ]))
  })

  it('adds diagnostic-only route-cost shadow eligibility from route budget', () => {
    const root = makeRoot()
    const routeCostBudgetPath = join(root, 'route_cost_budget.latest.json')
    writeFileSync(routeCostBudgetPath, JSON.stringify(makeRouteCostBudget({
      taker_taker: {
        totalExpectedCostBps: 43,
        maxAllowedCostBps: 20,
        breakEvenEdgeBps: 43,
      },
    })))

    const report = buildCostModelDiagnostics([
      makeTrade({
        tradeId: 'route-cost',
        routeCostBpsAtOpen: 43,
        expectedNetEdgePctAtOpen: 0.3,
      }),
    ], '2026-05-02T00:00:00.000Z', routeCostBudgetPath)

    expect(report.routeCostShadowEligibility).toMatchObject({
      diagnosticOnly: true,
      promotionEligible: false,
      paperExecutionAllowed: false,
      routeBudgetArtifactPath: routeCostBudgetPath,
      routeBudgetStatus: 'exceeded',
      feeSnapshotStatus: 'runtime_verified',
      selectedRoute: 'taker_taker',
      selectedRouteSource: 'conservative_promotion_v2_default',
      routeSelectionMutationAllowed: false,
      selectedRouteOverBudgetBps: 23,
      tradeCoverage: {
        closedTrades: 1,
        tradesWithRouteCostBps: 1,
        tradesWithExpectedNetEdge: 1,
        expectedNetEdgeBeatsSelectedRouteBreakEven: 0,
      },
      tradeCoveragePct: {
        routeCostBps: 100,
        expectedNetEdge: 100,
        expectedNetEdgeBeatsSelectedRouteBreakEven: 0,
      },
    })
    expect(report.routeCostShadowEligibility.blockers).toEqual(expect.arrayContaining([
      'route_cost_shadow_eligibility_diagnostic_only',
      'route_cost_budget_exceeded:taker_taker',
    ]))
    expect(report.routeCostShadowEligibility.routes.find(route => route.route === 'taker_taker')).toMatchObject({
      overBudgetBps: 23,
      eligibleForShadowEvaluation: false,
      blockers: ['route_cost_budget_exceeded:taker_taker'],
    })
  })

  it('keeps missing route-cost budget diagnostic-only and blocked', () => {
    const report = buildCostModelDiagnostics(
      [makeTrade({ tradeId: 'missing-budget', routeCostBpsAtOpen: 28 })],
      '2026-05-02T00:00:00.000Z',
      join(makeRoot(), 'missing_route_cost_budget.json'),
    )

    expect(report.routeCostShadowEligibility).toMatchObject({
      diagnosticOnly: true,
      promotionEligible: false,
      paperExecutionAllowed: false,
      routeBudgetStatus: 'invalid',
      feeSnapshotStatus: 'missing',
      selectedRouteSource: 'conservative_promotion_v2_default',
      routeSelectionMutationAllowed: false,
      selectedRouteOverBudgetBps: null,
      routes: [],
      tradeCoveragePct: {
        routeCostBps: 100,
        expectedNetEdge: 0,
        expectedNetEdgeBeatsSelectedRouteBreakEven: 0,
      },
    })
    expect(report.routeCostShadowEligibility.blockers).toEqual(expect.arrayContaining([
      'route_cost_shadow_eligibility_diagnostic_only',
      'route_cost_budget_invalid',
    ]))
  })

  it('uses explicit bps cost before pct fallback and keeps mark-match missing honest', () => {
    const report = buildCostModelDiagnostics([
      makeTrade({
        tradeId: 'explicit-bps',
        estimatedRoundTripCostPctAtOpen: 0.99,
        roundTripCostBpsAtOpen: 31,
        openPrice: 100,
      }),
      makeTrade({
        tradeId: 'mark-match',
        markPriceAtOpen: 100,
        matchPriceAtOpen: 100.08,
      }),
    ], '2026-05-02T00:00:00.000Z')

    expect(report.tradesWithCostPrediction).toBe(1)
    expect(report.predictedCostBpsMean).toBe(31)
    expect(report.markMatchPenalty.tradesWithPenalty).toBe(1)
    expect(report.markMatchPenalty.meanPenaltyBps).toBeCloseTo(8, 8)
    expect(report.markMatchPenalty.statusCounts).toMatchObject({
      missing: 1,
      ok: 1,
    })
  })

  it('reports new-window predicted open evidence separately from legacy cost gaps', () => {
    const report = buildCostModelDiagnostics([
      makeTrade({
        tradeId: 'legacy-missing-cost',
        openTs: '2026-05-01T00:00:00.000Z',
      }),
      makeTrade({
        tradeId: 'new-complete-cost',
        openTs: '2026-05-02T07:00:00.000Z',
        estimatedRoundTripCostPctAtOpen: 0.43,
        roundTripCostBpsAtOpen: 43,
        expectedGrossEdgePctAtOpen: 0.8,
        expectedNetEdgePctAtOpen: 0.37,
        expectedEdgeSourceAtOpen: 'test_edge_minus_cost',
        matchPriceAtOpen: 100,
        matchPriceSourceAtOpen: 'simulated_fill',
        markMatchPenaltyBpsAtOpen: 15,
        markMatchStatusAtOpen: 'stale_or_missing',
      }),
    ], '2026-05-02T08:00:00.000Z')

    expect(report.tradesWithCompletePredictedOpenEvidence).toBe(1)
    expect(report.completePredictedOpenEvidenceCoveragePct).toBe(50)
    expect(report.missingPredictedOpenEvidence).toMatchObject({
      totalMissingTrades: 1,
      sampleTradeIds: ['legacy-missing-cost'],
    })
    expect(report.missingPredictedOpenEvidence.topMissingFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'predicted_cost_bps', missingTrades: 1 }),
        expect.objectContaining({ field: 'expected_gross_edge_pct', missingTrades: 1 }),
        expect.objectContaining({ field: 'mark_match_status', missingTrades: 1 }),
      ]),
    )
    expect(report.missingPredictedOpenEvidence.byLane[0]).toMatchObject({
      lane: 'volume_breakout_1x',
      trades: 2,
      completePredictedOpenEvidence: 1,
      missingPredictedOpenEvidence: 1,
      coveragePct: 50,
    })
    expect(report.newWindow).toMatchObject({
      enforcementTs: '2026-05-02T06:30:00.000Z',
      producerGuardEnforcementTs: '2026-05-04T00:44:00.000Z',
      producerGuardClosedTrades: 0,
      awaitingPostEnforcementClosedTrades: true,
      status: 'ok',
      reason: 'complete_predicted_open_evidence',
      closedTrades: 1,
      tradesWithCompletePredictedOpenEvidence: 1,
      tradesMissingCompletePredictedOpenEvidence: 0,
      completePredictedOpenEvidenceCoveragePct: 100,
    })
  })

  it('backfills legacy cost gaps only as diagnostic evidence', () => {
    const report = buildCostModelDiagnostics([
      makeTrade({
        tradeId: 'legacy-missing-cost',
        openTs: '2026-05-01T00:00:00.000Z',
        pnlPct: 1,
      }),
      makeTrade({
        tradeId: 'new-missing-cost',
        openTs: '2026-05-02T07:00:00.000Z',
        pnlPct: 2,
      }),
      makeTrade({
        tradeId: 'new-predicted-cost',
        openTs: '2026-05-02T07:05:00.000Z',
        pnlPct: 3,
        roundTripCostBpsAtOpen: 28,
      }),
    ], '2026-05-02T08:00:00.000Z')

    expect(report.tradesWithCostPrediction).toBe(1)
    expect(report.missingCostPrediction).toBe(2)
    expect(report.missingPredictedOpenEvidence.totalMissingTrades).toBe(3)
    expect(report.missingPredictedOpenEvidence.topMissingFields[0]).toMatchObject({
      field: 'expected_edge_source',
      missingTrades: 3,
      missingPct: 100,
    })
    expect(report.legacyDiagnosticCostBackfill).toMatchObject({
      status: 'active',
      policy: 'diagnostic_only_not_promotion_evidence',
      promotionEvidenceAllowed: false,
      source: 'legacy_lane_default_fee_slippage_mark_penalty',
      defaultRoundTripCostBps: 43,
      eligibleLegacyMissingCostTrades: 1,
      backfilledTrades: 1,
      excludedNewWindowMissingCostTrades: 1,
      diagnosticNetPnlPct: 0.57,
      diagnosticMeanNetPnlPct: 0.57,
    })
    expect(report.actionableProducerGuardPatchTargets).toMatchObject({
      closedTrades: 0,
      missingPredictedCost: 0,
      missingCompletePredictedOpenEvidence: 0,
    })
    expect(report.legacyQuarantineTargets).toMatchObject({
      closedTrades: 1,
      missingPredictedCost: 1,
      missingCompletePredictedOpenEvidence: 1,
    })
    expect(report.transitionalDirtyQuarantineTargets).toMatchObject({
      closedTrades: 2,
      missingPredictedCost: 1,
      missingCompletePredictedOpenEvidence: 2,
    })
    expect(report.producerGuardMissingPredictedCostTargets).toEqual([])
    expect(report.producerGuardMissingCompletePredictedOpenEvidenceTargets).toEqual([])
    expect(report.newWindow).toMatchObject({
      status: 'ok',
      reason: 'complete_predicted_open_evidence',
      producerGuardClosedTrades: 0,
      awaitingPostEnforcementClosedTrades: true,
      closedTrades: 2,
      tradesWithCompletePredictedOpenEvidence: 0,
      tradesMissingCompletePredictedOpenEvidence: 2,
      transitionalDirtyMissingPredictedOpenEvidence: 2,
      producerGuardMissingPredictedOpenEvidence: 0,
    })
  })

  it('labels empty post-enforcement cost windows as awaiting future closed trades', () => {
    const report = buildCostModelDiagnostics([
      makeTrade({
        tradeId: 'legacy-complete',
        openTs: '2026-05-01T00:00:00.000Z',
        roundTripCostBpsAtOpen: 28,
        expectedGrossEdgePctAtOpen: 0.8,
        expectedNetEdgePctAtOpen: 0.52,
        expectedEdgeSourceAtOpen: 'test_edge_minus_cost',
        matchPriceAtOpen: 100,
        matchPriceSourceAtOpen: 'simulated_fill',
        markMatchPenaltyBpsAtOpen: 0,
        markMatchStatusAtOpen: 'ok',
      }),
    ], '2026-05-02T08:00:00.000Z')

    expect(report.newWindow).toMatchObject({
      status: 'insufficient_data',
      reason: 'awaiting_post_enforcement_closed_trades',
      producerGuardClosedTrades: 0,
      awaitingPostEnforcementClosedTrades: true,
      closedTrades: 0,
      tradesWithCompletePredictedOpenEvidence: 0,
      tradesMissingCompletePredictedOpenEvidence: 0,
      completePredictedOpenEvidenceCoveragePct: 0,
    })
  })

  it('surfaces open positions that will close with missing predicted-open evidence', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    mkdirSync(paperDir, { recursive: true })
    writeFileSync(join(paperDir, 'account.json'), JSON.stringify({
      positions: [
        {
          symbol: 'SEI-USDT',
          direction: 'short',
          entryPrice: 0.05759,
          entryTime: '2026-05-01T09:41:57.932Z',
          leverage: 1,
        },
        {
          symbol: 'DOGE-USDT',
          direction: 'long',
          entryPrice: 0.10876,
          entryTime: '2026-05-02T12:17:05.427Z',
          leverage: 1,
          contextSnapshotId: 'ctx:doge',
          decisionTime: '2026-05-02T12:17:05.427Z',
          marketDataWatermarkAtDecisionTime: '2026-05-02T12:17:05.000Z',
          featuresAvailableAtDecisionTime: true,
          featureSchemaVersion: 'paper_open_context.v3',
          contextGenerationAtOpen: 1,
          contextStatus: 'ok',
          flashContextStatus: 'ok',
          flashConfidenceLowAtOpen: 0.5,
          estimatedRoundTripCostPctAtOpen: 0.28,
          routeCostBpsAtOpen: 28,
          roundTripCostBpsAtOpen: 28,
          expectedGrossEdgePctAtOpen: 0.8,
          expectedNetEdgePctAtOpen: 0.52,
          expectedEdgeSourceAtOpen: 'test_open_position_edge_minus_cost',
          matchPriceAtOpen: 0.10876,
          matchPriceSourceAtOpen: 'simulated_fill',
          markMatchPenaltyBpsAtOpen: 15,
          markMatchStatusAtOpen: 'stale_or_missing',
        },
      ],
    }))

    const index = await buildP1TradingEvidence({
      paperDir,
      dataDir: join(root, 'market'),
      oneSecondDataDir: join(root, 'market_1s'),
      oneHourDataDir: join(root, 'market_1h'),
      shadowLedgerPath: join(root, 'missing_shadow.jsonl'),
      outputDir: join(root, 'out'),
      candidateRegistryPath: join(root, 'missing_candidate.json'),
      graveyardPath: join(root, 'missing_graveyard.json'),
      bestConfigPath: join(root, 'missing_best_config.json'),
      trialRegistryPath: join(root, 'missing_trial_registry.jsonl'),
      evidenceOutputRoot: join(root, 'missing_runtime_research'),
      optimizationDir: join(root, 'missing_optimization'),
      validationDir: join(root, 'missing_validation'),
      routeCostBudgetPath: join(root, 'missing_route_cost_budget.json'),
      timeframe: '5m',
      lookbackHours: null,
      json: true,
    })
    const cost = JSON.parse(await readFile(index.artifacts.costModelDiagnostics, 'utf-8'))

    expect(cost.openPositionReadiness).toMatchObject({
      status: 'blocked_legacy_dirty_opens',
      blockers: expect.arrayContaining([
        'open_position_readiness:blocked_legacy_dirty_opens',
        'open_positions:2',
        'open_positions_missing_predicted_open_evidence:1',
        'legacy_open_positions_will_close_dirty:1',
        'open_positions_missing_v3_context:1',
      ]),
      totalOpenPositions: 2,
      legacyOpenPositions: 1,
      newOpenPositions: 1,
      producerGuardOpenPositions: 0,
      completePredictedOpenEvidence: 1,
      missingPredictedOpenEvidence: 1,
      legacyMissingPredictedOpenEvidence: 1,
      newMissingPredictedOpenEvidence: 0,
      transitionalDirtyMissingPredictedOpenEvidence: 0,
      producerGuardMissingPredictedOpenEvidence: 0,
      newMissingPredictedOpenEvidenceByField: [],
      completeV3Context: 1,
      missingV3Context: 1,
      futureCloseDirtyRisk: 'legacy_will_close_dirty',
    })
    expect(cost.openPositionReadiness.byAccount[0].samplePositions[0]).toMatchObject({
      symbol: 'SEI-USDT',
      side: 'short',
      lane: 'cross_sectional_1x',
      v3ContextStatus: 'missing',
    })
    expect(cost.openPositionReadiness.byAccount[0].samplePositions[0].missingPredictedOpenEvidenceFields).toEqual(
      expect.arrayContaining([
        'expected_gross_edge_pct',
        'expected_net_edge_pct',
        'expected_edge_source',
        'match_price',
        'mark_match_penalty_bps',
      ]),
    )
  })

  it('separates new open-position predicted-open evidence gaps from legacy dirty opens', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    mkdirSync(paperDir, { recursive: true })
    writeFileSync(join(paperDir, 'account.json'), JSON.stringify({
      positions: [
        {
          symbol: 'SEI-USDT',
          direction: 'short',
          entryPrice: 0.05759,
          entryTime: '2026-05-01T09:41:57.932Z',
          leverage: 1,
        },
        {
          symbol: 'DOGE-USDT',
          direction: 'long',
          entryPrice: 0.10876,
          entryTime: '2026-05-02T12:17:05.427Z',
          leverage: 1,
          contextSnapshotId: 'ctx:doge',
          decisionTime: '2026-05-02T12:17:05.427Z',
          marketDataWatermarkAtDecisionTime: '2026-05-02T12:17:05.000Z',
          featuresAvailableAtDecisionTime: true,
          featureSchemaVersion: 'paper_open_context.v3',
          contextGenerationAtOpen: 1,
          contextStatus: 'ok',
          flashContextStatus: 'ok',
          flashConfidenceLowAtOpen: 0.5,
          estimatedRoundTripCostPctAtOpen: 0.28,
          routeCostBpsAtOpen: 28,
          roundTripCostBpsAtOpen: 28,
          matchPriceAtOpen: 0.10876,
          matchPriceSourceAtOpen: 'simulated_fill',
          markMatchStatusAtOpen: 'stale_or_missing',
        },
      ],
    }))

    const index = await buildP1TradingEvidence({
      paperDir,
      dataDir: join(root, 'market'),
      oneSecondDataDir: join(root, 'market_1s'),
      oneHourDataDir: join(root, 'market_1h'),
      shadowLedgerPath: join(root, 'missing_shadow.jsonl'),
      outputDir: join(root, 'out'),
      candidateRegistryPath: join(root, 'missing_candidate.json'),
      graveyardPath: join(root, 'missing_graveyard.json'),
      bestConfigPath: join(root, 'missing_best_config.json'),
      trialRegistryPath: join(root, 'missing_trial_registry.jsonl'),
      evidenceOutputRoot: join(root, 'missing_runtime_research'),
      optimizationDir: join(root, 'missing_optimization'),
      validationDir: join(root, 'missing_validation'),
      routeCostBudgetPath: join(root, 'missing_route_cost_budget.json'),
      timeframe: '5m',
      lookbackHours: null,
      json: true,
    })
    const cost = JSON.parse(await readFile(index.artifacts.costModelDiagnostics, 'utf-8'))

    expect(cost.openPositionReadiness).toMatchObject({
      status: 'blocked_legacy_dirty_opens',
      blockers: expect.arrayContaining([
        'open_position_readiness:blocked_legacy_dirty_opens',
        'open_positions:2',
        'open_positions_missing_predicted_open_evidence:2',
        'legacy_open_positions_will_close_dirty:1',
        'new_open_positions_missing_predicted_open_evidence:1',
        'transitional_dirty_open_positions_missing_predicted_open_evidence:1',
        'new_open_positions_missing_field:expected_gross_edge_pct:1',
        'new_open_positions_missing_field:mark_match_penalty_bps:1',
      ]),
      totalOpenPositions: 2,
      legacyOpenPositions: 1,
      newOpenPositions: 1,
      producerGuardOpenPositions: 0,
      missingPredictedOpenEvidence: 2,
      legacyMissingPredictedOpenEvidence: 1,
      newMissingPredictedOpenEvidence: 1,
      transitionalDirtyMissingPredictedOpenEvidence: 1,
      producerGuardMissingPredictedOpenEvidence: 0,
      futureCloseDirtyRisk: 'legacy_will_close_dirty',
    })
    expect(cost.openPositionReadiness.newMissingPredictedOpenEvidenceByField).toEqual(expect.arrayContaining([
      { field: 'expected_gross_edge_pct', missingPositions: 1 },
      { field: 'expected_net_edge_pct', missingPositions: 1 },
      { field: 'expected_edge_source', missingPositions: 1 },
      { field: 'mark_match_penalty_bps', missingPositions: 1 },
    ]))
    expect(cost.openPositionReadiness.byAccount[0]).toMatchObject({
      legacyMissingPredictedOpenEvidence: 1,
      newMissingPredictedOpenEvidence: 1,
      transitionalDirtyMissingPredictedOpenEvidence: 1,
      producerGuardMissingPredictedOpenEvidence: 0,
    })
  })

  it('keeps legacy diagnostic backfill out of promotion-grade gate cost coverage', () => {
    const report = buildGateEffectivenessReport({
      acceptedTrades: [
        makeTrade({
          tradeId: 'accepted-legacy',
          openTs: '2026-05-01T00:00:00.000Z',
          closeTs: '2026-05-01T00:05:00.000Z',
          pnlPct: 1,
        }),
      ],
      ledgerEntries: [
        {
          counterfactualType: 'trade_level_shadow',
          eventType: 'open',
          shadowId: 'shadow-with-cost',
          lane: 'volume_breakout_1x',
          symbol: 'ETH-USDT',
          side: 'long',
          entryPrice: 100,
          openTs: '2026-05-01T00:00:00.000Z',
          openBarTime: Date.parse('2026-05-01T00:00:00.000Z'),
          horizonMs: 300000,
          notionalUsd: null,
          stopLossPrice: 99,
          blockReasons: ['test'],
          context: completeShadowContext(1),
          quality: {},
          cost: {
            roundTripCostBpsAtOpen: 28,
          },
        },
        {
          counterfactualType: 'trade_level_shadow',
          eventType: 'closed',
          shadowId: 'shadow-with-cost',
          lane: 'volume_breakout_1x',
          symbol: 'ETH-USDT',
          side: 'long',
          entryPrice: 100,
          closePrice: 99,
          openTs: '2026-05-01T00:00:00.000Z',
          openBarTime: Date.parse('2026-05-01T00:00:00.000Z'),
          closeTs: '2026-05-01T00:05:00.000Z',
          closeBarTime: Date.parse('2026-05-01T00:05:00.000Z'),
          horizonMs: 300000,
          pnlPct: -1,
          pnlUsd: null,
          closeReason: 'shadow_stop_loss',
        },
      ],
      lookbackHours: null,
      generatedAt: '2026-05-02T00:00:00.000Z',
    })

    expect(report.costAdjusted.acceptedWithPredictedCost).toBe(0)
    expect(report.costAdjusted.acceptedMissingPredictedCost).toBe(1)
    expect(report.costAdjusted.acceptNetPnlPct).toBeNull()
    expect(report.costAdjusted.diagnosticLegacyBackfill).toMatchObject({
      policy: 'diagnostic_only_not_promotion_evidence',
      source: 'legacy_lane_default_fee_slippage_mark_penalty',
      defaultRoundTripCostBps: 43,
      acceptedBackfilledTrades: 1,
      skippedBackfilledTrades: 0,
      acceptedDiagnosticNetPnlPct: 0.57,
    })
    expect(report.costAdjusted.acceptedMissingPredictedCostAttribution.byProducerGuardStatus.legacy_pre_context_enforcement).toBe(1)
    expect(report.gateStatus).toBe('insufficient_data')
  })

  it('writes all P1 evidence artifacts and manifests', async () => {
    const root = makeRoot()
    const paperDir = join(root, 'paper')
    const dataDir = join(root, 'market')
    const outputDir = join(root, 'out')
    const ledgerPath = join(paperDir, 'shadow.jsonl')
    const candidateRegistryPath = join(root, 'candidate_registry.json')
    const graveyardPath = join(root, 'graveyard.json')
    const bestConfigPath = join(root, 'best_config.json')
    const trialRegistryPath = join(root, 'trial_registry.jsonl')
    const evidenceOutputRoot = join(root, 'runtime_research')
    const optimizationDir = join(root, 'optimization')
    const validationDir = join(root, 'new_strategies_validation')
    const visibleEvidenceId = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const visibleEvidenceDir = join(evidenceOutputRoot, 'validation', evidenceIdToPathKey(visibleEvidenceId))
    mkdirSync(paperDir, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(visibleEvidenceDir, { recursive: true })
    mkdirSync(optimizationDir, { recursive: true })
    mkdirSync(validationDir, { recursive: true })
    writeFileSync(join(visibleEvidenceDir, 'feature_availability_audit.json'), JSON.stringify({
      schema_version: 'evidence_os_v4_feature_availability_audit.v4_0',
      evidence_id: visibleEvidenceId,
      status: 'blocked',
      row_level_proxy_audit: {
        proxy_status: 'pass',
        promotion_grade: false,
        proxy_type: 'csv_bar_event_time_as_decision_time',
      },
      blocking_reasons: [{
        code: 'PIT_PROXY_ONLY',
        severity: 'hard_block',
        source: 'validation_runner',
        required: 'promotion-grade per-row system arrival_time <= decision_time proof',
        observed: 'csv_bar_event_time_as_decision_time',
      }],
    }))
    writeFileSync(join(paperDir, 'paper_trade_result.jsonl'), JSON.stringify({
      tradeId: 'accepted',
      lane: 'volume_breakout_1x',
      symbol: 'ETH-USDT',
      side: 'long',
      openTs: '2026-05-01T00:00:00.000Z',
      closeTs: '2026-05-01T00:05:00.000Z',
      openPrice: 100,
      closePrice: 101,
      pnlPct: 1,
      closeReason: 'take_profit',
      contextGenerationAtOpen: 1,
      estimatedRoundTripCostPctAtOpen: 0.2,
    }) + '\n')
    writeFileSync(ledgerPath, [
      JSON.stringify({
        counterfactualType: 'trade_level_shadow',
        eventType: 'open',
        shadowId: 'shadow',
        lane: 'volume_breakout_1x',
        symbol: 'ETH-USDT',
        side: 'long',
        entryPrice: 100,
        openTs: '2026-05-01T00:00:00.000Z',
        openBarTime: Date.parse('2026-05-01T00:00:00.000Z'),
        horizonMs: 300000,
        notionalUsd: null,
        stopLossPrice: 99,
        blockReasons: ['confidence 0.000 < 0.2'],
        context: completeShadowContext(1),
        quality: {},
        cost: {
          roundTripCostBpsAtOpen: 28,
        },
      }),
      JSON.stringify({
        counterfactualType: 'trade_level_shadow',
        eventType: 'closed',
        shadowId: 'shadow',
        lane: 'volume_breakout_1x',
        symbol: 'ETH-USDT',
        side: 'long',
        entryPrice: 100,
        closePrice: 99,
        openTs: '2026-05-01T00:00:00.000Z',
        openBarTime: Date.parse('2026-05-01T00:00:00.000Z'),
        closeTs: '2026-05-01T00:05:00.000Z',
        closeBarTime: Date.parse('2026-05-01T00:05:00.000Z'),
        horizonMs: 300000,
        pnlPct: -1,
        pnlUsd: null,
        closeReason: 'shadow_stop_loss',
      }),
    ].join('\n'))
    writeFileSync(candidateRegistryPath, JSON.stringify({
      registryId: 'test-registry',
      entries: [{
        candidateId: 'candidate-a',
        experimentId: 'experiment-a',
        strategyId: 'cross_sectional_v2',
        generatedAt: '2026-05-02T00:00:00.000Z',
        scriptName: 'optimize:cross-sectional',
        parameterHash: 'abcdef0123456789',
        status: 'active',
      }],
    }))
    writeFileSync(graveyardPath, JSON.stringify({
      registryId: 'test-graveyard',
      entries: [{
        candidateId: 'candidate-dead',
        experimentId: 'experiment-a',
        strategyId: 'volume_breakout_v0',
        parameterHash: 'deadbeef01234567',
        status: 'killed',
      }],
    }))
    writeFileSync(bestConfigPath, JSON.stringify({
      assetCount: 6,
      discoveredAt: '2026-05-02T00:00:00.000Z',
      dataRange: { start: '2026-01-01T00:00:00.000Z', end: '2026-05-01T00:00:00.000Z' },
      config: { lookbackHours: 120, minSpreadPct: 3 },
    }))
    writeFileSync(trialRegistryPath, [
      JSON.stringify({
        trial_id: 'trial-visible-1',
        evidence_id: visibleEvidenceId,
        trial_type: 'alpha_candidate',
        strategy_family: 'shock_fade',
        candidate_id: 'candidate-visible-1',
        primary_metric: 'cost_adjusted_net_expectancy_bps',
        secondary_metrics: ['ic_mean', 'turnover'],
        p_value: null,
        included_in_fdr: true,
        fdr_family: '2026Q2_crypto_evidence_os_v4',
        promotion_eligible: false,
        status: 'blocked_missing_fdr',
        failure_codes: ['MISSING_FDR_REPORT'],
        batch_id: 'batch-visible',
        created_at: '2026-05-02T00:00:00.000Z',
        metadata: {
          fdr_report_status: 'missing',
          fdr_p_values_available: false,
          fdr_missing_p_value_count: 1,
          fdr_p_value_blocked_reason: 'raw_m_complete=false',
        },
      }),
      JSON.stringify({
        trial_id: 'trial-visible-2',
        evidence_id: 'sha256:visible2',
        trial_type: 'alpha_candidate',
        strategy_family: 'trend',
        candidate_id: 'candidate-visible-2',
        primary_metric: 'cost_adjusted_net_expectancy_bps',
        p_value: null,
        included_in_fdr: true,
        fdr_family: '2026Q2_crypto_evidence_os_v4',
        promotion_eligible: false,
        status: 'blocked_missing_fdr',
        failure_codes: ['MISSING_FDR_REPORT'],
        batch_id: 'batch-visible',
        created_at: '2026-05-02T00:01:00.000Z',
        metadata: {
          fdr_report_status: 'missing',
          fdr_p_values_available: false,
          fdr_missing_p_value_count: 1,
          fdr_p_value_blocked_reason: 'includes_failed_trials=false',
          pit_audit_status: 'stub_blocked_by_feature_availability_audit',
          pit_audit_blocking_codes: ['PIT_AUDIT_NOT_IMPLEMENTED'],
          pit_audit_proxy_type: 'not_available',
          pit_audit_promotion_grade: false,
        },
      }),
    ].join('\n'))
    writeFileSync(join(optimizationDir, 'sweep_test.json'), JSON.stringify({
      generatedAt: '2026-05-02T00:00:00.000Z',
      experimentId: 'sweep-test',
      candidateCount: 12,
      topConfigs: [{
        lookbackHours: 120,
        minSpreadPct: 3,
        signals: 100,
        winRate: 51,
        avgSpread: 0.2,
        score: 1.2,
      }],
    }))
    writeFileSync(join(validationDir, 'validation_test.json'), JSON.stringify({
      generatedAt: '2026-05-02T00:00:00.000Z',
      strategies: [{
        strategy: 'enhancedCarry',
        symbol: 'ETH-USDT',
        trades: 10,
        winRate: 40,
        totalReturnPct: -1,
        sharpe: -0.5,
        netExpectancyPct: -0.1,
      }],
    }))

    const index = await buildP1TradingEvidence({
      paperDir,
      dataDir,
      oneSecondDataDir: dataDir,
      oneHourDataDir: dataDir,
      shadowLedgerPath: ledgerPath,
      outputDir,
      candidateRegistryPath,
      graveyardPath,
      bestConfigPath,
      trialRegistryPath,
      evidenceOutputRoot,
      optimizationDir,
      validationDir,
      routeCostBudgetPath: join(root, 'missing_route_cost_budget.json'),
      timeframe: '5m',
      lookbackHours: null,
      json: true,
    })

    expect(Object.keys(index.artifacts)).toEqual(expect.arrayContaining([
      'alphaHypothesisRegistry',
      'trialLedger',
      'gateEffectiveness',
      'costModelDiagnostics',
      'mfeMaeStoploss',
      'stoplossRiskPolicy',
      'candidateKillCriteria',
      'index',
    ]))
    const gate = JSON.parse(await readFile(index.artifacts.gateEffectiveness, 'utf-8'))
    const trialLedger = JSON.parse(await readFile(index.artifacts.trialLedger, 'utf-8'))
    const stoplossRiskPolicy = JSON.parse(await readFile(index.artifacts.stoplossRiskPolicy, 'utf-8'))
    expect(gate.accepted).toBe(1)
    expect(gate.skipped).toBe(1)
    expect(gate.skipStats.count).toBe(1)
    expect(trialLedger.rawMCompleteness).toBe('visible_sources_only')
    expect(trialLedger.status).toBe('skeleton')
    expect(trialLedger.promotionEligible).toBe(false)
    expect(trialLedger.raw_m).toBe(2)
    expect(trialLedger.effective_m).toBe(0)
    expect(trialLedger.fdrDiagnostics).toMatchObject({
      raw_m: 2,
      effective_m: 0,
    })
    expect(trialLedger.readinessGaps).toMatchObject({
      includedRawMTrials: 2,
      visibleFailedTrials: 3,
      missingPValueTrials: 2,
      missingFdrReportTrials: 2,
      fdrInputsIncompleteTrials: 0,
      fdrReportPresentTrials: 0,
      fdrReportBlockedTrials: 2,
      missingFdrReportPathTrials: 2,
      pitAuditNotImplementedTrials: 1,
      pitProxyOnlyTrials: 1,
      missingPitAuditMetadataTrials: 0,
      completeTrialUniverseMarkers: 0,
      pValueUnavailableReasonCounts: [
        { reason: 'includes_failed_trials=false', count: 1 },
        { reason: 'raw_m_complete=false', count: 1 },
      ],
      fdrBlockedReasonCounts: [
        { reason: 'missing', count: 2 },
      ],
    })
    expect(trialLedger.readinessGaps.blockerSummary).toEqual(expect.arrayContaining([
      'missing_complete_trial_universe_marker',
      'missing_p_value_trials:2',
      'missing_fdr_report_trials:2',
      'pit_audit_not_implemented_trials:1',
      'pit_proxy_only_trials:1',
    ]))
    expect(trialLedger.entries.filter((entry: any) => entry.source === 'runtime_trial_registry')).toHaveLength(2)
    expect(trialLedger.entries.find((entry: any) => entry.metrics.evidenceId === visibleEvidenceId)?.metrics).toMatchObject({
      pitAuditPath: join(visibleEvidenceDir, 'feature_availability_audit.json'),
      pitAuditStatus: 'blocked',
      pitAuditBlockingCodes: 'PIT_PROXY_ONLY',
      pitAuditProxyType: 'csv_bar_event_time_as_decision_time',
      pitAuditPromotionGrade: false,
      artifactLinkedPitAudit: true,
      artifactLinkedFdrReport: false,
    })
    expect(trialLedger.entries.filter((entry: any) => entry.source === 'best_config' && entry.includedInRawM)).toHaveLength(0)
    expect(trialLedger.sourceDiagnostics.map((item: any) => item.source)).toEqual(expect.arrayContaining([
      'candidate_registry',
      'graveyard',
      'best_config',
      'runtime_trial_registry',
      'optimization_sweep',
      'new_strategy_validation',
    ]))
    expect(trialLedger.sourceDiagnostics.find((item: any) => item.source === 'best_config')).toMatchObject({
      entriesEmitted: 0,
    })
    expect(trialLedger.sourceDiagnostics.find((item: any) => item.source === 'runtime_trial_registry')).toMatchObject({
      status: 'loaded',
      recordsIn: 2,
      entriesEmitted: 2,
    })
    expect(stoplossRiskPolicy).toMatchObject({
      diagnosticOnly: true,
      promotionEligible: false,
      policyMutationAllowed: false,
    })
    expect(index.childArtifactAudit).toMatchObject({
      overallAuditStatus: 'blocked_by_child_artifacts',
      tradingBehaviorChanged: false,
      promotionAllowed: false,
      paperExecutionAllowed: false,
      costModelDiagnostics: {
        quarantine: true,
        openPositionReadinessStatus: 'insufficient_data',
      },
      trialLedger: {
        status: 'skeleton',
        fdrGateStatus: 'blocked_missing_complete_trial_universe',
      },
      trialSourceCoverage: {
        status: 'blocked',
      },
      gateEffectiveness: {
        gateStatus: 'insufficient_data',
      },
      stoplossRiskPolicy: {
        promotionBlocked: false,
      },
    })
    expect(index.childArtifactAudit.trialLedger.blockerSummary).toEqual(expect.arrayContaining([
      'missing_complete_trial_universe_marker',
      'missing_p_value_trials:2',
    ]))
    expect(index.childArtifactAudit.trialSourceCoverage.topPatchTargets).toBeGreaterThan(0)
    expect(index.manifestPaths.gateEffectiveness).toMatch(/manifest\.json$/)
    expect(index.manifestPaths.stoplossRiskPolicy).toMatch(/manifest\.json$/)
  })
})

function makeTrade(overrides: Partial<NormalizedPaperTrade> = {}): NormalizedPaperTrade {
  return {
    tradeId: 'trade',
    source: 'test',
    lane: 'volume_breakout_1x',
    accountId: null,
    accountLabel: null,
    symbol: 'ETH-USDT',
    side: 'long',
    leverage: 1,
    openTs: '2026-05-01T00:00:00.000Z',
    closeTs: '2026-05-01T00:05:00.000Z',
    openPrice: 100,
    closePrice: 101,
    pnlPct: 1,
    pnlUsd: null,
    closeReason: 'take_profit',
    rawReason: 'take_profit',
    holdingSeconds: 300,
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
    contextGenerationAtOpen: 1,
    flashConfidenceLowAtOpen: null,
    ruleScoreAtOpen: null,
    proEpochAtOpen: null,
    marketIntelTriggerAtOpen: null,
    regimeAtOpen: null,
    contextCoverageBucket: 'ok',
    liquidated: false,
    ...overrides,
  }
}

function makeTrialLedgerEntry(overrides: {
  trialId: string
  policyId: string
  pValue: number | null
  status?: TrialLedgerEntry['status']
  parameterCluster?: string
  includedInRawM?: boolean
  includedInEffectiveM?: boolean
  source?: string
  metrics?: Record<string, unknown>
}): TrialLedgerEntry {
  return {
    trialId: overrides.trialId,
    familyId: 'test_family',
    policyId: overrides.policyId,
    featureSetHash: 'feature-set',
    universeHash: 'universe',
    parameterCluster: overrides.parameterCluster ?? 'cluster',
    status: overrides.status ?? 'active',
    source: overrides.source ?? 'runtime_trial_registry',
    metrics: { pValue: overrides.pValue, ...(overrides.metrics ?? {}) },
    includedInRawM: overrides.includedInRawM ?? true,
    includedInEffectiveM: overrides.includedInEffectiveM ?? true,
  }
}

function emptyAlphaRegistry() {
  return {
    schemaVersion: 1 as const,
    generatedAt: '2026-05-02T00:00:00.000Z',
    registryStatus: 'active' as const,
    entries: [],
  }
}

function makeRouteCostBudget(
  routeOverrides: Partial<Record<string, Partial<{
    totalExpectedCostBps: number
    maxAllowedCostBps: number
    breakEvenEdgeBps: number
  }>>> = {},
) {
  const feeSnapshot = {
    venue: 'binance',
    symbol: 'BTCUSDT',
    instrumentType: 'perp',
    accountTier: 'default',
    makerFeeBps: 2,
    takerFeeBps: 6,
    source: 'runtime',
    sourceFetchedAt: '2026-05-02T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
    verifiedByRuntime: true,
  }
  const makeRoute = (
    route: 'passive_passive' | 'passive_taker' | 'taker_taker' | 'twap',
    totalExpectedCostBps: number,
  ) => ({
    route,
    feeBps: 4,
    spreadBps: 2,
    slippageBps: Math.max(0, totalExpectedCostBps - 11),
    adverseSelectionBufferBps: 3,
    queueMissBufferBps: 2,
    fundingBps: 0,
    totalExpectedCostBps,
    maxAllowedCostBps: 20,
    breakEvenEdgeBps: totalExpectedCostBps,
    ...(routeOverrides[route] ?? {}),
  })
  return {
    schemaMeta: {
      schemaName: 'route_cost_budget',
      schemaVersion: 'test',
      createdBy: 'test',
      createdAt: '2026-05-02T00:00:00.000Z',
      codeCommit: 'test',
    },
    generatedAt: '2026-05-02T00:00:00.000Z',
    feeSnapshot,
    routes: {
      passive_passive: makeRoute('passive_passive', 18),
      passive_taker: makeRoute('passive_taker', 25),
      taker_taker: makeRoute('taker_taker', 28),
      twap: makeRoute('twap', 30),
    },
  }
}

function completeShadowContext(
  generation: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contextSnapshotId: `shadow-context:${generation}`,
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
