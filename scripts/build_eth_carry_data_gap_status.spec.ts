import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildEthCarryDataGapStatusReport,
  parseEthCarryDataGapStatusArgs,
  runEthCarryDataGapStatus,
} from './build_eth_carry_data_gap_status.js'

describe('build_eth_carry_data_gap_status', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parseEthCarryDataGapStatusArgs([
      '--output',
      'none',
      '--json',
      'true',
      '--warehouseRoot',
      '/tmp/warehouse',
      '--minCarryFeatureRows',
      '12',
      '--maxCollectorErrorCount',
      '0',
    ])).toMatchObject({
      featurePath: 'data/research/eth_carry_pit_features.latest.json',
      pitAuditPath: 'data/research/eth_carry_pit_audit.latest.json',
      prospectivePath: 'data/research/eth_carry_prospective_evidence_status.latest.json',
      capturePath: 'data/research/eth_carry_prospective_observation_capture.latest.json',
      collectorPath: 'data/runtime/external_derivatives_data_collect.latest.json',
      downloadMonitorPath: 'data/runtime/openalice_download_monitor.latest.json',
      warehouseRoot: '/tmp/warehouse',
      outputPath: null,
      minCarryFeatureRows: 12,
      maxCollectorErrorCount: 0,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:eth-carry:data-gap-status']).toContain('build_eth_carry_data_gap_status.ts')
    expect(scripts['status:research-evidence']).toContain('build_eth_carry_data_gap_status.ts')
  })

  it('blocks low PIT feature rows, low prospective outcomes, collector errors, and missing archives', () => {
    const report = buildEthCarryDataGapStatusReport({
      generatedAt: '2026-05-06T20:20:00.000Z',
      asOfMs: Date.parse('2026-05-06T20:20:00.000Z'),
      featurePath: '/repo/data/research/eth_carry_pit_features.latest.json',
      pitAuditPath: '/repo/data/research/eth_carry_pit_audit.latest.json',
      prospectivePath: '/repo/data/research/eth_carry_prospective_evidence_status.latest.json',
      capturePath: '/repo/data/research/eth_carry_prospective_observation_capture.latest.json',
      collectorPath: '/repo/data/runtime/external_derivatives_data_collect.latest.json',
      downloadMonitorPath: '/repo/data/runtime/openalice_download_monitor.latest.json',
      warehouseRoot: '/tmp/missing-warehouse',
      featureExists: true,
      pitAuditExists: true,
      prospectiveExists: true,
      captureExists: true,
      collectorExists: true,
      downloadMonitorExists: true,
      pitFeatureDataset: makePitFeatures(),
      pitAudit: makePitAuditPass(),
      prospectiveEvidence: makeProspective(),
      capture: makeCapture(),
      collector: makeCollector({ errorSummary: { tls: 10 } }),
      downloadMonitor: {
        generatedAt: '2026-05-06T20:10:00.000Z',
        status: 'watching',
        blockers: ['external_derivatives_collect_errors:tls:10'],
      },
      thresholds: {
        minCarryFeatureRows: 100,
        minProspectiveClosedOutcomes: 100,
        minClosedDecisionWindows: 3,
        maxCollectorErrorCount: 0,
      },
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-06T20:20:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked_insufficient_research_data',
      counts: {
        sourceEvents: 259,
        fundingEvents: 22,
        basisSnapshots: 29,
        carryFeatureRows: 14,
        prospectiveClosedOutcomes: 3,
        prospectivePendingOpenEvents: 0,
        prospectiveDueOpenEventsWithoutClose: 0,
        prospectiveClosedDecisionWindows: 3,
        prospectiveClosedOutcomeShortfall: 97,
        collectorErrorCount: 10,
      },
      pitStatus: {
        featureStatus: 'ready_for_research',
        auditStatus: 'pass',
        fundingSymbols: ['BTCUSDT', 'ETHUSDT'],
        basisSymbols: ['BTCUSDT', 'ETHUSDT'],
      },
      collectorStatus: {
        dryRun: false,
        proxyConfigured: true,
        proxySource: 'env:HTTPS_PROXY',
        errorSummary: { tls: 10 },
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'carry_feature_rows_low:14<100',
      'source_lineage_incomplete_rows:25',
      'prospective_closed_outcomes_low:3<100',
      'prospective_capture:eth_carry_prospective_observation_not_built',
      'prospective_capture_no_future_rows:skipped_already_due=14',
      'external_derivatives_collect_errors:tls:10',
      'external_derivatives_rows_not_appended',
      'data_vision_core_archive_missing:binance-public:um:fundingRate:usdt',
      'data_vision_core_archive_missing:binance-public:um:markPriceKlines:1h:usdt',
      'data_vision_core_archive_missing:binance-public:um:indexPriceKlines:1h:usdt',
      'data_vision_core_archive_missing:binance-public:um:premiumIndexKlines:1h:usdt',
    ]))
    expect(report.catalogBlockers).toEqual(expect.arrayContaining([
      'data_vision_full_catalog_archive_missing:binance-public:um:fundingRate:usdt',
      'data_vision_full_catalog_archive_missing:binance-public:um:markPriceKlines:1h:usdt',
      'data_vision_full_catalog_archive_missing:binance-public:um:indexPriceKlines:1h:usdt',
      'data_vision_full_catalog_archive_missing:binance-public:um:premiumIndexKlines:1h:usdt',
    ]))
    expect(report.nextActions).toEqual(expect.arrayContaining([
      'Download or rebuild BTC/ETH fundingRate plus 1h mark/index/premium Data Vision core smoke archives before rebuilding carry PIT research features.',
      'Keep full all-USDT derivatives catalog backfill separate from ETH/BTC core research readiness and run it only when bandwidth permits.',
      'Fix external derivatives collector network/proxy errors before treating funding/carry refresh as healthy.',
      'Keep prospective capture scheduled only for future decision rows; do not backfill already-due rows as prospective evidence.',
      'Generate fresh future PIT rows before capture; current rows are already label-due and correctly refused as prospective opens.',
    ]))
  })

  it('does not report no-future capture rows when prospective opens are already pending settlement', () => {
    const report = buildEthCarryDataGapStatusReport({
      generatedAt: '2026-05-06T20:20:00.000Z',
      asOfMs: Date.parse('2026-05-06T20:20:00.000Z'),
      featurePath: '/repo/features.json',
      pitAuditPath: '/repo/pit.json',
      prospectivePath: '/repo/prospective.json',
      capturePath: '/repo/capture.json',
      collectorPath: '/repo/collector.json',
      downloadMonitorPath: '/repo/download_monitor.json',
      warehouseRoot: '/tmp/missing-warehouse',
      featureExists: true,
      pitAuditExists: true,
      prospectiveExists: true,
      captureExists: true,
      collectorExists: true,
      downloadMonitorExists: true,
      pitFeatureDataset: {
        status: 'ready_for_research',
        counts: {
          sourceEvents: 200,
          fundingEvents: 100,
          basisSnapshots: 100,
          carryFeatureRows: 120,
          rowsMissingAvailableAt: 0,
          sourceLineageIncompleteRows: 0,
        },
      },
      pitAudit: {
        status: 'pass',
        counts: {
          auditedRows: 120,
          passingRows: 120,
          failingRows: 0,
        },
      },
      prospectiveEvidence: {
        status: 'has_closed_labels',
        counts: {
          openEvents: 8,
          closedEvents: 3,
          pendingOpenEvents: 5,
          dueOpenEventsWithoutClose: 0,
          closedDecisionWindows: 3,
        },
        metrics: {
          closedOutcomes: 3,
        },
      },
      capture: {
        status: 'skipped_duplicate',
        dryRun: false,
        counts: {
          featureRowsLoaded: 120,
          observationsBuilt: 0,
          skippedAlreadyDueObservations: 117,
        },
        blockers: [],
      },
      collector: makeCollector({ fetchedRows: 2, appendedRows: 2, errorSummary: {} }),
      downloadMonitor: {
        generatedAt: '2026-05-06T20:10:00.000Z',
        status: 'watching',
        blockers: [],
      },
      thresholds: {
        minCarryFeatureRows: 100,
        minProspectiveClosedOutcomes: 100,
        minClosedDecisionWindows: 3,
        maxCollectorErrorCount: 0,
      },
    })

    expect(report.counts).toMatchObject({
      prospectiveClosedOutcomes: 3,
      prospectivePendingOpenEvents: 5,
      prospectiveDueOpenEventsWithoutClose: 0,
      captureSkippedAlreadyDueObservations: 117,
    })
    expect(report.blockers).toContain('prospective_closed_outcomes_low:3<100')
    expect(report.blockers).not.toContain('prospective_capture_no_future_rows:skipped_already_due=117')
    expect(report.nextActions).toEqual(expect.arrayContaining([
      'Wait for pending ETH carry prospective observations to reach labelDueTime, then settle; do not count pending rows as closed evidence.',
    ]))
    expect(report.nextActions).not.toContain('Generate fresh future PIT rows before capture; current rows are already label-due and correctly refused as prospective opens.')
  })

  it('uses recent OKX carry snapshot cache rows when the latest collector report is partial', () => {
    const report = buildEthCarryDataGapStatusReport({
      generatedAt: '2026-05-08T01:40:00.000Z',
      asOfMs: Date.parse('2026-05-08T01:40:00.000Z'),
      featurePath: '/repo/features.json',
      pitAuditPath: '/repo/pit.json',
      prospectivePath: '/repo/prospective.json',
      capturePath: '/repo/capture.json',
      collectorPath: '/repo/collector.json',
      okxCarrySnapshotPath: '/repo/okx_snapshot.json',
      okxCarrySnapshotRowsPath: '/repo/okx_rows.jsonl',
      downloadMonitorPath: '/repo/download_monitor.json',
      warehouseRoot: '/tmp/missing-warehouse',
      featureExists: true,
      pitAuditExists: true,
      prospectiveExists: true,
      captureExists: true,
      collectorExists: true,
      okxCarrySnapshotExists: true,
      downloadMonitorExists: true,
      pitFeatureDataset: makeHealthyPitFeatures(),
      pitAudit: makeHealthyPitAudit(),
      prospectiveEvidence: makeHealthyProspective(),
      capture: makeHealthyCapture(),
      collector: makeCollector({ errorSummary: { tls: 10 } }),
      okxCarrySnapshot: {
        generatedAt: '2026-05-08T01:39:00.000Z',
        status: 'partial',
        dryRun: false,
        counts: {
          rowsBuilt: 1,
          rowsAppended: 1,
          duplicateRows: 0,
          errors: 1,
        },
        blockers: ['okx_carry_snapshot_rows_missing:1<2', 'okx_carry_snapshot_errors:1'],
        errors: [{ symbol: 'BTCUSDT', errorClass: 'tls' }],
      },
      okxCarrySnapshotRows: [
        makeOkxSnapshotCacheRow({ symbol: 'BTCUSDT', availableAt: '2026-05-08T01:16:03.830Z' }),
        makeOkxSnapshotCacheRow({ symbol: 'ETHUSDT', availableAt: '2026-05-08T01:27:14.146Z' }),
      ],
      downloadMonitor: {
        generatedAt: '2026-05-08T01:39:00.000Z',
        status: 'watching',
        blockers: ['external_derivatives_collect_errors:tls:10'],
      },
      thresholds: {
        minCarryFeatureRows: 100,
        minProspectiveClosedOutcomes: 100,
        minClosedDecisionWindows: 3,
        maxCollectorErrorCount: 0,
      },
    })

    expect(report.okxCarrySnapshotStatus).toMatchObject({
      status: 'complete',
      rowsBuilt: 2,
      errorCount: 0,
      reportRowsBuilt: 1,
      reportErrorCount: 1,
      cacheRows: 2,
      cacheSymbols: ['BTCUSDT', 'ETHUSDT'],
      cacheLatestAvailableAt: '2026-05-08T01:27:14.146Z',
      cacheFallbackUsed: true,
      reportBlockers: ['okx_carry_snapshot_rows_missing:1<2', 'okx_carry_snapshot_errors:1'],
    })
    expect(report.counts).toMatchObject({
      collectorFetchedRows: 2,
      collectorErrorCount: 0,
      externalCollectorErrorCount: 10,
      okxCarrySnapshotRowsBuilt: 2,
      okxCarrySnapshotErrorCount: 0,
      okxCarrySnapshotCacheRows: 2,
    })
    expect(report.blockers.some(blocker => blocker.startsWith('okx_carry_snapshot'))).toBe(false)
    expect(report.blockers).not.toContain('external_derivatives_collect_errors:tls:10')
    expect(report.nextActions).toContain('OKX live carry snapshot is healthy for fresh ETH/BTC prospective capture; keep Binance external collector TLS repair as a separate catalog-hardening task.')
  })

  it('keeps OKX snapshot blocked when cache rows are stale or missing a required symbol', () => {
    const report = buildEthCarryDataGapStatusReport({
      generatedAt: '2026-05-08T01:40:00.000Z',
      asOfMs: Date.parse('2026-05-08T01:40:00.000Z'),
      featurePath: '/repo/features.json',
      pitAuditPath: '/repo/pit.json',
      prospectivePath: '/repo/prospective.json',
      capturePath: '/repo/capture.json',
      collectorPath: '/repo/collector.json',
      okxCarrySnapshotPath: '/repo/okx_snapshot.json',
      okxCarrySnapshotRowsPath: '/repo/okx_rows.jsonl',
      downloadMonitorPath: '/repo/download_monitor.json',
      warehouseRoot: '/tmp/missing-warehouse',
      featureExists: true,
      pitAuditExists: true,
      prospectiveExists: true,
      captureExists: true,
      collectorExists: false,
      okxCarrySnapshotExists: true,
      downloadMonitorExists: true,
      pitFeatureDataset: makeHealthyPitFeatures(),
      pitAudit: makeHealthyPitAudit(),
      prospectiveEvidence: makeHealthyProspective(),
      capture: makeHealthyCapture(),
      collector: null,
      okxCarrySnapshot: {
        generatedAt: '2026-05-08T01:39:00.000Z',
        status: 'partial',
        dryRun: false,
        counts: {
          rowsBuilt: 1,
          rowsAppended: 1,
          duplicateRows: 0,
          errors: 1,
        },
        blockers: ['okx_carry_snapshot_rows_missing:1<2'],
      },
      okxCarrySnapshotRows: [
        makeOkxSnapshotCacheRow({ symbol: 'ETHUSDT', availableAt: '2026-05-08T01:27:14.146Z' }),
        makeOkxSnapshotCacheRow({ symbol: 'BTCUSDT', availableAt: '2026-05-07T12:00:00.000Z' }),
      ],
      downloadMonitor: {
        generatedAt: '2026-05-08T01:39:00.000Z',
        status: 'watching',
        blockers: [],
      },
      thresholds: {
        minCarryFeatureRows: 100,
        minProspectiveClosedOutcomes: 100,
        minClosedDecisionWindows: 3,
        maxCollectorErrorCount: 0,
      },
    })

    expect(report.okxCarrySnapshotStatus).toMatchObject({
      status: 'partial',
      rowsBuilt: 1,
      errorCount: 1,
      cacheRows: 1,
      cacheSymbols: ['ETHUSDT'],
      cacheFallbackUsed: false,
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'okx_carry_snapshot_collect_not_complete:partial',
      'okx_carry_snapshot_rows_missing:1<2',
      'okx_carry_snapshot_errors:1',
      'okx_carry_snapshot:okx_carry_snapshot_rows_missing:1<2',
    ]))
  })

  it('recognizes complete Data Vision archives without archive blockers', async () => {
    const warehouseRoot = await mkdtemp(join(tmpdir(), 'oa-eth-carry-gap-warehouse-'))
    for (const directory of [
      'market/binance-public/eth-carry-core-fundingRate',
      'market/binance-public/eth-carry-core-markPriceKlines-1h',
      'market/binance-public/eth-carry-core-indexPriceKlines-1h',
      'market/binance-public/eth-carry-core-premiumIndexKlines-1h',
      'market/binance-public/um-all-usdt-fundingRate',
      'market/binance-public/um-all-usdt-markPriceKlines-1h',
      'market/binance-public/um-all-usdt-indexPriceKlines-1h',
      'market/binance-public/um-all-usdt-premiumIndexKlines-1h',
    ]) {
      const path = join(warehouseRoot, directory)
      await mkdir(path, { recursive: true })
      await writeFile(join(path, 'sample.zip'), 'zip', 'utf-8')
      await writeFile(join(path, 'summary.fast-binance-download.json'), JSON.stringify({
        coverage: 'complete',
      }), 'utf-8')
      await writeFile(join(path, 'manifest.fast-binance-download.jsonl'), '{}\n', 'utf-8')
    }

    const report = buildEthCarryDataGapStatusReport({
      generatedAt: '2026-05-06T20:20:00.000Z',
      asOfMs: Date.parse('2026-05-06T20:20:00.000Z'),
      featurePath: '/repo/features.json',
      pitAuditPath: '/repo/pit.json',
      prospectivePath: '/repo/prospective.json',
      capturePath: '/repo/capture.json',
      collectorPath: '/repo/collector.json',
      downloadMonitorPath: '/repo/download_monitor.json',
      warehouseRoot,
      featureExists: true,
      pitAuditExists: true,
      prospectiveExists: true,
      captureExists: true,
      collectorExists: true,
      downloadMonitorExists: true,
      pitFeatureDataset: {
        status: 'ready_for_research',
        counts: {
          sourceEvents: 200,
          fundingEvents: 110,
          basisSnapshots: 120,
          carryFeatureRows: 110,
          symbolsWithFunding: ['BTCUSDT', 'ETHUSDT'],
          symbolsWithBasis: ['BTCUSDT', 'ETHUSDT'],
          rowsMissingAvailableAt: 0,
          sourceLineageIncompleteRows: 0,
        },
      },
      pitAudit: {
        status: 'pass',
        counts: {
          auditedRows: 110,
          passingRows: 110,
          failingRows: 0,
        },
      },
      prospectiveEvidence: {
        status: 'has_closed_labels',
        counts: {
          openEvents: 120,
          closedEvents: 110,
          closedDecisionWindows: 4,
        },
        metrics: {
          closedOutcomes: 110,
        },
      },
      capture: {
        status: 'collecting',
        dryRun: false,
        counts: {
          featureRowsLoaded: 110,
          observationsBuilt: 1,
          skippedAlreadyDueObservations: 0,
        },
        blockers: [],
      },
      collector: makeCollector({ fetchedRows: 8, appendedRows: 8, errorSummary: {} }),
      downloadMonitor: {
        generatedAt: '2026-05-06T20:10:00.000Z',
        status: 'watching',
        blockers: [],
      },
      thresholds: {
        minCarryFeatureRows: 100,
        minProspectiveClosedOutcomes: 100,
        minClosedDecisionWindows: 3,
        maxCollectorErrorCount: 0,
      },
    })

    expect(report.status).toBe('watch_ready_for_more_capture')
    expect(report.dataVisionCoreSmokeArchives).toHaveLength(4)
    expect(report.dataVisionCoreSmokeArchives.every(archive => archive.status === 'complete')).toBe(true)
    expect(report.dataVisionArchives).toHaveLength(4)
    expect(report.dataVisionArchives.every(archive => archive.status === 'complete')).toBe(true)
    expect(report.dataVisionArchiveSummary).toMatchObject({
      coreSmokeArchives: 4,
      coreSmokeArchivesComplete: 4,
      coreSmokeComplete: true,
      fullCatalogArchives: 4,
      fullCatalogArchivesComplete: 4,
      fullCatalogComplete: true,
    })
    expect(report.blockers.filter(blocker => blocker.startsWith('data_vision_core_archive_'))).toEqual([])
    expect(report.catalogBlockers.filter(blocker => blocker.startsWith('data_vision_full_catalog_archive_'))).toEqual([])
    expect(report.blockers).toEqual([])
  })

  it('writes data gap artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-data-gap-'))
    const outputPath = join(root, 'data_gap.json')
    const featuresPath = join(root, 'features.json')
    const pitAuditPath = join(root, 'pit_audit.json')
    const prospectivePath = join(root, 'prospective.json')
    const capturePath = join(root, 'capture.json')
    const collectorPath = join(root, 'collector.json')
    const monitorPath = join(root, 'monitor.json')
    await writeJson(featuresPath, makePitFeatures())
    await writeJson(pitAuditPath, makePitAuditPass())
    await writeJson(prospectivePath, makeProspective())
    await writeJson(capturePath, makeCapture())
    await writeJson(collectorPath, makeCollector({ errorSummary: { tls: 2 } }))
    await writeJson(monitorPath, { generatedAt: '2026-05-06T20:10:00.000Z', status: 'watching', blockers: [] })

    const report = await runEthCarryDataGapStatus({
      featurePath: featuresPath,
      pitAuditPath,
      prospectivePath,
      capturePath,
      collectorPath,
      downloadMonitorPath: monitorPath,
      warehouseRoot: join(root, 'warehouse'),
      outputPath,
      minCarryFeatureRows: 100,
      minProspectiveClosedOutcomes: 100,
      minClosedDecisionWindows: 3,
      maxCollectorErrorCount: 0,
      asOfMs: Date.parse('2026-05-06T20:20:00.000Z'),
      json: false,
    })

    expect(report).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked_insufficient_research_data',
    })
    expect(report.outputHash).toEqual(expect.any(String))
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      status: 'blocked_insufficient_research_data',
      outputHash: report.outputHash,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'eth_carry_data_gap_status',
      businessStatus: 'warn',
      recordsOut: 14,
    })
  })
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

function makePitFeatures() {
  return {
    status: 'ready_for_research',
    counts: {
      sourceEvents: 259,
      fundingEvents: 22,
      basisSnapshots: 29,
      carryFeatureRows: 14,
      symbolsWithFunding: ['BTCUSDT', 'ETHUSDT'],
      symbolsWithBasis: ['BTCUSDT', 'ETHUSDT'],
      rowsMissingAvailableAt: 0,
      sourceLineageIncompleteRows: 25,
    },
    carryFeatureRows: new Array(14).fill(null).map((_, index) => ({ featureId: `feature-${index}` })),
  }
}

function makePitAuditPass() {
  return {
    status: 'pass',
    counts: {
      carryFeatureRows: 14,
      auditedRows: 14,
      passingRows: 14,
      failingRows: 0,
    },
  }
}

function makeHealthyPitFeatures() {
  return {
    status: 'ready_for_research',
    counts: {
      sourceEvents: 400,
      fundingEvents: 200,
      basisSnapshots: 200,
      carryFeatureRows: 120,
      symbolsWithFunding: ['BTCUSDT', 'ETHUSDT'],
      symbolsWithBasis: ['BTCUSDT', 'ETHUSDT'],
      rowsMissingAvailableAt: 0,
      sourceLineageIncompleteRows: 0,
    },
  }
}

function makeHealthyPitAudit() {
  return {
    status: 'pass',
    counts: {
      carryFeatureRows: 120,
      auditedRows: 120,
      passingRows: 120,
      failingRows: 0,
    },
  }
}

function makeHealthyProspective() {
  return {
    status: 'has_closed_labels',
    counts: {
      openEvents: 100,
      closedEvents: 100,
      pendingOpenEvents: 0,
      dueOpenEventsWithoutClose: 0,
      closedDecisionWindows: 4,
    },
    metrics: {
      closedOutcomes: 100,
    },
  }
}

function makeHealthyCapture() {
  return {
    status: 'captured',
    dryRun: false,
    counts: {
      featureRowsLoaded: 120,
      observationsBuilt: 1,
      skippedAlreadyDueObservations: 0,
    },
    blockers: [],
  }
}

function makeProspective() {
  return {
    status: 'has_closed_labels',
    counts: {
      openEvents: 3,
      closedEvents: 3,
      closedDecisionWindows: 3,
    },
    metrics: {
      closedOutcomes: 3,
    },
    latestOpen: {
      observationId: 'obs-3',
      decisionTime: '2026-05-06T03:00:00.000Z',
      labelDueTime: '2026-05-06T11:00:00.000Z',
    },
  }
}

function makeCapture() {
  return {
    status: 'blocked',
    dryRun: false,
    counts: {
      featureRowsLoaded: 14,
      observationsBuilt: 0,
      skippedAlreadyDueObservations: 14,
    },
    blockers: ['eth_carry_prospective_observation_not_built'],
  }
}

function makeCollector(input: {
  fetchedRows?: number
  appendedRows?: number
  errorSummary: Record<string, number>
}) {
  return {
    generatedAt: '2026-05-06T20:10:00.000Z',
    dryRun: false,
    proxyConfigured: true,
    proxySource: 'env:HTTPS_PROXY',
    fetchedRows: input.fetchedRows ?? 0,
    appendedRows: input.appendedRows ?? 0,
    wouldAppendRows: 0,
    skippedDuplicateRows: 0,
    errorSummary: input.errorSummary,
  }
}

function makeOkxSnapshotCacheRow(input: { symbol: 'BTCUSDT' | 'ETHUSDT'; availableAt: string }) {
  return {
    schemaVersion: 'openalice.external_derivatives.normalized.v1',
    eventTime: input.availableAt,
    eventTimeMs: Date.parse(input.availableAt),
    exchange: 'okx',
    market: 'swap',
    symbol: input.symbol,
    endpointId: 'okxCarrySnapshot',
    sourceEndpoint: '/api/v5/public/okx-carry-snapshot',
    sourceTimestamp: input.availableAt,
    sourceTimestampMs: Date.parse(input.availableAt),
    sourceTimestampBasis: 'exchange_snapshot_max_ts',
    fetchedAt: input.availableAt,
    observedAt: input.availableAt,
    availableAt: input.availableAt,
    ingestedAt: input.availableAt,
    jobId: `job-${input.symbol}`,
    generatedAt: input.availableAt,
    lineageStatus: 'explicit_row_lineage',
    dedupKey: `okx|swap|okxCarrySnapshot|${input.symbol}|${Date.parse(input.availableAt)}`,
    rawPayloadHash: `hash-${input.symbol}`,
    collectionRunId: `job-${input.symbol}`,
    reportPath: '/repo/data/runtime/okx_carry_snapshot_collect.latest.json',
    manifestPath: '/repo/okx_rows.jsonl.manifest.json',
    normalizedPayloadHash: `normalized-${input.symbol}`,
    fields: {
      markPrice: input.symbol === 'BTCUSDT' ? 79618.5 : 2283.66,
      indexPrice: input.symbol === 'BTCUSDT' ? 79650.6 : 2284,
      fundingRate: input.symbol === 'BTCUSDT' ? 0.000029 : 0.0001,
      nextFundingTime: Date.parse('2026-05-08T08:00:00.000Z'),
    },
  }
}
