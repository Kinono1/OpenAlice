import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildEvidenceManifest } from '../src/runtime/evidence_manifest.js'
import {
  buildRuntimeManifestCoverageReport,
  parseRuntimeManifestCoverageArgs,
  runRuntimeManifestCoverageAudit,
  type RequiredRuntimeArtifact,
} from './audit_runtime_manifest_coverage.js'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('audit_runtime_manifest_coverage', () => {
  it('parses safe read-only defaults', () => {
    expect(parseRuntimeManifestCoverageArgs([])).toEqual({
      runtimeDir: 'data/runtime',
      outputPath: 'data/runtime/runtime_manifest_coverage.latest.json',
      json: false,
    })
    expect(parseRuntimeManifestCoverageArgs([
      '--runtimeDir',
      '/tmp/runtime',
      '--output',
      'null',
      '--json',
    ])).toEqual({
      runtimeDir: '/tmp/runtime',
      outputPath: null,
      json: true,
    })
  })

  it('blocks missing manifests and hash mismatches without granting promotion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-runtime-manifest-coverage-'))
    const goodRaw = `${JSON.stringify({ status: 'ok' }, null, 2)}\n`
    const badRaw = `${JSON.stringify({ status: 'blocked' }, null, 2)}\n`
    const goodPath = join(root, 'good.json')
    const missingManifestPath = join(root, 'missing_manifest.json')
    const mismatchPath = join(root, 'mismatch.json')
    await writeFile(goodPath, goodRaw, 'utf-8')
    await writeFile(missingManifestPath, goodRaw, 'utf-8')
    await writeFile(mismatchPath, badRaw, 'utf-8')
    await writeFile(`${goodPath}.manifest.json`, `${JSON.stringify({
      ...buildEvidenceManifest({
      job: 'good',
      artifactPath: goodPath,
      startedAt: '2026-05-03T00:00:00.000Z',
      finishedAt: '2026-05-03T00:00:01.000Z',
      exitCode: 0,
      artifactHash: sha256Hex(goodRaw),
      }),
      evidenceTrust: 'pass',
      dqStatus: 'pass',
    }, null, 2)}\n`, 'utf-8')
    await writeFile(`${mismatchPath}.manifest.json`, `${JSON.stringify({
      ...buildEvidenceManifest({
      job: 'mismatch',
      artifactPath: mismatchPath,
      startedAt: '2026-05-03T00:00:00.000Z',
      finishedAt: '2026-05-03T00:00:01.000Z',
      exitCode: 0,
      artifactHash: 'wrong-hash',
      }),
      evidenceTrust: 'pass',
      dqStatus: 'pass',
    }, null, 2)}\n`, 'utf-8')

    const requiredArtifacts: RequiredRuntimeArtifact[] = [
      { key: 'good', relativePath: 'good.json', required: true },
      { key: 'missingManifest', relativePath: 'missing_manifest.json', required: true },
      { key: 'mismatch', relativePath: 'mismatch.json', required: true },
      { key: 'missingArtifact', relativePath: 'missing_artifact.json', required: true },
    ]
    const report = buildRuntimeManifestCoverageReport({
      runtimeDir: root,
      requiredArtifacts,
      generatedAt: '2026-05-03T00:00:02.000Z',
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-03T00:00:02.000Z',
      status: 'blocked',
      coverageStatus: 'blocked',
      evidenceUsabilityStatus: 'missing_or_invalid_blocked',
      promotionAllowedByThisArtifact: false,
      promotionEvidenceAllowed: false,
      paperOrderEvidenceAllowed: false,
      monetizationConclusionAllowedByThisArtifact: false,
      monetizationConclusionAllowed: false,
      allRequiredManifestsPass: false,
      allRequiredManifestsPresentAndHashMatched: false,
      coverage: {
        requiredArtifacts: 4,
        existingArtifacts: 3,
        missingArtifacts: 1,
        presentManifests: 2,
        missingManifests: 1,
        hashMatchedManifests: 1,
        hashMismatchManifests: 1,
      },
    })
    expect(report.blockingReasons).toEqual(expect.arrayContaining([
      'manifest_missing:missingManifest',
      'manifest_hash_mismatch:mismatch',
      'artifact_missing:missingArtifact',
    ]))
    expect(report.trustBlockingReasons).toEqual(expect.arrayContaining([
      'required_manifests_not_all_present_and_hash_matched',
      'evidence_trust_pass_required:1/4',
    ]))
  })

  it('keeps complete manifest coverage unusable when every artifact is quarantined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-runtime-manifest-quarantine-'))
    const requiredArtifacts: RequiredRuntimeArtifact[] = [
      { key: 'quarantineA', relativePath: 'a.json', required: true },
      { key: 'quarantineB', relativePath: 'b.json', required: true },
    ]
    for (const artifact of requiredArtifacts) {
      const artifactPath = join(root, artifact.relativePath)
      const raw = `${JSON.stringify({ key: artifact.key }, null, 2)}\n`
      await writeFile(artifactPath, raw, 'utf-8')
      const manifest = buildEvidenceManifest({
        job: artifact.key,
        artifactPath,
        startedAt: '2026-05-03T00:00:00.000Z',
        finishedAt: '2026-05-03T00:00:01.000Z',
        exitCode: 0,
        artifactHash: sha256Hex(raw),
      })
      await writeFile(`${artifactPath}.manifest.json`, `${JSON.stringify({
        ...manifest,
        evidenceTrust: 'quarantine',
        dqStatus: 'quarantine',
        businessStatus: 'pass',
        git: {
          ...manifest.git,
          dirty: true,
          dirtyFilesCount: 2,
          dirtyHash: 'dirty-hash',
        },
      }, null, 2)}\n`, 'utf-8')
    }

    const report = buildRuntimeManifestCoverageReport({
      runtimeDir: root,
      requiredArtifacts,
      generatedAt: '2026-05-03T00:00:02.000Z',
    })

    expect(report).toMatchObject({
      status: 'complete',
      coverageStatus: 'complete',
      evidenceUsabilityStatus: 'quarantine_blocked',
      promotionReadinessStatus: 'coverage_complete_trust_blocked',
      coverageCompleteButTrustBlocked: true,
      promotionEvidenceAllowed: false,
      paperOrderEvidenceAllowed: false,
      monetizationConclusionAllowed: false,
      requiredPassManifests: 2,
      passManifestCount: 0,
      quarantineManifestCount: 2,
      allRequiredManifestsPass: false,
      allRequiredManifestsPresentAndHashMatched: true,
      trustSummary: {
        pass: 0,
        quarantine: 2,
      },
      manifestDirtyStateSummary: {
        dirtyStateDivergenceDetected: false,
        uniqueDirtyFilesCounts: [2],
        dirtyFilesCountMin: 2,
        dirtyFilesCountMax: 2,
      },
      businessStatusSummary: {
        pass: 2,
      },
    })
    expect(report.blockingReasons).toEqual([])
    expect(report.trustBlockingReasons).toEqual(expect.arrayContaining([
      'evidence_trust_pass_required:0/2',
      'evidence_trust_quarantine:2',
    ]))
    expect(report.items[0]).toMatchObject({
      manifestBusinessStatus: 'pass',
      manifestGitDirty: true,
      manifestGitDirtyFilesCount: 2,
      manifestGitDirtyHash: 'dirty-hash',
      promotionEvidenceAllowed: false,
      quarantineReason: 'manifest_git_dirty',
      trustBlockingReasons: expect.arrayContaining([
        'evidence_trust_not_pass:quarantineA:quarantine:quarantine',
        'manifest_git_dirty:quarantineA:2',
      ]),
    })
  })

  it('writes an audited report with its own sidecar manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-runtime-manifest-write-'))
    const artifactPath = join(root, 'artifact.json')
    const outputPath = join(root, 'runtime_manifest_coverage.latest.json')
    const raw = `${JSON.stringify({ ok: true }, null, 2)}\n`
    await mkdir(root, { recursive: true })
    await writeFile(artifactPath, raw, 'utf-8')
    await writeFile(`${artifactPath}.manifest.json`, `${JSON.stringify(buildEvidenceManifest({
      job: 'artifact',
      artifactPath,
      startedAt: '2026-05-03T00:00:00.000Z',
      finishedAt: '2026-05-03T00:00:01.000Z',
      exitCode: 0,
      artifactHash: sha256Hex(raw),
    }), null, 2)}\n`, 'utf-8')

    const report = await runRuntimeManifestCoverageAudit({
      runtimeDir: root,
      outputPath,
      json: true,
    })

    expect(report.status).toBe('blocked')
    const persistedRaw = await readFile(outputPath, 'utf-8')
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(manifest).toMatchObject({
      job: 'runtime_manifest_coverage_audit',
      artifactPath: outputPath,
      recordsIn: report.coverage.requiredArtifacts,
      recordsOut: report.coverage.presentManifests,
      businessStatus: 'warn',
    })
    expect(manifest.artifactHash).toBe(sha256Hex(persistedRaw))
  })

  it('surfaces dirty-state divergence across otherwise matched manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-runtime-manifest-dirty-divergence-'))
    const requiredArtifacts: RequiredRuntimeArtifact[] = [
      { key: 'artifactA', relativePath: 'a.json', required: true },
      { key: 'artifactB', relativePath: 'b.json', required: true },
    ]
    for (const [index, artifact] of requiredArtifacts.entries()) {
      const artifactPath = join(root, artifact.relativePath)
      const raw = `${JSON.stringify({ key: artifact.key }, null, 2)}\n`
      await writeFile(artifactPath, raw, 'utf-8')
      const manifest = buildEvidenceManifest({
        job: artifact.key,
        artifactPath,
        startedAt: '2026-05-03T00:00:00.000Z',
        finishedAt: '2026-05-03T00:00:01.000Z',
        exitCode: 0,
        artifactHash: sha256Hex(raw),
      })
      await writeFile(`${artifactPath}.manifest.json`, `${JSON.stringify({
        ...manifest,
        evidenceTrust: 'quarantine',
        dqStatus: 'quarantine',
        errorClass: index === 0 ? 'first_error' : null,
        git: {
          ...manifest.git,
          dirty: true,
          dirtyFilesCount: index === 0 ? 10 : 12,
          dirtyHash: `dirty-${index}`,
        },
      }, null, 2)}\n`, 'utf-8')
    }

    const report = buildRuntimeManifestCoverageReport({
      runtimeDir: root,
      requiredArtifacts,
      generatedAt: '2026-05-03T00:00:02.000Z',
    })

    expect(report.manifestDirtyStateSummary).toMatchObject({
      dirtyStateDivergenceDetected: true,
      uniqueDirtyFilesCounts: [10, 12],
      dirtyFilesCountMin: 10,
      dirtyFilesCountMax: 12,
    })
    expect(report.manifestDirtyStateSummary.dirtyFilesCountGroups).toEqual([
      { dirtyFilesCount: 10, artifactKeys: ['artifactA'] },
      { dirtyFilesCount: 12, artifactKeys: ['artifactB'] },
    ])
    expect(report.errorClassSummary).toMatchObject({
      first_error: 1,
      none: 1,
    })
  })

  it('tracks fee snapshot and route cost budget in default runtime coverage', () => {
    const report = buildRuntimeManifestCoverageReport({
      runtimeDir: '/tmp/openalice-missing-runtime-manifest-defaults',
      generatedAt: '2026-05-03T00:00:00.000Z',
    })

    expect(report.items.map(item => item.key)).toEqual(expect.arrayContaining([
      'feeSnapshot',
      'routeCostBudget',
    ]))
    expect(report.blockingReasons).toEqual(expect.arrayContaining([
      'artifact_missing:feeSnapshot',
      'artifact_missing:routeCostBudget',
    ]))
  })
})
