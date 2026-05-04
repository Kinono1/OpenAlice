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
      evidenceTrust: 'pass',
      businessStatus: 'pass',
      recordsIn: 3,
      recordsOut: 1,
    })
  })
})
