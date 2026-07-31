import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildEthCarryDerivativesBackfillPlanReport,
  parseEthCarryDerivativesBackfillPlanArgs,
  runEthCarryDerivativesBackfillPlan,
} from './build_eth_carry_derivatives_backfill_plan.js'

describe('build_eth_carry_derivatives_backfill_plan', () => {
  it('parses defaults and keeps package scripts wired research-only', () => {
    expect(parseEthCarryDerivativesBackfillPlanArgs([
      '--warehouseRoot',
      '/tmp/warehouse',
      '--output',
      'none',
      '--endMonth',
      '2026-05',
      '--json',
      'true',
    ])).toMatchObject({
      dataGapPath: 'data/research/eth_carry_data_gap_status.latest.json',
      downloadMonitorPath: 'data/runtime/openalice_download_monitor.latest.json',
      dataCatalogPath: 'data/runtime/openalice_data_catalog.latest.json',
      warehouseRoot: '/tmp/warehouse',
      outputPath: null,
      startMonth: '2019-09',
      endMonth: '2026-05',
      symbols: ['BTCUSDT', 'ETHUSDT'],
      quote: 'USDT',
      proxy: 'none',
      networkInterface: 'en0',
      discovery: 'probe',
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:eth-carry:derivatives-backfill-plan']).toContain('build_eth_carry_derivatives_backfill_plan.ts')
    expect(scripts['status:research-evidence']).toContain('build_eth_carry_derivatives_backfill_plan.ts')
  })

  it('blocks when the data-gap artifact is unavailable', async () => {
    const warehouseRoot = await mkdtemp(join(tmpdir(), 'oa-eth-carry-backfill-missing-gap-'))
    const report = buildEthCarryDerivativesBackfillPlanReport({
      generatedAt: '2026-05-06T21:00:00.000Z',
      dataGapPath: '/repo/data/research/eth_carry_data_gap_status.latest.json',
      downloadMonitorPath: '/repo/data/runtime/openalice_download_monitor.latest.json',
      dataCatalogPath: '/repo/data/runtime/openalice_data_catalog.latest.json',
      warehouseRoot,
      dataGapExists: false,
      dataGap: null,
      downloadMonitor: null,
      dataCatalog: null,
      args: defaultArgs(),
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      startsDownload: false,
      status: 'blocked_no_data_gap',
      counts: {
        datasets: 4,
        commandsPlanned: 4,
      },
    })
    expect(report.blockers).toContain('eth_carry_data_gap_status_missing')
    expect(report.nextActions).toEqual([
      'Run research:eth-carry:data-gap-status first so backfill planning is tied to current data gaps.',
    ])
  })

  it('plans BTC/ETH core smoke backfills when derivative archives are missing', async () => {
    const warehouseRoot = await mkdtemp(join(tmpdir(), 'oa-eth-carry-backfill-ready-'))
    const report = buildEthCarryDerivativesBackfillPlanReport({
      generatedAt: '2026-05-06T21:00:00.000Z',
      dataGapPath: '/repo/data/research/eth_carry_data_gap_status.latest.json',
      downloadMonitorPath: '/repo/data/runtime/openalice_download_monitor.latest.json',
      dataCatalogPath: '/repo/data/runtime/openalice_data_catalog.latest.json',
      warehouseRoot,
      dataGapExists: true,
      dataGap: makeDataGap(),
      downloadMonitor: {
        status: 'watching',
        activeProcesses: [
          {
            id: 'um-all-usdt-aggTrades',
            path: '/Volumes/shield/cryptoData/openalice-data/market/binance-public/um-all-usdt-aggTrades',
            pid: 16808,
            command: 'scripts/run_fast_binance_data_vision_dataset.ts --market um --dataType aggTrades',
          },
        ],
      },
      dataCatalog: null,
      args: defaultArgs(),
    })

    expect(report.status).toBe('ready_core_smoke_backfill')
    expect(report.startsDownload).toBe(false)
    expect(report.counts).toMatchObject({
      datasets: 4,
      fullArchivesComplete: 0,
      coreArchivesComplete: 0,
      activeConflicts: 0,
      commandsPlanned: 4,
    })
    expect(report.entries).toHaveLength(4)
    expect(report.entries.every(entry => entry.recommendedPhase === 'core_smoke_backfill')).toBe(true)
    expect(report.entries.map(entry => entry.datasetId)).toEqual([
      'binance-public:um:fundingRate:usdt',
      'binance-public:um:markPriceKlines:1h:usdt',
      'binance-public:um:indexPriceKlines:1h:usdt',
      'binance-public:um:premiumIndexKlines:1h:usdt',
    ])
    expect(report.entries[0].coreSmokeCommand).toEqual(expect.arrayContaining([
      'scripts/run_fast_binance_data_vision_dataset.ts',
      '--dataType',
      'fundingRate',
      '--symbols',
      'BTCUSDT,ETHUSDT',
      '--proxy',
      'none',
      '--interface',
      'en0',
      '--discovery',
      'probe',
    ]))
    expect(report.entries[1].coreSmokeCommand).toEqual(expect.arrayContaining([
      '--dataType',
      'markPriceKlines',
      '--timeframe',
      '1h',
    ]))
    expect(report.entries[0].fullCatalogCommand).not.toContain('--symbols')
    expect(report.entries[0].coreArchive.path).toBe(resolve(warehouseRoot, 'market/binance-public/eth-carry-core-fundingRate'))
    expect(report.blockers).toEqual(expect.arrayContaining([
      'full_archive_not_complete:binance-public:um:fundingRate:usdt:missing',
      'core_archive_not_complete:binance-public:um:fundingRate:usdt:missing',
    ]))
    expect(report.safetyNotes.join(' ')).toContain('does not start a downloader')
  })

  it('reports full archives complete when all Data Vision derivative archives are complete', async () => {
    const warehouseRoot = await mkdtemp(join(tmpdir(), 'oa-eth-carry-backfill-complete-'))
    for (const directory of fullArchiveDirectories()) {
      await writeCompleteArchive(join(warehouseRoot, directory))
    }

    const report = buildEthCarryDerivativesBackfillPlanReport({
      generatedAt: '2026-05-06T21:00:00.000Z',
      dataGapPath: '/repo/data/research/eth_carry_data_gap_status.latest.json',
      downloadMonitorPath: '/repo/data/runtime/openalice_download_monitor.latest.json',
      dataCatalogPath: '/repo/data/runtime/openalice_data_catalog.latest.json',
      warehouseRoot,
      dataGapExists: true,
      dataGap: makeDataGap(),
      downloadMonitor: { status: 'complete', activeProcesses: [] },
      dataCatalog: null,
      args: defaultArgs(),
    })

    expect(report.status).toBe('full_archives_complete')
    expect(report.counts).toMatchObject({
      fullArchivesComplete: 4,
      fullArchivesMissingOrPartial: 0,
      commandsPlanned: 0,
    })
    expect(report.entries.every(entry => entry.recommendedPhase === 'skip_complete')).toBe(true)
    expect(report.blockers.filter(blocker => blocker.startsWith('full_archive_not_complete'))).toEqual([])
    expect(report.nextActions).toEqual([
      'Rebuild normalized derivatives events and ETH carry PIT features from the completed archives; keep promotion blocked until PIT/WFO/FDR/prospective/paper gates pass.',
    ])
  })

  it('waits only for active downloader conflicts on target derivative archive paths', async () => {
    const warehouseRoot = await mkdtemp(join(tmpdir(), 'oa-eth-carry-backfill-active-'))
    const fundingPath = join(warehouseRoot, 'market/binance-public/um-all-usdt-fundingRate')
    const report = buildEthCarryDerivativesBackfillPlanReport({
      generatedAt: '2026-05-06T21:00:00.000Z',
      dataGapPath: '/repo/data/research/eth_carry_data_gap_status.latest.json',
      downloadMonitorPath: '/repo/data/runtime/openalice_download_monitor.latest.json',
      dataCatalogPath: '/repo/data/runtime/openalice_data_catalog.latest.json',
      warehouseRoot,
      dataGapExists: true,
      dataGap: makeDataGap(),
      downloadMonitor: {
        status: 'watching',
        activeProcesses: [
          {
            id: 'um-all-usdt-fundingRate',
            path: fundingPath,
            pid: 12345,
            command: 'scripts/run_fast_binance_data_vision_dataset.ts --market um --dataType fundingRate',
          },
        ],
      },
      dataCatalog: null,
      args: defaultArgs(),
    })

    expect(report.status).toBe('waiting_active_downloads')
    expect(report.counts.activeConflicts).toBe(1)
    expect(report.entries[0]).toMatchObject({
      datasetId: 'binance-public:um:fundingRate:usdt',
      activeProcessPids: [12345],
      recommendedPhase: 'wait_active_download',
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'active_download_conflicts:1',
      'active_download_conflict:binance-public:um:fundingRate:usdt',
    ]))
    expect(report.nextActions).toEqual([
      'Wait for active downloader conflicts to clear, rerun data:monitor, then regenerate this plan before launching a new process.',
    ])
  })

  it('writes the plan artifact and manifest sidecar without starting downloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-backfill-run-'))
    const dataGapPath = join(root, 'data_gap.json')
    const monitorPath = join(root, 'monitor.json')
    const catalogPath = join(root, 'catalog.json')
    const outputPath = join(root, 'plan.json')
    await writeJson(dataGapPath, makeDataGap())
    await writeJson(monitorPath, { status: 'watching', activeProcesses: [] })
    await writeJson(catalogPath, { status: 'blocked', blockers: [] })

    const report = await runEthCarryDerivativesBackfillPlan({
      ...defaultArgs(),
      dataGapPath,
      downloadMonitorPath: monitorPath,
      dataCatalogPath: catalogPath,
      warehouseRoot: join(root, 'warehouse'),
      outputPath,
      json: false,
    })

    expect(report).toMatchObject({
      status: 'ready_core_smoke_backfill',
      startsDownload: false,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
    expect(report.outputHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      status: 'ready_core_smoke_backfill',
      startsDownload: false,
      outputHash: report.outputHash,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'eth_carry_derivatives_backfill_plan',
      businessStatus: 'warn',
      recordsIn: 4,
      recordsOut: 4,
    })
  })
})

function defaultArgs() {
  return {
    quote: 'USDT',
    symbols: ['BTCUSDT', 'ETHUSDT'],
    startMonth: '2019-09',
    endMonth: '2026-05',
    timeframe: '1h',
    listConcurrency: 8,
    concurrency: 4,
    retryConcurrency: 4,
    maxRetries: 3,
    retryMaxRetries: 3,
    connectTimeoutSec: 10,
    listMaxTimeSec: 30,
    downloadMaxTimeSec: 300,
    retryRounds: 1,
    proxy: 'none',
    networkInterface: 'en0',
    discovery: 'probe',
  }
}

function makeDataGap() {
  return {
    status: 'blocked_insufficient_research_data',
    counts: {
      carryFeatureRows: 14,
      prospectiveClosedOutcomes: 3,
      collectorErrorCount: 10,
    },
    thresholds: {
      minCarryFeatureRows: 100,
      minProspectiveClosedOutcomes: 100,
    },
    dataVisionArchives: [
      { datasetId: 'binance-public:um:fundingRate:usdt', status: 'missing' },
      { datasetId: 'binance-public:um:markPriceKlines:1h:usdt', status: 'missing' },
      { datasetId: 'binance-public:um:indexPriceKlines:1h:usdt', status: 'missing' },
      { datasetId: 'binance-public:um:premiumIndexKlines:1h:usdt', status: 'missing' },
    ],
  }
}

function fullArchiveDirectories(): string[] {
  return [
    'market/binance-public/um-all-usdt-fundingRate',
    'market/binance-public/um-all-usdt-markPriceKlines-1h',
    'market/binance-public/um-all-usdt-indexPriceKlines-1h',
    'market/binance-public/um-all-usdt-premiumIndexKlines-1h',
  ]
}

async function writeCompleteArchive(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'sample.zip'), 'zip', 'utf-8')
  await writeFile(join(path, 'summary.fast-binance-download.json'), `${JSON.stringify({ coverage: 'complete' }, null, 2)}\n`, 'utf-8')
  await writeFile(join(path, 'manifest.fast-binance-download.jsonl'), '{}\n', 'utf-8')
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}
