import { describe, expect, it } from 'vitest'
import {
  CARRY_REPORTED_REGIME_GATE_NOTE,
  CARRY_RESEARCH_ONLY_NOTE,
  buildCarryReportedRegimeGate,
  buildCarryResearchArtifactMetadata,
} from './carry_protocol_artifacts.ts'

describe('carry_protocol_artifacts', () => {
  it('marks sweep-family outputs as research-only artifacts', () => {
    expect(buildCarryResearchArtifactMetadata({
      artifactKind: 'research_sweep',
      summaryKind: 'coarse_threshold_sweep',
      candidateCount: 300,
      significanceTrialCount: 300,
    })).toEqual({
      artifactKind: 'research_sweep',
      summaryKind: 'coarse_threshold_sweep',
      executable: false,
      validationGrade: false,
      candidateCount: 300,
      significanceScope: {
        trialCount: 300,
        mode: 'research_only',
        note: CARRY_RESEARCH_ONLY_NOTE,
      },
    })
  })

  it('marks ETH carry regime gates as reported-only metadata', () => {
    expect(buildCarryReportedRegimeGate({
      allowedEntryRegimes: ['HighVolMeanRevert', 'LowVolCarry'],
      exitOnMismatch: true,
    })).toEqual({
      allowedEntryRegimes: ['HighVolMeanRevert', 'LowVolCarry'],
      exitOnMismatch: true,
      artifactKind: 'reported_regime_gate_metadata',
      executable: false,
      implementedInBacktest: false,
      note: CARRY_REPORTED_REGIME_GATE_NOTE,
    })
  })
})
