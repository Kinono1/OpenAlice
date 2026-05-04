import { describe, expect, it } from 'vitest'
import {
  OPENALICE_SCRIPT_CRON_SPECS,
  upsertCronJobStore,
  buildEthCarryCronScript,
} from './install_eth_carry_refresh_cron.ts'

describe('install_eth_carry_refresh_cron', () => {
  it('builds a deterministic single-action script spec for the approved script', () => {
    const script = buildEthCarryCronScript({
      repoRoot: '/repo/OpenAlice',
      approvedScript: '/repo/OpenAlice/scripts/cron_eth_carry_refresh_pipeline.sh',
      notificationPath: '/repo/OpenAlice/data/runtime/eth_carry_status/eth_carry_actionability_notification.json',
    })

    expect(script).toEqual({
      path: '/repo/OpenAlice/scripts/cron_eth_carry_refresh_pipeline.sh',
      args: [],
      cwd: '/repo/OpenAlice',
      notificationPath: '/repo/OpenAlice/data/runtime/eth_carry_status/eth_carry_actionability_notification.json',
    })
  })

  it('upserts the ETH carry cron job without creating duplicates', () => {
    const first = upsertCronJobStore(
      { jobs: [] },
      {
        name: 'eth_carry_refresh_pipeline_daily',
        schedule: { kind: 'cron', cron: '5 7 * * *' },
        payload: '',
        kind: 'script',
        script: {
          path: '/repo/OpenAlice/scripts/cron_eth_carry_refresh_pipeline.sh',
        },
        enabled: true,
        nowMs: Date.UTC(2026, 3, 14, 0, 0, 0),
      },
    )
    expect(first.jobs).toHaveLength(1)
    expect(first.jobs[0]?.name).toBe('eth_carry_refresh_pipeline_daily')
    expect(first.jobs[0]?.kind).toBe('script')
    expect(first.jobs[0]?.script?.path).toBe('/repo/OpenAlice/scripts/cron_eth_carry_refresh_pipeline.sh')

    const second = upsertCronJobStore(
      first,
      {
        name: 'eth_carry_refresh_pipeline_daily',
        schedule: { kind: 'cron', cron: '10 7 * * *' },
        payload: '',
        kind: 'script',
        script: {
          path: '/repo/OpenAlice/scripts/cron_eth_carry_refresh_pipeline.sh',
          notificationPath: '/repo/OpenAlice/data/runtime/eth_carry_status/eth_carry_actionability_notification.json',
        },
        enabled: false,
        nowMs: Date.UTC(2026, 3, 14, 1, 0, 0),
      },
    )
    expect(second.jobs).toHaveLength(1)
    expect(second.jobs[0]?.payload).toBe('')
    expect(second.jobs[0]?.kind).toBe('script')
    expect(second.jobs[0]?.script?.notificationPath).toBe('/repo/OpenAlice/data/runtime/eth_carry_status/eth_carry_actionability_notification.json')
    expect(second.jobs[0]?.enabled).toBe(false)
    expect(second.jobs[0]?.schedule).toEqual({ kind: 'cron', cron: '10 7 * * *' })
  })

  it('defines deterministic single-script presets for paper diagnostics jobs', () => {
    expect(OPENALICE_SCRIPT_CRON_SPECS.paper_policy_shadow_settle_5m).toMatchObject({
      jobName: 'paper_policy_shadow_settle_5m',
      cronExpr: '2-59/5 * * * *',
      approvedScript: 'scripts/cron_paper_policy_shadow_settle.sh',
      notificationPath: 'data/runtime/paper_policy_shadow_settle_notification.json',
    })
    expect(OPENALICE_SCRIPT_CRON_SPECS.paper_policy_shadow_capture_5m).toMatchObject({
      jobName: 'paper_policy_shadow_capture_5m',
      cronExpr: '1-59/5 * * * *',
      approvedScript: 'scripts/cron_paper_policy_shadow_capture.sh',
      notificationPath: 'data/runtime/paper_policy_shadow_capture_notification.json',
    })
    expect(OPENALICE_SCRIPT_CRON_SPECS.paper_pnl_diagnostics_30m.approvedScript).toBe('scripts/cron_paper_pnl_diagnostics.sh')
    expect(OPENALICE_SCRIPT_CRON_SPECS.pro_policy_window_hourly.approvedScript).toBe('scripts/cron_pro_policy_window.sh')
    expect(OPENALICE_SCRIPT_CRON_SPECS.microstructure_stoploss_replay_hourly.approvedScript).toBe('scripts/cron_microstructure_stoploss_replay.sh')
    expect(OPENALICE_SCRIPT_CRON_SPECS.dirty_worktree_audit_daily.approvedScript).toBe('scripts/cron_dirty_worktree_audit.sh')
    expect(OPENALICE_SCRIPT_CRON_SPECS.scheduler_security_audit_hourly).toMatchObject({
      jobName: 'scheduler_security_audit_hourly',
      cronExpr: '23 * * * *',
      approvedScript: 'scripts/cron_scheduler_security_audit.sh',
      notificationPath: 'data/runtime/scheduler_security_audit_notification.json',
    })
    expect(OPENALICE_SCRIPT_CRON_SPECS.external_derivatives_data_collect_8h).toMatchObject({
      jobName: 'external_derivatives_data_collect_8h',
      cronExpr: '7 */8 * * *',
      approvedScript: 'scripts/cron_external_derivatives_data_collect.sh',
      notificationPath: 'data/runtime/external_derivatives_data_collect_notification.json',
      timezone: 'UTC',
    })
    expect(OPENALICE_SCRIPT_CRON_SPECS.p1_trading_evidence_hourly).toMatchObject({
      jobName: 'p1_trading_evidence_hourly',
      cronExpr: '18 * * * *',
      approvedScript: 'scripts/cron_p1_trading_evidence.sh',
      notificationPath: 'data/runtime/p1_trading_evidence_notification.json',
    })
  })

  it('upserts external derivatives collection with a UTC cron schedule', () => {
    const preset = OPENALICE_SCRIPT_CRON_SPECS.external_derivatives_data_collect_8h
    const first = upsertCronJobStore(
      { jobs: [] },
      {
        name: preset.jobName,
        schedule: { kind: 'cron', cron: preset.cronExpr, timezone: preset.timezone },
        payload: '',
        kind: 'script',
        script: {
          path: '/repo/OpenAlice/scripts/cron_external_derivatives_data_collect.sh',
          notificationPath: '/repo/OpenAlice/data/runtime/external_derivatives_data_collect_notification.json',
        },
        enabled: true,
        nowMs: Date.UTC(2026, 4, 2, 0, 0, 0),
      },
    )

    expect(first.jobs).toHaveLength(1)
    expect(first.jobs[0]?.name).toBe('external_derivatives_data_collect_8h')
    expect(first.jobs[0]?.schedule).toEqual({ kind: 'cron', cron: '7 */8 * * *', timezone: 'UTC' })
    expect(first.jobs[0]?.state.nextRunAtMs).toBe(Date.UTC(2026, 4, 2, 0, 7, 0))
  })
})
