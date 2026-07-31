import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildDecisionContextCoverageGateStatus,
  parseDecisionContextCoverageGateStatusArgs,
  runDecisionContextCoverageGateStatus,
} from './build_decision_context_coverage_gate_status.js'

describe('build_decision_context_coverage_gate_status', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parseDecisionContextCoverageGateStatusArgs(['--output', 'null', '--json'])).toEqual({
      outputPath: null,
      paperPnlDiagnosticsPath: 'data/research/paper_pnl_diagnostics.latest.json',
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:strategy:decision-context-coverage-gate']).toContain('build_decision_context_coverage_gate_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_decision_context_coverage_gate_status.ts')
  })

  it('reports low context coverage as watch when diagnostics show poor coverage', () => {
    const report = buildDecisionContextCoverageGateStatus({
      generatedAt: '2026-05-08T07:00:00.000Z',
      paperPnlDiagnostics: {
        coverage: {
          closedTrades: 100,
          contextBuckets: [
            { bucket: 'ok', count: 10, sharePct: 10 },
            { bucket: 'stale', count: 2, sharePct: 2 },
            { bucket: 'timeout', count: 0, sharePct: 0 },
            { bucket: 'legacy_missing', count: 85, sharePct: 85 },
            { bucket: 'new_missing', count: 3, sharePct: 3 },
          ],
          contextEnforcementWindow: {
            status: 'ok',
            contextCoveragePct: 0,
            newMissingContextTrades: 3,
          },
        },
      },
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-08T07:00:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'watch',
    })
    expect(report.checks.contextOKCount).toBe(10)
    expect(report.checks.contextStaleCount).toBe(2)
    expect(report.checks.contextTotalCount).toBe(100)
    expect(report.checks.coveragePct).toBe(12)
    expect(report.checks.coverageBelowThreshold).toBe(true)
    expect(report.blockers).toContain('context_coverage_below_threshold:12<95')
    expect(report.blockers).toContain('enforcement_window_new_missing_context:3')
  })

  it('reports pass when context coverage meets threshold', () => {
    const report = buildDecisionContextCoverageGateStatus({
      generatedAt: '2026-05-08T07:00:00.000Z',
      paperPnlDiagnostics: {
        coverage: {
          closedTrades: 100,
          contextBuckets: [
            { bucket: 'ok', count: 96, sharePct: 96 },
            { bucket: 'stale', count: 4, sharePct: 4 },
            { bucket: 'timeout', count: 0, sharePct: 0 },
            { bucket: 'legacy_missing', count: 0, sharePct: 0 },
            { bucket: 'new_missing', count: 0, sharePct: 0 },
          ],
          contextEnforcementWindow: {
            status: 'ok',
            contextCoveragePct: 100,
            newMissingContextTrades: 0,
          },
        },
      },
    })

    expect(report).toMatchObject({
      status: 'pass',
      researchOnly: true,
      diagnosticOnly: true,
      executionAllowed: false,
    })
    expect(report.checks.coveragePct).toBe(100)
    expect(report.checks.coverageBelowThreshold).toBe(false)
    expect(report.blockers).toEqual([])
  })

  it('reports blocked when diagnostics are missing', () => {
    const report = buildDecisionContextCoverageGateStatus({
      generatedAt: '2026-05-08T07:00:00.000Z',
      paperPnlDiagnostics: null,
    })

    expect(report.status).toBe('blocked')
    expect(report.blockers).toContain('paper_pnl_diagnostics_missing')
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-decision-context-coverage-'))
    const diagnosticsPath = join(root, 'paper_pnl_diagnostics.latest.json')
    const outputPath = join(root, 'decision_context_coverage_gate_status.latest.json')
    await mkdir(root, { recursive: true })
    await writeFile(diagnosticsPath, JSON.stringify({
      coverage: {
        closedTrades: 10,
        contextBuckets: [
          { bucket: 'ok', count: 10, sharePct: 100 },
          { bucket: 'legacy_missing', count: 0, sharePct: 0 },
        ],
        contextEnforcementWindow: {
          status: 'ok',
          contextCoveragePct: 100,
          newMissingContextTrades: 0,
        },
      },
    }), 'utf-8')

    const report = await runDecisionContextCoverageGateStatus({
      outputPath,
      paperPnlDiagnosticsPath: diagnosticsPath,
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
      job: 'decision_context_coverage_gate_status',
      businessStatus: 'pass',
      recordsIn: 1,
      recordsOut: 1,
    })
  })
})
