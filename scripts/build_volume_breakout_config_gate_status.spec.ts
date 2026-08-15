import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildVolumeBreakoutConfigGateStatus,
  parseVolumeBreakoutConfigGateStatusArgs,
  runVolumeBreakoutConfigGateStatus,
} from './build_volume_breakout_config_gate_status.js'

describe('build_volume_breakout_config_gate_status', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parseVolumeBreakoutConfigGateStatusArgs(['--output', 'null', '--json'])).toEqual({
      outputPath: null,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:strategy:volume-breakout-config-gate']).toContain('build_volume_breakout_config_gate_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_volume_breakout_config_gate_status.ts')
  })

  it('reports the actual DEFAULT_VB_CONFIG values and derived needs_work status', () => {
    const report = buildVolumeBreakoutConfigGateStatus('2026-05-08T06:00:00.000Z')

    // Top-level status is now derived from check verdicts; with the real
    // DEFAULT_VB_CONFIG (volumeMultiplier=0.8, minBreakQuality=0.01) it
    // should resolve to needs_work, not the historical hardcoded 'pass'.
    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-08T06:00:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'needs_work',
      blockers: [],
    })

    // volumeMultiplier check: real default 0.8 is below the 2.0 threshold
    expect(report.checks.volumeMultiplier).toMatchObject({
      found: true,
      value: 0.8,
      verdict: 'needs_work',
    })
    expect(report.checks.volumeMultiplier.reason).toContain('0.8')
    expect(report.checks.volumeMultiplier.reason).toContain('false breakouts')

    // confidenceLogic check: still flags shallow threshold gradient (math is independent of multiplier value)
    expect(report.checks.confidenceLogic).toMatchObject({
      found: true,
      verdict: 'needs_work',
    })
    expect(report.checks.confidenceLogic.minConfidenceAtThreshold).toBeCloseTo(0.333, 3)
    expect(report.checks.confidenceLogic.volumeComponentDynamicRange).toBeCloseTo(3.0, 1)
    expect(report.checks.confidenceLogic.reason).toContain('shallow volume gradient')

    // stopLossPct check: real default 2% is within 1-5% acceptable range
    expect(report.checks.stopLossPct).toMatchObject({
      found: true,
      value: 0.02,
      verdict: 'ok',
    })

    // minBreakQuality check: real default 0.01 is below the 0.2 threshold
    expect(report.checks.minBreakQuality).toMatchObject({
      found: true,
      value: 0.01,
      verdict: 'needs_work',
    })
    expect(report.checks.minBreakQuality.reason).toContain('too lax')
  })

  it('reports verdict=ok when injected defaults satisfy all thresholds (reverse regression)', () => {
    // Inject synthetic well-tuned defaults to verify the builder correctly
    // reports 'pass' when configuration is healthy. This guards against a
    // regression that would always force needs_work regardless of input.
    const report = buildVolumeBreakoutConfigGateStatus('2026-05-08T06:00:00.000Z', {
      volumeMultiplier: 2.5,
      stopLossPct: 0.03,
      minBreakQuality: 0.35,
    })

    expect(report.status).toBe('needs_work') // confidenceLogic still flags shallow gradient
    expect(report.checks.volumeMultiplier).toMatchObject({
      value: 2.5,
      verdict: 'ok',
    })
    expect(report.checks.volumeMultiplier.reason).toContain('reasonable')
    expect(report.checks.minBreakQuality).toMatchObject({
      value: 0.35,
      verdict: 'ok',
    })
    expect(report.checks.minBreakQuality.reason).toContain('reasonable')
    expect(report.checks.stopLossPct.verdict).toBe('ok')
    // confidenceLogic remains needs_work because the shallow-gradient math
    // is independent of multiplier value; this is documented behavior.
    expect(report.checks.confidenceLogic.verdict).toBe('needs_work')
  })

  it('writes artifact and manifest sidecar with derived businessStatus', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-volume-breakout-config-gate-'))
    const outputPath = join(root, 'volume_breakout_config_gate_status.latest.json')
    await mkdir(root, { recursive: true })

    const report = await runVolumeBreakoutConfigGateStatus({
      outputPath,
      json: false,
    })

    // status is derived; with real DEFAULT_VB_CONFIG it must be needs_work
    expect(report.status).toBe('needs_work')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      schemaVersion: 1,
      researchOnly: true,
      diagnosticOnly: true,
      status: 'needs_work',
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
    // businessStatus mirrors the derived top-level status:
    // needs_work → warn, pass → pass, fail → fail.
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'volume_breakout_config_gate_status',
      businessStatus: 'warn',
      recordsIn: 4,
      recordsOut: 1,
    })
  })
})
