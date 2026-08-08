import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDirtyWorktreeNotification, writeDirtyWorktreeNotification } from './build_dirty_worktree_notification.js'

async function fixture(overrides: {
  report?: Record<string, unknown>
  plan?: Record<string, unknown>
  coverage?: Record<string, unknown>
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'openalice-dirty-notification-'))
  const reportPath = join(root, 'report.json')
  const planPath = join(root, 'plan.json')
  const coveragePath = join(root, 'coverage.json')
  const notificationPath = join(root, 'notification.json')
  await writeFile(reportPath, JSON.stringify(overrides.report ?? {
    purpose: 'legacy_wip', sourceMode: 'git_worktree', statusHash: 'status-1',
    counts: { total: 555, byProtocolClass: { A: 536, B: 0, C: 14, D: 5 }, scopeCounts: { deletedTrackedTotal: 3, promotionRelevantTotal: 555 } },
    governance: { blockingReasons: ['dirty_worktree'] },
  }))
  await writeFile(planPath, JSON.stringify(overrides.plan ?? { blockingReasons: ['source_audit_dirty_entries:555'] }))
  await writeFile(coveragePath, JSON.stringify(overrides.coverage ?? {
    status: 'complete', evidenceUsabilityStatus: 'quarantine_blocked',
    blockingReasons: [], trustBlockingReasons: ['evidence_trust_quarantine:29'],
  }))
  return { reportPath, planPath, coveragePath, notificationPath, root }
}

describe('build_dirty_worktree_notification', () => {
  it('unions ordinary and trust blockers and explains complete-but-quarantined coverage', async () => {
    const paths = await fixture()
    const legacyReportPath = join(paths.root, 'legacy-report.json')
    const legacyPlanPath = join(paths.root, 'legacy-plan.json')
    await writeFile(legacyReportPath, JSON.stringify({
      purpose: 'legacy_wip',
      sourceMode: 'git_worktree',
      branch: 'work/kino-mainline',
      commit: 'a'.repeat(40),
      statusHash: 'legacy-status',
      counts: {
        total: 555,
        byProtocolClass: { A: 536, B: 0, C: 14, D: 5 },
        scopeCounts: { deletedTrackedTotal: 3, promotionRelevantTotal: 555 },
      },
    }))
    await writeFile(legacyPlanPath, JSON.stringify({ blockingReasons: ['legacy_quarantine'] }))
    const result = buildDirtyWorktreeNotification({
      ...paths,
      manifestCoveragePath: paths.coveragePath,
      legacyReportPath,
      legacyPlanPath,
      now: new Date('2026-08-09T00:00:00.000Z'),
    })
    expect(result.status).toBe('blocked')
    expect(result.shouldNotify).toBe(true)
    expect(result.fullText).toContain('Manifest coverage complete, but evidence trust blocked.')
    expect(result.fullText).toContain('trustBlockingReasons=evidence_trust_quarantine:29')
    expect(result.fullText).toContain('nextAction=')
    expect(result.fullText).toContain('receiptPaths=')
    expect(result.fullText).toContain('legacy_wip')
    expect(result.fullText).toContain('branch=work/kino-mainline')
    expect(result.fullText).toContain(`commit=${'a'.repeat(40)}`)
    expect(result.fullText).toContain('sourceMode=git_worktree')
    expect(result.receiptPaths).toContain(legacyPlanPath)
    expect(result.fullText).toContain('total=555, A=536, B=0, C=14, D=5, deletedTracked=3, promotionRelevant=555')
    expect(result.legacyWipSummary).toMatchObject({
      purpose: 'legacy_wip',
      sourceMode: 'git_worktree',
      branch: 'work/kino-mainline',
      commit: 'a'.repeat(40),
      total: 555,
      a: 536,
      b: 0,
      c: 14,
      d: 5,
      deletedTracked: 3,
      promotionRelevant: 555,
      statusHash: 'legacy-status',
    })
  })

  it('suppresses unchanged clean state and sends a weekly blocked reminder', async () => {
    const paths = await fixture({
      report: { purpose: 'canonical_release', sourceMode: 'verified_release', statusHash: 'clean', counts: { total: 0, byProtocolClass: {}, scopeCounts: {} }, governance: { blockingReasons: [] } },
      plan: { blockingReasons: [] },
      coverage: { status: 'complete', evidenceUsabilityStatus: 'pass', blockingReasons: [], trustBlockingReasons: [] },
    })
    const first = buildDirtyWorktreeNotification({ ...paths, manifestCoveragePath: paths.coveragePath, now: new Date('2026-08-09T00:00:00.000Z') })
    expect(first.shouldNotify).toBe(true)
    const second = buildDirtyWorktreeNotification({ ...paths, manifestCoveragePath: paths.coveragePath, previousState: { lastFingerprint: first.fingerprint, lastStatus: 'clean', lastNotifiedAt: first.generatedAt }, now: new Date('2026-08-09T01:00:00.000Z') })
    expect(second.shouldNotify).toBe(false)

    const blockedPaths = await fixture({ coverage: { status: 'complete', evidenceUsabilityStatus: 'quarantine_blocked', blockingReasons: [], trustBlockingReasons: ['evidence_trust_quarantine:29'] } })
    const blocked = buildDirtyWorktreeNotification({ ...blockedPaths, manifestCoveragePath: blockedPaths.coveragePath, previousState: { lastFingerprint: 'different', lastStatus: 'blocked', lastNotifiedAt: '2026-08-01T00:00:00.000Z' }, now: new Date('2026-08-09T00:00:00.000Z') })
    expect(blocked.notificationReason).toBe('state_changed')
    const reminder = buildDirtyWorktreeNotification({ ...blockedPaths, manifestCoveragePath: blockedPaths.coveragePath, previousState: { lastFingerprint: blocked.fingerprint, lastStatus: 'blocked', lastNotifiedAt: '2026-08-01T00:00:00.000Z' }, now: new Date('2026-08-09T00:00:00.000Z') })
    expect(reminder.notificationReason).toBe('weekly_reminder')
    expect(reminder.shouldNotify).toBe(true)
  })

  it('writes notification and state atomically', async () => {
    const paths = await fixture()
    const result = await writeDirtyWorktreeNotification({ ...paths, manifestCoveragePath: paths.coveragePath, now: new Date('2026-08-09T00:00:00.000Z') })
    const persisted = JSON.parse(await readFile(paths.notificationPath, 'utf8'))
    const state = JSON.parse(await readFile(`${paths.notificationPath}.state.json`, 'utf8'))
    expect(persisted.fingerprint).toBe(result.fingerprint)
    expect(state.lastFingerprint).toBe(result.fingerprint)
  })

  it('notifies once when a blocked state recovers and fails closed for schema loss', async () => {
    const cleanPaths = await fixture({
      report: {
        purpose: 'canonical_release',
        sourceMode: 'verified_release',
        statusHash: 'clean',
        branch: null,
        commit: 'a'.repeat(40),
        counts: { total: 0, byProtocolClass: {}, scopeCounts: {} },
        governance: { blockingReasons: [] },
      },
      plan: { blockingReasons: [] },
      coverage: {
        status: 'complete',
        evidenceUsabilityStatus: 'pass',
        blockingReasons: [],
        trustBlockingReasons: [],
      },
    })
    const recovered = buildDirtyWorktreeNotification({
      ...cleanPaths,
      manifestCoveragePath: cleanPaths.coveragePath,
      previousState: {
        lastFingerprint: 'blocked-fingerprint',
        lastStatus: 'blocked',
        lastNotifiedAt: '2026-08-08T00:00:00.000Z',
      },
      now: new Date('2026-08-09T00:00:00.000Z'),
    })
    expect(recovered).toMatchObject({
      status: 'clean',
      shouldNotify: true,
      notificationReason: 'recovered',
    })
    const stable = buildDirtyWorktreeNotification({
      ...cleanPaths,
      manifestCoveragePath: cleanPaths.coveragePath,
      previousState: {
        lastFingerprint: recovered.fingerprint,
        lastStatus: 'clean',
        lastNotifiedAt: recovered.generatedAt,
      },
      now: new Date('2026-08-09T01:00:00.000Z'),
    })
    expect(stable.shouldNotify).toBe(false)

    const invalidPaths = await fixture({
      report: { purpose: 'canonical_release', sourceMode: 'verified_release' },
    })
    const invalid = buildDirtyWorktreeNotification({
      ...invalidPaths,
      manifestCoveragePath: invalidPaths.coveragePath,
    })
    expect(invalid).toMatchObject({
      status: 'invalid',
      shouldNotify: true,
      notificationReason: 'invalid_audit',
    })
    expect(invalid.fullText).toContain('Fail-closed')
  })
})
