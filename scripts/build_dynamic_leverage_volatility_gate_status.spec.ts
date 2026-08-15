import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildDynamicLeverageVolatilityGateStatus,
  parseDynamicLeverageVolatilityGateStatusArgs,
  resolveVolatilityTier,
  runDynamicLeverageVolatilityGateStatus,
} from './build_dynamic_leverage_volatility_gate_status.js'

describe('build_dynamic_leverage_volatility_gate_status', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parseDynamicLeverageVolatilityGateStatusArgs(['--output', 'null', '--json'])).toEqual({
      outputPath: null,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:strategy:dynamic-leverage-volatility-gate']).toContain('build_dynamic_leverage_volatility_gate_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_dynamic_leverage_volatility_gate_status.ts')
  })

  it('proves volatility tier resolution produces correct leverage caps without authorizing execution', () => {
    const report = buildDynamicLeverageVolatilityGateStatus('2026-05-08T06:00:00.000Z')

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

    expect(report.checks).toMatchObject({
      volatilityPercentile: 0.85,
      realizedVolPct: 65,
      currentMaxLeverage: 100,
      leverageBlocked: false,
      tier: 'high',
    })

    expect(report.checks.lowTierProbe).toMatchObject({ percentile: 0.10, maxLeverage: 3, blocked: false })
    expect(report.checks.normalTierProbe).toMatchObject({ percentile: 0.50, maxLeverage: 1, blocked: false })
    expect(report.checks.highTierProbe).toMatchObject({ percentile: 0.90, maxLeverage: 1, blocked: false })
    expect(report.checks.extremeTierProbe).toMatchObject({ percentile: 0.99, maxLeverage: 0, blocked: true })
  })

  it('resolves volatility tiers correctly', () => {
    const low = resolveVolatilityTier(0.10)
    expect(low).toMatchObject({ tier: 'low', maxLeverage: 3, blocked: false })

    const normal = resolveVolatilityTier(0.50)
    expect(normal).toMatchObject({ tier: 'normal', maxLeverage: 1, blocked: false })

    const high = resolveVolatilityTier(0.90)
    expect(high).toMatchObject({ tier: 'high', maxLeverage: 1, blocked: false })

    const extreme = resolveVolatilityTier(0.99)
    expect(extreme).toMatchObject({ tier: 'extreme', maxLeverage: 0, blocked: true })

    const boundaryLow = resolveVolatilityTier(0.25)
    expect(boundaryLow.tier).toBe('normal')

    const boundaryNormal = resolveVolatilityTier(0.75)
    expect(boundaryNormal.tier).toBe('high')

    const boundaryHigh = resolveVolatilityTier(0.95)
    expect(boundaryHigh.tier).toBe('extreme')
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-dynamic-leverage-gate-'))
    const outputPath = join(root, 'dynamic_leverage_volatility_gate_status.latest.json')
    await mkdir(root, { recursive: true })

    const report = await runDynamicLeverageVolatilityGateStatus({
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
      job: 'dynamic_leverage_volatility_gate_status',
      businessStatus: 'pass',
      recordsIn: 4,
      recordsOut: 1,
    })
  })
})
