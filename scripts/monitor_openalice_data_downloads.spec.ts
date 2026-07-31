import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseMacosSystemProxyOutput,
  parseMonitorArgs,
  readDownloadDirectRoutingSnapshot,
  runOpenAliceDownloadMonitor,
} from './monitor_openalice_data_downloads.js'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'openalice-download-monitor-'))
}

describe('monitor_openalice_data_downloads', () => {
  it('parses cli args', () => {
    const parsed = parseMonitorArgs(['--warehouseRoot', '/warehouse', '--repoDataRoot', '/repo/data', '--output', 'null', '--json'])
    expect(parsed).toMatchObject({
      warehouseRoot: '/warehouse',
      repoDataRoot: '/repo/data',
      runtimeDir: join(process.cwd(), 'data/runtime'),
      dataCatalogPath: join(process.cwd(), 'data/runtime/openalice_data_catalog.latest.json'),
      outputPath: null,
      json: true,
      checkMacosSystemProxy: false,
      checkDownloadDirectRouting: false,
      monitorOfflineBackfills: false,
    })
    expect(parsed.downloadDirectRoutingConfigPaths[0]).toBe(
      join(process.env.HOME ?? '', 'Library/Application Support/mihomo-party/work/config.yaml'),
    )
    expect(parsed.downloadDirectRoutingConfigPaths.slice(1)).toEqual(
      expect.arrayContaining(parsed.downloadDirectRoutingConfigPaths.slice(1).map(path =>
        expect.stringMatching(/Library\/Application Support\/mihomo-party\/rules\/[^/]+\.yaml$/),
      )),
    )
  })

  it('uses OPENALICE_DATA_ROOT for the default runtime warehouse', () => {
    const previous = process.env.OPENALICE_DATA_ROOT
    process.env.OPENALICE_DATA_ROOT = '/local/openalice-data'
    try {
      expect(parseMonitorArgs([]).warehouseRoot).toBe('/local/openalice-data')
    } finally {
      if (previous == null) delete process.env.OPENALICE_DATA_ROOT
      else process.env.OPENALICE_DATA_ROOT = previous
    }
  })

  it('parses macOS system proxy state for routing blockers', () => {
    expect(parseMacosSystemProxyOutput([
      '<dictionary> {',
      '  HTTPEnable : 1',
      '  HTTPProxy : 127.0.0.1',
      '  HTTPPort : 7890',
      '  HTTPSEnable : 1',
      '  HTTPSProxy : 127.0.0.1',
      '  HTTPSPort : 7890',
      '  SOCKSEnable : 1',
      '  SOCKSProxy : 127.0.0.1',
      '  SOCKSPort : 7890',
      '}',
    ].join('\n'))).toMatchObject({
      checked: true,
      enabled: true,
      httpProxy: '127.0.0.1',
      httpPort: 7890,
      httpsProxy: '127.0.0.1',
      httpsPort: 7890,
      socksProxy: '127.0.0.1',
      socksPort: 7890,
      error: null,
    })
  })

  it('reports tracked dataset and audit state', async () => {
    const root = await tempRoot()
    const warehouseRoot = join(root, 'warehouse')
    const repoDataRoot = join(root, 'repo-data')
    const runtimeDir = join(repoDataRoot, 'runtime')
    const trackedSpot = join(warehouseRoot, 'market/binance-public/spot-all-usdt-klines-30m')
    const trackedUm = join(warehouseRoot, 'market/binance-public/um-all-usdt-klines-30m')
    const trackedSpot1h = join(warehouseRoot, 'market/binance-public/spot-all-usdt-klines-1h')
    const trackedUm1h = join(warehouseRoot, 'market/binance-public/um-all-usdt-klines-1h')
    const onchainRaw = join(warehouseRoot, 'onchain/coinmetrics')
    const onchainNormalized = join(warehouseRoot, 'normalized/onchain/coinmetrics')
    await mkdir(runtimeDir, { recursive: true })
    await mkdir(trackedSpot, { recursive: true })
    await mkdir(trackedUm, { recursive: true })
    await mkdir(trackedSpot1h, { recursive: true })
    await mkdir(trackedUm1h, { recursive: true })
    await mkdir(onchainRaw, { recursive: true })
    await mkdir(onchainNormalized, { recursive: true })
    await writeFile(join(runtimeDir, 'openalice_coinmetrics_onchain_collect.latest.json'), JSON.stringify({
      status: 'complete',
      blockers: [],
    }, null, 2), 'utf-8')
    await writeFile(join(runtimeDir, 'openalice_coinmetrics_onchain_normalize.latest.json'), JSON.stringify({
      status: 'complete',
      blockers: [],
    }, null, 2), 'utf-8')
    await writeFile(join(runtimeDir, 'openalice_coinmetrics_onchain_audit.latest.json'), JSON.stringify({
      status: 'complete',
      blockers: [],
    }, null, 2), 'utf-8')
    await writeFile(join(runtimeDir, 'okx_public_connectivity_diagnosis.latest.json'), JSON.stringify({
      status: 'blocked',
      publicDataFetchable: false,
      attempts: [
        { hostname: 'www.okx.com', ok: false, errorClass: 'tls' },
        { hostname: 'aws.okx.com', ok: false, errorClass: 'tls' },
      ],
    }, null, 2), 'utf-8')
    await writeFile(join(runtimeDir, 'binance_public_download_audit.latest.json'), JSON.stringify({
      totals: {
        completeDatasets: 1,
        incompleteDatasets: 1,
        zipFiles: 10,
        partFiles: 1,
        verifiedZipFiles: 9,
      },
    }, null, 2), 'utf-8')
    await writeFile(join(runtimeDir, 'openalice_data_catalog.latest.json'), JSON.stringify({
      status: 'blocked',
      summary: {
        datasets: 99,
        complete: 43,
        partial: 6,
        missing: 49,
        inProgress: 1,
      },
      blockerActionability: {
        totalBlockers: 82,
        primaryCategory: 'download_gap',
        categories: [
          {
            category: 'download_gap',
            count: 51,
            sampleBlockers: [
              'binance_dataset_in_progress:um-all-usdt-aggTrades',
              'binance_dataset_missing:um-all-usdt-fundingRate',
            ],
            nextAction: 'Continue managed Data Vision backfill.',
          },
          { category: 'pit_or_normalized_gap', count: 8 },
          { category: 'ai_scientist_validation_gate', count: 15 },
        ],
      },
    }, null, 2), 'utf-8')
    await writeFile(join(trackedSpot, 'summary.fast-binance-download.json'), JSON.stringify({ coverage: 'complete' }, null, 2), 'utf-8')
    await writeFile(join(trackedSpot, 'x.zip'), 'zip', 'utf-8')
    await writeFile(join(trackedSpot1h, 'summary.fast-binance-download.json'), JSON.stringify({ coverage: 'complete' }, null, 2), 'utf-8')
    await writeFile(join(trackedSpot1h, 'x.zip'), 'zip', 'utf-8')
    await writeFile(join(trackedUm1h, 'summary.fast-binance-download.json'), JSON.stringify({ coverage: 'complete' }, null, 2), 'utf-8')
    await writeFile(join(trackedUm1h, 'x.zip'), 'zip', 'utf-8')
    await writeFile(join(onchainRaw, 'raw.jsonl'), '{}\n', 'utf-8')
    await writeFile(join(onchainNormalized, 'normalized.jsonl'), '{}\n', 'utf-8')

    const report = await runOpenAliceDownloadMonitor({
      warehouseRoot,
      repoDataRoot,
      runtimeDir,
      outputPath: join(runtimeDir, 'openalice_download_monitor.latest.json'),
      json: true,
      checkMacosSystemProxy: false,
      checkDownloadDirectRouting: false,
      monitorOfflineBackfills: true,
      proxyEnv: {},
      processListOutput: '',
    })

    expect(report.status).toBe('watching')
    expect(report.totals.trackedDatasets).toBe(2)
    expect(report.binanceAudit.completeDatasets).toBe(1)
    expect(report.dataCatalog).toMatchObject({
      status: 'blocked',
      datasets: 99,
      complete: 43,
      completePct: 43,
      primaryBlockerCategory: 'download_gap',
      downloadGapBlockers: 51,
      pitOrNormalizedGapBlockers: 8,
      aiScientistValidationGateBlockers: 15,
      sampleDownloadGapBlockers: [
        'binance_dataset_in_progress:um-all-usdt-aggTrades',
        'binance_dataset_missing:um-all-usdt-fundingRate',
      ],
      nextDownloadGapAction: 'Continue managed Data Vision backfill.',
    })
    expect(report.coinmetricsRuntime.collect.status).toBe('complete')
    expect(report.okxPublicConnectivity.publicDataFetchable).toBe(false)
    expect(report.okxPublicConnectivity.failedErrorClasses).toEqual(['tls'])
    expect(report.datasets.find(dataset => dataset.datasetId === 'coinmetrics-community:onchain:raw')).toMatchObject({
      complete: true,
      reportStatus: 'complete',
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'openalice_data_catalog_status:blocked',
      'openalice_data_catalog_download_gap:51',
      'openalice_data_catalog_pit_or_normalized_gap:8',
      'okx_public_connectivity_status:blocked',
    ]))
  })

  it('distinguishes paused part files from an active Binance downloader', async () => {
    const root = await tempRoot()
    const warehouseRoot = join(root, 'warehouse')
    const repoDataRoot = join(root, 'repo-data')
    const runtimeDir = join(repoDataRoot, 'runtime')
    const aggTrades = join(warehouseRoot, 'market/binance-public/spot-all-usdt-aggTrades')
    await mkdir(runtimeDir, { recursive: true })
    await mkdir(aggTrades, { recursive: true })
    await writeFile(join(aggTrades, 'x.zip'), 'zip', 'utf-8')
    await writeFile(join(aggTrades, 'x.zip.part'), 'partial', 'utf-8')
    await writeFile(join(runtimeDir, 'binance_public_download_audit.latest.json'), JSON.stringify({
      totals: {
        completeDatasets: 30,
        incompleteDatasets: 51,
        zipFiles: 629871,
        partFiles: 56,
        verifiedZipFiles: 621219,
      },
      audits: [
        {
          id: 'spot-all-usdt-aggTrades',
          path: aggTrades,
          zipFiles: 1,
          partFiles: 1,
          complete: false,
          status: 'in_progress',
          reason: 'part files are present',
        },
      ],
    }, null, 2), 'utf-8')

    const report = await runOpenAliceDownloadMonitor({
      warehouseRoot,
      repoDataRoot,
      runtimeDir,
      outputPath: null,
      json: true,
      checkMacosSystemProxy: false,
      checkDownloadDirectRouting: false,
      monitorOfflineBackfills: true,
      proxyEnv: {},
      processListOutput: '',
    })

    const dataset = report.datasets.find(item => item.datasetId === 'binance-public:spot-all-usdt-aggTrades')
    expect(report.activeProcesses).toEqual([])
    expect(dataset).toMatchObject({
      reportStatus: 'paused_part_files',
      activeProcessPids: [],
      complete: false,
    })
    expect(dataset?.reportBlockers[0]).toContain('no active downloader process found')
    expect(report.nextActions).toEqual([
      'Clear stale .part files or resume the paused Binance dataset only after network/proxy routing has been verified.',
    ])
  })

  it('surfaces macOS system proxy as a monitor blocker when enabled', async () => {
    const root = await tempRoot()
    const warehouseRoot = join(root, 'warehouse')
    const repoDataRoot = join(root, 'repo-data')
    const runtimeDir = join(repoDataRoot, 'runtime')
    await mkdir(runtimeDir, { recursive: true })
    await writeFile(join(runtimeDir, 'binance_public_download_audit.latest.json'), JSON.stringify({
      totals: {
        completeDatasets: 81,
        incompleteDatasets: 0,
        zipFiles: 1,
        partFiles: 0,
        verifiedZipFiles: 1,
      },
      audits: [],
    }, null, 2), 'utf-8')

    const report = await runOpenAliceDownloadMonitor({
      warehouseRoot,
      repoDataRoot,
      runtimeDir,
      outputPath: null,
      json: true,
      checkMacosSystemProxy: true,
      checkDownloadDirectRouting: false,
      monitorOfflineBackfills: true,
      processListOutput: '',
      macosSystemProxyOutput: [
        '<dictionary> {',
        '  HTTPEnable : 1',
        '  HTTPProxy : 127.0.0.1',
        '  HTTPPort : 7890',
        '}',
      ].join('\n'),
      proxyEnv: {},
    })

    expect(report.macosSystemProxy).toMatchObject({
      checked: true,
      enabled: true,
      httpProxy: '127.0.0.1',
      httpPort: 7890,
    })
    expect(report.blockers).toContain('macos_system_proxy_enabled')
    expect(report.nextActions).toEqual([
      'Disable the macOS system proxy/VPN proxy before resuming Binance downloads, then rerun this monitor.',
    ])
  })

  it('surfaces proxy environment variables as a monitor blocker', async () => {
    const root = await tempRoot()
    const warehouseRoot = join(root, 'warehouse')
    const repoDataRoot = join(root, 'repo-data')
    const runtimeDir = join(repoDataRoot, 'runtime')
    await mkdir(runtimeDir, { recursive: true })
    await writeFile(join(runtimeDir, 'binance_public_download_audit.latest.json'), JSON.stringify({
      totals: {
        completeDatasets: 81,
        incompleteDatasets: 0,
        zipFiles: 1,
        partFiles: 0,
        verifiedZipFiles: 1,
      },
      audits: [],
    }, null, 2), 'utf-8')

    const report = await runOpenAliceDownloadMonitor({
      warehouseRoot,
      repoDataRoot,
      runtimeDir,
      outputPath: null,
      json: true,
      checkMacosSystemProxy: false,
      checkDownloadDirectRouting: false,
      monitorOfflineBackfills: true,
      proxyEnv: {
        HTTPS_PROXY: 'http://127.0.0.1:7890',
        NO_PROXY: 'localhost,127.0.0.1',
      },
      processListOutput: '',
    })

    expect(report.proxyEnvironment).toMatchObject({
      checked: true,
      enabled: true,
      variables: {
        HTTPS_PROXY: 'http://127.0.0.1:7890',
        NO_PROXY: 'localhost,127.0.0.1',
      },
    })
    expect(report.blockers).toContain('proxy_environment_variables_present')
    expect(report.nextActions).toEqual([
      'Clear HTTP_PROXY/HTTPS_PROXY/ALL_PROXY and lowercase proxy variables before resuming Binance downloads, then rerun this monitor.',
    ])
  })

  it('surfaces external derivatives collector errors without leaking credential diagnostics', async () => {
    const root = await tempRoot()
    const warehouseRoot = join(root, 'warehouse')
    const repoDataRoot = join(root, 'repo-data')
    const runtimeDir = join(repoDataRoot, 'runtime')
    await mkdir(runtimeDir, { recursive: true })
    await writeFile(join(runtimeDir, 'binance_public_download_audit.latest.json'), JSON.stringify({
      totals: {
        completeDatasets: 81,
        incompleteDatasets: 0,
        zipFiles: 1,
        partFiles: 0,
        verifiedZipFiles: 1,
      },
      audits: [],
    }, null, 2), 'utf-8')
    await writeFile(join(runtimeDir, 'external_derivatives_data_collect.latest.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      dryRun: false,
      proxyConfigured: true,
      proxySource: 'env:HTTPS_PROXY',
      fetchedRows: 0,
      appendedRows: 0,
      skippedDuplicateRows: 0,
      errorSummary: { timeout: 7, tls: 3 },
      errors: [
        {
          symbol: 'BTCUSDT',
          endpoint: 'premiumIndex',
          errorClass: 'timeout',
          error: 'fetch failed for https://example.test/path?apiKey=abc123&signature=deadbeef',
        },
      ],
    }, null, 2), 'utf-8')

    const report = await runOpenAliceDownloadMonitor({
      warehouseRoot,
      repoDataRoot,
      runtimeDir,
      outputPath: null,
      json: true,
      checkMacosSystemProxy: false,
      checkDownloadDirectRouting: false,
      proxyEnv: {},
      processListOutput: '',
    })

    expect(report.externalDerivativesCollect).toMatchObject({
      exists: true,
      dryRun: false,
      proxyConfigured: true,
      proxySource: 'env:HTTPS_PROXY',
      fetchedRows: 0,
      appendedRows: 0,
      errorCount: 1,
      errorSummary: { timeout: 7, tls: 3 },
      stale: false,
    })
    expect(report.externalDerivativesCollect.latestErrors[0]?.error).toContain('apiKey=***')
    expect(report.externalDerivativesCollect.latestErrors[0]?.error).toContain('signature=***')
    expect(report.externalDerivativesCollect.latestErrors[0]?.error).not.toContain('abc123')
    expect(report.externalDerivativesCollect.latestErrors[0]?.error).not.toContain('deadbeef')
    expect(report.blockers).toContain('external_derivatives_collect_errors:timeout:7,tls:3')
    expect(report.nextActions).toEqual([
      'Diagnose the OKX public derivatives collector with one-symbol dry-run probes; keep funding/carry evidence research-only until collection errors clear.',
    ])
  })

  it('surfaces stale external derivatives collector reports', async () => {
    const root = await tempRoot()
    const warehouseRoot = join(root, 'warehouse')
    const repoDataRoot = join(root, 'repo-data')
    const runtimeDir = join(repoDataRoot, 'runtime')
    await mkdir(runtimeDir, { recursive: true })
    await writeFile(join(runtimeDir, 'binance_public_download_audit.latest.json'), JSON.stringify({
      totals: {
        completeDatasets: 81,
        incompleteDatasets: 0,
        zipFiles: 1,
        partFiles: 0,
        verifiedZipFiles: 1,
      },
      audits: [],
    }, null, 2), 'utf-8')
    await writeFile(join(runtimeDir, 'external_derivatives_data_collect.latest.json'), JSON.stringify({
      generatedAt: new Date(Date.now() - 11 * 60 * 60 * 1000).toISOString(),
      dryRun: false,
      proxyConfigured: false,
      fetchedRows: 4,
      appendedRows: 1,
      errorSummary: {},
      errors: [],
    }, null, 2), 'utf-8')

    const report = await runOpenAliceDownloadMonitor({
      warehouseRoot,
      repoDataRoot,
      runtimeDir,
      outputPath: null,
      json: true,
      checkMacosSystemProxy: false,
      checkDownloadDirectRouting: false,
      proxyEnv: {},
      processListOutput: '',
    })

    expect(report.externalDerivativesCollect.stale).toBe(true)
    expect(report.blockers).toContain('external_derivatives_collect_stale')
    expect(report.nextActions).toEqual([
      'Rerun external derivatives collection in research-only mode; keep funding/carry promotion blocked until the collector report is fresh.',
    ])
  })

  it('recognizes Mihomo direct routing for OpenAlice download domains', async () => {
    const root = await tempRoot()
    const configPath = join(root, 'config.yaml')
    await writeFile(configPath, [
      'proxy-groups:',
      '  - name: 🎯 本地直连',
      '    type: select',
      '    proxies:',
      '      - DIRECT',
      'rules:',
      '  - DOMAIN,data.binance.vision,🎯 本地直连',
      '  - DOMAIN,s3-ap-northeast-1.amazonaws.com,🎯 本地直连',
      '  - DOMAIN,s3.ap-northeast-1.amazonaws.com,🎯 本地直连',
      '  - DOMAIN,s3.dualstack.ap-northeast-1.amazonaws.com,🎯 本地直连',
      '  - DOMAIN,community-api.coinmetrics.io,🎯 本地直连',
      '  - DOMAIN,fapi.binance.com,🎯 本地直连',
      '  - DOMAIN-SUFFIX,openai.com,openAI',
      '',
    ].join('\n'), 'utf-8')

    const snapshot = readDownloadDirectRoutingSnapshot([configPath])

    expect(snapshot.complete).toBe(true)
    expect(snapshot.missingDomains).toEqual([])
    expect(snapshot.configs[0]?.matchedDomains['data.binance.vision']).toMatchObject({
      target: '🎯 本地直连',
      ruleIndex: 0,
    })
  })

  it('does not block on proxy state when download domains are verified direct', async () => {
    const root = await tempRoot()
    const warehouseRoot = join(root, 'warehouse')
    const repoDataRoot = join(root, 'repo-data')
    const runtimeDir = join(repoDataRoot, 'runtime')
    const configPath = join(root, 'config.yaml')
    await mkdir(runtimeDir, { recursive: true })
    await writeFile(join(runtimeDir, 'binance_public_download_audit.latest.json'), JSON.stringify({
      totals: {
        completeDatasets: 81,
        incompleteDatasets: 0,
        zipFiles: 1,
        partFiles: 0,
        verifiedZipFiles: 1,
      },
      audits: [],
    }, null, 2), 'utf-8')
    await writeFile(configPath, [
      'proxy-groups:',
      '  - name: 🎯 本地直连',
      '    type: select',
      '    proxies:',
      '      - DIRECT',
      'rules:',
      '  - DOMAIN,data.binance.vision,🎯 本地直连',
      '  - DOMAIN,s3-ap-northeast-1.amazonaws.com,🎯 本地直连',
      '  - DOMAIN,s3.ap-northeast-1.amazonaws.com,🎯 本地直连',
      '  - DOMAIN,s3.dualstack.ap-northeast-1.amazonaws.com,🎯 本地直连',
      '  - DOMAIN,community-api.coinmetrics.io,🎯 本地直连',
      '  - DOMAIN,fapi.binance.com,🎯 本地直连',
      '',
    ].join('\n'), 'utf-8')

    const report = await runOpenAliceDownloadMonitor({
      warehouseRoot,
      repoDataRoot,
      runtimeDir,
      outputPath: null,
      json: true,
      checkMacosSystemProxy: true,
      checkDownloadDirectRouting: true,
      monitorOfflineBackfills: true,
      downloadDirectRoutingConfigPaths: [configPath],
      processListOutput: '',
      macosSystemProxyOutput: [
        '<dictionary> {',
        '  HTTPEnable : 1',
        '  HTTPProxy : 127.0.0.1',
        '  HTTPPort : 7890',
        '}',
      ].join('\n'),
      proxyEnv: {
        HTTPS_PROXY: 'http://127.0.0.1:7890',
      },
    })

    expect(report.downloadDirectRouting.complete).toBe(true)
    expect(report.blockers).not.toContain('macos_system_proxy_enabled')
    expect(report.blockers).not.toContain('proxy_environment_variables_present')
  })

  it('detects active low-level Binance downloader processes without leaking environment variables', async () => {
    const root = await tempRoot()
    const warehouseRoot = join(root, 'warehouse')
    const repoDataRoot = join(root, 'repo-data')
    const runtimeDir = join(repoDataRoot, 'runtime')
    const aggTrades = join(warehouseRoot, 'market/binance-public/spot-all-usdt-aggTrades')
    await mkdir(runtimeDir, { recursive: true })
    await mkdir(aggTrades, { recursive: true })
    await writeFile(join(aggTrades, 'x.zip'), 'zip', 'utf-8')
    await writeFile(join(aggTrades, 'x.zip.part'), 'partial', 'utf-8')
    await writeFile(join(runtimeDir, 'binance_public_download_audit.latest.json'), JSON.stringify({
      totals: {
        completeDatasets: 30,
        incompleteDatasets: 51,
        zipFiles: 629871,
        partFiles: 56,
        verifiedZipFiles: 621219,
      },
      audits: [
        {
          id: 'spot-all-usdt-aggTrades',
          path: aggTrades,
          zipFiles: 1,
          partFiles: 1,
          complete: false,
          status: 'in_progress',
          reason: 'part files are present',
        },
      ],
    }, null, 2), 'utf-8')

    const report = await runOpenAliceDownloadMonitor({
      warehouseRoot,
      repoDataRoot,
      runtimeDir,
      outputPath: null,
      json: true,
      checkMacosSystemProxy: false,
      checkDownloadDirectRouting: false,
      monitorOfflineBackfills: true,
      proxyEnv: {},
      processListOutput: [
        `123 npm exec tsx scripts/fast_binance_data_vision_backfill.ts --outDir ${aggTrades} DEEPSEEK_API_KEY=sk-secret`,
        `124 zsh -c npx tsx scripts/fast_binance_data_vision_backfill.ts --outDir ${aggTrades}`,
      ].join('\n'),
    })

    expect(report.activeProcesses).toHaveLength(1)
    expect(report.activeProcesses[0]).toMatchObject({
      id: 'spot-all-usdt-aggTrades',
      path: aggTrades,
      pid: 123,
    })
    expect(report.activeProcesses[0]?.command).not.toContain('sk-secret')
    expect(report.activeProcesses[0]?.command).not.toContain('DEEPSEEK_API_KEY')
    expect(report.datasets.find(item => item.datasetId === 'binance-public:spot-all-usdt-aggTrades')).toMatchObject({
      reportStatus: 'in_progress',
      activeProcessPids: [123],
    })
  })

  it('flags duplicate active downloaders for the same Binance dataset', async () => {
    const root = await tempRoot()
    const warehouseRoot = join(root, 'warehouse')
    const repoDataRoot = join(root, 'repo-data')
    const runtimeDir = join(repoDataRoot, 'runtime')
    const aggTrades = join(warehouseRoot, 'market/binance-public/spot-all-usdt-aggTrades')
    await mkdir(runtimeDir, { recursive: true })
    await mkdir(aggTrades, { recursive: true })
    await writeFile(join(runtimeDir, 'binance_public_download_audit.latest.json'), JSON.stringify({
      totals: {
        completeDatasets: 30,
        incompleteDatasets: 51,
        zipFiles: 629871,
        partFiles: 0,
        verifiedZipFiles: 621219,
      },
      audits: [
        {
          id: 'spot-all-usdt-aggTrades',
          path: aggTrades,
          zipFiles: 1,
          partFiles: 0,
          complete: false,
          status: 'in_progress',
          reason: 'process active',
        },
      ],
    }, null, 2), 'utf-8')

    const report = await runOpenAliceDownloadMonitor({
      warehouseRoot,
      repoDataRoot,
      runtimeDir,
      outputPath: null,
      json: true,
      checkMacosSystemProxy: false,
      checkDownloadDirectRouting: false,
      monitorOfflineBackfills: true,
      proxyEnv: {},
      processListOutput: [
        `123 npm exec tsx scripts/fast_binance_data_vision_backfill.ts --outDir ${aggTrades}`,
        `125 npm exec tsx scripts/run_fast_binance_data_vision_dataset.ts --outDir ${aggTrades}`,
      ].join('\n'),
    })

    expect(report.activeProcesses.map(process => process.pid)).toEqual([123, 125])
    expect(report.duplicateActiveDownloaders).toEqual([
      expect.objectContaining({
        datasetId: 'binance-public:spot-all-usdt-aggTrades',
        path: aggTrades,
        activeProcessCount: 2,
        keepPid: 123,
        suggestedStopPids: [125],
        manualStopCommand: 'kill -TERM 125',
        manualOnly: true,
      }),
    ])
    expect(report.datasets.find(item => item.datasetId === 'binance-public:spot-all-usdt-aggTrades')).toMatchObject({
      activeProcessPids: [123, 125],
    })
    expect(report.blockers).toContain('duplicate_active_downloader_processes:binance-public:spot-all-usdt-aggTrades:2')
    expect(report.nextActions).toEqual([
      'Collapse each Binance Data Vision dataset to a single active downloader, then rerun this monitor before launching more downloads.',
    ])
  })

  it('keeps retired Binance backfills and proxy state out of the default runtime blockers', async () => {
    const root = await tempRoot()
    const warehouseRoot = join(root, 'data')
    const runtimeDir = join(warehouseRoot, 'runtime')
    const onchainRaw = join(warehouseRoot, 'onchain/coinmetrics')
    const onchainNormalized = join(warehouseRoot, 'normalized/onchain/coinmetrics')
    const retiredBinancePath = join(warehouseRoot, 'offline/binance/spot-all-usdt-aggTrades')
    await mkdir(runtimeDir, { recursive: true })
    await mkdir(onchainRaw, { recursive: true })
    await mkdir(onchainNormalized, { recursive: true })
    await writeFile(join(onchainRaw, 'asset_metrics_1d.jsonl'), '{}\n', 'utf-8')
    await writeFile(join(onchainNormalized, 'asset_metrics_1d.normalized.jsonl'), '{}\n', 'utf-8')
    for (const reportName of [
      'openalice_coinmetrics_onchain_collect.latest.json',
      'openalice_coinmetrics_onchain_normalize.latest.json',
      'openalice_coinmetrics_onchain_audit.latest.json',
    ]) {
      await writeFile(join(runtimeDir, reportName), JSON.stringify({ status: 'complete', blockers: [] }, null, 2), 'utf-8')
    }
    await writeFile(join(runtimeDir, 'binance_public_download_audit.latest.json'), JSON.stringify({
      totals: {
        completeDatasets: 30,
        incompleteDatasets: 51,
        zipFiles: 10,
        partFiles: 1,
        verifiedZipFiles: 9,
      },
      audits: [{
        id: 'spot-all-usdt-aggTrades',
        path: retiredBinancePath,
        zipFiles: 1,
        partFiles: 1,
        complete: false,
        status: 'in_progress',
        reason: 'historical offline backfill',
      }],
    }, null, 2), 'utf-8')
    await writeFile(join(runtimeDir, 'openalice_data_catalog.latest.json'), JSON.stringify({
      status: 'blocked',
      summary: { datasets: 83, complete: 2, partial: 0, missing: 81, inProgress: 0 },
      blockerActionability: {
        totalBlockers: 81,
        primaryCategory: 'download_gap',
        categories: [{ category: 'download_gap', count: 81 }],
      },
    }, null, 2), 'utf-8')

    const report = await runOpenAliceDownloadMonitor({
      warehouseRoot,
      repoDataRoot: warehouseRoot,
      runtimeDir,
      outputPath: null,
      json: true,
      checkMacosSystemProxy: true,
      checkDownloadDirectRouting: true,
      monitorOfflineBackfills: false,
      macosSystemProxyOutput: '<dictionary> {\nHTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7890\n}',
      proxyEnv: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
      processListOutput: `123 npm exec tsx scripts/fast_binance_data_vision_backfill.ts --outDir ${retiredBinancePath}`,
    })

    expect(report.status).toBe('complete')
    expect(report.datasets.map(dataset => dataset.datasetId)).toEqual([
      'coinmetrics-community:onchain:raw',
      'coinmetrics-community:onchain:normalized',
    ])
    expect(report.activeProcesses).toEqual([])
    expect(report.macosSystemProxy.checked).toBe(false)
    expect(report.downloadDirectRouting.checked).toBe(false)
    expect(report.proxyEnvironment.enabled).toBe(true)
    expect(report.blockers).toEqual([])
  })
})
