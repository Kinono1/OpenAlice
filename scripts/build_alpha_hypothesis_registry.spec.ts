import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildEvidenceManifest } from '../src/runtime/evidence_manifest.js'
import {
  buildAlphaHypothesisRegistryReport,
  defaultAlphaHypotheses,
  parseAlphaHypothesisRegistryArgs,
  renderAlphaHypothesisRegistryMarkdown,
  runAlphaHypothesisRegistry,
} from './build_alpha_hypothesis_registry.js'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'alpha-hypothesis-registry-'))
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('build_alpha_hypothesis_registry', () => {
  it('parses CLI args with runtime defaults', () => {
    expect(parseAlphaHypothesisRegistryArgs([])).toEqual({
      candidateRegistryPath: 'data/runtime/candidate_registry.latest.json',
      outputPath: 'data/runtime/alpha_hypothesis_registry.latest.json',
      json: false,
    })
    expect(parseAlphaHypothesisRegistryArgs([
      '--candidateRegistry',
      'tmp/candidates.json',
      '--outputPath',
      'null',
      '--json',
      'true',
    ])).toEqual({
      candidateRegistryPath: 'tmp/candidates.json',
      outputPath: null,
      json: true,
    })
  })

  it('covers active candidate strategyIds while staying research-only', () => {
    const candidateRegistry = candidateRegistryFixture([
      {
        candidateId: 'candidate-cross',
        strategyId: 'cross_sectional_v2',
        status: 'active',
      },
      {
        candidateId: 'candidate-old',
        strategyId: 'unknown_strategy',
        status: 'graveyard',
      },
    ])
    const raw = `${JSON.stringify(candidateRegistry, null, 2)}\n`
    const report = buildAlphaHypothesisRegistryReport({
      candidateRegistry,
      candidateRegistryPath: '/repo/data/runtime/candidate_registry.latest.json',
      candidateRegistryRaw: raw,
      candidateRegistryManifest: buildEvidenceManifest({
        job: 'promotion_v2_runtime_candidateRegistry',
        artifactPath: '/repo/data/runtime/candidate_registry.latest.json',
        startedAt: '2026-05-02T00:00:00.000Z',
        finishedAt: '2026-05-02T00:00:01.000Z',
        exitCode: 0,
        artifactHash: sha256Hex(raw),
      }),
      generatedAt: '2026-05-02T00:00:02.000Z',
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-02T00:00:02.000Z',
      researchOnly: true,
      promotionEligible: false,
      policyMutationAllowed: false,
      promotionAllowedByThisArtifact: false,
      candidateRegistryHash: sha256Hex(raw),
      candidateRegistryManifest: {
        present: true,
        artifactHash: sha256Hex(raw),
        hashMatchesCandidateRegistry: true,
      },
      coverage: {
        candidateRegistryPresent: true,
        candidateCount: 2,
        activeCandidates: 1,
        coveredActiveCandidates: 1,
        uncoveredActiveCandidates: 0,
        coverageStatus: 'pass',
      },
      governance: {
        requiredBeforeP1Review: true,
        requiredBeforePromotion: true,
        promotionBlockedByThisArtifact: true,
      },
    })
    expect(report.coverage.candidates.find(item => item.candidateId === 'candidate-cross')).toMatchObject({
      covered: true,
      matchedPolicyIds: ['cross_sectional_post_cost_rank_spread_v1'],
      missingReason: null,
    })
    expect(report.entries.every(entry =>
      entry.researchOnly === true &&
      entry.promotionEligible === false &&
      entry.policyMutationAllowed === false &&
      entry.whoPays.length > 0 &&
      entry.falsificationRule.condition.length > 0 &&
      entry.killCriteria.length > 0,
    )).toBe(true)
  })

  it('blocks hypothesis coverage when an active candidate has no registered family', () => {
    const report = buildAlphaHypothesisRegistryReport({
      candidateRegistry: candidateRegistryFixture([
        {
          candidateId: 'candidate-mystery',
          strategyId: 'mystery_alpha_v1',
          status: 'active',
        },
      ]),
      candidateRegistryPath: '/repo/data/runtime/candidate_registry.latest.json',
      generatedAt: '2026-05-02T00:00:02.000Z',
    })

    expect(report.coverage).toMatchObject({
      activeCandidates: 1,
      coveredActiveCandidates: 0,
      uncoveredActiveCandidates: 1,
      coverageStatus: 'blocked_missing_hypothesis',
      uncoveredStrategyIds: ['mystery_alpha_v1'],
    })
    expect(report.governance.blockingReasons).toEqual([
      'missing_alpha_hypothesis:mystery_alpha_v1',
    ])
    expect(report.governance.requiredActions.join('\n')).toContain('Register a concrete alpha hypothesis')
  })

  it('treats missing candidate registry as research coverage incomplete', () => {
    const report = buildAlphaHypothesisRegistryReport({
      candidateRegistry: null,
      candidateRegistryPath: '/repo/data/runtime/candidate_registry.latest.json',
    })

    expect(report.coverage).toMatchObject({
      candidateRegistryPresent: false,
      candidateCount: 0,
      coverageStatus: 'candidate_registry_missing',
    })
    expect(report.governance.blockingReasons).toContain('candidate_registry_missing')
  })

  it('writes registry artifact and sidecar manifest', async () => {
    const root = await tempRoot()
    const candidatePath = join(root, 'candidate_registry.latest.json')
    const outputPath = join(root, 'alpha_hypothesis_registry.latest.json')
    const candidateRegistry = candidateRegistryFixture([
      {
        candidateId: 'candidate-cross',
        strategyId: 'cross_sectional_v2',
        status: 'active',
      },
    ])
    const candidateRaw = `${JSON.stringify(candidateRegistry, null, 2)}\n`
    await writeFile(candidatePath, candidateRaw, 'utf-8')
    const candidateManifest = buildEvidenceManifest({
      job: 'promotion_v2_runtime_candidateRegistry',
      artifactPath: candidatePath,
      startedAt: '2026-05-02T00:00:00.000Z',
      finishedAt: '2026-05-02T00:00:01.000Z',
      exitCode: 0,
      artifactHash: sha256Hex(candidateRaw),
    })
    await writeFile(`${candidatePath}.manifest.json`, `${JSON.stringify(candidateManifest, null, 2)}\n`, 'utf-8')

    const report = await runAlphaHypothesisRegistry({
      candidateRegistryPath: candidatePath,
      outputPath,
      json: true,
    })

    expect(report.coverage.coverageStatus).toBe('pass')
    const persistedRaw = await readFile(outputPath, 'utf-8')
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(JSON.parse(persistedRaw)).toMatchObject({
      researchOnly: true,
      promotionAllowedByThisArtifact: false,
      coverage: {
        coverageStatus: 'pass',
      },
    })
    expect(manifest).toMatchObject({
      job: 'alpha_hypothesis_registry',
      artifactPath: outputPath,
      recordsIn: 1,
      recordsOut: defaultAlphaHypotheses().length,
      businessStatus: 'pass',
      errorClass: null,
    })
    expect(manifest.artifactHash).toBe(sha256Hex(persistedRaw))
  })

  it('renders markdown without implying production permission', () => {
    const report = buildAlphaHypothesisRegistryReport({
      candidateRegistry: candidateRegistryFixture([
        {
          candidateId: 'candidate-cross',
          strategyId: 'cross_sectional_v2',
          status: 'active',
        },
      ]),
      candidateRegistryPath: '/repo/candidate_registry.latest.json',
      generatedAt: '2026-05-02T00:00:02.000Z',
    })
    const markdown = renderAlphaHypothesisRegistryMarkdown(report)

    expect(markdown).toContain('# Alpha Hypothesis Registry')
    expect(markdown).toContain('Research only: `true`')
    expect(markdown).toContain('Promotion allowed by this artifact: `false`')
    expect(markdown).toContain('cross_sectional_post_cost_rank_spread_v1')
    expect(markdown).toContain('candidate-cross')
  })
})

function candidateRegistryFixture(entries: Array<{
  candidateId: string
  strategyId: string
  status: string
}>) {
  return {
    schemaMeta: {
      schemaName: 'candidate_registry',
      schemaVersion: 'promotion-v2.6.0',
      createdBy: 'test',
      createdAt: '2026-05-02T00:00:00.000Z',
      codeCommit: 'test',
    },
    registryId: 'test-registry',
    candidateCount: entries.length,
    entries,
    graveyardCandidateCount: 0,
  }
}
