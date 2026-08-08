import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildEvidenceManifest,
  readGitEvidenceSnapshot,
  writeEvidenceManifestForArtifact,
} from './evidence_manifest.js'

describe('evidence_manifest', () => {
  it('marks dirty git snapshots as quarantine evidence', () => {
    const manifest = buildEvidenceManifest({
      job: 'paper_policy_shadow_settle',
      artifactPath: 'data/runtime/paper_policy_shadow_settle.latest.json',
      startedAt: '2026-05-02T00:00:00.000Z',
      finishedAt: '2026-05-02T00:00:01.000Z',
      exitCode: 0,
      gitSnapshot: readGitEvidenceSnapshot(process.cwd(), {
        commit: 'abc123',
        statusPorcelain: ' M src/runtime/example.ts\n?? data/runtime/new.json\n',
      }),
    })

    expect(manifest.git).toMatchObject({
      commit: 'abc123',
      dirty: true,
      dirtyFilesCount: 2,
    })
    expect(manifest.git.dirtyHash).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.evidenceTrust).toBe('quarantine')
    expect(manifest.dqStatus).toBe('quarantine')
  })

  it('uses all untracked files in dirty snapshot overrides to match dirty audit counts', () => {
    const snapshot = readGitEvidenceSnapshot(process.cwd(), {
      commit: 'abc123',
      statusPorcelain: [
        '?? data/runtime/a.json',
        '?? data/runtime/nested/b.json',
        ' M src/runtime/example.ts',
      ].join('\n'),
    })

    expect(snapshot.dirty).toBe(true)
    expect(snapshot.dirtyFilesCount).toBe(3)
    expect(snapshot.dirtyHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('writes a sidecar manifest with artifact hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evidence-manifest-'))
    const artifactPath = join(root, 'artifact.json')
    const manifestPath = join(root, 'artifact.json.manifest.json')
    await writeFile(artifactPath, '{"ok":true}\n', 'utf-8')

    const manifest = await writeEvidenceManifestForArtifact({
      job: 'unit_test_job',
      artifactPath,
      manifestPath,
      startedAt: '2026-05-02T00:00:00.000Z',
      finishedAt: '2026-05-02T00:00:02.000Z',
      exitCode: 0,
      recordsIn: 3,
      recordsOut: 1,
      businessStatus: 'pass',
      gitSnapshot: readGitEvidenceSnapshot(process.cwd(), {
        commit: 'clean123',
        statusPorcelain: '',
      }),
    })

    expect(manifest.evidenceTrust).toBe('pass')
    expect(manifest.durationMs).toBe(2_000)
    expect(manifest.artifactHash).toMatch(/^[a-f0-9]{64}$/)
    const persisted = JSON.parse(await readFile(manifestPath, 'utf-8'))
    expect(persisted).toMatchObject({
      job: 'unit_test_job',
      producer: 'unit_test_job',
      producerExitCode: 0,
      generatedAt: '2026-05-02T00:00:02.000Z',
      evidenceTrust: 'pass',
      businessStatus: 'pass',
      recordsIn: 3,
      recordsOut: 1,
    })
  })

  it('passes only when a verified release identity is complete and convergent', () => {
    const manifest = buildEvidenceManifest({
      job: 'research_data_collect',
      artifactPath: 'data/runtime/research.json',
      startedAt: '2026-05-02T00:00:00.000Z',
      finishedAt: '2026-05-02T00:00:01.000Z',
      exitCode: 0,
      releaseIdentity: {
        sourceKind: 'verified_release',
        sourceCommit: 'a'.repeat(40),
        releaseId: 'a'.repeat(40),
        dirtyStateHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        releaseManifestHash: 'b'.repeat(64),
        releasePathIdentity: '/immutable/releases/a',
      },
    })

    expect(manifest).toMatchObject({
      schemaVersion: 2,
      sourceKind: 'verified_release',
      sourceCommit: 'a'.repeat(40),
      releaseId: 'a'.repeat(40),
      sourceIdentityValid: true,
      evidenceTrust: 'pass',
    })
  })

  it('quarantines incomplete verified-release identity and missing Git identity', () => {
    const invalidRelease = buildEvidenceManifest({
      job: 'research_data_collect',
      artifactPath: 'data/runtime/research.json',
      startedAt: '2026-05-02T00:00:00.000Z',
      finishedAt: '2026-05-02T00:00:01.000Z',
      exitCode: 0,
      releaseIdentity: {
        sourceKind: 'verified_release',
        sourceCommit: 'a'.repeat(40),
        releaseId: 'b'.repeat(40),
        dirtyStateHash: 'c'.repeat(64),
        releaseManifestHash: 'd'.repeat(64),
        releasePathIdentity: '',
      },
    })
    expect(invalidRelease).toMatchObject({
      sourceIdentityValid: false,
      sourceIdentityError: 'verified_release_identity_invalid',
      evidenceTrust: 'quarantine',
    })

    const noGit = buildEvidenceManifest({
      job: 'no_git_source',
      artifactPath: 'data/runtime/research.json',
      startedAt: '2026-05-02T00:00:00.000Z',
      finishedAt: '2026-05-02T00:00:01.000Z',
      exitCode: 0,
      gitSnapshot: {
        commit: null,
        dirty: false,
        dirtyFilesCount: 0,
        dirtyHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
    })
    expect(noGit).toMatchObject({
      sourceKind: 'git_worktree',
      sourceIdentityValid: false,
      sourceIdentityError: 'git_identity_missing',
      evidenceTrust: 'quarantine',
    })
  })

  it('quarantines contradictory release identity variables instead of mixing sources', () => {
    const previous = { ...process.env }
    try {
      for (const key of [
        'OPENALICE_SOURCE_KIND',
        'OPENALICE_SOURCE_COMMIT',
        'OPENALICE_DIRTY_STATE_HASH',
        'OPENALICE_RELEASE_ID',
        'OPENALICE_RELEASE_MANIFEST_HASH',
        'OPENALICE_RELEASE_PATH',
      ]) delete process.env[key]
      process.env.OPENALICE_SOURCE_KIND = 'git_worktree'
      process.env.OPENALICE_RELEASE_ID = 'a'.repeat(40)

      const manifest = buildEvidenceManifest({
        job: 'mixed_source_identity',
        artifactPath: 'data/runtime/mixed.json',
        startedAt: '2026-05-02T00:00:00.000Z',
        finishedAt: '2026-05-02T00:00:01.000Z',
        exitCode: 0,
        gitSnapshot: {
          commit: 'b'.repeat(40),
          dirty: false,
          dirtyFilesCount: 0,
          dirtyHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
      })
      expect(manifest.sourceKind).toBe('verified_release')
      expect(manifest.sourceIdentityValid).toBe(false)
      expect(manifest.sourceIdentityError).toBe('verified_release_identity_invalid')
      expect(manifest.evidenceTrust).toBe('quarantine')
    } finally {
      for (const key of [
        'OPENALICE_SOURCE_KIND',
        'OPENALICE_SOURCE_COMMIT',
        'OPENALICE_DIRTY_STATE_HASH',
        'OPENALICE_RELEASE_ID',
        'OPENALICE_RELEASE_MANIFEST_HASH',
        'OPENALICE_RELEASE_PATH',
      ]) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
  })
})
