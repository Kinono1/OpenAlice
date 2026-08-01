import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ADMISSION_POLICY,
  reduceAdmissionDecision,
  tryLoadAdmissionDecision,
  writeAdmissionDecision,
  type AdmissionGateEvidenceInput,
  type AdmissionGateRequirement,
} from './admission.js'
import { storeEvidenceArtifact } from './evidence_store.js'

const SOURCE_COMMIT = '1'.repeat(40)
const DIRTY_HASH = '2'.repeat(64)
const RELEASE_HASH = '3'.repeat(64)
const NOW = new Date('2026-08-01T08:00:00.000Z')

describe('AdmissionDecisionV1', () => {
  it('fails closed with precise engineering blockers when evidence is absent', async () => {
    const decision = await reduceAdmissionDecision(baseInput([]))
    expect(decision.stage).toBe('research_only')
    expect(decision.paperTradingAllowed).toBe(false)
    expect(decision.liveTradingAllowed).toBe(false)
    expect(decision.liveExecutionArmed).toBe(false)
    expect(decision.blockingReasons).toContain('missing_gate_evidence:source_clean')
  })

  it('reaches paper_candidate only after every engineering gate passes', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'admission-engineering-'))
    const gates = await gatesFor(tempDir, ['engineering'])
    const decision = await reduceAdmissionDecision(baseInput(gates))
    expect(decision.stage).toBe('paper_candidate')
    expect(decision.paperTradingAllowed).toBe(false)
    expect(decision.blockingReasons).toContain('missing_gate_evidence:promotion_v2_6')
  })

  it('allows paper only after all paper evidence passes', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'admission-paper-'))
    const gates = await gatesFor(tempDir, ['engineering', 'paper'])
    const decision = await reduceAdmissionDecision(baseInput(gates))
    expect(decision.stage).toBe('paper_allowed')
    expect(decision.paperTradingAllowed).toBe(true)
    expect(decision.liveTradingAllowed).toBe(false)
  })

  it('does not arm live execution when live admission is absent', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'admission-arm-blocked-'))
    const gates = await gatesFor(tempDir, ['engineering', 'paper', 'arm'])
    const decision = await reduceAdmissionDecision({
      ...baseInput(gates),
      requestLiveExecutionArm: true,
    })
    expect(decision.liveTradingAllowed).toBe(false)
    expect(decision.liveExecutionArmed).toBe(false)
  })

  it('can represent live admission while leaving execution arm false', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'admission-live-'))
    const gates = await gatesFor(tempDir, [
      'engineering',
      'paper',
      'tiny_cap',
      'live',
      'live_approval',
    ])
    const decision = await reduceAdmissionDecision(baseInput(gates))
    expect(decision.stage).toBe('live_allowed')
    expect(decision.paperTradingAllowed).toBe(true)
    expect(decision.liveTradingAllowed).toBe(true)
    expect(decision.liveExecutionArmed).toBe(false)
  })

  it('rejects unknown evidence schemas', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'admission-schema-'))
    const gates = await gatesFor(tempDir, ['engineering'])
    gates[0] = { ...gates[0]!, acceptedSchemaVersions: ['different.v1'] }
    const decision = await reduceAdmissionDecision(baseInput(gates))
    expect(decision.stage).toBe('research_only')
    expect(decision.gateResults.find((gate) => gate.gateId === gates[0]!.gateId)).toMatchObject({
      status: 'unknown',
    })
  })

  it('marks commit-bound evidence stale after a source change', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'admission-commit-'))
    const gates = await gatesFor(tempDir, ['engineering'])
    const decision = await reduceAdmissionDecision({
      ...baseInput(gates),
      sourceCommit: '9'.repeat(40),
    })
    expect(decision.stage).toBe('research_only')
    expect(decision.gateResults.some((gate) => gate.status === 'stale')).toBe(true)
  })

  it('detects artifact tampering', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'admission-tamper-'))
    const gates = await gatesFor(tempDir, ['engineering'])
    await writeFile(gates[0]!.evidence[0]!.path, '{"tampered":true}\n', 'utf-8')
    const decision = await reduceAdmissionDecision(baseInput(gates))
    expect(decision.stage).toBe('research_only')
    expect(decision.gateResults.find((gate) => gate.gateId === gates[0]!.gateId)?.status).toBe('fail')
  })

  it('propagates a missing parent evidence reference to the dependent gate', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'admission-parent-missing-'))
    const gates = await gatesFor(tempDir, ['engineering'])
    const parent = storeEvidenceArtifact({
      rootDir: tempDir,
      schemaVersion: 'parent.receipt.v1',
      payload: { status: 'pass' },
      generatedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
      sourceCommit: SOURCE_COMMIT,
      dirtyStateHash: DIRTY_HASH,
    })
    const child = storeEvidenceArtifact({
      rootDir: tempDir,
      schemaVersion: gates[0]!.acceptedSchemaVersions[0]!,
      payload: { status: 'pass', dependsOn: parent.artifactHash },
      generatedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
      sourceCommit: SOURCE_COMMIT,
      dirtyStateHash: DIRTY_HASH,
      parentEvidenceRefs: [parent.artifactHash],
    })
    gates[0] = { ...gates[0]!, evidence: [child] }

    const decision = await reduceAdmissionDecision(baseInput(gates))
    expect(decision.stage).toBe('research_only')
    const gateResult = decision.gateResults.find((gate) => gate.gateId === gates[0]!.gateId)
    expect(gateResult?.status).toBe('unknown')
    expect(gateResult?.reasonCodes.join(',')).toContain('missing_parent_evidence')
  })

  it('propagates tampering in a parent artifact through the evidence DAG', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'admission-parent-tamper-'))
    const gates = await gatesFor(tempDir, ['engineering'])
    const parent = storeEvidenceArtifact({
      rootDir: tempDir,
      schemaVersion: 'parent.receipt.v1',
      payload: { status: 'pass' },
      generatedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
      sourceCommit: SOURCE_COMMIT,
      dirtyStateHash: DIRTY_HASH,
    })
    const child = storeEvidenceArtifact({
      rootDir: tempDir,
      schemaVersion: gates[0]!.acceptedSchemaVersions[0]!,
      payload: { status: 'pass', dependsOn: parent.artifactHash },
      generatedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
      sourceCommit: SOURCE_COMMIT,
      dirtyStateHash: DIRTY_HASH,
      parentEvidenceRefs: [parent.artifactHash],
    })
    gates[0] = { ...gates[0]!, evidence: [child] }
    await writeFile(parent.path, '{"tampered":true}\n', 'utf-8')

    const decision = await reduceAdmissionDecision({
      ...baseInput(gates),
      evidenceGraph: [parent],
    })
    expect(decision.stage).toBe('research_only')
    const gateResult = decision.gateResults.find((gate) => gate.gateId === gates[0]!.gateId)
    expect(gateResult?.status).toBe('fail')
    expect(gateResult?.reasonCodes.join(',')).toContain('tampered')
  })

  it('treats duplicate gate providers as conflicting evidence', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'admission-conflict-'))
    const gates = await gatesFor(tempDir, ['engineering'])
    gates.push({ ...gates[0]! })
    const decision = await reduceAdmissionDecision(baseInput(gates))
    expect(decision.stage).toBe('research_only')
    expect(decision.blockingReasons).toContain(`conflicting_gate_evidence:${gates[0]!.gateId}`)
  })

  it('produces a deterministic decision id for identical inputs', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'admission-deterministic-'))
    const gates = await gatesFor(tempDir, ['engineering'])
    const first = await reduceAdmissionDecision(baseInput(gates))
    const second = await reduceAdmissionDecision(baseInput(gates))
    expect(second.decisionId).toBe(first.decisionId)
  })

  it('writes and loads the same validated authority snapshot', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'admission-load-'))
    const path = join(tempDir, 'admission_decision.v1.json')
    const decision = await reduceAdmissionDecision(baseInput([]))
    writeAdmissionDecision(path, decision)
    const loaded = await tryLoadAdmissionDecision(path, { now: NOW })
    expect(loaded.kind).toBe('loaded')
    expect(loaded.kind === 'loaded' ? loaded.decision : null).toEqual(decision)
    expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual(decision)
  })

  it('reports stale snapshots instead of rendering them as current', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'admission-stale-'))
    const path = join(tempDir, 'admission_decision.v1.json')
    const decision = await reduceAdmissionDecision({ ...baseInput([]), ttlMs: 1 })
    writeAdmissionDecision(path, decision)
    const loaded = await tryLoadAdmissionDecision(path, {
      now: new Date(NOW.getTime() + 2),
    })
    expect(loaded.kind).toBe('stale')
  })

  it('rejects a snapshot whose fields no longer match its decision hash', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'admission-hash-mismatch-'))
    const path = join(tempDir, 'admission_decision.v1.json')
    const decision = await reduceAdmissionDecision(baseInput([]))
    await writeFile(path, `${JSON.stringify({
      ...decision,
      assetScope: [...decision.assetScope, 'SOL/USD'],
    })}\n`, 'utf-8')
    const loaded = await tryLoadAdmissionDecision(path, { now: NOW })
    expect(loaded.kind).toBe('invalid')
    expect(loaded.kind === 'invalid' ? loaded.error : '').toContain('admission_decision_hash_mismatch')
  })
})

function baseInput(gates: AdmissionGateEvidenceInput[]) {
  return {
    candidateId: 'candidate-v2',
    sourceCommit: SOURCE_COMMIT,
    dirtyStateHash: DIRTY_HASH,
    releaseManifestHash: RELEASE_HASH,
    gates,
    accountScope: ['paper-main'],
    assetScope: ['BTC/USD', 'ETH/USD'],
    now: NOW,
  }
}

async function gatesFor(
  rootDir: string,
  requirements: AdmissionGateRequirement[],
): Promise<AdmissionGateEvidenceInput[]> {
  return DEFAULT_ADMISSION_POLICY
    .filter((gate) => requirements.includes(gate.requirement))
    .map((gate) => {
      const ref = storeEvidenceArtifact({
        rootDir,
        schemaVersion: `${gate.gateId}.receipt.v1`,
        payload: { gateId: gate.gateId, status: 'pass' },
        generatedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
        sourceCommit: SOURCE_COMMIT,
        dirtyStateHash: DIRTY_HASH,
      })
      return {
        gateId: gate.gateId,
        requirement: gate.requirement,
        providerStatus: 'pass' as const,
        evidence: [ref],
        acceptedSchemaVersions: [ref.schemaVersion],
      }
    })
}
