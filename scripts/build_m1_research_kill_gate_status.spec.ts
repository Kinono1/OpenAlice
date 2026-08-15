import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildM1ResearchKillGateStatus,
  parseM1ResearchKillGateStatusArgs,
  runM1ResearchKillGateStatus,
} from './build_m1_research_kill_gate_status.js'
import type { TrainingReport } from './build_m0b_signal_gate_status.js'

describe('build_m1_research_kill_gate_status', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parseM1ResearchKillGateStatusArgs(['--output', 'null', '--json'])).toEqual({
      outputPath: null,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:m1:kill-gate']).toContain('build_m1_research_kill_gate_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_m1_research_kill_gate_status.ts')
  })

  it('returns missing report when training_report.json does not exist', () => {
    const report = buildM1ResearchKillGateStatus('2026-05-08T05:30:00.000Z', null)

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-08T05:30:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'fail',
      allPassed: false,
      blockers: ['training_report_missing'],
    })
    expect(report.gateResults.wfoFoldCount).toEqual({ value: null, threshold: 3, pass: false })
    expect(report.gateResults.wfoMeanIc).toEqual({ value: null, threshold: 0, pass: false })
    expect(report.gateResults.wfoPassRate).toEqual({ value: null, threshold: 0.3, pass: false })
    expect(report.gateResults.wfoMedianSpread).toEqual({ value: null, threshold: 0, pass: false })
  })

  it('returns all passed when all WFO-Lite conditions are met', () => {
    const trainingReport: TrainingReport = {
      wfo: {
        foldCount: 5,
        meanIc: 0.035,
        passRate: 0.6,
        medianSpread: 0.015,
      },
    }

    const report = buildM1ResearchKillGateStatus('2026-05-08T05:30:00.000Z', trainingReport)

    expect(report.status).toBe('pass')
    expect(report.allPassed).toBe(true)
    expect(report.blockers).toEqual([])
    expect(report.gateResults.wfoFoldCount.pass).toBe(true)
    expect(report.gateResults.wfoMeanIc.pass).toBe(true)
    expect(report.gateResults.wfoPassRate.pass).toBe(true)
    expect(report.gateResults.wfoMedianSpread.pass).toBe(true)
  })

  it('fails specific WFO conditions and reports blockers', () => {
    const trainingReport: TrainingReport = {
      wfo: {
        foldCount: 2,
        meanIc: -0.01,
        passRate: 0.2,
        medianSpread: -0.005,
      },
    }

    const report = buildM1ResearchKillGateStatus('2026-05-08T05:30:00.000Z', trainingReport)

    expect(report.allPassed).toBe(false)
    expect(report.gateResults.wfoFoldCount.pass).toBe(false)
    expect(report.gateResults.wfoMeanIc.pass).toBe(false)
    expect(report.gateResults.wfoPassRate.pass).toBe(false)
    expect(report.gateResults.wfoMedianSpread.pass).toBe(false)
    expect(report.blockers.length).toBeGreaterThanOrEqual(4)
    expect(report.blockers[0]).toContain('wfoFoldCount_failed')
  })

  it('fails when WFO section is missing from report', () => {
    const trainingReport: TrainingReport = {}

    const report = buildM1ResearchKillGateStatus('2026-05-08T05:30:00.000Z', trainingReport)

    expect(report.allPassed).toBe(false)
    expect(report.gateResults.wfoFoldCount.pass).toBe(false)
    expect(report.gateResults.wfoMeanIc.pass).toBe(false)
    expect(report.gateResults.wfoPassRate.pass).toBe(false)
    expect(report.gateResults.wfoMedianSpread.pass).toBe(false)
  })

  it('always keeps diagnostic-only execution guards', () => {
    const trainingReport: TrainingReport = {
      wfo: {
        foldCount: 5,
        meanIc: 0.04,
        passRate: 0.6,
        medianSpread: 0.02,
      },
    }

    const report = buildM1ResearchKillGateStatus('2026-05-08T05:30:00.000Z', trainingReport)

    expect(report.researchOnly).toBe(true)
    expect(report.diagnosticOnly).toBe(true)
    expect(report.promotionEligible).toBe(false)
    expect(report.paperTradingAllowed).toBe(false)
    expect(report.liveTradingAllowed).toBe(false)
    expect(report.executionAllowed).toBe(false)
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-m1-gate-'))
    const outputPath = join(root, 'm1_research_kill_gate_status.latest.json')
    await mkdir(root, { recursive: true })

    const report = await runM1ResearchKillGateStatus({
      outputPath,
      json: false,
      reportPath: join(root, 'missing_training_report.json'),
    })

    expect(report.allPassed).toBe(false)
    expect(report.blockers).toContain('training_report_missing')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      status: 'fail',
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'm1_research_kill_gate_status',
      businessStatus: 'fail',
      recordsIn: 1,
      recordsOut: 1,
    })
  })

  it('writes artifact with pass when WFO evidence exists and all conditions met', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-m1-gate-pass-'))
    const outputPath = join(root, 'm1_research_kill_gate_status.latest.json')
    await mkdir(root, { recursive: true })

    const trainingReport: TrainingReport = {
      wfo: {
        foldCount: 5,
        meanIc: 0.04,
        passRate: 0.7,
        medianSpread: 0.02,
      },
    }

    const report = buildM1ResearchKillGateStatus('2026-05-08T05:30:00.000Z', trainingReport)

    expect(report.allPassed).toBe(true)
    expect(report.status).toBe('pass')
    expect(report.gateResults.wfoFoldCount.value).toBe(5)
    expect(report.gateResults.wfoMeanIc.value).toBe(0.04)
    expect(report.gateResults.wfoPassRate.value).toBe(0.7)
    expect(report.gateResults.wfoMedianSpread.value).toBe(0.02)
  })
})
