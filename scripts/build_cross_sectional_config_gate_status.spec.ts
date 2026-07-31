import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildCrossSectionalConfigGateStatus,
  parseCrossSectionalConfigGateStatusArgs,
  runCrossSectionalConfigGateStatus,
} from './build_cross_sectional_config_gate_status.js'

describe('build_cross_sectional_config_gate_status', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parseCrossSectionalConfigGateStatusArgs(['--output', 'null', '--json'])).toEqual({
      outputPath: null,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:strategy:cross-sectional-config-gate']).toContain('build_cross_sectional_config_gate_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_cross_sectional_config_gate_status.ts')
  })

  it('produces static diagnostic artifact without authorizing execution', () => {
    const report = buildCrossSectionalConfigGateStatus('2026-05-08T06:00:00.000Z')

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

    expect(report.checks.mtfWeight).toMatchObject({ found: true, verdict: 'needs_work' })
    expect(report.checks.funding).toMatchObject({ found: true, verdict: 'needs_work' })
    expect(report.checks.spread).toMatchObject({ found: true, verdict: 'needs_work' })
    expect(report.checks.regime).toMatchObject({ found: false, verdict: 'needs_work' })
    expect(report.checks.confidence).toMatchObject({ found: true, verdict: 'needs_work' })
    expect(report.checks.volCeiling).toMatchObject({ found: true, verdict: 'needs_work' })
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-cross-sectional-config-gate-'))
    const outputPath = join(root, 'cross_sectional_config_gate_status.latest.json')
    await mkdir(root, { recursive: true })

    const report = await runCrossSectionalConfigGateStatus({
      outputPath,
      json: false,
    })

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
      job: 'cross_sectional_config_gate_status',
      businessStatus: 'pass',
      recordsIn: 6,
      recordsOut: 1,
    })
  })
})
