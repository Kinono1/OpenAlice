import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildQuantFrameworkBenchmarkReport,
  parseQuantFrameworkBenchmarkArgs,
  runQuantFrameworkBenchmark,
} from './build_quant_framework_benchmark_report.js'

describe('build_quant_framework_benchmark_report', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parseQuantFrameworkBenchmarkArgs([
      '--output',
      'null',
      '--strategyDefectRegistryPath',
      '/tmp/registry.json',
      '--dataCatalogPath',
      '/tmp/catalog.json',
      '--reasonChainPath',
      '/tmp/reason.json',
      '--json',
    ])).toEqual({
      outputPath: null,
      strategyDefectRegistryPath: '/tmp/registry.json',
      dataCatalogPath: '/tmp/catalog.json',
      reasonChainPath: '/tmp/reason.json',
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:quant-framework:benchmark']).toContain('build_quant_framework_benchmark_report.ts')
    expect(scripts['status:research-evidence']).toContain('build_quant_framework_benchmark_report.ts')
  })

  it('maps framework lessons to OpenAlice defects without authorizing execution', () => {
    const report = buildQuantFrameworkBenchmarkReport({
      generatedAt: '2026-05-06T06:30:00.000Z',
      sourceArtifacts: {
        strategyDefectRegistry: '/tmp/strategy_defect_registry.latest.json',
        dataCatalog: '/tmp/openalice_data_catalog.latest.json',
        reasonChain: '/tmp/system_status_reason_chain.latest.json',
      },
      strategyDefectRegistry: {
        defects: [
          defect('2.4', 'execution', 'Per-trade cost evidence incomplete', 'P0', 'partial', ['evidence reporting', 'connector abstraction']),
          defect('2.5', 'execution', 'Slippage estimate missing', 'P0', 'open', ['order book matching']),
          defect('3.5', 'risk', 'Single trade max loss missing', 'P0', 'open', ['protections', 'risk management']),
          defect('7.2', 'portfolio', 'Total exposure cap missing', 'P0', 'open', ['portfolio/risk management']),
          defect('6.4', 'strategy_learning', 'Parameter stability check missing', 'P1', 'open', ['fast parameter sweep', 'research workflow']),
        ],
      },
      dataCatalog: {
        status: 'blocked',
      },
      reasonChain: {
        effectiveActionability: 'research_only_blocked',
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        canPromote: false,
      },
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-06T06:30:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'blocked',
      summary: {
        frameworks: 6,
        capabilities: 10,
        blockedCapabilities: expect.any(Number),
        dataCatalogStatus: 'blocked',
        reasonChainActionability: 'research_only_blocked',
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        canPromote: false,
      },
    })
    expect(report.frameworkSources.map(item => item.frameworkId)).toEqual([
      'quantconnect_lean',
      'nautilus_trader',
      'freqtrade',
      'vectorbt',
      'qlib',
      'hummingbot',
    ])
    expect(report.capabilities.find(item => item.capabilityId === 'order_book_matching')).toMatchObject({
      status: 'blocked',
      modelFrameworks: ['nautilus_trader', 'hummingbot'],
      currentEvidence: {
        openOrPartialDefectIds: expect.arrayContaining(['2.5']),
      },
      blockers: expect.arrayContaining([
        'related_defect_open_or_partial:2.5',
        'global_actionability_research_only_blocked',
      ]),
    })
    expect(report.capabilities.find(item => item.capabilityId === 'portfolio_risk_management')).toMatchObject({
      status: 'blocked',
      currentEvidence: {
        openOrPartialDefectIds: expect.arrayContaining(['7.2']),
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'order_book_matching:related_defect_open_or_partial:2.5',
      'portfolio_risk_management:related_defect_open_or_partial:7.2',
    ]))
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-quant-benchmark-'))
    const registryPath = join(root, 'strategy_defect_registry.latest.json')
    const catalogPath = join(root, 'openalice_data_catalog.latest.json')
    const reasonPath = join(root, 'system_status_reason_chain.latest.json')
    const outputPath = join(root, 'quant_framework_benchmark_report.latest.json')
    await mkdir(root, { recursive: true })
    await writeFile(registryPath, JSON.stringify({
      defects: [
        defect('2.4', 'execution', 'Per-trade cost evidence incomplete', 'P0', 'partial', ['evidence reporting']),
      ],
    }), 'utf-8')
    await writeFile(catalogPath, JSON.stringify({ status: 'blocked' }), 'utf-8')
    await writeFile(reasonPath, JSON.stringify({
      effectiveActionability: 'research_only_blocked',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      canPromote: false,
    }), 'utf-8')

    const report = await runQuantFrameworkBenchmark({
      outputPath,
      strategyDefectRegistryPath: registryPath,
      dataCatalogPath: catalogPath,
      reasonChainPath: reasonPath,
      json: false,
    })

    expect(report.status).toBe('blocked')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'quant_framework_benchmark_report',
      businessStatus: 'fail',
      recordsIn: 6,
      recordsOut: 10,
    })
  })
})

function defect(
  id: string,
  layer: string,
  title: string,
  priority: 'P0' | 'P1' | 'P2',
  status: 'open' | 'partial' | 'watch' | 'pass' | 'unknown',
  benchmarkLessons: string[],
) {
  return {
    id,
    layer,
    title,
    priority,
    status,
    benchmarkLessons,
  }
}
