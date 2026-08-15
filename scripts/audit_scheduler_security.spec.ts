import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildSchedulerSecurityAuditReport,
  checkSurface,
  inspectEnvFile,
  inspectInternalCronJobsStore,
} from './audit_scheduler_security.ts'

describe('audit_scheduler_security', () => {
  it('detects plaintext API keys and secret-like values on scheduler surfaces', () => {
    const result = checkSurface([
      'OPENALICE_ENV_FILE=/Users/kino/.config/openalice/openalice.env',
      'DEEPSEEK_API_KEY=sk-123456789012345678901234',
      '<key>DEEPSEEK_API_KEY</key>',
      'SLACK_BOT_TOKEN=xoxb-123456789012345678901234',
      'HTTP_PROXY=http://alice:s3cr3t@127.0.0.1:8080',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
      '-----BEGIN PRIVATE KEY-----',
    ].join('\n'))

    expect(result.openaliceEnvFileHits).toBe(1)
    expect(result.secretValueHits).toBe(4)
    expect(result.plaintextKeyAssignmentHits).toBe(3)
  })

  it('allows env-file references without plaintext key assignments', () => {
    const result = checkSurface([
      'OPENALICE_ENV_FILE=/Users/kino/.config/openalice/openalice.env',
      'OPENALICE_LLM_API_KEY_ENV=DEEPSEEK_API_KEY',
    ].join('\n'))

    expect(result.openaliceEnvFileHits).toBe(1)
    expect(result.secretValueHits).toBe(0)
    expect(result.plaintextKeyAssignmentHits).toBe(0)
  })

  it('fails for plaintext Telegram token, duplicate jobs, circuit-open jobs, and extra resident services', () => {
    const report = buildSchedulerSecurityAuditReport({
      crontabRaw: '',
      internalCronJobs: inspectInternalCronJobsStore(JSON.stringify({ jobs: [] })),
      plistTexts: 'OPENALICE_ENV_FILE=/Users/kino/.config/openalice/openalice.env',
      launchctlRaw: 'OPENALICE_ENV_FILE=/Users/kino/.config/openalice/openalice.env',
      wrapperText: '${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false}',
      envFile: {
        path: '/Users/kino/.config/openalice/openalice.env', exists: true, mode: '600',
        ownedByCurrentUser: true, restricted: true,
      },
      runtimeSafety: {
        connectorConfigPath: '/repo/data/config/connectors.json',
        plaintextTelegramToken: true,
        duplicateJobNames: ['duplicate'],
        circuitOpenJobs: ['failed-job'],
        dataRoot: '/repo/data',
        dataRootWritable: true,
        residentOpenAliceLabels: ['ai.openalice.main', 'ai.openalice.low-vol-observer'],
        retiredLaunchAgentPlistsPresent: ['ai.openalice.low-vol-observer'],
        okxPrivateDataEnabled: true,
        okxMarginDataEnabled: false,
        okxOptionChainEnabled: false,
        okxWarehouseDataRoot: '/Volumes/shield/active',
        okxWarehouseDataRootExternal: true,
        okxPrivateWebsocketConfigured: true,
        okxPrivateLoginSourceHits: ['scripts/run_okx_stream_worker.ts'],
        okxStreamWorkerProcesses: 2,
        ordinaryShieldDirectoryPresent: true,
      },
    })

    expect(report.status).toBe('fail')
    expect(report.findings.map(finding => finding.check)).toEqual(expect.arrayContaining([
      'telegram_plaintext_token',
      'internal_cron_duplicate_names',
      'internal_cron_circuit_open',
      'resident_openalice_service_count',
      'retired_launchagent_plists_present',
      'okx_public_only_config',
      'okx_active_warehouse_local_root',
      'okx_private_websocket_forbidden',
      'okx_stream_worker_singleton',
      'ordinary_shield_directory_forbidden',
    ]))
  })

  it('detects OS crontab duplicates for the internal external-derivatives collector', () => {
    const result = checkSurface([
      '# 7 */8 * * * /repo/OpenAlice/scripts/cron_external_derivatives_data_collect.sh',
      '7 */8 * * * cd /repo/OpenAlice && scripts/cron_external_derivatives_data_collect.sh',
      '8 */8 * * * cd /repo/OpenAlice && corepack pnpm external:derivatives:collect',
    ].join('\n'))

    expect(result.externalDerivativesCollectorHits).toBe(2)
    expect(result.openaliceSchedulerEntryHits).toBe(2)
  })

  it('detects OS crontab duplicates for OKX public-data tasks', () => {
    const result = checkSurface([
      '# 0-59/5 * * * * cd /repo/OpenAlice && scripts/cron_openalice_task.sh accumulate_5m_data',
      '0-59/5 * * * * cd /repo/OpenAlice && scripts/cron_openalice_task.sh accumulate_5m_data',
      '2-59/5 * * * * cd /repo/OpenAlice && corepack pnpm data:freshness:audit',
    ].join('\n'))

    expect(result.okxPublicDataTaskHits).toBe(2)
    expect(result.openaliceSchedulerEntryHits).toBe(2)
  })

  it('extracts the internal external-derivatives scheduler job and UTC timezone', () => {
    const result = inspectInternalCronJobsStore(JSON.stringify({
      jobs: [
        {
          name: 'external_derivatives_data_collect_8h',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'cron', cron: '7 */8 * * *', timezone: 'UTC' },
          script: { path: '/repo/OpenAlice/scripts/cron_external_derivatives_data_collect.sh' },
        },
      ],
    }))

    expect(result).toMatchObject({
      exists: true,
      parseError: null,
      externalDerivativesJobHits: 1,
      enabledExternalDerivativesJobHits: 1,
      scheduleKind: 'cron',
      cron: '7 */8 * * *',
      timezone: 'UTC',
      scriptPath: '/repo/OpenAlice/scripts/cron_external_derivatives_data_collect.sh',
    })
  })

  it('extracts required OKX public-data scheduler jobs with wrapper args', () => {
    const result = inspectInternalCronJobsStore(JSON.stringify({
      jobs: [
        {
          name: 'external_derivatives_data_collect_8h',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'cron', cron: '7 */8 * * *', timezone: 'UTC' },
          script: { path: '/repo/OpenAlice/scripts/cron_external_derivatives_data_collect.sh', args: [] },
        },
        {
          name: 'okx_public_1h_accumulate_hourly',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'cron', cron: '3 * * * *' },
          script: { path: '/repo/OpenAlice/scripts/cron_openalice_task.sh', args: ['accumulate_live_data'] },
        },
        {
          name: 'okx_public_5m_accumulate_5m',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'cron', cron: '0-59/5 * * * *' },
          script: { path: '/repo/OpenAlice/scripts/cron_openalice_task.sh', args: ['accumulate_5m_data'] },
        },
        {
          name: 'okx_public_1s_accumulate_5m',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'cron', cron: '1-59/5 * * * *' },
          script: { path: '/repo/OpenAlice/scripts/cron_openalice_task.sh', args: ['accumulate_1s_data'] },
        },
        {
          name: 'okx_public_freshness_audit_5m',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'cron', cron: '2-59/5 * * * *' },
          script: { path: '/repo/OpenAlice/scripts/cron_openalice_task.sh', args: ['live_data_freshness_audit'] },
        },
        {
          name: 'runtime_fee_auth_tick_4h',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'cron', cron: '11 */4 * * *' },
          script: { path: '/repo/OpenAlice/scripts/cron_openalice_task.sh', args: ['runtime_fee_auth_tick'] },
        },
        {
          name: 'prospective_evidence_tick_hourly',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'cron', cron: '9 * * * *' },
          script: { path: '/repo/OpenAlice/scripts/cron_openalice_task.sh', args: ['prospective_evidence_tick'] },
        },
      ],
    }))

    expect(result.requiredJobs.okx_public_1h_accumulate_hourly).toMatchObject({
      hits: 1,
      enabledHits: 1,
      cron: '3 * * * *',
      scriptPath: '/repo/OpenAlice/scripts/cron_openalice_task.sh',
      args: ['accumulate_live_data'],
    })
    expect(result.requiredJobs.okx_public_freshness_audit_5m).toMatchObject({
      hits: 1,
      enabledHits: 1,
      cron: '2-59/5 * * * *',
      scriptPath: '/repo/OpenAlice/scripts/cron_openalice_task.sh',
      args: ['live_data_freshness_audit'],
    })
    expect(result.requiredJobs.runtime_fee_auth_tick_4h).toMatchObject({
      hits: 1,
      enabledHits: 1,
      cron: '11 */4 * * *',
      scriptPath: '/repo/OpenAlice/scripts/cron_openalice_task.sh',
      args: ['runtime_fee_auth_tick'],
    })
    expect(result.requiredJobs.prospective_evidence_tick_hourly).toMatchObject({
      hits: 1,
      enabledHits: 1,
      cron: '9 * * * *',
      scriptPath: '/repo/OpenAlice/scripts/cron_openalice_task.sh',
      args: ['prospective_evidence_tick'],
    })
  })

  it('fails audit when an OKX public-data scheduler job is missing its wrapper arg', () => {
    const internalCronJobs = inspectInternalCronJobsStore(JSON.stringify({
      jobs: [
        {
          name: 'external_derivatives_data_collect_8h',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'cron', cron: '7 */8 * * *', timezone: 'UTC' },
          script: { path: '/repo/OpenAlice/scripts/cron_external_derivatives_data_collect.sh', args: [] },
        },
        {
          name: 'okx_public_1h_accumulate_hourly',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'cron', cron: '3 * * * *' },
          script: { path: '/repo/OpenAlice/scripts/cron_openalice_task.sh', args: [] },
        },
        {
          name: 'okx_public_5m_accumulate_5m',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'cron', cron: '0-59/5 * * * *' },
          script: { path: '/repo/OpenAlice/scripts/cron_openalice_task.sh', args: ['accumulate_5m_data'] },
        },
        {
          name: 'okx_public_1s_accumulate_5m',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'cron', cron: '1-59/5 * * * *' },
          script: { path: '/repo/OpenAlice/scripts/cron_openalice_task.sh', args: ['accumulate_1s_data'] },
        },
        {
          name: 'okx_public_freshness_audit_5m',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'cron', cron: '2-59/5 * * * *' },
          script: { path: '/repo/OpenAlice/scripts/cron_openalice_task.sh', args: ['live_data_freshness_audit'] },
        },
        {
          name: 'runtime_fee_auth_tick_4h',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'cron', cron: '11 */4 * * *' },
          script: { path: '/repo/OpenAlice/scripts/cron_openalice_task.sh', args: ['runtime_fee_auth_tick'] },
        },
        {
          name: 'prospective_evidence_tick_hourly',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'cron', cron: '9 * * * *' },
          script: { path: '/repo/OpenAlice/scripts/cron_openalice_task.sh', args: ['prospective_evidence_tick'] },
        },
      ],
    }))
    const report = buildSchedulerSecurityAuditReport({
      crontabRaw: '',
      internalCronJobs,
      plistTexts: 'OPENALICE_ENV_FILE=/Users/kino/.config/openalice/openalice.env',
      launchctlRaw: 'OPENALICE_ENV_FILE=/Users/kino/.config/openalice/openalice.env',
      wrapperText: '${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false}',
      envFile: {
        path: '/Users/kino/.config/openalice/openalice.env',
        exists: true,
        mode: '600',
        ownedByCurrentUser: true,
        restricted: true,
      },
      generatedAt: '2026-05-03T00:00:00.000Z',
    })

    expect(report.status).toBe('fail')
    expect(report.findings.map(finding => finding.check)).toContain('internal_okx_public_1h_accumulate_args')
  })

  it('fails audit when the internal external-derivatives job loses UTC timezone', () => {
    const internalCronJobs = inspectInternalCronJobsStore(JSON.stringify({
      jobs: [
        {
          name: 'external_derivatives_data_collect_8h',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'cron', cron: '7 */8 * * *' },
          script: { path: '/repo/OpenAlice/scripts/cron_external_derivatives_data_collect.sh' },
        },
      ],
    }))
    const report = buildSchedulerSecurityAuditReport({
      crontabRaw: '',
      internalCronJobs,
      plistTexts: 'OPENALICE_ENV_FILE=/Users/kino/.config/openalice/openalice.env',
      launchctlRaw: 'OPENALICE_ENV_FILE=/Users/kino/.config/openalice/openalice.env',
      wrapperText: '${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false}',
      envFile: {
        path: '/Users/kino/.config/openalice/openalice.env',
        exists: true,
        mode: '600',
        ownedByCurrentUser: true,
        restricted: true,
      },
      generatedAt: '2026-05-03T00:00:00.000Z',
    })

    expect(report.status).toBe('fail')
    expect(report.findings.map(finding => finding.check)).toContain('internal_external_derivatives_timezone')
  })

  it('fails audit when OS crontab also installs the external-derivatives collector', () => {
    const internalCronJobs = inspectInternalCronJobsStore(JSON.stringify({
      jobs: [
        {
          name: 'external_derivatives_data_collect_8h',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'cron', cron: '7 */8 * * *', timezone: 'UTC' },
          script: { path: '/repo/OpenAlice/scripts/cron_external_derivatives_data_collect.sh' },
        },
      ],
    }))
    const report = buildSchedulerSecurityAuditReport({
      crontabRaw: [
        'OPENALICE_ENV_FILE=/Users/kino/.config/openalice/openalice.env',
        '7 */8 * * * cd /repo/OpenAlice && scripts/cron_external_derivatives_data_collect.sh',
      ].join('\n'),
      internalCronJobs,
      plistTexts: 'OPENALICE_ENV_FILE=/Users/kino/.config/openalice/openalice.env',
      launchctlRaw: 'OPENALICE_ENV_FILE=/Users/kino/.config/openalice/openalice.env',
      wrapperText: '${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false}',
      envFile: {
        path: '/Users/kino/.config/openalice/openalice.env',
        exists: true,
        mode: '600',
        ownedByCurrentUser: true,
        restricted: true,
      },
      generatedAt: '2026-05-03T00:00:00.000Z',
    })

    expect(report.status).toBe('fail')
    expect(report.findings.map(finding => finding.check)).toContain('crontab_external_derivatives_duplicate')
  })

  it('requires the env file to be restricted to the current user', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-scheduler-audit-'))
    const envFile = join(dir, 'openalice.env')
    try {
      await writeFile(envFile, 'DEEPSEEK_API_KEY=test\n', 'utf-8')
      await chmod(envFile, 0o600)

      await expect(inspectEnvFile(envFile)).resolves.toMatchObject({
        exists: true,
        mode: '600',
        restricted: true,
      })

      await chmod(envFile, 0o644)
      await expect(inspectEnvFile(envFile)).resolves.toMatchObject({
        exists: true,
        mode: '644',
        restricted: false,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports OKX credential presence from a restricted env file without exposing values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-scheduler-audit-'))
    const envFile = join(dir, 'openalice.env')
    try {
      await writeFile(envFile, [
        'EXCHANGE_API_KEY=sourceKey123456789',
        'EXCHANGE_API_SECRET="sourceSecret123456789"',
        "EXCHANGE_PASSWORD='sourcePassphrase'",
      ].join('\n'), 'utf-8')
      await chmod(envFile, 0o600)

      await expect(inspectEnvFile(envFile)).resolves.toMatchObject({
        exists: true,
        restricted: true,
        okxCredentialPresence: {
          apiKey: true,
          secret: true,
          password: true,
        },
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails audit when runtime fee auth cron is enabled but launchd env is missing OKX credentials', () => {
    const internalCronJobs = inspectInternalCronJobsStore(JSON.stringify({
      jobs: [
        {
          name: 'runtime_fee_auth_tick_4h',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'cron', cron: '11 */4 * * *' },
          script: { path: '/repo/OpenAlice/scripts/cron_openalice_task.sh', args: ['runtime_fee_auth_tick'] },
        },
      ],
    }))
    const report = buildSchedulerSecurityAuditReport({
      crontabRaw: '',
      internalCronJobs,
      plistTexts: 'OPENALICE_ENV_FILE=/Users/kino/.config/openalice/openalice.env',
      launchctlRaw: 'OPENALICE_ENV_FILE=/Users/kino/.config/openalice/openalice.env',
      wrapperText: '${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false}',
      envFile: {
        path: '/Users/kino/.config/openalice/openalice.env',
        exists: true,
        mode: '600',
        ownedByCurrentUser: true,
        restricted: true,
        okxCredentialPresence: {
          apiKey: true,
          secret: false,
          password: false,
        },
      },
      generatedAt: '2026-05-03T00:00:00.000Z',
    })

    const finding = report.findings.find(item => item.check === 'runtime_fee_auth_tick_okx_credentials')
    expect(report.status).toBe('fail')
    expect(finding).toMatchObject({
      severity: 'fail',
      path: '/Users/kino/.config/openalice/openalice.env',
    })
    expect(finding?.detail).toContain('EXCHANGE_API_SECRET')
    expect(finding?.detail).toContain('EXCHANGE_PASSWORD')
  })
})
