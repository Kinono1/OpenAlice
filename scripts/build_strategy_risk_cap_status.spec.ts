import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildStrategyRiskCapStatus,
  parseStrategyRiskCapStatusArgs,
  runStrategyRiskCapStatus,
} from './build_strategy_risk_cap_status.js'

describe('build_strategy_risk_cap_status', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parseStrategyRiskCapStatusArgs(['--output', 'null', '--json'])).toEqual({
      outputPath: null,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:strategy:risk-cap-status']).toContain('build_strategy_risk_cap_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_strategy_risk_cap_status.ts')
  })

  it('proves single-trade and total-exposure caps without authorizing execution', async () => {
    const report = await buildStrategyRiskCapStatus('2026-05-07T14:00:00.000Z')

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-07T14:00:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'pass',
      blockers: [],
      checks: {
        singleTradeLossProbe: {
          approved: false,
        },
        totalExposureProbe: {
          approved: false,
        },
        symbolConcentrationProbe: {
          approved: false,
        },
        netDirectionalExposureProbe: {
          approved: false,
        },
        correlatedGroupExposureProbe: {
          approved: false,
        },
        reduceOnlyPassThroughProbe: {
          approved: true,
          reason: null,
        },
        maxSingleTradeLossUsdConfigured: 150,
        maxTotalExposurePctOfEquityConfigured: 60,
        maxSymbolExposurePctOfEquityConfigured: 40,
        maxNetDirectionalExposurePctOfEquityConfigured: 40,
        maxCorrelatedGroupExposurePctOfEquityConfigured: 60,
      },
    })
    expect(report.checks.singleTradeLossProbe.reason).toContain('maxSingleTradeLossUsd')
    expect(report.checks.totalExposureProbe.reason).toContain('maxTotalExposurePctOfEquity')
    expect(report.checks.symbolConcentrationProbe.reason).toContain('maxSymbolExposurePctOfEquity')
    expect(report.checks.netDirectionalExposureProbe.reason).toContain('maxNetDirectionalExposurePctOfEquity')
    expect(report.checks.correlatedGroupExposureProbe.reason).toContain('maxCorrelatedGroupExposurePctOfEquity')
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-risk-cap-status-'))
    const outputPath = join(root, 'strategy_risk_cap_status.latest.json')
    await mkdir(root, { recursive: true })

    const report = await runStrategyRiskCapStatus({
      outputPath,
      json: false,
    })

    expect(report.status).toBe('pass')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      status: 'pass',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'strategy_risk_cap_status',
      businessStatus: 'pass',
      recordsIn: 6,
      recordsOut: 1,
    })
  })
})
