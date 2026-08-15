import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildM0bSignalGateStatus,
  parseM0bSignalGateStatusArgs,
  runM0bSignalGateStatus,
} from './build_m0b_signal_gate_status.js'
import type { TrainingReport } from './build_m0b_signal_gate_status.js'

describe('build_m0b_signal_gate_status', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parseM0bSignalGateStatusArgs(['--output', 'null', '--json'])).toEqual({
      outputPath: null,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:m0b:signal-gate']).toContain('build_m0b_signal_gate_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_m0b_signal_gate_status.ts')
  })

  it('returns missing report when training_report.json does not exist', () => {
    const report = buildM0bSignalGateStatus('2026-05-08T05:30:00.000Z', null)

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
    expect(report.gateResults.spearmanIC).toEqual({ value: null, threshold: 0.03, pass: false })
    expect(report.gateResults.icir).toEqual({ value: null, threshold: 0.3, pass: false })
    expect(report.gateResults.topBottomGross).toEqual({ value: null, threshold: 0, pass: false })
    expect(report.gateResults.topBottomNet).toEqual({ value: null, threshold: 0, pass: false })
    expect(report.gateResults.turnoverCost).toEqual({ value: null, threshold: 0.5, pass: false })
    expect(report.gateResults.continuousDays).toEqual({ value: null, threshold: 60, pass: false })
    expect(report.gateResults.negativeControl).toEqual({ value: null, threshold: 0.03, pass: false })
  })

  it('returns all passed when all conditions are met', () => {
    const trainingReport: TrainingReport = {
      ic: {
        spearmanRankIc: 0.045,
        effectiveNCorrected: true,
        icir: 0.45,
        icirMethod: 'daily_aggregated',
      },
      topBottomSpread: {
        grossReturn: 0.025,
        netReturn: 0.018,
      },
      turnover: {
        costPct: 0.008,
        grossEdgePct: 0.025,
      },
      continuousValidDays: 65,
      negativeControl: {
        shuffledLabelIc: 0.01,
      },
    }

    const report = buildM0bSignalGateStatus('2026-05-08T05:30:00.000Z', trainingReport)

    expect(report.status).toBe('pass')
    expect(report.allPassed).toBe(true)
    expect(report.blockers).toEqual([])
    expect(report.gateResults.spearmanIC.pass).toBe(true)
    expect(report.gateResults.icir.pass).toBe(true)
    expect(report.gateResults.topBottomGross.pass).toBe(true)
    expect(report.gateResults.topBottomNet.pass).toBe(true)
    expect(report.gateResults.turnoverCost.pass).toBe(true)
    expect(report.gateResults.continuousDays.pass).toBe(true)
    expect(report.gateResults.negativeControl.pass).toBe(true)
  })

  it('fails specific conditions and reports blockers', () => {
    const trainingReport: TrainingReport = {
      ic: {
        spearmanRankIc: 0.02,
        effectiveNCorrected: true,
        icir: 0.25,
        icirMethod: 'daily_aggregated',
      },
      topBottomSpread: {
        grossReturn: -0.01,
        netReturn: -0.015,
      },
      turnover: {
        costPct: 0.02,
        grossEdgePct: 0.02,
      },
      continuousValidDays: 30,
      negativeControl: {
        shuffledLabelIc: 0.05,
      },
    }

    const report = buildM0bSignalGateStatus('2026-05-08T05:30:00.000Z', trainingReport)

    expect(report.allPassed).toBe(false)
    expect(report.gateResults.spearmanIC.pass).toBe(false)
    expect(report.gateResults.icir.pass).toBe(false)
    expect(report.gateResults.topBottomGross.pass).toBe(false)
    expect(report.gateResults.topBottomNet.pass).toBe(false)
    expect(report.gateResults.turnoverCost.pass).toBe(false) // 0.02/0.02 = 1.0 >= 0.5
    expect(report.gateResults.continuousDays.pass).toBe(false)
    expect(report.gateResults.negativeControl.pass).toBe(false)
    expect(report.blockers.length).toBeGreaterThanOrEqual(7)
    expect(report.blockers[0]).toContain('spearmanIC_failed')
  })

  it('always keeps diagnostic-only execution guards', () => {
    const trainingReport: TrainingReport = {
      ic: { spearmanRankIc: 0.05, effectiveNCorrected: true, icir: 0.5, icirMethod: 'daily_aggregated' },
      topBottomSpread: { grossReturn: 0.03, netReturn: 0.02 },
      turnover: { costPct: 0.005, grossEdgePct: 0.03 },
      continuousValidDays: 90,
      negativeControl: { shuffledLabelIc: 0.01 },
    }

    const report = buildM0bSignalGateStatus('2026-05-08T05:30:00.000Z', trainingReport)

    expect(report.researchOnly).toBe(true)
    expect(report.diagnosticOnly).toBe(true)
    expect(report.promotionEligible).toBe(false)
    expect(report.paperTradingAllowed).toBe(false)
    expect(report.liveTradingAllowed).toBe(false)
    expect(report.executionAllowed).toBe(false)
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-m0b-gate-'))
    const outputPath = join(root, 'm0b_signal_gate_status.latest.json')
    await mkdir(root, { recursive: true })

    const report = await runM0bSignalGateStatus({
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
      job: 'm0b_signal_gate_status',
      businessStatus: 'fail',
      recordsIn: 1,
      recordsOut: 1,
    })
  })

  it('writes artifact with pass when report exists and all conditions met', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-m0b-gate-pass-'))
    const outputPath = join(root, 'm0b_signal_gate_status.latest.json')
    await mkdir(root, { recursive: true })

    // Create a mock training report
    const reportPath = join(root, 'training_report.json')
    const trainingReport: TrainingReport = {
      ic: { spearmanRankIc: 0.05, effectiveNCorrected: true, icir: 0.5, icirMethod: 'daily_aggregated' },
      topBottomSpread: { grossReturn: 0.03, netReturn: 0.02 },
      turnover: { costPct: 0.005, grossEdgePct: 0.03 },
      continuousValidDays: 90,
      negativeControl: { shuffledLabelIc: 0.01 },
    }
    await writeFile(reportPath, `${JSON.stringify(trainingReport, null, 2)}\n`)

    // The file-backed runner accepts a report path, but this assertion keeps the
    // pure gate contract focused on the parsed training-report shape.
    const report = buildM0bSignalGateStatus('2026-05-08T05:30:00.000Z', trainingReport)

    expect(report.allPassed).toBe(true)
    expect(report.status).toBe('pass')
    expect(report.gateResults.spearmanIC.value).toBe(0.05)
    expect(report.gateResults.icir.value).toBe(0.5)
    expect(report.gateResults.topBottomGross.value).toBe(0.03)
    expect(report.gateResults.topBottomNet.value).toBe(0.02)
    expect(report.gateResults.continuousDays.value).toBe(90)
    expect(report.gateResults.negativeControl.value).toBe(0.01)

    // turnoverCost should be 0.005/0.03 = 0.1667
    expect(report.gateResults.turnoverCost.value).toBeCloseTo(0.1667, 3)
  })
})
