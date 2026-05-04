import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
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
})
