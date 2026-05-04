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

  it('detects OS crontab duplicates for the internal external-derivatives collector', () => {
    const result = checkSurface([
      '# 7 */8 * * * /repo/OpenAlice/scripts/cron_external_derivatives_data_collect.sh',
      '7 */8 * * * cd /repo/OpenAlice && scripts/cron_external_derivatives_data_collect.sh',
      '8 */8 * * * cd /repo/OpenAlice && corepack pnpm external:derivatives:collect',
    ].join('\n'))

    expect(result.externalDerivativesCollectorHits).toBe(2)
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
})
