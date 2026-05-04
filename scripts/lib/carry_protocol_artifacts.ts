export const CARRY_RESEARCH_ONLY_NOTE =
  'Exploratory research artifact only; not a holdout-clean validation artifact and not executable runtime policy.'

export const CARRY_REPORTED_REGIME_GATE_NOTE =
  'Reported policy metadata only; the ETH carry backtest path does not execute a regime gate.'

export function buildCarryResearchArtifactMetadata(input: {
  artifactKind: string
  summaryKind: string
  candidateCount: number
  significanceTrialCount: number
}) {
  return {
    artifactKind: input.artifactKind,
    summaryKind: input.summaryKind,
    executable: false,
    validationGrade: false,
    candidateCount: input.candidateCount,
    significanceScope: {
      trialCount: input.significanceTrialCount,
      mode: 'research_only',
      note: CARRY_RESEARCH_ONLY_NOTE,
    },
  }
}

export function buildCarryReportedRegimeGate(input: {
  allowedEntryRegimes: string[]
  exitOnMismatch: boolean
}) {
  return {
    allowedEntryRegimes: [...input.allowedEntryRegimes],
    exitOnMismatch: input.exitOnMismatch,
    artifactKind: 'reported_regime_gate_metadata',
    executable: false,
    implementedInBacktest: false,
    note: CARRY_REPORTED_REGIME_GATE_NOTE,
  }
}
