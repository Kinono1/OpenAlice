import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildMarketIntelNoOpenGateStatus,
  parseMarketIntelNoOpenGateStatusArgs,
  runMarketIntelNoOpenGateStatus,
} from './build_market_intel_no_open_gate_status.js'

describe('build_market_intel_no_open_gate_status', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parseMarketIntelNoOpenGateStatusArgs(['--output', 'null', '--json'])).toEqual({
      outputPath: null,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:strategy:market-intel-no-open-gate']).toContain('build_market_intel_no_open_gate_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_market_intel_no_open_gate_status.ts')
  })

  it('proves market-intel blocks reject new opens without authorizing execution', () => {
    const report = buildMarketIntelNoOpenGateStatus('2026-05-08T06:00:00.000Z')

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
      checks: {
        riskOffOpenContextStatus: 'risk_off',
        severeNewsOpenContextStatus: 'severe_news',
        laneBlockedOpenContextStatus: 'lane_blocked',
        symbolBlockedOpenContextStatus: 'symbol_blocked',
        allowedOpenContextStatus: 'ok',
        allowedRejectReasons: [],
      },
      blockers: [],
    })
    expect(report.checks.riskOffRejectReasons).toContain('context_status:risk_off')
    expect(report.checks.severeNewsRejectReasons).toContain('context_status:severe_news')
    expect(report.checks.laneBlockedRejectReasons).toContain('context_status:lane_blocked')
    expect(report.checks.symbolBlockedRejectReasons).toContain('context_status:symbol_blocked')
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-market-intel-gate-'))
    const outputPath = join(root, 'market_intel_no_open_gate_status.latest.json')
    await mkdir(root, { recursive: true })

    const report = await runMarketIntelNoOpenGateStatus({
      outputPath,
      json: false,
    })

    expect(report.status).toBe('pass')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      status: 'pass',
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'market_intel_no_open_gate_status',
      businessStatus: 'pass',
      recordsIn: 4,
      recordsOut: 1,
    })
  })
})
