import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildPartialTakeProfitStatus,
  parsePartialTakeProfitStatusArgs,
  runPartialTakeProfitStatus,
} from './build_partial_take_profit_status.js'

describe('build_partial_take_profit_status', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parsePartialTakeProfitStatusArgs(['--output', 'null', '--json'])).toEqual({
      outputPath: null,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:strategy:partial-take-profit-status']).toContain('build_partial_take_profit_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_partial_take_profit_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_strategy_defect_monitor.ts')
  })

  it('validates tranche math without authorizing execution', () => {
    const report = buildPartialTakeProfitStatus('2026-05-07T15:00:00.000Z')

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-07T15:00:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'pass',
      blockers: [],
      checks: {
        longFirstTrancheCloseFraction: 0.5,
        longFirstTrancheCloseQuantity: 5,
        longIncrementalCloseFraction: 0.25,
        shortFirstTrancheCloseFraction: 0.5,
        notTriggeredCloseFraction: 0,
        levelCount: 2,
        totalConfiguredCloseFraction: 0.75,
      },
    })
    expect(report.safetyNotes.join(' ')).toContain('cannot authorize paper orders')
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-partial-take-profit-status-'))
    const outputPath = join(root, 'partial_take_profit_status.latest.json')
    await mkdir(root, { recursive: true })

    const report = await runPartialTakeProfitStatus({
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
      job: 'partial_take_profit_status',
      businessStatus: 'pass',
      recordsIn: 4,
      recordsOut: 1,
    })
  })
})
