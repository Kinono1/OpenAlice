import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getSkippedRequiredLiveChecks,
  isReleaseGateStatusBlocking,
  normalizeReleaseGateStatus,
  writeReleaseGateStatus,
  type PersistedReleaseGateStatus,
} from './release_gate_status.js'

const tempDirs: string[] = []

function makeStatus(overrides?: Partial<PersistedReleaseGateStatus>): PersistedReleaseGateStatus {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    allowPaperTrading: true,
    allowLiveTrading: true,
    failedChecks: [],
    warningChecks: [],
    ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe('release_gate_status', () => {
  it('blocks paper mode when allowPaperTrading is false', () => {
    const result = isReleaseGateStatusBlocking(
      makeStatus({ allowPaperTrading: false, allowLiveTrading: true, failedChecks: ['significance'] }),
      'paper',
    )

    expect(result).toEqual({
      blocking: true,
      reason: 'paper_release_gate_failed:significance',
    })
  })

  it('allows paper mode when allowPaperTrading is true even if live remains blocked', () => {
    const paper = isReleaseGateStatusBlocking(
      makeStatus({ allowPaperTrading: true, allowLiveTrading: false, failedChecks: ['execution_quality'] }),
      'paper',
    )
    const live = isReleaseGateStatusBlocking(
      makeStatus({ allowPaperTrading: true, allowLiveTrading: false, failedChecks: ['execution_quality'] }),
      'live',
    )

    expect(paper).toEqual({ blocking: false })
    expect(live).toEqual({
      blocking: true,
      reason: 'live_release_gate_failed:execution_quality',
    })
  })

  it('normalizes and persists allowTinyCapLiveTrading as an explicit boolean', async () => {
    const normalized = normalizeReleaseGateStatus({
      version: 1,
      generatedAt: '2026-03-27T00:00:00.000Z',
      allowPaperTrading: true,
      allowLiveTrading: false,
      allowTinyCapLiveTrading: true,
      failedChecks: [],
      warningChecks: [],
    })

    expect(normalized.allowTinyCapLiveTrading).toBe(true)
    expect(() =>
      normalizeReleaseGateStatus({
        ...normalized,
        allowTinyCapLiveTrading: 'true',
      }),
    ).toThrow('Malformed release gate status.')

    const dir = await mkdtemp(join(tmpdir(), 'release-gate-status-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'release_gate_status.json')

    await writeReleaseGateStatus(
      {
        checks: [],
        failedChecks: [],
        warningChecks: [],
        hardFail: false,
        allowPaperTrading: true,
        allowLiveTrading: false,
      },
      {
        filePath,
        allowTinyCapLiveTrading: true,
      },
    )

    const persisted = normalizeReleaseGateStatus(JSON.parse(await readFile(filePath, 'utf-8')))
    expect(persisted.allowTinyCapLiveTrading).toBe(true)
    const manifest = JSON.parse(await readFile(`${filePath}.manifest.json`, 'utf-8'))
    expect(manifest).toMatchObject({
      job: 'release_gate_status',
      artifactPath: filePath,
      exitCode: 0,
      businessStatus: 'pass',
    })
    expect(typeof manifest.artifactHash).toBe('string')
  })

  it('blocks expired gate status before evaluating tiny-cap live allowance', () => {
    const result = isReleaseGateStatusBlocking(
      makeStatus({
        allowPaperTrading: true,
        allowLiveTrading: false,
        allowTinyCapLiveTrading: true,
        failedChecks: [],
        expiresAt: '2026-03-27T00:00:00.000Z',
      }),
      'live',
      new Date('2026-03-28T00:00:00.000Z'),
    )

    expect(result).toEqual({
      blocking: true,
      reason: 'release_gate_status_expired:2026-03-27T00:00:00.000Z',
    })
  })

  it('returns skipped required live checks from diagnostics when present', () => {
    const skipped = getSkippedRequiredLiveChecks(
      makeStatus({
        allowPaperTrading: true,
        allowLiveTrading: false,
        checks: [
          {
            name: 'execution_quality',
            status: 'skipped',
            summary: 'Execution quality gate not provided; skipping gate.',
            metrics: {},
          },
          {
            name: 'ramp_up',
            status: 'warn',
            summary: 'Ramp-up sample is still insufficient.',
            metrics: {},
          },
          {
            name: 'regime_shift',
            status: 'skipped',
            summary: 'Regime-shift gate not provided; skipping gate.',
            metrics: {},
          },
        ],
      }),
    )

    expect(skipped).toEqual(['execution_quality', 'regime_shift'])
  })

  it('persists and reloads optional diagnostics fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'release-gate-status-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'release_gate_status.json')

    await writeReleaseGateStatus(
      {
        checks: [
          {
            name: 'wfo',
            status: 'fail',
            summary: 'WFO gate failed.',
            metrics: {
              failedWindows: 11,
              windowCount: 15,
              failedWindowRatio: 11 / 15,
            },
          },
        ],
        failedChecks: ['wfo'],
        warningChecks: [],
        hardFail: true,
        allowPaperTrading: false,
        allowLiveTrading: false,
      },
      {
        filePath,
        sourceReportPath: '/tmp/validation_runs.json',
        result: 'NO_GO',
        reasonCodes: ['HARD_FDR_THRESHOLD_FAIL', 'HARD_RELEASE_GATE_BLOCKED'],
      },
    )

    const persisted = normalizeReleaseGateStatus(JSON.parse(await readFile(filePath, 'utf-8')))
    expect(persisted.result).toBe('NO_GO')
    expect(persisted.reasonCodes).toEqual([
      'HARD_FDR_THRESHOLD_FAIL',
      'HARD_RELEASE_GATE_BLOCKED',
    ])
    expect(persisted.checks).toEqual([
      {
        name: 'wfo',
        status: 'fail',
        summary: 'WFO gate failed.',
        metrics: {
          failedWindows: 11,
          windowCount: 15,
          failedWindowRatio: 11 / 15,
        },
      },
    ])
    expect(persisted.sourceReportPath).toBe('/tmp/validation_runs.json')
  })

  it('accepts research-only persisted verdicts without authorizing paper or live trading', () => {
    const status = normalizeReleaseGateStatus({
      version: 1,
      generatedAt: '2026-05-11T12:00:00.000Z',
      allowPaperTrading: false,
      allowLiveTrading: false,
      allowTinyCapLiveTrading: false,
      failedChecks: ['paper_gate', 'live_gate'],
      warningChecks: [],
      result: 'RESEARCH_ONLY',
      reasonCodes: ['research_only_blocked'],
      checks: [
        {
          name: 'wfo',
          status: 'pass',
          summary: 'WFO passed, but execution gates remain blocked.',
          metrics: {},
        },
      ],
    })

    expect(status.result).toBe('RESEARCH_ONLY')
    expect(isReleaseGateStatusBlocking(status, 'paper')).toEqual({
      blocking: true,
      reason: 'paper_release_gate_failed:paper_gate,live_gate',
    })
    expect(isReleaseGateStatusBlocking(status, 'live')).toEqual({
      blocking: true,
      reason: 'live_release_gate_failed:paper_gate,live_gate',
    })
  })
})
