import { describe, expect, it } from 'vitest'
import {
  decideCronNotification,
  fingerprintCronError,
  isCriticalNotification,
  isLogOnlyJob,
} from './notification-policy.js'

describe('cron notification policy', () => {
  it.each([
    'okx_ssd_presence_archive_probe_15m',
    'okx_warehouse_compact_hourly',
    'okx_public_freshness_audit_5m',
    'paper_policy_shadow_capture_5m',
    'p1_trading_evidence_hourly',
    'microstructure_stoploss_replay_hourly',
  ])('routes routine %s notifications to the event log only', (jobName) => {
    expect(isLogOnlyJob(jobName)).toBe(true)
    expect(decideCronNotification({
      jobName,
      outcome: 'success',
      requested: true,
      text: 'routine report',
    })).toMatchObject({
      shouldNotify: false,
      reason: 'log_only',
      notificationClass: 'log_only',
    })
  })

  it('notifies the first failure and suppresses the identical repeat', () => {
    const jobName = 'okx_ssd_presence_archive_probe_15m'
    const error = 'Command failed: corepack: command not found'
    const first = decideCronNotification({
      jobName,
      outcome: 'failure',
      requested: true,
      text: error,
      error,
      previousConsecutiveErrors: 0,
    })
    const repeated = decideCronNotification({
      jobName,
      outcome: 'failure',
      requested: true,
      text: error,
      error,
      previousConsecutiveErrors: 1,
      previousErrorFingerprint: first.errorFingerprint,
    })
    expect(first).toMatchObject({ shouldNotify: true, reason: 'first_failure', failureCount: 1 })
    expect(repeated).toMatchObject({ shouldNotify: false, reason: 'duplicate_failure', failureCount: 2 })
  })

  it('notifies a changed error and a configured circuit transition', () => {
    const jobName = 'external_derivatives_data_collect_8h'
    const prior = fingerprintCronError(jobName, 'HTTP 500')
    expect(decideCronNotification({
      jobName,
      outcome: 'failure',
      requested: true,
      text: 'HTTP 401',
      error: 'HTTP 401',
      previousConsecutiveErrors: 1,
      previousErrorFingerprint: prior,
    }).reason).toBe('error_changed')

    expect(decideCronNotification({
      jobName,
      outcome: 'failure',
      requested: true,
      text: 'HTTP 500',
      error: 'HTTP 500',
      previousConsecutiveErrors: 2,
      previousErrorFingerprint: prior,
      circuitOpenAfter: 3,
    })).toMatchObject({ shouldNotify: true, reason: 'circuit_opened', failureCount: 3 })
  })

  it('notifies recovery after failures even for a log-only job', () => {
    expect(decideCronNotification({
      jobName: 'okx_warehouse_compact_hourly',
      outcome: 'success',
      requested: false,
      text: '',
      previousConsecutiveErrors: 8,
    })).toMatchObject({
      shouldNotify: true,
      reason: 'recovered',
      notificationClass: 'recovery',
    })
  })

  it('keeps critical safety and real-account alerts immediate', () => {
    const text = 'Critical: live trading safety gate bypassed'
    expect(isCriticalNotification(text)).toBe(true)
    expect(decideCronNotification({
      jobName: 'okx_market_data_health_5m',
      outcome: 'success',
      requested: true,
      text,
    })).toMatchObject({ shouldNotify: true, reason: 'critical', notificationClass: 'critical' })
  })

  it('preserves explicit SSD reminder delivery', () => {
    expect(isLogOnlyJob('okx_ssd_weekly_reminder_sunday')).toBe(false)
    expect(decideCronNotification({
      jobName: 'okx_ssd_weekly_reminder_sunday',
      outcome: 'success',
      requested: true,
      text: 'Connect shield.',
    })).toMatchObject({ shouldNotify: true, reason: 'requested' })
  })

  it('normalizes volatile timestamps and long counters in fingerprints', () => {
    const a = fingerprintCronError('job', 'failed at 2026-07-25T10:01:02Z count=12345678901')
    const b = fingerprintCronError('job', 'failed at 2026-07-25T10:02:03Z count=12345678999')
    expect(a).toBe(b)
  })
})
