import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildStrategyQualityGateCoverageReport,
  parseStrategyQualityGateCoverageArgs,
  runStrategyQualityGateCoverage,
} from './build_strategy_quality_gate_coverage.js'

describe('build_strategy_quality_gate_coverage', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parseStrategyQualityGateCoverageArgs(['--output', 'null', '--json'])).toMatchObject({
      outputPath: null,
      strategyDefectRegistryPath: 'data/research/strategy_defect_registry.latest.json',
      strategyDefectMonitorPath: 'data/research/strategy_defect_monitor.latest.json',
      quantFrameworkBenchmarkPath: 'data/research/quant_framework_benchmark_report.latest.json',
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:strategy:quality-gate-coverage']).toContain('build_strategy_quality_gate_coverage.ts')
    expect(scripts['status:research-evidence']).toContain('build_strategy_quality_gate_coverage.ts')
  })

  it('blocks uncovered P0/P1 open defects without authorizing execution', () => {
    const report = buildStrategyQualityGateCoverageReport({
      generatedAt: '2026-05-08T05:00:00.000Z',
      sourceArtifacts: {
        strategyDefectRegistry: '/tmp/strategy_defect_registry.latest.json',
        strategyDefectMonitor: '/tmp/strategy_defect_monitor.latest.json',
        quantFrameworkBenchmark: '/tmp/quant_framework_benchmark_report.latest.json',
      },
      strategyDefectRegistry: {
        researchOnly: true,
        diagnosticOnly: true,
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        executionAllowed: false,
        defects: [
          defect('2.4', 'execution', 'Per-trade cost evidence incomplete', 'P0', 'partial', ['route_cost_slippage_readiness']),
          defect('2.8', 'execution', 'Entry timing quality missing', 'P1', 'open', []),
          defect('3.3', 'risk', 'Panic/regime context not hard-gated', 'P1', 'open', []),
          defect('4.4', 'data', 'Stale data must fail-close opens', 'P0', 'watch', ['stale_data_no_open_gate']),
          defect('5.2', 'backtest', 'CPCV/PBO validation missing', 'P2', 'open', []),
        ],
      },
      strategyDefectMonitor: {
        researchOnly: true,
        diagnosticOnly: true,
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        executionAllowed: false,
        findings: [
          { id: 'route_cost_slippage_readiness', status: 'blocked' },
          { id: 'stale_data_no_open_gate', status: 'pass' },
        ],
      },
      quantFrameworkBenchmark: {
        status: 'blocked',
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        executionAllowed: false,
      },
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-08T05:00:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked',
      summary: {
        defects: 5,
        monitorFindings: 2,
        openOrPartial: 4,
        p0OpenOrPartial: 1,
        p1OpenOrPartial: 2,
        p0p1OpenOrPartial: 3,
        monitorCovered: 2,
        monitorUncovered: 3,
        p0p1OpenOrPartialCovered: 1,
        p0p1OpenOrPartialUncovered: 2,
        p0OpenOrPartialUncovered: 0,
        p1OpenOrPartialUncovered: 2,
        coveragePct: 40,
        p0p1OpenOrPartialCoveragePct: 33,
        quantBenchmarkStatus: 'blocked',
      },
    })
    expect(report.uncoveredDefects.map(item => item.id)).toEqual(['2.8', '3.3'])
    expect(report.repairQueues.find(queue => queue.queueId === 'execution_quality')).toMatchObject({
      status: 'blocked',
      p0p1OpenOrPartialUncovered: ['2.8'],
      blockers: ['2.8:monitor_missing'],
    })
    expect(report.repairQueues.find(queue => queue.queueId === 'risk_controls')).toMatchObject({
      status: 'blocked',
      p0p1OpenOrPartialUncovered: ['3.3'],
      blockers: ['3.3:monitor_missing'],
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'p1_open_or_partial_defects_without_monitor:2',
      '2.8:entry_timing_quality_missing',
      '3.3:panic/regime_context_not_hard-gated',
    ]))
    expect(report.blockers).not.toContain('2.4:per_trade_cost_evidence_incomplete')
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-strategy-quality-coverage-'))
    const registryPath = join(root, 'strategy_defect_registry.latest.json')
    const monitorPath = join(root, 'strategy_defect_monitor.latest.json')
    const benchmarkPath = join(root, 'quant_framework_benchmark_report.latest.json')
    const outputPath = join(root, 'strategy_quality_gate_coverage.latest.json')
    await mkdir(root, { recursive: true })
    await writeJson(registryPath, {
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      defects: [
        defect('2.8', 'execution', 'Entry timing quality missing', 'P1', 'open', []),
      ],
    })
    await writeJson(monitorPath, {
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      findings: [],
    })
    await writeJson(benchmarkPath, {
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked',
    })

    const report = await runStrategyQualityGateCoverage({
      outputPath,
      strategyDefectRegistryPath: registryPath,
      strategyDefectMonitorPath: monitorPath,
      quantFrameworkBenchmarkPath: benchmarkPath,
      json: false,
    })

    expect(report.status).toBe('blocked')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      summary: {
        defects: 1,
        p0p1OpenOrPartialUncovered: 1,
      },
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'strategy_quality_gate_coverage',
      businessStatus: 'fail',
      recordsIn: 1,
      recordsOut: 1,
    })
  })
})

function defect(
  id: string,
  layer: string,
  title: string,
  priority: 'P0' | 'P1' | 'P2',
  status: 'open' | 'partial' | 'watch' | 'pass' | 'unknown',
  relatedMonitorFindingIds: string[],
) {
  return {
    id,
    layer,
    title,
    priority,
    status,
    relatedMonitorFindingIds,
    blockers: [`${title.toLowerCase().replaceAll(' ', '_')}`],
    benchmarkLessons: ['evidence reporting'],
    evidencePaths: [`/tmp/${id}.json`],
    monitorCoverage: {
      covered: relatedMonitorFindingIds.length > 0,
      matchingFindingIds: relatedMonitorFindingIds,
      matchingBlockers: [],
    },
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}
