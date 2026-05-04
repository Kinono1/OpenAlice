import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildEvidenceManifest } from '../src/runtime/evidence_manifest.js'
import { buildDirtyWorktreeAudit } from './audit_dirty_worktree.js'
import {
  buildDirtyQuarantinePlanReport,
  parseDirtyQuarantinePlanArgs,
  renderDirtyQuarantinePlanMarkdown,
  runDirtyQuarantinePlan,
} from './build_dirty_quarantine_plan.js'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dirty-quarantine-plan-'))
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('build_dirty_quarantine_plan', () => {
  it('parses CLI args with read-only report defaults', () => {
    expect(parseDirtyQuarantinePlanArgs([])).toEqual({
      inputPath: 'data/runtime/dirty_worktree_audit.latest.json',
      outputPath: 'data/runtime/dirty_quarantine_plan.latest.json',
      maxBatches: 80,
      representativeLimit: 12,
      json: false,
    })
    expect(parseDirtyQuarantinePlanArgs([
      '--input',
      'tmp/audit.json',
      '--outputPath',
      'null',
      '--maxBatches',
      '5',
      '--representativeLimit',
      '2',
      '--json',
    ])).toEqual({
      inputPath: 'tmp/audit.json',
      outputPath: null,
      maxBatches: 5,
      representativeLimit: 2,
      json: true,
    })
  })

  it('builds prioritized read-only batches without granting promotion evidence', () => {
    const audit = auditFixture()
    const raw = `${JSON.stringify(audit, null, 2)}\n`
    const report = buildDirtyQuarantinePlanReport({
      audit,
      sourceAuditPath: '/repo/data/runtime/dirty_worktree_audit.latest.json',
      sourceAuditRaw: raw,
      sourceManifest: buildEvidenceManifest({
        job: 'dirty_worktree_audit',
        artifactPath: '/repo/data/runtime/dirty_worktree_audit.latest.json',
        startedAt: '2026-05-02T00:00:00.000Z',
        finishedAt: '2026-05-02T00:00:01.000Z',
        exitCode: 0,
        gitSnapshot: {
          commit: 'abc',
          dirty: true,
          dirtyFilesCount: audit.counts.total,
          dirtyHash: 'dirty',
        },
        artifactHash: sha256Hex(raw),
      }),
      sourceAuditManifestPath: '/repo/data/runtime/dirty_worktree_audit.latest.json.manifest.json',
      representativeLimit: 2,
      generatedAt: '2026-05-02T00:00:02.000Z',
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-02T00:00:02.000Z',
      planGeneratedAt: '2026-05-02T00:00:02.000Z',
      readOnly: true,
      mutationAllowed: false,
      gitResetAllowed: false,
      gitCleanAllowed: false,
      bulkAddAllowed: false,
      p2PromotionAllowedAfterPlan: false,
      monetizationConclusionAllowedAfterPlan: false,
      sourceAuditHash: sha256Hex(raw),
      sourceAuditGeneratedAt: audit.generatedAt,
      sourceAuditCountsTotal: audit.counts.total,
      latestObservedDirtyFilesCount: audit.counts.total,
      dirtyStateDriftDetected: false,
      dirtyStateDriftReason: null,
      sourceAuditAgeMsAtPlan: 2000,
      sourceManifest: {
        present: true,
        artifactHash: sha256Hex(raw),
        hashMatchesSourceAudit: true,
        evidenceTrust: 'quarantine',
        gitDirtyFilesCount: audit.counts.total,
      },
      blockingReasons: expect.arrayContaining([
        'source_audit_manifest_not_pass:quarantine:quarantine',
        `source_audit_dirty_entries:${audit.counts.total}`,
        `source_audit_promotion_relevant_dirty:${audit.counts.scopeCounts.promotionRelevantTotal}`,
      ]),
      dirtyScopes: {
        promotionRelevantTotal: expect.any(Number),
        generatedArtifactOnlyTotal: expect.any(Number),
      },
      batchSummary: {
        byActionType: expect.arrayContaining([
          { key: 'runtime_artifact_quarantine', entries: 3, batches: 1 },
          { key: 'source_functional_review', entries: 3, batches: 3 },
        ]),
        byProtocolClass: expect.arrayContaining([
          { key: 'B', entries: 3, batches: 1 },
          { key: 'A', entries: 3, batches: 3 },
        ]),
        byPathGroup: expect.arrayContaining([
          { key: 'data', entries: 3, batches: 1 },
          { key: 'src', entries: 2, batches: 2 },
        ]),
      },
      sourceAuditSampleSummary: {
        promotionRelevantSamples: {
          count: expect.any(Number),
          firstPath: '.env.local',
        },
        generatedArtifactOnlySamples: {
          count: 3,
          firstPath: 'runtime/research/a.json',
        },
        secretRiskSamples: {
          count: 1,
          firstPath: '.env.local',
        },
        deletedTrackedSamples: {
          count: 1,
          firstPath: 'docs/research/old.md',
        },
      },
    })
    expect(report.redLines).toEqual(expect.arrayContaining([
      'Do not run git reset --hard for this cleanup protocol.',
      'Do not run git clean -fd for this cleanup protocol.',
      'Do not run git add .; each batch must be reviewed with an explicit file scope.',
    ]))
    expect(report.batches.every(batch =>
      batch.p2Blocking === true &&
      batch.promotionEvidenceAllowed === false &&
      batch.destructiveOperationAllowed === false,
    )).toBe(true)

    expect(report.batches.map(batch => batch.actionType).slice(0, 5)).toEqual([
      'isolate_and_rotate_secret',
      'explicit_deleted_file_review',
      'runtime_artifact_quarantine',
      'source_functional_review',
      'source_functional_review',
    ])
    const runtime = report.batches.find(batch => batch.actionType === 'runtime_artifact_quarantine')
    expect(runtime).toMatchObject({
      protocolClass: 'B',
      pathGroup: 'data',
      topPrefix: 'runtime/research',
      count: 3,
      representativePaths: [
        'runtime/research/a.json',
        'runtime/research/b.json',
      ],
    })
    expect(runtime?.redLines).toContain('Do not use this batch as monetization or promotion evidence')
  })

  it('keeps dirty audit manifest hash mismatch visible', () => {
    const audit = auditFixture()
    const raw = `${JSON.stringify(audit, null, 2)}\n`
    const report = buildDirtyQuarantinePlanReport({
      audit,
      sourceAuditPath: '/repo/data/runtime/dirty_worktree_audit.latest.json',
      sourceAuditRaw: raw,
      sourceManifest: buildEvidenceManifest({
        job: 'dirty_worktree_audit',
        artifactPath: '/repo/data/runtime/dirty_worktree_audit.latest.json',
        startedAt: '2026-05-02T00:00:00.000Z',
        finishedAt: '2026-05-02T00:00:01.000Z',
        exitCode: 0,
        artifactHash: 'wrong-hash',
      }),
    })

    expect(report.sourceManifest).toMatchObject({
      present: true,
      artifactHash: 'wrong-hash',
      hashMatchesSourceAudit: false,
    })
    expect(report.blockingReasons).toEqual(expect.arrayContaining([
      'source_audit_manifest_hash_mismatch',
      'source_audit_manifest_not_pass:quarantine:quarantine',
    ]))
    expect(report.p2PromotionAllowedAfterPlan).toBe(false)
  })

  it('marks missing and stale source audit manifest fields as plan blockers', () => {
    const audit = auditFixture()
    const report = buildDirtyQuarantinePlanReport({
      audit,
      sourceAuditPath: '/repo/data/runtime/dirty_worktree_audit.latest.json',
      sourceManifest: null,
    })

    expect(report.sourceManifest).toMatchObject({
      present: false,
      artifactHash: null,
      hashMatchesSourceAudit: null,
      gitDirtyFilesCount: null,
    })
    expect(report.blockingReasons).toEqual(expect.arrayContaining([
      'source_audit_manifest_missing',
      `source_audit_dirty_entries:${audit.counts.total}`,
      `source_audit_promotion_relevant_dirty:${audit.counts.scopeCounts.promotionRelevantTotal}`,
    ]))
    expect(report.redLines).toContain('Plan source blocker: source_audit_manifest_missing')
  })

  it('flags manifest dirty-count mismatch so stale quarantine plans are visible', () => {
    const audit = auditFixture()
    const raw = `${JSON.stringify(audit, null, 2)}\n`
    const report = buildDirtyQuarantinePlanReport({
      audit,
      sourceAuditPath: '/repo/data/runtime/dirty_worktree_audit.latest.json',
      sourceAuditRaw: raw,
      sourceManifest: buildEvidenceManifest({
        job: 'dirty_worktree_audit',
        artifactPath: '/repo/data/runtime/dirty_worktree_audit.latest.json',
        startedAt: '2026-05-02T00:00:00.000Z',
        finishedAt: '2026-05-02T00:00:01.000Z',
        exitCode: 0,
        gitSnapshot: {
          commit: 'abc',
          dirty: true,
          dirtyFilesCount: audit.counts.total - 1,
          dirtyHash: 'stale-dirty',
        },
        artifactHash: sha256Hex(raw),
      }),
    })

    expect(report.sourceManifest.gitDirtyFilesCount).toBe(audit.counts.total - 1)
    expect(report).toMatchObject({
      latestObservedDirtyFilesCount: audit.counts.total - 1,
      dirtyStateDriftDetected: true,
      dirtyStateDriftReason: `manifest_dirty_count:${audit.counts.total - 1} != source_audit_counts_total:${audit.counts.total}`,
    })
    expect(report.blockingReasons).toContain(
      `source_audit_manifest_dirty_count_mismatch:${audit.counts.total - 1}:${audit.counts.total}`,
    )
    expect(report.blockingReasons).toContain('dirty_state_drift_detected')
  })

  it('writes plan artifact and sidecar manifest with matching hash', async () => {
    const root = await tempRoot()
    const auditPath = join(root, 'dirty_worktree_audit.latest.json')
    const outputPath = join(root, 'dirty_quarantine_plan.latest.json')
    const audit = auditFixture()
    const auditRaw = `${JSON.stringify(audit, null, 2)}\n`
    await writeFile(auditPath, auditRaw, 'utf-8')
    const auditManifest = buildEvidenceManifest({
      job: 'dirty_worktree_audit',
      artifactPath: auditPath,
      startedAt: '2026-05-02T00:00:00.000Z',
      finishedAt: '2026-05-02T00:00:01.000Z',
      exitCode: 0,
      artifactHash: sha256Hex(auditRaw),
    })
    await writeFile(`${auditPath}.manifest.json`, `${JSON.stringify(auditManifest, null, 2)}\n`, 'utf-8')

    const report = await runDirtyQuarantinePlan({
      inputPath: auditPath,
      outputPath,
      maxBatches: 10,
      representativeLimit: 2,
      json: true,
    })

    expect(report.coverage.emittedBatches).toBeGreaterThan(0)
    const persistedRaw = await readFile(outputPath, 'utf-8')
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(JSON.parse(persistedRaw)).toMatchObject({
      readOnly: true,
      mutationAllowed: false,
      sourceManifest: {
        hashMatchesSourceAudit: true,
      },
      blockingReasons: expect.arrayContaining([
        `source_audit_dirty_entries:${audit.counts.total}`,
      ]),
    })
    expect(manifest).toMatchObject({
      job: 'dirty_quarantine_plan',
      artifactPath: outputPath,
      recordsIn: audit.counts.total,
      recordsOut: report.coverage.emittedBatches,
      businessStatus: 'warn',
      errorClass: 'dirty_worktree_quarantine_plan',
    })
    expect(manifest.artifactHash).toBe(sha256Hex(persistedRaw))
  })

  it('renders markdown with red lines and batch table', () => {
    const report = buildDirtyQuarantinePlanReport({
      audit: auditFixture(),
      sourceAuditPath: '/repo/audit.json',
      representativeLimit: 2,
      generatedAt: '2026-05-02T00:00:02.000Z',
    })

    const markdown = renderDirtyQuarantinePlanMarkdown(report)

    expect(markdown).toContain('# Dirty Quarantine Plan')
    expect(markdown).toContain('Read only: `true`')
    expect(markdown).toContain('Mutation allowed: `false`')
    expect(markdown).toContain('## Source Blockers')
    expect(markdown).toContain('runtime_artifact_quarantine')
    expect(markdown).toContain('Do not run git add .')
  })
})

function auditFixture() {
  return buildDirtyWorktreeAudit({
    repoRoot: '/repo',
    generatedAt: '2026-05-02T00:00:00.000Z',
    porcelain: [
      '?? .env.local',
      'D  docs/research/old.md',
      '?? runtime/research/a.json',
      '?? runtime/research/b.json',
      '?? runtime/research/c.json',
      ' M src/domain/trading.ts',
      '?? src/domain/new_gate.ts',
      ' M scripts/paper_trade.ts',
      '?? docs/openalice_plan.md',
    ].join('\n'),
  })
}
