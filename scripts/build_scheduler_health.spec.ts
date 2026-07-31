import { describe, expect, it } from 'vitest'
import { deriveSchedulerHealthStatus, parseArgs } from './build_scheduler_health.ts'

describe('build_scheduler_health', () => {
  it('defaults every runtime path under the local data root', () => {
    const args = parseArgs(['--dataRoot', '/tmp/openalice-data'])
    expect(args.jobsPath).toBe('/tmp/openalice-data/cron/jobs.json')
    expect(args.outputPath).toBe('/tmp/openalice-data/runtime/scheduler_health.latest.json')
    expect(args.telegramProbePath).toBe('/tmp/openalice-data/runtime/telegram_push_probe.latest.json')
    expect(args.okxHealthPath).toBe('/tmp/openalice-data/runtime/okx_market_data_health.latest.json')
    expect(args.okxArchivePath).toBe('/tmp/openalice-data/runtime/storage/ssd_archive_state.json')
  })

  it('fails when a blocker is added after warning collection', () => {
    const blockers: string[] = []
    const warnings = ['telegram_probe_failed:timeout']
    blockers.push('okx_private_api_calls:1')
    expect(deriveSchedulerHealthStatus(blockers, warnings)).toBe('fail')
  })

  it('does not downgrade a healthy report merely because the caller shell lacks runtime secrets', () => {
    expect(deriveSchedulerHealthStatus([], [])).toBe('pass')
  })
})
