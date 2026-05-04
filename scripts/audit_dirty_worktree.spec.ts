import { describe, expect, it } from 'vitest'
import {
  buildDirtyWorktreeAudit,
  parseAuditArgs,
  parsePorcelainStatus,
  renderDirtyWorktreeMarkdown,
} from './audit_dirty_worktree.js'

describe('audit_dirty_worktree', () => {
  it('parses porcelain status and classifies status kinds', () => {
    const entries = parsePorcelainStatus([
      ' M src/runtime/promotion_v2.ts',
      'D  docs/research/old.md',
      '?? data/runtime/snapshot.json',
      'R  scripts/old.ts -> scripts/new.ts',
    ].join('\n'))

    expect(entries).toHaveLength(4)
    expect(entries[0]).toMatchObject({
      path: 'src/runtime/promotion_v2.ts',
      pathGroup: 'src',
      statusKinds: ['modified'],
      protocolClass: 'A',
    })
    expect(entries[1]).toMatchObject({
      path: 'docs/research/old.md',
      pathGroup: 'docs',
      statusKinds: ['deleted'],
      protocolClass: 'C',
    })
    expect(entries[2]).toMatchObject({
      path: 'data/runtime/snapshot.json',
      pathGroup: 'data',
      statusKinds: ['untracked'],
      protocolClass: 'B',
    })
    expect(entries[3]).toMatchObject({
      originalPath: 'scripts/old.ts',
      path: 'scripts/new.ts',
      pathGroup: 'scripts',
      statusKinds: ['renamed'],
      protocolClass: 'A',
    })
  })

  it('routes secret-risk paths to protocol D regardless of path prefix', () => {
    const audit = buildDirtyWorktreeAudit({
      repoRoot: '/repo',
      generatedAt: '2026-05-02T00:00:00.000Z',
      porcelain: [
        '?? .env.local',
        ' M src/config/api-token.json',
        '?? docs/research/credential-notes.md',
      ].join('\n'),
    })

    expect(audit.counts.byProtocolClass.D).toBe(3)
    expect(audit.protocol.D.entries.map((entry) => entry.path)).toEqual([
      '.env.local',
      'src/config/api-token.json',
      'docs/research/credential-notes.md',
    ])
    expect(audit.protocol.D.entries.every((entry) => entry.pathGroup === 'secrets')).toBe(true)
  })

  it('builds A/B/C/D counts and path/status summaries', () => {
    const audit = buildDirtyWorktreeAudit({
      repoRoot: '/repo',
      generatedAt: '2026-05-02T00:00:00.000Z',
      porcelain: [
        ' M src/main.ts',
        '?? scripts/new_tool.ts',
        '?? data/research/output.json',
        ' M logs/runtime.log',
        'D  docs/research/archive.md',
        '?? private.key',
      ].join('\n'),
    })

    expect(audit.isDirty).toBe(true)
    expect(audit.counts.total).toBe(6)
    expect(audit.counts.byProtocolClass).toMatchObject({
      A: 2,
      B: 2,
      C: 1,
      D: 1,
    })
    expect(audit.counts.byPathGroup).toMatchObject({
      src: 1,
      scripts: 1,
      data: 1,
      logs: 1,
      docs: 1,
      secrets: 1,
    })
    expect(audit.counts.byStatusKind).toMatchObject({
      modified: 2,
      deleted: 1,
      untracked: 3,
    })
    expect(audit.counts.scopeCounts).toMatchObject({
      promotionRelevantTotal: 5,
      generatedArtifactOnlyTotal: 1,
      sourceReviewTotal: 3,
      secretRiskTotal: 1,
      deletedTrackedTotal: 1,
    })
    expect(audit.samples.promotionRelevantSamples.map((entry) => entry.path)).toEqual([
      'src/main.ts',
      'scripts/new_tool.ts',
      'data/research/output.json',
      'docs/research/archive.md',
      'private.key',
    ])
    expect(audit.samples.promotionCriticalSamples).toEqual([])
    expect(audit.samples.generatedArtifactOnlySamples.map((entry) => entry.path)).toEqual([
      'logs/runtime.log',
    ])
    expect(audit.samples.secretRiskSamples.map((entry) => entry.path)).toEqual(['private.key'])
    expect(audit.samples.deletedTrackedSamples.map((entry) => entry.path)).toEqual([
      'docs/research/archive.md',
    ])
    expect(audit.governance).toMatchObject({
      evidenceTrust: 'fail',
      p2PromotionAllowed: false,
      monetizationConclusionAllowed: false,
      runtimeArtifactsQuarantined: true,
      reviewProtocol: 'secret_risk_fail',
    })
    expect(audit.governance.blockingReasons).toEqual(expect.arrayContaining([
      'secret_risk_dirty_file',
      'dirty_worktree',
      'source_changes_require_review',
      'deleted_files_require_explicit_review',
      'runtime_artifacts_dirty',
      'docs_research_archive_dirty',
    ]))
  })

  it('renders markdown summary by default shape', () => {
    const audit = buildDirtyWorktreeAudit({
      repoRoot: '/repo',
      generatedAt: '2026-05-02T00:00:00.000Z',
      porcelain: '?? data/runtime/result.json\n',
    })
    const markdown = renderDirtyWorktreeMarkdown(audit)

    expect(markdown).toContain('# Dirty Worktree Audit')
    expect(markdown).toContain('Secret-risk dirty entries: 0')
    expect(markdown).toContain('Deleted tracked dirty entries: 0')
    expect(markdown).toContain('## Top-Level Samples')
    expect(markdown).toContain('### Generated Artifact Only')
    expect(markdown).toContain('B: runtime/data/logs should be ignored or archived - 1')
    expect(markdown).toContain('evidenceTrust: quarantine')
    expect(markdown).toContain('p2PromotionAllowed: false')
    expect(markdown).toContain('runtimeArtifactsQuarantined: true')
    expect(markdown).toContain('Promotion-critical scope dirty entries: 0')
    expect(markdown).toContain('promotionCriticalScope: clean')
    expect(markdown).toContain('`data/runtime/result.json`')
  })

  it('separates promotion-critical executable scope from docs/readme churn', () => {
    const audit = buildDirtyWorktreeAudit({
      repoRoot: '/repo',
      generatedAt: '2026-05-02T00:00:00.000Z',
      porcelain: [
        ' D src/domain/trading/README.md',
        ' M src/domain/trading/production-leverage-guard.ts',
        ' D docs/research/archive.md',
        '?? packages/opentypebb/README.md',
      ].join('\n'),
    })

    expect(audit.promotionCriticalScope).toMatchObject({
      dirtyTotal: 3,
      sourceCodeDirtyTotal: 1,
      docsOrReadmeDirtyTotal: 2,
      generatedArtifactDirtyTotal: 0,
      clean: false,
      status: 'dirty',
    })
    expect(audit.samples.promotionCriticalSamples.map((entry) => entry.path)).toEqual([
      'src/domain/trading/README.md',
      'src/domain/trading/production-leverage-guard.ts',
      'packages/opentypebb/README.md',
    ])
    expect(audit.governance).toMatchObject({
      evidenceTrust: 'quarantine',
      p2PromotionAllowed: false,
      runtimeArtifactsQuarantined: true,
    })
  })

  it('blocks P2 promotion and monetization conclusions for source-lane dirty files', () => {
    const audit = buildDirtyWorktreeAudit({
      repoRoot: '/repo',
      generatedAt: '2026-05-02T00:00:00.000Z',
      porcelain: [
        ' M src/runtime/promotion_v2.ts',
        '?? scripts/new_gate.ts',
      ].join('\n'),
    })

    expect(audit.governance).toMatchObject({
      evidenceTrust: 'quarantine',
      p2PromotionAllowed: false,
      monetizationConclusionAllowed: false,
      runtimeArtifactsQuarantined: true,
      reviewProtocol: 'dirty_quarantine',
    })
    expect(audit.governance.blockingReasons).toEqual(expect.arrayContaining([
      'dirty_worktree',
      'source_changes_require_review',
    ]))
    expect(audit.governance.requiredActions.join('\n')).toContain(
      'Treat every artifact generated from this worktree as quarantine evidence.',
    )
    expect(audit.governance.p2RequiredEvidence).toEqual(expect.arrayContaining([
      'data/runtime/dirty_worktree_audit.latest.json:counts.total=0,governance.p2PromotionAllowed=true',
      'data/runtime/dirty_worktree_audit.latest.json.manifest.json:evidenceTrust=pass,dqStatus=pass,artifactHash=match',
    ]))
  })

  it('explicitly quarantines runtime artifacts for stricter P2 gating', () => {
    const audit = buildDirtyWorktreeAudit({
      repoRoot: '/repo',
      generatedAt: '2026-05-02T00:00:00.000Z',
      porcelain: [
        '?? data/runtime/strategy_promotion.latest.json',
        '?? runtime/paper/reports/report.json',
        ' M logs/runtime.log',
      ].join('\n'),
    })

    expect(audit.counts.byProtocolClass.B).toBe(3)
    expect(audit.counts.scopeCounts).toMatchObject({
      promotionRelevantTotal: 0,
      generatedArtifactOnlyTotal: 3,
    })
    expect(audit.governance).toMatchObject({
      evidenceTrust: 'quarantine',
      p2PromotionAllowed: false,
      monetizationConclusionAllowed: false,
      runtimeArtifactsQuarantined: true,
    })
    expect(audit.governance.blockingReasons).toContain('runtime_artifacts_dirty')
    expect(audit.governance.requiredActions.join('\n')).toContain(
      'Do not let promotion consume dirty runtime artifacts unless the dirty-worktree audit and manifest both pass.',
    )
    expect(audit.governance.requiredActions.join('\n')).toContain(
      'Review generated-artifact-only dirty files separately',
    )
  })

  it('allows promotion conclusions only when the worktree is clean', () => {
    const audit = buildDirtyWorktreeAudit({
      repoRoot: '/repo',
      generatedAt: '2026-05-02T00:00:00.000Z',
      porcelain: '',
    })

    expect(audit.isDirty).toBe(false)
    expect(audit.counts.scopeCounts).toEqual({
      promotionRelevantTotal: 0,
      generatedArtifactOnlyTotal: 0,
      sourceReviewTotal: 0,
      secretRiskTotal: 0,
      deletedTrackedTotal: 0,
    })
    expect(audit.governance).toEqual({
      evidenceTrust: 'pass',
      p2PromotionAllowed: true,
      monetizationConclusionAllowed: true,
      runtimeArtifactsQuarantined: false,
      reviewProtocol: 'clean',
      blockingReasons: [],
      requiredActions: ['No dirty worktree action required.'],
      p2RequiredEvidence: [
        'data/runtime/dirty_worktree_audit.latest.json:governance.p2PromotionAllowed=true',
        'data/runtime/dirty_worktree_audit.latest.json.manifest.json:evidenceTrust=pass',
      ],
    })
  })

  it('supports --json boolean parsing', () => {
    expect(parseAuditArgs([])).toEqual({ json: false, outputPath: null })
    expect(parseAuditArgs(['--json'])).toEqual({ json: true, outputPath: null })
    expect(parseAuditArgs(['--json', 'false'])).toEqual({ json: false, outputPath: null })
    expect(parseAuditArgs(['--output', 'data/runtime/audit.json'])).toEqual({
      json: false,
      outputPath: 'data/runtime/audit.json',
    })
  })
})
