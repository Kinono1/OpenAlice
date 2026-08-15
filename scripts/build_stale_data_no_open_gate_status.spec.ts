import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildStaleDataNoOpenGateStatus,
  parseStaleDataNoOpenGateStatusArgs,
  runStaleDataNoOpenGateStatus,
} from './build_stale_data_no_open_gate_status.js'

describe('build_stale_data_no_open_gate_status', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parseStaleDataNoOpenGateStatusArgs(['--output', 'null', '--json'])).toEqual({
      outputPath: null,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:strategy:stale-data-no-open-gate']).toContain('build_stale_data_no_open_gate_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_stale_data_no_open_gate_status.ts')
  })

  it('proves stale data blocks new opens without authorizing execution', () => {
    const report = buildStaleDataNoOpenGateStatus('2026-05-07T13:00:00.000Z')

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-07T13:00:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'pass',
      checks: {
        staleHighConfidenceActionStatus: 'no-trade',
        freshHighConfidenceActionStatus: 'attack',
        staleOpenDecisionMode: 'blocked',
        staleReduceDecisionMode: 'pass-through',
        staleReducePassThrough: true,
      },
      blockers: [],
    })
    expect(report.checks.staleOpenBlockReason).toContain('no-trade')
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-stale-data-gate-'))
    const outputPath = join(root, 'stale_data_no_open_gate_status.latest.json')
    await mkdir(root, { recursive: true })

    const report = await runStaleDataNoOpenGateStatus({
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
      job: 'stale_data_no_open_gate_status',
      businessStatus: 'pass',
      recordsIn: 2,
      recordsOut: 1,
    })
  })
})
