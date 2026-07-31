import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>
type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'unassigned'
type DefectStatus = 'open' | 'partial' | 'watch' | 'pass' | 'unknown'

interface CliArgs {
  outputPath: string | null
  strategyDefectMonitorPath: string
  strategyReportPath: string
  crossSectionalPath: string
  crossSectionalPaperPath: string
  volumeBreakoutPath: string
  microstructurePath: string
  actionGatePath: string
  scoringPath: string
  staleDataNoOpenGateStatusPath: string
  panicRegimeNoOpenGateStatusPath: string
  strategyRiskCapStatusPath: string
  partialTakeProfitStatusPath: string
  mfeMaeStoplossReportPath: string
  liveDataFreshnessPath: string
  ethCarryEvidencePath: string
  ethCarryProspectiveEvidencePath: string
  dynamicLeverageVolatilityGateStatusPath: string
  decisionContextCoverageGateStatusPath: string
  pitAuditGlobalGateStatusPath: string
  routeCostModelCompletenessGateStatusPath: string
  marketIntelNoOpenGateStatusPath: string
  crossSectionalConfigGateStatusPath: string
  volumeBreakoutConfigGateStatusPath: string
  wfoStabilityGateStatusPath: string
  portfolioRiskManagementGateStatusPath: string
  killSwitchGateStatusPath: string
  accountCorruptionGateStatusPath: string
  json: boolean
}

interface SourceSnapshot {
  path: string
  exists: boolean
  text: string
}

interface DefectDefinition {
  id: string
  section: string
  layer: string
  title: string
  priority: Priority
  evidencePaths: string[]
  impacts: string[]
  relatedMonitorFindingIds: string[]
  benchmarkLessons: string[]
  nextActions: string[]
}

interface DefectEntry extends DefectDefinition {
  status: DefectStatus
  observed: Record<string, unknown>
  blockers: string[]
  monitorCoverage: {
    covered: boolean
    matchingFindingIds: string[]
    matchingBlockers: string[]
  }
}

interface RegistrySources {
  strategyReport: SourceSnapshot
  crossSectional: SourceSnapshot
  crossSectionalPaper: SourceSnapshot
  volumeBreakout: SourceSnapshot
  microstructure: SourceSnapshot
  actionGate: SourceSnapshot
  scoring: SourceSnapshot
  staleDataNoOpenGateStatus: UnknownRecord | null
  panicRegimeNoOpenGateStatus: UnknownRecord | null
  strategyRiskCapStatus: UnknownRecord | null
  partialTakeProfitStatus: UnknownRecord | null
  mfeMaeStoplossReport: UnknownRecord | null
  dynamicLeverageVolatilityGateStatus: UnknownRecord | null
  decisionContextCoverageGateStatus: UnknownRecord | null
  pitAuditGlobalGateStatus: UnknownRecord | null
  routeCostModelCompletenessGateStatus: UnknownRecord | null
  marketIntelNoOpenGateStatus: UnknownRecord | null
  crossSectionalConfigGateStatus: UnknownRecord | null
  volumeBreakoutConfigGateStatus: UnknownRecord | null
  wfoStabilityGateStatus: UnknownRecord | null
  portfolioRiskManagementGateStatus: UnknownRecord | null
  killSwitchGateStatus: UnknownRecord | null
  accountCorruptionGateStatus: UnknownRecord | null
}

interface DefectAssessmentContext {
  sources: RegistrySources
  strategyDefectMonitor: UnknownRecord | null
  monitorFindings: UnknownRecord[]
  monitorBlockers: string[]
  liveDataFreshness: UnknownRecord | null
  ethCarryEvidence: UnknownRecord | null
  ethCarryProspectiveEvidence: UnknownRecord | null
}

export interface StrategyDefectRegistryReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: 'blocked' | 'watch_only'
  sourceArtifacts: Record<string, string>
  summary: {
    defects: number
    open: number
    partial: number
    watch: number
    pass: number
    unknown: number
    p0OpenOrPartial: number
    p1OpenOrPartial: number
    monitorCovered: number
    monitorUncovered: number
  }
  defects: DefectEntry[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/research/strategy_defect_registry.latest.json'

async function main(): Promise<void> {
  const args = parseStrategyDefectRegistryArgs(process.argv.slice(2))
  const report = await runStrategyDefectRegistry(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }
}

export function parseStrategyDefectRegistryArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    strategyDefectMonitorPath: raw.get('strategyDefectMonitorPath') ?? 'data/research/strategy_defect_monitor.latest.json',
    strategyReportPath: raw.get('strategyReportPath') ?? '/Users/kino/Downloads/openalice_strategy_improvement.md',
    crossSectionalPath: raw.get('crossSectionalPath') ?? 'src/domain/strategy/cross-sectional-momentum.ts',
    crossSectionalPaperPath: raw.get('crossSectionalPaperPath') ?? 'scripts/paper_trade_cross_sectional.ts',
    volumeBreakoutPath: raw.get('volumeBreakoutPath') ?? 'src/domain/strategy/volume-breakout.ts',
    microstructurePath: raw.get('microstructurePath') ?? 'scripts/paper_trade_microstructure_stress.ts',
    actionGatePath: raw.get('actionGatePath') ?? 'src/domain/strategy/governance/action-gate.ts',
    scoringPath: raw.get('scoringPath') ?? 'src/domain/strategy/governance/scoring.ts',
    staleDataNoOpenGateStatusPath: raw.get('staleDataNoOpenGateStatusPath') ?? 'data/runtime/stale_data_no_open_gate_status.latest.json',
    panicRegimeNoOpenGateStatusPath: raw.get('panicRegimeNoOpenGateStatusPath') ?? 'data/runtime/panic_regime_no_open_gate_status.latest.json',
    strategyRiskCapStatusPath: raw.get('strategyRiskCapStatusPath') ?? 'data/runtime/strategy_risk_cap_status.latest.json',
    partialTakeProfitStatusPath: raw.get('partialTakeProfitStatusPath') ?? 'data/runtime/partial_take_profit_status.latest.json',
    mfeMaeStoplossReportPath: raw.get('mfeMaeStoplossReportPath') ?? 'data/runtime/p1_trading_evidence/mfe_mae_stoploss_report.latest.json',
    liveDataFreshnessPath: raw.get('liveDataFreshnessPath') ?? 'data/runtime/live_data_freshness.latest.json',
    ethCarryEvidencePath: raw.get('ethCarryEvidencePath') ?? 'data/research/eth_carry_research_evidence_status.latest.json',
    ethCarryProspectiveEvidencePath: raw.get('ethCarryProspectiveEvidencePath') ?? 'data/research/eth_carry_prospective_evidence_status.latest.json',
    dynamicLeverageVolatilityGateStatusPath: raw.get('dynamicLeverageVolatilityGateStatusPath') ?? 'data/runtime/dynamic_leverage_volatility_gate_status.latest.json',
    decisionContextCoverageGateStatusPath: raw.get('decisionContextCoverageGateStatusPath') ?? 'data/runtime/decision_context_coverage_gate_status.latest.json',
    pitAuditGlobalGateStatusPath: raw.get('pitAuditGlobalGateStatusPath') ?? 'data/runtime/pit_audit_global_gate_status.latest.json',
    routeCostModelCompletenessGateStatusPath: raw.get('routeCostModelCompletenessGateStatusPath') ?? 'data/runtime/route_cost_model_completeness_gate_status.latest.json',
    marketIntelNoOpenGateStatusPath: raw.get('marketIntelNoOpenGateStatusPath') ?? 'data/runtime/market_intel_no_open_gate_status.latest.json',
    crossSectionalConfigGateStatusPath: raw.get('crossSectionalConfigGateStatusPath') ?? 'data/runtime/cross_sectional_config_gate_status.latest.json',
    volumeBreakoutConfigGateStatusPath: raw.get('volumeBreakoutConfigGateStatusPath') ?? 'data/runtime/volume_breakout_config_gate_status.latest.json',
    wfoStabilityGateStatusPath: raw.get('wfoStabilityGateStatusPath') ?? 'data/runtime/wfo_stability_gate_status.latest.json',
    portfolioRiskManagementGateStatusPath: raw.get('portfolioRiskManagementGateStatusPath') ?? 'data/runtime/portfolio_risk_management_gate_status.latest.json',
    killSwitchGateStatusPath: raw.get('killSwitchGateStatusPath') ?? 'data/runtime/kill_switch_gate_status.latest.json',
    accountCorruptionGateStatusPath: raw.get('accountCorruptionGateStatusPath') ?? 'data/runtime/account_corruption_gate_status.latest.json',
    json: parseBool(raw.get('json'), false),
  }
}

export async function runStrategyDefectRegistry(inputArgs: Partial<CliArgs>): Promise<StrategyDefectRegistryReport> {
  const args: CliArgs = {
    ...parseStrategyDefectRegistryArgs([]),
    ...inputArgs,
  }
  const startedAt = new Date()
  const sourceArtifacts = {
    strategyDefectMonitor: resolve(args.strategyDefectMonitorPath),
    strategyReport: resolve(args.strategyReportPath),
    crossSectional: resolve(args.crossSectionalPath),
    crossSectionalPaper: resolve(args.crossSectionalPaperPath),
    volumeBreakout: resolve(args.volumeBreakoutPath),
    microstructure: resolve(args.microstructurePath),
    actionGate: resolve(args.actionGatePath),
    scoring: resolve(args.scoringPath),
    staleDataNoOpenGateStatus: resolve(args.staleDataNoOpenGateStatusPath),
    panicRegimeNoOpenGateStatus: resolve(args.panicRegimeNoOpenGateStatusPath),
    strategyRiskCapStatus: resolve(args.strategyRiskCapStatusPath),
    partialTakeProfitStatus: resolve(args.partialTakeProfitStatusPath),
    mfeMaeStoplossReport: resolve(args.mfeMaeStoplossReportPath),
    liveDataFreshness: resolve(args.liveDataFreshnessPath),
    ethCarryEvidence: resolve(args.ethCarryEvidencePath),
    ethCarryProspectiveEvidence: resolve(args.ethCarryProspectiveEvidencePath),
    dynamicLeverageVolatilityGateStatus: resolve(args.dynamicLeverageVolatilityGateStatusPath),
    decisionContextCoverageGateStatus: resolve(args.decisionContextCoverageGateStatusPath),
    pitAuditGlobalGateStatus: resolve(args.pitAuditGlobalGateStatusPath),
    routeCostModelCompletenessGateStatus: resolve(args.routeCostModelCompletenessGateStatusPath),
    marketIntelNoOpenGateStatus: resolve(args.marketIntelNoOpenGateStatusPath),
    crossSectionalConfigGateStatus: resolve(args.crossSectionalConfigGateStatusPath),
    volumeBreakoutConfigGateStatus: resolve(args.volumeBreakoutConfigGateStatusPath),
    wfoStabilityGateStatus: resolve(args.wfoStabilityGateStatusPath),
    portfolioRiskManagementGateStatus: resolve(args.portfolioRiskManagementGateStatusPath),
    killSwitchGateStatus: resolve(args.killSwitchGateStatusPath),
    accountCorruptionGateStatus: resolve(args.accountCorruptionGateStatusPath),
  }
  const report = buildStrategyDefectRegistryReport({
    generatedAt: new Date().toISOString(),
    sourceArtifacts,
    sources: {
      strategyReport: await readSource(sourceArtifacts.strategyReport),
      crossSectional: await readSource(sourceArtifacts.crossSectional),
      crossSectionalPaper: await readSource(sourceArtifacts.crossSectionalPaper),
      volumeBreakout: await readSource(sourceArtifacts.volumeBreakout),
      microstructure: await readSource(sourceArtifacts.microstructure),
      actionGate: await readSource(sourceArtifacts.actionGate),
      scoring: await readSource(sourceArtifacts.scoring),
      staleDataNoOpenGateStatus: asRecord(await readJsonIfExists(sourceArtifacts.staleDataNoOpenGateStatus)),
      panicRegimeNoOpenGateStatus: asRecord(await readJsonIfExists(sourceArtifacts.panicRegimeNoOpenGateStatus)),
      strategyRiskCapStatus: asRecord(await readJsonIfExists(sourceArtifacts.strategyRiskCapStatus)),
      partialTakeProfitStatus: asRecord(await readJsonIfExists(sourceArtifacts.partialTakeProfitStatus)),
      mfeMaeStoplossReport: asRecord(await readJsonIfExists(sourceArtifacts.mfeMaeStoplossReport)),
      dynamicLeverageVolatilityGateStatus: asRecord(await readJsonIfExists(sourceArtifacts.dynamicLeverageVolatilityGateStatus)),
      decisionContextCoverageGateStatus: asRecord(await readJsonIfExists(sourceArtifacts.decisionContextCoverageGateStatus)),
      pitAuditGlobalGateStatus: asRecord(await readJsonIfExists(sourceArtifacts.pitAuditGlobalGateStatus)),
      routeCostModelCompletenessGateStatus: asRecord(await readJsonIfExists(sourceArtifacts.routeCostModelCompletenessGateStatus)),
      marketIntelNoOpenGateStatus: asRecord(await readJsonIfExists(sourceArtifacts.marketIntelNoOpenGateStatus)),
      crossSectionalConfigGateStatus: asRecord(await readJsonIfExists(sourceArtifacts.crossSectionalConfigGateStatus)),
      volumeBreakoutConfigGateStatus: asRecord(await readJsonIfExists(sourceArtifacts.volumeBreakoutConfigGateStatus)),
      wfoStabilityGateStatus: asRecord(await readJsonIfExists(sourceArtifacts.wfoStabilityGateStatus)),
      portfolioRiskManagementGateStatus: asRecord(await readJsonIfExists(sourceArtifacts.portfolioRiskManagementGateStatus)),
      killSwitchGateStatus: asRecord(await readJsonIfExists(sourceArtifacts.killSwitchGateStatus)),
      accountCorruptionGateStatus: asRecord(await readJsonIfExists(sourceArtifacts.accountCorruptionGateStatus)),
    },
    strategyDefectMonitor: asRecord(await readJsonIfExists(sourceArtifacts.strategyDefectMonitor)),
    liveDataFreshness: asRecord(await readJsonIfExists(sourceArtifacts.liveDataFreshness)),
    ethCarryEvidence: asRecord(await readJsonIfExists(sourceArtifacts.ethCarryEvidence)),
    ethCarryProspectiveEvidence: asRecord(await readJsonIfExists(sourceArtifacts.ethCarryProspectiveEvidence)),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'strategy_defect_registry',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'watch_only' ? 'warn' : 'fail',
      recordsIn: report.defects.length,
      recordsOut: report.blockers.length,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export function buildStrategyDefectRegistryReport(input: {
  generatedAt?: string
  sourceArtifacts: Record<string, string>
  sources: RegistrySources
  strategyDefectMonitor: UnknownRecord | null
  liveDataFreshness: UnknownRecord | null
  ethCarryEvidence: UnknownRecord | null
  ethCarryProspectiveEvidence: UnknownRecord | null
}): StrategyDefectRegistryReport {
  const monitorFindings = readRecordArray(input.strategyDefectMonitor?.findings)
  const monitorBlockers = readStringArray(input.strategyDefectMonitor?.blockers)
  const defects = DEFECT_CATALOG.map(defect => enrichDefect(defect, {
    sources: input.sources,
    strategyDefectMonitor: input.strategyDefectMonitor,
    monitorFindings,
    monitorBlockers,
    liveDataFreshness: input.liveDataFreshness,
    ethCarryEvidence: input.ethCarryEvidence,
    ethCarryProspectiveEvidence: input.ethCarryProspectiveEvidence,
  }))
  const summary = {
    defects: defects.length,
    open: defects.filter(item => item.status === 'open').length,
    partial: defects.filter(item => item.status === 'partial').length,
    watch: defects.filter(item => item.status === 'watch').length,
    pass: defects.filter(item => item.status === 'pass').length,
    unknown: defects.filter(item => item.status === 'unknown').length,
    p0OpenOrPartial: defects.filter(item => item.priority === 'P0' && ['open', 'partial', 'unknown'].includes(item.status)).length,
    p1OpenOrPartial: defects.filter(item => item.priority === 'P1' && ['open', 'partial', 'unknown'].includes(item.status)).length,
    monitorCovered: defects.filter(item => item.monitorCoverage.covered).length,
    monitorUncovered: defects.filter(item => !item.monitorCoverage.covered).length,
  }
  const blockers = defects
    .filter(item => ['open', 'partial', 'unknown'].includes(item.status))
    .flatMap(item => item.blockers.map(blocker => `${item.id}:${blocker}`))

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: blockers.length > 0 ? 'blocked' : 'watch_only',
    sourceArtifacts: input.sourceArtifacts,
    summary,
    defects,
    blockers: uniqueStrings(blockers),
    nextActions: [
      'Use this registry as the checklist for strategy repair; every high-priority defect needs code evidence and runtime artifact evidence before it can leave open/partial.',
      'Prioritize P0 defects that affect real execution quality: liquidity enforcement, route cost/slippage evidence, stale-data fail-closed gates, and positive net expectancy.',
      'Keep paper/live gates closed until strategy_defect_monitor, release gates, prospective evidence, and paper telemetry all agree.',
    ],
    safetyNotes: [
      'This registry is diagnostic only; it cannot authorize paper orders, live orders, leverage changes, promotion, or best_config mutations.',
      'A watch/pass status here only means the defect has code/artifact evidence; profitability still requires WFO, FDR, PIT, prospective outcomes, route costs, and paper telemetry.',
    ],
  }
}

function enrichDefect(defect: DefectDefinition, context: DefectAssessmentContext): DefectEntry {
  const matchingFindings = context.monitorFindings.filter(finding =>
    defect.relatedMonitorFindingIds.includes(readString(finding.id) ?? ''),
  )
  const matchingFindingIds = matchingFindings
    .map(finding => readString(finding.id))
    .filter((item): item is string => item != null)
  const matchingBlockers = context.monitorBlockers.filter(blocker =>
    defect.relatedMonitorFindingIds.some(id => blocker.startsWith(`${id}:`)),
  )
  const assessed = assessDefect(defect, context)
  return {
    ...defect,
    status: assessed.status,
    observed: assessed.observed,
    blockers: assessed.blockers,
    monitorCoverage: {
      covered: matchingFindingIds.length > 0,
      matchingFindingIds,
      matchingBlockers,
    },
  }
}

function assessDefect(defect: DefectDefinition, context: DefectAssessmentContext): {
  status: DefectStatus
  observed: Record<string, unknown>
  blockers: string[]
} {
  const cs = context.sources.crossSectional.text
  const paperCs = context.sources.crossSectionalPaper.text
  const vb = context.sources.volumeBreakout.text
  const micro = context.sources.microstructure.text
  const actionGate = context.sources.actionGate.text
  const scoring = context.sources.scoring.text
  const staleDataNoOpenGateStatus = context.sources.staleDataNoOpenGateStatus
  const staleDataNoOpenGateChecks = asRecord(staleDataNoOpenGateStatus?.checks)
  const panicRegimeNoOpenGateStatus = context.sources.panicRegimeNoOpenGateStatus
  const panicRegimeNoOpenGateChecks = asRecord(panicRegimeNoOpenGateStatus?.checks)
  const strategyRiskCapStatus = context.sources.strategyRiskCapStatus
  const strategyRiskCapChecks = asRecord(strategyRiskCapStatus?.checks)
  const partialTakeProfitStatus = context.sources.partialTakeProfitStatus
  const partialTakeProfitChecks = asRecord(partialTakeProfitStatus?.checks)
  const mfeMaeStoplossReport = context.sources.mfeMaeStoplossReport
  const mfeMaeCoverage = asRecord(mfeMaeStoplossReport?.coverage)
  const mfeMaeAttribution = asRecord(mfeMaeStoplossReport?.stopLossAttribution)
  const liveFreshnessStatus = readString(context.liveDataFreshness?.status)
  const dynamicLeverageVolatilityGateStatus = context.sources.dynamicLeverageVolatilityGateStatus
  const dynamicLeverageVolatilityGateChecks = asRecord(dynamicLeverageVolatilityGateStatus?.checks)
  const ethCarryBlockers = readStringArray(context.ethCarryEvidence?.blockers)
  const ethCarryPitEvidence = asRecord(context.ethCarryEvidence?.pitEvidence)
  const ethCarryBasisEvidence = asRecord(context.ethCarryEvidence?.basisEvidence)
  const ethCarryCostEvidence = asRecord(context.ethCarryEvidence?.costEvidence)
  const ethCarryProspectiveCounts = asRecord(context.ethCarryProspectiveEvidence?.counts)
  const ethCarryProspectiveMetrics = asRecord(context.ethCarryProspectiveEvidence?.metrics)
  const ethCarryProspectiveThresholds = asRecord(context.ethCarryProspectiveEvidence?.thresholds)
  const ethCarryRuntimeFeeStatus = readString(ethCarryCostEvidence?.runtimeFeeStatus)
  const decisionContextCoverageGateStatus = context.sources.decisionContextCoverageGateStatus
  const decisionContextCoverageGateChecks = asRecord(decisionContextCoverageGateStatus?.checks)
  const pitAuditGlobalGateStatus = context.sources.pitAuditGlobalGateStatus
  const pitAuditGlobalGateChecks = asRecord(pitAuditGlobalGateStatus?.checks)
  const routeCostModelCompletenessGateStatus = context.sources.routeCostModelCompletenessGateStatus
  const routeCostModelCompletenessGateChecks = asRecord(routeCostModelCompletenessGateStatus?.checks)
  const marketIntelNoOpenGateStatus = context.sources.marketIntelNoOpenGateStatus
  const marketIntelNoOpenGateChecks = asRecord(marketIntelNoOpenGateStatus?.checks)
  const crossSectionalConfigGateStatus = context.sources.crossSectionalConfigGateStatus
  const crossSectionalConfigGateChecks = asRecord(crossSectionalConfigGateStatus?.checks)
  const volumeBreakoutConfigGateStatus = context.sources.volumeBreakoutConfigGateStatus
  const volumeBreakoutConfigGateChecks = asRecord(volumeBreakoutConfigGateStatus?.checks)
  const wfoStabilityGateStatus = context.sources.wfoStabilityGateStatus
  const wfoStabilityGateChecks = asRecord(wfoStabilityGateStatus?.checks)
  const portfolioRiskManagementGateStatus = context.sources.portfolioRiskManagementGateStatus
  const portfolioRiskManagementGateChecks = asRecord(portfolioRiskManagementGateStatus?.checks)
  const killSwitchGateStatus = context.sources.killSwitchGateStatus
  const killSwitchGateChecks = asRecord(killSwitchGateStatus?.checks)
  const accountCorruptionGateStatus = context.sources.accountCorruptionGateStatus
  const accountCorruptionGateChecks = asRecord(accountCorruptionGateStatus?.checks)

  switch (defect.id) {
    case '1.1.1': {
      const retiredLineGuard = context.monitorFindings.find(finding => readString(finding.id) === 'retired_line_guard')
      const retiredLineObserved = asRecord(retiredLineGuard?.observed)
      const retiredLineGuardPassed = readString(retiredLineGuard?.status) === 'pass' &&
        readBoolean(retiredLineObserved?.retired) === true &&
        readBoolean(retiredLineObserved?.hasReactivationChecklist) === true &&
        readBoolean(retiredLineObserved?.artifactAllowsExecution) === false
      return retiredLineGuardPassed
        ? watch(defect, {
            currentCommentStillClaimsReversal: cs.includes('short-term reversal'),
            currentWinRateEvidenceRequired: true,
            retiredLineGuardStatus: readString(retiredLineGuard?.status),
            lineRetired: readBoolean(retiredLineObserved?.retired),
            hasReactivationChecklist: readBoolean(retiredLineObserved?.hasReactivationChecklist),
            artifactAllowsExecution: readBoolean(retiredLineObserved?.artifactAllowsExecution),
          }, 'retired_line_runtime_guard_passed_requires_new_alpha_before_reactivation')
        : open(defect, {
            currentCommentStillClaimsReversal: cs.includes('short-term reversal'),
            currentWinRateEvidenceRequired: true,
            retiredLineGuardStatus: readString(retiredLineGuard?.status),
            lineRetired: readBoolean(retiredLineObserved?.retired),
            hasReactivationChecklist: readBoolean(retiredLineObserved?.hasReactivationChecklist),
            artifactAllowsExecution: readBoolean(retiredLineObserved?.artifactAllowsExecution),
          }, 'reversal_hypothesis_requires_current_runtime_retirement_or_regime_gate')
    }
    case '1.1.2': {
      const gateStatus = readString(crossSectionalConfigGateStatus?.status)
      const gatePresent = crossSectionalConfigGateStatus != null && gateStatus === 'pass'
      return numberWatch(defect, extractNumberAfterKey(cs, 'mtfWeight'), 0.35, 'fixed_mtf_weight_still_present')
    }
    case '1.1.3': {
      return numberWatch(defect, extractNumberAfterKey(cs, 'fundingWeight'), 0.25, 'funding_weight_still_high_or_fixed')
    }
    case '1.1.4': {
      return numberWatch(defect, extractNumberAfterKey(cs, 'minSpreadPct'), 5, 'min_spread_threshold_still_low_or_fixed')
    }
    case '1.1.5': {
      return open(defect, { hasRegimeFilter: cs.includes('regime') && cs.includes('PanicIndex') }, 'cross_sectional_regime_filter_missing')
    }
    case '1.1.6': {
      return partial(defect, { hasConfidence: cs.includes('confidence'), stillTopBottomBuckets: cs.includes('topN') && cs.includes('bottomN') }, 'continuous_confidence_needs_runtime_validation')
    }
    case '1.1.7': {
      return numberWatch(defect, extractNumberAfterKey(cs, 'maxVolPercentile'), 0.9, 'vol_ceiling_still_permissive')
    }
    case '1.2.1':
      return numberWatch(defect, extractNumberAfterKey(vb, 'volumeLookbackBars'), 24, 'volume_lookback_still_short_for_noise_rejection')
    case '1.2.2':
      return numberWatch(defect, extractNumberAfterKey(vb, 'volumeMultiplier'), 2.5, 'volume_multiplier_still_low')
    case '1.2.3':
      return partial(defect, { holdBars: extractNumberAfterKey(vb, 'holdBars'), dynamicHold: vb.includes('dynamic') || vb.includes('ATR') }, 'hold_bars_fixed_no_dynamic_exit')
    case '1.2.4':
      return partial(defect, { stopLossPct: extractNumberAfterKey(vb, 'stopLossPct'), atrBased: vb.includes('ATR') }, 'fixed_stop_needs_atr_or_volatility_scaling')
    case '1.2.5':
      return numberWatch(defect, extractNumberAfterKey(vb, 'minBreakQuality'), 0.35, 'break_quality_threshold_still_low')
    case '1.3.1': {
      const stressOnly100x = /id:\s*['"]liquidation_probe_100x['"][\s\S]{0,220}mode:\s*['"]stress_only['"]/.test(micro)
      return stressOnly100x
        ? watch(defect, { stressOnly100x }, '100x_profile_is_stress_only_needs_runtime_validation')
        : open(defect, { stressOnly100x }, '100x_profile_not_quarantined')
    }
    case '1.3.2':
      return open(defect, { mentionsOrderBookDepth: micro.includes('orderBook') || micro.includes('depth') }, 'order_book_depth_check_missing')
    case '2.1':
      return paperCs.includes('computeAtrTrailingStop')
        ? watch(defect, { atrTrailingIntegrated: true }, 'atr_trailing_integrated_needs_outcome_validation')
        : open(defect, { atrTrailingIntegrated: false }, 'atr_trailing_not_integrated')
    case '2.2':
      return readString(partialTakeProfitStatus?.status) === 'pass' &&
        readBoolean(partialTakeProfitStatus?.promotionEligible) === false &&
        readBoolean(partialTakeProfitStatus?.paperTradingAllowed) === false &&
        readBoolean(partialTakeProfitStatus?.liveTradingAllowed) === false &&
        readBoolean(partialTakeProfitStatus?.executionAllowed) === false &&
        readNumber(partialTakeProfitChecks?.longFirstTrancheCloseFraction) === 0.5 &&
        readNumber(partialTakeProfitChecks?.longIncrementalCloseFraction) === 0.25 &&
        readNumber(partialTakeProfitChecks?.shortFirstTrancheCloseFraction) === 0.5 &&
        readNumber(partialTakeProfitChecks?.notTriggeredCloseFraction) === 0
        ? watch(defect, {
            partialTakeProfitStatus: readString(partialTakeProfitStatus?.status),
            artifactAllowsExecution: false,
            longFirstTrancheCloseFraction: readNumber(partialTakeProfitChecks?.longFirstTrancheCloseFraction),
            longIncrementalCloseFraction: readNumber(partialTakeProfitChecks?.longIncrementalCloseFraction),
            shortFirstTrancheCloseFraction: readNumber(partialTakeProfitChecks?.shortFirstTrancheCloseFraction),
            notTriggeredCloseFraction: readNumber(partialTakeProfitChecks?.notTriggeredCloseFraction),
            totalConfiguredCloseFraction: readNumber(partialTakeProfitChecks?.totalConfiguredCloseFraction),
          }, 'partial_take_profit_primitive_runtime_validated_needs_paper_outcome_validation')
        : open(defect, {
            partialTakeProfitStatus: readString(partialTakeProfitStatus?.status),
            paperTextMentionsPartialTakeProfit: paperCs.includes('partial') && paperCs.includes('take'),
            longFirstTrancheCloseFraction: readNumber(partialTakeProfitChecks?.longFirstTrancheCloseFraction),
            longIncrementalCloseFraction: readNumber(partialTakeProfitChecks?.longIncrementalCloseFraction),
            shortFirstTrancheCloseFraction: readNumber(partialTakeProfitChecks?.shortFirstTrancheCloseFraction),
            notTriggeredCloseFraction: readNumber(partialTakeProfitChecks?.notTriggeredCloseFraction),
          }, 'partial_take_profit_missing_or_not_runtime_validated')
    case '2.3':
      return watch(defect, { expectedHoldingHours: extractNumberAfterKey(paperCs, 'expectedHoldingHours') }, 'holding_window_reduced_needs_runtime_validation')
    case '2.4':
      return partial(defect, { runtimeFeeStatus: ethCarryRuntimeFeeStatus, runtimeFeeVerified: ethCarryRuntimeFeeStatus === 'runtime_verified' }, 'per_trade_cost_evidence_coverage_required')
    case '2.5':
      return open(defect, { slippageTelemetry: paperCs.includes('slippage') }, 'slippage_estimation_or_telemetry_missing')
    case '2.6':
      return partial(defect, { maxSpreadBps: cs.includes('maxSpreadBps') || vb.includes('maxSpreadBps') }, 'spread_optional_needs_strict_runtime_enforcement')
    case '2.7':
      return mfeMaeStoplossReport != null &&
        readString(mfeMaeStoplossReport?.metricBasis) === 'price_path_bps' &&
        readNumber(mfeMaeCoverage?.closedTrades) != null &&
        readNumber(mfeMaeCoverage?.closedTrades)! > 0 &&
        readNumber(mfeMaeCoverage?.closedDiagnosticsOk) === readNumber(mfeMaeCoverage?.closedTrades) &&
        readNumber(mfeMaeCoverage?.stopLossTrades) != null &&
        readNumber(mfeMaeCoverage?.stopLossTrades)! > 0 &&
        readNumber(mfeMaeCoverage?.stopLossDiagnosticsOk) === readNumber(mfeMaeCoverage?.stopLossTrades) &&
        readNumber(mfeMaeCoverage?.stopLossDiagnosticsOkPct) === 100 &&
        readBoolean(mfeMaeAttribution?.promotionEligible) === false &&
        readBoolean(mfeMaeAttribution?.policyMutationAllowed) === false &&
        readBoolean(mfeMaeAttribution?.profitabilityClaimAllowed) === false &&
        readBoolean(mfeMaeStoplossReport?.promotionClaimAllowed) === false &&
        readBoolean(mfeMaeStoplossReport?.profitabilityClaimAllowed) === false &&
        readBoolean(mfeMaeStoplossReport?.executionReplayClaimAllowed) === false
        ? watch(defect, {
            metricBasis: readString(mfeMaeStoplossReport?.metricBasis),
            closedTrades: readNumber(mfeMaeCoverage?.closedTrades),
            closedDiagnosticsOk: readNumber(mfeMaeCoverage?.closedDiagnosticsOk),
            stopLossTrades: readNumber(mfeMaeCoverage?.stopLossTrades),
            stopLossDiagnosticsOk: readNumber(mfeMaeCoverage?.stopLossDiagnosticsOk),
            stopLossDiagnosticsOkPct: readNumber(mfeMaeCoverage?.stopLossDiagnosticsOkPct),
            stopLossKnownOrdering: readNumber(mfeMaeCoverage?.stopLossKnownOrdering),
            stopLossCoarseOrdering: readNumber(mfeMaeCoverage?.stopLossCoarseOrdering),
            stopLossAttributionStatus: readString(mfeMaeAttribution?.status),
            promotionClaimAllowed: readBoolean(mfeMaeStoplossReport?.promotionClaimAllowed),
            executionReplayClaimAllowed: readBoolean(mfeMaeStoplossReport?.executionReplayClaimAllowed),
          }, 'mfe_mae_path_diagnostics_runtime_validated_needs_policy_outcome_validation')
        : open(defect, {
            paperTextMentionsMfeMae: paperCs.includes('MFE') || paperCs.includes('MAE'),
            metricBasis: readString(mfeMaeStoplossReport?.metricBasis),
            closedTrades: readNumber(mfeMaeCoverage?.closedTrades),
            closedDiagnosticsOk: readNumber(mfeMaeCoverage?.closedDiagnosticsOk),
            stopLossTrades: readNumber(mfeMaeCoverage?.stopLossTrades),
            stopLossDiagnosticsOk: readNumber(mfeMaeCoverage?.stopLossDiagnosticsOk),
            stopLossDiagnosticsOkPct: readNumber(mfeMaeCoverage?.stopLossDiagnosticsOkPct),
          }, 'mfe_mae_tracking_missing_or_low_coverage')
    case '2.8':
      return open(defect, { entryTimingTelemetry: paperCs.includes('entryTiming') || paperCs.includes('entry timing') }, 'entry_timing_quality_missing')
    case '3.1':
      return partial(defect, { minDailyVolumeUsd: cs.includes('minDailyVolumeUsd'), minVolumeUsd: vb.includes('minVolumeUsd') }, 'liquidity_filters_need_runtime_trade_coverage_validation')
    case '3.2':
      return readString(marketIntelNoOpenGateStatus?.status) === 'pass' &&
        readBoolean(marketIntelNoOpenGateStatus?.promotionEligible) === false &&
        readBoolean(marketIntelNoOpenGateStatus?.paperTradingAllowed) === false &&
        readBoolean(marketIntelNoOpenGateStatus?.liveTradingAllowed) === false &&
        readBoolean(marketIntelNoOpenGateStatus?.executionAllowed) === false
        ? watch(defect, {
            marketIntelNoOpenGateStatus: readString(marketIntelNoOpenGateStatus?.status),
            riskOffOpenContextStatus: readString(marketIntelNoOpenGateChecks?.riskOffOpenContextStatus),
            severeNewsOpenContextStatus: readString(marketIntelNoOpenGateChecks?.severeNewsOpenContextStatus),
            laneBlockedOpenContextStatus: readString(marketIntelNoOpenGateChecks?.laneBlockedOpenContextStatus),
            symbolBlockedOpenContextStatus: readString(marketIntelNoOpenGateChecks?.symbolBlockedOpenContextStatus),
            allowedOpenContextStatus: readString(marketIntelNoOpenGateChecks?.allowedOpenContextStatus),
            artifactAllowsExecution: false,
          }, 'market_intel_no_open_gate_runtime_validated_needs_live_context_coverage')
        : open(defect, {
            marketIntelMentioned: context.sources.strategyReport.text.includes('MarketIntel'),
            marketIntelNoOpenGateStatus: readString(marketIntelNoOpenGateStatus?.status),
          }, 'blacklist_is_reactive_not_pre_trade_gate')
    case '3.3':
      return readString(panicRegimeNoOpenGateStatus?.status) === 'pass' &&
        readBoolean(panicRegimeNoOpenGateStatus?.promotionEligible) === false &&
        readBoolean(panicRegimeNoOpenGateStatus?.paperTradingAllowed) === false &&
        readBoolean(panicRegimeNoOpenGateStatus?.liveTradingAllowed) === false &&
        readBoolean(panicRegimeNoOpenGateStatus?.executionAllowed) === false &&
        readString(panicRegimeNoOpenGateChecks?.eventFreezeRegime) === 'event-risk-freeze' &&
        readString(panicRegimeNoOpenGateChecks?.eventFreezeOpenDecisionMode) === 'blocked' &&
        readBoolean(panicRegimeNoOpenGateChecks?.eventFreezeReducePassThrough) === true &&
        readString(panicRegimeNoOpenGateChecks?.volStressRegime) === 'vol-stress' &&
        readString(panicRegimeNoOpenGateChecks?.volStressOpenDecisionMode) === 'blocked' &&
        readBoolean(panicRegimeNoOpenGateChecks?.volStressReducePassThrough) === true
        ? watch(defect, {
            panicRegimeStatus: readString(panicRegimeNoOpenGateStatus?.status),
            eventFreezeRegime: readString(panicRegimeNoOpenGateChecks?.eventFreezeRegime),
            eventFreezeActionStatus: readString(panicRegimeNoOpenGateChecks?.eventFreezeActionStatus),
            eventFreezeOpenDecisionMode: readString(panicRegimeNoOpenGateChecks?.eventFreezeOpenDecisionMode),
            eventFreezeReducePassThrough: readBoolean(panicRegimeNoOpenGateChecks?.eventFreezeReducePassThrough),
            volStressRegime: readString(panicRegimeNoOpenGateChecks?.volStressRegime),
            volStressOpenDecisionMode: readString(panicRegimeNoOpenGateChecks?.volStressOpenDecisionMode),
            volStressReducePassThrough: readBoolean(panicRegimeNoOpenGateChecks?.volStressReducePassThrough),
            artifactAllowsExecution: false,
          }, 'panic_regime_no_open_gate_runtime_validated_needs_live_context_coverage')
        : open(defect, {
            panicIndexInActionGate: actionGate.includes('PanicIndex') || actionGate.includes('panic'),
            panicRegimeStatus: readString(panicRegimeNoOpenGateStatus?.status),
            eventFreezeRegime: readString(panicRegimeNoOpenGateChecks?.eventFreezeRegime),
            eventFreezeOpenDecisionMode: readString(panicRegimeNoOpenGateChecks?.eventFreezeOpenDecisionMode),
            volStressRegime: readString(panicRegimeNoOpenGateChecks?.volStressRegime),
            volStressOpenDecisionMode: readString(panicRegimeNoOpenGateChecks?.volStressOpenDecisionMode),
          }, 'panic_index_not_hard_wired_to_action_gate')
    case '3.4':
      return numberMinimum(defect, extractProbeScoreThreshold(actionGate), 65, 'governance_probe_threshold_needs_raise_or_runtime_justification')
    case '3.5':
      return readString(strategyRiskCapStatus?.status) === 'pass' &&
        readBoolean(asRecord(strategyRiskCapChecks?.singleTradeLossProbe)?.approved) === false &&
        (readString(asRecord(strategyRiskCapChecks?.singleTradeLossProbe)?.reason)?.includes('maxSingleTradeLossUsd') ?? false)
        ? watch(defect, {
            strategyRiskCapStatus: readString(strategyRiskCapStatus?.status),
            maxSingleTradeLossUsdConfigured: readNumber(strategyRiskCapChecks?.maxSingleTradeLossUsdConfigured),
            singleTradeLossProbeApproved: readBoolean(asRecord(strategyRiskCapChecks?.singleTradeLossProbe)?.approved),
            singleTradeLossReason: readString(asRecord(strategyRiskCapChecks?.singleTradeLossProbe)?.reason),
          }, 'single_trade_max_loss_cap_runtime_validated')
        : open(defect, {
            strategyRiskCapStatus: readString(strategyRiskCapStatus?.status),
            maxSingleLoss: paperCs.includes('maxSingle') || paperCs.includes('singleLoss'),
            maxSingleTradeLossUsdConfigured: readNumber(strategyRiskCapChecks?.maxSingleTradeLossUsdConfigured),
          }, 'single_trade_max_loss_limit_missing')
    case '3.6':
      return readString(dynamicLeverageVolatilityGateStatus?.status) === 'pass' &&
        readBoolean(dynamicLeverageVolatilityGateStatus?.researchOnly) === true &&
        readBoolean(dynamicLeverageVolatilityGateStatus?.diagnosticOnly) === true &&
        readBoolean(dynamicLeverageVolatilityGateStatus?.promotionEligible) === false &&
        readBoolean(dynamicLeverageVolatilityGateStatus?.paperTradingAllowed) === false &&
        readBoolean(dynamicLeverageVolatilityGateStatus?.liveTradingAllowed) === false &&
        readBoolean(dynamicLeverageVolatilityGateStatus?.executionAllowed) === false &&
        readNumber(dynamicLeverageVolatilityGateChecks?.volatilityPercentile) != null &&
        readNumber(dynamicLeverageVolatilityGateChecks?.recommendedMaxLeverage) != null
        ? watch(defect, {
            dynamicLeverageVolatilityGateStatus: readString(dynamicLeverageVolatilityGateStatus?.status),
            volatilityPercentile: readNumber(dynamicLeverageVolatilityGateChecks?.volatilityPercentile),
            recommendedMaxLeverage: readNumber(dynamicLeverageVolatilityGateChecks?.recommendedMaxLeverage),
            tier: readString(dynamicLeverageVolatilityGateChecks?.tier),
            currentMaxLeverage: readNumber(dynamicLeverageVolatilityGateChecks?.currentMaxLeverage),
            leverageBlocked: readBoolean(dynamicLeverageVolatilityGateChecks?.leverageBlocked),
            artifactAllowsExecution: false,
          }, 'dynamic_leverage_volatility_gate_runtime_validated_needs_live_context_coverage')
        : open(defect, {
            microstructureMentionsVolatilityAndLeverage: context.sources.microstructure.text.includes('volatility') && context.sources.microstructure.text.includes('leverage'),
            dynamicLeverageVolatilityGateStatus: readString(dynamicLeverageVolatilityGateStatus?.status),
            volatilityPercentile: readNumber(dynamicLeverageVolatilityGateChecks?.volatilityPercentile),
            recommendedMaxLeverage: readNumber(dynamicLeverageVolatilityGateChecks?.recommendedMaxLeverage),
          }, 'dynamic_leverage_by_volatility_missing')
    case '3.7':
      return readString(strategyRiskCapStatus?.status) === 'pass' &&
        readBoolean(asRecord(strategyRiskCapChecks?.correlatedGroupExposureProbe)?.approved) === false &&
        (readString(asRecord(strategyRiskCapChecks?.correlatedGroupExposureProbe)?.reason)?.includes('maxCorrelatedGroupExposurePctOfEquity') ?? false)
        ? watch(defect, {
            strategyRiskCapStatus: readString(strategyRiskCapStatus?.status),
            correlationCheck: true,
            correlationBasis: 'static_correlated_exposure_group',
            maxCorrelatedGroupExposurePctOfEquityConfigured: readNumber(strategyRiskCapChecks?.maxCorrelatedGroupExposurePctOfEquityConfigured),
            correlatedGroupExposureProbeApproved: readBoolean(asRecord(strategyRiskCapChecks?.correlatedGroupExposureProbe)?.approved),
            correlatedGroupExposureReason: readString(asRecord(strategyRiskCapChecks?.correlatedGroupExposureProbe)?.reason),
          }, 'static_correlated_group_exposure_cap_runtime_validated_needs_rolling_correlation_upgrade')
        : open(defect, {
            strategyRiskCapStatus: readString(strategyRiskCapStatus?.status),
            correlationCheck: paperCs.includes('correlation'),
            maxCorrelatedGroupExposurePctOfEquityConfigured: readNumber(strategyRiskCapChecks?.maxCorrelatedGroupExposurePctOfEquityConfigured),
          }, 'portfolio_correlation_check_missing')
    case '4.1':
      return liveFreshnessStatus === 'fresh'
        ? watch(defect, { liveDataFreshnessStatus: liveFreshnessStatus }, 'fresh_now_but_scheduler_monitoring_required')
        : open(defect, { liveDataFreshnessStatus: liveFreshnessStatus }, 'live_data_not_fresh')
    case '4.2': {
      const gateStatus = readString(decisionContextCoverageGateStatus?.status)
      const coveragePct = readNumber(decisionContextCoverageGateChecks?.coveragePct) ?? 0
      const coverageBelowThreshold = readBoolean(decisionContextCoverageGateChecks?.coverageBelowThreshold) ?? true
      return gateStatus === 'pass' && !coverageBelowThreshold
        ? watch(defect, { decisionContextCoverageGateStatus: gateStatus, coveragePct, coverageBelowThreshold }, 'decision_context_coverage_gate_runtime_validated_needs_continuous_monitoring')
        : open(defect, { decisionContextCoverageGateStatus: gateStatus, coveragePct, coverageBelowThreshold }, 'decision_context_snapshot_coverage_low')
    }
    case '4.3': {
      const pitGateStatus = readString(pitAuditGlobalGateStatus?.status)
      const carryPitAuditPassingRows = readNumber(pitAuditGlobalGateChecks?.carryPitAuditPassingRows) ?? 0
      const carryPitAuditTotalRows = readNumber(pitAuditGlobalGateChecks?.carryPitAuditTotalRows) ?? 0
      const globalPitAuditImplemented = readBoolean(pitAuditGlobalGateChecks?.globalPitAuditImplemented) ?? false
      const carryFundingAvailableTimeStatus = readString(pitAuditGlobalGateChecks?.carryFundingAvailableTimeStatus)
      const carryBasisAvailableTimeStatus = readString(pitAuditGlobalGateChecks?.carryBasisAvailableTimeStatus)
      const carryPitOK = carryPitAuditPassingRows > 0 && carryPitAuditTotalRows > 0
      if (!globalPitAuditImplemented && carryPitOK) {
        return partial(defect, {
          pitAuditGlobalGateStatus: pitGateStatus,
          carryPitAuditPassingRows,
          carryPitAuditTotalRows,
          globalPitAuditImplemented,
          carryFundingAvailableTimeStatus,
          carryBasisAvailableTimeStatus,
        }, 'pit_available_at_fixed_for_carry_not_global')
      }
      if (carryPitOK && globalPitAuditImplemented) {
        return watch(defect, {
          pitAuditGlobalGateStatus: pitGateStatus,
          carryPitAuditPassingRows,
          carryPitAuditTotalRows,
          globalPitAuditImplemented,
        }, 'global_pit_audit_runtime_validated_needs_continuous_coverage')
      }
      return open(defect, {
        pitAuditGlobalGateStatus: pitGateStatus,
        carryPitAuditPassingRows,
        carryPitAuditTotalRows,
        carryFundingAvailableTimeStatus,
        carryBasisAvailableTimeStatus,
      }, 'feature_availability_audit_missing')
    }
    case '4.4':
      return actionGate.includes("staleDataApplied") && actionGate.includes("'no-trade'") &&
        readString(staleDataNoOpenGateStatus?.status) === 'pass' &&
        readString(staleDataNoOpenGateChecks?.staleHighConfidenceActionStatus) === 'no-trade' &&
        readString(staleDataNoOpenGateChecks?.staleOpenDecisionMode) === 'blocked' &&
        readBoolean(staleDataNoOpenGateChecks?.staleReducePassThrough) === true
        ? watch(defect, {
            staleDataNoTrade: true,
            staleDataNoOpenGateStatus: readString(staleDataNoOpenGateStatus?.status),
            staleOpenDecisionMode: readString(staleDataNoOpenGateChecks?.staleOpenDecisionMode),
            staleReducePassThrough: readBoolean(staleDataNoOpenGateChecks?.staleReducePassThrough),
          }, 'stale_data_fail_closed_runtime_validated')
        : open(defect, {
            staleDataNoTrade: actionGate.includes("staleDataApplied") && actionGate.includes("'no-trade'"),
            staleDataNoOpenGateStatus: readString(staleDataNoOpenGateStatus?.status),
            staleOpenDecisionMode: readString(staleDataNoOpenGateChecks?.staleOpenDecisionMode),
            staleReducePassThrough: readBoolean(staleDataNoOpenGateChecks?.staleReducePassThrough),
          }, 'stale_data_fail_closed_runtime_validation_missing')
    case '5.1':
      return open(defect, { minUniverseSize: extractNumberAfterKey(cs, 'minUniverseSize') }, 'backtest_universe_size_needs_20_plus_enforcement')
    case '5.2':
      return open(defect, { cpcvMentioned: context.sources.strategyReport.text.includes('CPCV') }, 'cpcv_validation_missing')
    case '5.3': {
      const routeCostGateStatus = readString(routeCostModelCompletenessGateStatus?.status)
      const routesModeled = readNumber(routeCostModelCompletenessGateChecks?.routesModeled) ?? 0
      const slippageTracked = readBoolean(routeCostModelCompletenessGateChecks?.slippageTracked) ?? false
      const adverseSelectionTracked = readBoolean(routeCostModelCompletenessGateChecks?.adverseSelectionTracked) ?? false
      const allRoutesModeled = readBoolean(routeCostModelCompletenessGateChecks?.allRoutesModeled) ?? false
      const feeSnapshotVerifiedByRuntime = readBoolean(routeCostModelCompletenessGateChecks?.feeSnapshotVerifiedByRuntime) ?? false
      const allPassing = routeCostGateStatus === 'pass' && routesModeled > 0 && slippageTracked && adverseSelectionTracked && allRoutesModeled
      if (allPassing) {
        return watch(defect, {
          routeCostGateStatus,
          routesModeled,
          slippageTracked,
          adverseSelectionTracked,
          allRoutesModeled,
          feeSnapshotVerifiedByRuntime,
        }, 'route_cost_model_completeness_gate_runtime_validated_needs_fill_telemetry')
      }
      return partial(defect, {
        routeCostGateStatus,
        routesModeled,
        slippageTracked,
        adverseSelectionTracked,
        allRoutesModeled,
        feeSnapshotVerifiedByRuntime,
      }, 'route_cost_and_slippage_model_still_incomplete')
    }
    case '5.4':
      return open(defect, { sharpeGuard: context.sources.strategyReport.text.includes('Sharpe') }, 'unrealistic_sharpe_guard_missing')
    case '5.5':
      return partial(defect, { wfoMentioned: context.strategyDefectMonitor != null }, 'forced_oos_periods_need_registry_validation')
    case '5.6': {
      const closedOutcomes = readNumber(ethCarryProspectiveMetrics?.closedOutcomes) ?? readNumber(ethCarryProspectiveCounts?.closedEvents) ?? 0
      const closedDecisionWindows = readNumber(ethCarryProspectiveCounts?.closedDecisionWindows) ?? 0
      const minClosedOutcomes = readNumber(ethCarryProspectiveThresholds?.minClosedOutcomes) ?? 100
      const minNonOverlappingWindows = readNumber(ethCarryProspectiveThresholds?.minNonOverlappingWindows) ?? 3
      const meanGrossCarryPairReturnPct = readNumber(ethCarryProspectiveMetrics?.meanGrossCarryPairReturnPct)
      const enoughSamples = closedOutcomes >= minClosedOutcomes && closedDecisionWindows >= minNonOverlappingWindows
      const meanPositive = meanGrossCarryPairReturnPct != null && meanGrossCarryPairReturnPct > 0
      return enoughSamples && meanPositive
        ? watch(defect, {
            status: readString(context.ethCarryProspectiveEvidence?.status),
            closedOutcomes,
            closedDecisionWindows,
            meanGrossCarryPairReturnPct,
          }, 'prospective_profitability_needs_wfo_fdr_paper_confirmation')
        : partial(defect, {
            status: readString(context.ethCarryProspectiveEvidence?.status),
            closedOutcomes,
            closedDecisionWindows,
            minClosedOutcomes,
            minNonOverlappingWindows,
            meanGrossCarryPairReturnPct,
            winRatePct: readNumber(ethCarryProspectiveMetrics?.winRatePct),
          }, 'carry_prospective_samples_or_return_not_sufficient')
    }
    case '6.1':
      return open(defect, { dryRunMentioned: context.sources.strategyReport.text.includes('dryRun') }, 'continuous_improvement_loop_still_diagnostic_only')
    case '6.2':
      return open(defect, { llmAnalysisMentioned: context.sources.strategyReport.text.includes('llmAnalysis') }, 'llm_analysis_no_safe_parameter_patch_lane')
    case '6.3': {
      const wfoStabilityVerdict = readString(wfoStabilityGateChecks?.wfoStability?.verdict)
      return wfoStabilityVerdict === 'pass'
        ? watch(defect, { wfoStabilityVerdict, wfoFastModeMentioned: context.sources.strategyReport.text.includes('WFO') }, 'wfo_stability_gate_pass_needs_continuous_monitoring')
        : open(defect, { wfoStabilityVerdict, wfoFastModeMentioned: context.sources.strategyReport.text.includes('WFO') }, 'wfo_window_protocol_needs_stability_guard')
    }
    case '6.4': {
      const paramStabilityVerdict = readString(wfoStabilityGateChecks?.paramStability?.verdict)
      return paramStabilityVerdict === 'pass'
        ? watch(defect, { paramStabilityVerdict, parameterStability: context.sources.strategyReport.text.includes('参数稳定') }, 'param_stability_gate_pass_needs_continuous_monitoring')
        : open(defect, { paramStabilityVerdict, parameterStability: context.sources.strategyReport.text.includes('参数稳定') }, 'parameter_stability_check_missing')
    }
    case '6.5': {
      const stabilityReportingVerdict = readString(wfoStabilityGateChecks?.stabilityReporting?.verdict)
      return stabilityReportingVerdict === 'pass'
        ? partial(defect, { stabilityReportingVerdict, promotionBlocked: true }, 'promotion_gate_blocked_until_strategy_quality_improves')
        : partial(defect, { stabilityReportingVerdict, promotionBlocked: true }, 'promotion_gate_blocked_until_strategy_quality_improves')
    }
    case '7.1': {
      const portfolioRiskVerdict = readString(portfolioRiskManagementGateChecks?.portfolioRiskMgmt?.verdict)
      const positionSizingVerdict = readString(portfolioRiskManagementGateChecks?.positionSizing?.verdict)
      return portfolioRiskVerdict === 'pass' && positionSizingVerdict === 'pass'
        ? watch(defect, { portfolioRiskVerdict, positionSizingVerdict, accountCountMentioned: context.sources.strategyReport.text.includes('12') }, 'portfolio_risk_management_gate_pass_needs_continuous_monitoring')
        : open(defect, { portfolioRiskVerdict, positionSizingVerdict, accountCountMentioned: context.sources.strategyReport.text.includes('12') }, 'multi_account_portfolio_risk_missing')
    }
    case '7.2':
      return readString(strategyRiskCapStatus?.status) === 'pass' &&
        readBoolean(asRecord(strategyRiskCapChecks?.totalExposureProbe)?.approved) === false &&
        (readString(asRecord(strategyRiskCapChecks?.totalExposureProbe)?.reason)?.includes('maxTotalExposurePctOfEquity') ?? false) &&
        readBoolean(asRecord(strategyRiskCapChecks?.reduceOnlyPassThroughProbe)?.approved) === true
        ? watch(defect, {
            strategyRiskCapStatus: readString(strategyRiskCapStatus?.status),
            totalExposureCap: true,
            maxTotalExposurePctOfEquityConfigured: readNumber(strategyRiskCapChecks?.maxTotalExposurePctOfEquityConfigured),
            totalExposureProbeApproved: readBoolean(asRecord(strategyRiskCapChecks?.totalExposureProbe)?.approved),
            totalExposureReason: readString(asRecord(strategyRiskCapChecks?.totalExposureProbe)?.reason),
            reduceOnlyPassThrough: true,
          }, 'total_exposure_cap_runtime_validated')
        : open(defect, {
            strategyRiskCapStatus: readString(strategyRiskCapStatus?.status),
            totalExposureCap: paperCs.includes('totalExposure'),
            maxTotalExposurePctOfEquityConfigured: readNumber(strategyRiskCapChecks?.maxTotalExposurePctOfEquityConfigured),
          }, 'total_exposure_cap_missing')
    case '7.3':
      return readString(strategyRiskCapStatus?.status) === 'pass' &&
        readBoolean(asRecord(strategyRiskCapChecks?.symbolConcentrationProbe)?.approved) === false &&
        (readString(asRecord(strategyRiskCapChecks?.symbolConcentrationProbe)?.reason)?.includes('maxSymbolExposurePctOfEquity') ?? false)
        ? watch(defect, {
            strategyRiskCapStatus: readString(strategyRiskCapStatus?.status),
            concentrationLimit: true,
            maxSymbolExposurePctOfEquityConfigured: readNumber(strategyRiskCapChecks?.maxSymbolExposurePctOfEquityConfigured),
            symbolConcentrationProbeApproved: readBoolean(asRecord(strategyRiskCapChecks?.symbolConcentrationProbe)?.approved),
            symbolConcentrationReason: readString(asRecord(strategyRiskCapChecks?.symbolConcentrationProbe)?.reason),
          }, 'symbol_concentration_cap_runtime_validated')
        : open(defect, {
            strategyRiskCapStatus: readString(strategyRiskCapStatus?.status),
            concentrationLimit: paperCs.includes('concentration'),
            maxSymbolExposurePctOfEquityConfigured: readNumber(strategyRiskCapChecks?.maxSymbolExposurePctOfEquityConfigured),
          }, 'symbol_concentration_limit_missing')
    case '7.4':
      return readString(strategyRiskCapStatus?.status) === 'pass' &&
        readBoolean(asRecord(strategyRiskCapChecks?.netDirectionalExposureProbe)?.approved) === false &&
        (readString(asRecord(strategyRiskCapChecks?.netDirectionalExposureProbe)?.reason)?.includes('maxNetDirectionalExposurePctOfEquity') ?? false)
        ? watch(defect, {
            strategyRiskCapStatus: readString(strategyRiskCapStatus?.status),
            marketNeutral: true,
            maxNetDirectionalExposurePctOfEquityConfigured: readNumber(strategyRiskCapChecks?.maxNetDirectionalExposurePctOfEquityConfigured),
            netDirectionalExposureProbeApproved: readBoolean(asRecord(strategyRiskCapChecks?.netDirectionalExposureProbe)?.approved),
            netDirectionalExposureReason: readString(asRecord(strategyRiskCapChecks?.netDirectionalExposureProbe)?.reason),
          }, 'net_directional_exposure_cap_runtime_validated')
        : open(defect, {
            strategyRiskCapStatus: readString(strategyRiskCapStatus?.status),
            marketNeutral: paperCs.includes('marketNeutral') || paperCs.includes('netExposure'),
            maxNetDirectionalExposurePctOfEquityConfigured: readNumber(strategyRiskCapChecks?.maxNetDirectionalExposurePctOfEquityConfigured),
          }, 'long_short_neutrality_check_missing')
    default:
      return unknown(defect, {}, 'defect_not_assessed')
  }
}

function open(defect: DefectDefinition, observed: Record<string, unknown>, blocker: string) {
  return { status: 'open' as const, observed, blockers: [blocker] }
}

function partial(defect: DefectDefinition, observed: Record<string, unknown>, blocker: string) {
  return { status: 'partial' as const, observed, blockers: [blocker] }
}

function watch(defect: DefectDefinition, observed: Record<string, unknown>, blocker: string) {
  return { status: 'watch' as const, observed, blockers: [blocker] }
}

function unknown(defect: DefectDefinition, observed: Record<string, unknown>, blocker: string) {
  return { status: 'unknown' as const, observed, blockers: [blocker] }
}

function numberWatch(defect: DefectDefinition, value: number | null, flaggedValue: number, blocker: string) {
  return value === flaggedValue
    ? partial(defect, { value }, blocker)
    : watch(defect, { value }, 'changed_from_report_needs_runtime_validation')
}

function numberMinimum(defect: DefectDefinition, value: number | null, minimum: number, blocker: string) {
  return value != null && value >= minimum
    ? watch(defect, { value, minimum }, 'threshold_changed_needs_runtime_validation')
    : partial(defect, { value, minimum }, blocker)
}

function d(
  id: string,
  section: string,
  layer: string,
  title: string,
  priority: Priority,
  evidencePaths: string[],
  relatedMonitorFindingIds: string[] = [],
  benchmarkLessons: string[] = ['research workflow', 'evidence reporting'],
): DefectDefinition {
  return {
    id,
    section,
    layer,
    title,
    priority,
    evidencePaths,
    impacts: [],
    relatedMonitorFindingIds,
    benchmarkLessons,
    nextActions: ['Convert this defect into code evidence plus refreshed runtime artifact evidence before marking it fixed.'],
  }
}

const DEFECT_CATALOG: DefectDefinition[] = [
  d('1.1.1', '1.1', 'signal_generation.cross_sectional', 'Reversal hypothesis failed in current market', 'P0', ['src/domain/strategy/cross-sectional-momentum.ts', 'data/research/research_line_retirement.latest.json'], ['retired_line_guard']),
  d('1.1.2', '1.1', 'signal_generation.cross_sectional', 'MTF weight is fixed and not regime adaptive', 'P1', ['src/domain/strategy/cross-sectional-momentum.ts', 'data/runtime/cross_sectional_config_gate_status.latest.json'], ['cross_sectional_config_gate']),
  d('1.1.3', '1.1', 'signal_generation.cross_sectional', 'Funding-rate weight is high/noisy', 'P1', ['src/domain/strategy/cross-sectional-momentum.ts', 'data/runtime/cross_sectional_config_gate_status.latest.json'], ['cross_sectional_config_gate']),
  d('1.1.4', '1.1', 'signal_generation.cross_sectional', 'Minimum dispersion threshold too low', 'P1', ['src/domain/strategy/cross-sectional-momentum.ts', 'data/runtime/cross_sectional_config_gate_status.latest.json'], ['cross_sectional_config_gate']),
  d('1.1.5', '1.1', 'signal_generation.cross_sectional', 'No hard trend/regime filter', 'P0', ['src/domain/strategy/cross-sectional-momentum.ts', 'data/runtime/cross_sectional_config_gate_status.latest.json'], ['cross_sectional_config_gate']),
  d('1.1.6', '1.1', 'signal_generation.cross_sectional', 'Ranking buckets are too coarse', 'P1', ['src/domain/strategy/cross-sectional-momentum.ts', 'data/runtime/cross_sectional_config_gate_status.latest.json'], ['cross_sectional_config_gate']),
  d('1.1.7', '1.1', 'signal_generation.cross_sectional', 'Volatility ceiling is permissive', 'P1', ['src/domain/strategy/cross-sectional-momentum.ts', 'data/runtime/cross_sectional_config_gate_status.latest.json'], ['cross_sectional_config_gate']),
  d('1.2.1', '1.2', 'signal_generation.volume_breakout', 'Volume lookback is too short', 'P1', ['src/domain/strategy/volume-breakout.ts'], ['volume_breakout_hold_liquidity']),
  d('1.2.2', '1.2', 'signal_generation.volume_breakout', 'Volume multiplier threshold is too low', 'P1', ['src/domain/strategy/volume-breakout.ts', 'data/runtime/volume_breakout_config_gate_status.latest.json'], ['volume_breakout_config_gate']),
  d('1.2.3', '1.2', 'signal_generation.volume_breakout', 'Hold bars are fixed', 'P1', ['src/domain/strategy/volume-breakout.ts'], ['volume_breakout_hold_liquidity']),
  d('1.2.4', '1.2', 'signal_generation.volume_breakout', 'Fixed stop is not volatility adaptive', 'P1', ['src/domain/strategy/volume-breakout.ts'], ['volume_breakout_stop_loss']),
  d('1.2.5', '1.2', 'signal_generation.volume_breakout', 'Breakout quality threshold is weak', 'P1', ['src/domain/strategy/volume-breakout.ts', 'data/runtime/volume_breakout_config_gate_status.latest.json'], ['volume_breakout_config_gate']),
  d('1.3.1', '1.3', 'signal_generation.microstructure', '100x liquidation probe must be stress-only', 'P1', ['scripts/paper_trade_microstructure_stress.ts'], ['microstructure_noise_channels']),
  d('1.3.2', '1.3', 'signal_generation.microstructure', 'Order-book depth check missing', 'P0', ['scripts/paper_trade_microstructure_stress.ts'], ['microstructure_noise_channels']),
  d('2.1', '2', 'execution', 'ATR trailing stop not fully validated', 'P0', ['scripts/paper_trade_cross_sectional.ts', 'src/domain/strategy/risk/atr-trailing-stop.ts'], ['atr_trailing_exit_integration']),
  d('2.2', '2', 'execution', 'Partial take-profit missing', 'P0', ['scripts/paper_trade_cross_sectional.ts', 'src/domain/strategy/risk/partial-take-profit.ts', 'data/runtime/partial_take_profit_status.latest.json'], ['atr_trailing_exit_integration']),
  d('2.3', '2', 'execution', '48h holding exposure too long', 'P1', ['scripts/paper_trade_cross_sectional.ts'], ['cross_sectional_holding_window']),
  d('2.4', '2', 'execution', 'Per-trade cost evidence incomplete', 'P0', ['data/runtime/p1_trading_evidence/cost_model_diagnostics.latest.json'], ['route_cost_slippage_readiness']),
  d('2.5', '2', 'execution', 'Slippage estimate/telemetry missing', 'P0', ['scripts/paper_trade_cross_sectional.ts'], ['route_cost_slippage_readiness']),
  d('2.6', '2', 'execution', 'Spread data optional instead of mandatory', 'P0', ['src/domain/strategy/cross-sectional-momentum.ts', 'src/domain/strategy/volume-breakout.ts'], ['cross_sectional_spread_filter']),
  d('2.7', '2', 'execution', 'MFE/MAE tracking missing or low coverage', 'P1', ['data/runtime/p1_trading_evidence/mfe_mae_stoploss_report.latest.json', 'scripts/build_p1_trading_evidence.ts']),
  d('2.8', '2', 'execution', 'Entry timing quality missing', 'P1', [
    'scripts/paper_trade_cross_sectional.ts',
    'data/runtime/p1_trading_evidence/mfe_mae_stoploss_report.latest.json',
    'data/runtime/paper_execution_future_telemetry_watchdog.latest.json',
  ], ['entry_timing_quality']),
  d('3.1', '3', 'risk', 'Liquidity filter needs strict runtime enforcement', 'P0', ['src/domain/strategy/cross-sectional-momentum.ts', 'src/domain/strategy/volume-breakout.ts'], ['cross_sectional_spread_filter', 'volume_breakout_hold_liquidity']),
  d('3.2', '3', 'risk', 'Market-intel blacklist is reactive', 'P1', [
    'src/runtime/paper_open_context.ts',
    'src/runtime/market_intel_context.ts',
    'data/runtime/market_intel_no_open_gate_status.latest.json',
  ], ['market_intel_no_open_gate']),
  d('3.3', '3', 'risk', 'Panic/regime context not hard-gated', 'P1', [
    'src/domain/strategy/governance/action-gate.ts',
    'src/domain/strategy/regime/classifier.ts',
    'src/domain/strategy/execution.ts',
    'data/runtime/panic_regime_no_open_gate_status.latest.json',
    'data/runtime/no_trade_risk_filter.latest.json',
  ], ['panic_regime_no_open_gate']),
  d('3.4', '3', 'risk', 'Governance scoring threshold too low', 'P1', ['src/domain/strategy/governance/action-gate.ts']),
  d('3.5', '3', 'risk', 'Single-trade max loss limit missing', 'P0', ['scripts/paper_trade_cross_sectional.ts']),
  d('3.6', '3', 'risk', 'Leverage is not volatility adaptive', 'P1', ['scripts/paper_trade_microstructure_stress.ts']),
  d('3.7', '3', 'risk', 'Correlation exposure check missing', 'P1', ['scripts/paper_trade_cross_sectional.ts']),
  d('4.1', '4', 'data', 'Live data can become stale', 'P2', ['data/runtime/live_data_freshness.latest.json']),
  d('4.2', '4', 'data', 'Decision context snapshot coverage low', 'P1', ['/Users/kino/Downloads/openalice_strategy_improvement.md', 'data/runtime/decision_context_coverage_gate_status.latest.json'], ['decision_context_coverage_gate']),
  d('4.3', '4', 'data', 'Feature availability/PIT audit incomplete', 'P0', ['data/research/eth_carry_research_evidence_status.latest.json', 'data/runtime/pit_audit_global_gate_status.latest.json'], ['pit_audit_global_gate']),
  d('4.4', '4', 'data', 'Stale data must fail-close opens', 'P0', ['src/domain/strategy/governance/action-gate.ts'], ['stale_data_no_open_gate']),
  d('5.1', '5', 'backtest', 'Backtest asset universe too small', 'P2', ['src/domain/strategy/cross-sectional-momentum.ts']),
  d('5.2', '5', 'backtest', 'CPCV/PBO validation missing', 'P2', ['/Users/kino/Downloads/openalice_strategy_improvement.md']),
  d('5.3', '5', 'backtest', 'Cost model too optimistic', 'P0', ['data/runtime/fee_snapshot_refresh.latest.json', 'data/runtime/route_cost_model_completeness_gate_status.latest.json'], ['route_cost_model_completeness_gate']),
  d('5.4', '5', 'backtest', 'Unrealistic Sharpe guard missing', 'P2', ['/Users/kino/Downloads/openalice_strategy_improvement.md']),
  d('5.5', '5', 'backtest', 'Forced OOS period incomplete', 'P2', ['data/runtime/release_gate_status.json']),
  d('5.6', '5', 'backtest', 'Carry prospective labels insufficient or non-positive', 'P0', ['data/research/eth_carry_prospective_evidence_status.latest.json'], ['carry_prospective_evidence']),
  d('6.1', '6', 'strategy_learning', 'Continuous improvement loop remains dry-run/diagnostic', 'P2', ['/Users/kino/Downloads/openalice_strategy_improvement.md']),
  d('6.2', '6', 'strategy_learning', 'LLM analysis has no safe parameter patch lane', 'P2', ['/Users/kino/Downloads/openalice_strategy_improvement.md']),
  d('6.3', '6', 'strategy_learning', 'WFO window protocol too short or unstable', 'P1', ['data/runtime/release_gate_status.json', 'data/runtime/wfo_stability_gate_status.latest.json'], ['wfo_stability_gate']),
  d('6.4', '6', 'strategy_learning', 'Parameter stability check missing', 'P1', ['/Users/kino/Downloads/openalice_strategy_improvement.md', 'data/runtime/wfo_stability_gate_status.latest.json'], ['wfo_stability_gate']),
  d('6.5', '6', 'strategy_learning', 'Promotion gates all fail for current strategy set', 'P0', ['data/runtime/system_status_reason_chain.latest.json', 'data/runtime/wfo_stability_gate_status.latest.json'], ['wfo_stability_gate']),
  d('7.1', '7', 'portfolio', 'Accounts are not portfolio-risk coordinated', 'P1', ['/Users/kino/Downloads/openalice_strategy_improvement.md', 'data/runtime/portfolio_risk_management_gate_status.latest.json'], ['portfolio_risk_management_gate']),
  d('7.2', '7', 'portfolio', 'Total exposure cap missing', 'P0', ['scripts/paper_trade_cross_sectional.ts']),
  d('7.3', '7', 'portfolio', 'Symbol concentration limit missing', 'P1', ['scripts/paper_trade_cross_sectional.ts']),
  d('7.4', '7', 'portfolio', 'Long/short neutrality check missing', 'P1', ['scripts/paper_trade_cross_sectional.ts']),
]

async function readSource(path: string): Promise<SourceSnapshot> {
  const resolved = resolve(path)
  try {
    return { path: resolved, exists: true, text: await readFile(resolved, 'utf-8') }
  } catch {
    return { path: resolved, exists: false, text: '' }
  }
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf-8'))
  } catch {
    return null
  }
}

function renderConsoleSummary(report: StrategyDefectRegistryReport): string {
  return [
    `Strategy defect registry: ${report.status}`,
    `defects=${report.summary.defects} open=${report.summary.open} partial=${report.summary.partial} watch=${report.summary.watch} pass=${report.summary.pass} unknown=${report.summary.unknown}`,
    `p0OpenOrPartial=${report.summary.p0OpenOrPartial} p1OpenOrPartial=${report.summary.p1OpenOrPartial}`,
    `paper=false live=false promotion=false`,
    `topBlockers=${report.blockers.slice(0, 8).join(',') || 'none'}`,
  ].join('\n')
}

function extractNumberAfterKey(text: string, key: string): number | null {
  const pattern = new RegExp(`${key}\\s*[:=]\\s*([0-9][0-9_]*(?:\\.[0-9]+)?)`)
  const match = pattern.exec(text)
  if (!match) return null
  const parsed = Number(match[1].replaceAll('_', ''))
  return Number.isFinite(parsed) ? parsed : null
}

function extractProbeScoreThreshold(text: string): number | null {
  const probeMatch = /if\s*\(\s*totalScore\s*>=\s*([0-9][0-9_]*(?:\.[0-9]+)?)\s*\)\s*return\s*['"]probe['"]/.exec(text)
  if (!probeMatch) return null
  const parsed = Number(probeMatch[1].replaceAll('_', ''))
  return Number.isFinite(parsed) ? parsed : null
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    i += 1
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' ? null : value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function readRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_strategy_defect_registry failed:', error)
    process.exit(1)
  })
}
