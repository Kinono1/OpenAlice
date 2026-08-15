import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildPanicRegimeNoOpenGateStatus,
  parsePanicRegimeNoOpenGateStatusArgs,
  runPanicRegimeNoOpenGateStatus,
} from './build_panic_regime_no_open_gate_status.js'

describe('build_panic_regime_no_open_gate_status', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parsePanicRegimeNoOpenGateStatusArgs(['--output', 'null', '--json'])).toEqual({
      outputPath: null,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:strategy:panic-regime-no-open-gate']).toContain('build_panic_regime_no_open_gate_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_panic_regime_no_open_gate_status.ts')
  })

  it('proves panic/regime stress blocks new opens without authorizing execution', () => {
    const report = buildPanicRegimeNoOpenGateStatus('2026-05-08T05:30:00.000Z')

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-08T05:30:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'pass',
      checks: {
        eventFreezeRegime: 'event-risk-freeze',
        eventFreezeActionStatus: 'reduce',
        eventFreezeBaseActionStatus: 'attack-lite',
        eventFreezeCappedByEventWindow: true,
        eventFreezeOpenDecisionMode: 'blocked',
        eventFreezeReduceDecisionMode: 'pass-through',
        eventFreezeReducePassThrough: true,
        volStressRegime: 'vol-stress',
        volStressOpenDecisionMode: 'blocked',
        volStressReduceDecisionMode: 'pass-through',
        volStressReducePassThrough: true,
      },
      blockers: [],
    })
    expect(report.checks.eventFreezeOpenBlockReason).toContain('reduce')
    expect(report.checks.volStressOpenBlockReason).toContain('reduce')
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-panic-regime-gate-'))
    const outputPath = join(root, 'panic_regime_no_open_gate_status.latest.json')
    await mkdir(root, { recursive: true })

    const report = await runPanicRegimeNoOpenGateStatus({
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
      job: 'panic_regime_no_open_gate_status',
      businessStatus: 'pass',
      recordsIn: 2,
      recordsOut: 1,
    })
  })
})
