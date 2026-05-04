/**
 * P1 trading evidence builder.
 *
 * Produces machine-readable reports for:
 * - alpha hypothesis registry
 * - trial ledger skeleton
 * - accept-vs-skip gate effectiveness
 * - cost model diagnostics
 * - MFE/MAE stop-loss diagnostics
 * - candidate kill criteria
 *
 * This is read-only. It writes diagnostics only and never submits orders.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  runFdrCorrection,
  runLedgerBoundFdrCorrection,
} from '../src/backtest/fdr.js'
import { evidenceIdToPathKey } from '../src/evidence/evidence_id.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import {
  DEFAULT_PAPER_POLICY_SHADOW_LEDGER_PATH,
  paperPolicyShadowOpenMissingV3ContextFields,
  readPaperPolicyShadowLedger,
  type PaperPolicyShadowLedgerEntry,
  type PaperPolicyShadowOutcome,
  type ParsedPaperPolicyShadowOpen,
} from '../src/runtime/paper_policy_shadow_ledger.js'
import {
  loadClosedTrades,
  computeStats,
  isAfterPredictedOpenEvidenceEnforcement,
  normalizedPredictedOpenEvidenceEnforcementTs,
  type ContextCoverageBucket,
  type GroupStats,
  type NormalizedPaperTrade,
} from './analyze_paper_pnl.js'
import {
  paperSymbolToCsvFile,
  type PaperUniverseTimeframe,
} from './lib/paper_universe.js'
import type { FeeSnapshot, RouteCostBudget, RouteName } from '../src/runtime/promotion_v2.js'

export interface P1TradingEvidenceArgs {
  paperDir: string
  dataDir: string
  oneSecondDataDir: string
  oneHourDataDir: string
  shadowLedgerPath: string
  outputDir: string
  candidateRegistryPath: string
  graveyardPath: string
  bestConfigPath: string
  trialRegistryPath: string
  evidenceOutputRoot: string
  optimizationDir: string
  validationDir: string
  routeCostBudgetPath: string
  timeframe: PaperUniverseTimeframe
  lookbackHours: number | null
  json: boolean
}

export type GateStatus = 'useful' | 'neutral' | 'harmful' | 'insufficient_data'
export type DiagnosticQuality = 'ok' | 'low_sample' | 'no_data'
export type GateStratifiedDimension = 'lane' | 'symbol' | 'side' | 'lane_symbol_side'
export type GateCostCoverageCohort = 'accepted_closed' | 'skipped_closed_shadow' | 'skipped_open_shadow'
export type GateCostCoverageProducerGuardStatus =
  | 'legacy_pre_context_enforcement'
  | 'transitional_dirty_open'
  | 'producer_guard_enforced'
  | 'unknown_time'
export type GateStratifiedAction =
  | 'candidate_review_only'
  | 'keep_blocked'
  | 'collect_more_data'
  | 'cost_coverage_required'
  | 'neutral_review'

export interface AlphaHypothesisEntry {
  policyId: string
  familyId: string
  alphaHypothesis: string
  marketInefficiency: string
  whoPays: string
  expectedHoldingHorizon: string
  expectedFailureRegime: string[]
  requiredObservables: string[]
  falsificationRule: {
    condition: string
    action: 'kill_candidate' | 'keep_shadow_only' | 'revise_hypothesis'
  }
  promotionBlockedBy: string[]
}

export interface AlphaHypothesisRegistry {
  schemaVersion: 1
  generatedAt: string
  registryStatus: 'active'
  entries: AlphaHypothesisEntry[]
}

export interface TrialLedgerEntry {
  trialId: string
  familyId: string
  policyId: string
  featureSetHash: string
  universeHash: string
  parameterCluster: string
  status: 'registered' | 'active' | 'graveyard' | 'killed'
  source: string
  metrics: Record<string, number | string | boolean | null>
  includedInRawM: boolean
  includedInEffectiveM: boolean
}

interface VisibleTrialLedgerSources {
  entries: TrialLedgerEntry[]
  diagnostics: TrialLedgerReport['sourceDiagnostics']
}

interface RuntimeValidationArtifactLinks {
  fdrReportPath: string | null
  fdrReport: Record<string, unknown> | null
  featureAvailabilityAuditPath: string | null
  featureAvailabilityAudit: Record<string, unknown> | null
}

export interface TrialLedgerReport {
  schemaVersion: 1
  generatedAt: string
  raw_m: number
  effective_m: number
  rawMComplete: boolean
  rawMCompleteness: 'visible_sources_only' | 'complete_trial_universe'
  includesFailedTrials: boolean
  failedTrialCount: number
  survivingTrialCount: number
  promotionEligible: boolean
  fdrGateStatus: 'blocked_missing_complete_trial_universe' | 'blocked_missing_pvalues' | 'ready_explanatory_only' | 'invalid_trial_ledger'
  fdrMethodPrimary: 'BY_raw_m'
  fdrMethodSecondary: 'BY_effective_m'
  status: 'valid' | 'invalid_trial_ledger' | 'skeleton'
  fdrDiagnostics: {
    status: 'ready' | 'skeleton_no_pvalues' | 'invalid_trial_ledger' | 'blocked_missing_complete_trial_universe'
    raw_m: number
    effective_m: number
    fdrComputationEligibleM: number
    fdrComputationM: number
    fdrComputationEffectiveEligibleM: number
    fdrComputationEffectiveM: number
    excludedFromFdrComputationM: number
    excludedMissingPValueTrials: number
    excludedNonPromotionGradePValueTrials: number
    excludedPromotionGradeMissingTrials: number
    fdrComputationSkippedReason: string | null
    harmonicRawM: number
    harmonicEffectiveM: number
    fdrMethodPrimary: 'BY_raw_m'
    fdrMethodSecondary: 'BY_effective_m'
    secondaryReports: {
      BH_secondary: {
        method: 'bh'
        candidateCount: number
      } | null
    }
    entries: Array<{
      policyId: string
      pValue: number | null
      diagnosticPValue: number | null
      eligibleForFdrComputation: boolean
      includedInFdrComputation: boolean
      fdrComputationExclusionReason: string | null
      pAdjustedBYRawM: number | null
      pAdjustedBYEffectiveM: number | null
      pAdjustedBHSecondary: number | null
      promotionAllowed: false
      reason: string
    }>
  }
  readinessGaps: {
    includedRawMTrials: number
    visibleFailedTrials: number
    visibleSurvivingTrials: number
    missingPValueTrials: number
    missingFdrReportTrials: number
    fdrInputsIncompleteTrials: number
    fdrReportPresentTrials: number
    fdrReportBlockedTrials: number
    missingFdrReportPathTrials: number
    pitAuditNotImplementedTrials: number
    pitProxyOnlyTrials: number
    missingPitAuditMetadataTrials: number
    fdrPValueAvailableTrials: number
    fdrPValueUnavailableTrials: number
    fdrPValueNonPromotionGradeTrials: number
    completeTrialUniverseMarkers: number
    invalidPValueTrials: number
    pValueUnavailableReasonCounts: Array<{ reason: string; count: number }>
    fdrBlockedReasonCounts: Array<{ reason: string; count: number }>
    topFailureCodes: Array<{ code: string; count: number }>
    blockerSummary: string[]
  }
  sourceDiagnostics: Array<{
    source: string
    path: string
    status: 'loaded' | 'missing' | 'invalid'
    recordsIn: number
    entriesEmitted: number
    notes: string[]
  }>
  entries: TrialLedgerEntry[]
  notes: string[]
}

export interface TrialSourceCoverageBucket {
  key: string
  entries: number
  includedRawMTrials: number
  includedEffectiveMTrials: number
  visibleFailedTrials: number
  visibleSurvivingTrials: number
  missingPValueTrials: number
  invalidPValueTrials: number
  missingFdrReportTrials: number
  fdrInputsIncompleteTrials: number
  fdrReportPresentTrials: number
  fdrReportBlockedTrials: number
  missingFdrReportPathTrials: number
  pitAuditNotImplementedTrials: number
  pitProxyOnlyTrials: number
  missingPitAuditMetadataTrials: number
  fdrPValueAvailableTrials: number
  fdrPValueUnavailableTrials: number
  fdrPValueNonPromotionGradeTrials: number
  completeTrialUniverseMarkers: number
  pValueUnavailableReasonCounts: Array<{ reason: string; count: number }>
  fdrBlockedReasonCounts: Array<{ reason: string; count: number }>
  topFailureCodes: Array<{ code: string; count: number }>
  primaryBlockers: string[]
}

export interface TrialSourceCoverageReport {
  schemaVersion: 1
  generatedAt: string
  diagnosticOnly: true
  promotionEligible: false
  status: 'blocked' | 'clear'
  sourceArtifact: 'trial_ledger'
  summary: TrialSourceCoverageBucket
  bySource: TrialSourceCoverageBucket[]
  byFamily: TrialSourceCoverageBucket[]
  bySourceFamily: TrialSourceCoverageBucket[]
  runtimeRegistryDiagnostics: RuntimeTrialRegistryDiagnostics
  sourceDiagnostics: TrialLedgerReport['sourceDiagnostics']
  nextPatchTargets: Array<{
    rank: number
    source: string
    familyId: string
    entries: number
    missingPValueTrials: number
    missingFdrReportTrials: number
    missingFdrReportPathTrials: number
    fdrInputsIncompleteTrials: number
    pitAuditNotImplementedTrials: number
    pitProxyOnlyTrials: number
    missingPitAuditMetadataTrials: number
    fdrPValueAvailableTrials: number
    fdrPValueUnavailableTrials: number
    fdrPValueNonPromotionGradeTrials: number
    topFailureCodes: Array<{ code: string; count: number }>
    primaryBlockers: string[]
    recommendedPatchPoint: string
    recommendedAction: string
  }>
  notes: string[]
}

export interface RuntimeTrialRegistryDiagnostics {
  source: 'runtime_trial_registry'
  diagnosticOnly: true
  promotionEligible: false
  entries: number
  includedRawMTrials: number
  quarantinedTestHarnessRows: number
  duplicateRerunGroups: number
  duplicateRerunRowsExcludedFromRawM: number
  rowsWithRegistryPValue: number
  rowsWithArtifactPValue: number
  rowsMissingPValueBecauseFdrArtifactMissing: number
  rowsWithExplanatoryOnlyPValue: number
  rowsWithMetadataFdrReportPath: number
  rowsWithArtifactLinkedFdrReport: number
  rowsWithBlockedPitAudit: number
  rowsWithDefaultFailClosedPitPromotionGrade: number
  metadataCoverage: {
    rowsWithFdrReportPath: number
    rowsMissingFdrReportPath: number
    rowsWithExistingFdrReportPath: number
    rowsWithMissingFdrReportFile: number
    rowsWithFdrReportStatus: number
    rowsMissingFdrReportStatus: number
    rowsWithPitAuditStatus: number
    rowsMissingPitAuditStatus: number
    rowsWithPitAuditPromotionGrade: number
    rowsWithPromotionGradePitAudit: number
  }
  pValueSourceCounts: Array<{ source: string; count: number }>
  fdrReportPathSourceCounts: Array<{ source: string; count: number }>
  pitAuditSourceCounts: Array<{ source: string; count: number }>
  pitAuditPromotionGradeSourceCounts: Array<{ source: string; count: number }>
  fdrReportPathStatusCounts: Array<{ status: string; count: number }>
  fdrReportStatusCounts: Array<{ status: string; count: number }>
  pitAuditStatusCounts: Array<{ status: string; count: number }>
  pitAuditPromotionGradeCounts: Array<{ status: string; count: number }>
  repairBuckets: Array<{
    bucket: string
    count: number
    action: string
  }>
  notes: string[]
}

export interface GateEffectivenessReport {
  schemaVersion: 1
  generatedAt: string
  policyId: string
  window: {
    lookbackHours: number | null
    earliestAcceptedCloseTs: string | null
    latestAcceptedCloseTs: string | null
    earliestSkippedCloseTs: string | null
    latestSkippedCloseTs: string | null
  }
  signals: number
  accepted: number
  skipped: number
  downSized: number
  acceptPnlPct: number
  skipCounterfactualPnlPct: number
  acceptVsSkipDeltaPct: number | null
  costAdjusted: {
    basis: 'pnlPct_minus_predictedRoundTripCostBps'
    costMissingPolicy: 'drop_diagnostic_only'
    acceptedClosedTrades: number
    skippedOpenSignals: number
    skippedClosedOutcomes: number
    skippedCurrentlyOpenSignals: number
    acceptedWithPredictedCost: number
    skippedWithPredictedCost: number
    acceptedMissingPredictedCost: number
    skippedClosedMissingPredictedCost: number
    skippedMissingPredictedCost: number
    skippedOpenWithPredictedCost: number
    skippedOpenMissingPredictedCost: number
    acceptedMissingPredictedCostAttribution: {
      diagnosticOnly: true
      rootCause: 'accepted_closed_predicted_open_evidence_missing' | 'none'
      uniqueMissingTrades: number
      duplicateProjectionNote: string
      byProducerGuardStatus: Record<GateCostCoverageProducerGuardStatus, number>
      topMissingFields: Array<{ field: PredictedOpenEvidenceField; missingTrades: number }>
      byLane: Array<{ lane: string; missingTrades: number }>
      sampleTradeIds: string[]
    }
    acceptNetPnlPct: number | null
    skipCounterfactualNetPnlPct: number | null
    acceptVsSkipNetDeltaPct: number | null
    diagnosticLegacyBackfill: {
      policy: 'diagnostic_only_not_promotion_evidence'
      source: 'legacy_lane_default_fee_slippage_mark_penalty'
      defaultRoundTripCostBps: number
      acceptedBackfilledTrades: number
      skippedBackfilledTrades: number
      acceptedDiagnosticNetPnlPct: number | null
      skipCounterfactualDiagnosticNetPnlPct: number | null
      acceptVsSkipDiagnosticNetDeltaPct: number | null
    }
  }
  fillAdjusted: {
    basis: 'fill_adjusted_cost_fields'
    minimumCoveragePct: 95
    acceptedTrades: number
    skippedTrades: number
    totalTrades: number
    acceptedWithFillAdjustedCost: number
    skippedWithFillAdjustedCost: number
    totalWithFillAdjustedCost: number
    acceptedFillAdjustedNetPnlPct: number | null
    skippedFillAdjustedNetPnlPct: number | null
    acceptVsSkipFillAdjustedDeltaPct: number | null
    coveragePct: number | null
    promotionEligible: false
    promotionBlocked: boolean
    blockedBy: string[]
  }
  costCoverageAttribution: {
    diagnosticOnly: true
    promotionEligible: false
    promotionBlocked: true
    basis: 'predicted_open_evidence_fields'
    contextEnforcementTs: string
    producerGuardEnforcementTs: string
    cohorts: GateCostCoverageCohortSummary[]
    topPatchTargets: GateCostCoveragePatchTarget[]
    actionableProducerGuardPatchTargets: GateCostCoveragePatchTarget[]
    legacyQuarantineTargets: GateCostCoveragePatchTarget[]
    producerGuardMissingPredictedCostTargets: GateCostCoveragePatchTarget[]
    producerGuardMissingCompletePredictedOpenEvidenceTargets: GateCostCoveragePatchTarget[]
    awaitingPostEnforcementClosedTrades: boolean
    notes: string[]
  }
  acceptStats: GroupStats
  skipStats: GroupStats
  skippedOutcomeStatsByRejectReason: Array<{
    reason: string
    count: number
    totalPnlPct: number
    avgPnlPct: number
  }>
  stratifiedDiagnostics: {
    promotionEligible: false
    minimumClosedPerSide: 30
    minimumIndependentBetsPerSide: 20
    dimensions: GateStratifiedDimension[]
    summary: {
      items: number
      useful: number
      neutral: number
      harmful: number
      insufficientData: number
      keepBlocked: number
      collectMoreData: number
      costCoverageRequired: number
      costCoverageRequiredByDimension: Record<GateStratifiedDimension, number>
      uniqueAcceptedMissingPredictedCostTrades: number
      uniqueSkippedClosedMissingPredictedCostTrades: number
      topHarmfulKeys: string[]
    }
    items: GateStratifiedDiagnostic[]
  }
  validityCounts: {
    valid: number
    partial: number
    invalid: number
  }
  shadowContextCoverage: {
    openSignals: number
    ok: number
    stale: number
    timeout: number
    newMissing: number
    legacyMissing: number
    coveragePct: number
    missingRequiredFields: Record<string, number>
    promotionEligible: false
    promotionBlocked: boolean
  }
  independenceUnit: 'symbol_day'
  independentBets: {
    accepted: number
    skipped: number
    total: number
    minimumForPromotion: 100
    diagnosticQuality: DiagnosticQuality
  }
  bootstrapBlockSensitivity: {
    method: 'stationary_block_sensitivity'
    resamplingUnit: 'symbol_day'
    comparisonDesign: 'unpaired_symbol_day'
    promotionEligible: false
    baseBlockSize: number | null
    blockSizeSet: number[]
    iterations: number
    results: Array<{
      blockSize: number
      acceptVsSkipDeltaMeanPct: number | null
      acceptVsSkipDeltaLowerBoundPct: number | null
      acceptVsSkipDeltaUpperBoundPct: number | null
      confidenceLevel: 0.9
      deltaPositiveShare: number | null
      directionStable: boolean
      lowerBoundPositive: boolean
      skippedReason: string | null
    }>
  }
  bootstrapDirectionStable: boolean
  diagnosticQuality: DiagnosticQuality
  topRejectReasons: Array<{ reason: string; count: number }>
  gateStatus: GateStatus
  gateStatusBasis: 'cost_adjusted_accept_vs_skip_net_delta' | 'gross_accept_vs_skip_delta' | 'insufficient_data'
  gateStatusDeltaPct: number | null
  notes: string[]
}

export interface GateCostCoverageCohortSummary {
  cohort: GateCostCoverageCohort
  records: number
  withPredictedCost: number
  missingPredictedCost: number
  predictedCostCoveragePct: number
  withCompletePredictedOpenEvidence: number
  missingCompletePredictedOpenEvidence: number
  completePredictedOpenEvidenceCoveragePct: number
  producerGuardMissingPredictedCost: number
  producerGuardMissingCompletePredictedOpenEvidence: number
  topMissingFields: Array<{ field: PredictedOpenEvidenceField; missingRecords: number }>
  byProducerGuardStatus: GateCostCoverageBucketSummary[]
  byLane: GateCostCoverageBucketSummary[]
  byLaneProducerGuardStatus: GateCostCoverageBucketSummary[]
}

export interface GateCostCoverageBucketSummary {
  key: string
  records: number
  withPredictedCost: number
  missingPredictedCost: number
  predictedCostCoveragePct: number
  withCompletePredictedOpenEvidence: number
  missingCompletePredictedOpenEvidence: number
  completePredictedOpenEvidenceCoveragePct: number
  producerGuardStatusCounts: Record<string, number>
  topMissingFields: Array<{ field: PredictedOpenEvidenceField; missingRecords: number }>
}

export interface GateCostCoveragePatchTarget {
  rank: number
  cohort: GateCostCoverageCohort
  lane: string
  producerGuardStatus: GateCostCoverageProducerGuardStatus
  records: number
  missingPredictedCost: number
  missingCompletePredictedOpenEvidence: number
  topMissingFields: Array<{ field: PredictedOpenEvidenceField; missingRecords: number }>
  recommendedPatchPoint: string
  recommendedAction: string
}

export interface GateStratifiedDiagnostic {
  dimension: GateStratifiedDimension
  key: string
  acceptedTrades: number
  skippedClosedOutcomes: number
  acceptedIndependentBets: number
  skippedIndependentBets: number
  acceptedPnlPct: number
  skippedCounterfactualPnlPct: number
  acceptVsSkipDeltaPct: number | null
  acceptedWithPredictedCost: number
  skippedWithPredictedCost: number
  acceptedMissingPredictedCost: number
  skippedMissingPredictedCost: number
  acceptNetPnlPct: number | null
  skipCounterfactualNetPnlPct: number | null
  acceptVsSkipNetDeltaPct: number | null
  diagnosticQuality: DiagnosticQuality
  gateStatus: GateStatus
  recommendedAction: GateStratifiedAction
  actionReason: string[]
  promotionEligible: false
}

export interface CostModelDiagnosticsReport {
  schemaVersion: 1
  generatedAt: string
  tradesWithCostPrediction: number
  tradesWithRealizedCost: number
  tradesWithPaperModelCostEvidence: number
  tradesWithExchangeReconciledCostEvidence: number
  pairedCostSamples: number
  missingCostPrediction: number
  missingRealizedCost: number
  tradesWithExpectedGrossEdge: number
  tradesWithExpectedNetEdge: number
  tradesWithExpectedEdgeSource: number
  tradesWithOpenTimeMarkMatchEvidence: number
  tradesWithCompletePredictedOpenEvidence: number
  completePredictedOpenEvidenceCoveragePct: number
  predictedCostSourceBreakdown: {
    closedTrades: number
    roundTripCostBpsAtOpen: number
    roundTripCostBps: number
    routeCostBpsAtOpen: number
    routeCostBps: number
    estimatedRoundTripCostPctAtOpen: number
    costEvidenceSourceCounts: Record<string, number>
    costEvidenceStatusCounts: Record<string, number>
    predictedOpenEvidenceStatusCounts: Record<string, number>
    predictedOpenEvidenceReasonCounts: Record<string, number>
  }
  realizedCostEvidenceIntegrity: {
    diagnosticOnly: true
    realizedFieldsPresent: number
    realizedFieldsPresentButPaperModelOnly: number
    realizedFieldsPresentWithoutExchangeSource: number
    exchangeReconciledSourceMissingRealizedFields: number
    paperModelOnlyIgnoredAsRealized: number
    sampleTrades: Array<{
      tradeId: string
      source: string
      lane: string
      symbol: string
      openTs: string
      closeTs: string
      reason: string
    }>
  }
  missingPredictedOpenEvidence: {
    totalMissingTrades: number
    topMissingFields: Array<{
      field: string
      missingTrades: number
      missingPct: number
    }>
    byLane: Array<{
      lane: string
      trades: number
      completePredictedOpenEvidence: number
      missingPredictedOpenEvidence: number
      coveragePct: number
      topMissingFields: Array<{
        field: string
        missingTrades: number
      }>
    }>
    sampleTradeIds: string[]
    sampleMissingTrades: Array<{
      tradeId: string
      source: string
      lane: string
      symbol: string
      openTs: string
      closeTs: string
      missingFields: PredictedOpenEvidenceField[]
      enforcementBucket: GateCostCoverageProducerGuardStatus
    }>
  }
  closedTradeEnforcementBuckets: Array<{
    bucket: GateCostCoverageProducerGuardStatus
    closedTrades: number
    completePredictedOpenEvidence: number
    missingPredictedOpenEvidence: number
    missingPredictedCost: number
    coveragePct: number
  }>
  predictedOpenEvidenceConsistency: {
    statusOkButFieldsMissing: number
    fieldsCompleteButStatusNotOk: number
    sampleTradeIds: string[]
  }
  newWindow: {
    cutoverTs: string
    enforcementTs: string
    producerGuardEnforcementTs: string
    producerGuardClosedTrades: number
    awaitingPostEnforcementClosedTrades: boolean
    status: 'ok' | 'missing' | 'insufficient_data'
    reason: 'complete_predicted_open_evidence' | 'awaiting_post_enforcement_closed_trades' | 'missing_predicted_open_evidence'
    closedTrades: number
    tradesWithCompletePredictedOpenEvidence: number
    tradesMissingCompletePredictedOpenEvidence: number
    transitionalDirtyMissingPredictedOpenEvidence: number
    producerGuardMissingPredictedOpenEvidence: number
    completePredictedOpenEvidenceCoveragePct: number
  }
  actionableProducerGuardPatchTargets: CostEvidenceTargetSummary
  legacyQuarantineTargets: CostEvidenceTargetSummary
  transitionalDirtyQuarantineTargets: CostEvidenceTargetSummary
  producerGuardMissingPredictedCostTargets: CostEvidenceTarget[]
  producerGuardMissingCompletePredictedOpenEvidenceTargets: CostEvidenceTarget[]
  openPositionReadiness: {
    status: 'ok' | 'blocked_legacy_dirty_opens' | 'blocked_new_missing_evidence' | 'insufficient_data'
    blockers: string[]
    totalOpenPositions: number
    legacyOpenPositions: number
    newOpenPositions: number
    producerGuardOpenPositions: number
    completePredictedOpenEvidence: number
    missingPredictedOpenEvidence: number
    legacyMissingPredictedOpenEvidence: number
    newMissingPredictedOpenEvidence: number
    transitionalDirtyMissingPredictedOpenEvidence: number
    producerGuardMissingPredictedOpenEvidence: number
    newMissingPredictedOpenEvidenceByField: Array<{
      field: PredictedOpenEvidenceField
      missingPositions: number
    }>
    completeV3Context: number
    missingV3Context: number
    futureCloseDirtyRisk: 'none' | 'legacy_will_close_dirty' | 'new_missing_context_or_cost'
    byAccount: Array<{
      accountId: string
      path: string
      openPositions: number
      legacyOpenPositions: number
      newOpenPositions: number
      producerGuardOpenPositions: number
      completePredictedOpenEvidence: number
      missingPredictedOpenEvidence: number
      legacyMissingPredictedOpenEvidence: number
      newMissingPredictedOpenEvidence: number
      transitionalDirtyMissingPredictedOpenEvidence: number
      producerGuardMissingPredictedOpenEvidence: number
      newMissingPredictedOpenEvidenceByField: Array<{
        field: PredictedOpenEvidenceField
        missingPositions: number
      }>
      completeV3Context: number
      missingV3Context: number
      samplePositions: Array<{
        positionId: string
        symbol: string
        side: 'long' | 'short' | 'unknown'
        lane: string
        entryTime: string | null
        missingPredictedOpenEvidenceFields: PredictedOpenEvidenceField[]
        v3ContextStatus: 'ok' | 'missing'
      }>
    }>
  }
  predictedCostBpsMean: number | null
  realizedCostBpsMean: number | null
  costPredictionErrorBpsMean: number | null
  costPredictionErrorBpsMAE: number | null
  markMatchPenalty: {
    formula: 'abs(matchPrice - markPrice) / markPrice * 10000'
    tradesWithPenalty: number
    meanPenaltyBps: number | null
    statusCounts: Record<string, number>
  }
  legacyDiagnosticCostBackfill: {
    status: 'inactive' | 'active' | 'not_needed'
    policy: 'diagnostic_only_not_promotion_evidence'
    promotionEvidenceAllowed: false
    source: 'legacy_lane_default_fee_slippage_mark_penalty'
    defaultRoundTripCostBps: number
    eligibleLegacyMissingCostTrades: number
    backfilledTrades: number
    excludedNewWindowMissingCostTrades: number
    diagnosticNetPnlPct: number | null
    diagnosticMeanNetPnlPct: number | null
  }
  routeCostShadowEligibility: RouteCostShadowEligibilityReport
  sampleThresholds: {
    minCostPredictionSamples: number
    minRealizedCostSamples: number
    minPairedCostSamples: number
    minExchangeReconciledCostSamples: number
  }
  quarantineDiagnostics: Array<{
    code: string
    actual: number
    required: number
    failClosed: true
    promotionEvidenceAllowed: false
    paperExecutionAllowed: false
  }>
  profitabilityClaimAllowed: false
  promotionClaimAllowed: false
  executionReplayClaimAllowed: false
  quarantine: boolean
  quarantineReasons: string[]
}

export interface CostEvidenceTarget {
  tradeId: string
  source: string
  lane: string
  symbol: string
  openTs: string
  closeTs: string
  missingFields: PredictedOpenEvidenceField[]
  enforcementBucket: GateCostCoverageProducerGuardStatus
}

export interface CostEvidenceTargetSummary {
  closedTrades: number
  missingPredictedCost: number
  missingCompletePredictedOpenEvidence: number
  sampleTrades: CostEvidenceTarget[]
}

export interface RouteCostShadowEligibilityReport {
  diagnosticOnly: true
  promotionEligible: false
  paperExecutionAllowed: false
  routeBudgetArtifactPath: string | null
  routeBudgetStatus: 'pass' | 'exceeded' | 'missing' | 'invalid'
  feeSnapshotStatus: 'runtime_verified' | 'manual_override' | 'missing' | 'stale_or_unverified'
  selectedRoute: RouteName
  selectedRouteSource: 'conservative_promotion_v2_default'
  routeSelectionMutationAllowed: false
  selectedRouteOverBudgetBps: number | null
  routes: Array<{
    route: RouteName
    totalExpectedCostBps: number
    maxAllowedCostBps: number
    breakEvenEdgeBps: number
    overBudgetBps: number
    eligibleForShadowEvaluation: boolean
    blockers: string[]
  }>
  tradeCoverage: {
    closedTrades: number
    tradesWithRouteCostBps: number
    tradesWithExpectedNetEdge: number
    expectedNetEdgeBeatsSelectedRouteBreakEven: number
  }
  tradeCoveragePct: {
    routeCostBps: number
    expectedNetEdge: number
    expectedNetEdgeBeatsSelectedRouteBreakEven: number
  }
  blockers: string[]
  notes: string[]
}

export interface MfeMaeTradeDiagnostic {
  tradeId: string
  lane: string
  symbol: string
  side: NormalizedPaperTrade['side']
  closeReason: string
  openTs: string
  closeTs: string
  pnlPct: number
  contextCoverageBucket: ContextCoverageBucket
  liquidityUsdAtOpen: number | null
  liquidityStatusAtOpen: string | null
  spreadStatusAtOpen: string | null
  spreadBpsAtOpen: number | null
  routeCostBpsAtOpen: number | null
  roundTripCostBpsAtOpen: number | null
  markMatchStatusAtOpen: string | null
  markMatchPenaltyBpsAtOpen: number | null
  regimeAtOpen: string | null
  pricePathTimeframe: PaperUniverseTimeframe | null
  pricePathFallbackUsed: boolean
  pricePathFallbackReason: 'preferred_missing_price_path' | 'preferred_price_path_mismatch' | null
  mfeBps: number | null
  maeBps: number | null
  timeToMfeSec: number | null
  timeToMaeSec: number | null
  timeToStopSec: number | null
  mfeBeforeStop: boolean | null
  pitStatus: 'safe_1s' | 'coarse_bar_ambiguous' | 'path_missing' | 'invalid'
  orderingStatus: 'known' | 'coarse_bar_unknown' | 'path_missing' | 'invalid'
  diagnosticStatus: 'ok' | 'missing_price_path' | 'price_path_mismatch' | 'invalid_trade_prices' | 'unknown_side'
}

export interface MfeMaeStoplossReport {
  schemaVersion: 1
  generatedAt: string
  metricBasis: 'price_path_bps'
  pathSemantics: {
    candleTimestampConvention: 'bar_open_assumed'
    intrabarOrderingKnownOnlyFor: '1s'
    coarseBarMfeBeforeStopReliable: false
  }
  coverage: {
    closedTrades: number
    stopLossTrades: number
    diagnosticsOk: number
    closedDiagnosticsOk: number
    stopLossDiagnosticsOk: number
    stopLossDiagnosticsOkPct: number
    stopLossMissingPricePath: number
    stopLossPricePathMismatch: number
    stopLossKnownOrdering: number
    stopLossCoarseOrdering: number
    missingPricePath: number
    pricePathMismatch: number
    invalidTradePrices: number
  }
  byCloseReason: Array<{
    closeReason: string
    count: number
    avgMfeBps: number | null
    avgMaeBps: number | null
    medianMfeBps: number | null
    medianMaeBps: number | null
  }>
  stopLossAttribution: {
    diagnosticUse: 'read_only_cluster_attribution'
    status: 'blocked_diagnostic_only' | 'clear_no_stoploss_cluster'
    promotionEligible: false
    policyMutationAllowed: false
    profitabilityClaimAllowed: false
    blockedBy: string[]
    blockerSummary: {
      missingRoundTripCostAtOpenCount: number
      missingMarkMatchStatusAtOpenCount: number
      legacyOrMissingContextCount: number
      coarseOrderingAmbiguousCount: number
    }
    byLane: MfeMaeStoplossBucketSummary[]
    bySymbol: MfeMaeStoplossBucketSummary[]
    bySide: MfeMaeStoplossBucketSummary[]
    byLaneSymbolSide: MfeMaeStoplossBucketSummary[]
    byRegime: MfeMaeStoplossBucketSummary[]
    byContextCoverageBucket: MfeMaeStoplossBucketSummary[]
    byLiquidityUsdBucket: MfeMaeStoplossBucketSummary[]
    byLiquidityStatus: MfeMaeStoplossBucketSummary[]
    bySpreadStatus: MfeMaeStoplossBucketSummary[]
    bySpreadBpsBucket: MfeMaeStoplossBucketSummary[]
    byRouteCostBpsBucket: MfeMaeStoplossBucketSummary[]
    byRoundTripCostBpsBucket: MfeMaeStoplossBucketSummary[]
    byMarkMatchStatus: MfeMaeStoplossBucketSummary[]
    byMarkMatchPenaltyBpsBucket: MfeMaeStoplossBucketSummary[]
    byMfeBpsBucket: MfeMaeStoplossBucketSummary[]
    byMaeBpsBucket: MfeMaeStoplossBucketSummary[]
    byMfeBeforeStop: MfeMaeStoplossBucketSummary[]
    byTimeToStopBucket: MfeMaeStoplossBucketSummary[]
  }
  stopLossSummary: {
    count: number
    avgMfeBps: number | null
    avgMaeBps: number | null
    medianMfeBps: number | null
    medianMaeBps: number | null
    mfeBeforeStopSharePct: number | null
  }
  diagnostics: MfeMaeTradeDiagnostic[]
  profitabilityClaimAllowed: false
  promotionClaimAllowed: false
  executionReplayClaimAllowed: false
  notes: string[]
}

export interface MfeMaeStoplossBucketSummary {
  dimension: string
  key: string
  count: number
  diagnosticsOk: number
  avgPnlPct: number | null
  totalPnlPct: number
  avgMfeBps: number | null
  avgMaeBps: number | null
  medianMfeBps: number | null
  medianMaeBps: number | null
  avgTimeToStopSec: number | null
  mfeBeforeStopSharePct: number | null
}

export interface CandidateKillCriteriaReport {
  schemaVersion: 1
  generatedAt: string
  candidates: Array<{
    policyId: string
    familyId: string
    state: 'research' | 'locked_oos' | 'prospective_shadow' | 'review_pack' | 'tiny_cap_manual' | 'production' | 'probation' | 'retired' | 'killed'
    killCriteria: string[]
    currentFlags: string[]
    promotionAllowed: boolean
  }>
}

export type StoplossRiskPolicyAction = 'allow' | 'downweight' | 'cooldown' | 'block' | 'shadow_only'
export type StoplossRiskSeverity = 'low' | 'medium' | 'high' | 'critical'

export interface StoplossRiskPolicyItem {
  dimension: 'lane' | 'symbol' | 'side' | 'lane_symbol_side'
  key: string
  lane: string | null
  symbol: string | null
  side: NormalizedPaperTrade['side'] | null
  stopLossTrades: number
  diagnosticsOk: number
  diagnosticsOkPct: number
  totalPnlPct: number
  avgPnlPct: number | null
  avgMfeBps: number | null
  avgMaeBps: number | null
  medianMaeBps: number | null
  avgTimeToStopSec: number | null
  safeOneSecondSharePct: number | null
  coarseBarSharePct: number | null
  severity: StoplossRiskSeverity
  recommendedAction: StoplossRiskPolicyAction
  actionReason: string[]
  requiredEvidenceBeforeRelaxation: string[]
  policyMutationAllowed: false
  promotionEligible: false
}

export interface StoplossFailClosedReviewQueueItem {
  rank: number
  dimension: StoplossRiskPolicyItem['dimension']
  key: string
  failClosedAction: Exclude<StoplossRiskPolicyAction, 'allow'>
  reportOnly: true
  policyMutationAllowed: false
  promotionEligible: false
  stopLossTrades: number
  diagnosticsOkPct: number
  totalPnlPct: number
  avgMaeBps: number | null
  avgTimeToStopSec: number | null
  actionReason: string[]
  missingEvidence: string[]
  representativeTrades: Array<{
    tradeId: string
    closeTs: string
    lane: string
    symbol: string
    side: NormalizedPaperTrade['side']
    pnlPct: number
    mfeBps: number | null
    maeBps: number | null
    timeToStopSec: number | null
    pricePathTimeframe: PaperUniverseTimeframe | null
    pitStatus: MfeMaeTradeDiagnostic['pitStatus']
    roundTripCostBpsAtOpen: number | null
    routeCostBpsAtOpen: number | null
  markMatchPenaltyBpsAtOpen: number | null
  markMatchStatusAtOpen: string | null
    pricePathFallbackUsed: boolean
    pricePathFallbackReason: MfeMaeTradeDiagnostic['pricePathFallbackReason']
    orderingStatus: MfeMaeTradeDiagnostic['orderingStatus']
    contextCoverageBucket: ContextCoverageBucket
  }>
  requiredEvidenceBeforeRelaxation: string[]
}

export interface StoplossRiskPolicyReport {
  schemaVersion: 1
  generatedAt: string
  policyVersion: 'p1_stoploss_risk_policy_v1'
  diagnosticOnly: true
  promotionEligible: false
  policyMutationAllowed: false
  source: {
    artifact: 'mfe_mae_stoploss_report'
    metricBasis: MfeMaeStoplossReport['metricBasis']
    closedTrades: number
    closedDiagnosticsOk: number
    stopLossTrades: number
    stopLossDiagnosticsOk: number
    stopLossDiagnosticsOkPct: number
    diagnosticsOk: number
  }
  thresholds: {
    productionForbiddenLeverage: 100
    blockStopLossTrades: 20
    reviewStopLossTrades: 5
    severeAvgMaeBps: -100
    elevatedAvgMaeBps: -25
    materialLossPct: -1
  }
  status: 'clear' | 'blocked'
  summary: {
    reviewedItems: number
    allow: number
    downweight: number
    cooldown: number
    block: number
    shadowOnly: number
    highestSeverity: StoplossRiskSeverity | null
    promotionBlocked: boolean
    promotionBlockedBy: string[]
    totalPromotionBlockers: number
    promotionBlockedByTruncated: boolean
  }
  failClosedReviewQueue: StoplossFailClosedReviewQueueItem[]
  recommendations: StoplossRiskPolicyItem[]
  profitabilityClaimAllowed: false
  promotionClaimAllowed: false
  executionReplayClaimAllowed: false
  notes: string[]
}

export interface P1TradingEvidenceIndex {
  schemaVersion: 1
  generatedAt: string
  outputDir: string
  artifacts: Record<string, string>
  manifestPaths: Record<string, string>
  childArtifactAudit: {
    overallAuditStatus: 'clear' | 'blocked_by_child_artifacts'
    tradingBehaviorChanged: false
    promotionAllowed: false
    paperExecutionAllowed: false
    costModelDiagnostics: {
      quarantine: boolean
      quarantineReasons: string[]
      openPositionReadinessStatus: CostModelDiagnosticsReport['openPositionReadiness']['status']
      openPositionBlockers: string[]
    }
    trialLedger: {
      status: TrialLedgerReport['status']
      fdrGateStatus: TrialLedgerReport['fdrGateStatus']
      blockerSummary: string[]
    }
    trialSourceCoverage: {
      status: TrialSourceCoverageReport['status']
      topPatchTargets: number
    }
    gateEffectiveness: {
      gateStatus: GateStatus
      costAdjustedDiagnosticQuality: DiagnosticQuality
      costCoveragePatchTargets: number
      producerGuardMissingCostTargets: number
      producerGuardMissingCompletePredictedOpenEvidence: number
    }
    mfeMaeStoploss: {
      attributionStatus: MfeMaeStoplossReport['stopLossAttribution']['status']
      profitabilityClaimAllowed: false
    }
    stoplossRiskPolicy: {
      status: StoplossRiskPolicyReport['status']
      promotionBlocked: boolean
      totalPromotionBlockers: number
    }
  }
  notes: string[]
}

interface Candle {
  timestamp: number
  datetime: string
  open: number
  high: number
  low: number
  close: number
}

const DEFAULT_CONTEXT_CUTOVER_TS = '2026-05-02T00:00:00.000Z'
const DEFAULT_CONTEXT_ENFORCEMENT_TS = '2026-05-02T06:30:00.000Z'
const COST_MODEL_SAMPLE_THRESHOLDS: CostModelDiagnosticsReport['sampleThresholds'] = {
  minCostPredictionSamples: 30,
  minRealizedCostSamples: 30,
  minPairedCostSamples: 30,
  minExchangeReconciledCostSamples: 30,
}

const DEFAULT_ARGS: P1TradingEvidenceArgs = {
  paperDir: 'data/paper_trading',
  dataDir: 'data/market/live_5m',
  oneSecondDataDir: 'data/market/live_1s',
  oneHourDataDir: 'data/market/live_accumulated',
  shadowLedgerPath: DEFAULT_PAPER_POLICY_SHADOW_LEDGER_PATH,
  outputDir: 'data/runtime/p1_trading_evidence',
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
}

export function parseP1TradingEvidenceArgs(argv: string[]): P1TradingEvidenceArgs {
  const raw = parseRawArgs(argv)
  return {
    paperDir: raw.get('paperDir') ?? DEFAULT_ARGS.paperDir,
    dataDir: raw.get('dataDir') ?? DEFAULT_ARGS.dataDir,
    oneSecondDataDir: raw.get('oneSecondDataDir') ?? DEFAULT_ARGS.oneSecondDataDir,
    oneHourDataDir: raw.get('oneHourDataDir') ?? DEFAULT_ARGS.oneHourDataDir,
    shadowLedgerPath: raw.get('shadowLedgerPath') ?? DEFAULT_ARGS.shadowLedgerPath,
    outputDir: raw.get('outputDir') ?? DEFAULT_ARGS.outputDir,
    candidateRegistryPath: raw.get('candidateRegistryPath') ?? DEFAULT_ARGS.candidateRegistryPath,
    graveyardPath: raw.get('graveyardPath') ?? DEFAULT_ARGS.graveyardPath,
    bestConfigPath: raw.get('bestConfigPath') ?? DEFAULT_ARGS.bestConfigPath,
    trialRegistryPath: raw.get('trialRegistryPath') ?? DEFAULT_ARGS.trialRegistryPath,
    evidenceOutputRoot: raw.get('evidenceOutputRoot') ?? DEFAULT_ARGS.evidenceOutputRoot,
    optimizationDir: raw.get('optimizationDir') ?? DEFAULT_ARGS.optimizationDir,
    validationDir: raw.get('validationDir') ?? DEFAULT_ARGS.validationDir,
    routeCostBudgetPath: raw.get('routeCostBudgetPath') ?? DEFAULT_ARGS.routeCostBudgetPath,
    timeframe: parseTimeframe(raw.get('timeframe') ?? DEFAULT_ARGS.timeframe),
    lookbackHours: parseNullablePositiveNumber(raw.get('lookbackHours')),
    json: parseBool(raw.get('json'), DEFAULT_ARGS.json),
  }
}

export async function buildP1TradingEvidence(
  args: P1TradingEvidenceArgs,
): Promise<P1TradingEvidenceIndex> {
  const startedAt = new Date()
  const paperDir = resolve(args.paperDir)
  const dataDir = resolve(args.dataDir)
  const oneSecondDataDir = resolve(args.oneSecondDataDir)
  const oneHourDataDir = resolve(args.oneHourDataDir)
  const shadowLedgerPath = resolve(args.shadowLedgerPath)
  const outputDir = resolve(args.outputDir)
  const routeCostBudgetPath = resolve(args.routeCostBudgetPath)
  const visibleTrialSources = loadVisibleTrialLedgerSources({
    candidateRegistryPath: resolve(args.candidateRegistryPath),
    graveyardPath: resolve(args.graveyardPath),
    bestConfigPath: resolve(args.bestConfigPath),
    trialRegistryPath: resolve(args.trialRegistryPath),
    evidenceOutputRoot: resolve(args.evidenceOutputRoot),
    optimizationDir: resolve(args.optimizationDir),
    validationDir: resolve(args.validationDir),
  })
  const loaded = await loadClosedTrades(paperDir, args.lookbackHours)
  const acceptedTrades = loaded.closedTrades
  const ledgerEntries = readPaperPolicyShadowLedger(shadowLedgerPath)
  const alphaRegistry = buildAlphaHypothesisRegistry()
  const gateEffectiveness = buildGateEffectivenessReport({
    acceptedTrades,
    ledgerEntries,
    lookbackHours: args.lookbackHours,
  })
  const costDiagnostics = await buildCostModelDiagnosticsWithOpenPositionReadiness({
    trades: acceptedTrades,
    paperDir,
    routeCostBudgetPath,
  })
  const mfeMaeReport = await buildMfeMaeStoplossReport({
    trades: acceptedTrades,
    dataDir,
    dataDirs: {
      [args.timeframe]: dataDir,
      '1s': oneSecondDataDir,
      '1h': oneHourDataDir,
    },
    timeframe: args.timeframe,
  })
  const trialLedger = buildTrialLedgerReport({
    acceptedTrades,
    gateEffectiveness,
    alphaRegistry,
    visibleTrialSources,
  })
  const trialSourceCoverage = buildTrialSourceCoverageReport({
    trialLedger,
  })
  const killCriteria = buildCandidateKillCriteriaReport({
    acceptedTrades,
    gateEffectiveness,
    costDiagnostics,
    mfeMaeReport,
    alphaRegistry,
  })
  const stoplossRiskPolicy = buildStoplossRiskPolicyReport({
    mfeMaeReport,
  })

  const artifacts = {
    alphaHypothesisRegistry: join(outputDir, 'alpha_hypothesis_registry.latest.json'),
    trialLedger: join(outputDir, 'trial_ledger.latest.json'),
    trialSourceCoverage: join(outputDir, 'trial_source_coverage.latest.json'),
    gateEffectiveness: join(outputDir, 'gate_effectiveness_report.latest.json'),
    costModelDiagnostics: join(outputDir, 'cost_model_diagnostics.latest.json'),
    mfeMaeStoploss: join(outputDir, 'mfe_mae_stoploss_report.latest.json'),
    stoplossRiskPolicy: join(outputDir, 'stoploss_risk_policy.latest.json'),
    candidateKillCriteria: join(outputDir, 'candidate_kill_criteria.latest.json'),
  }

  const manifestPaths: Record<string, string> = {}
  await mkdir(outputDir, { recursive: true })
  for (const [key, path] of Object.entries(artifacts)) {
    const value = {
      alphaHypothesisRegistry: alphaRegistry,
      trialLedger,
      trialSourceCoverage,
      gateEffectiveness,
      costModelDiagnostics: costDiagnostics,
      mfeMaeStoploss: mfeMaeReport,
      stoplossRiskPolicy,
      candidateKillCriteria: killCriteria,
    }[key]
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
    const manifest = await writeEvidenceManifestForArtifact({
      job: `p1_trading_evidence_${key}`,
      artifactPath: path,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: p1ArtifactBusinessStatus(key, value),
      recordsIn: acceptedTrades.length + ledgerEntries.length,
      recordsOut: p1ArtifactRecordsOut(key, value),
      errorClass: p1ArtifactErrorClass(key, value),
    })
    manifestPaths[key] = manifest.manifestPath
  }

  const index: P1TradingEvidenceIndex = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    outputDir,
    artifacts,
    manifestPaths,
    childArtifactAudit: buildP1ChildArtifactAudit({
      costDiagnostics,
      trialLedger,
      trialSourceCoverage,
      gateEffectiveness,
      mfeMaeReport,
      stoplossRiskPolicy,
    }),
    notes: [
      'P1 evidence is diagnostic-only and read-only; it must not auto-promote or auto-trade.',
      'Gate effectiveness compares accepted closed trades against trade-level shadow outcomes only, not portfolio-level counterfactual PnL.',
      'Trial source coverage pinpoints missing p-value/FDR/PIT provenance by source and family without changing promotion gates.',
      'MFE/MAE uses available local OHLC price path and marks rows missing when path data is unavailable.',
      'Coarse OHLC bars are path diagnostics only; intrabar ordering is not promotion-grade evidence.',
    ],
  }
  const indexPath = join(outputDir, 'p1_trading_evidence.index.latest.json')
  index.artifacts.index = indexPath
  index.manifestPaths.index = `${resolve(indexPath)}.manifest.json`
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8')
  await writeEvidenceManifestForArtifact({
    job: 'p1_trading_evidence_index',
    artifactPath: indexPath,
    manifestPath: index.manifestPaths.index,
    startedAt,
    finishedAt: new Date(),
    exitCode: 0,
    businessStatus: 'pass',
    recordsIn: acceptedTrades.length + ledgerEntries.length,
    recordsOut: Object.keys(artifacts).length,
  })

  return index
}

function buildP1ChildArtifactAudit(input: {
  costDiagnostics: CostModelDiagnosticsReport
  trialLedger: TrialLedgerReport
  trialSourceCoverage: TrialSourceCoverageReport
  gateEffectiveness: GateEffectivenessReport
  mfeMaeReport: MfeMaeStoplossReport
  stoplossRiskPolicy: StoplossRiskPolicyReport
}): P1TradingEvidenceIndex['childArtifactAudit'] {
  const blocked =
    input.costDiagnostics.quarantine ||
    input.costDiagnostics.openPositionReadiness.status !== 'ok' ||
    input.trialLedger.status !== 'valid' ||
    input.trialLedger.fdrGateStatus !== 'ready_explanatory_only' ||
    input.trialSourceCoverage.status !== 'clear' ||
    input.gateEffectiveness.gateStatus !== 'useful' ||
    input.gateEffectiveness.costAdjusted.acceptVsSkipNetDeltaPct == null ||
    input.mfeMaeReport.stopLossAttribution.status === 'blocked_diagnostic_only' ||
    input.stoplossRiskPolicy.status !== 'clear' ||
    input.stoplossRiskPolicy.summary.promotionBlocked

  return {
    overallAuditStatus: blocked ? 'blocked_by_child_artifacts' : 'clear',
    tradingBehaviorChanged: false,
    promotionAllowed: false,
    paperExecutionAllowed: false,
    costModelDiagnostics: {
      quarantine: input.costDiagnostics.quarantine,
      quarantineReasons: input.costDiagnostics.quarantineReasons,
      openPositionReadinessStatus: input.costDiagnostics.openPositionReadiness.status,
      openPositionBlockers: input.costDiagnostics.openPositionReadiness.blockers,
    },
    trialLedger: {
      status: input.trialLedger.status,
      fdrGateStatus: input.trialLedger.fdrGateStatus,
      blockerSummary: input.trialLedger.readinessGaps.blockerSummary,
    },
    trialSourceCoverage: {
      status: input.trialSourceCoverage.status,
      topPatchTargets: input.trialSourceCoverage.nextPatchTargets.length,
    },
    gateEffectiveness: {
      gateStatus: input.gateEffectiveness.gateStatus,
      costAdjustedDiagnosticQuality: input.gateEffectiveness.diagnosticQuality,
      costCoveragePatchTargets: input.gateEffectiveness.costCoverageAttribution.topPatchTargets.length,
      producerGuardMissingCostTargets: input.gateEffectiveness.costCoverageAttribution.topPatchTargets
        .filter(target => target.producerGuardStatus === 'producer_guard_enforced' && target.missingPredictedCost > 0)
        .length,
      producerGuardMissingCompletePredictedOpenEvidence: input.gateEffectiveness.costCoverageAttribution.cohorts
        .reduce((sum, cohort) => sum + cohort.producerGuardMissingCompletePredictedOpenEvidence, 0),
    },
    mfeMaeStoploss: {
      attributionStatus: input.mfeMaeReport.stopLossAttribution.status,
      profitabilityClaimAllowed: false,
    },
    stoplossRiskPolicy: {
      status: input.stoplossRiskPolicy.status,
      promotionBlocked: input.stoplossRiskPolicy.summary.promotionBlocked,
      totalPromotionBlockers: input.stoplossRiskPolicy.summary.totalPromotionBlockers,
    },
  }
}

export function buildAlphaHypothesisRegistry(generatedAt = new Date().toISOString()): AlphaHypothesisRegistry {
  return {
    schemaVersion: 1,
    generatedAt,
    registryStatus: 'active',
    entries: [
      {
        policyId: 'volume_breakout_clean_v1',
        familyId: 'volume_breakout',
        alphaHypothesis: 'Abnormal volume plus clean range expansion can imply short-horizon continuation when urgent liquidity demand overwhelms passive supply.',
        marketInefficiency: 'Temporary order-flow imbalance after range expansion.',
        whoPays: 'Late breakout chasers, forced shorts, and liquidity takers that enter after the initial imbalance.',
        expectedHoldingHorizon: '5m-2h',
        expectedFailureRegime: ['chop', 'wide_spread', 'thin_liquidity', 'news_fakeout', 'single_bar_volume_spike_without_close_followthrough'],
        requiredObservables: ['volumeRatio', 'rangeBreakoutPct', 'breakQuality', 'closeDirectionAgreement', 'spreadBps', 'liquidityUsd', 'routeCostBps'],
        falsificationRule: {
          condition: 'Post-filter accepted group fails to outperform skipped shadow group after cost over two non-overlapping prospective windows.',
          action: 'kill_candidate',
        },
        promotionBlockedBy: ['missing_gate_effectiveness', 'missing_shadow_outcomes', 'dirty_evidence_quarantine'],
      },
      {
        policyId: 'microstructure_impulse_v1',
        familyId: 'microstructure',
        alphaHypothesis: 'Short-horizon impulse can continue when local order-flow imbalance is strong enough to overcome spread, queue miss, and adverse selection cost.',
        marketInefficiency: 'Very short-lived order-flow imbalance and liquidity vacuum.',
        whoPays: 'Urgent takers, stop cascades, and participants forced to cross the spread during liquidity gaps.',
        expectedHoldingHorizon: '1s-10m',
        expectedFailureRegime: ['stale_price', 'wide_spread', 'toxic_flow', 'thin_book', 'latency_spike', 'post_news_whipsaw'],
        requiredObservables: ['ofi', 'obi', 'vpin', 'spreadBps', 'bookDepthUsd', 'markMatchPenaltyBps', 'latencyMs', 'routeCostBps'],
        falsificationRule: {
          condition: 'Accepted impulse trades show worse fill-adjusted return or higher tail loss than skipped shadow group in two prospective windows.',
          action: 'kill_candidate',
        },
        promotionBlockedBy: ['100x_production_forbidden', 'missing_microstructure_context', 'missing_fill_adjusted_outcomes'],
      },
      {
        policyId: 'cross_sectional_post_cost_v1',
        familyId: 'cross_sectional',
        alphaHypothesis: 'Relative strength or reversal ranks can earn only when rank spread remains positive after turnover, slippage, and rebalance cost.',
        marketInefficiency: 'Slow cross-asset repricing under crypto beta and liquidity segmentation.',
        whoPays: 'Crowded laggards, stale index-flow reallocators, and overreactive short-horizon flow.',
        expectedHoldingHorizon: '4h-7d',
        expectedFailureRegime: ['high_common_beta', 'fee_drag', 'over_turnover', 'single_symbol_concentration', 'funding_shock'],
        requiredObservables: ['rankIC', 'topBottomSpread', 'turnover', 'routeCostBps', 'slippageBps', 'singleSymbolContribution', 'cryptoBetaExposure'],
        falsificationRule: {
          condition: 'Top-ranked candidates do not beat no-trade and equal-weight benchmarks after cost over four rebalance cycles.',
          action: 'keep_shadow_only',
        },
        promotionBlockedBy: ['missing_post_cost_score', 'missing_trial_ledger', 'missing_live_sync_cost_diagnostics'],
      },
    ],
  }
}

export function buildGateEffectivenessReport(input: {
  acceptedTrades: NormalizedPaperTrade[]
  ledgerEntries: PaperPolicyShadowLedgerEntry[]
  lookbackHours: number | null
  generatedAt?: string
}): GateEffectivenessReport {
  const acceptedTrades = input.acceptedTrades
  const shadowClosed = input.ledgerEntries
    .filter((entry): entry is PaperPolicyShadowOutcome => entry.eventType === 'closed')
  const shadowOpenById = new Map<string, ParsedPaperPolicyShadowOpen>()
  for (const entry of input.ledgerEntries) {
    if (entry.eventType === 'open') shadowOpenById.set(entry.shadowId, entry)
  }
  const validShadowClosed = shadowClosed.filter(outcome =>
    classifyShadowOutcomeValidityStatus(outcome, shadowOpenById.get(outcome.shadowId)) === 'valid',
  )
  const skippedTrades = validShadowClosed.map(outcome =>
    outcomeToNormalizedTrade(outcome, shadowOpenById.get(outcome.shadowId)),
  )
  const acceptStats = computeStats('accepted', acceptedTrades)
  const skipStats = computeStats('skipped_shadow', skippedTrades)
  const acceptVsSkipDeltaPct = acceptedTrades.length > 0 && skippedTrades.length > 0
    ? acceptStats.avgPnlPct - skipStats.avgPnlPct
    : null
  const costAdjusted = buildGateCostAdjustedSummary(
    acceptedTrades,
    skippedTrades,
    [...shadowOpenById.values()],
  )
  const fillAdjusted = buildGateFillAdjustedSummary(acceptedTrades, skippedTrades)
  const costCoverageAttribution = buildGateCostCoverageAttribution(
    acceptedTrades,
    skippedTrades,
    [...shadowOpenById.values()],
  )
  const awaitingPostEnforcementClosedTrades = acceptedTrades.every(trade =>
    classifyGateCostCoverageProducerGuardStatus(trade.openTs) !== 'producer_guard_enforced',
  )
  const shadowContextCoverage = summarizeShadowContextCoverage([...shadowOpenById.values()])
  const topRejectReasons = countRejectReasons([...shadowOpenById.values()])
  const validityCounts = classifyShadowOutcomeValidity(shadowClosed, shadowOpenById)
  const acceptedIndependentBets = countIndependentBets(acceptedTrades)
  const skippedIndependentBets = countIndependentBets(skippedTrades)
  const independentBetQuality = acceptedIndependentBets + skippedIndependentBets === 0
    ? 'no_data'
    : acceptedIndependentBets < 100 || skippedIndependentBets < 100
      ? 'low_sample'
      : 'ok'
  const diagnosticQuality = acceptedTrades.length + skippedTrades.length === 0
    ? 'no_data'
    : acceptedTrades.length < 30 || skippedTrades.length < 30 || independentBetQuality !== 'ok'
      ? 'low_sample'
      : 'ok'
  const bootstrapBlockSensitivity = buildBootstrapBlockSensitivity(acceptedTrades, skippedTrades)
  const stratifiedDiagnostics = buildGateStratifiedDiagnostics(acceptedTrades, skippedTrades)
  const gateStatusBasis = costAdjusted.acceptVsSkipNetDeltaPct != null
    ? 'cost_adjusted_accept_vs_skip_net_delta'
    : 'insufficient_data'
  const primaryGateDeltaPct = costAdjusted.acceptVsSkipNetDeltaPct
  const gateStatus = diagnosticQuality !== 'ok'
    ? 'insufficient_data'
    : primaryGateDeltaPct == null
      ? 'insufficient_data'
      : primaryGateDeltaPct > 0
        ? 'useful'
        : primaryGateDeltaPct < 0
          ? 'harmful'
          : 'neutral'

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    policyId: 'p1_rule_gate_vs_trade_level_shadow',
    window: {
      lookbackHours: input.lookbackHours,
      earliestAcceptedCloseTs: minIso(acceptedTrades.map(trade => trade.closeTs)),
      latestAcceptedCloseTs: maxIso(acceptedTrades.map(trade => trade.closeTs)),
      earliestSkippedCloseTs: minIso(skippedTrades.map(trade => trade.closeTs)),
      latestSkippedCloseTs: maxIso(skippedTrades.map(trade => trade.closeTs)),
    },
    signals: acceptedTrades.length + shadowOpenById.size,
    accepted: acceptedTrades.length,
    skipped: shadowOpenById.size,
    downSized: 0,
    acceptPnlPct: acceptStats.totalPnlPct,
    skipCounterfactualPnlPct: skipStats.totalPnlPct,
    acceptVsSkipDeltaPct,
    costAdjusted,
    fillAdjusted,
    costCoverageAttribution,
    acceptStats,
    skipStats,
    skippedOutcomeStatsByRejectReason: buildSkippedStatsByRejectReason(validShadowClosed, shadowOpenById),
    stratifiedDiagnostics,
    validityCounts,
    shadowContextCoverage,
    independenceUnit: 'symbol_day',
    independentBets: {
      accepted: acceptedIndependentBets,
      skipped: skippedIndependentBets,
      total: acceptedIndependentBets + skippedIndependentBets,
      minimumForPromotion: 100,
      diagnosticQuality: independentBetQuality,
    },
    bootstrapBlockSensitivity,
    bootstrapDirectionStable: bootstrapBlockSensitivity.results.length > 0
      && bootstrapBlockSensitivity.results.every(result => result.directionStable && result.lowerBoundPositive),
    diagnosticQuality,
    topRejectReasons,
    gateStatus,
    gateStatusBasis: diagnosticQuality === 'ok' ? gateStatusBasis : 'insufficient_data',
    gateStatusDeltaPct: diagnosticQuality === 'ok' ? primaryGateDeltaPct : null,
    notes: [
      'counterfactualType=trade_level_shadow; no portfolio-level capital reallocation is modeled.',
      'Promotion requires accept group to beat skipped shadow group after cost in prospective windows, not this retrospective diagnostic alone.',
      'Bootstrap sensitivity is unpaired by symbol-day and promotionEligible=false until paired prospective cohorts and cost coverage are available.',
      'Shadow context coverage validates v3 decision-time fields; missing context blocks promotion and remains diagnostic-only.',
      awaitingPostEnforcementClosedTrades
        ? 'No accepted closed trades opened after predicted-open producer guard enforcement yet; current accepted closed cost gaps are not producer patch targets.'
        : 'Accepted closed trades include post-producer-guard samples; producer_guard_enforced gaps are actionable patch targets.',
    ],
  }
}

function buildGateCostAdjustedSummary(
  acceptedTrades: NormalizedPaperTrade[],
  skippedTrades: NormalizedPaperTrade[],
  skippedOpenSignals: ParsedPaperPolicyShadowOpen[],
): GateEffectivenessReport['costAdjusted'] {
  const accepted = acceptedTrades.flatMap(costAdjustedPnlPct)
  const skipped = skippedTrades.flatMap(costAdjustedPnlPct)
  const acceptedDiagnostic = acceptedTrades.map(diagnosticCostAdjustedPnlPct)
  const skippedDiagnostic = skippedTrades.map(diagnosticCostAdjustedPnlPct)
  const skippedOpenWithPredictedCost = skippedOpenSignals
    .map(shadowOpenPredictedCostBps)
    .filter((value): value is number => value != null)
  const acceptAvg = accepted.length > 0 ? mean(accepted) : null
  const skipAvg = skipped.length > 0 ? mean(skipped) : null
  const acceptedBackfilledTrades = acceptedTrades.filter(trade => predictedCostBps(trade) == null).length
  const skippedBackfilledTrades = skippedTrades.filter(trade => predictedCostBps(trade) == null).length
  const diagnosticAcceptAvg = acceptedDiagnostic.length > 0 ? mean(acceptedDiagnostic) : null
  const diagnosticSkipAvg = skippedDiagnostic.length > 0 ? mean(skippedDiagnostic) : null
  return {
    basis: 'pnlPct_minus_predictedRoundTripCostBps',
    costMissingPolicy: 'drop_diagnostic_only',
    acceptedClosedTrades: acceptedTrades.length,
    skippedOpenSignals: skippedOpenSignals.length,
    skippedClosedOutcomes: skippedTrades.length,
    skippedCurrentlyOpenSignals: Math.max(0, skippedOpenSignals.length - skippedTrades.length),
    acceptedWithPredictedCost: accepted.length,
    skippedWithPredictedCost: skipped.length,
    acceptedMissingPredictedCost: acceptedTrades.length - accepted.length,
    skippedClosedMissingPredictedCost: skippedTrades.length - skipped.length,
    skippedMissingPredictedCost: skippedTrades.length - skipped.length,
    skippedOpenWithPredictedCost: skippedOpenWithPredictedCost.length,
    skippedOpenMissingPredictedCost: skippedOpenSignals.length - skippedOpenWithPredictedCost.length,
    acceptedMissingPredictedCostAttribution: buildAcceptedMissingPredictedCostAttribution(acceptedTrades),
    acceptNetPnlPct: accepted.length > 0 ? sum(accepted) : null,
    skipCounterfactualNetPnlPct: skipped.length > 0 ? sum(skipped) : null,
    acceptVsSkipNetDeltaPct: acceptAvg != null && skipAvg != null ? acceptAvg - skipAvg : null,
    diagnosticLegacyBackfill: {
      policy: 'diagnostic_only_not_promotion_evidence',
      source: 'legacy_lane_default_fee_slippage_mark_penalty',
      defaultRoundTripCostBps: DEFAULT_LEGACY_DIAGNOSTIC_ROUND_TRIP_COST_BPS,
      acceptedBackfilledTrades,
      skippedBackfilledTrades,
      acceptedDiagnosticNetPnlPct: acceptedDiagnostic.length > 0 ? roundFinite(sum(acceptedDiagnostic)) : null,
      skipCounterfactualDiagnosticNetPnlPct: skippedDiagnostic.length > 0 ? roundFinite(sum(skippedDiagnostic)) : null,
      acceptVsSkipDiagnosticNetDeltaPct: diagnosticAcceptAvg != null && diagnosticSkipAvg != null
        ? roundFinite(diagnosticAcceptAvg - diagnosticSkipAvg)
        : null,
    },
  }
}

function buildAcceptedMissingPredictedCostAttribution(
  acceptedTrades: NormalizedPaperTrade[],
): GateEffectivenessReport['costAdjusted']['acceptedMissingPredictedCostAttribution'] {
  const missing = acceptedTrades
    .map(trade => ({ trade, missingFields: missingPredictedOpenEvidenceFields(trade) }))
    .filter(row => predictedCostBps(row.trade) == null)
  const byProducerGuardStatus = {
    legacy_pre_context_enforcement: 0,
    transitional_dirty_open: 0,
    producer_guard_enforced: 0,
    unknown_time: 0,
  } satisfies Record<GateCostCoverageProducerGuardStatus, number>
  for (const row of missing) {
    byProducerGuardStatus[classifyGateCostCoverageProducerGuardStatus(row.trade.openTs)] += 1
  }
  const topMissingFields = Object.entries(countStrings(missing.flatMap(row => row.missingFields)))
    .map(([field, missingTrades]) => ({
      field: field as PredictedOpenEvidenceField,
      missingTrades,
    }))
    .sort((left, right) => right.missingTrades - left.missingTrades || left.field.localeCompare(right.field))
    .slice(0, 8)
  const byLane = [...groupBy(missing, row => row.trade.lane).entries()]
    .map(([lane, rows]) => ({ lane, missingTrades: rows.length }))
    .sort((left, right) => right.missingTrades - left.missingTrades || left.lane.localeCompare(right.lane))
    .slice(0, 20)
  return {
    diagnosticOnly: true,
    rootCause: missing.length > 0 ? 'accepted_closed_predicted_open_evidence_missing' : 'none',
    uniqueMissingTrades: missing.length,
    duplicateProjectionNote: 'stratifiedDiagnostics costCoverageRequired counts dimension buckets, not unique missing trades',
    byProducerGuardStatus,
    topMissingFields,
    byLane,
    sampleTradeIds: missing.slice(0, 20).map(row => row.trade.tradeId),
  }
}

function costAdjustedPnlPct(trade: NormalizedPaperTrade): number[] {
  const costBps = predictedCostBps(trade)
  if (costBps == null) return []
  return [trade.pnlPct - costBps / 100]
}

function buildGateFillAdjustedSummary(
  acceptedTrades: NormalizedPaperTrade[],
  skippedTrades: NormalizedPaperTrade[],
): GateEffectivenessReport['fillAdjusted'] {
  const accepted = acceptedTrades.flatMap(fillAdjustedPnlPct)
  const skipped = skippedTrades.flatMap(fillAdjustedPnlPct)
  const totalTrades = acceptedTrades.length + skippedTrades.length
  const totalWithFillAdjustedCost = accepted.length + skipped.length
  const acceptedAvg = accepted.length > 0 ? mean(accepted) : null
  const skippedAvg = skipped.length > 0 ? mean(skipped) : null
  const coveragePct = totalTrades > 0 ? totalWithFillAdjustedCost / totalTrades * 100 : null
  const blockedBy = [
    ...(coveragePct != null && coveragePct >= 95 ? [] : [`fill_adjusted_coverage_below_minimum:${coveragePct ?? 'missing'}<95`]),
    ...(accepted.length > 0 ? [] : ['accepted_fill_adjusted_outcomes_missing']),
    ...(skipped.length > 0 ? [] : ['skipped_fill_adjusted_outcomes_missing']),
    ...(acceptedAvg != null && skippedAvg != null ? [] : ['fill_adjusted_accept_vs_skip_unavailable']),
  ]
  return {
    basis: 'fill_adjusted_cost_fields',
    minimumCoveragePct: 95,
    acceptedTrades: acceptedTrades.length,
    skippedTrades: skippedTrades.length,
    totalTrades,
    acceptedWithFillAdjustedCost: accepted.length,
    skippedWithFillAdjustedCost: skipped.length,
    totalWithFillAdjustedCost,
    acceptedFillAdjustedNetPnlPct: accepted.length > 0 ? roundFinite(sum(accepted)) : null,
    skippedFillAdjustedNetPnlPct: skipped.length > 0 ? roundFinite(sum(skipped)) : null,
    acceptVsSkipFillAdjustedDeltaPct: acceptedAvg != null && skippedAvg != null ? roundFinite(acceptedAvg - skippedAvg) : null,
    coveragePct,
    promotionEligible: false,
    promotionBlocked: blockedBy.length > 0,
    blockedBy,
  }
}

function fillAdjustedPnlPct(trade: NormalizedPaperTrade): number[] {
  const costBps = fillAdjustedCostBps(trade)
  if (costBps == null) return []
  return [trade.pnlPct - costBps / 100]
}

function fillAdjustedCostBps(trade: NormalizedPaperTrade): number | null {
  if (trade.fillAdjustedCostBps != null && trade.fillAdjustedCostBps >= 0) return trade.fillAdjustedCostBps
  if (trade.fillAdjustedCostPct != null && trade.fillAdjustedCostPct >= 0) return trade.fillAdjustedCostPct * 100
  return null
}

function buildGateCostCoverageAttribution(
  acceptedTrades: NormalizedPaperTrade[],
  skippedTrades: NormalizedPaperTrade[],
  skippedOpenSignals: ParsedPaperPolicyShadowOpen[],
): GateEffectivenessReport['costCoverageAttribution'] {
  const rows: GateCostCoverageRow[] = [
    ...acceptedTrades.map(trade => tradeCostCoverageRow('accepted_closed', trade)),
    ...skippedTrades.map(trade => tradeCostCoverageRow('skipped_closed_shadow', trade)),
    ...skippedOpenSignals.map(open => shadowOpenCostCoverageRow(open)),
  ]
  const cohorts = (['accepted_closed', 'skipped_closed_shadow', 'skipped_open_shadow'] as GateCostCoverageCohort[])
    .map(cohort => summarizeGateCostCoverageCohort(cohort, rows.filter(row => row.cohort === cohort)))
  const topPatchTargets = buildGateCostCoveragePatchTargets(rows)
  return {
    diagnosticOnly: true,
    promotionEligible: false,
    promotionBlocked: true,
    basis: 'predicted_open_evidence_fields',
    contextEnforcementTs: normalizedContextEnforcementTs(),
    producerGuardEnforcementTs: normalizedPredictedOpenEvidenceEnforcementTs(),
    cohorts,
    topPatchTargets,
    actionableProducerGuardPatchTargets: topPatchTargets.filter(target =>
      target.producerGuardStatus === 'producer_guard_enforced',
    ),
    legacyQuarantineTargets: topPatchTargets.filter(target =>
      target.producerGuardStatus !== 'producer_guard_enforced',
    ),
    producerGuardMissingPredictedCostTargets: topPatchTargets.filter(target =>
      target.producerGuardStatus === 'producer_guard_enforced' && target.missingPredictedCost > 0,
    ),
    producerGuardMissingCompletePredictedOpenEvidenceTargets: topPatchTargets.filter(target =>
      target.producerGuardStatus === 'producer_guard_enforced' && target.missingCompletePredictedOpenEvidence > 0,
    ),
    awaitingPostEnforcementClosedTrades: rows.every(row =>
      row.cohort !== 'accepted_closed' || row.producerGuardStatus !== 'producer_guard_enforced',
    ),
    notes: [
      'This attribution explains why cost-adjusted accept-vs-skip is blocked; it never backfills missing costs as promotion evidence.',
      'producer_guard_enforced rows are current-producer repair targets; legacy_pre_context_enforcement and transitional_dirty_open rows remain quarantine evidence.',
      'Complete predicted-open evidence requires predicted cost, gross/net edge, edge source, match price/source, and mark-match penalty/status.',
    ],
  }
}

interface GateCostCoverageRow {
  cohort: GateCostCoverageCohort
  lane: string
  producerGuardStatus: GateCostCoverageProducerGuardStatus
  predictedCostPresent: boolean
  completePredictedOpenEvidence: boolean
  missingFields: PredictedOpenEvidenceField[]
}

function tradeCostCoverageRow(
  cohort: GateCostCoverageCohort,
  trade: NormalizedPaperTrade,
): GateCostCoverageRow {
  const missingFields = missingPredictedOpenEvidenceFields(trade)
  return {
    cohort,
    lane: trade.lane,
    producerGuardStatus: classifyGateCostCoverageProducerGuardStatus(trade.openTs),
    predictedCostPresent: predictedCostBps(trade) != null,
    completePredictedOpenEvidence: missingFields.length === 0,
    missingFields,
  }
}

function shadowOpenCostCoverageRow(open: ParsedPaperPolicyShadowOpen): GateCostCoverageRow {
  const missingFields = missingPredictedOpenEvidenceFields(shadowOpenToCostCoverageTrade(open))
  return {
    cohort: 'skipped_open_shadow',
    lane: open.lane,
    producerGuardStatus: classifyGateCostCoverageProducerGuardStatus(open.openTs),
    predictedCostPresent: shadowOpenPredictedCostBps(open) != null,
    completePredictedOpenEvidence: missingFields.length === 0,
    missingFields,
  }
}

function shadowOpenToCostCoverageTrade(open: ParsedPaperPolicyShadowOpen): NormalizedPaperTrade {
  const cost = open.cost
  return {
    tradeId: open.shadowId,
    source: 'paper_policy_shadow_ledger_open',
    lane: open.lane,
    accountId: null,
    accountLabel: null,
    symbol: open.symbol,
    side: open.side,
    leverage: null,
    openTs: open.openTs,
    closeTs: open.openTs,
    openPrice: open.entryPrice,
    closePrice: null,
    pnlPct: 0,
    pnlUsd: null,
    closeReason: 'shadow_open_cost_coverage',
    rawReason: null,
    holdingSeconds: null,
    closeHourUtc: null,
    priceSource: 'shadow_ledger',
    priceStale: null,
    volumeRatioAtOpen: null,
    breakQualityAtOpen: null,
    liquidityUsdAtOpen: null,
    liquidityStatusAtOpen: null,
    spreadStatusAtOpen: null,
    spreadBpsAtOpen: null,
    rankAtOpen: null,
    rankSpreadPctAtOpen: null,
    estimatedRoundTripCostPctAtOpen: numberOrNull(cost.estimatedRoundTripCostPctAtOpen ?? cost.estimatedRoundTripCostPct),
    estimatedRoundTripCostPctOfMarginAtOpen: numberOrNull(cost.estimatedRoundTripCostPctOfMarginAtOpen),
    expectedGrossEdgePctAtOpen: numberOrNull(cost.expectedGrossEdgePctAtOpen),
    expectedNetEdgePctAtOpen: numberOrNull(cost.expectedNetEdgePctAtOpen),
    expectedEdgeSourceAtOpen: stringOrNull(cost.expectedEdgeSourceAtOpen),
    routeCostBpsAtOpen: numberOrNull(cost.routeCostBpsAtOpen ?? cost.routeCostBps),
    roundTripCostBpsAtOpen: numberOrNull(cost.roundTripCostBpsAtOpen ?? cost.roundTripCostBps),
    markPriceAtOpen: numberOrNull(cost.markPriceAtOpen),
    markPriceTimestampAtOpen: stringOrNull(cost.markPriceTimestampAtOpen),
    matchPriceAtOpen: numberOrNull(cost.matchPriceAtOpen),
    matchPriceSourceAtOpen: stringOrNull(cost.matchPriceSourceAtOpen),
    markMatchPenaltyBpsAtOpen: numberOrNull(cost.markMatchPenaltyBpsAtOpen),
    markMatchStatusAtOpen: stringOrNull(cost.markMatchStatusAtOpen),
    realizedRoundTripCostBps: null,
    realizedCostBps: null,
    fillAdjustedCostBps: null,
    fillAdjustedCostPct: null,
    costEvidenceSource: null,
    costEvidenceStatus: null,
    predictedOpenEvidenceStatus: null,
    predictedOpenEvidenceReason: null,
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
    contextGenerationAtOpen: null,
    flashConfidenceLowAtOpen: null,
    ruleScoreAtOpen: null,
    proEpochAtOpen: null,
    marketIntelTriggerAtOpen: null,
    regimeAtOpen: null,
    contextCoverageBucket: 'new_missing',
    liquidated: false,
  }
}

function summarizeGateCostCoverageCohort(
  cohort: GateCostCoverageCohort,
  rows: GateCostCoverageRow[],
): GateCostCoverageCohortSummary {
  return {
    cohort,
    ...summarizeGateCostCoverageRows(rows),
    producerGuardMissingPredictedCost: rows.filter(row =>
      row.producerGuardStatus === 'producer_guard_enforced' && !row.predictedCostPresent
    ).length,
    producerGuardMissingCompletePredictedOpenEvidence: rows.filter(row =>
      row.producerGuardStatus === 'producer_guard_enforced' && !row.completePredictedOpenEvidence
    ).length,
    topMissingFields: summarizeGateCostCoverageMissingFields(rows).slice(0, 8),
    byProducerGuardStatus: summarizeGateCostCoverageBuckets(rows, row => row.producerGuardStatus),
    byLane: summarizeGateCostCoverageBuckets(rows, row => row.lane),
    byLaneProducerGuardStatus: summarizeGateCostCoverageBuckets(rows, row => `${row.lane}|${row.producerGuardStatus}`),
  }
}

function summarizeGateCostCoverageBuckets(
  rows: GateCostCoverageRow[],
  keyFn: (row: GateCostCoverageRow) => string,
): GateCostCoverageBucketSummary[] {
  return [...groupBy(rows, keyFn).entries()]
    .map(([key, bucketRows]) => ({
      key,
      ...summarizeGateCostCoverageRows(bucketRows),
      producerGuardStatusCounts: countStrings(bucketRows.map(row => row.producerGuardStatus)),
      topMissingFields: summarizeGateCostCoverageMissingFields(bucketRows).slice(0, 5),
    }))
    .filter(item => item.records > 0)
    .sort((left, right) =>
      right.missingCompletePredictedOpenEvidence - left.missingCompletePredictedOpenEvidence ||
      right.missingPredictedCost - left.missingPredictedCost ||
      right.records - left.records ||
      left.key.localeCompare(right.key),
    )
    .slice(0, 30)
}

function summarizeGateCostCoverageRows(rows: GateCostCoverageRow[]): Omit<
  GateCostCoverageBucketSummary,
  'key' | 'producerGuardStatusCounts' | 'topMissingFields'
> {
  const withPredictedCost = rows.filter(row => row.predictedCostPresent).length
  const withCompletePredictedOpenEvidence = rows.filter(row => row.completePredictedOpenEvidence).length
  return {
    records: rows.length,
    withPredictedCost,
    missingPredictedCost: rows.length - withPredictedCost,
    predictedCostCoveragePct: rows.length > 0 ? withPredictedCost / rows.length * 100 : 0,
    withCompletePredictedOpenEvidence,
    missingCompletePredictedOpenEvidence: rows.length - withCompletePredictedOpenEvidence,
    completePredictedOpenEvidenceCoveragePct: rows.length > 0 ? withCompletePredictedOpenEvidence / rows.length * 100 : 0,
  }
}

function summarizeGateCostCoverageMissingFields(
  rows: GateCostCoverageRow[],
): Array<{ field: PredictedOpenEvidenceField; missingRecords: number }> {
  return Object.entries(countStrings(rows.flatMap(row => row.missingFields)))
    .map(([field, missingRecords]) => ({
      field: field as PredictedOpenEvidenceField,
      missingRecords,
    }))
    .sort((left, right) => right.missingRecords - left.missingRecords || left.field.localeCompare(right.field))
}

function buildGateCostCoveragePatchTargets(
  rows: GateCostCoverageRow[],
): GateCostCoveragePatchTarget[] {
  return [...groupBy(rows.filter(row => !row.completePredictedOpenEvidence), row =>
    `${row.cohort}|${row.lane}|${row.producerGuardStatus}`,
  ).entries()]
    .map(([key, bucketRows]) => {
      const [cohort, lane, producerGuardStatus] = key.split('|') as [
        GateCostCoverageCohort,
        string,
        GateCostCoverageProducerGuardStatus,
      ]
      return {
        rank: 0,
        cohort,
        lane,
        producerGuardStatus,
        records: bucketRows.length,
        missingPredictedCost: bucketRows.filter(row => !row.predictedCostPresent).length,
        missingCompletePredictedOpenEvidence: bucketRows.length,
        topMissingFields: summarizeGateCostCoverageMissingFields(bucketRows).slice(0, 5),
        recommendedPatchPoint: recommendedGateCostCoveragePatchPoint(cohort, producerGuardStatus, lane),
        recommendedAction: recommendedGateCostCoverageAction(cohort, producerGuardStatus),
      }
    })
    .sort((left, right) =>
      gateCostCoverageProducerGuardPriority(right.producerGuardStatus) - gateCostCoverageProducerGuardPriority(left.producerGuardStatus) ||
      right.missingPredictedCost - left.missingPredictedCost ||
      right.missingCompletePredictedOpenEvidence - left.missingCompletePredictedOpenEvidence ||
      right.records - left.records ||
      `${left.cohort}:${left.lane}:${left.producerGuardStatus}`.localeCompare(`${right.cohort}:${right.lane}:${right.producerGuardStatus}`),
    )
    .slice(0, 15)
    .map((item, index) => ({ ...item, rank: index + 1 }))
}

function classifyGateCostCoverageProducerGuardStatus(openTs: string | null): GateCostCoverageProducerGuardStatus {
  if (!openTs || !Number.isFinite(Date.parse(openTs))) return 'unknown_time'
  if (isAfterPredictedOpenEvidenceEnforcement(openTs)) return 'producer_guard_enforced'
  const contextEnforcementMs = Date.parse(normalizedContextEnforcementTs())
  const openMs = Date.parse(openTs)
  return Number.isFinite(contextEnforcementMs) && openMs >= contextEnforcementMs
    ? 'transitional_dirty_open'
    : 'legacy_pre_context_enforcement'
}

function gateCostCoverageProducerGuardPriority(status: GateCostCoverageProducerGuardStatus): number {
  return {
    legacy_pre_context_enforcement: 0,
    transitional_dirty_open: 1,
    unknown_time: 2,
    producer_guard_enforced: 3,
  }[status]
}

function recommendedGateCostCoveragePatchPoint(
  cohort: GateCostCoverageCohort,
  producerGuardStatus: GateCostCoverageProducerGuardStatus,
  lane: string,
): string {
  if (producerGuardStatus !== 'producer_guard_enforced') {
    return 'historical evidence quarantine: do not mutate historical ledgers; wait for dirty opens to close into explicit quarantine evidence'
  }
  if (cohort === 'accepted_closed') {
    if (lane.includes('cross_sectional')) return 'scripts/paper_trade_cross_sectional.ts open/close result writer'
    if (lane.includes('volume_breakout')) return 'scripts/paper_trade_volume_breakout.ts open/close result writer'
    if (lane.includes('microstructure')) return 'scripts/paper_trade_microstructure_stress.ts open/close result writer'
    return 'paper trade result writer for accepted closed trades'
  }
  return 'src/runtime/paper_policy_shadow_ledger.ts and shadow open writer cost/context payload'
}

function recommendedGateCostCoverageAction(
  cohort: GateCostCoverageCohort,
  producerGuardStatus: GateCostCoverageProducerGuardStatus,
): string {
  if (producerGuardStatus !== 'producer_guard_enforced') {
    return 'quarantine_only; preserve missing historical evidence and exclude from promotion-grade cost-adjusted gate conclusions'
  }
  if (cohort === 'accepted_closed') {
    return 'patch current accepted-trade producer so every new open carries complete predicted-open evidence before it can be counted in gate effectiveness'
  }
  return 'patch current shadow-open producer so every new skipped signal carries complete predicted-open evidence before it can be used for accept-vs-skip promotion evidence'
}

const DEFAULT_LEGACY_DIAGNOSTIC_ROUND_TRIP_COST_BPS = 43

function diagnosticCostAdjustedPnlPct(trade: NormalizedPaperTrade): number {
  return trade.pnlPct - diagnosticCostBps(trade) / 100
}

function diagnosticCostBps(trade: NormalizedPaperTrade): number {
  return predictedCostBps(trade) ?? DEFAULT_LEGACY_DIAGNOSTIC_ROUND_TRIP_COST_BPS
}

function buildGateStratifiedDiagnostics(
  acceptedTrades: NormalizedPaperTrade[],
  skippedTrades: NormalizedPaperTrade[],
): GateEffectivenessReport['stratifiedDiagnostics'] {
  const dimensions: GateStratifiedDimension[] = ['lane', 'symbol', 'side', 'lane_symbol_side']
  const items = dimensions.flatMap(dimension =>
    buildGateStratifiedDiagnosticsForDimension(dimension, acceptedTrades, skippedTrades),
  ).sort(compareGateStratifiedDiagnostics)
  const summary = summarizeGateStratifiedDiagnostics(items)
  return {
    promotionEligible: false,
    minimumClosedPerSide: 30,
    minimumIndependentBetsPerSide: 20,
    dimensions,
    summary,
    items,
  }
}

function buildGateStratifiedDiagnosticsForDimension(
  dimension: GateStratifiedDimension,
  acceptedTrades: NormalizedPaperTrade[],
  skippedTrades: NormalizedPaperTrade[],
): GateStratifiedDiagnostic[] {
  const acceptedByKey = groupTradesByGateDimension(acceptedTrades, dimension)
  const skippedByKey = groupTradesByGateDimension(skippedTrades, dimension)
  const keys = [...new Set([...acceptedByKey.keys(), ...skippedByKey.keys()])].sort()
  return keys.map(key =>
    buildGateStratifiedDiagnostic(
      dimension,
      key,
      acceptedByKey.get(key) ?? [],
      skippedByKey.get(key) ?? [],
    ),
  ).filter(item =>
    item.acceptedTrades > 0 ||
    item.skippedClosedOutcomes > 0,
  )
}

function buildGateStratifiedDiagnostic(
  dimension: GateStratifiedDimension,
  key: string,
  acceptedTrades: NormalizedPaperTrade[],
  skippedTrades: NormalizedPaperTrade[],
): GateStratifiedDiagnostic {
  const acceptedCostAdjusted = acceptedTrades.flatMap(costAdjustedPnlPct)
  const skippedCostAdjusted = skippedTrades.flatMap(costAdjustedPnlPct)
  const acceptedIndependentBets = countIndependentBets(acceptedTrades)
  const skippedIndependentBets = countIndependentBets(skippedTrades)
  const acceptPnl = sum(acceptedTrades.map(trade => trade.pnlPct))
  const skipPnl = sum(skippedTrades.map(trade => trade.pnlPct))
  const acceptVsSkipDeltaPct = acceptedTrades.length > 0 && skippedTrades.length > 0
    ? mean(acceptedTrades.map(trade => trade.pnlPct)) - mean(skippedTrades.map(trade => trade.pnlPct))
    : null
  const acceptNetPnlPct = acceptedCostAdjusted.length > 0 ? sum(acceptedCostAdjusted) : null
  const skipCounterfactualNetPnlPct = skippedCostAdjusted.length > 0 ? sum(skippedCostAdjusted) : null
  const acceptVsSkipNetDeltaPct = acceptedCostAdjusted.length > 0 && skippedCostAdjusted.length > 0
    ? mean(acceptedCostAdjusted) - mean(skippedCostAdjusted)
    : null
  const diagnosticQuality: DiagnosticQuality = acceptedTrades.length + skippedTrades.length === 0
    ? 'no_data'
    : acceptedTrades.length < 30 ||
      skippedTrades.length < 30 ||
      acceptedIndependentBets < 20 ||
      skippedIndependentBets < 20
      ? 'low_sample'
      : 'ok'
  const acceptedMissingPredictedCost = acceptedTrades.length - acceptedCostAdjusted.length
  const skippedMissingPredictedCost = skippedTrades.length - skippedCostAdjusted.length
  const gateStatus: GateStatus = diagnosticQuality !== 'ok'
    ? 'insufficient_data'
    : acceptVsSkipNetDeltaPct == null
      ? 'insufficient_data'
      : acceptVsSkipNetDeltaPct > 0
        ? 'useful'
        : acceptVsSkipNetDeltaPct < 0
          ? 'harmful'
          : 'neutral'
  const action = classifyGateStratifiedAction({
    gateStatus,
    diagnosticQuality,
    acceptedMissingPredictedCost,
    skippedMissingPredictedCost,
    acceptedTrades: acceptedTrades.length,
    skippedTrades: skippedTrades.length,
    acceptVsSkipNetDeltaPct,
  })
  return {
    dimension,
    key,
    acceptedTrades: acceptedTrades.length,
    skippedClosedOutcomes: skippedTrades.length,
    acceptedIndependentBets,
    skippedIndependentBets,
    acceptedPnlPct: acceptPnl,
    skippedCounterfactualPnlPct: skipPnl,
    acceptVsSkipDeltaPct,
    acceptedWithPredictedCost: acceptedCostAdjusted.length,
    skippedWithPredictedCost: skippedCostAdjusted.length,
    acceptedMissingPredictedCost,
    skippedMissingPredictedCost,
    acceptNetPnlPct,
    skipCounterfactualNetPnlPct,
    acceptVsSkipNetDeltaPct,
    diagnosticQuality,
    gateStatus,
    recommendedAction: action.recommendedAction,
    actionReason: action.actionReason,
    promotionEligible: false,
  }
}

function classifyGateStratifiedAction(input: {
  gateStatus: GateStatus
  diagnosticQuality: DiagnosticQuality
  acceptedMissingPredictedCost: number
  skippedMissingPredictedCost: number
  acceptedTrades: number
  skippedTrades: number
  acceptVsSkipNetDeltaPct: number | null
}): { recommendedAction: GateStratifiedAction; actionReason: string[] } {
  const actionReason: string[] = []
  if (input.acceptedTrades === 0) actionReason.push('accepted_group_missing')
  if (input.skippedTrades === 0) actionReason.push('skipped_group_missing')
  if (input.acceptedMissingPredictedCost > 0) actionReason.push(`accepted_predicted_cost_missing:${input.acceptedMissingPredictedCost}`)
  if (input.skippedMissingPredictedCost > 0) actionReason.push(`skipped_predicted_cost_missing:${input.skippedMissingPredictedCost}`)
  if (input.diagnosticQuality !== 'ok') actionReason.push(`diagnostic_quality:${input.diagnosticQuality}`)
  if (input.acceptVsSkipNetDeltaPct != null) actionReason.push(`accept_vs_skip_net_delta_pct:${roundFinite(input.acceptVsSkipNetDeltaPct)}`)

  if (input.acceptedMissingPredictedCost > 0 || input.skippedMissingPredictedCost > 0) {
    return { recommendedAction: 'cost_coverage_required', actionReason }
  }
  if (input.diagnosticQuality !== 'ok') {
    return { recommendedAction: 'collect_more_data', actionReason }
  }
  if (input.gateStatus === 'harmful') return { recommendedAction: 'keep_blocked', actionReason }
  if (input.gateStatus === 'useful') return { recommendedAction: 'candidate_review_only', actionReason }
  return { recommendedAction: 'neutral_review', actionReason }
}

function groupTradesByGateDimension(
  trades: NormalizedPaperTrade[],
  dimension: GateStratifiedDimension,
): Map<string, NormalizedPaperTrade[]> {
  const groups = new Map<string, NormalizedPaperTrade[]>()
  for (const trade of trades) {
    const key = gateDimensionKey(trade, dimension)
    groups.set(key, [...(groups.get(key) ?? []), trade])
  }
  return groups
}

function gateDimensionKey(trade: NormalizedPaperTrade, dimension: GateStratifiedDimension): string {
  if (dimension === 'lane') return trade.lane
  if (dimension === 'symbol') return trade.symbol
  if (dimension === 'side') return trade.side
  return `${trade.lane}|${trade.symbol}|${trade.side}`
}

function summarizeGateStratifiedDiagnostics(
  items: GateStratifiedDiagnostic[],
): GateEffectivenessReport['stratifiedDiagnostics']['summary'] {
  const summary = {
    items: items.length,
    useful: 0,
    neutral: 0,
    harmful: 0,
    insufficientData: 0,
    keepBlocked: 0,
    collectMoreData: 0,
    costCoverageRequired: 0,
    costCoverageRequiredByDimension: {
      lane: 0,
      symbol: 0,
      side: 0,
      lane_symbol_side: 0,
    } satisfies Record<GateStratifiedDimension, number>,
    uniqueAcceptedMissingPredictedCostTrades: 0,
    uniqueSkippedClosedMissingPredictedCostTrades: 0,
    topHarmfulKeys: [] as string[],
  }
  for (const item of items) {
    if (item.gateStatus === 'useful') summary.useful += 1
    if (item.gateStatus === 'neutral') summary.neutral += 1
    if (item.gateStatus === 'harmful') summary.harmful += 1
    if (item.gateStatus === 'insufficient_data') summary.insufficientData += 1
    if (item.recommendedAction === 'keep_blocked') summary.keepBlocked += 1
    if (item.recommendedAction === 'collect_more_data') summary.collectMoreData += 1
    if (item.recommendedAction === 'cost_coverage_required') {
      summary.costCoverageRequired += 1
      summary.costCoverageRequiredByDimension[item.dimension] += 1
    }
  }
  const laneItems = items.filter(item => item.dimension === 'lane')
  summary.uniqueAcceptedMissingPredictedCostTrades = sum(laneItems.map(item => item.acceptedMissingPredictedCost))
  summary.uniqueSkippedClosedMissingPredictedCostTrades = sum(laneItems.map(item => item.skippedMissingPredictedCost))
  summary.topHarmfulKeys = items
    .filter(item => item.gateStatus === 'harmful' || item.recommendedAction === 'keep_blocked')
    .sort(compareGateStratifiedDiagnostics)
    .slice(0, 10)
    .map(item => `${item.dimension}:${item.key}`)
  return summary
}

function compareGateStratifiedDiagnostics(left: GateStratifiedDiagnostic, right: GateStratifiedDiagnostic): number {
  return actionPriority(right.recommendedAction) - actionPriority(left.recommendedAction) ||
    (left.acceptVsSkipNetDeltaPct ?? left.acceptVsSkipDeltaPct ?? 0) - (right.acceptVsSkipNetDeltaPct ?? right.acceptVsSkipDeltaPct ?? 0) ||
    (right.acceptedTrades + right.skippedClosedOutcomes) - (left.acceptedTrades + left.skippedClosedOutcomes) ||
    `${left.dimension}:${left.key}`.localeCompare(`${right.dimension}:${right.key}`)
}

function actionPriority(action: GateStratifiedAction): number {
  return {
    candidate_review_only: 0,
    neutral_review: 1,
    collect_more_data: 2,
    cost_coverage_required: 3,
    keep_blocked: 4,
  }[action]
}

export function buildCostModelDiagnostics(
  trades: NormalizedPaperTrade[],
  generatedAt = new Date().toISOString(),
  routeCostBudgetPath: string | null = null,
): CostModelDiagnosticsReport {
  const predicted = trades
    .map(predictedCostBps)
    .filter((value): value is number => value != null)
  const realized = trades
    .map(trade => realizedCostBps(trade))
    .filter((value): value is number => value != null)
  const evidenceSources = trades.map(costEvidenceSource)
  const paperModelCostEvidence = evidenceSources.filter(source => source === 'paper_cost_model_at_open')
  const exchangeReconciledCostEvidence = evidenceSources.filter(source => source === 'exchange_reconciled_fill')
  const paired = trades.flatMap(trade => {
    const predictedCost = predictedCostBps(trade)
    const realizedCost = realizedCostBps(trade)
    return predictedCost == null || realizedCost == null ? [] : [{ predictedCost, realizedCost }]
  })
  const errors = paired.map(item => item.realizedCost - item.predictedCost)
  const penalties = trades.flatMap(markMatchPenaltyBps)
  const statusCounts = countStrings(trades.map(markMatchStatus))
  const tradesWithExpectedGrossEdge = trades.filter(trade => trade.expectedGrossEdgePctAtOpen != null).length
  const tradesWithExpectedNetEdge = trades.filter(trade => trade.expectedNetEdgePctAtOpen != null).length
  const tradesWithExpectedEdgeSource = trades.filter(trade => trade.expectedEdgeSourceAtOpen != null).length
  const tradesWithOpenTimeMarkMatchEvidence = trades.filter(hasOpenTimeMarkMatchEvidence).length
  const tradesWithCompletePredictedOpenEvidence = trades.filter(hasCompletePredictedOpenEvidence).length
  const missingPredictedOpenEvidence = summarizeMissingPredictedOpenEvidence(trades)
  const predictedCostSourceBreakdown = buildPredictedCostSourceBreakdown(trades)
  const realizedCostEvidenceIntegrity = buildRealizedCostEvidenceIntegrity(trades)
  const closedTradeEnforcementBuckets = buildClosedTradeEnforcementBuckets(trades)
  const predictedOpenEvidenceConsistency = buildPredictedOpenEvidenceConsistency(trades)
  const newWindow = summarizeCostEvidenceNewWindow(trades)
  const costEvidenceTargets = buildCostEvidenceTargets(trades)
  const actionableProducerGuardPatchTargets = summarizeCostEvidenceTargets(
    costEvidenceTargets.filter(row => row.enforcementBucket === 'producer_guard_enforced'),
  )
  const legacyQuarantineTargets = summarizeCostEvidenceTargets(
    costEvidenceTargets.filter(row => row.enforcementBucket === 'legacy_pre_context_enforcement'),
  )
  const transitionalDirtyQuarantineTargets = summarizeCostEvidenceTargets(
    costEvidenceTargets.filter(row => row.enforcementBucket === 'transitional_dirty_open'),
  )
  const producerGuardMissingPredictedCostTargets = costEvidenceTargets.filter(row =>
    row.enforcementBucket === 'producer_guard_enforced' && row.missingFields.includes('predicted_cost_bps'),
  )
  const producerGuardMissingCompletePredictedOpenEvidenceTargets = costEvidenceTargets.filter(row =>
    row.enforcementBucket === 'producer_guard_enforced',
  )
  const legacyDiagnosticCostBackfill = summarizeLegacyDiagnosticCostBackfill(trades)
  const quarantineReasons: string[] = []
  const bias = errors.length > 0 ? mean(errors) : null
  if (bias != null && bias > 5) quarantineReasons.push(`cost_model_underestimates_realized_cost_by_${bias.toFixed(2)}bps`)
  if (predicted.length < COST_MODEL_SAMPLE_THRESHOLDS.minCostPredictionSamples) quarantineReasons.push('low_cost_prediction_sample')
  if (realized.length < COST_MODEL_SAMPLE_THRESHOLDS.minRealizedCostSamples) quarantineReasons.push('missing_realized_cost_sample')
  if (paired.length < COST_MODEL_SAMPLE_THRESHOLDS.minPairedCostSamples) quarantineReasons.push('low_paired_cost_sample')
  if (exchangeReconciledCostEvidence.length < COST_MODEL_SAMPLE_THRESHOLDS.minExchangeReconciledCostSamples) quarantineReasons.push('low_exchange_reconciled_cost_sample')
  const quarantineDiagnostics = buildCostQuarantineDiagnostics({
    predicted: predicted.length,
    realized: realized.length,
    paired: paired.length,
    exchangeReconciled: exchangeReconciledCostEvidence.length,
  })

  return {
    schemaVersion: 1,
    generatedAt,
    tradesWithCostPrediction: predicted.length,
    tradesWithRealizedCost: realized.length,
    tradesWithPaperModelCostEvidence: paperModelCostEvidence.length,
    tradesWithExchangeReconciledCostEvidence: exchangeReconciledCostEvidence.length,
    pairedCostSamples: paired.length,
    missingCostPrediction: trades.length - predicted.length,
    missingRealizedCost: trades.length - realized.length,
    tradesWithExpectedGrossEdge,
    tradesWithExpectedNetEdge,
    tradesWithExpectedEdgeSource,
    tradesWithOpenTimeMarkMatchEvidence,
    tradesWithCompletePredictedOpenEvidence,
    completePredictedOpenEvidenceCoveragePct: trades.length > 0
      ? tradesWithCompletePredictedOpenEvidence / trades.length * 100
      : 0,
    predictedCostSourceBreakdown,
    realizedCostEvidenceIntegrity,
    missingPredictedOpenEvidence,
    closedTradeEnforcementBuckets,
    predictedOpenEvidenceConsistency,
    newWindow,
    actionableProducerGuardPatchTargets,
    legacyQuarantineTargets,
    transitionalDirtyQuarantineTargets,
    producerGuardMissingPredictedCostTargets: producerGuardMissingPredictedCostTargets.slice(0, 20),
    producerGuardMissingCompletePredictedOpenEvidenceTargets: producerGuardMissingCompletePredictedOpenEvidenceTargets.slice(0, 20),
    predictedCostBpsMean: predicted.length > 0 ? mean(predicted) : null,
    realizedCostBpsMean: realized.length > 0 ? mean(realized) : null,
    costPredictionErrorBpsMean: bias,
    costPredictionErrorBpsMAE: errors.length > 0 ? mean(errors.map(Math.abs)) : null,
    markMatchPenalty: {
      formula: 'abs(matchPrice - markPrice) / markPrice * 10000',
      tradesWithPenalty: penalties.length,
      meanPenaltyBps: penalties.length > 0 ? mean(penalties) : null,
      statusCounts,
    },
    legacyDiagnosticCostBackfill,
    routeCostShadowEligibility: buildRouteCostShadowEligibilityReport({
      trades,
      routeCostBudgetPath,
    }),
    openPositionReadiness: {
      status: 'insufficient_data',
      blockers: ['open_position_readiness:insufficient_data'],
      totalOpenPositions: 0,
      legacyOpenPositions: 0,
      newOpenPositions: 0,
      producerGuardOpenPositions: 0,
      completePredictedOpenEvidence: 0,
      missingPredictedOpenEvidence: 0,
      legacyMissingPredictedOpenEvidence: 0,
      newMissingPredictedOpenEvidence: 0,
      transitionalDirtyMissingPredictedOpenEvidence: 0,
      producerGuardMissingPredictedOpenEvidence: 0,
      newMissingPredictedOpenEvidenceByField: [],
      completeV3Context: 0,
      missingV3Context: 0,
      futureCloseDirtyRisk: 'none',
      byAccount: [],
    },
    sampleThresholds: COST_MODEL_SAMPLE_THRESHOLDS,
    quarantineDiagnostics,
    profitabilityClaimAllowed: false,
    promotionClaimAllowed: false,
    executionReplayClaimAllowed: false,
    quarantine: quarantineReasons.length > 0,
    quarantineReasons,
  }
}

function buildCostQuarantineDiagnostics(input: {
  predicted: number
  realized: number
  paired: number
  exchangeReconciled: number
}): CostModelDiagnosticsReport['quarantineDiagnostics'] {
  const rows = [
    {
      code: 'low_cost_prediction_sample',
      actual: input.predicted,
      required: COST_MODEL_SAMPLE_THRESHOLDS.minCostPredictionSamples,
    },
    {
      code: 'missing_realized_cost_sample',
      actual: input.realized,
      required: COST_MODEL_SAMPLE_THRESHOLDS.minRealizedCostSamples,
    },
    {
      code: 'low_paired_cost_sample',
      actual: input.paired,
      required: COST_MODEL_SAMPLE_THRESHOLDS.minPairedCostSamples,
    },
    {
      code: 'low_exchange_reconciled_cost_sample',
      actual: input.exchangeReconciled,
      required: COST_MODEL_SAMPLE_THRESHOLDS.minExchangeReconciledCostSamples,
    },
  ]
  return rows
    .filter(row => row.actual < row.required)
    .map(row => ({
      ...row,
      failClosed: true,
      promotionEvidenceAllowed: false,
      paperExecutionAllowed: false,
    }))
}

async function buildCostModelDiagnosticsWithOpenPositionReadiness(input: {
  trades: NormalizedPaperTrade[]
  paperDir: string
  routeCostBudgetPath?: string | null
  generatedAt?: string
}): Promise<CostModelDiagnosticsReport> {
  const report = buildCostModelDiagnostics(input.trades, input.generatedAt, input.routeCostBudgetPath ?? null)
  return {
    ...report,
    openPositionReadiness: await summarizeOpenPositionReadiness(input.paperDir),
  }
}

function buildRouteCostShadowEligibilityReport(input: {
  trades: NormalizedPaperTrade[]
  routeCostBudgetPath: string | null
}): RouteCostShadowEligibilityReport {
  const selectedRoute: RouteName = 'taker_taker'
  const budget = input.routeCostBudgetPath ? readRouteCostBudget(input.routeCostBudgetPath) : null
  const baseBlockers = ['route_cost_shadow_eligibility_diagnostic_only']
  const tradeCoverage = {
    closedTrades: input.trades.length,
    tradesWithRouteCostBps: input.trades.filter(trade => routeCostBps(trade) != null).length,
    tradesWithExpectedNetEdge: input.trades.filter(trade => trade.expectedNetEdgePctAtOpen != null).length,
    expectedNetEdgeBeatsSelectedRouteBreakEven: 0,
  }
  if (!budget) {
    return {
      diagnosticOnly: true,
      promotionEligible: false,
      paperExecutionAllowed: false,
      routeBudgetArtifactPath: input.routeCostBudgetPath,
      routeBudgetStatus: input.routeCostBudgetPath ? 'invalid' : 'missing',
      feeSnapshotStatus: 'missing',
      selectedRoute,
      selectedRouteSource: 'conservative_promotion_v2_default',
      routeSelectionMutationAllowed: false,
      selectedRouteOverBudgetBps: null,
      routes: [],
      tradeCoverage,
      tradeCoveragePct: buildRouteTradeCoveragePct(tradeCoverage),
      blockers: [
        ...baseBlockers,
        input.routeCostBudgetPath ? 'route_cost_budget_invalid' : 'route_cost_budget_missing',
      ],
      notes: [
        'Route-cost shadow eligibility is diagnostic only and cannot enable paper or live execution.',
        'Selected route is the conservative promotion-v2 default used only for audit comparability.',
        'Missing or invalid route cost budget keeps cost-adjusted gate conclusions blocked.',
      ],
    }
  }

  const routes = (Object.values(budget.routes) as Array<RouteCostBudget['routes'][RouteName]>)
    .sort((left, right) => left.route.localeCompare(right.route))
    .map(route => {
      const blockers = routeCostBudgetBlockers(route)
      return {
        route: route.route,
        totalExpectedCostBps: route.totalExpectedCostBps,
        maxAllowedCostBps: route.maxAllowedCostBps,
        breakEvenEdgeBps: route.breakEvenEdgeBps,
        overBudgetBps: Math.max(0, route.totalExpectedCostBps - route.maxAllowedCostBps),
        eligibleForShadowEvaluation: blockers.length === 0,
        blockers,
      }
    })
  const selected = budget.routes[selectedRoute]
  const selectedBlockers = selected ? routeCostBudgetBlockers(selected) : [`selected_route_budget_missing:${selectedRoute}`]
  const feeSnapshotStatus = classifyRouteBudgetFeeSnapshot(budget.feeSnapshot)
  const feeBlockers = feeSnapshotStatus === 'manual_override'
    ? ['route_cost_budget_fee_snapshot_manual_override']
    : feeSnapshotStatus === 'stale_or_unverified'
      ? ['route_cost_budget_fee_snapshot_stale_or_unverified']
      : feeSnapshotStatus === 'missing'
        ? ['route_cost_budget_fee_snapshot_missing']
        : []
  const selectedBreakEven = selected?.breakEvenEdgeBps ?? null
  tradeCoverage.expectedNetEdgeBeatsSelectedRouteBreakEven =
    selectedBreakEven == null
      ? 0
      : input.trades.filter(trade => {
          const expectedNetEdgeBps = expectedNetEdgeBpsAtOpen(trade)
          return expectedNetEdgeBps != null && expectedNetEdgeBps > selectedBreakEven
        }).length

  return {
    diagnosticOnly: true,
    promotionEligible: false,
    paperExecutionAllowed: false,
    routeBudgetArtifactPath: input.routeCostBudgetPath,
    routeBudgetStatus: selectedBlockers.length > 0 ? 'exceeded' : 'pass',
    feeSnapshotStatus,
    selectedRoute,
    selectedRouteSource: 'conservative_promotion_v2_default',
    routeSelectionMutationAllowed: false,
    selectedRouteOverBudgetBps: selected
      ? Math.max(0, selected.totalExpectedCostBps - selected.maxAllowedCostBps)
      : null,
    routes,
    tradeCoverage,
    tradeCoveragePct: buildRouteTradeCoveragePct(tradeCoverage),
    blockers: [
      ...baseBlockers,
      ...selectedBlockers,
      ...feeBlockers,
    ],
    notes: [
      'Selected route is a shadow evaluation assumption, not an execution permission.',
      'Selected route is the conservative promotion-v2 default and cannot mutate route selection.',
      'Blocker names mirror promotion-v2 route economics so P1 and promotion diagnostics use the same vocabulary.',
    ],
  }
}

function buildRouteTradeCoveragePct(
  tradeCoverage: RouteCostShadowEligibilityReport['tradeCoverage'],
): RouteCostShadowEligibilityReport['tradeCoveragePct'] {
  const denominator = tradeCoverage.closedTrades
  return {
    routeCostBps: denominator > 0 ? tradeCoverage.tradesWithRouteCostBps / denominator * 100 : 0,
    expectedNetEdge: denominator > 0 ? tradeCoverage.tradesWithExpectedNetEdge / denominator * 100 : 0,
    expectedNetEdgeBeatsSelectedRouteBreakEven: denominator > 0
      ? tradeCoverage.expectedNetEdgeBeatsSelectedRouteBreakEven / denominator * 100
      : 0,
  }
}

function readRouteCostBudget(path: string): RouteCostBudget | null {
  const parsed = readJsonFile(path)
  if (!parsed.ok) return null
  const root = asRecord(parsed.value)
  const routes = asRecord(root?.routes)
  const feeSnapshot = asRecord(root?.feeSnapshot)
  if (!root || !routes || !feeSnapshot) return null
  const parsedRoutes: Partial<Record<RouteName, RouteCostBudget['routes'][RouteName]>> = {}
  for (const route of ['passive_passive', 'passive_taker', 'taker_taker', 'twap'] as RouteName[]) {
    const rawRoute = asRecord(routes[route])
    const totalExpectedCostBps = numberOrNull(rawRoute?.totalExpectedCostBps)
    const maxAllowedCostBps = numberOrNull(rawRoute?.maxAllowedCostBps)
    const breakEvenEdgeBps = numberOrNull(rawRoute?.breakEvenEdgeBps)
    if (!rawRoute || totalExpectedCostBps == null || maxAllowedCostBps == null || breakEvenEdgeBps == null) {
      return null
    }
    parsedRoutes[route] = {
      route,
      feeBps: numberOrNull(rawRoute.feeBps) ?? 0,
      spreadBps: numberOrNull(rawRoute.spreadBps) ?? 0,
      slippageBps: numberOrNull(rawRoute.slippageBps) ?? 0,
      adverseSelectionBufferBps: numberOrNull(rawRoute.adverseSelectionBufferBps) ?? 0,
      queueMissBufferBps: numberOrNull(rawRoute.queueMissBufferBps) ?? 0,
      fundingBps: numberOrNull(rawRoute.fundingBps) ?? 0,
      totalExpectedCostBps,
      maxAllowedCostBps,
      breakEvenEdgeBps,
    }
  }
  return {
    schemaMeta: root.schemaMeta as RouteCostBudget['schemaMeta'],
    generatedAt: stringOrNull(root.generatedAt) ?? new Date(0).toISOString(),
    feeSnapshot: feeSnapshot as unknown as FeeSnapshot,
    routes: parsedRoutes as RouteCostBudget['routes'],
  }
}

function routeCostBudgetBlockers(route: RouteCostBudget['routes'][RouteName]): string[] {
  return route.totalExpectedCostBps > route.maxAllowedCostBps
    ? [`route_cost_budget_exceeded:${route.route}`]
    : []
}

function classifyRouteBudgetFeeSnapshot(feeSnapshot: FeeSnapshot | null | undefined): RouteCostShadowEligibilityReport['feeSnapshotStatus'] {
  if (!feeSnapshot) return 'missing'
  if (feeSnapshot.source === 'manual_override') return 'manual_override'
  if (feeSnapshot.verifiedByRuntime !== true) return 'stale_or_unverified'
  const expiresAt = typeof feeSnapshot.expiresAt === 'string' ? Date.parse(feeSnapshot.expiresAt) : NaN
  if (Number.isFinite(expiresAt) && expiresAt < Date.now()) return 'stale_or_unverified'
  return 'runtime_verified'
}

function routeCostBps(trade: NormalizedPaperTrade): number | null {
  return trade.routeCostBpsAtOpen ?? trade.roundTripCostBpsAtOpen ?? null
}

function expectedNetEdgeBpsAtOpen(trade: NormalizedPaperTrade): number | null {
  return trade.expectedNetEdgePctAtOpen == null ? null : trade.expectedNetEdgePctAtOpen * 100
}

export type PredictedOpenEvidenceField =
  | 'predicted_cost_bps'
  | 'expected_gross_edge_pct'
  | 'expected_net_edge_pct'
  | 'expected_edge_source'
  | 'match_price'
  | 'match_price_source'
  | 'mark_match_penalty_bps'
  | 'mark_match_status'

const PREDICTED_OPEN_EVIDENCE_FIELDS: PredictedOpenEvidenceField[] = [
  'predicted_cost_bps',
  'expected_gross_edge_pct',
  'expected_net_edge_pct',
  'expected_edge_source',
  'match_price',
  'match_price_source',
  'mark_match_penalty_bps',
  'mark_match_status',
]

function summarizeMissingPredictedOpenEvidence(
  trades: NormalizedPaperTrade[],
): CostModelDiagnosticsReport['missingPredictedOpenEvidence'] {
  const missingRows = trades
    .map(trade => ({ trade, missing: missingPredictedOpenEvidenceFields(trade) }))
    .filter(row => row.missing.length > 0)
  const topMissingFields = summarizeMissingFieldCounts(
    missingRows.flatMap(row => row.missing),
    Math.max(trades.length, 1),
  )
  const byLane = [...groupBy(trades, trade => trade.lane).entries()]
    .map(([lane, laneTrades]) => {
      const laneMissingRows = laneTrades
        .map(trade => ({ trade, missing: missingPredictedOpenEvidenceFields(trade) }))
        .filter(row => row.missing.length > 0)
      const completePredictedOpenEvidence = laneTrades.length - laneMissingRows.length
      return {
        lane,
        trades: laneTrades.length,
        completePredictedOpenEvidence,
        missingPredictedOpenEvidence: laneMissingRows.length,
        coveragePct: laneTrades.length > 0
          ? completePredictedOpenEvidence / laneTrades.length * 100
          : 0,
        topMissingFields: summarizeMissingFieldCounts(
          laneMissingRows.flatMap(row => row.missing),
          Math.max(laneTrades.length, 1),
        ).slice(0, 5).map(item => ({
          field: item.field,
          missingTrades: item.missingTrades,
        })),
      }
    })
    .filter(item => item.missingPredictedOpenEvidence > 0)
    .sort((left, right) =>
      right.missingPredictedOpenEvidence - left.missingPredictedOpenEvidence ||
      left.coveragePct - right.coveragePct ||
      left.lane.localeCompare(right.lane),
    )
    .slice(0, 20)
  return {
    totalMissingTrades: missingRows.length,
    topMissingFields,
    byLane,
    sampleTradeIds: missingRows.slice(0, 20).map(row => row.trade.tradeId),
    sampleMissingTrades: missingRows.slice(0, 20).map(row => ({
      tradeId: row.trade.tradeId,
      source: row.trade.source,
      lane: row.trade.lane,
      symbol: row.trade.symbol,
      openTs: row.trade.openTs,
      closeTs: row.trade.closeTs,
      missingFields: row.missing,
      enforcementBucket: classifyGateCostCoverageProducerGuardStatus(row.trade.openTs),
    })),
  }
}

function buildCostEvidenceTargets(trades: NormalizedPaperTrade[]): CostEvidenceTarget[] {
  return trades
    .map(trade => ({
      trade,
      missingFields: missingPredictedOpenEvidenceFields(trade),
      enforcementBucket: classifyGateCostCoverageProducerGuardStatus(trade.openTs),
    }))
    .filter(row => row.missingFields.length > 0)
    .map(row => ({
      tradeId: row.trade.tradeId,
      source: row.trade.source,
      lane: row.trade.lane,
      symbol: row.trade.symbol,
      openTs: row.trade.openTs,
      closeTs: row.trade.closeTs,
      missingFields: row.missingFields,
      enforcementBucket: row.enforcementBucket,
    }))
}

function summarizeCostEvidenceTargets(targets: CostEvidenceTarget[]): CostEvidenceTargetSummary {
  return {
    closedTrades: targets.length,
    missingPredictedCost: targets.filter(target => target.missingFields.includes('predicted_cost_bps')).length,
    missingCompletePredictedOpenEvidence: targets.length,
    sampleTrades: targets.slice(0, 20),
  }
}

function buildPredictedCostSourceBreakdown(
  trades: NormalizedPaperTrade[],
): CostModelDiagnosticsReport['predictedCostSourceBreakdown'] {
  const hasNumber = (trade: NormalizedPaperTrade, key: string) =>
    numberOrNull((trade as unknown as Record<string, unknown>)[key]) != null
  return {
    closedTrades: trades.length,
    roundTripCostBpsAtOpen: trades.filter(trade => hasNumber(trade, 'roundTripCostBpsAtOpen')).length,
    roundTripCostBps: trades.filter(trade => hasNumber(trade, 'roundTripCostBps')).length,
    routeCostBpsAtOpen: trades.filter(trade => hasNumber(trade, 'routeCostBpsAtOpen')).length,
    routeCostBps: trades.filter(trade => hasNumber(trade, 'routeCostBps')).length,
    estimatedRoundTripCostPctAtOpen: trades.filter(trade => hasNumber(trade, 'estimatedRoundTripCostPctAtOpen')).length,
    costEvidenceSourceCounts: countStrings(trades.map(trade => trade.costEvidenceSource ?? 'missing')),
    costEvidenceStatusCounts: countStrings(trades.map(trade => trade.costEvidenceStatus ?? 'missing')),
    predictedOpenEvidenceStatusCounts: countStrings(trades.map(trade => trade.predictedOpenEvidenceStatus ?? 'missing')),
    predictedOpenEvidenceReasonCounts: countStrings(trades.map(trade => trade.predictedOpenEvidenceReason ?? 'missing')),
  }
}

function buildRealizedCostEvidenceIntegrity(
  trades: NormalizedPaperTrade[],
): CostModelDiagnosticsReport['realizedCostEvidenceIntegrity'] {
  const rows = trades.flatMap(trade => {
    const hasFields = hasRawRealizedCostFields(trade)
    const source = costEvidenceSource(trade)
    const paperModelOnly = source === 'paper_cost_model_at_open' ||
      trade.costEvidenceStatus === 'paper_model_not_exchange_reconciled'
    if (hasFields && paperModelOnly) return [{ trade, reason: 'realized_fields_present_but_paper_model_only' }]
    if (hasFields && source !== 'exchange_reconciled_fill') return [{ trade, reason: 'realized_fields_present_without_exchange_source' }]
    if (!hasFields && source === 'exchange_reconciled_fill') return [{ trade, reason: 'exchange_reconciled_source_missing_realized_fields' }]
    if (!hasFields && paperModelOnly) return [{ trade, reason: 'paper_model_only_ignored_as_realized' }]
    return []
  })
  return {
    diagnosticOnly: true,
    realizedFieldsPresent: trades.filter(hasRawRealizedCostFields).length,
    realizedFieldsPresentButPaperModelOnly: rows.filter(row => row.reason === 'realized_fields_present_but_paper_model_only').length,
    realizedFieldsPresentWithoutExchangeSource: rows.filter(row => row.reason === 'realized_fields_present_without_exchange_source').length,
    exchangeReconciledSourceMissingRealizedFields: rows.filter(row => row.reason === 'exchange_reconciled_source_missing_realized_fields').length,
    paperModelOnlyIgnoredAsRealized: rows.filter(row => row.reason === 'paper_model_only_ignored_as_realized').length,
    sampleTrades: rows.slice(0, 20).map(row => ({
      tradeId: row.trade.tradeId,
      source: row.trade.source,
      lane: row.trade.lane,
      symbol: row.trade.symbol,
      openTs: row.trade.openTs,
      closeTs: row.trade.closeTs,
      reason: row.reason,
    })),
  }
}

function buildClosedTradeEnforcementBuckets(
  trades: NormalizedPaperTrade[],
): CostModelDiagnosticsReport['closedTradeEnforcementBuckets'] {
  return ([
    'legacy_pre_context_enforcement',
    'transitional_dirty_open',
    'producer_guard_enforced',
    'unknown_time',
  ] as GateCostCoverageProducerGuardStatus[])
    .map(bucket => {
      const rows = trades.filter(trade => classifyGateCostCoverageProducerGuardStatus(trade.openTs) === bucket)
      const completePredictedOpenEvidence = rows.filter(hasCompletePredictedOpenEvidence).length
      const missingPredictedOpenEvidence = rows.length - completePredictedOpenEvidence
      return {
        bucket,
        closedTrades: rows.length,
        completePredictedOpenEvidence,
        missingPredictedOpenEvidence,
        missingPredictedCost: rows.filter(trade => predictedCostBps(trade) == null).length,
        coveragePct: rows.length > 0 ? completePredictedOpenEvidence / rows.length * 100 : 0,
      }
    })
    .filter(item => item.closedTrades > 0)
}

function buildPredictedOpenEvidenceConsistency(
  trades: NormalizedPaperTrade[],
): CostModelDiagnosticsReport['predictedOpenEvidenceConsistency'] {
  const statusOkButFieldsMissing = trades.filter(trade =>
    trade.predictedOpenEvidenceStatus === 'ok' && missingPredictedOpenEvidenceFields(trade).length > 0
  )
  const fieldsCompleteButStatusNotOk = trades.filter(trade =>
    hasCompletePredictedOpenEvidence(trade) && trade.predictedOpenEvidenceStatus !== 'ok'
  )
  return {
    statusOkButFieldsMissing: statusOkButFieldsMissing.length,
    fieldsCompleteButStatusNotOk: fieldsCompleteButStatusNotOk.length,
    sampleTradeIds: [...statusOkButFieldsMissing, ...fieldsCompleteButStatusNotOk]
      .slice(0, 20)
      .map(trade => trade.tradeId),
  }
}

function missingPredictedOpenEvidenceFields(trade: NormalizedPaperTrade): PredictedOpenEvidenceField[] {
  return PREDICTED_OPEN_EVIDENCE_FIELDS.filter(field => {
    switch (field) {
      case 'predicted_cost_bps':
        return predictedCostBps(trade) == null
      case 'expected_gross_edge_pct':
        return trade.expectedGrossEdgePctAtOpen == null
      case 'expected_net_edge_pct':
        return trade.expectedNetEdgePctAtOpen == null
      case 'expected_edge_source':
        return trade.expectedEdgeSourceAtOpen == null
      case 'match_price':
        return trade.matchPriceAtOpen == null
      case 'match_price_source':
        return trade.matchPriceSourceAtOpen == null
      case 'mark_match_penalty_bps':
        return trade.markMatchPenaltyBpsAtOpen == null
      case 'mark_match_status':
        return trade.markMatchStatusAtOpen == null
    }
  })
}

function summarizeMissingFieldCounts(
  fields: PredictedOpenEvidenceField[],
  denominator: number,
): Array<{ field: string; missingTrades: number; missingPct: number }> {
  const counts = countStrings(fields)
  return Object.entries(counts)
    .map(([field, missingTrades]) => ({
      field,
      missingTrades,
      missingPct: denominator > 0 ? missingTrades / denominator * 100 : 0,
    }))
    .sort((left, right) => right.missingTrades - left.missingTrades || left.field.localeCompare(right.field))
}

function groupBy<T>(
  values: T[],
  keyFn: (value: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const value of values) {
    const key = keyFn(value)
    groups.set(key, [...(groups.get(key) ?? []), value])
  }
  return groups
}

function summarizeLegacyDiagnosticCostBackfill(
  trades: NormalizedPaperTrade[],
): CostModelDiagnosticsReport['legacyDiagnosticCostBackfill'] {
  const enforcementMs = Date.parse(normalizedContextEnforcementTs())
  const legacyMissingCost = trades.filter(trade => {
    const openMs = Date.parse(trade.openTs)
    return predictedCostBps(trade) == null &&
      Number.isFinite(openMs) &&
      Number.isFinite(enforcementMs) &&
      openMs < enforcementMs
  })
  const newMissingCost = trades.filter(trade => {
    const openMs = Date.parse(trade.openTs)
    return predictedCostBps(trade) == null &&
      Number.isFinite(openMs) &&
      Number.isFinite(enforcementMs) &&
      openMs >= enforcementMs
  })
  const diagnosticNet = legacyMissingCost.map(diagnosticCostAdjustedPnlPct)
  const status = legacyMissingCost.length > 0
    ? 'active'
    : trades.some(trade => predictedCostBps(trade) == null)
      ? 'inactive'
      : 'not_needed'
  return {
    status,
    policy: 'diagnostic_only_not_promotion_evidence',
    promotionEvidenceAllowed: false,
    source: 'legacy_lane_default_fee_slippage_mark_penalty',
    defaultRoundTripCostBps: DEFAULT_LEGACY_DIAGNOSTIC_ROUND_TRIP_COST_BPS,
    eligibleLegacyMissingCostTrades: legacyMissingCost.length,
    backfilledTrades: legacyMissingCost.length,
    excludedNewWindowMissingCostTrades: newMissingCost.length,
    diagnosticNetPnlPct: diagnosticNet.length > 0 ? roundFinite(sum(diagnosticNet)) : null,
    diagnosticMeanNetPnlPct: diagnosticNet.length > 0 ? roundFinite(mean(diagnosticNet)) : null,
  }
}

function predictedCostBps(trade: NormalizedPaperTrade): number | null {
  const raw = trade as unknown as Record<string, unknown>
  const explicitBps = numberOrNull(raw.roundTripCostBpsAtOpen ?? raw.roundTripCostBps ?? raw.routeCostBpsAtOpen ?? raw.routeCostBps)
  if (explicitBps != null && explicitBps >= 0) return explicitBps
  return trade.estimatedRoundTripCostPctAtOpen == null ? null : trade.estimatedRoundTripCostPctAtOpen * 100
}

function hasRawRealizedCostFields(trade: NormalizedPaperTrade): boolean {
  const raw = trade as unknown as Record<string, unknown>
  return numberOrNull(
    raw.realizedRoundTripCostBps ??
    raw.realizedCostBps ??
    raw.fillAdjustedCostBps ??
    raw.routeRealizedCostBps ??
    raw.realizedRoundTripCostPct ??
    raw.realizedCostPct ??
    raw.fillAdjustedCostPct,
  ) != null
}

function hasOpenTimeMarkMatchEvidence(trade: NormalizedPaperTrade): boolean {
  return (
    trade.matchPriceAtOpen != null &&
    trade.matchPriceSourceAtOpen != null &&
    trade.markMatchPenaltyBpsAtOpen != null &&
    trade.markMatchStatusAtOpen != null
  )
}

function hasCompletePredictedOpenEvidence(trade: NormalizedPaperTrade): boolean {
  return predictedCostBps(trade) != null &&
    trade.expectedGrossEdgePctAtOpen != null &&
    trade.expectedNetEdgePctAtOpen != null &&
    trade.expectedEdgeSourceAtOpen != null &&
    hasOpenTimeMarkMatchEvidence(trade)
}

function summarizeCostEvidenceNewWindow(trades: NormalizedPaperTrade[]): CostModelDiagnosticsReport['newWindow'] {
  const cutoverTs = normalizedContextCutoverTs()
  const enforcementTs = normalizedContextEnforcementTs(cutoverTs)
  const enforcementMs = Date.parse(enforcementTs)
  const producerGuardEnforcementTs = normalizedPredictedOpenEvidenceEnforcementTs()
  const producerGuardEnforcementMs = Date.parse(producerGuardEnforcementTs)
  const inWindow = trades.filter(trade => {
    const openMs = Date.parse(trade.openTs)
    return Number.isFinite(openMs) && openMs >= enforcementMs
  })
  const producerGuardRows = inWindow.filter(trade => {
    const openMs = Date.parse(trade.openTs)
    return Number.isFinite(openMs) && Number.isFinite(producerGuardEnforcementMs) && openMs >= producerGuardEnforcementMs
  })
  const complete = inWindow.filter(hasCompletePredictedOpenEvidence).length
  const missing = inWindow.filter(trade => !hasCompletePredictedOpenEvidence(trade))
  const producerGuardMissing = missing.filter(trade => isAfterPredictedOpenEvidenceEnforcement(trade.openTs)).length
  const transitionalDirtyMissing = missing.length - producerGuardMissing
  const status = inWindow.length === 0
    ? 'insufficient_data'
    : producerGuardMissing === 0
      ? 'ok'
      : 'missing'
  return {
    cutoverTs,
    enforcementTs,
    producerGuardEnforcementTs,
    producerGuardClosedTrades: producerGuardRows.length,
    awaitingPostEnforcementClosedTrades: producerGuardRows.length === 0,
    status,
    reason: status === 'ok'
      ? 'complete_predicted_open_evidence'
      : status === 'insufficient_data'
        ? 'awaiting_post_enforcement_closed_trades'
        : 'missing_predicted_open_evidence',
    closedTrades: inWindow.length,
    tradesWithCompletePredictedOpenEvidence: complete,
    tradesMissingCompletePredictedOpenEvidence: missing.length,
    transitionalDirtyMissingPredictedOpenEvidence: transitionalDirtyMissing,
    producerGuardMissingPredictedOpenEvidence: producerGuardMissing,
    completePredictedOpenEvidenceCoveragePct: inWindow.length > 0 ? complete / inWindow.length * 100 : 0,
  }
}

async function summarizeOpenPositionReadiness(
  paperDir: string,
): Promise<CostModelDiagnosticsReport['openPositionReadiness']> {
  const accountSummaries: CostModelDiagnosticsReport['openPositionReadiness']['byAccount'] = []
  for (const path of discoverP1AccountJsonFiles(paperDir)) {
    const parsed = readJsonFile(path)
    if (!parsed.ok) continue
    const root = asRecord(parsed.value)
    const positions = Array.isArray(root?.positions) ? root.positions.filter(isRecord) : []
    if (positions.length === 0) continue
    accountSummaries.push(summarizeAccountOpenPositionReadiness({
      path,
      accountId: inferP1AccountIdFromPath(path),
      positions,
    }))
  }
  const totals = accountSummaries.reduce(
    (acc, account) => {
      acc.totalOpenPositions += account.openPositions
      acc.legacyOpenPositions += account.legacyOpenPositions
      acc.newOpenPositions += account.newOpenPositions
      acc.producerGuardOpenPositions += account.producerGuardOpenPositions
      acc.completePredictedOpenEvidence += account.completePredictedOpenEvidence
      acc.missingPredictedOpenEvidence += account.missingPredictedOpenEvidence
      acc.legacyMissingPredictedOpenEvidence += account.legacyMissingPredictedOpenEvidence
      acc.newMissingPredictedOpenEvidence += account.newMissingPredictedOpenEvidence
      acc.transitionalDirtyMissingPredictedOpenEvidence += account.transitionalDirtyMissingPredictedOpenEvidence
      acc.producerGuardMissingPredictedOpenEvidence += account.producerGuardMissingPredictedOpenEvidence
      acc.completeV3Context += account.completeV3Context
      acc.missingV3Context += account.missingV3Context
      return acc
    },
    {
      totalOpenPositions: 0,
      legacyOpenPositions: 0,
      newOpenPositions: 0,
      producerGuardOpenPositions: 0,
      completePredictedOpenEvidence: 0,
      missingPredictedOpenEvidence: 0,
      legacyMissingPredictedOpenEvidence: 0,
      newMissingPredictedOpenEvidence: 0,
      transitionalDirtyMissingPredictedOpenEvidence: 0,
      producerGuardMissingPredictedOpenEvidence: 0,
      completeV3Context: 0,
      missingV3Context: 0,
    },
  )
  const newMissingPredictedOpenEvidenceByField = summarizeNewOpenMissingPredictedEvidenceFields(accountSummaries)
  const futureCloseDirtyRisk: CostModelDiagnosticsReport['openPositionReadiness']['futureCloseDirtyRisk'] = totals.producerGuardOpenPositions > 0 &&
    (totals.producerGuardMissingPredictedOpenEvidence > 0 || totals.missingV3Context > totals.legacyOpenPositions + totals.transitionalDirtyMissingPredictedOpenEvidence)
    ? 'new_missing_context_or_cost'
    : totals.legacyOpenPositions > 0 || totals.missingPredictedOpenEvidence > 0 || totals.missingV3Context > 0
      ? 'legacy_will_close_dirty'
      : 'none'
  const status: CostModelDiagnosticsReport['openPositionReadiness']['status'] = totals.totalOpenPositions === 0
    ? 'insufficient_data'
    : futureCloseDirtyRisk === 'none'
      ? 'ok'
      : futureCloseDirtyRisk === 'new_missing_context_or_cost'
        ? 'blocked_new_missing_evidence'
        : 'blocked_legacy_dirty_opens'
  return {
    status,
    blockers: buildOpenPositionReadinessBlockers({
      status,
      totalOpenPositions: totals.totalOpenPositions,
      missingPredictedOpenEvidence: totals.missingPredictedOpenEvidence,
      legacyMissingPredictedOpenEvidence: totals.legacyMissingPredictedOpenEvidence,
      newMissingPredictedOpenEvidence: totals.newMissingPredictedOpenEvidence,
      transitionalDirtyMissingPredictedOpenEvidence: totals.transitionalDirtyMissingPredictedOpenEvidence,
      producerGuardMissingPredictedOpenEvidence: totals.producerGuardMissingPredictedOpenEvidence,
      missingV3Context: totals.missingV3Context,
      newMissingPredictedOpenEvidenceByField,
    }),
    ...totals,
    newMissingPredictedOpenEvidenceByField,
    futureCloseDirtyRisk,
    byAccount: accountSummaries.sort((left, right) =>
      right.missingPredictedOpenEvidence - left.missingPredictedOpenEvidence ||
      right.missingV3Context - left.missingV3Context ||
      left.accountId.localeCompare(right.accountId),
    ),
  }
}

function buildOpenPositionReadinessBlockers(input: {
  status: CostModelDiagnosticsReport['openPositionReadiness']['status']
  totalOpenPositions: number
  missingPredictedOpenEvidence: number
  legacyMissingPredictedOpenEvidence: number
  newMissingPredictedOpenEvidence: number
  transitionalDirtyMissingPredictedOpenEvidence: number
  producerGuardMissingPredictedOpenEvidence: number
  missingV3Context: number
  newMissingPredictedOpenEvidenceByField: CostModelDiagnosticsReport['openPositionReadiness']['newMissingPredictedOpenEvidenceByField']
}): string[] {
  const blockers = [`open_position_readiness:${input.status}`]
  if (input.totalOpenPositions > 0) blockers.push(`open_positions:${input.totalOpenPositions}`)
  if (input.missingPredictedOpenEvidence > 0) {
    blockers.push(`open_positions_missing_predicted_open_evidence:${input.missingPredictedOpenEvidence}`)
  }
  if (input.legacyMissingPredictedOpenEvidence > 0) {
    blockers.push(`legacy_open_positions_will_close_dirty:${input.legacyMissingPredictedOpenEvidence}`)
  }
  if (input.newMissingPredictedOpenEvidence > 0) {
    blockers.push(`new_open_positions_missing_predicted_open_evidence:${input.newMissingPredictedOpenEvidence}`)
  }
  if (input.transitionalDirtyMissingPredictedOpenEvidence > 0) {
    blockers.push(`transitional_dirty_open_positions_missing_predicted_open_evidence:${input.transitionalDirtyMissingPredictedOpenEvidence}`)
  }
  if (input.producerGuardMissingPredictedOpenEvidence > 0) {
    blockers.push(`producer_guard_open_positions_missing_predicted_open_evidence:${input.producerGuardMissingPredictedOpenEvidence}`)
  }
  if (input.missingV3Context > 0) blockers.push(`open_positions_missing_v3_context:${input.missingV3Context}`)
  for (const item of input.newMissingPredictedOpenEvidenceByField) {
    blockers.push(`new_open_positions_missing_field:${item.field}:${item.missingPositions}`)
  }
  return blockers
}

function summarizeAccountOpenPositionReadiness(input: {
  path: string
  accountId: string
  positions: Record<string, unknown>[]
}): CostModelDiagnosticsReport['openPositionReadiness']['byAccount'][number] {
  const samples = input.positions
    .map((position, index) => ({
      positionId: stringOrNull(position.id ?? position.positionId ?? position.tradeId) ??
        `${input.accountId}:${stringOrNull(position.symbol) ?? 'unknown'}:${stringOrNull(position.entryTime ?? position.openTs) ?? index}`,
      symbol: stringOrNull(position.symbol) ?? 'unknown',
      side: parseP1Side(position.side ?? position.direction),
      lane: stringOrNull(position.lane) ?? inferOpenPositionLane(position, input.path),
      entryTime: stringOrNull(position.entryTime ?? position.openTs),
      missingPredictedOpenEvidenceFields: missingPredictedOpenEvidenceFields(positionRecordToTrade(position, input.path, index)),
      v3ContextStatus: hasOpenPositionV3Context(position) ? 'ok' as const : 'missing' as const,
    }))
  const legacyOpenPositions = samples.filter(sample => !isAfterContextEnforcement(sample.entryTime)).length
  const newOpenPositions = samples.length - legacyOpenPositions
  const producerGuardOpenPositions = samples.filter(sample => isAfterPredictedOpenEvidenceEnforcement(sample.entryTime)).length
  const completePredictedOpenEvidence = samples.filter(sample => sample.missingPredictedOpenEvidenceFields.length === 0).length
  const legacyMissingPredictedOpenEvidence = samples.filter(sample =>
    !isAfterContextEnforcement(sample.entryTime) &&
    sample.missingPredictedOpenEvidenceFields.length > 0
  ).length
  const newMissingPredictedOpenEvidence = samples.filter(sample =>
    isAfterContextEnforcement(sample.entryTime) &&
    sample.missingPredictedOpenEvidenceFields.length > 0
  ).length
  const transitionalDirtyMissingPredictedOpenEvidence = samples.filter(sample =>
    isAfterContextEnforcement(sample.entryTime) &&
    !isAfterPredictedOpenEvidenceEnforcement(sample.entryTime) &&
    sample.missingPredictedOpenEvidenceFields.length > 0
  ).length
  const producerGuardMissingPredictedOpenEvidence = samples.filter(sample =>
    isAfterPredictedOpenEvidenceEnforcement(sample.entryTime) &&
    sample.missingPredictedOpenEvidenceFields.length > 0
  ).length
  const newMissingPredictedOpenEvidenceByField = summarizeMissingFieldCounts(
    samples
      .filter(sample => isAfterContextEnforcement(sample.entryTime))
      .flatMap(sample => sample.missingPredictedOpenEvidenceFields),
    Math.max(newOpenPositions, 1),
  ).map(item => ({
    field: item.field as PredictedOpenEvidenceField,
    missingPositions: item.missingTrades,
  }))
  const completeV3Context = samples.filter(sample => sample.v3ContextStatus === 'ok').length
  return {
    accountId: input.accountId,
    path: input.path,
    openPositions: samples.length,
    legacyOpenPositions,
    newOpenPositions,
    producerGuardOpenPositions,
    completePredictedOpenEvidence,
    missingPredictedOpenEvidence: samples.length - completePredictedOpenEvidence,
    legacyMissingPredictedOpenEvidence,
    newMissingPredictedOpenEvidence,
    transitionalDirtyMissingPredictedOpenEvidence,
    producerGuardMissingPredictedOpenEvidence,
    newMissingPredictedOpenEvidenceByField,
    completeV3Context,
    missingV3Context: samples.length - completeV3Context,
    samplePositions: samples
      .filter(sample => sample.missingPredictedOpenEvidenceFields.length > 0 || sample.v3ContextStatus !== 'ok')
      .slice(0, 5),
  }
}

function summarizeNewOpenMissingPredictedEvidenceFields(
  accounts: CostModelDiagnosticsReport['openPositionReadiness']['byAccount'],
): CostModelDiagnosticsReport['openPositionReadiness']['newMissingPredictedOpenEvidenceByField'] {
  const counts = new Map<PredictedOpenEvidenceField, number>()
  for (const account of accounts) {
    for (const item of account.newMissingPredictedOpenEvidenceByField) {
      counts.set(item.field, (counts.get(item.field) ?? 0) + item.missingPositions)
    }
  }
  return [...counts.entries()]
    .map(([field, missingPositions]) => ({ field, missingPositions }))
    .sort((left, right) => right.missingPositions - left.missingPositions || left.field.localeCompare(right.field))
}

function positionRecordToTrade(position: Record<string, unknown>, source: string, index: number): NormalizedPaperTrade {
  const entryTime = stringOrNull(position.entryTime ?? position.openTs) ?? new Date(0).toISOString()
  return {
    tradeId: stringOrNull(position.tradeId ?? position.id ?? position.positionId) ?? `${source}:open:${index}`,
    source,
    lane: stringOrNull(position.lane) ?? inferOpenPositionLane(position, source),
    accountId: stringOrNull(position.accountId),
    accountLabel: stringOrNull(position.accountLabel),
    symbol: stringOrNull(position.symbol) ?? 'unknown',
    side: parseP1Side(position.side ?? position.direction),
    leverage: numberOrNull(position.leverage),
    openTs: entryTime,
    closeTs: entryTime,
    openPrice: numberOrNull(position.openPrice ?? position.entryPrice),
    closePrice: null,
    pnlPct: 0,
    pnlUsd: null,
    closeReason: 'open_position_readiness',
    rawReason: null,
    holdingSeconds: null,
    closeHourUtc: null,
    priceSource: stringOrNull(position.priceSource),
    priceStale: booleanOrNull(position.priceStale),
    volumeRatioAtOpen: numberOrNull(position.volumeRatioAtOpen ?? position.volumeRatio),
    breakQualityAtOpen: numberOrNull(position.breakQualityAtOpen ?? position.breakQuality),
    liquidityUsdAtOpen: numberOrNull(position.liquidityUsdAtOpen ?? position.liquidityUsd),
    liquidityStatusAtOpen: stringOrNull(position.liquidityStatusAtOpen ?? position.liquidityStatus),
    spreadStatusAtOpen: stringOrNull(position.spreadStatusAtOpen ?? position.spreadStatus),
    spreadBpsAtOpen: numberOrNull(position.spreadBpsAtOpen ?? position.spreadBps),
    rankAtOpen: numberOrNull(position.rankAtOpen),
    rankSpreadPctAtOpen: numberOrNull(position.rankSpreadPctAtOpen),
    estimatedRoundTripCostPctAtOpen: numberOrNull(position.estimatedRoundTripCostPctAtOpen),
    estimatedRoundTripCostPctOfMarginAtOpen: numberOrNull(position.estimatedRoundTripCostPctOfMarginAtOpen),
    expectedGrossEdgePctAtOpen: numberOrNull(position.expectedGrossEdgePctAtOpen),
    expectedNetEdgePctAtOpen: numberOrNull(position.expectedNetEdgePctAtOpen),
    expectedEdgeSourceAtOpen: stringOrNull(position.expectedEdgeSourceAtOpen),
    routeCostBpsAtOpen: numberOrNull(position.routeCostBpsAtOpen ?? position.routeCostBps),
    roundTripCostBpsAtOpen: numberOrNull(position.roundTripCostBpsAtOpen ?? position.roundTripCostBps),
    markPriceAtOpen: numberOrNull(position.markPriceAtOpen ?? position.markPrice),
    markPriceTimestampAtOpen: stringOrNull(position.markPriceTimestampAtOpen ?? position.markPriceTimestamp),
    matchPriceAtOpen: numberOrNull(position.matchPriceAtOpen ?? position.matchPrice),
    matchPriceSourceAtOpen: stringOrNull(position.matchPriceSourceAtOpen ?? position.matchPriceSource),
    markMatchPenaltyBpsAtOpen: numberOrNull(position.markMatchPenaltyBpsAtOpen ?? position.markMatchPenaltyBps),
    markMatchStatusAtOpen: stringOrNull(position.markMatchStatusAtOpen ?? position.markMatchStatus),
    realizedRoundTripCostBps: null,
    realizedCostBps: null,
    fillAdjustedCostBps: null,
    fillAdjustedCostPct: null,
    costEvidenceSource: stringOrNull(position.costEvidenceSource),
    costEvidenceStatus: stringOrNull(position.costEvidenceStatus),
    mfeBps: null,
    maeBps: null,
    timeToMfeSec: null,
    timeToMaeSec: null,
    timeToStopSec: null,
    mfeBeforeStop: null,
    signalConfidenceAtOpen: numberOrNull(position.signalConfidenceAtOpen ?? position.signalConfidence),
    contextSnapshotId: stringOrNull(position.contextSnapshotId),
    decisionTime: stringOrNull(position.decisionTime),
    marketDataWatermarkAtDecisionTime: stringOrNull(position.marketDataWatermarkAtDecisionTime),
    watermark: stringOrNull(position.watermark),
    featuresAvailableAtDecisionTime: booleanOrNull(position.featuresAvailableAtDecisionTime),
    featureSchemaVersion: stringOrNull(position.featureSchemaVersion),
    flashContextStatus: stringOrNull(position.flashContextStatus),
    contextStatus: stringOrNull(position.contextStatus),
    contextReason: stringOrNull(position.contextReason),
    contextCoverageStatus: stringOrNull(position.contextCoverageStatus),
    contextCoverageReason: stringOrNull(position.contextCoverageReason),
    contextGenerationAtOpen: numberOrNull(position.contextGenerationAtOpen),
    flashConfidenceLowAtOpen: numberOrNull(position.flashConfidenceLowAtOpen),
    ruleScoreAtOpen: numberOrNull(position.ruleScoreAtOpen),
    proEpochAtOpen: numberOrNull(position.proEpochAtOpen),
    marketIntelTriggerAtOpen: stringOrNull(position.marketIntelTriggerAtOpen),
    regimeAtOpen: stringOrNull(position.regimeAtOpen ?? position.marketRegimeAtOpen),
    contextCoverageBucket: hasOpenPositionV3Context(position) ? 'ok' : isAfterContextEnforcement(entryTime) ? 'new_missing' : 'legacy_missing',
    liquidated: false,
  }
}

function hasOpenPositionV3Context(position: Record<string, unknown>): boolean {
  const decisionTime = stringOrNull(position.decisionTime)
  const watermark = stringOrNull(position.marketDataWatermarkAtDecisionTime) ?? stringOrNull(position.watermark)
  const contextStatus = stringOrNull(position.contextStatus)
  const flashContextStatus = stringOrNull(position.flashContextStatus)
  return Boolean(
    stringOrNull(position.contextSnapshotId) &&
    decisionTime &&
    watermark &&
    isPITSafeWatermark(decisionTime, watermark) &&
    booleanOrNull(position.featuresAvailableAtDecisionTime) === true &&
    stringOrNull(position.featureSchemaVersion) === 'paper_open_context.v3' &&
    contextStatus === 'ok' &&
    flashContextStatus === 'ok' &&
    numberOrNull(position.contextGenerationAtOpen) != null &&
    numberOrNull(position.flashConfidenceLowAtOpen) != null,
  )
}

function isPITSafeWatermark(decisionTime: string, watermark: string): boolean {
  const decisionMs = Date.parse(decisionTime)
  const watermarkMs = Date.parse(watermark)
  return Number.isFinite(decisionMs) && Number.isFinite(watermarkMs) && watermarkMs <= decisionMs
}

function isAfterContextEnforcement(value: string | null): boolean {
  if (!value) return false
  const parsed = Date.parse(value)
  const enforcement = Date.parse(normalizedContextEnforcementTs())
  return Number.isFinite(parsed) && Number.isFinite(enforcement) && parsed >= enforcement
}

function discoverP1AccountJsonFiles(paperDir: string): string[] {
  const files: string[] = []
  for (const name of listDir(paperDir)) {
    if (/^account.*\.json$/.test(name)) files.push(join(paperDir, name))
  }
  const accountsDir = join(paperDir, 'accounts')
  for (const account of listDir(accountsDir)) {
    const path = join(accountsDir, account, 'account.json')
    if (existsSync(path)) files.push(path)
  }
  return files.sort()
}

function listDir(path: string): string[] {
  if (!existsSync(path)) return []
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function inferP1AccountIdFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const accountMatch = normalized.match(/\/accounts\/([^/]+)\/account\.json$/)
  if (accountMatch) return accountMatch[1]
  const file = normalized.split('/').pop() ?? 'account.json'
  return file.replace(/^account_?/, '').replace(/\.json$/, '') || 'root'
}

function inferOpenPositionLane(position: Record<string, unknown>, source: string): string {
  const explicit = stringOrNull(position.lane)
  if (explicit) return explicit
  const leverage = numberOrNull(position.leverage)
  if (source.includes('account_ms')) return `microstructure_${leverage ?? 'unknown'}x`
  if (source.includes('account_vb')) return `volume_breakout_${leverage ?? 'unknown'}x`
  return leverage != null ? `cross_sectional_${leverage}x` : 'cross_sectional'
}

function parseP1Side(value: unknown): 'long' | 'short' | 'unknown' {
  if (value === 'long' || value === 'buy') return 'long'
  if (value === 'short' || value === 'sell') return 'short'
  return 'unknown'
}

function shadowOpenPredictedCostBps(open: ParsedPaperPolicyShadowOpen): number | null {
  const raw = open.cost
  const explicitBps = numberOrNull(raw.roundTripCostBpsAtOpen ?? raw.roundTripCostBps ?? raw.routeCostBpsAtOpen ?? raw.routeCostBps)
  if (explicitBps != null && explicitBps >= 0) return explicitBps
  const estimatedPct = numberOrNull(raw.estimatedRoundTripCostPctAtOpen ?? raw.estimatedRoundTripCostPct)
  return estimatedPct == null || estimatedPct < 0 ? null : estimatedPct * 100
}

export async function buildMfeMaeStoplossReport(input: {
  trades: NormalizedPaperTrade[]
  dataDir: string
  dataDirs?: Partial<Record<PaperUniverseTimeframe, string>>
  timeframe: PaperUniverseTimeframe
  generatedAt?: string
}): Promise<MfeMaeStoplossReport> {
  const candlesByKey = new Map<string, Candle[]>()
  const diagnostics: MfeMaeTradeDiagnostic[] = []
  for (const trade of input.trades) {
    let selectedDiagnostic: MfeMaeTradeDiagnostic | null = null
    let fallbackReason: MfeMaeTradeDiagnostic['pricePathFallbackReason'] = null
    for (const [index, timeframe] of resolveMfeMaeTimeframeCandidatesForTrade(trade, input.timeframe).entries()) {
      const dataDir = input.dataDirs?.[timeframe] ?? input.dataDir
      const cacheKey = `${timeframe}:${trade.symbol}:${dataDir}`
      let candles = candlesByKey.get(cacheKey)
      if (!candles) {
        candles = await loadCandlesForTrade(dataDir, trade.symbol, timeframe)
        candlesByKey.set(cacheKey, candles)
      }
      const diagnostic = computeMfeMaeDiagnostic({
        trade,
        candles,
        timeframe,
        fallbackUsed: index > 0,
        fallbackReason,
      })
      if (diagnostic.diagnosticStatus === 'ok') {
        selectedDiagnostic = diagnostic
        break
      }
      if (
        index === 0 &&
        (diagnostic.diagnosticStatus === 'missing_price_path' || diagnostic.diagnosticStatus === 'price_path_mismatch')
      ) {
        fallbackReason = diagnostic.diagnosticStatus === 'missing_price_path'
          ? 'preferred_missing_price_path'
          : 'preferred_price_path_mismatch'
        selectedDiagnostic = diagnostic
        continue
      }
      if (
        !selectedDiagnostic ||
        (selectedDiagnostic.diagnosticStatus === 'missing_price_path' && diagnostic.diagnosticStatus !== 'missing_price_path')
      ) {
        selectedDiagnostic = diagnostic
      }
    }
    diagnostics.push(selectedDiagnostic ?? computeMfeMaeDiagnostic({
      trade,
      candles: [],
      timeframe: null,
      fallbackUsed: false,
      fallbackReason: null,
    }))
  }
  const ok = diagnostics.filter(item => item.diagnosticStatus === 'ok')
  const stopLoss = diagnostics.filter(item => item.closeReason === 'stop_loss')
  const stopLossOk = stopLoss.filter(item => item.diagnosticStatus === 'ok')
  const stopLossKnownOrdering = stopLossOk.filter(item => item.orderingStatus === 'known')

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    metricBasis: 'price_path_bps',
    pathSemantics: {
      candleTimestampConvention: 'bar_open_assumed',
      intrabarOrderingKnownOnlyFor: '1s',
      coarseBarMfeBeforeStopReliable: false,
    },
    coverage: {
      closedTrades: input.trades.length,
      stopLossTrades: stopLoss.length,
      diagnosticsOk: ok.length,
      closedDiagnosticsOk: ok.length,
      stopLossDiagnosticsOk: stopLossOk.length,
      stopLossDiagnosticsOkPct: stopLoss.length > 0 ? stopLossOk.length / stopLoss.length * 100 : 0,
      stopLossMissingPricePath: stopLoss.filter(item => item.diagnosticStatus === 'missing_price_path').length,
      stopLossPricePathMismatch: stopLoss.filter(item => item.diagnosticStatus === 'price_path_mismatch').length,
      stopLossKnownOrdering: stopLossKnownOrdering.length,
      stopLossCoarseOrdering: stopLossOk.filter(item => item.orderingStatus === 'coarse_bar_unknown').length,
      missingPricePath: diagnostics.filter(item => item.diagnosticStatus === 'missing_price_path').length,
      pricePathMismatch: diagnostics.filter(item => item.diagnosticStatus === 'price_path_mismatch').length,
      invalidTradePrices: diagnostics.filter(item => item.diagnosticStatus === 'invalid_trade_prices').length,
    },
    byCloseReason: groupMfeMaeByCloseReason(ok),
    stopLossAttribution: buildMfeMaeStoplossAttribution(stopLoss),
    stopLossSummary: {
      count: stopLoss.length,
      avgMfeBps: averageNullable(stopLossOk.map(item => item.mfeBps)),
      avgMaeBps: averageNullable(stopLossOk.map(item => item.maeBps)),
      medianMfeBps: medianNullable(stopLossOk.map(item => item.mfeBps)),
      medianMaeBps: medianNullable(stopLossOk.map(item => item.maeBps)),
      mfeBeforeStopSharePct: stopLossKnownOrdering.length > 0
        ? stopLossKnownOrdering.filter(item => item.mfeBeforeStop === true).length / stopLossKnownOrdering.length * 100
        : null,
    },
    diagnostics,
    profitabilityClaimAllowed: false,
    promotionClaimAllowed: false,
    executionReplayClaimAllowed: false,
    notes: [
      'MFE/MAE is computed from local OHLC candles between openTs and closeTs; it is path diagnostic, not execution replay.',
      'Price path timeframe is selected from priceSource when available; 1s trades use the local live_1s path.',
      'Rows without local price path are excluded from MFE/MAE aggregates and marked missing_price_path.',
      'Rows whose candle prices are out of scale with the trade open price are excluded and marked price_path_mismatch.',
      'For non-1s candles, mfeBeforeStop is not interpreted as ordering proof because OHLC intrabar order is unknown.',
    ],
  }
}

function resolveMfeMaeTimeframeForTrade(
  trade: NormalizedPaperTrade,
  fallback: PaperUniverseTimeframe,
): PaperUniverseTimeframe {
  if (trade.priceSource === '1s') return '1s'
  if (trade.priceSource === '5m') return '5m'
  return fallback
}

function resolveMfeMaeTimeframeCandidatesForTrade(
  trade: NormalizedPaperTrade,
  fallback: PaperUniverseTimeframe,
): PaperUniverseTimeframe[] {
  const preferred = resolveMfeMaeTimeframeForTrade(trade, fallback)
  const candidates: PaperUniverseTimeframe[] = [preferred]
  if (preferred !== '1s') candidates.push('1s')
  if (!candidates.includes('1h')) candidates.push('1h')
  return candidates
}

export function buildTrialLedgerReport(input: {
  acceptedTrades: NormalizedPaperTrade[]
  gateEffectiveness: GateEffectivenessReport
  alphaRegistry: AlphaHypothesisRegistry
  visibleTrialSources?: VisibleTrialLedgerSources
  generatedAt?: string
  rawMComplete?: boolean
  includesFailedTrials?: boolean
  rawMCompleteness?: TrialLedgerReport['rawMCompleteness']
}): TrialLedgerReport {
  const laneStats = new Map<string, NormalizedPaperTrade[]>()
  for (const trade of input.acceptedTrades) {
    laneStats.set(trade.lane, [...(laneStats.get(trade.lane) ?? []), trade])
  }
  const registryEntries: TrialLedgerEntry[] = input.alphaRegistry.entries.map((hypothesis) => {
    const laneTrades = [...laneStats.entries()]
      .filter(([lane]) => lane.includes(hypothesis.familyId.replace('_breakout', '')) || lane.includes(hypothesis.familyId))
      .flatMap(([, trades]) => trades)
    const stats = computeStats(hypothesis.policyId, laneTrades)
    return {
      trialId: `${hypothesis.policyId}:p1_registered`,
      familyId: hypothesis.familyId,
      policyId: hypothesis.policyId,
      featureSetHash: hashString(hypothesis.requiredObservables.join('|')),
      universeHash: hashString([...new Set(laneTrades.map(trade => trade.symbol))].sort().join('|') || 'unknown'),
      parameterCluster: 'p1_hand_registered',
      status: stats.count > 0 ? 'active' : 'registered',
      source: 'alpha_hypothesis_registry',
      metrics: {
        closedTrades: stats.count,
        totalPnlPct: stats.totalPnlPct,
        winRate: stats.winRate,
        profitFactor: stats.profitFactor,
        gateStatus: input.gateEffectiveness.gateStatus,
        diagnosticOnly: true,
        fdrExclusionReason: 'alpha_hypothesis_registry_is_causal_hypothesis_not_statistical_trial',
      },
      includedInRawM: false,
      includedInEffectiveM: false,
    }
  })
  const entries = excludeDuplicateRuntimeTrialRerunsFromRawM(dedupeTrialLedgerEntries([
    ...registryEntries,
    ...(input.visibleTrialSources?.entries ?? []),
  ]))
  const rawM = entries.filter(entry => entry.includedInRawM).length
  const effectiveM = new Set(entries
    .filter(entry => entry.includedInEffectiveM)
    .map(entry => `${entry.familyId}|${entry.featureSetHash}|${entry.universeHash}|${entry.parameterCluster}`)).size
  const completeTrialUniverseMarkerPresent = hasCompleteTrialUniverseMarker(entries)
  const rawMComplete = input.rawMComplete ?? completeTrialUniverseMarkerPresent
  const includesFailedTrials = input.includesFailedTrials ?? completeTrialUniverseMarkerPresent
  const rawMCompleteness = input.rawMCompleteness ?? (rawMComplete ? 'complete_trial_universe' : 'visible_sources_only')
  const survivingTrialCount = entries.filter(entry => entry.status === 'active' || entry.status === 'registered').length
  const failedTrialCount = entries.filter(entry => entry.status === 'graveyard' || entry.status === 'killed').length
  const fdrDiagnostics = buildFdrDiagnostics({
    entries,
    rawMComplete,
    includesFailedTrials,
  })
  const readinessGaps = summarizeTrialLedgerReadinessGaps(entries)
  const status: TrialLedgerReport['status'] = entries.length === 0
    ? 'invalid_trial_ledger'
    : fdrDiagnostics.status === 'ready' && rawMComplete && includesFailedTrials
      ? 'valid'
      : 'skeleton'
  const fdrGateStatus: TrialLedgerReport['fdrGateStatus'] = entries.length === 0
    ? 'invalid_trial_ledger'
    : !rawMComplete || !includesFailedTrials
      ? 'blocked_missing_complete_trial_universe'
      : fdrDiagnostics.status !== 'ready'
        ? 'blocked_missing_pvalues'
        : 'ready_explanatory_only'
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    raw_m: rawM,
    effective_m: effectiveM,
    rawMComplete,
    rawMCompleteness,
    includesFailedTrials,
    failedTrialCount,
    survivingTrialCount,
    promotionEligible: status === 'valid' && fdrGateStatus === 'ready_explanatory_only',
    fdrGateStatus,
    fdrMethodPrimary: 'BY_raw_m',
    fdrMethodSecondary: 'BY_effective_m',
    status,
    fdrDiagnostics,
    readinessGaps,
    sourceDiagnostics: input.visibleTrialSources?.diagnostics ?? [],
    entries,
    notes: [
      'This P1 ledger registers alpha families plus visible candidate, optimizer, validation, and graveyard rows; P2 promotion still requires a complete raw_m across all optimizer trials.',
      'rawMCompleteness=visible_sources_only is conservative bookkeeping, not a complete trial universe.',
      'FDR readiness requires rawMComplete=true, includesFailedTrials=true, and finite p-values for every included FDR trial.',
      'BY_raw_m is the only default promotion FDR gate; BY_effective_m is explanatory only.',
    ],
  }
}

function hasCompleteTrialUniverseMarker(entries: TrialLedgerEntry[]): boolean {
  return entries.some(entry =>
    entry.source === 'runtime_trial_registry' &&
    entry.metrics.trialUniverseMarker === true &&
    entry.metrics.trialUniverseMarkerType === 'complete_trial_universe' &&
    entry.metrics.trialLedgerRawMComplete === true &&
    entry.metrics.trialLedgerIncludesFailedTrials === true,
  )
}

function summarizeTrialLedgerReadinessGaps(entries: TrialLedgerEntry[]): TrialLedgerReport['readinessGaps'] {
  const includedEntries = entries.filter(entry => entry.includedInRawM)
  const includedRawMTrials = entries.filter(entry => entry.includedInRawM).length
  const visibleFailedTrials = entries.filter(entry => entry.status === 'graveyard' || entry.status === 'killed').length
  const visibleSurvivingTrials = entries.filter(entry => entry.status === 'active' || entry.status === 'registered').length
  const missingPValueTrials = entries.filter(entry => entry.includedInRawM && promotionGradePValueMetric(entry) == null).length
  const invalidPValueTrials = entries.filter(entry => {
    const raw = (entry.metrics as Record<string, unknown>).pValue
    return raw != null && numericMetric(raw) == null
  }).length
  const completeTrialUniverseMarkers = entries.filter(entry =>
    hasCompleteTrialUniverseMarker([entry]),
  ).length
  const failureCodes = new Map<string, number>()
  for (const entry of includedEntries) {
    for (const code of entryFailureCodes(entry)) {
      failureCodes.set(code, (failureCodes.get(code) ?? 0) + 1)
    }
  }
  const topFailureCodes = [...failureCodes.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
    .slice(0, 10)
  const missingFdrReportTrials = failureCodes.get('MISSING_FDR_REPORT') ?? 0
  const fdrInputsIncompleteTrials = failureCodes.get('FDR_INPUTS_INCOMPLETE') ?? 0
  const fdrReportPresentTrials = entries.filter(entry => typeof entry.metrics.fdrReportPath === 'string' && entry.metrics.fdrReportPath.length > 0).length
  const fdrReportBlockedTrials = entries.filter(entry => {
    const status = entry.metrics.fdrReportStatus
    return typeof status === 'string' && status !== 'ready_explanatory_only'
  }).length
  const missingFdrReportPathTrials = entries.filter(entry =>
    entry.source === 'runtime_trial_registry' &&
    entry.includedInRawM &&
    typeof entry.metrics.fdrReportPath !== 'string',
  ).length
  const pitAuditNotImplementedTrials = failureCodes.get('PIT_AUDIT_NOT_IMPLEMENTED') ?? 0
  const pitProxyOnlyTrials = failureCodes.get('PIT_PROXY_ONLY') ?? 0
  const missingPitAuditMetadataTrials = entries.filter(entry =>
    entry.source === 'runtime_trial_registry' &&
    entry.includedInRawM &&
    typeof entry.metrics.pitAuditStatus !== 'string',
  ).length
  const fdrPValueAvailableTrials = entries.filter(entry =>
    entry.includedInRawM &&
    promotionGradePValueMetric(entry) != null,
  ).length
  const fdrPValueUnavailableTrials = entries.filter(entry =>
    entry.includedInRawM &&
    promotionGradePValueMetric(entry) == null &&
    (
      entry.metrics.fdrPValuesAvailable === false ||
      numericMetric(entry.metrics.fdrMissingPValueCount) != null && Number(entry.metrics.fdrMissingPValueCount) > 0 ||
      numericMetric(entry.metrics.pValue) != null && entry.metrics.fdrPValueIsPromotionGrade === false
    ),
  ).length
  const fdrPValueNonPromotionGradeTrials = entries.filter(entry =>
    entry.includedInRawM &&
    numericMetric(entry.metrics.pValue) != null &&
    entry.metrics.fdrPValueIsPromotionGrade === false,
  ).length
  const pValueUnavailableReasonCounts = countMetricStringValues(
    entries,
    'fdrPValueBlockedReason',
    'unspecified',
    entry => entry.includedInRawM && promotionGradePValueMetric(entry) == null,
  )
  const fdrBlockedReasonCounts = countMetricStringValues(
    entries,
    'fdrReportStatus',
    'missing_fdr_report_status',
    entry => entry.includedInRawM && (
      typeof entry.metrics.fdrReportStatus !== 'string' ||
      entry.metrics.fdrReportStatus !== 'ready_explanatory_only'
    ),
  )
  const blockerSummary: string[] = []
  if (completeTrialUniverseMarkers === 0) blockerSummary.push('missing_complete_trial_universe_marker')
  if (missingPValueTrials > 0) blockerSummary.push(`missing_p_value_trials:${missingPValueTrials}`)
  if (missingFdrReportTrials > 0) blockerSummary.push(`missing_fdr_report_trials:${missingFdrReportTrials}`)
  if (missingFdrReportPathTrials > 0) blockerSummary.push(`missing_fdr_report_path_trials:${missingFdrReportPathTrials}`)
  if (fdrInputsIncompleteTrials > 0) blockerSummary.push(`fdr_inputs_incomplete_trials:${fdrInputsIncompleteTrials}`)
  if (pitAuditNotImplementedTrials > 0) blockerSummary.push(`pit_audit_not_implemented_trials:${pitAuditNotImplementedTrials}`)
  if (pitProxyOnlyTrials > 0) blockerSummary.push(`pit_proxy_only_trials:${pitProxyOnlyTrials}`)
  if (missingPitAuditMetadataTrials > 0) blockerSummary.push(`missing_pit_audit_metadata_trials:${missingPitAuditMetadataTrials}`)
  if (fdrPValueNonPromotionGradeTrials > 0) blockerSummary.push(`fdr_p_value_non_promotion_grade_trials:${fdrPValueNonPromotionGradeTrials}`)
  if (invalidPValueTrials > 0) blockerSummary.push(`invalid_p_value_trials:${invalidPValueTrials}`)
  return {
    includedRawMTrials,
    visibleFailedTrials,
    visibleSurvivingTrials,
    missingPValueTrials,
    missingFdrReportTrials,
    fdrInputsIncompleteTrials,
    fdrReportPresentTrials,
    fdrReportBlockedTrials,
    missingFdrReportPathTrials,
    pitAuditNotImplementedTrials,
    pitProxyOnlyTrials,
    missingPitAuditMetadataTrials,
    fdrPValueAvailableTrials,
    fdrPValueUnavailableTrials,
    fdrPValueNonPromotionGradeTrials,
    completeTrialUniverseMarkers,
    invalidPValueTrials,
    pValueUnavailableReasonCounts,
    fdrBlockedReasonCounts,
    topFailureCodes,
    blockerSummary,
  }
}

export function buildTrialSourceCoverageReport(input: {
  trialLedger: TrialLedgerReport
  generatedAt?: string
}): TrialSourceCoverageReport {
  const entries = input.trialLedger.entries
  const bySource = buildTrialSourceCoverageBuckets(entries, entry => entry.source)
  const byFamily = buildTrialSourceCoverageBuckets(entries, entry => entry.familyId)
  const bySourceFamily = buildTrialSourceCoverageBuckets(entries, entry => `${entry.source}|${entry.familyId}`)
  const summary = buildTrialSourceCoverageBucket('all', entries)
  const runtimeRegistryDiagnostics = buildRuntimeTrialRegistryDiagnostics(entries)
  const nextPatchTargets = bySourceFamily
    .filter(bucket =>
      bucket.missingPValueTrials > 0 ||
      bucket.missingFdrReportTrials > 0 ||
      bucket.missingFdrReportPathTrials > 0 ||
      bucket.fdrInputsIncompleteTrials > 0 ||
      bucket.pitAuditNotImplementedTrials > 0 ||
      bucket.pitProxyOnlyTrials > 0 ||
      bucket.missingPitAuditMetadataTrials > 0 ||
      bucket.fdrPValueNonPromotionGradeTrials > 0,
    )
    .sort(compareTrialSourceCoverageBuckets)
    .slice(0, 12)
    .map((bucket, index) => {
      const { source, familyId } = splitSourceFamilyKey(bucket.key)
      return {
        rank: index + 1,
        source,
        familyId,
        entries: bucket.entries,
        missingPValueTrials: bucket.missingPValueTrials,
        missingFdrReportTrials: bucket.missingFdrReportTrials,
        missingFdrReportPathTrials: bucket.missingFdrReportPathTrials,
        fdrInputsIncompleteTrials: bucket.fdrInputsIncompleteTrials,
        pitAuditNotImplementedTrials: bucket.pitAuditNotImplementedTrials,
        pitProxyOnlyTrials: bucket.pitProxyOnlyTrials,
        missingPitAuditMetadataTrials: bucket.missingPitAuditMetadataTrials,
        fdrPValueAvailableTrials: bucket.fdrPValueAvailableTrials,
        fdrPValueUnavailableTrials: bucket.fdrPValueUnavailableTrials,
        fdrPValueNonPromotionGradeTrials: bucket.fdrPValueNonPromotionGradeTrials,
        topFailureCodes: bucket.topFailureCodes,
        primaryBlockers: bucket.primaryBlockers,
        recommendedPatchPoint: recommendedTrialSourcePatchPoint(source),
        recommendedAction: recommendedTrialSourceAction(source, bucket),
      }
    })
  const status: TrialSourceCoverageReport['status'] = summary.primaryBlockers.length > 0 ? 'blocked' : 'clear'
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? input.trialLedger.generatedAt,
    diagnosticOnly: true,
    promotionEligible: false,
    status,
    sourceArtifact: 'trial_ledger',
    summary,
    bySource,
    byFamily,
    bySourceFamily,
    runtimeRegistryDiagnostics,
    sourceDiagnostics: input.trialLedger.sourceDiagnostics,
    nextPatchTargets,
    notes: [
      'Diagnostic-only coverage report for P1-A. It explains where missing p-values, FDR artifacts, and PIT audit gaps originate.',
      'This report must not synthesize p-values, complete-trial-universe markers, or promotion eligibility.',
      'raw_m remains visible_sources_only until a complete registered trial universe including failed trials is genuinely available.',
    ],
  }
}

function buildTrialSourceCoverageBuckets(
  entries: TrialLedgerEntry[],
  keyFn: (entry: TrialLedgerEntry) => string,
): TrialSourceCoverageBucket[] {
  const groups = new Map<string, TrialLedgerEntry[]>()
  for (const entry of entries) {
    const key = keyFn(entry) || 'unknown'
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  return [...groups.entries()]
    .map(([key, group]) => buildTrialSourceCoverageBucket(key, group))
    .sort(compareTrialSourceCoverageBuckets)
}

function buildTrialSourceCoverageBucket(key: string, entries: TrialLedgerEntry[]): TrialSourceCoverageBucket {
  const includedEntries = entries.filter(entry => entry.includedInRawM)
  const failureCodesByEntry = includedEntries.map(entry => entryFailureCodes(entry))
  const countFailureCode = (code: string) => failureCodesByEntry.filter(codes => codes.includes(code)).length
  const failureCodes = new Map<string, number>()
  for (const codes of failureCodesByEntry) {
    for (const code of codes) failureCodes.set(code, (failureCodes.get(code) ?? 0) + 1)
  }
  const topFailureCodes = [...failureCodes.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
    .slice(0, 10)
  const missingPValueTrials = entries.filter(entry => entry.includedInRawM && promotionGradePValueMetric(entry) == null).length
  const invalidPValueTrials = entries.filter(entry => {
    const raw = (entry.metrics as Record<string, unknown>).pValue
    return raw != null && numericMetric(raw) == null
  }).length
  const missingFdrReportTrials = countFailureCode('MISSING_FDR_REPORT')
  const fdrInputsIncompleteTrials = countFailureCode('FDR_INPUTS_INCOMPLETE')
  const pitAuditNotImplementedTrials = countFailureCode('PIT_AUDIT_NOT_IMPLEMENTED')
  const pitProxyOnlyTrials = countFailureCode('PIT_PROXY_ONLY')
  const fdrReportPresentTrials = entries.filter(entry => typeof entry.metrics.fdrReportPath === 'string' && entry.metrics.fdrReportPath.length > 0).length
  const fdrReportBlockedTrials = entries.filter(entry => {
    const status = entry.metrics.fdrReportStatus
    return typeof status === 'string' && status !== 'ready_explanatory_only'
  }).length
  const missingFdrReportPathTrials = entries.filter(entry =>
    entry.source === 'runtime_trial_registry' &&
    entry.includedInRawM &&
    typeof entry.metrics.fdrReportPath !== 'string',
  ).length
  const completeTrialUniverseMarkers = entries.filter(entry => hasCompleteTrialUniverseMarker([entry])).length
  const missingPitAuditMetadataTrials = entries.filter(entry =>
    entry.source === 'runtime_trial_registry' &&
    entry.includedInRawM &&
    typeof entry.metrics.pitAuditStatus !== 'string',
  ).length
  const fdrPValueAvailableTrials = entries.filter(entry =>
    entry.includedInRawM &&
    promotionGradePValueMetric(entry) != null,
  ).length
  const fdrPValueUnavailableTrials = entries.filter(entry =>
    entry.includedInRawM &&
    promotionGradePValueMetric(entry) == null &&
    (
      entry.metrics.fdrPValuesAvailable === false ||
      numericMetric(entry.metrics.fdrMissingPValueCount) != null && Number(entry.metrics.fdrMissingPValueCount) > 0 ||
      numericMetric(entry.metrics.pValue) != null && entry.metrics.fdrPValueIsPromotionGrade === false
    ),
  ).length
  const fdrPValueNonPromotionGradeTrials = entries.filter(entry =>
    entry.includedInRawM &&
    numericMetric(entry.metrics.pValue) != null &&
    entry.metrics.fdrPValueIsPromotionGrade === false,
  ).length
  const pValueUnavailableReasonCounts = countMetricStringValues(
    entries,
    'fdrPValueBlockedReason',
    'unspecified',
    entry => entry.includedInRawM && promotionGradePValueMetric(entry) == null,
  )
  const fdrBlockedReasonCounts = countMetricStringValues(
    entries,
    'fdrReportStatus',
    'missing_fdr_report_status',
    entry => entry.includedInRawM && (
      typeof entry.metrics.fdrReportStatus !== 'string' ||
      entry.metrics.fdrReportStatus !== 'ready_explanatory_only'
    ),
  )
  const primaryBlockers: string[] = []
  if (completeTrialUniverseMarkers === 0) primaryBlockers.push('missing_complete_trial_universe_marker')
  if (missingPValueTrials > 0) primaryBlockers.push(`missing_p_value_trials:${missingPValueTrials}`)
  if (missingFdrReportTrials > 0) primaryBlockers.push(`missing_fdr_report_trials:${missingFdrReportTrials}`)
  if (missingFdrReportPathTrials > 0) primaryBlockers.push(`missing_fdr_report_path_trials:${missingFdrReportPathTrials}`)
  if (fdrInputsIncompleteTrials > 0) primaryBlockers.push(`fdr_inputs_incomplete_trials:${fdrInputsIncompleteTrials}`)
  if (pitAuditNotImplementedTrials > 0) primaryBlockers.push(`pit_audit_not_implemented_trials:${pitAuditNotImplementedTrials}`)
  if (pitProxyOnlyTrials > 0) primaryBlockers.push(`pit_proxy_only_trials:${pitProxyOnlyTrials}`)
  if (missingPitAuditMetadataTrials > 0) primaryBlockers.push(`missing_pit_audit_metadata_trials:${missingPitAuditMetadataTrials}`)
  if (fdrPValueNonPromotionGradeTrials > 0) primaryBlockers.push(`fdr_p_value_non_promotion_grade_trials:${fdrPValueNonPromotionGradeTrials}`)
  if (invalidPValueTrials > 0) primaryBlockers.push(`invalid_p_value_trials:${invalidPValueTrials}`)
  return {
    key,
    entries: entries.length,
    includedRawMTrials: entries.filter(entry => entry.includedInRawM).length,
    includedEffectiveMTrials: entries.filter(entry => entry.includedInEffectiveM).length,
    visibleFailedTrials: entries.filter(entry => entry.status === 'graveyard' || entry.status === 'killed').length,
    visibleSurvivingTrials: entries.filter(entry => entry.status === 'active' || entry.status === 'registered').length,
    missingPValueTrials,
    invalidPValueTrials,
    missingFdrReportTrials,
    fdrInputsIncompleteTrials,
    fdrReportPresentTrials,
    fdrReportBlockedTrials,
    missingFdrReportPathTrials,
    pitAuditNotImplementedTrials,
    pitProxyOnlyTrials,
    missingPitAuditMetadataTrials,
    fdrPValueAvailableTrials,
    fdrPValueUnavailableTrials,
    fdrPValueNonPromotionGradeTrials,
    completeTrialUniverseMarkers,
    pValueUnavailableReasonCounts,
    fdrBlockedReasonCounts,
    topFailureCodes,
    primaryBlockers,
  }
}

function compareTrialSourceCoverageBuckets(left: TrialSourceCoverageBucket, right: TrialSourceCoverageBucket): number {
  const leftScore = trialSourceCoverageBlockerScore(left)
  const rightScore = trialSourceCoverageBlockerScore(right)
  return rightScore - leftScore ||
    right.missingPValueTrials - left.missingPValueTrials ||
    right.entries - left.entries ||
    left.key.localeCompare(right.key)
}

function trialSourceCoverageBlockerScore(bucket: TrialSourceCoverageBucket): number {
  return bucket.missingPValueTrials +
    bucket.missingFdrReportTrials +
    bucket.missingFdrReportPathTrials +
    bucket.fdrInputsIncompleteTrials +
    bucket.pitAuditNotImplementedTrials +
    bucket.pitProxyOnlyTrials +
    bucket.missingPitAuditMetadataTrials +
    bucket.fdrPValueNonPromotionGradeTrials +
    bucket.invalidPValueTrials
}

function buildRuntimeTrialRegistryDiagnostics(entries: TrialLedgerEntry[]): RuntimeTrialRegistryDiagnostics {
  const runtimeEntries = entries.filter(entry => entry.source === 'runtime_trial_registry')
  const included = runtimeEntries.filter(entry => entry.includedInRawM)
  const quarantinedTestHarnessRows = runtimeEntries.filter(entry =>
    entry.metrics.rawMExclusionReason === 'quarantined_test_harness_runtime_trial_registry_leak'
  ).length
  const duplicateRerunRowsExcludedFromRawM = runtimeEntries.filter(entry =>
    entry.metrics.rawMExclusionReason === 'duplicate_runtime_trial_registry_rerun',
  ).length
  const duplicateRerunGroups = new Set(runtimeEntries
    .filter(entry => entry.metrics.rawMExclusionReason === 'duplicate_runtime_trial_registry_rerun')
    .map(entry => entry.metrics.duplicateGroupKeyHash)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)).size
  const rowsWithFdrReportPath = included.filter(entry => typeof entry.metrics.fdrReportPath === 'string').length
  const rowsMissingFdrReportPath = included.length - rowsWithFdrReportPath
  const rowsWithExistingFdrReportPath = included.filter(entry =>
    typeof entry.metrics.fdrReportPath === 'string' &&
    existsSync(entry.metrics.fdrReportPath),
  ).length
  const rowsWithMissingFdrReportFile = included.filter(entry =>
    typeof entry.metrics.fdrReportPath === 'string' &&
    !existsSync(entry.metrics.fdrReportPath),
  ).length
  const rowsWithFdrReportStatus = included.filter(entry => typeof entry.metrics.fdrReportStatus === 'string').length
  const rowsMissingFdrReportStatus = included.length - rowsWithFdrReportStatus
  const rowsWithPitAuditStatus = included.filter(entry => typeof entry.metrics.pitAuditStatus === 'string').length
  const rowsMissingPitAuditStatus = included.length - rowsWithPitAuditStatus
  const rowsWithPitAuditPromotionGrade = included.filter(entry => typeof entry.metrics.pitAuditPromotionGrade === 'boolean').length
  const rowsWithPromotionGradePitAudit = included.filter(entry => entry.metrics.pitAuditPromotionGrade === true).length
  const rowsWithRegistryPValue = included.filter(entry => entry.metrics.pValueSource === 'registry_row').length
  const rowsWithArtifactPValue = included.filter(entry => entry.metrics.pValueSource === 'fdr_report').length
  const rowsMissingPValueBecauseFdrArtifactMissing = included.filter(entry =>
    entry.metrics.pValueSource === 'missing' && entry.metrics.fdrReportPathSource === 'missing',
  ).length
  const rowsWithExplanatoryOnlyPValue = included.filter(entry =>
    numericMetric(entry.metrics.pValue) != null && entry.metrics.fdrPValueIsPromotionGrade === false,
  ).length
  const rowsWithMetadataFdrReportPath = included.filter(entry => entry.metrics.fdrReportPathSource === 'registry_metadata').length
  const rowsWithArtifactLinkedFdrReport = included.filter(entry => entry.metrics.fdrReportPathSource === 'artifact_link').length
  const rowsWithBlockedPitAudit = included.filter(entry =>
    typeof entry.metrics.pitAuditStatus === 'string' && entry.metrics.pitAuditStatus !== 'pass',
  ).length
  const rowsWithDefaultFailClosedPitPromotionGrade = included.filter(entry =>
    entry.metrics.pitAuditPromotionGradeSource === 'default_fail_closed',
  ).length
  const repairBuckets = [
    {
      bucket: 'historical_missing_fdr_report_path',
      count: rowsMissingFdrReportPath,
      action: 'keep_missing_unless a deterministic artifact path can be linked from existing evidence; do not synthesize reports',
    },
    {
      bucket: 'fdr_report_path_file_missing',
      count: rowsWithMissingFdrReportFile,
      action: 'repair artifact retention or mark as stale_link; do not count as present FDR evidence',
    },
    {
      bucket: 'missing_pit_audit_metadata',
      count: rowsMissingPitAuditStatus,
      action: 'patch runtime/research/trial_registry.jsonl writer to emit pit_audit_status/blocking_codes/proxy_type/promotion_grade for new rows',
    },
    {
      bucket: 'pit_proxy_or_blocked',
      count: included.filter(entry => {
        const status = String(entry.metrics.pitAuditStatus ?? '')
        const blockingCodes = String(entry.metrics.pitAuditBlockingCodes ?? '')
        return entry.metrics.pitAuditPromotionGrade !== true &&
          (status.length > 0 || blockingCodes.includes('PIT_PROXY_ONLY') || blockingCodes.includes('PIT_AUDIT_NOT_IMPLEMENTED'))
      }).length,
      action: 'keep fail-closed until row-level PIT feature availability audit is promotion-grade',
    },
    {
      bucket: 'non_promotion_grade_fdr_pvalue',
      count: included.filter(entry =>
        numericMetric(entry.metrics.pValue) != null &&
        entry.metrics.fdrPValueIsPromotionGrade === false,
      ).length,
      action: 'treat explanatory p-values as diagnostics only; promotion requires complete raw_m and promotion-grade p-values',
    },
    {
      bucket: 'duplicate_runtime_trial_registry_rerun',
      count: duplicateRerunRowsExcludedFromRawM,
      action: 'keep duplicate reruns as provenance only; raw_m counts unique evidence_id/fdr_family/candidate_id rows',
    },
  ].filter(bucket => bucket.count > 0)
  return {
    source: 'runtime_trial_registry',
    diagnosticOnly: true,
    promotionEligible: false,
    entries: runtimeEntries.length,
    includedRawMTrials: included.length,
    quarantinedTestHarnessRows,
    duplicateRerunGroups,
    duplicateRerunRowsExcludedFromRawM,
    rowsWithRegistryPValue,
    rowsWithArtifactPValue,
    rowsMissingPValueBecauseFdrArtifactMissing,
    rowsWithExplanatoryOnlyPValue,
    rowsWithMetadataFdrReportPath,
    rowsWithArtifactLinkedFdrReport,
    rowsWithBlockedPitAudit,
    rowsWithDefaultFailClosedPitPromotionGrade,
    metadataCoverage: {
      rowsWithFdrReportPath,
      rowsMissingFdrReportPath,
      rowsWithExistingFdrReportPath,
      rowsWithMissingFdrReportFile,
      rowsWithFdrReportStatus,
      rowsMissingFdrReportStatus,
      rowsWithPitAuditStatus,
      rowsMissingPitAuditStatus,
      rowsWithPitAuditPromotionGrade,
      rowsWithPromotionGradePitAudit,
    },
    pValueSourceCounts: countMetricStringStatuses(included, 'pValueSource', 'missing', () => true)
      .map(({ status, count }) => ({ source: status, count })),
    fdrReportPathSourceCounts: countMetricStringStatuses(included, 'fdrReportPathSource', 'missing', () => true)
      .map(({ status, count }) => ({ source: status, count })),
    pitAuditSourceCounts: countMetricStringStatuses(included, 'pitAuditSource', 'missing', () => true)
      .map(({ status, count }) => ({ source: status, count })),
    pitAuditPromotionGradeSourceCounts: countMetricStringStatuses(included, 'pitAuditPromotionGradeSource', 'missing', () => true)
      .map(({ status, count }) => ({ source: status, count })),
    fdrReportPathStatusCounts: countRuntimeFdrReportPathStatuses(included),
    fdrReportStatusCounts: countMetricStringStatuses(
      included,
      'fdrReportStatus',
      'missing_fdr_report_status',
      () => true,
    ),
    pitAuditStatusCounts: countMetricStringStatuses(
      included,
      'pitAuditStatus',
      'missing_pit_audit_status',
      () => true,
    ),
    pitAuditPromotionGradeCounts: countRuntimePitPromotionGradeStatuses(included),
    repairBuckets,
    notes: [
      'Read-only runtime registry diagnostics. Missing historical metadata remains missing unless an existing deterministic artifact can be linked.',
      'Rows from local validation test harness temp outputs are quarantined as provenance-only and excluded from raw_m; tests must pass an isolated trialRegistryPath.',
      'Duplicate runtime registry reruns with the same evidence_id/fdr_family/candidate_id are retained as provenance but excluded from raw_m inflation.',
      'Existing fdr_report_path only proves an artifact link exists; fdr_report_status and p_value_is_promotion_grade still control evidence quality.',
      'PIT proxy or missing PIT audit metadata must remain promotion-blocking.',
    ],
  }
}

function countRuntimeFdrReportPathStatuses(entries: TrialLedgerEntry[]): Array<{ status: string; count: number }> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const path = entry.metrics.fdrReportPath
    const status = typeof path !== 'string'
      ? 'missing_path'
      : existsSync(path)
        ? 'path_exists'
        : 'path_missing_file'
    counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((left, right) => right.count - left.count || left.status.localeCompare(right.status))
}

function countRuntimePitPromotionGradeStatuses(entries: TrialLedgerEntry[]): Array<{ status: string; count: number }> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const value = entry.metrics.pitAuditPromotionGrade
    const status = typeof value === 'boolean' ? String(value) : 'missing'
    counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((left, right) => right.count - left.count || left.status.localeCompare(right.status))
}

function countMetricStringStatuses(
  entries: TrialLedgerEntry[],
  metricKey: string,
  fallback: string,
  include: (entry: TrialLedgerEntry) => boolean,
): Array<{ status: string; count: number }> {
  return countMetricStringValues(entries, metricKey, fallback, include)
    .map(({ reason, count }) => ({ status: reason, count }))
}

function countMetricStringValues(
  entries: TrialLedgerEntry[],
  metricKey: string,
  fallback: string,
  include: (entry: TrialLedgerEntry) => boolean,
): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (!include(entry)) continue
    const raw = entry.metrics[metricKey]
    const reason = typeof raw === 'string' && raw.trim().length > 0 ? raw : fallback
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
}

function splitSourceFamilyKey(key: string): { source: string; familyId: string } {
  const separator = key.indexOf('|')
  if (separator < 0) return { source: key, familyId: 'unknown' }
  return {
    source: key.slice(0, separator) || 'unknown',
    familyId: key.slice(separator + 1) || 'unknown',
  }
}

function recommendedTrialSourcePatchPoint(source: string): string {
  if (source === 'runtime_trial_registry') {
    return 'src/evidence/trial_registry.ts buildCompleteTrialUniverseMarkerRecord plus runtime/research/trial_registry.jsonl writer/read-side diagnostics: annotate p_value/FDR/PIT provenance; preserve historical missing artifacts; only future rows may link deterministic promotion-grade FDR/PIT evidence'
  }
  if (source === 'optimization_sweep') {
    return 'optimization sweep writer: register every scanned parameter row, not only topConfigs, and emit trial-level p-values when statistically valid'
  }
  if (source === 'new_strategy_validation') {
    return 'new strategy validation writer: attach validation p-values or mark rows excluded from FDR with explicit rationale'
  }
  if (source === 'candidate_registry' || source === 'graveyard') {
    return `${source} writer: preserve source trial_id/evidence_id and link to FDR/PIT reports instead of only survivor metadata`
  }
  if (source === 'alpha_hypothesis_registry') {
    return 'alpha hypothesis registry: keep as registered hypotheses; do not fabricate p-values before prospective evidence exists'
  }
  return `${source}: add source-specific p-value/FDR/PIT provenance before promotion use`
}

function recommendedTrialSourceAction(source: string, bucket: TrialSourceCoverageBucket): string {
  if (bucket.completeTrialUniverseMarkers === 0 && source !== 'alpha_hypothesis_registry') {
    if (source === 'runtime_trial_registry') {
      if (bucket.missingFdrReportPathTrials > 0) {
        return 'do_not_promote; preserve historical missing FDR links, and only new validation rows should attach deterministic fdr_report_path/status plus PIT audit metadata'
      }
      if (bucket.fdrPValueNonPromotionGradeTrials > 0 || bucket.pitProxyOnlyTrials > 0) {
        return 'do_not_promote; run only as diagnostics until complete trial universe and row-level promotion-grade PIT audit exist'
      }
    }
    if (source === 'optimization_sweep') {
      return 'patch sweep output to register every scanned parameter row, failed rows included, before calculating raw_m/effective_m or any BY FDR gate'
    }
    if (source === 'new_strategy_validation') {
      return 'patch validation artifacts to explicitly mark rows excluded_from_fdr or attach statistically valid p-values; keep current rows diagnostic-only'
    }
    if (source === 'candidate_registry' || source === 'graveyard') {
      return 'treat as survivor/graveyard provenance only until linked trial_id/evidence_id/FDR/PIT artifacts are available'
    }
  }
  if (bucket.missingPValueTrials > 0) {
    return 'collect or compute valid p-values from a complete registered trial universe; do not backfill synthetic p-values'
  }
  if (bucket.pitProxyOnlyTrials > 0 || bucket.pitAuditNotImplementedTrials > 0) {
    return 'upgrade producer to persist per-feature available_time <= decision_time proofs; proxy PIT evidence remains blocking'
  }
  if (bucket.fdrPValueNonPromotionGradeTrials > 0) {
    return 'keep explanatory p-values out of promotion gates; require promotion-grade FDR inputs first'
  }
  return 'no immediate patch target; keep diagnostic-only until global trial ledger blockers clear'
}

function splitFailureCodes(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  if (typeof value !== 'string') return []
  return value.split('|').map(item => item.trim()).filter(Boolean)
}

function entryFailureCodes(entry: TrialLedgerEntry): string[] {
  return [...new Set([
    ...splitFailureCodes(entry.metrics.failureCodes),
    ...splitFailureCodes(entry.metrics.pitAuditBlockingCodes),
  ])].sort()
}

function dedupeTrialLedgerEntries(entries: TrialLedgerEntry[]): TrialLedgerEntry[] {
  const seen = new Set<string>()
  const out: TrialLedgerEntry[] = []
  for (const entry of entries) {
    if (seen.has(entry.trialId)) continue
    seen.add(entry.trialId)
    out.push(entry)
  }
  return out
}

function loadVisibleTrialLedgerSources(input: {
  candidateRegistryPath: string
  graveyardPath: string
  bestConfigPath: string
  trialRegistryPath: string
  optimizationDir: string
  validationDir: string
  evidenceOutputRoot?: string
}): VisibleTrialLedgerSources {
  const diagnostics: TrialLedgerReport['sourceDiagnostics'] = []
  const entries: TrialLedgerEntry[] = []

  const candidate = loadCandidateRegistryTrialEntries(input.candidateRegistryPath, 'candidate_registry')
  diagnostics.push(candidate.diagnostic)
  entries.push(...candidate.entries)

  const graveyard = loadCandidateRegistryTrialEntries(input.graveyardPath, 'graveyard')
  diagnostics.push(graveyard.diagnostic)
  entries.push(...graveyard.entries)

  const bestConfig = loadBestConfigTrialEntry(input.bestConfigPath)
  diagnostics.push(bestConfig.diagnostic)
  entries.push(...bestConfig.entries)

  const runtimeTrialRegistry = loadRuntimeTrialRegistryEntries(
    input.trialRegistryPath,
    input.evidenceOutputRoot ?? 'runtime/research',
  )
  diagnostics.push(runtimeTrialRegistry.diagnostic)
  entries.push(...runtimeTrialRegistry.entries)

  const optimization = loadOptimizationSweepTrialEntries(input.optimizationDir)
  diagnostics.push(...optimization.diagnostics)
  entries.push(...optimization.entries)

  const validations = loadNewStrategyValidationTrialEntries(input.validationDir)
  diagnostics.push(...validations.diagnostics)
  entries.push(...validations.entries)

  return { entries, diagnostics }
}

function loadCandidateRegistryTrialEntries(
  path: string,
  source: 'candidate_registry' | 'graveyard',
): { entries: TrialLedgerEntry[]; diagnostic: TrialLedgerReport['sourceDiagnostics'][number] } {
  const parsed = readJsonFile(path)
  if (!parsed.ok) {
    return {
      entries: [],
      diagnostic: {
        source,
        path,
        status: parsed.status,
        recordsIn: 0,
        entriesEmitted: 0,
        notes: [parsed.note],
      },
    }
  }
  const root = asRecord(parsed.value)
  const rows = Array.isArray(root?.entries) ? root.entries.filter(isRecord) : []
  const entries = rows.map((row, index) => {
    const candidateId = stringOrNull(row.candidateId) ?? `${source}_candidate_${index}`
    const strategyId = stringOrNull(row.strategyId) ?? inferFamilyFromPolicyId(candidateId)
    const experimentId = stringOrNull(row.experimentId) ?? stringOrNull(root?.registryId) ?? 'unknown_experiment'
    const statusRaw = stringOrNull(row.status)
    const status: TrialLedgerEntry['status'] = source === 'graveyard'
      ? 'graveyard'
      : statusRaw === 'killed' || statusRaw === 'graveyard'
        ? 'graveyard'
        : statusRaw === 'active'
          ? 'active'
          : 'registered'
    const parameterHash = stringOrNull(row.parameterHash) ?? hashString(stableJson(row))
    return {
      trialId: `${source}:${candidateId}`,
      familyId: normalizeFamilyId(strategyId),
      policyId: candidateId,
      featureSetHash: hashString(`${strategyId}|${stringOrNull(row.scriptName) ?? source}`),
      universeHash: 'unknown_visible_source',
      parameterCluster: parameterHash.slice(0, 16),
      status,
      source,
      metrics: {
        experimentId,
        strategyId,
        generatedAt: stringOrNull(row.generatedAt),
        registryId: stringOrNull(root?.registryId),
        diagnosticOnly: true,
        fdrExclusionReason: `${source}_is_survivor_metadata_not_statistical_trial`,
      },
      includedInRawM: false,
      includedInEffectiveM: false,
    } satisfies TrialLedgerEntry
  })
  return {
    entries,
    diagnostic: {
      source,
      path,
      status: 'loaded',
      recordsIn: rows.length,
      entriesEmitted: entries.length,
      notes: [`visible ${source} rows are provenance only and are excluded from raw_m/effective_m until linked trial_id/evidence_id/FDR/PIT artifacts exist`],
    },
  }
}

function loadBestConfigTrialEntry(path: string): { entries: TrialLedgerEntry[]; diagnostic: TrialLedgerReport['sourceDiagnostics'][number] } {
  const parsed = readJsonFile(path)
  if (!parsed.ok) {
    return {
      entries: [],
      diagnostic: {
        source: 'best_config',
        path,
        status: parsed.status,
        recordsIn: 0,
        entriesEmitted: 0,
        notes: [parsed.note],
      },
    }
  }
  const root = asRecord(parsed.value)
  const config = asRecord(root?.config)
  if (!root || !config) {
    return {
      entries: [],
      diagnostic: {
        source: 'best_config',
        path,
        status: 'invalid',
        recordsIn: 1,
        entriesEmitted: 0,
        notes: ['missing config object'],
      },
    }
  }
  const parameterCluster = hashString(stableJson(config))
  const entry: TrialLedgerEntry = {
    trialId: `best_config:${parameterCluster}`,
    familyId: 'cross_sectional',
    policyId: 'best_config_cross_sectional',
    featureSetHash: hashString(Object.keys(config).sort().join('|')),
    universeHash: `asset_count:${numberOrNull(root.assetCount) ?? 'unknown'}`,
    parameterCluster,
    status: 'active',
    source: 'best_config',
    metrics: {
      assetCount: numberOrNull(root.assetCount),
      discoveredAt: stringOrNull(root.discoveredAt),
      dataStart: stringOrNull(asRecord(root.dataRange)?.start),
      dataEnd: stringOrNull(asRecord(root.dataRange)?.end),
      provenanceOnly: true,
    },
    includedInRawM: false,
    includedInEffectiveM: false,
  }
  return {
    entries: [entry],
    diagnostic: {
      source: 'best_config',
      path,
      status: 'loaded',
      recordsIn: 1,
      entriesEmitted: 0,
      notes: ['best config is survivor provenance only and is excluded from raw_m/effective_m to avoid double-counting selected winners'],
    },
  }
}

function loadRuntimeTrialRegistryEntries(
  path: string,
  evidenceOutputRoot: string,
): { entries: TrialLedgerEntry[]; diagnostic: TrialLedgerReport['sourceDiagnostics'][number] } {
  if (!existsSync(path)) {
    return {
      entries: [],
      diagnostic: {
        source: 'runtime_trial_registry',
        path,
        status: 'missing',
        recordsIn: 0,
        entriesEmitted: 0,
        notes: ['path missing'],
      },
    }
  }
  const lines = readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  const entries: TrialLedgerEntry[] = []
  const invalidNotes: string[] = []
  const seen = new Set<string>()
  for (const [index, line] of lines.entries()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      invalidNotes.push(`line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const row = asRecord(parsed)
    if (!row) {
      invalidNotes.push(`line ${index + 1}: expected object`)
      continue
    }
    const trialId = stringOrNull(row.trial_id) ?? stringOrNull(row.trialId)
    if (!trialId) {
      invalidNotes.push(`line ${index + 1}: missing trial_id`)
      continue
    }
    if (seen.has(trialId)) continue
    seen.add(trialId)
    entries.push(runtimeTrialRegistryRowToEntry(row, trialId, path, evidenceOutputRoot))
  }
  return {
    entries,
    diagnostic: {
      source: 'runtime_trial_registry',
      path,
      status: invalidNotes.length > 0 ? 'invalid' : 'loaded',
      recordsIn: lines.length,
      entriesEmitted: entries.length,
      notes: [
        'append-only runtime trial registry is counted as visible raw_m; missing parameter hashes keep it out of effective_m clustering',
        'p_value=null rows intentionally keep P1 FDR in skeleton_no_pvalues state',
        ...invalidNotes.slice(0, 5),
      ],
    },
  }
}

function excludeDuplicateRuntimeTrialRerunsFromRawM(entries: TrialLedgerEntry[]): TrialLedgerEntry[] {
  const candidates = entries
    .map((entry, index) => ({ entry, index, key: runtimeTrialRerunKey(entry) }))
    .filter(item => item.entry.includedInRawM && item.key != null)
  const grouped = new Map<string, typeof candidates>()
  for (const item of candidates) {
    grouped.set(item.key, [...(grouped.get(item.key) ?? []), item])
  }
  const canonicalIndexByKey = new Map<string, number>()
  for (const [key, items] of grouped.entries()) {
    if (items.length <= 1) continue
    const canonical = [...items].sort((left, right) => {
      const leftTime = isoTimeMs(left.entry.metrics.createdAt)
      const rightTime = isoTimeMs(right.entry.metrics.createdAt)
      return rightTime - leftTime || right.index - left.index
    })[0]
    canonicalIndexByKey.set(key, canonical.index)
  }
  if (canonicalIndexByKey.size === 0) return entries
  return entries.map((entry, index) => {
    const key = runtimeTrialRerunKey(entry)
    const canonicalIndex = key == null ? null : canonicalIndexByKey.get(key)
    if (key == null || canonicalIndex == null || canonicalIndex === index) return entry
    const canonical = entries[canonicalIndex]
    return {
      ...entry,
      includedInRawM: false,
      includedInEffectiveM: false,
      metrics: {
        ...entry.metrics,
        provenanceOnly: true,
        duplicateRuntimeTrialRegistryRerun: true,
        duplicateCanonicalTrialId: canonical.trialId,
        duplicateGroupKeyHash: hashString(key),
        rawMExclusionReason: 'duplicate_runtime_trial_registry_rerun',
      },
    }
  })
}

function runtimeTrialRerunKey(entry: TrialLedgerEntry): string | null {
  if (entry.source !== 'runtime_trial_registry') return null
  const evidenceId = stringOrNull(entry.metrics.evidenceId)
  const fdrFamily = stringOrNull(entry.metrics.fdrFamily)
  if (!evidenceId || !fdrFamily || !entry.policyId) return null
  return `${evidenceId}|${fdrFamily}|${entry.policyId}`
}

function isoTimeMs(value: unknown): number {
  if (typeof value !== 'string') return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

function runtimeTrialRegistryRowToEntry(
  row: Record<string, unknown>,
  trialId: string,
  path: string,
  evidenceOutputRoot: string,
): TrialLedgerEntry {
  const familyId = normalizeFamilyId(stringOrNull(row.strategy_family) ?? stringOrNull(row.familyId) ?? 'unknown_family')
  const policyId = stringOrNull(row.candidate_id) ?? stringOrNull(row.policyId) ?? trialId
  const statusRaw = stringOrNull(row.status)?.toLowerCase() ?? 'registered'
  const status: TrialLedgerEntry['status'] = statusRaw.includes('killed') || statusRaw.includes('blocked') || statusRaw.includes('failed')
    ? 'killed'
    : statusRaw.includes('graveyard')
      ? 'graveyard'
      : statusRaw.includes('active') || statusRaw.includes('passed')
        ? 'active'
        : 'registered'
  const failureCodes = Array.isArray(row.failure_codes)
    ? row.failure_codes.filter((item): item is string => typeof item === 'string')
    : []
  const secondaryMetrics = Array.isArray(row.secondary_metrics)
    ? row.secondary_metrics.filter((item): item is string => typeof item === 'string')
    : []
  const metadata = asRecord(row.metadata)
  const evidenceId = stringOrNull(row.evidence_id)
  const artifactLinks = loadRuntimeValidationArtifactLinks(evidenceId, evidenceOutputRoot)
  const fdrReport = artifactLinks.fdrReport
  const featureAvailabilityAudit = artifactLinks.featureAvailabilityAudit
  const pitAuditBlockingCodes = pitAuditBlockingCodesFromArtifact(featureAvailabilityAudit)
  const pitProxyAudit = asRecord(featureAvailabilityAudit?.row_level_proxy_audit)
  const artifactFdrReportPath = artifactLinks.fdrReportPath
  const artifactFeatureAvailabilityAuditPath = artifactLinks.featureAvailabilityAuditPath
  const registryPValue = numberOrNull(row.p_value)
  const artifactPValue = numberOrNull(fdrReport?.p_value)
  const metadataFdrReportPath = stringOrNull(metadata?.fdr_report_path ?? metadata?.fdrReportPath)
  const metadataPitAuditPath = stringOrNull(metadata?.pit_audit_path ?? metadata?.pitAuditPath ?? metadata?.feature_availability_audit_path ?? metadata?.featureAvailabilityAuditPath)
  const metadataPitPromotionGrade = booleanOrNull(metadata?.pit_audit_promotion_grade ?? metadata?.pitAuditPromotionGrade)
  const artifactPitPromotionGrade = booleanOrNull(pitProxyAudit?.promotion_grade)
  const explicitPValueSource = stringOrNull(metadata?.p_value_source ?? metadata?.pValueSource)
  const explicitFdrReportPathSource = stringOrNull(metadata?.fdr_report_path_source ?? metadata?.fdrReportPathSource)
  const explicitPitAuditSource = stringOrNull(metadata?.pit_audit_source ?? metadata?.pitAuditSource)
  const explicitPitAuditPromotionGradeSource = stringOrNull(metadata?.pit_audit_promotion_grade_source ?? metadata?.pitAuditPromotionGradeSource)
  const testHarnessLeak = isRuntimeValidationTestHarnessLeak(metadata)
  return {
    trialId: `runtime_trial_registry:${trialId}`,
    familyId,
    policyId,
    featureSetHash: hashString(`${familyId}|${stringOrNull(row.primary_metric) ?? 'unknown_primary_metric'}|${secondaryMetrics.join('|')}`),
    universeHash: hashString(stringOrNull(row.fdr_family) ?? 'unknown_fdr_family'),
    parameterCluster: hashString(`${policyId}|${stringOrNull(row.batch_id) ?? ''}|${stringOrNull(row.evidence_id) ?? ''}`),
    status,
    source: 'runtime_trial_registry',
    metrics: {
      evidenceId,
      trialType: stringOrNull(row.trial_type),
      fdrFamily: stringOrNull(row.fdr_family),
      pValue: registryPValue ?? artifactPValue,
      pValueSource: explicitPValueSource ?? (registryPValue != null ? 'registry_row' : artifactPValue != null ? 'fdr_report' : 'missing'),
      includedInFdr: booleanOrNull(row.included_in_fdr),
      promotionEligible: booleanOrNull(row.promotion_eligible),
      registryStatus: stringOrNull(row.status),
      failureCodes: failureCodes.join('|') || null,
      batchId: stringOrNull(row.batch_id),
      createdAt: stringOrNull(row.created_at),
      rawMComplete: booleanOrNull(row.raw_m_complete ?? row.rawMComplete),
      includesFailedTrials: booleanOrNull(row.includes_failed_trials ?? row.includesFailedTrials),
      trialUniverseMarker: booleanOrNull(metadata?.trial_universe_marker ?? metadata?.trialUniverseMarker),
      trialUniverseMarkerType: stringOrNull(metadata?.trial_universe_marker_type ?? metadata?.trialUniverseMarkerType),
      trialLedgerRawMComplete: booleanOrNull(metadata?.raw_m_complete ?? metadata?.rawMComplete),
      trialLedgerIncludesFailedTrials: booleanOrNull(metadata?.includes_failed_trials ?? metadata?.includesFailedTrials),
      fdrReportPath: metadataFdrReportPath ?? artifactFdrReportPath,
      fdrReportPathSource: explicitFdrReportPathSource ?? (metadataFdrReportPath != null ? 'registry_metadata' : artifactFdrReportPath != null ? 'artifact_link' : 'missing'),
      fdrReportStatus: stringOrNull(metadata?.fdr_report_status ?? metadata?.fdrReportStatus) ?? stringOrNull(fdrReport?.status),
      fdrPValuesAvailable: booleanOrNull(metadata?.fdr_p_values_available ?? metadata?.fdrPValuesAvailable) ?? booleanOrNull(fdrReport?.p_values_available),
      fdrMissingPValueCount: numberOrNull(metadata?.fdr_missing_p_value_count ?? metadata?.fdrMissingPValueCount) ?? numberOrNull(fdrReport?.missing_p_value_count),
      fdrPValueBlockedReason: stringOrNull(metadata?.fdr_p_value_blocked_reason ?? metadata?.fdrPValueBlockedReason) ?? fdrPValueBlockedReasonFromArtifact(fdrReport),
      fdrPValueMethod: stringOrNull(metadata?.fdr_p_value_method ?? metadata?.fdrPValueMethod) ?? stringOrNull(fdrReport?.p_value_method),
      fdrPValueScope: stringOrNull(metadata?.fdr_p_value_scope ?? metadata?.fdrPValueScope) ?? stringOrNull(fdrReport?.p_value_scope),
      fdrPValueIsPromotionGrade: booleanOrNull(metadata?.fdr_p_value_is_promotion_grade ?? metadata?.fdrPValueIsPromotionGrade) ?? booleanOrNull(fdrReport?.p_value_is_promotion_grade),
      fdrObservedMeanExcess: numberOrNull(metadata?.fdr_observed_mean_excess ?? metadata?.fdrObservedMeanExcess) ?? numberOrNull(fdrReport?.observed_mean_excess),
      fdrBootstrapSamples: numberOrNull(metadata?.fdr_bootstrap_samples ?? metadata?.fdrBootstrapSamples) ?? numberOrNull(fdrReport?.bootstrap_samples),
      fdrCandidateCount: numberOrNull(metadata?.fdr_candidate_count ?? metadata?.fdrCandidateCount) ?? numberOrNull(fdrReport?.raw_m),
      fdrHoldoutReturnCount: numberOrNull(metadata?.fdr_holdout_return_count ?? metadata?.fdrHoldoutReturnCount),
      pitAuditPath: metadataPitAuditPath ?? artifactFeatureAvailabilityAuditPath,
      pitAuditSource: explicitPitAuditSource ?? (metadataPitAuditPath != null ? 'registry_metadata' : artifactFeatureAvailabilityAuditPath != null ? 'artifact_link' : 'missing'),
      pitAuditStatus: stringOrNull(metadata?.pit_audit_status ?? metadata?.pitAuditStatus) ?? stringOrNull(featureAvailabilityAudit?.status),
      pitAuditBlockingCodes: Array.isArray(metadata?.pit_audit_blocking_codes)
        ? metadata.pit_audit_blocking_codes.filter((item): item is string => typeof item === 'string').join('|') || null
        : Array.isArray(metadata?.pitAuditBlockingCodes)
          ? metadata.pitAuditBlockingCodes.filter((item): item is string => typeof item === 'string').join('|') || null
          : pitAuditBlockingCodes.join('|') || null,
      pitAuditProxyType: stringOrNull(metadata?.pit_audit_proxy_type ?? metadata?.pitAuditProxyType) ?? stringOrNull(pitProxyAudit?.proxy_type),
      pitAuditPromotionGrade: metadataPitPromotionGrade ?? artifactPitPromotionGrade ?? false,
      pitAuditPromotionGradeSource: explicitPitAuditPromotionGradeSource ?? (metadataPitPromotionGrade != null
        ? 'registry_metadata'
        : artifactPitPromotionGrade != null
          ? 'artifact'
          : 'default_fail_closed'),
      sourcePathHash: hashString(path),
      artifactLinkedFdrReport: artifactFdrReportPath != null,
      artifactLinkedPitAudit: artifactFeatureAvailabilityAuditPath != null,
      ...(testHarnessLeak
        ? {
            provenanceOnly: true,
            rawMExclusionReason: 'quarantined_test_harness_runtime_trial_registry_leak',
          }
        : {}),
    },
    includedInRawM: !testHarnessLeak && booleanOrNull(row.included_in_fdr) !== false,
    includedInEffectiveM: false,
  }
}

function isRuntimeValidationTestHarnessLeak(metadata: Record<string, unknown> | null): boolean {
  const outputReportPath = stringOrNull(metadata?.output_report_path ?? metadata?.outputReportPath)
  if (!outputReportPath) return false
  return /(?:^|[/\\])oa-validation-pipeline-[^/\\]+[/\\]validation\.json$/.test(outputReportPath)
}

function loadRuntimeValidationArtifactLinks(
  evidenceId: string | null,
  evidenceOutputRoot: string,
): RuntimeValidationArtifactLinks {
  if (!evidenceId) {
    return {
      fdrReportPath: null,
      fdrReport: null,
      featureAvailabilityAuditPath: null,
      featureAvailabilityAudit: null,
    }
  }
  const artifactDir = resolve(evidenceOutputRoot, 'validation', evidenceIdToPathKey(evidenceId))
  const fdrReportPath = join(artifactDir, 'fdr_report.json')
  const featureAvailabilityAuditPath = join(artifactDir, 'feature_availability_audit.json')
  const fdrReport = readEvidenceArtifactIfMatches(fdrReportPath, evidenceId)
  const featureAvailabilityAudit = readEvidenceArtifactIfMatches(featureAvailabilityAuditPath, evidenceId)
  return {
    fdrReportPath: fdrReport ? fdrReportPath : null,
    fdrReport,
    featureAvailabilityAuditPath: featureAvailabilityAudit ? featureAvailabilityAuditPath : null,
    featureAvailabilityAudit,
  }
}

function readEvidenceArtifactIfMatches(path: string, evidenceId: string): Record<string, unknown> | null {
  const parsed = readJsonFile(path)
  if (!parsed.ok) return null
  const root = asRecord(parsed.value)
  if (!root || stringOrNull(root.evidence_id ?? root.evidenceId) !== evidenceId) return null
  return root
}

function fdrPValueBlockedReasonFromArtifact(fdrReport: Record<string, unknown> | null): string | null {
  if (!fdrReport) return null
  const reasons = Array.isArray(fdrReport.blocking_reasons)
    ? fdrReport.blocking_reasons.filter(isRecord)
    : []
  for (const reason of reasons) {
    const observed = stringOrNull(reason.observed)
    if (
      observed &&
      observed !== 'raw_m_complete=false' &&
      observed !== 'includes_failed_trials=false'
    ) return observed
  }
  return null
}

function pitAuditBlockingCodesFromArtifact(featureAvailabilityAudit: Record<string, unknown> | null): string[] {
  if (!featureAvailabilityAudit) return []
  return Array.isArray(featureAvailabilityAudit.blocking_reasons)
    ? featureAvailabilityAudit.blocking_reasons
      .filter(isRecord)
      .map(reason => stringOrNull(reason.code))
      .filter((code): code is string => code != null)
    : []
}

function loadOptimizationSweepTrialEntries(dir: string): { entries: TrialLedgerEntry[]; diagnostics: TrialLedgerReport['sourceDiagnostics'] } {
  const files = listJsonFiles(dir, /^sweep_.*\.json$/)
  if (files.length === 0) {
    return {
      entries: [],
      diagnostics: [{
        source: 'optimization_sweep',
        path: dir,
        status: existsSync(dir) ? 'loaded' : 'missing',
        recordsIn: 0,
        entriesEmitted: 0,
        notes: [existsSync(dir) ? 'no sweep_*.json files found' : 'directory missing'],
      }],
    }
  }
  const entries: TrialLedgerEntry[] = []
  const diagnostics: TrialLedgerReport['sourceDiagnostics'] = []
  for (const path of files) {
    const parsed = readJsonFile(path)
    if (!parsed.ok) {
      diagnostics.push({
        source: 'optimization_sweep',
        path,
        status: parsed.status,
        recordsIn: 0,
        entriesEmitted: 0,
        notes: [parsed.note],
      })
      continue
    }
    const root = asRecord(parsed.value)
    const trialUniverse = asRecord(root?.trialUniverse)
    const trialUniverseTrials = Array.isArray(trialUniverse?.trials)
      ? trialUniverse.trials.filter(isRecord)
      : []
    const topConfigs = Array.isArray(root?.topConfigs) ? root.topConfigs.filter(isRecord) : []
    const candidateRows = trialUniverseTrials.length > 0
      ? trialUniverseTrials
      : Array.isArray(root?.allConfigs)
        ? root.allConfigs.filter(isRecord)
        : topConfigs
    const generatedAt = stringOrNull(root?.generatedAt)
    const experimentId = stringOrNull(root?.experimentId) ?? `optimization:${generatedAt ?? hashString(path)}`
    const completeForThisSweep = booleanOrNull(trialUniverse?.completeForThisSweep) === true
    const emitted = candidateRows.map((config, index) => sweepConfigToTrialEntry({
      config,
      index,
      generatedAt,
      experimentId,
      path,
      source: 'optimization_sweep',
      completeForThisSweep,
    }))
    entries.push(...emitted)
    const candidateCount = numberOrNull(root?.candidateCount)
    diagnostics.push({
      source: 'optimization_sweep',
      path,
      status: 'loaded',
      recordsIn: candidateCount ?? candidateRows.length,
      entriesEmitted: emitted.length,
      notes: [
        completeForThisSweep
          ? 'optimizer trialUniverse is complete for this sweep, including failed/non-top rows; p-values may still be unavailable'
          : candidateCount != null && candidateCount > candidateRows.length
            ? 'candidateCount exceeds emitted rows; missing failed/non-top parameter rows keep rawMComplete=false'
            : 'legacy optimizer visible rows only; failed/non-top parameter rows may be absent',
      ],
    })
  }
  return { entries, diagnostics }
}

function sweepConfigToTrialEntry(input: {
  config: Record<string, unknown>
  index: number
  generatedAt: string | null
  experimentId: string
  path: string
  source: string
  completeForThisSweep: boolean
}): TrialLedgerEntry {
  const trialId = stringOrNull(input.config.trialId ?? input.config.trial_id)
  const candidateId = stringOrNull(input.config.candidateId ?? input.config.candidate_id)
  const explicitParameterHash = stringOrNull(input.config.parameterHash ?? input.config.parameter_hash)
  const explicitStatus = stringOrNull(input.config.status)
  const explicitFailureCodes = Array.isArray(input.config.failureCodes)
    ? input.config.failureCodes.filter((item): item is string => typeof item === 'string')
    : Array.isArray(input.config.failure_codes)
      ? input.config.failure_codes.filter((item): item is string => typeof item === 'string')
      : []
  const parameterFields = Object.fromEntries(
    Object.entries(input.config)
      .filter(([key, value]) => !['signals', 'winRate', 'spreadCum', 'avgSpread', 'sharpeApprox', 'filteredCount', 'score'].includes(key) && (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean')),
  )
  const parameterCluster = explicitParameterHash ?? hashString(stableJson(parameterFields))
  const status: TrialLedgerEntry['status'] = explicitStatus === 'killed'
    ? 'killed'
    : explicitStatus === 'graveyard'
      ? 'graveyard'
      : 'active'
  return {
    trialId: `${input.source}:${trialId ?? `${input.experimentId}:candidate:${input.index}:${parameterCluster}`}`,
    familyId: 'cross_sectional',
    policyId: candidateId ?? `cross_sectional_optimizer_${parameterCluster}`,
    featureSetHash: hashString(Object.keys(parameterFields).sort().join('|') || 'cross_sectional_optimizer_config'),
    universeHash: 'unknown_visible_source',
    parameterCluster,
    status,
    source: input.source,
    metrics: {
      experimentId: input.experimentId,
      generatedAt: input.generatedAt,
      sourcePathHash: hashString(input.path),
      pValue: numberOrNull(input.config.pValue ?? input.config.p_value),
      fdrPValueBlockedReason: stringOrNull(input.config.pValueUnavailableReason ?? input.config.p_value_unavailable_reason),
      fdrReportStatus: stringOrNull(input.config.fdrReportStatus ?? input.config.fdr_report_status),
      fdrPValuesAvailable: booleanOrNull(input.config.fdrPValuesAvailable ?? input.config.fdr_p_values_available),
      fdrPValueIsPromotionGrade: booleanOrNull(input.config.fdrPValueIsPromotionGrade ?? input.config.fdr_p_value_is_promotion_grade),
      pitAuditStatus: stringOrNull(input.config.pitAuditStatus ?? input.config.pit_audit_status),
      pitAuditPromotionGrade: booleanOrNull(input.config.pitAuditPromotionGrade ?? input.config.pit_audit_promotion_grade),
      failureCodes: explicitFailureCodes.join('|') || null,
      diagnosticOnly: input.completeForThisSweep ? false : true,
      fdrExclusionReason: input.completeForThisSweep ? null : 'legacy_optimizer_visible_rows_only_not_complete_trial_universe',
      signals: numberOrNull(input.config.signals),
      winRate: numberOrNull(input.config.winRate),
      avgSpread: numberOrNull(input.config.avgSpread),
      sharpeApprox: numberOrNull(input.config.sharpeApprox),
      filteredCount: numberOrNull(input.config.filteredCount),
      score: numberOrNull(input.config.score),
    },
    includedInRawM: input.completeForThisSweep && booleanOrNull(input.config.includedInRawM ?? input.config.included_in_raw_m) !== false,
    includedInEffectiveM: input.completeForThisSweep && booleanOrNull(input.config.includedInEffectiveM ?? input.config.included_in_effective_m) !== false,
  }
}

function loadNewStrategyValidationTrialEntries(dir: string): { entries: TrialLedgerEntry[]; diagnostics: TrialLedgerReport['sourceDiagnostics'] } {
  const files = listJsonFiles(dir, /^validation_.*\.json$/)
  if (files.length === 0) {
    return {
      entries: [],
      diagnostics: [{
        source: 'new_strategy_validation',
        path: dir,
        status: existsSync(dir) ? 'loaded' : 'missing',
        recordsIn: 0,
        entriesEmitted: 0,
        notes: [existsSync(dir) ? 'no validation_*.json files found' : 'directory missing'],
      }],
    }
  }
  const entries: TrialLedgerEntry[] = []
  const diagnostics: TrialLedgerReport['sourceDiagnostics'] = []
  for (const path of files) {
    const parsed = readJsonFile(path)
    if (!parsed.ok) {
      diagnostics.push({
        source: 'new_strategy_validation',
        path,
        status: parsed.status,
        recordsIn: 0,
        entriesEmitted: 0,
        notes: [parsed.note],
      })
      continue
    }
    const root = asRecord(parsed.value)
    const generatedAt = stringOrNull(root?.generatedAt)
    const strategies = Array.isArray(root?.strategies) ? root.strategies.filter(isRecord) : []
    const emitted = strategies.map((strategy, index) => validationStrategyToTrialEntry({
      strategy,
      index,
      generatedAt,
      path,
    }))
    entries.push(...emitted)
    diagnostics.push({
      source: 'new_strategy_validation',
      path,
      status: 'loaded',
      recordsIn: strategies.length,
      entriesEmitted: emitted.length,
      notes: ['visible validation strategies only; does not include abandoned ad-hoc trials outside validation artifacts'],
    })
  }
  return { entries, diagnostics }
}

function validationStrategyToTrialEntry(input: {
  strategy: Record<string, unknown>
  index: number
  generatedAt: string | null
  path: string
}): TrialLedgerEntry {
  const strategy = stringOrNull(input.strategy.strategy) ?? `strategy_${input.index}`
  const symbol = stringOrNull(input.strategy.symbol) ?? 'unknown_symbol'
  const dateRange = asRecord(input.strategy.dateRange)
  const explicitTrialId = stringOrNull(input.strategy.trialId ?? input.strategy.trial_id)
  const explicitCandidateId = stringOrNull(input.strategy.candidateId ?? input.strategy.candidate_id)
  const explicitStatus = stringOrNull(input.strategy.status)
  const explicitFailureCodes = Array.isArray(input.strategy.failureCodes)
    ? input.strategy.failureCodes.filter((item): item is string => typeof item === 'string')
    : Array.isArray(input.strategy.failure_codes)
      ? input.strategy.failure_codes.filter((item): item is string => typeof item === 'string')
      : []
  const parameterCluster = hashString(`${strategy}|${symbol}|${dateRange?.start ?? ''}|${dateRange?.end ?? ''}`)
  const includedInRawM = booleanOrNull(input.strategy.includedInFdr ?? input.strategy.included_in_fdr) === true
  const includedInEffectiveM = includedInRawM && booleanOrNull(input.strategy.includedInEffectiveM ?? input.strategy.included_in_effective_m) !== false
  const status: TrialLedgerEntry['status'] = explicitStatus === 'killed' || explicitStatus === 'failed_validation'
    ? 'killed'
    : explicitStatus === 'graveyard'
      ? 'graveyard'
      : numberOrNull(input.strategy.trades) === 0
        ? 'registered'
        : 'active'
  return {
    trialId: explicitTrialId != null
      ? `new_strategy_validation:${explicitTrialId}`
      : `new_strategy_validation:${input.generatedAt ?? hashString(input.path)}:${strategy}:${symbol}:${parameterCluster}`,
    familyId: normalizeFamilyId(strategy),
    policyId: explicitCandidateId ?? `${strategy}_${symbol}`.replace(/[^A-Za-z0-9_:-]/g, '_'),
    featureSetHash: hashString(strategy),
    universeHash: hashString(symbol),
    parameterCluster,
    status,
    source: 'new_strategy_validation',
    metrics: {
      generatedAt: input.generatedAt,
      sourcePathHash: hashString(input.path),
      symbol,
      diagnosticOnly: booleanOrNull(input.strategy.diagnosticOnly ?? input.strategy.diagnostic_only),
      promotionEligible: booleanOrNull(input.strategy.promotionEligible ?? input.strategy.promotion_eligible),
      pValue: numberOrNull(input.strategy.pValue ?? input.strategy.p_value),
      fdrReportStatus: stringOrNull(input.strategy.fdrReportStatus ?? input.strategy.fdr_report_status),
      fdrPValuesAvailable: booleanOrNull(input.strategy.fdrPValuesAvailable ?? input.strategy.fdr_p_values_available),
      fdrMissingPValueCount: numberOrNull(input.strategy.fdrMissingPValueCount ?? input.strategy.fdr_missing_p_value_count),
      fdrPValueBlockedReason: stringOrNull(input.strategy.fdrPValueBlockedReason ?? input.strategy.fdr_p_value_blocked_reason ?? input.strategy.fdrExclusionReason ?? input.strategy.fdr_exclusion_reason),
      fdrPValueIsPromotionGrade: booleanOrNull(input.strategy.fdrPValueIsPromotionGrade ?? input.strategy.fdr_p_value_is_promotion_grade),
      pitAuditStatus: stringOrNull(input.strategy.pitAuditStatus ?? input.strategy.pit_audit_status),
      pitAuditPromotionGrade: booleanOrNull(input.strategy.pitAuditPromotionGrade ?? input.strategy.pit_audit_promotion_grade),
      failureCodes: explicitFailureCodes.join('|') || null,
      fdrExclusionReason: stringOrNull(input.strategy.fdrExclusionReason ?? input.strategy.fdr_exclusion_reason),
      trades: numberOrNull(input.strategy.trades),
      winRate: numberOrNull(input.strategy.winRate),
      totalReturnPct: numberOrNull(input.strategy.totalReturnPct),
      sharpe: numberOrNull(input.strategy.sharpe),
      netExpectancyPct: numberOrNull(input.strategy.netExpectancyPct),
      costDragPct: numberOrNull(input.strategy.costDragPct),
    },
    includedInRawM,
    includedInEffectiveM,
  }
}

function buildFdrDiagnostics(input: {
  entries: TrialLedgerEntry[]
  rawMComplete: boolean
  includesFailedTrials: boolean
}): TrialLedgerReport['fdrDiagnostics'] {
  const entries = input.entries
  const rawM = entries.filter(entry => entry.includedInRawM).length
  const effectiveM = new Set(entries
    .filter(entry => entry.includedInEffectiveM)
    .map(entry => `${entry.familyId}|${entry.featureSetHash}|${entry.universeHash}|${entry.parameterCluster}`)).size
  const harmonicRawM = harmonicNumber(rawM)
  const harmonicEffectiveM = harmonicNumber(effectiveM)
  const includedEntries = entries.filter(entry => entry.includedInRawM)
  const effectiveClusters = buildEffectivePValueClusters(entries)
  const pValueDiagnostics = includedEntries.map(entry => {
    const diagnosticPValue = numericMetric(entry.metrics.pValue)
    const nonPromotionGrade = diagnosticPValue != null && entry.metrics.fdrPValueIsPromotionGrade === false
    const pValue = promotionGradePValueMetric(entry)
    const eligibleForFdrComputation = pValue != null
    return {
      entry,
      pValue,
      diagnosticPValue,
      nonPromotionGrade,
      eligibleForFdrComputation,
    }
  })
  const fdrComputationEligibleEntries = pValueDiagnostics
    .filter(item => item.eligibleForFdrComputation)
    .map(item => item.entry)
  const finitePromotionGradePValues = pValueDiagnostics
    .filter(item => item.eligibleForFdrComputation)
    .map(item => item.pValue)
    .filter((value): value is number => value != null)
  const missingPValueEntries = pValueDiagnostics.filter(item => item.pValue == null && !item.nonPromotionGrade)
  const nonPromotionGradePValueEntries = pValueDiagnostics.filter(item => item.nonPromotionGrade)
  const hasAllPValues = pValueDiagnostics.length > 0 && missingPValueEntries.length === 0 && nonPromotionGradePValueEntries.length === 0
  const effectivePValues = effectiveClusters.map(cluster => cluster.pValue)
  const hasAllEffectivePValues = effectivePValues.every(value => value != null)
    && entries.every(entry => {
      if (!entry.includedInEffectiveM) return true
      const pValue = numericMetric(entry.metrics.pValue)
      return pValue != null && entry.metrics.fdrPValueIsPromotionGrade !== false
    })
  const canRunPromotionFdr = entries.length > 0 && input.rawMComplete && input.includesFailedTrials && hasAllPValues
  const pValues = finitePromotionGradePValues
  const effectivePValuesFinite = effectivePValues.filter((value): value is number => value != null)
  const fdrComputationM = canRunPromotionFdr ? pValues.length : 0
  const fdrComputationEffectiveM = canRunPromotionFdr && hasAllEffectivePValues ? effectivePValuesFinite.length : 0
  const byRaw = canRunPromotionFdr
    ? runLedgerBoundFdrCorrection({
        method: 'by',
        pValues,
        trialLedger: {
          rawM,
          effectiveM: effectiveM > 0 ? effectiveM : null,
          rawMComplete: true,
          includesFailedTrials: true,
          failedTrialCount: includedEntries.filter(entry => entry.status === 'graveyard' || entry.status === 'killed').length,
          survivingTrialCount: includedEntries.filter(entry => entry.status === 'active' || entry.status === 'registered').length,
          fdrMethodPrimary: 'BY_raw_m',
        },
      })
    : null
  const byEffective = canRunPromotionFdr && effectiveClusters.length > 0 && hasAllEffectivePValues
    ? runFdrCorrection({ method: 'by', pValues: effectivePValuesFinite })
    : null
  const bhSecondary = canRunPromotionFdr
    ? runFdrCorrection({ method: 'bh', pValues })
    : null
  const fdrIndexByTrialId = new Map<string, number>()
  fdrComputationEligibleEntries.forEach((entry, index) => fdrIndexByTrialId.set(entry.trialId, index))
  const effectiveFdrIndexByTrialId = new Map<string, number>()
  effectiveClusters.forEach((cluster, index) => {
    for (const trialId of cluster.trialIds) effectiveFdrIndexByTrialId.set(trialId, index)
  })
  const pValueEntries = entries.map(entry => {
    const fdrIndex = fdrIndexByTrialId.get(entry.trialId)
    const effectiveFdrIndex = effectiveFdrIndexByTrialId.get(entry.trialId)
    const diagnosticPValue = numericMetric(entry.metrics.pValue)
    const pValue = promotionGradePValueMetric(entry)
    const nonPromotionGrade = diagnosticPValue != null && entry.metrics.fdrPValueIsPromotionGrade === false
    const eligibleForFdrComputation = entry.includedInRawM &&
      pValue != null &&
      entry.metrics.fdrPValueIsPromotionGrade !== false
    const includedInFdrComputation = canRunPromotionFdr && eligibleForFdrComputation
    const fdrComputationExclusionReason = !entry.includedInRawM
      ? 'excluded_from_raw_m'
      : nonPromotionGrade
          ? 'p_value_not_promotion_grade'
          : pValue == null
            ? 'missing_p_value'
            : !input.rawMComplete || !input.includesFailedTrials
              ? 'complete_trial_universe_required'
              : !canRunPromotionFdr
                ? 'fdr_inputs_not_ready'
                : null
    const rawItem = fdrIndex == null ? null : byRaw?.items[fdrIndex] ?? null
    const effectiveItem = effectiveFdrIndex == null ? null : byEffective?.items[effectiveFdrIndex] ?? null
    const bhItem = fdrIndex == null ? null : bhSecondary?.items[fdrIndex] ?? null
    return {
      policyId: entry.policyId,
      pValue,
      diagnosticPValue,
      eligibleForFdrComputation,
      includedInFdrComputation,
      fdrComputationExclusionReason,
      pAdjustedBYRawM: rawItem?.qValue ?? null,
      pAdjustedBYEffectiveM: effectiveItem?.qValue ?? null,
      pAdjustedBHSecondary: bhItem?.qValue ?? null,
      promotionAllowed: false as const,
      reason: !entry.includedInRawM
        ? 'excluded_from_raw_m'
        : nonPromotionGrade
          ? 'p_value_not_promotion_grade'
          : pValue == null
            ? 'missing_p_value_p1_skeleton'
            : !input.rawMComplete || !input.includesFailedTrials
              ? 'complete_trial_universe_required_for_promotion_fdr'
              : canRunPromotionFdr
                ? 'p1_report_explanatory_only'
                : 'p1_fdr_blocked',
    }
  })
  return {
    status: entries.length === 0
      ? 'invalid_trial_ledger'
      : !input.rawMComplete || !input.includesFailedTrials
        ? (hasAllPValues ? 'blocked_missing_complete_trial_universe' : 'skeleton_no_pvalues')
        : canRunPromotionFdr
          ? 'ready'
        : 'skeleton_no_pvalues',
    raw_m: rawM,
    effective_m: effectiveM,
    fdrComputationEligibleM: fdrComputationEligibleEntries.length,
    fdrComputationM,
    fdrComputationEffectiveEligibleM: hasAllEffectivePValues ? effectivePValuesFinite.length : 0,
    fdrComputationEffectiveM,
    excludedFromFdrComputationM: rawM - fdrComputationM,
    excludedMissingPValueTrials: missingPValueEntries.length,
    excludedNonPromotionGradePValueTrials: nonPromotionGradePValueEntries.length,
    excludedPromotionGradeMissingTrials: missingPValueEntries.length + nonPromotionGradePValueEntries.length,
    fdrComputationSkippedReason: canRunPromotionFdr
      ? null
      : entries.length === 0
        ? 'invalid_trial_ledger'
        : !input.rawMComplete || !input.includesFailedTrials
          ? 'complete_trial_universe_required'
          : missingPValueEntries.length > 0
            ? 'missing_p_values'
            : nonPromotionGradePValueEntries.length > 0
              ? 'non_promotion_grade_p_values'
              : 'fdr_inputs_not_ready',
    harmonicRawM,
    harmonicEffectiveM,
    fdrMethodPrimary: 'BY_raw_m',
    fdrMethodSecondary: 'BY_effective_m',
    secondaryReports: {
      BH_secondary: bhSecondary
        ? {
            method: 'bh',
            candidateCount: bhSecondary.diagnostics.candidateCount,
          }
        : null,
    },
    entries: pValueEntries,
  }
}

function promotionGradePValueMetric(entry: TrialLedgerEntry): number | null {
  const pValue = numericMetric(entry.metrics.pValue)
  if (pValue == null) return null
  if (entry.metrics.fdrPValueIsPromotionGrade === false) return null
  return pValue
}

function numericMetric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null
}

function buildEffectivePValueClusters(entries: TrialLedgerEntry[]): Array<{
  key: string
  pValue: number | null
  trialIds: string[]
}> {
  const byCluster = new Map<string, TrialLedgerEntry[]>()
  for (const entry of entries) {
    if (!entry.includedInEffectiveM) continue
    const key = `${entry.familyId}|${entry.featureSetHash}|${entry.universeHash}|${entry.parameterCluster}`
    byCluster.set(key, [...(byCluster.get(key) ?? []), entry])
  }
  return [...byCluster.entries()].map(([key, clusterEntries]) => {
    const pValues = clusterEntries
      .map(entry => numericMetric(entry.metrics.pValue))
      .filter((value): value is number => value != null)
    return {
      key,
      pValue: pValues.length === clusterEntries.length ? Math.min(...pValues) : null,
      trialIds: clusterEntries.map(entry => entry.trialId),
    }
  })
}

function harmonicNumber(n: number): number {
  let total = 0
  for (let i = 1; i <= n; i += 1) total += 1 / i
  return total
}

export function buildCandidateKillCriteriaReport(input: {
  acceptedTrades: NormalizedPaperTrade[]
  gateEffectiveness: GateEffectivenessReport
  costDiagnostics: CostModelDiagnosticsReport
  mfeMaeReport: MfeMaeStoplossReport
  alphaRegistry: AlphaHypothesisRegistry
  generatedAt?: string
}): CandidateKillCriteriaReport {
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    candidates: input.alphaRegistry.entries.map(entry => {
      const stats = computeStats(entry.policyId, input.acceptedTrades.filter(trade => trade.lane.includes(entry.familyId) || trade.lane.includes(entry.familyId.replace('_breakout', ''))))
      const currentFlags: string[] = []
      if (stats.count < 30) currentFlags.push('low_sample')
      if (stats.count > 0 && stats.profitFactor != null && stats.profitFactor < 1) currentFlags.push('pf_below_1')
      if (input.gateEffectiveness.gateStatus === 'harmful') currentFlags.push('accept_group_underperforms_skip_group')
      if (input.costDiagnostics.quarantine) currentFlags.push('cost_model_quarantine')
      if (input.mfeMaeReport.coverage.stopLossTrades >= 20) currentFlags.push('stoploss_cluster_requires_review')
      return {
        policyId: entry.policyId,
        familyId: entry.familyId,
        state: currentFlags.includes('pf_below_1') || currentFlags.includes('accept_group_underperforms_skip_group')
          ? 'probation'
          : 'research',
        killCriteria: [
          '2 consecutive prospective evaluation windows PF < 1.0',
          'accept group no longer beats skip shadow group after cost',
          'costModelBias > 5 bps or cost diagnostics quarantine=true',
          'single symbol contribution > 35%',
          'contextCoveragePct < 95%',
          'DSR is null because independentBets < 100 during promotion review',
        ],
        currentFlags,
        promotionAllowed: false,
      }
    }),
  }
}

export function buildStoplossRiskPolicyReport(input: {
  mfeMaeReport: MfeMaeStoplossReport
  generatedAt?: string
}): StoplossRiskPolicyReport {
  const thresholds: StoplossRiskPolicyReport['thresholds'] = {
    productionForbiddenLeverage: 100,
    blockStopLossTrades: 20,
    reviewStopLossTrades: 5,
    severeAvgMaeBps: -100,
    elevatedAvgMaeBps: -25,
    materialLossPct: -1,
  }
  const diagnostics = input.mfeMaeReport.diagnostics
    .filter(item => item.closeReason === 'stop_loss')
  const recommendations = [
    ...buildStoplossRiskPolicyItems('lane', diagnostics, item => item.lane, thresholds),
    ...buildStoplossRiskPolicyItems('symbol', diagnostics, item => item.symbol, thresholds),
    ...buildStoplossRiskPolicyItems('side', diagnostics, item => item.side, thresholds),
    ...buildStoplossRiskPolicyItems('lane_symbol_side', diagnostics, item => `${item.lane}|${item.symbol}|${item.side}`, thresholds),
  ].sort(compareStoplossRiskPolicyItems)
  const summary = summarizeStoplossRiskPolicyItems(recommendations)
  const failClosedReviewQueue = buildStoplossFailClosedReviewQueue({
    recommendations,
    diagnostics,
  })
  const allPromotionBlockers = recommendations
    .filter(item => item.recommendedAction !== 'allow')
    .map(item => `stoploss_${item.dimension}:${item.key}:${item.recommendedAction}`)
  const promotionBlockedBy = allPromotionBlockers.slice(0, 12)

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    policyVersion: 'p1_stoploss_risk_policy_v1',
    diagnosticOnly: true,
    promotionEligible: false,
    policyMutationAllowed: false,
    source: {
      artifact: 'mfe_mae_stoploss_report',
      metricBasis: input.mfeMaeReport.metricBasis,
      closedTrades: input.mfeMaeReport.coverage.closedTrades,
      closedDiagnosticsOk: input.mfeMaeReport.coverage.closedDiagnosticsOk,
      stopLossTrades: input.mfeMaeReport.coverage.stopLossTrades,
      stopLossDiagnosticsOk: input.mfeMaeReport.coverage.stopLossDiagnosticsOk,
      stopLossDiagnosticsOkPct: input.mfeMaeReport.coverage.stopLossDiagnosticsOkPct,
      diagnosticsOk: input.mfeMaeReport.coverage.diagnosticsOk,
    },
    thresholds,
    status: promotionBlockedBy.length > 0 ? 'blocked' : 'clear',
    summary: {
      ...summary,
      promotionBlocked: promotionBlockedBy.length > 0,
      promotionBlockedBy,
      totalPromotionBlockers: allPromotionBlockers.length,
      promotionBlockedByTruncated: allPromotionBlockers.length > promotionBlockedBy.length,
    },
    failClosedReviewQueue,
    recommendations,
    profitabilityClaimAllowed: false,
    promotionClaimAllowed: false,
    executionReplayClaimAllowed: false,
    notes: [
      'Diagnostic-only stop-loss risk policy. It recommends review actions but must not mutate strategy parameters or routing by itself.',
      '100x lanes are always block recommendations for production; they remain research/stress-only until separately proven under a new policy.',
      'Low-sample severe-MAE clusters are shadow_only/cooldown inputs, not proof that wider stops would help.',
      'Relaxation requires prospective accept-vs-skip improvement, cost model pass, and clean evidence manifests.',
    ],
  }
}

function buildStoplossRiskPolicyItems(
  dimension: StoplossRiskPolicyItem['dimension'],
  diagnostics: MfeMaeTradeDiagnostic[],
  keyFn: (item: MfeMaeTradeDiagnostic) => string,
  thresholds: StoplossRiskPolicyReport['thresholds'],
): StoplossRiskPolicyItem[] {
  const groups = new Map<string, MfeMaeTradeDiagnostic[]>()
  for (const item of diagnostics) {
    const key = keyFn(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return [...groups.entries()]
    .map(([key, group]) => buildStoplossRiskPolicyItem(dimension, key, group, thresholds))
    .filter(item => item.recommendedAction !== 'allow' || item.stopLossTrades >= thresholds.reviewStopLossTrades)
}

function buildStoplossRiskPolicyItem(
  dimension: StoplossRiskPolicyItem['dimension'],
  key: string,
  group: MfeMaeTradeDiagnostic[],
  thresholds: StoplossRiskPolicyReport['thresholds'],
): StoplossRiskPolicyItem {
  const ok = group.filter(item => item.diagnosticStatus === 'ok')
  const avgMfeBps = averageNullable(ok.map(item => item.mfeBps))
  const avgMaeBps = averageNullable(ok.map(item => item.maeBps))
  const totalPnlPct = sum(group.map(item => item.pnlPct))
  const actionReason: string[] = []
  const leverage = inferLeverageFromRiskKey(key)
  if (leverage != null && leverage >= thresholds.productionForbiddenLeverage) {
    actionReason.push(`production_forbidden_leverage:${leverage}x`)
  }
  if (group.length >= thresholds.blockStopLossTrades) {
    actionReason.push(`stoploss_count_ge_${thresholds.blockStopLossTrades}:${group.length}`)
  } else if (group.length >= thresholds.reviewStopLossTrades) {
    actionReason.push(`stoploss_count_ge_${thresholds.reviewStopLossTrades}:${group.length}`)
  }
  if (totalPnlPct <= thresholds.materialLossPct) {
    actionReason.push(`material_stoploss_loss_pct:${roundFinite(totalPnlPct)}`)
  }
  if (avgMaeBps != null && avgMaeBps <= thresholds.severeAvgMaeBps) {
    actionReason.push(`severe_avg_mae_bps:${roundFinite(avgMaeBps)}`)
  } else if (avgMaeBps != null && avgMaeBps <= thresholds.elevatedAvgMaeBps) {
    actionReason.push(`elevated_avg_mae_bps:${roundFinite(avgMaeBps)}`)
  }
  if (ok.length < group.length) {
    actionReason.push(`incomplete_diagnostics:${ok.length}/${group.length}`)
  }
  const severity = classifyStoplossRiskSeverity({ actionReason, totalPnlPct, avgMaeBps, count: group.length })
  const recommendedAction = classifyStoplossRiskAction({
    actionReason,
    severity,
    count: group.length,
  })
  return {
    dimension,
    key,
    lane: dimension === 'lane' ? key : splitLaneSymbolSide(key).lane,
    symbol: dimension === 'symbol' ? key : splitLaneSymbolSide(key).symbol,
    side: dimension === 'side'
      ? normalizeDiagnosticSide(key)
      : splitLaneSymbolSide(key).side,
    stopLossTrades: group.length,
    diagnosticsOk: ok.length,
    diagnosticsOkPct: group.length > 0 ? ok.length / group.length * 100 : 0,
    totalPnlPct,
    avgPnlPct: group.length > 0 ? mean(group.map(item => item.pnlPct)) : null,
    avgMfeBps,
    avgMaeBps,
    medianMaeBps: medianNullable(ok.map(item => item.maeBps)),
    avgTimeToStopSec: averageNullable(ok.map(item => item.timeToStopSec)),
    safeOneSecondSharePct: ok.length > 0
      ? ok.filter(item => item.pitStatus === 'safe_1s').length / ok.length * 100
      : null,
    coarseBarSharePct: ok.length > 0
      ? ok.filter(item => item.pitStatus === 'coarse_bar_ambiguous').length / ok.length * 100
      : null,
    severity,
    recommendedAction,
    actionReason: actionReason.length > 0 ? actionReason : ['no_material_stoploss_cluster'],
    requiredEvidenceBeforeRelaxation: [
      'prospective_accept_vs_skip_delta_after_cost_positive',
      'cost_model_quarantine_false',
      'stoploss_cluster_below_threshold_in_two_non_overlapping_windows',
      'clean_evidence_manifest_and_dirty_worktree_pass',
    ],
    policyMutationAllowed: false,
    promotionEligible: false,
  }
}

function buildStoplossFailClosedReviewQueue(input: {
  recommendations: StoplossRiskPolicyItem[]
  diagnostics: MfeMaeTradeDiagnostic[]
}): StoplossFailClosedReviewQueueItem[] {
  return input.recommendations
    .filter((item): item is StoplossRiskPolicyItem & { recommendedAction: Exclude<StoplossRiskPolicyAction, 'allow'> } =>
      item.recommendedAction !== 'allow',
    )
    .map((item, index) => {
      const matchingDiagnostics = input.diagnostics.filter(diagnostic => diagnosticMatchesStoplossRiskItem(diagnostic, item))
      return {
        rank: index + 1,
        dimension: item.dimension,
        key: item.key,
        failClosedAction: item.recommendedAction,
        reportOnly: true,
        policyMutationAllowed: false,
        promotionEligible: false,
        stopLossTrades: item.stopLossTrades,
        diagnosticsOkPct: item.diagnosticsOkPct,
        totalPnlPct: item.totalPnlPct,
        avgMaeBps: item.avgMaeBps,
        avgTimeToStopSec: item.avgTimeToStopSec,
        actionReason: item.actionReason,
        missingEvidence: summarizeStoplossMissingEvidence(matchingDiagnostics),
        representativeTrades: matchingDiagnostics
          .sort(compareRepresentativeStoplossTrades)
          .slice(0, 3)
          .map(stoplossRepresentativeTrade),
        requiredEvidenceBeforeRelaxation: item.requiredEvidenceBeforeRelaxation,
      }
    })
}

function diagnosticMatchesStoplossRiskItem(
  diagnostic: MfeMaeTradeDiagnostic,
  item: StoplossRiskPolicyItem,
): boolean {
  if (item.dimension === 'lane') return diagnostic.lane === item.key
  if (item.dimension === 'symbol') return diagnostic.symbol === item.key
  if (item.dimension === 'side') return diagnostic.side === item.side
  return `${diagnostic.lane}|${diagnostic.symbol}|${diagnostic.side}` === item.key
}

function summarizeStoplossMissingEvidence(diagnostics: MfeMaeTradeDiagnostic[]): string[] {
  const missing = new Set<string>()
  for (const diagnostic of diagnostics) {
    if (diagnostic.roundTripCostBpsAtOpen == null) missing.add('missing_round_trip_cost_bps_at_open')
    if (diagnostic.markMatchStatusAtOpen == null) missing.add('missing_mark_match_status_at_open')
    if (diagnostic.contextCoverageBucket !== 'ok') missing.add('legacy_or_missing_context')
    if (diagnostic.pitStatus === 'coarse_bar_ambiguous') missing.add('coarse_bar_ordering_ambiguous')
    if (diagnostic.diagnosticStatus !== 'ok') missing.add('incomplete_price_path_diagnostics')
  }
  return [...missing].sort()
}

function compareRepresentativeStoplossTrades(left: MfeMaeTradeDiagnostic, right: MfeMaeTradeDiagnostic): number {
  return left.pnlPct - right.pnlPct ||
    (left.maeBps ?? 0) - (right.maeBps ?? 0) ||
    right.closeTs.localeCompare(left.closeTs) ||
    left.tradeId.localeCompare(right.tradeId)
}

function stoplossRepresentativeTrade(diagnostic: MfeMaeTradeDiagnostic): StoplossFailClosedReviewQueueItem['representativeTrades'][number] {
  return {
    tradeId: diagnostic.tradeId,
    closeTs: diagnostic.closeTs,
    lane: diagnostic.lane,
    symbol: diagnostic.symbol,
    side: diagnostic.side,
    pnlPct: diagnostic.pnlPct,
    mfeBps: diagnostic.mfeBps,
    maeBps: diagnostic.maeBps,
    timeToStopSec: diagnostic.timeToStopSec,
    pricePathTimeframe: diagnostic.pricePathTimeframe,
    pitStatus: diagnostic.pitStatus,
    roundTripCostBpsAtOpen: diagnostic.roundTripCostBpsAtOpen,
    routeCostBpsAtOpen: diagnostic.routeCostBpsAtOpen,
    markMatchPenaltyBpsAtOpen: diagnostic.markMatchPenaltyBpsAtOpen,
    markMatchStatusAtOpen: diagnostic.markMatchStatusAtOpen,
    pricePathFallbackUsed: diagnostic.pricePathFallbackUsed,
    pricePathFallbackReason: diagnostic.pricePathFallbackReason,
    orderingStatus: diagnostic.orderingStatus,
    contextCoverageBucket: diagnostic.contextCoverageBucket,
  }
}

function classifyStoplossRiskSeverity(input: {
  actionReason: string[]
  totalPnlPct: number
  avgMaeBps: number | null
  count: number
}): StoplossRiskSeverity {
  if (
    input.actionReason.some(reason => reason.startsWith('production_forbidden_leverage:')) ||
    input.actionReason.some(reason => reason.startsWith('stoploss_count_ge_20:')) ||
    (input.avgMaeBps != null && input.avgMaeBps <= -100 && input.totalPnlPct <= -1)
  ) return 'critical'
  if (
    input.actionReason.some(reason => reason.startsWith('material_stoploss_loss_pct:')) ||
    input.actionReason.some(reason => reason.startsWith('severe_avg_mae_bps:')) ||
    input.count >= 5
  ) return 'high'
  if (
    input.actionReason.some(reason => reason.startsWith('elevated_avg_mae_bps:')) ||
    input.count >= 2
  ) return 'medium'
  return 'low'
}

function classifyStoplossRiskAction(input: {
  actionReason: string[]
  severity: StoplossRiskSeverity
  count: number
}): StoplossRiskPolicyAction {
  if (input.actionReason.some(reason => reason.startsWith('production_forbidden_leverage:'))) return 'block'
  if (input.severity === 'critical') return 'cooldown'
  if (input.severity === 'high') return input.count >= 5 ? 'cooldown' : 'shadow_only'
  if (input.severity === 'medium') return 'downweight'
  return 'allow'
}

function compareStoplossRiskPolicyItems(left: StoplossRiskPolicyItem, right: StoplossRiskPolicyItem): number {
  return severityRank(right.severity) - severityRank(left.severity) ||
    actionRank(right.recommendedAction) - actionRank(left.recommendedAction) ||
    right.stopLossTrades - left.stopLossTrades ||
    left.totalPnlPct - right.totalPnlPct ||
    `${left.dimension}:${left.key}`.localeCompare(`${right.dimension}:${right.key}`)
}

function severityRank(value: StoplossRiskSeverity): number {
  return { low: 0, medium: 1, high: 2, critical: 3 }[value]
}

function actionRank(value: StoplossRiskPolicyAction): number {
  return { allow: 0, downweight: 1, shadow_only: 2, cooldown: 3, block: 4 }[value]
}

function summarizeStoplossRiskPolicyItems(items: StoplossRiskPolicyItem[]): Omit<
  StoplossRiskPolicyReport['summary'],
  'promotionBlocked' | 'promotionBlockedBy'
> {
  const counts = {
    reviewedItems: items.length,
    allow: 0,
    downweight: 0,
    cooldown: 0,
    block: 0,
    shadowOnly: 0,
    highestSeverity: null as StoplossRiskSeverity | null,
  }
  for (const item of items) {
    if (item.recommendedAction === 'allow') counts.allow += 1
    if (item.recommendedAction === 'downweight') counts.downweight += 1
    if (item.recommendedAction === 'cooldown') counts.cooldown += 1
    if (item.recommendedAction === 'block') counts.block += 1
    if (item.recommendedAction === 'shadow_only') counts.shadowOnly += 1
    if (!counts.highestSeverity || severityRank(item.severity) > severityRank(counts.highestSeverity)) {
      counts.highestSeverity = item.severity
    }
  }
  return counts
}

function splitLaneSymbolSide(key: string): {
  lane: string | null
  symbol: string | null
  side: NormalizedPaperTrade['side'] | null
} {
  const parts = key.split('|')
  if (parts.length !== 3) return { lane: null, symbol: null, side: null }
  return {
    lane: parts[0] || null,
    symbol: parts[1] || null,
    side: normalizeDiagnosticSide(parts[2]),
  }
}

function normalizeDiagnosticSide(value: string | null): NormalizedPaperTrade['side'] | null {
  if (value === 'long' || value === 'short' || value === 'unknown') return value
  return null
}

function inferLeverageFromRiskKey(value: string): number | null {
  const match = value.match(/(?:^|_)(\d+)x(?:$|\|)/)
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : null
}

function outcomeToNormalizedTrade(
  outcome: PaperPolicyShadowOutcome,
  open: ParsedPaperPolicyShadowOpen | undefined,
): NormalizedPaperTrade {
  const quality = open?.quality ?? {}
  const context = open?.context ?? {}
  const cost = open?.cost ?? {}
  return {
    tradeId: outcome.shadowId,
    source: 'paper_policy_shadow_ledger',
    lane: outcome.lane,
    accountId: null,
    accountLabel: null,
    symbol: outcome.symbol,
    side: outcome.side,
    leverage: null,
    openTs: outcome.openTs,
    closeTs: outcome.closeTs,
    openPrice: outcome.entryPrice,
    closePrice: outcome.closePrice,
    pnlPct: outcome.pnlPct,
    pnlUsd: outcome.pnlUsd,
    closeReason: outcome.closeReason === 'shadow_stop_loss' ? 'stop_loss' : 'holding_expired',
    rawReason: outcome.closeReason,
    holdingSeconds: Math.max(0, (Date.parse(outcome.closeTs) - Date.parse(outcome.openTs)) / 1000),
    closeHourUtc: Number.isFinite(Date.parse(outcome.closeTs)) ? new Date(outcome.closeTs).getUTCHours() : null,
    priceSource: 'shadow_ledger',
    priceStale: null,
    volumeRatioAtOpen: numberOrNull(quality.volumeRatioAtOpen ?? quality.volumeRatio),
    breakQualityAtOpen: numberOrNull(quality.breakQualityAtOpen ?? quality.breakQuality),
    liquidityStatusAtOpen: stringOrNull(quality.liquidityStatusAtOpen ?? quality.liquidityStatus),
    spreadStatusAtOpen: stringOrNull(quality.spreadStatusAtOpen ?? quality.spreadStatus),
    spreadBpsAtOpen: numberOrNull(quality.spreadBpsAtOpen ?? quality.spreadBps),
    rankAtOpen: null,
    rankSpreadPctAtOpen: null,
    estimatedRoundTripCostPctAtOpen: numberOrNull(cost.estimatedRoundTripCostPctAtOpen),
    estimatedRoundTripCostPctOfMarginAtOpen: numberOrNull(cost.estimatedRoundTripCostPctOfMarginAtOpen),
    expectedGrossEdgePctAtOpen: numberOrNull(cost.expectedGrossEdgePctAtOpen),
    expectedNetEdgePctAtOpen: numberOrNull(cost.expectedNetEdgePctAtOpen),
    expectedEdgeSourceAtOpen: stringOrNull(cost.expectedEdgeSourceAtOpen),
    routeCostBpsAtOpen: numberOrNull(cost.routeCostBpsAtOpen),
    roundTripCostBpsAtOpen: numberOrNull(cost.roundTripCostBpsAtOpen),
    markPriceAtOpen: numberOrNull(cost.markPriceAtOpen),
    markPriceTimestampAtOpen: stringOrNull(cost.markPriceTimestampAtOpen),
    matchPriceAtOpen: numberOrNull(cost.matchPriceAtOpen),
    matchPriceSourceAtOpen: stringOrNull(cost.matchPriceSourceAtOpen),
    markMatchPenaltyBpsAtOpen: numberOrNull(cost.markMatchPenaltyBpsAtOpen),
    markMatchStatusAtOpen: stringOrNull(cost.markMatchStatusAtOpen),
    signalConfidenceAtOpen: numberOrNull(quality.confidenceAtOpen ?? quality.confidence),
    contextGenerationAtOpen: numberOrNull(context.contextGenerationAtOpen),
    flashConfidenceLowAtOpen: numberOrNull(context.flashConfidenceLowAtOpen),
    ruleScoreAtOpen: numberOrNull(quality.ruleScoreAtOpen ?? quality.confidenceAtOpen ?? quality.confidence),
    proEpochAtOpen: numberOrNull(context.proEpochAtOpen),
    marketIntelTriggerAtOpen: stringOrNull(context.marketIntelTriggerAtOpen),
    contextCoverageBucket: classifyShadowContextCoverage(context),
    liquidated: false,
    contextSnapshotId: stringOrNull(context.contextSnapshotId),
    decisionTime: stringOrNull(context.decisionTime),
    marketDataWatermarkAtDecisionTime: stringOrNull(context.marketDataWatermarkAtDecisionTime),
    watermark: stringOrNull(context.watermark),
    featuresAvailableAtDecisionTime: booleanOrNull(context.featuresAvailableAtDecisionTime),
    featureSchemaVersion: stringOrNull(context.featureSchemaVersion),
    flashContextStatus: stringOrNull(context.flashContextStatus),
    contextStatus: stringOrNull(context.contextStatus),
    contextReason: stringOrNull(context.contextReason),
    contextCoverageStatus: null,
    contextCoverageReason: null,
  }
}

function classifyShadowOutcomeValidity(
  outcomes: PaperPolicyShadowOutcome[],
  openById: Map<string, ParsedPaperPolicyShadowOpen>,
): GateEffectivenessReport['validityCounts'] {
  const counts = { valid: 0, partial: 0, invalid: 0 }
  for (const outcome of outcomes) {
    counts[classifyShadowOutcomeValidityStatus(outcome, openById.get(outcome.shadowId))] += 1
  }
  return counts
}

function classifyShadowOutcomeValidityStatus(
  _outcome: PaperPolicyShadowOutcome,
  open: ParsedPaperPolicyShadowOpen | undefined,
): keyof GateEffectivenessReport['validityCounts'] {
  if (!open) return 'invalid'
  if (open.blockReasons.length === 0) return 'partial'
  if (shadowContextMissingFields(open.context).length > 0) return 'partial'
  if (shadowOpenPredictedCostBps(open) == null) return 'partial'
  return 'valid'
}

function buildSkippedStatsByRejectReason(
  outcomes: PaperPolicyShadowOutcome[],
  openById: Map<string, ParsedPaperPolicyShadowOpen>,
): GateEffectivenessReport['skippedOutcomeStatsByRejectReason'] {
  const byReason = new Map<string, PaperPolicyShadowOutcome[]>()
  for (const outcome of outcomes) {
    const open = openById.get(outcome.shadowId)
    const reasons = open?.blockReasons.length ? open.blockReasons : ['unknown']
    for (const reason of reasons) {
      byReason.set(reason, [...(byReason.get(reason) ?? []), outcome])
    }
  }
  return [...byReason.entries()]
    .map(([reason, reasonOutcomes]) => ({
      reason,
      count: reasonOutcomes.length,
      totalPnlPct: sum(reasonOutcomes.map(outcome => outcome.pnlPct)),
      avgPnlPct: mean(reasonOutcomes.map(outcome => outcome.pnlPct)),
    }))
    .sort((a, b) => a.totalPnlPct - b.totalPnlPct || b.count - a.count)
    .slice(0, 20)
}

function countRejectReasons(opens: ParsedPaperPolicyShadowOpen[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>()
  for (const open of opens) {
    const reasons = open.blockReasons.length > 0 ? open.blockReasons : ['unknown']
    for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 20)
}

function countIndependentBets(trades: NormalizedPaperTrade[]): number {
  return new Set(trades.map(symbolDayKey).filter(Boolean)).size
}

function symbolDayKey(trade: NormalizedPaperTrade): string {
  const ts = Date.parse(trade.closeTs || trade.openTs)
  const day = Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : 'unknown_day'
  return `${trade.symbol}|${day}`
}

function buildBootstrapBlockSensitivity(
  acceptedTrades: NormalizedPaperTrade[],
  skippedTrades: NormalizedPaperTrade[],
): GateEffectivenessReport['bootstrapBlockSensitivity'] {
  const acceptedUnits = aggregatePnlByIndependentUnit(acceptedTrades)
  const skippedUnits = aggregatePnlByIndependentUnit(skippedTrades)
  const totalUnits = acceptedUnits.length + skippedUnits.length
  if (acceptedUnits.length < 30 || skippedUnits.length < 30) {
    return {
      method: 'stationary_block_sensitivity',
      resamplingUnit: 'symbol_day',
      comparisonDesign: 'unpaired_symbol_day',
      promotionEligible: false,
      baseBlockSize: totalUnits > 0 ? Math.max(5, Math.floor(totalUnits ** (1 / 3))) : null,
      blockSizeSet: [],
      iterations: 0,
      results: [],
    }
  }
  const baseBlockSize = Math.max(5, Math.floor(totalUnits ** (1 / 3)))
  const blockSizeSet = [
    Math.max(2, Math.floor(0.5 * baseBlockSize)),
    baseBlockSize,
    2 * baseBlockSize,
  ]
  const results = blockSizeSet.map(blockSize => bootstrapDeltaResult({
    acceptedUnits,
    skippedUnits,
    blockSize,
    iterations: 500,
  }))
  return {
    method: 'stationary_block_sensitivity',
    resamplingUnit: 'symbol_day',
    comparisonDesign: 'unpaired_symbol_day',
    promotionEligible: false,
    baseBlockSize,
    blockSizeSet,
    iterations: 500,
    results,
  }
}

function aggregatePnlByIndependentUnit(trades: NormalizedPaperTrade[]): number[] {
  const byUnit = new Map<string, number[]>()
  for (const trade of trades) {
    const key = symbolDayKey(trade)
    byUnit.set(key, [...(byUnit.get(key) ?? []), trade.pnlPct])
  }
  return [...byUnit.values()].map(values => mean(values))
}

function bootstrapDeltaResult(input: {
  acceptedUnits: number[]
  skippedUnits: number[]
  blockSize: number
  iterations: number
}): GateEffectivenessReport['bootstrapBlockSensitivity']['results'][number] {
  if (input.acceptedUnits.length === 0 || input.skippedUnits.length === 0) {
    return {
      blockSize: input.blockSize,
      acceptVsSkipDeltaMeanPct: null,
      acceptVsSkipDeltaLowerBoundPct: null,
      acceptVsSkipDeltaUpperBoundPct: null,
      confidenceLevel: 0.9,
      deltaPositiveShare: null,
      directionStable: false,
      lowerBoundPositive: false,
      skippedReason: 'missing_units',
    }
  }
  const deltas: number[] = []
  for (let i = 0; i < input.iterations; i += 1) {
    const acceptedSample = stationaryBlockSample(input.acceptedUnits, input.acceptedUnits.length, input.blockSize, i + 17)
    const skippedSample = stationaryBlockSample(input.skippedUnits, input.skippedUnits.length, input.blockSize, i + 101)
    deltas.push(mean(acceptedSample) - mean(skippedSample))
  }
  const positiveShare = deltas.filter(delta => delta > 0).length / deltas.length
  const lowerBound = quantile(deltas, 0.05)
  const upperBound = quantile(deltas, 0.95)
  return {
    blockSize: input.blockSize,
    acceptVsSkipDeltaMeanPct: mean(deltas),
    acceptVsSkipDeltaLowerBoundPct: lowerBound,
    acceptVsSkipDeltaUpperBoundPct: upperBound,
    confidenceLevel: 0.9,
    deltaPositiveShare: positiveShare,
    directionStable: positiveShare >= 0.95 || positiveShare <= 0.05,
    lowerBoundPositive: lowerBound > 0,
    skippedReason: null,
  }
}

function stationaryBlockSample(values: number[], size: number, blockSize: number, seed: number): number[] {
  const out: number[] = []
  const rng = mulberry32(seed)
  let index = Math.floor(rng() * values.length)
  const restartProbability = 1 / Math.max(1, blockSize)
  while (out.length < size) {
    if (out.length === 0 || rng() < restartProbability) {
      index = Math.floor(rng() * values.length)
    } else {
      index = (index + 1) % values.length
    }
    out.push(values[index])
  }
  return out
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function loadCandlesForTrade(dataDir: string, symbol: string, timeframe: PaperUniverseTimeframe): Promise<Candle[]> {
  const path = join(dataDir, paperSymbolToCsvFile(symbol, timeframe))
  if (!existsSync(path)) return []
  const raw = await readFile(path, 'utf-8')
  const lines = raw.trim().split(/\r?\n/)
  if (lines.length < 2) return []
  const header = lines[0].split(',')
  const ti = header.indexOf('timestamp')
  const di = header.indexOf('datetime')
  const oi = header.indexOf('open')
  const hi = header.indexOf('high')
  const li = header.indexOf('low')
  const ci = header.indexOf('close')
  if ([ti, oi, hi, li, ci].some(index => index < 0)) return []
  return lines.slice(1)
    .map(line => {
      const cols = line.split(',')
      return {
        timestamp: Number(cols[ti]),
        datetime: di >= 0 ? cols[di] : new Date(Number(cols[ti])).toISOString(),
        open: Number(cols[oi]),
        high: Number(cols[hi]),
        low: Number(cols[li]),
        close: Number(cols[ci]),
      }
    })
    .filter(candle =>
      Number.isFinite(candle.timestamp) &&
      [candle.open, candle.high, candle.low, candle.close].every(value => Number.isFinite(value) && value > 0),
    )
    .sort((a, b) => a.timestamp - b.timestamp)
}

function computeMfeMaeDiagnostic(input: {
  trade: NormalizedPaperTrade
  candles: Candle[]
  timeframe: PaperUniverseTimeframe | null
  fallbackUsed: boolean
  fallbackReason: MfeMaeTradeDiagnostic['pricePathFallbackReason']
}): MfeMaeTradeDiagnostic {
  const { trade, candles, timeframe, fallbackUsed, fallbackReason } = input
  const openMs = Date.parse(trade.openTs)
  const closeMs = Date.parse(trade.closeTs)
  if (!Number.isFinite(openMs) || !Number.isFinite(closeMs) || (trade.openPrice ?? 0) <= 0) {
    return baseMfeMaeTrade({ trade, diagnosticStatus: 'invalid_trade_prices', timeframe, fallbackUsed, fallbackReason })
  }
  if (trade.side === 'unknown') return baseMfeMaeTrade({ trade, diagnosticStatus: 'unknown_side', timeframe, fallbackUsed, fallbackReason })
  const path = candles.filter(candle => candleOverlapsTradeWindow(candle, openMs, closeMs, timeframe))
  if (path.length === 0) return baseMfeMaeTrade({ trade, diagnosticStatus: 'missing_price_path', timeframe, fallbackUsed, fallbackReason })
  const openPrice = trade.openPrice!
  if (!pricePathMatchesTradeScale(path, openPrice)) {
    return baseMfeMaeTrade({ trade, diagnosticStatus: 'price_path_mismatch', timeframe, fallbackUsed, fallbackReason })
  }
  let bestBps = -Infinity
  let worstBps = Infinity
  let bestTs = path[0].timestamp
  let worstTs = path[0].timestamp
  for (const candle of path) {
    const favorablePrice = trade.side === 'long' ? candle.high : candle.low
    const adversePrice = trade.side === 'long' ? candle.low : candle.high
    const favorableBps = trade.side === 'long'
      ? (favorablePrice / openPrice - 1) * 10_000
      : (openPrice / favorablePrice - 1) * 10_000
    const adverseBps = trade.side === 'long'
      ? (adversePrice / openPrice - 1) * 10_000
      : (openPrice / adversePrice - 1) * 10_000
    if (favorableBps > bestBps) {
      bestBps = favorableBps
      bestTs = candle.timestamp
    }
    if (adverseBps < worstBps) {
      worstBps = adverseBps
      worstTs = candle.timestamp
    }
  }
  return {
    ...baseMfeMaeTrade({ trade, diagnosticStatus: 'ok', timeframe, fallbackUsed, fallbackReason }),
    mfeBps: roundFinite(bestBps),
    maeBps: roundFinite(worstBps),
    timeToMfeSec: Math.max(0, (bestTs - openMs) / 1000),
    timeToMaeSec: Math.max(0, (worstTs - openMs) / 1000),
    timeToStopSec: trade.closeReason === 'stop_loss' ? Math.max(0, (closeMs - openMs) / 1000) : null,
    mfeBeforeStop: trade.closeReason === 'stop_loss' && timeframe === '1s' ? bestTs <= closeMs : null,
    pitStatus: timeframe === '1s' ? 'safe_1s' : 'coarse_bar_ambiguous',
    orderingStatus: timeframe === '1s' ? 'known' : 'coarse_bar_unknown',
  }
}

function pricePathMatchesTradeScale(path: Candle[], openPrice: number): boolean {
  if (!Number.isFinite(openPrice) || openPrice <= 0) return false
  const firstClose = path.find(candle => Number.isFinite(candle.close) && candle.close > 0)?.close
  if (firstClose == null || firstClose <= 0) return false
  const ratio = Math.max(firstClose / openPrice, openPrice / firstClose)
  if (ratio > 5) return false
  const suspiciousConstant2026 = path.length >= 2
    && path.slice(0, Math.min(5, path.length)).every(candle =>
      candle.open === 2026 &&
      candle.high === 2026 &&
      candle.low === 2026 &&
      candle.close === 2026,
    )
  return !suspiciousConstant2026
}

function candleOverlapsTradeWindow(
  candle: Candle,
  openMs: number,
  closeMs: number,
  timeframe: PaperUniverseTimeframe | null,
): boolean {
  if (!Number.isFinite(candle.timestamp)) return false
  const durationMs = timeframeDurationMs(timeframe)
  const candleEndMs = candle.timestamp + durationMs
  return candle.timestamp <= closeMs && candleEndMs > openMs
}

function timeframeDurationMs(timeframe: PaperUniverseTimeframe | null): number {
  if (timeframe === '1s') return 1_000
  if (timeframe === '5m') return 5 * 60_000
  if (timeframe === '1h') return 60 * 60_000
  return 0
}

function baseMfeMaeTrade(input: {
  trade: NormalizedPaperTrade
  diagnosticStatus: MfeMaeTradeDiagnostic['diagnosticStatus']
  timeframe: PaperUniverseTimeframe | null
  fallbackUsed: boolean
  fallbackReason: MfeMaeTradeDiagnostic['pricePathFallbackReason']
}): MfeMaeTradeDiagnostic {
  const { trade, diagnosticStatus, timeframe, fallbackUsed, fallbackReason } = input
  return {
    tradeId: trade.tradeId,
    lane: trade.lane,
    symbol: trade.symbol,
    side: trade.side,
    closeReason: trade.closeReason,
    openTs: trade.openTs,
    closeTs: trade.closeTs,
    pnlPct: trade.pnlPct,
    contextCoverageBucket: trade.contextCoverageBucket,
    liquidityUsdAtOpen: trade.liquidityUsdAtOpen,
    liquidityStatusAtOpen: trade.liquidityStatusAtOpen,
    spreadStatusAtOpen: trade.spreadStatusAtOpen,
    spreadBpsAtOpen: trade.spreadBpsAtOpen,
    routeCostBpsAtOpen: trade.routeCostBpsAtOpen,
    roundTripCostBpsAtOpen: trade.roundTripCostBpsAtOpen,
    markMatchStatusAtOpen: trade.markMatchStatusAtOpen,
    markMatchPenaltyBpsAtOpen: trade.markMatchPenaltyBpsAtOpen,
    regimeAtOpen: trade.regimeAtOpen,
    pricePathTimeframe: timeframe,
    pricePathFallbackUsed: fallbackUsed,
    pricePathFallbackReason: fallbackReason,
    mfeBps: null,
    maeBps: null,
    timeToMfeSec: null,
    timeToMaeSec: null,
    timeToStopSec: null,
    mfeBeforeStop: null,
    pitStatus: diagnosticStatus === 'missing_price_path'
      ? 'path_missing'
      : diagnosticStatus === 'ok'
        ? (timeframe === '1s' ? 'safe_1s' : 'coarse_bar_ambiguous')
        : 'invalid',
    orderingStatus: diagnosticStatus === 'missing_price_path'
      ? 'path_missing'
      : diagnosticStatus === 'ok'
        ? (timeframe === '1s' ? 'known' : 'coarse_bar_unknown')
        : 'invalid',
    diagnosticStatus,
  }
}

function groupMfeMaeByCloseReason(items: MfeMaeTradeDiagnostic[]): MfeMaeStoplossReport['byCloseReason'] {
  const groups = new Map<string, MfeMaeTradeDiagnostic[]>()
  for (const item of items) groups.set(item.closeReason, [...(groups.get(item.closeReason) ?? []), item])
  return [...groups.entries()]
    .map(([closeReason, group]) => ({
      closeReason,
      count: group.length,
      avgMfeBps: averageNullable(group.map(item => item.mfeBps)),
      avgMaeBps: averageNullable(group.map(item => item.maeBps)),
      medianMfeBps: medianNullable(group.map(item => item.mfeBps)),
      medianMaeBps: medianNullable(group.map(item => item.maeBps)),
    }))
    .sort((a, b) => b.count - a.count || a.closeReason.localeCompare(b.closeReason))
}

function buildMfeMaeStoplossAttribution(
  stopLoss: MfeMaeTradeDiagnostic[],
): MfeMaeStoplossReport['stopLossAttribution'] {
  const missingRoundTripCostAtOpenCount = stopLoss.filter(item => item.roundTripCostBpsAtOpen == null).length
  const missingMarkMatchStatusAtOpenCount = stopLoss.filter(item => item.markMatchStatusAtOpen == null).length
  const legacyOrMissingContextCount = stopLoss.filter(item => item.contextCoverageBucket !== 'ok').length
  const coarseOrderingAmbiguousCount = stopLoss.filter(item => item.orderingStatus === 'coarse_bar_unknown').length
  return {
    diagnosticUse: 'read_only_cluster_attribution',
    status: stopLoss.length > 0 ? 'blocked_diagnostic_only' : 'clear_no_stoploss_cluster',
    promotionEligible: false,
    policyMutationAllowed: false,
    profitabilityClaimAllowed: false,
    blockedBy: [
      'read_only_path_attribution',
      'requires_pro_review_before_policy_change',
      'not_fill_adjusted_execution_replay',
    ],
    blockerSummary: {
      missingRoundTripCostAtOpenCount,
      missingMarkMatchStatusAtOpenCount,
      legacyOrMissingContextCount,
      coarseOrderingAmbiguousCount,
    },
    byLane: groupMfeMaeStoplossBucket(stopLoss, 'lane', item => item.lane),
    bySymbol: groupMfeMaeStoplossBucket(stopLoss, 'symbol', item => item.symbol),
    bySide: groupMfeMaeStoplossBucket(stopLoss, 'side', item => item.side),
    byLaneSymbolSide: groupMfeMaeStoplossBucket(stopLoss, 'lane_symbol_side', item => `${item.lane}|${item.symbol}|${item.side}`),
    byRegime: groupMfeMaeStoplossBucket(stopLoss, 'regime', item => item.regimeAtOpen ?? 'missing'),
    byContextCoverageBucket: groupMfeMaeStoplossBucket(stopLoss, 'context_coverage_bucket', item => item.contextCoverageBucket),
    byLiquidityUsdBucket: groupMfeMaeStoplossBucket(stopLoss, 'liquidity_usd_bucket', item => bucketLiquidityUsd(item.liquidityUsdAtOpen)),
    byLiquidityStatus: groupMfeMaeStoplossBucket(stopLoss, 'liquidity_status', item => item.liquidityStatusAtOpen ?? 'missing'),
    bySpreadStatus: groupMfeMaeStoplossBucket(stopLoss, 'spread_status', item => item.spreadStatusAtOpen ?? 'missing'),
    bySpreadBpsBucket: groupMfeMaeStoplossBucket(stopLoss, 'spread_bps_bucket', item => bucketSpreadBps(item.spreadBpsAtOpen)),
    byRouteCostBpsBucket: groupMfeMaeStoplossBucket(stopLoss, 'route_cost_bps_bucket', item => bucketCostBps(item.routeCostBpsAtOpen)),
    byRoundTripCostBpsBucket: groupMfeMaeStoplossBucket(stopLoss, 'round_trip_cost_bps_bucket', item => bucketCostBps(item.roundTripCostBpsAtOpen)),
    byMarkMatchStatus: groupMfeMaeStoplossBucket(stopLoss, 'mark_match_status', item => item.markMatchStatusAtOpen ?? 'missing'),
    byMarkMatchPenaltyBpsBucket: groupMfeMaeStoplossBucket(stopLoss, 'mark_match_penalty_bps_bucket', item => bucketCostBps(item.markMatchPenaltyBpsAtOpen)),
    byMfeBpsBucket: groupMfeMaeStoplossBucket(stopLoss, 'mfe_bps_bucket', item => bucketExcursionBps(item.mfeBps)),
    byMaeBpsBucket: groupMfeMaeStoplossBucket(stopLoss, 'mae_bps_bucket', item => bucketExcursionBps(item.maeBps)),
    byMfeBeforeStop: groupMfeMaeStoplossBucket(stopLoss, 'mfe_before_stop', item => item.mfeBeforeStop == null ? 'missing' : String(item.mfeBeforeStop)),
    byTimeToStopBucket: groupMfeMaeStoplossBucket(stopLoss, 'time_to_stop_bucket', item => bucketHoldingSeconds(item.timeToStopSec)),
  }
}

function groupMfeMaeStoplossBucket(
  items: MfeMaeTradeDiagnostic[],
  dimension: string,
  keyFn: (item: MfeMaeTradeDiagnostic) => string,
): MfeMaeStoplossBucketSummary[] {
  const groups = new Map<string, MfeMaeTradeDiagnostic[]>()
  for (const item of items) {
    const key = keyFn(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return [...groups.entries()]
    .map(([key, group]) => summarizeMfeMaeStoplossBucket(dimension, key, group))
    .sort((a, b) =>
      b.count - a.count ||
      a.key.localeCompare(b.key),
    )
    .slice(0, 10)
}

function summarizeMfeMaeStoplossBucket(
  dimension: string,
  key: string,
  group: MfeMaeTradeDiagnostic[],
): MfeMaeStoplossBucketSummary {
  const ok = group.filter(item => item.diagnosticStatus === 'ok')
  const knownOrdering = ok.filter(item => item.orderingStatus === 'known')
  const pnlValues = group.map(item => item.pnlPct)
  return {
    dimension,
    key,
    count: group.length,
    diagnosticsOk: ok.length,
    avgPnlPct: pnlValues.length > 0 ? mean(pnlValues) : null,
    totalPnlPct: sum(pnlValues),
    avgMfeBps: averageNullable(ok.map(item => item.mfeBps)),
    avgMaeBps: averageNullable(ok.map(item => item.maeBps)),
    medianMfeBps: medianNullable(ok.map(item => item.mfeBps)),
    medianMaeBps: medianNullable(ok.map(item => item.maeBps)),
    avgTimeToStopSec: averageNullable(ok.map(item => item.timeToStopSec)),
    mfeBeforeStopSharePct: knownOrdering.length > 0
      ? knownOrdering.filter(item => item.mfeBeforeStop === true).length / knownOrdering.length * 100
      : null,
  }
}

function bucketLiquidityUsd(value: number | null): string {
  if (value == null) return 'missing'
  if (value < 10_000) return '<10k'
  if (value < 50_000) return '10k-50k'
  if (value < 250_000) return '50k-250k'
  if (value < 1_000_000) return '250k-1m'
  return '>=1m'
}

function bucketSpreadBps(value: number | null): string {
  if (value == null) return 'missing'
  if (value < 5) return '<5'
  if (value < 10) return '5-10'
  if (value < 25) return '10-25'
  if (value < 50) return '25-50'
  return '>=50'
}

function bucketCostBps(value: number | null): string {
  if (value == null) return 'missing'
  if (value < 5) return '<5'
  if (value < 15) return '5-15'
  if (value < 30) return '15-30'
  if (value < 50) return '30-50'
  return '>=50'
}

function bucketExcursionBps(value: number | null): string {
  if (value == null) return 'missing'
  const abs = Math.abs(value)
  if (abs < 25) return '<25'
  if (abs < 50) return '25-50'
  if (abs < 100) return '50-100'
  if (abs < 250) return '100-250'
  return '>=250'
}

function bucketHoldingSeconds(value: number | null): string {
  if (value == null) return 'missing'
  if (value < 30) return '<30s'
  if (value < 120) return '30-120s'
  if (value < 600) return '2-10m'
  if (value < 1_800) return '10-30m'
  if (value < 3_600) return '30-60m'
  return '>=60m'
}

function realizedCostBps(trade: NormalizedPaperTrade): number | null {
  const raw = trade as unknown as Record<string, unknown>
  if (
    costEvidenceSource(trade) === 'paper_cost_model_at_open' ||
    raw.costEvidenceStatus === 'paper_model_not_exchange_reconciled'
  ) {
    return null
  }
  const explicitBps = numberOrNull(
    raw.realizedRoundTripCostBps ??
    raw.realizedCostBps ??
    raw.fillAdjustedCostBps ??
    raw.routeRealizedCostBps,
  )
  if (explicitBps != null && explicitBps >= 0) return explicitBps
  const explicitPct = numberOrNull(
    raw.realizedRoundTripCostPct ??
    raw.realizedCostPct ??
    raw.fillAdjustedCostPct,
  )
  if (explicitPct != null && explicitPct >= 0) return explicitPct * 100
  return null
}

function costEvidenceSource(trade: NormalizedPaperTrade): string | null {
  const raw = trade as unknown as Record<string, unknown>
  return typeof raw.costEvidenceSource === 'string' ? raw.costEvidenceSource : null
}

function markMatchPenaltyBps(trade: NormalizedPaperTrade): number[] {
  const raw = trade as unknown as Record<string, unknown>
  const explicitPenalty = numberOrNull(raw.markMatchPenaltyBpsAtOpen ?? raw.markMatchPenaltyBps)
  if (explicitPenalty != null && explicitPenalty >= 0) return [explicitPenalty]
  const markPrice = numberOrNull(raw.markPriceAtOpen ?? raw.markPrice)
  const matchPrice = numberOrNull(raw.matchPriceAtOpen ?? raw.matchPrice)
  if (markPrice == null || markPrice <= 0 || matchPrice == null || matchPrice <= 0) return []
  return [Math.abs(matchPrice - markPrice) / markPrice * 10_000]
}

function markMatchStatus(trade: NormalizedPaperTrade): string {
  const raw = trade as unknown as Record<string, unknown>
  const explicit = typeof raw.markMatchStatusAtOpen === 'string'
    ? raw.markMatchStatusAtOpen
    : typeof raw.markMatchStatus === 'string'
      ? raw.markMatchStatus
      : null
  if (explicit) return explicit
  const markPrice = numberOrNull(raw.markPriceAtOpen ?? raw.markPrice)
  const matchPrice = numberOrNull(raw.matchPriceAtOpen ?? raw.matchPrice)
  if (markPrice == null || matchPrice == null) return 'missing'
  if (markPrice <= 0 || matchPrice <= 0) return 'invalid'
  return 'ok'
}

function p1ArtifactBusinessStatus(key: string, value: unknown): 'pass' | 'warn' | 'fail' | 'unknown' {
  if (key === 'gateEffectiveness') {
    const report = value as GateEffectivenessReport
    return report.gateStatus === 'harmful' ? 'fail' : report.gateStatus === 'insufficient_data' ? 'warn' : 'pass'
  }
  if (key === 'costModelDiagnostics') {
    return (value as CostModelDiagnosticsReport).quarantine ? 'warn' : 'pass'
  }
  if (key === 'trialLedger') {
    return (value as TrialLedgerReport).status === 'invalid_trial_ledger' ? 'fail' : 'warn'
  }
  if (key === 'trialSourceCoverage') {
    return (value as TrialSourceCoverageReport).status === 'blocked' ? 'warn' : 'pass'
  }
  if (key === 'stoplossRiskPolicy') {
    return (value as StoplossRiskPolicyReport).status === 'blocked' ? 'warn' : 'pass'
  }
  return 'pass'
}

function p1ArtifactRecordsOut(key: string, value: unknown): number {
  if (key === 'alphaHypothesisRegistry') return (value as AlphaHypothesisRegistry).entries.length
  if (key === 'trialLedger') return (value as TrialLedgerReport).entries.length
  if (key === 'trialSourceCoverage') return (value as TrialSourceCoverageReport).nextPatchTargets.length
  if (key === 'mfeMaeStoploss') return (value as MfeMaeStoplossReport).diagnostics.length
  if (key === 'stoplossRiskPolicy') return (value as StoplossRiskPolicyReport).failClosedReviewQueue.length
  if (key === 'candidateKillCriteria') return (value as CandidateKillCriteriaReport).candidates.length
  return 1
}

function p1ArtifactErrorClass(key: string, value: unknown): string | null {
  if (key === 'gateEffectiveness' && (value as GateEffectivenessReport).gateStatus === 'harmful') {
    return 'gate_harmful_accept_underperforms_skip'
  }
  if (key === 'costModelDiagnostics' && (value as CostModelDiagnosticsReport).quarantine) {
    return 'cost_model_quarantine'
  }
  if (key === 'trialLedger' && (value as TrialLedgerReport).status !== 'valid') {
    return 'trial_ledger_not_promotion_complete'
  }
  if (key === 'trialSourceCoverage' && (value as TrialSourceCoverageReport).status === 'blocked') {
    return 'trial_source_coverage_blocked'
  }
  if (key === 'stoplossRiskPolicy' && (value as StoplossRiskPolicyReport).status === 'blocked') {
    return 'stoploss_risk_policy_blocked'
  }
  return null
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const keyValue = token.slice(2)
    const eq = keyValue.indexOf('=')
    if (eq >= 0) {
      out.set(keyValue.slice(0, eq), keyValue.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out.set(keyValue, next)
      i += 1
    } else {
      out.set(keyValue, 'true')
    }
  }
  return out
}

function parseTimeframe(value: string): PaperUniverseTimeframe {
  if (value === '1h' || value === '5m' || value === '1s') return value
  throw new Error(`Unsupported timeframe: ${value}`)
}

function parseNullablePositiveNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '' || value.trim().toLowerCase() === 'null') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Expected positive number, got ${value}`)
  return parsed
}

function normalizedContextCutoverTs(): string {
  return normalizedIsoTimestamp(process.env.OPENALICE_CONTEXT_CUTOVER_TS, DEFAULT_CONTEXT_CUTOVER_TS)
}

function normalizedContextEnforcementTs(cutoverTs = normalizedContextCutoverTs()): string {
  return normalizedIsoTimestamp(process.env.OPENALICE_CONTEXT_ENFORCEMENT_TS, DEFAULT_CONTEXT_ENFORCEMENT_TS, cutoverTs)
}

function normalizedIsoTimestamp(value: string | undefined, fallback: string, floor?: string): string {
  const parsed = value ? Date.parse(value) : Number.NaN
  const fallbackParsed = Date.parse(fallback)
  const floorParsed = floor ? Date.parse(floor) : Number.NaN
  const selected = Number.isFinite(parsed)
    ? parsed
    : Number.isFinite(fallbackParsed)
      ? fallbackParsed
      : Date.parse(DEFAULT_CONTEXT_CUTOVER_TS)
  const floored = Number.isFinite(floorParsed) ? Math.max(selected, floorParsed) : selected
  return new Date(floored).toISOString()
}

function readJsonFile(path: string): { ok: true; value: unknown } | { ok: false; status: 'missing' | 'invalid'; note: string } {
  if (!existsSync(path)) return { ok: false, status: 'missing', note: 'path missing' }
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf-8')) }
  } catch (error) {
    return {
      ok: false,
      status: 'invalid',
      note: error instanceof Error ? error.message : String(error),
    }
  }
}

function listJsonFiles(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter(file => pattern.test(file))
      .map(file => join(dir, file))
      .sort()
  } catch {
    return []
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonValue(item)]),
  )
}

function normalizeFamilyId(value: string): string {
  const normalized = value
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  if (normalized.includes('cross_sectional')) return 'cross_sectional'
  if (normalized.includes('volume_breakout')) return 'volume_breakout'
  if (normalized.includes('microstructure')) return 'microstructure'
  if (normalized.includes('carry') || normalized.includes('funding') || normalized.includes('basis')) return 'carry_basis'
  if (normalized.includes('liquidation')) return 'liquidation_aftermath'
  return normalized || 'unknown_family'
}

function inferFamilyFromPolicyId(value: string): string {
  return normalizeFamilyId(value)
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error(`Invalid boolean value: ${value}`)
}

function minIso(values: string[]): string | null {
  const parsed = values.map(value => Date.parse(value)).filter(Number.isFinite)
  return parsed.length > 0 ? new Date(Math.min(...parsed)).toISOString() : null
}

function maxIso(values: string[]): string | null {
  const parsed = values.map(value => Date.parse(value)).filter(Number.isFinite)
  return parsed.length > 0 ? new Date(Math.max(...parsed)).toISOString() : null
}

function countStrings(values: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const value of values) out[value] = (out[value] ?? 0) + 1
  return out
}

function averageNullable(values: Array<number | null>): number | null {
  const filtered = values.filter((value): value is number => value != null)
  return filtered.length > 0 ? mean(filtered) : null
}

function medianNullable(values: Array<number | null>): number | null {
  const filtered = values.filter((value): value is number => value != null)
  return filtered.length > 0 ? median(filtered) : null
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0)
}

function mean(values: number[]): number {
  return values.length > 0 ? sum(values) / values.length : 0
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function quantile(values: number[], probability: number): number | null {
  if (values.length === 0) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const boundedProbability = Math.max(0, Math.min(1, probability))
  const index = boundedProbability * (sorted.length - 1)
  const lowerIndex = Math.floor(index)
  const upperIndex = Math.ceil(index)
  if (lowerIndex === upperIndex) return sorted[lowerIndex]
  const weight = index - lowerIndex
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function classifyShadowContextCoverage(context: Record<string, unknown>): ContextCoverageBucket {
  const status = stringOrNull(context.contextStatus)
  const reason = stringOrNull(context.contextReason)?.toLowerCase() ?? ''
  if (status === 'stale' || reason.includes('stale')) return 'stale'
  if (status === 'timeout' || reason.includes('timeout')) return 'timeout'
  return shadowContextMissingFields(context).length === 0 ? 'ok' : 'new_missing'
}

function summarizeShadowContextCoverage(
  opens: ParsedPaperPolicyShadowOpen[],
): GateEffectivenessReport['shadowContextCoverage'] {
  const counts: Record<ContextCoverageBucket, number> = {
    ok: 0,
    stale: 0,
    timeout: 0,
    legacy_missing: 0,
    new_missing: 0,
  }
  const missingRequiredFields: Record<string, number> = {}
  for (const open of opens) {
    const bucket = classifyShadowContextCoverage(open.context)
    counts[bucket] += 1
    for (const field of shadowContextMissingFields(open.context)) {
      missingRequiredFields[field] = (missingRequiredFields[field] ?? 0) + 1
    }
  }
  const coveragePct = opens.length > 0 ? counts.ok / opens.length * 100 : 0
  return {
    openSignals: opens.length,
    ok: counts.ok,
    stale: counts.stale,
    timeout: counts.timeout,
    newMissing: counts.new_missing,
    legacyMissing: counts.legacy_missing,
    coveragePct,
    missingRequiredFields,
    promotionEligible: false,
    promotionBlocked: opens.length === 0 || coveragePct < 95,
  }
}

function shadowContextMissingFields(context: Record<string, unknown>): string[] {
  return paperPolicyShadowOpenMissingV3ContextFields(context)
}

function booleanOrNull(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes'].includes(normalized)) return true
    if (['false', '0', 'no'].includes(normalized)) return false
  }
  return null
}

function roundFinite(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(10)) : value
}

function hashString(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseP1TradingEvidenceArgs(argv)
  const index = await buildP1TradingEvidence(args)
  if (args.json) {
    console.log(JSON.stringify(index, null, 2))
  } else {
    console.log(`p1 trading evidence: outputDir=${index.outputDir} artifacts=${Object.keys(index.artifacts).length}`)
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
