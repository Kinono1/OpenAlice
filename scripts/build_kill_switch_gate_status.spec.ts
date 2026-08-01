import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildKillSwitchGateStatus,
  parseKillSwitchGateStatusArgs,
  runKillSwitchGateStatus,
} from './build_kill_switch_gate_status.js'

describe('build_kill_switch_gate_status', () => {
  const passingSources = {
    killSwitchConfig: { defaultPolicy: 'block_new_only' },
    riskConfig: { killSwitch: false },
  }

  it('parses defaults and keeps package scripts wired', () => {
    expect(parseKillSwitchGateStatusArgs(['--output', 'null', '--json'])).toEqual({
      outputPath: null,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:strategy:kill-switch-gate']).toContain('build_kill_switch_gate_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_kill_switch_gate_status.ts')
  })

  it('reads kill-switch and risk config and produces correct artifact structure', async () => {
    const report = await buildKillSwitchGateStatus('2026-05-08T06:00:00.000Z', passingSources)

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-08T06:00:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'pass',
      blockers: [],
    })

    expect(report.killSwitchEnabled).toBe(false)
    expect(report.defaultPolicy).toBe('block_new_only')
    expect(report.researchOnlyBlockedConsistent).toBe(true)

    expect(report.checks.killSwitchEnabled).toMatchObject({ found: true, value: false, verdict: 'pass' })
    expect(report.checks.defaultPolicy).toMatchObject({ found: true, value: 'block_new_only', verdict: 'pass' })
    expect(report.checks.consistentWithState).toMatchObject({ found: true, value: true, verdict: 'pass' })
  })

  it('produces consistent verdicts when kill switch is disabled', async () => {
    const report = await buildKillSwitchGateStatus('2026-05-08T06:00:00.000Z', passingSources)

    expect(report.status).toBe('pass')
    expect(report.researchOnlyBlockedConsistent).toBe(true)
    expect(report.checks.consistentWithState.verdict).toBe('pass')
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-kill-switch-gate-'))
    const outputPath = join(root, 'kill_switch_gate_status.latest.json')
    await mkdir(root, { recursive: true })

    const report = await runKillSwitchGateStatus({
      outputPath,
      json: false,
    }, passingSources)

    expect(report.status).toBe('pass')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      schemaVersion: 1,
      researchOnly: true,
      diagnosticOnly: true,
      status: 'pass',
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'kill_switch_gate_status',
      businessStatus: 'pass',
      recordsIn: 2,
      recordsOut: 1,
    })
  })

  it('fails closed when the runtime configuration is unavailable', async () => {
    const report = await buildKillSwitchGateStatus(
      '2026-05-08T06:00:00.000Z',
      { killSwitchConfig: null, riskConfig: null },
    )

    expect(report.status).toBe('fail')
    expect(report.checks.killSwitchEnabled.verdict).toBe('fail')
    expect(report.checks.defaultPolicy.verdict).toBe('fail')
    expect(report.checks.consistentWithState.verdict).toBe('fail')
    expect(report.blockers).toEqual(expect.arrayContaining([
      'risk_config_kill_switch_missing',
      'kill_switch_default_policy_missing',
      'kill_switch_state_not_verifiably_consistent',
    ]))
  })
})
