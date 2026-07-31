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

  it('builds a script spec with explicit arguments for shared OpenAlice cron wrapper tasks', () => {
    const script = buildEthCarryCronScript({
      repoRoot: '/repo/OpenAlice',
      approvedScript: '/repo/OpenAlice/scripts/cron_openalice_task.sh',
      args: ['accumulate_1s_data'],
      notificationPath: '/repo/OpenAlice/data/runtime/cron_openalice_task/accumulate_1s_data_notification.json',
    })

    expect(script).toEqual({
      path: '/repo/OpenAlice/scripts/cron_openalice_task.sh',
      args: ['accumulate_1s_data'],
      cwd: '/repo/OpenAlice',
      notificationPath: '/repo/OpenAlice/data/runtime/cron_openalice_task/accumulate_1s_data_notification.json',
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

  it('removes all duplicate jobs with the same name during upsert', () => {
    const duplicate = {
      id: 'duplicate',
      name: 'market_intel_refresh_15m',
      enabled: true,
      kind: 'script' as const,
      schedule: { kind: 'cron' as const, cron: '1 * * * *' },
      payload: '',
      state: { nextRunAtMs: 1, lastRunAtMs: null, lastStatus: null, consecutiveErrors: 0 },
      createdAt: 1,
    }
    const updated = upsertCronJobStore(
      { jobs: [{ ...duplicate, id: 'first' }, { ...duplicate, id: 'second' }] },
      {
        name: 'market_intel_refresh_15m',
        schedule: { kind: 'cron', cron: '*/15 * * * *' },
        payload: '',
        kind: 'script',
        enabled: true,
        nowMs: Date.UTC(2026, 6, 17, 0, 0, 0),
      },
    )

    expect(updated.jobs.filter(job => job.name === 'market_intel_refresh_15m')).toHaveLength(1)
    expect(updated.jobs[0]?.id).toBe('first')
    expect(updated.jobs[0]?.schedule).toEqual({ kind: 'cron', cron: '*/15 * * * *' })
  })

  it('enables validated P0 shadow jobs while keeping candidate evolution disabled', () => {
    expect(OPENALICE_SCRIPT_CRON_SPECS.gated_improvement_candidate_daily.enabled).toBe(false)
    expect(OPENALICE_SCRIPT_CRON_SPECS.okx_instrument_master_refresh_15m.enabled).toBe(true)
    expect(OPENALICE_SCRIPT_CRON_SPECS.okx_public_fast_refresh_1m.enabled).toBe(true)
    expect(OPENALICE_SCRIPT_CRON_SPECS.okx_public_broad_refresh_5m.enabled).toBe(true)
    expect(OPENALICE_SCRIPT_CRON_SPECS.okx_warehouse_compact_hourly.enabled).toBe(true)
    expect(OPENALICE_SCRIPT_CRON_SPECS.okx_depth_universe_daily.enabled).toBe(true)
  })

  it('defines SSD archive and reminder presets without external schedulers', () => {
    expect(OPENALICE_SCRIPT_CRON_SPECS.okx_ssd_presence_archive_probe_15m).toMatchObject({ cronExpr: '7,22,37,52 * * * *', args: ['ssd_probe'] })
    expect(OPENALICE_SCRIPT_CRON_SPECS.okx_ssd_weekly_reminder_sunday).toMatchObject({ cronExpr: '0 20 * * 0', args: ['ssd_reminder_weekly'] })
    expect(OPENALICE_SCRIPT_CRON_SPECS.okx_ssd_followup_reminder_mon_wed).toMatchObject({ cronExpr: '0 20 * * 1-3', args: ['ssd_reminder_followup'] })
    expect(OPENALICE_SCRIPT_CRON_SPECS.okx_ssd_integrity_audit_weekly).toMatchObject({ cronExpr: '30 22 * * 0', args: ['ssd_integrity'] })
    expect(OPENALICE_SCRIPT_CRON_SPECS.okx_warehouse_retention_daily).toMatchObject({ cronExpr: '35 4 * * *', args: ['retention'] })
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
    expect(OPENALICE_SCRIPT_CRON_SPECS.okx_public_1h_accumulate_hourly).toMatchObject({
      jobName: 'okx_public_1h_accumulate_hourly',
      cronExpr: '3 * * * *',
      approvedScript: 'scripts/cron_openalice_task.sh',
      args: ['accumulate_live_data'],
      notificationPath: 'data/runtime/cron_openalice_task/accumulate_live_data_notification.json',
    })
    expect(OPENALICE_SCRIPT_CRON_SPECS.okx_public_5m_accumulate_5m).toMatchObject({
      jobName: 'okx_public_5m_accumulate_5m',
      cronExpr: '0-59/5 * * * *',
      approvedScript: 'scripts/cron_openalice_task.sh',
      args: ['accumulate_5m_data'],
      notificationPath: 'data/runtime/cron_openalice_task/accumulate_5m_data_notification.json',
    })
    expect(OPENALICE_SCRIPT_CRON_SPECS.okx_public_1s_accumulate_5m).toMatchObject({
      jobName: 'okx_public_1s_accumulate_5m',
      cronExpr: '1-59/5 * * * *',
      approvedScript: 'scripts/cron_openalice_task.sh',
      args: ['accumulate_1s_data'],
      notificationPath: 'data/runtime/cron_openalice_task/accumulate_1s_data_notification.json',
    })
    expect(OPENALICE_SCRIPT_CRON_SPECS.okx_public_freshness_audit_5m).toMatchObject({
      jobName: 'okx_public_freshness_audit_5m',
      cronExpr: '2-59/5 * * * *',
      approvedScript: 'scripts/cron_openalice_task.sh',
      args: ['live_data_freshness_audit'],
      notificationPath: 'data/runtime/cron_openalice_task/live_data_freshness_audit_notification.json',
    })
    expect(OPENALICE_SCRIPT_CRON_SPECS.runtime_fee_auth_tick_4h).toMatchObject({
      jobName: 'runtime_fee_auth_tick_4h',
      cronExpr: '11 */4 * * *',
      approvedScript: 'scripts/cron_openalice_task.sh',
      args: ['runtime_fee_auth_tick'],
      notificationPath: 'data/runtime/cron_openalice_task/runtime_fee_auth_tick_notification.json',
    })
    expect(OPENALICE_SCRIPT_CRON_SPECS.prospective_evidence_tick_hourly).toMatchObject({
      jobName: 'prospective_evidence_tick_hourly',
      cronExpr: '9 * * * *',
      approvedScript: 'scripts/cron_openalice_task.sh',
      args: ['prospective_evidence_tick'],
      notificationPath: 'data/runtime/cron_openalice_task/prospective_evidence_tick_notification.json',
    })
    expect(OPENALICE_SCRIPT_CRON_SPECS.low_vol_research_daily).toMatchObject({
      jobName: 'low_vol_research_daily',
      cronExpr: '0 2 * * *',
      approvedScript: 'scripts/cron_low_vol_research.sh',
      notificationPath: 'data/runtime/low_vol_research_daily_notification.json',
    })
    expect(OPENALICE_SCRIPT_CRON_SPECS.gated_improvement_candidate_daily).toMatchObject({
      jobName: 'gated_improvement_candidate_daily',
      cronExpr: '30 3 * * *',
      approvedScript: 'scripts/cron_gated_improvement_candidate.sh',
      enabled: false,
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
