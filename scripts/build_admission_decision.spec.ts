import { describe, expect, it } from 'vitest'
import {
  admissionEvidenceBundleV1Schema,
  buildAdmissionDecisionFromBundle,
  parseBuildAdmissionArgs,
} from './build_admission_decision.js'

const BINDING = {
  sourceCommit: '1'.repeat(40),
  dirtyStateHash: '2'.repeat(64),
}

describe('build_admission_decision', () => {
  it('emits a research-only blocked snapshot when required gate evidence is absent', async () => {
    const bundle = admissionEvidenceBundleV1Schema.parse({
      schemaVersion: 'admission_evidence_bundle.v1',
      candidateId: 'candidate-v2',
      releaseManifestHash: '3'.repeat(64),
      gates: [],
      accountScope: ['paper-main'],
      assetScope: ['BTC/USD', 'ETH/USD'],
    })
    const decision = await buildAdmissionDecisionFromBundle({
      bundle,
      binding: BINDING,
      now: new Date('2026-08-01T12:00:00.000Z'),
    })
    expect(decision.stage).toBe('research_only')
    expect(decision.paperTradingAllowed).toBe(false)
    expect(decision.liveTradingAllowed).toBe(false)
    expect(decision.liveExecutionArmed).toBe(false)
    expect(decision.blockingReasons).toContain('missing_gate_evidence:source_clean')
  })

  it('does not expose a force or live-arm argument', () => {
    expect(() => parseBuildAdmissionArgs(['--requestLiveExecutionArm', 'true']))
      .toThrow('unknown argument')
    expect(() => parseBuildAdmissionArgs(['--force', 'paper_allowed']))
      .toThrow('unknown argument')
  })
})
