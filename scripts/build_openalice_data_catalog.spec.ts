import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildOpenAliceDataCatalogReport,
  parseOpenAliceDataCatalogArgs,
  runOpenAliceDataCatalog,
} from './build_openalice_data_catalog.js'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'openalice-data-catalog-'))
}

describe('build_openalice_data_catalog', () => {
  it('parses warehouse defaults and nullable output', () => {
    expect(parseOpenAliceDataCatalogArgs([
      '--warehouseRoot',
      '/warehouse',
      '--repoDataRoot',
      '/repo/data',
      '--aiScientistRoot',
      '/ai/crypto_dl',
      '--output',
      'null',
      '--json',
    ])).toEqual({
      warehouseRoot: '/warehouse',
      repoDataRoot: '/repo/data',
      aiScientistRoot: '/ai/crypto_dl',
      outputPath: null,
      json: true,
      allowBlockedExitZero: false,
      monitorOfflineBackfills: false,
    })

    expect(parseOpenAliceDataCatalogArgs(['--allowBlockedExitZero'])).toMatchObject({
      allowBlockedExitZero: true,
      monitorOfflineBackfills: false,
    })

    expect(parseOpenAliceDataCatalogArgs(['--monitorOfflineBackfills', 'true'])).toMatchObject({
      monitorOfflineBackfills: true,
    })
  })

  it('classifies Binance summaries, local granularities, and explicit warehouse gaps', async () => {
    const root = await tempRoot()
    const warehouseRoot = join(root, 'warehouse')
    const repoDataRoot = join(root, 'repo-data')
    const aiScientistRoot = join(root, 'ai-scientist/templates/crypto_dl')
    const completeBinanceDir = join(warehouseRoot, 'market/binance-public/spot-all-usdt-klines-1m')
    const inProgressBinanceDir = join(warehouseRoot, 'market/binance-public/um-all-usdt-klines-1h')
    const liveOneSecondDir = join(repoDataRoot, 'market/live_1s')
    const derivativesDir = join(repoDataRoot, 'external/derivatives')
    const derivativesNormalizedDir = join(warehouseRoot, 'parquet/derivatives')
    const runtimeDir = join(repoDataRoot, 'runtime')
    const researchDir = join(repoDataRoot, 'research')
    const logsDir = join(warehouseRoot, 'logs')
    const onchainRawDir = join(warehouseRoot, 'onchain/coinmetrics')
    const onchainNormalizedDir = join(warehouseRoot, 'parquet/onchain/coinmetrics')
    const featureRoot = join(warehouseRoot, 'derived/features')
    const manifestsDir = join(warehouseRoot, 'manifests')

    await mkdir(completeBinanceDir, { recursive: true })
    await writeFile(join(completeBinanceDir, 'BTCUSDT-1m-2017-08.zip'), 'zip', 'utf-8')
    await writeFile(join(completeBinanceDir, 'summary.fast-binance-download.json'), JSON.stringify({
      coverage: 'complete',
      files: 1,
      targetSymbols: 1,
      totals: { downloaded: 1, exists: 0, missing: 0, failed: 0 },
    }, null, 2), 'utf-8')
    await writeFile(join(completeBinanceDir, 'manifest.fast-binance-download.jsonl'), '{}\n', 'utf-8')

    await mkdir(inProgressBinanceDir, { recursive: true })
    await writeFile(join(inProgressBinanceDir, 'BTCUSDT-1h-2019-09.zip.part'), 'partial', 'utf-8')

    await mkdir(liveOneSecondDir, { recursive: true })
    await writeFile(
      join(liveOneSecondDir, 'BTC_USDT_USDT_1s.csv'),
      'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange\n1714521600000,2024-05-01T00:00:00.000Z,1,1,1,1,1,BTC_USDT_USDT,1s,binance_futures\n',
      'utf-8',
    )
    await mkdir(join(repoDataRoot, 'market/live_5m'), { recursive: true })
    await writeFile(
      join(repoDataRoot, 'market/live_5m/BTC_USDT_USDT_5m.csv'),
      'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange\n1714521600000,2024-05-01T00:00:00.000Z,1,1,1,1,1,BTC_USDT_USDT,5m,okx\n',
      'utf-8',
    )
    await mkdir(join(repoDataRoot, 'market/live_accumulated'), { recursive: true })
    await writeFile(
      join(repoDataRoot, 'market/live_accumulated/BTC_USDT_USDT.csv'),
      'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange\n1714521600000,2024-05-01T00:00:00.000Z,1,1,1,1,1,BTC_USDT_USDT,1h,okx\n',
      'utf-8',
    )

    await mkdir(derivativesDir, { recursive: true })
    await writeFile(
      join(derivativesDir, 'okx_swap_derivatives_events.jsonl'),
      `${JSON.stringify({
        schemaVersion: 'external_derivatives_event.v1',
        exchange: 'okx',
        market: 'swap',
        symbol: 'BTCUSDT',
        sourceEndpoint: '/api/v5/public/premiumIndex',
        sourceTimestamp: '2026-05-05T00:00:00.000Z',
        sourceTimestampMs: 1777939200000,
        ingestedAt: '2026-05-05T00:00:02.000Z',
        dedupKey: 'okx|swap|premiumIndex|BTCUSDT|BTC-USDT-SWAP|5m|1777939200000',
        payload: { symbol: 'BTCUSDT', lastFundingRate: '0.0001', time: 1777939200000 },
      })}\n`,
      'utf-8',
    )
    await mkdir(join(repoDataRoot, 'normalized/derivatives'), { recursive: true })
    await writeFile(
      join(repoDataRoot, 'normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl'),
      `${JSON.stringify({
        schemaVersion: 'openalice.external_derivatives.normalized.v1',
        exchange: 'okx',
        market: 'swap',
        symbol: 'BTCUSDT',
        endpointId: 'premiumIndex',
        sourceEndpoint: '/api/v5/public/premiumIndex',
        sourceTimestamp: '2026-05-05T00:00:00.000Z',
        sourceTimestampMs: 1777939200000,
        fetchedAt: '2026-05-05T00:00:01.000Z',
        observedAt: '2026-05-05T00:00:01.500Z',
        availableAt: '2026-05-05T00:00:02.000Z',
        dedupKey: 'okx|swap|premiumIndex|BTCUSDT|BTC-USDT-SWAP|5m|1777939200000',
        reportPath: null,
        manifestPath: null,
        fields: { lastFundingRate: 0.0001, time: 1777939200000 },
      })}\n`,
      'utf-8',
    )

    await mkdir(runtimeDir, { recursive: true })
    await writeFile(join(runtimeDir, 'live_data_freshness.latest.json'), '{}\n', 'utf-8')
    await writeFile(join(runtimeDir, 'external_derivatives_data_collect.latest.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-05-05T00:00:03.000Z',
      dryRun: false,
      appendedRows: 1,
      outputPath: join(derivativesDir, 'okx_swap_derivatives_events.jsonl'),
      blockers: [],
    }, null, 2), 'utf-8')
    await writeFile(join(runtimeDir, 'external_derivatives_data_normalize.latest.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-05-05T00:00:04.000Z',
      status: 'complete',
      inputPath: join(derivativesDir, 'okx_swap_derivatives_events.jsonl'),
      outputPath: join(repoDataRoot, 'normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl'),
      rowsRead: 1,
      rowsNormalized: 1,
      rowsDropped: 0,
      endpointIds: ['premiumIndex'],
      symbols: ['BTCUSDT'],
      observedStartTime: '2026-05-05T00:00:00.000Z',
      observedEndTime: '2026-05-05T00:00:00.000Z',
      blockers: [],
    }, null, 2), 'utf-8')
    await writeFile(join(runtimeDir, 'external_derivatives_data_audit.latest.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-05-05T00:00:05.000Z',
      status: 'partial',
      inputPath: join(repoDataRoot, 'normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl'),
      rowCount: 1,
      symbols: ['BTCUSDT'],
      endpointCoverage: { BTCUSDT: ['premiumIndex'] },
      availableAtCoveragePct: 100,
      dedupKeyCoveragePct: 100,
      reportPathCoveragePct: 0,
      manifestPathCoveragePct: 0,
      blockers: [
        'external_derivatives_endpoint_missing:BTCUSDT:fundingRate',
        'external_derivatives_report_path_incomplete:0',
        'external_derivatives_manifest_path_incomplete:0',
      ],
    }, null, 2), 'utf-8')
    await mkdir(join(aiScientistRoot, 'run_candidate_001'), { recursive: true })
    await writeFile(join(aiScientistRoot, 'run_candidate_001/target_proof.json'), '{}\n', 'utf-8')
    await mkdir(researchDir, { recursive: true })
    await writeFile(join(researchDir, 'ai_scientist_crypto_candidate_intake.latest.json'), JSON.stringify({
      status: 'research_only_blocked',
      counts: {
        candidatesFound: 2,
        runsWithWalkForward: 1,
        runsWithFundingFeatures: 1,
        safetyViolations: 0,
      },
      blockers: [
        'ai_scientist_intake_research_only',
        'openalice_second_validation_required_before_incubation',
      ],
    }, null, 2), 'utf-8')
    await writeFile(join(researchDir, 'openalice_ohlcv_collector_pit_contract_status.latest.json'), JSON.stringify({
      status: 'ready_for_pit_audit_research_only',
      timeframeFreshness: [
        { timeframe: '1h', rows: 300, stale: false },
        { timeframe: '5m', rows: 300, stale: false },
      ],
      blockers: [
        'collector_pit_contract_research_only',
        'collector_rows_not_promotion_grade',
      ],
    }, null, 2), 'utf-8')
    await writeFile(join(researchDir, 'openalice_ohlcv_collector_pit_contract_status.latest.json.manifest.json'), '{}\n', 'utf-8')
    await mkdir(onchainRawDir, { recursive: true })
    await writeFile(join(onchainRawDir, 'asset_metrics_1d.jsonl'), '{}\n', 'utf-8')
    await mkdir(onchainNormalizedDir, { recursive: true })
    await writeFile(join(onchainNormalizedDir, 'asset_metrics_1d.normalized.jsonl'), '{}\n', 'utf-8')
    await writeFile(join(runtimeDir, 'openalice_coinmetrics_onchain_collect.latest.json'), JSON.stringify({
      status: 'complete',
      observedStartTime: '2010-01-01T00:00:00.000Z',
      observedEndTime: '2026-05-05T00:00:00.000Z',
      blockers: [],
    }, null, 2), 'utf-8')
    await writeFile(join(runtimeDir, 'openalice_coinmetrics_onchain_normalize.latest.json'), JSON.stringify({
      status: 'complete',
      observedStartTime: '2010-01-01T00:00:00.000Z',
      observedEndTime: '2026-05-05T00:00:00.000Z',
      blockers: [],
    }, null, 2), 'utf-8')
    await writeFile(join(runtimeDir, 'openalice_coinmetrics_onchain_audit.latest.json'), JSON.stringify({
      status: 'complete',
      observedStartTime: '2010-01-01T00:00:00.000Z',
      observedEndTime: '2026-05-05T00:00:00.000Z',
      blockers: [],
    }, null, 2), 'utf-8')
    await writeFile(join(runtimeDir, 'runtime_manifest_coverage.latest.json'), JSON.stringify({
      status: 'complete',
      coverageStatus: 'complete',
      evidenceUsabilityStatus: 'quarantine_blocked',
      coverage: {
        requiredArtifacts: 3,
        existingArtifacts: 3,
        missingArtifacts: 0,
        missingManifests: 0,
        hashMismatchManifests: 0,
      },
      blockingReasons: [],
      trustBlockingReasons: [
        'evidence_trust_pass_required:0/3',
        'evidence_trust_quarantine:3',
      ],
    }, null, 2), 'utf-8')
    await writeFile(join(runtimeDir, 'runtime_manifest_coverage.latest.json.manifest.json'), '{}\n', 'utf-8')
    await writeFile(join(runtimeDir, 'openalice_resume_finalize_contract.latest.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-05-08T00:00:00.000Z',
      contractVersion: 'openalice.resume_finalize_contract.v1',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      startsDownload: false,
      status: 'complete',
      summary: {
        sources: 6,
        completeSources: 6,
        blockedSources: 0,
        sourceAgnosticResumeContract: true,
      },
      blockers: [],
    }, null, 2), 'utf-8')
    await writeFile(join(runtimeDir, 'openalice_resume_finalize_contract.latest.json.manifest.json'), '{}\n', 'utf-8')
    await mkdir(featureRoot, { recursive: true })
    const featureOutputPath = join(featureRoot, 'eth_carry_pit_features.research_only.normalized.jsonl')
    await writeFile(featureOutputPath, `${JSON.stringify({
      schemaVersion: 'openalice.feature_store.eth_carry_pit.v1',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      featureId: 'feature-1',
      availableAt: '2026-05-07T00:42:49.601Z',
    })}\n`, 'utf-8')
    await writeFile(`${featureOutputPath}.manifest.json`, '{}\n', 'utf-8')
    await writeFile(join(runtimeDir, 'eth_carry_feature_store_materialize.latest.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-05-07T05:00:00.000Z',
      status: 'complete',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      inputPath: join(researchDir, 'eth_carry_pit_features.latest.json'),
      outputPath: featureOutputPath,
      rowsRead: 1,
      rowsWritten: 1,
      observedStartTime: '2026-05-07T00:42:49.601Z',
      observedEndTime: '2026-05-07T00:42:49.601Z',
      blockers: [],
    }, null, 2), 'utf-8')
    await writeFile(join(runtimeDir, 'eth_carry_feature_store_materialize.latest.json.manifest.json'), '{}\n', 'utf-8')
    await mkdir(logsDir, { recursive: true })
    await writeFile(join(logsDir, 'download.log'), 'ok\n', 'utf-8')
    await mkdir(manifestsDir, { recursive: true })
    await writeFile(join(manifestsDir, 'openalice_warehouse_manifest_index.latest.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-05-06T00:00:00.000Z',
      status: 'complete',
      summary: {
        manifestFiles: 3,
        readableFiles: 3,
        unreadableFiles: 0,
        notJsonFiles: 0,
        emptyFiles: 0,
      },
      blockers: [],
    }, null, 2), 'utf-8')
    await writeFile(join(manifestsDir, 'openalice_warehouse_manifest_index.latest.json.manifest.json'), '{}\n', 'utf-8')
    await writeFile(join(manifestsDir, 'openalice_normalized_warehouse_index.latest.json'), JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-05-06T00:00:01.000Z',
      status: 'blocked',
      coverageStatus: 'complete',
      pitReadinessStatus: 'blocked',
      summary: {
        normalizedFiles: 2,
        filesWithSidecarManifest: 2,
        sampledFiles: 2,
        pitContractCompleteFiles: 1,
      },
      blockers: [
        'normalized_warehouse_field_coverage_low:pit_contract:50<100',
        'normalized_warehouse_evidence_trust_quarantine:2',
      ],
    }, null, 2), 'utf-8')
    await writeFile(join(manifestsDir, 'openalice_normalized_warehouse_index.latest.json.manifest.json'), '{}\n', 'utf-8')

    const report = await buildOpenAliceDataCatalogReport({
      warehouseRoot,
      repoDataRoot,
      aiScientistRoot,
      monitorOfflineBackfills: true,
      generatedAt: '2026-05-06T00:00:00.000Z',
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-06T00:00:00.000Z',
      aiScientistRoot,
      status: 'blocked',
      summary: {
        verifiedBinancePublicDatasets: 1,
        plannedBinancePublicDatasets: 81,
        inProgress: 1,
      },
      blockerActionability: {
        totalBlockers: expect.any(Number),
        primaryCategory: expect.any(String),
      },
    })
    expect(report.objectiveCoverage.timeGranularitiesObserved).toEqual(['second', 'minute', 'hour', 'day'])
    expect(report.objectiveCoverage.observedFamilies).toContain('research_candidates')
    expect(report.objectiveCoverage.observedLayers).toContain('derived')
    expect(report.blockers).toEqual(expect.arrayContaining([
      'asset_metadata_registry_missing',
      'feature_backtest_input_research_only_not_promotion_evidence',
    ]))
    const actionCategories = Object.fromEntries(
      report.blockerActionability.categories.map(category => [category.category, category]),
    )
    expect(actionCategories.download_gap).toMatchObject({
      count: expect.any(Number),
      nextAction: expect.stringContaining('Data Vision'),
    })
    expect(actionCategories.download_gap.count).toBeGreaterThan(0)
    expect(actionCategories.ai_scientist_validation_gate).toMatchObject({
      sampleBlockers: expect.arrayContaining([
        'ai_scientist_candidates_are_not_trading_authority',
      ]),
    })
    expect(actionCategories.pit_or_normalized_gap).toMatchObject({
      sampleBlockers: expect.arrayContaining([
        'feature_backtest_input_research_only_not_promotion_evidence',
      ]),
    })
    expect(actionCategories.manifest_or_trust_gap).toMatchObject({
      sampleBlockers: expect.arrayContaining([
        'runtime_manifest_trust_blocked:evidence_trust_pass_required:0/3',
      ]),
    })

    expect(report.datasets.find(dataset => dataset.datasetId === 'binance-public:spot:klines:1m:usdt')).toMatchObject({
      status: 'complete',
      lifecycle: 'offline_manual',
      runtimeBlocking: false,
      quality: {
        summaryPresent: true,
        manifestPresent: true,
        zipFiles: 1,
        expectedFiles: 1,
        complete: true,
      },
    })
    expect(report.datasets.find(dataset => dataset.datasetId === 'binance-public:um:klines:1h:usdt')).toMatchObject({
      status: 'in_progress',
      lifecycle: 'offline_manual',
      runtimeBlocking: false,
      quality: {
        partFiles: 1,
        complete: false,
      },
    })
    expect(report.datasets.find(dataset => dataset.datasetId === 'ai-scientist:crypto-dl:candidate-runs')).toMatchObject({
      source: 'ai_scientist_crypto_dl',
      family: 'research_candidates',
      layer: 'derived',
      status: 'partial',
      present: true,
      quality: {
        summaryPresent: true,
        targetSymbols: 2,
        complete: false,
      },
      blockers: expect.arrayContaining([
        'ai_scientist_intake:ai_scientist_intake_research_only',
        'ai_scientist_candidates_require_openalice_second_validation',
        'ai_scientist_candidates_are_not_trading_authority',
      ]),
    })
    expect(report.datasets.find(dataset => dataset.datasetId === 'repo-live-market:live_5m')).toMatchObject({
      status: 'complete',
      present: true,
      reason: 'local OKX market CSV is covered by row-explicit collector PIT sidecar rows for research backtest inputs',
      quality: {
        summaryPresent: true,
        manifestPresent: true,
        complete: true,
      },
      blockers: ['local_market_pit_rows_research_only_not_promotion_evidence'],
    })
    expect(report.datasets.find(dataset => dataset.datasetId === 'repo-live-market:live_accumulated_1h')).toMatchObject({
      status: 'complete',
      present: true,
      blockers: ['local_market_pit_rows_research_only_not_promotion_evidence'],
    })
    expect(report.datasets.find(dataset => dataset.datasetId === 'repo-live-market:live_1s')).toMatchObject({
      status: 'partial',
      present: true,
      blockers: ['local_market_requires_normalized_point_in_time_snapshot'],
    })
    expect(report.datasets.find(dataset => dataset.datasetId === 'onchain:coinmetrics-community')).toMatchObject({
      status: 'complete',
      present: true,
      cadence: {
        granularity: 'day',
        timeframe: '1d',
      },
      blockers: [],
      quality: {
        summaryPresent: true,
        complete: true,
      },
    })
    expect(report.datasets.find(dataset => dataset.datasetId === 'onchain:coinmetrics-community:normalized')).toMatchObject({
      status: 'complete',
      present: true,
      blockers: [],
      quality: {
        summaryPresent: true,
        complete: true,
      },
    })
    expect(report.datasets.find(dataset => dataset.datasetId === 'onchain:coinmetrics-community:audit')).toMatchObject({
      status: 'complete',
      present: true,
      blockers: [],
      quality: {
        summaryPresent: true,
        complete: true,
      },
    })
    expect(report.datasets.find(dataset => dataset.datasetId === 'external-derivatives:okx-swap-events')).toMatchObject({
      status: 'complete',
      present: true,
      blockers: [],
      quality: {
        summaryPresent: true,
        complete: true,
      },
    })
    expect(report.datasets.find(dataset => dataset.datasetId === 'external-derivatives:okx-swap-events:normalized')).toMatchObject({
      status: 'complete',
      present: true,
      timeSpan: {
        start: '2026-05-05T00:00:00.000Z',
        end: '2026-05-05T00:00:00.000Z',
      },
      blockers: [],
      quality: {
        summaryPresent: true,
        complete: true,
      },
    })
    expect(report.datasets.find(dataset => dataset.datasetId === 'external-derivatives:okx-swap-events:audit')).toMatchObject({
      status: 'partial',
      present: true,
      blockers: expect.arrayContaining([
        'external_derivatives_endpoint_missing:BTCUSDT:fundingRate',
        'external_derivatives_report_path_incomplete:0',
        'external_derivatives_manifest_path_incomplete:0',
      ]),
      quality: {
        summaryPresent: true,
        auditPresent: true,
        complete: false,
      },
    })
    expect(report.datasets.find(dataset => dataset.datasetId === 'warehouse-audit:manifests-root')).toMatchObject({
      status: 'complete',
      present: true,
      quality: {
        summaryPresent: true,
        manifestPresent: true,
        expectedFiles: 3,
        complete: true,
      },
      blockers: [],
    })
    expect(report.datasets.find(dataset => dataset.datasetId === 'warehouse-runtime:openalice-runtime-artifacts')).toMatchObject({
      status: 'complete',
      present: true,
      reason: 'runtime artifact manifest coverage is complete; trust status remains a separate promotion blocker',
      quality: {
        summaryPresent: true,
        manifestPresent: true,
        expectedFiles: 3,
        missingFiles: 0,
        complete: true,
      },
      blockers: expect.arrayContaining([
        'runtime_manifest_trust_blocked:evidence_trust_pass_required:0/3',
        'runtime_manifest_trust_blocked:evidence_trust_quarantine:3',
      ]),
    })
    expect(report.datasets.find(dataset => dataset.datasetId === 'warehouse-normalized:parquet-root')).toMatchObject({
      status: 'complete',
      present: true,
      reason: 'normalized warehouse index has complete file and sidecar coverage; PIT/trust blockers remain separate quality signals',
      quality: {
        summaryPresent: true,
        manifestPresent: true,
        expectedFiles: 2,
        missingFiles: 0,
        complete: true,
      },
      blockers: expect.arrayContaining([
        'normalized_warehouse_trust_or_pit_blocked:normalized_warehouse_field_coverage_low:pit_contract:50<100',
        'normalized_warehouse_trust_or_pit_blocked:normalized_warehouse_evidence_trust_quarantine:2',
      ]),
    })
    expect(report.datasets.find(dataset => dataset.datasetId === 'features:point-in-time-backtest-input')).toMatchObject({
      status: 'complete',
      present: true,
      reason: 'research feature-store backtest input exists with materialization report and sidecar manifests',
      quality: {
        summaryPresent: true,
        manifestPresent: true,
        expectedFiles: 1,
        missingFiles: 0,
        targetSymbols: 2,
        complete: true,
      },
      blockers: ['feature_backtest_input_research_only_not_promotion_evidence'],
    })
    expect(report.datasets.find(dataset => dataset.datasetId === 'warehouse-resume:retry-finalize-contract')).toMatchObject({
      status: 'complete',
      present: true,
      reason: 'source-agnostic resume/finalize contract exists for data collectors and candidate imports',
      provenance: {
        auditScript: 'scripts/build_openalice_resume_finalize_contract.ts',
        resumeScript: 'scripts/build_openalice_resume_finalize_contract.ts',
      },
      quality: {
        summaryPresent: true,
        manifestPresent: true,
        expectedFiles: 6,
        failedFiles: 0,
        complete: true,
      },
      blockers: [],
    })
  })

  it('keeps offline Binance inventory visible without blocking default runtime catalog', async () => {
    const root = await tempRoot()
    const warehouseRoot = join(root, 'warehouse')
    const repoDataRoot = join(root, 'repo-data')
    const aiScientistRoot = join(root, 'ai-scientist/templates/crypto_dl')

    const runtimeReport = await buildOpenAliceDataCatalogReport({
      warehouseRoot,
      repoDataRoot,
      aiScientistRoot,
      generatedAt: '2026-05-06T00:00:00.000Z',
    })
    const offlineAuditReport = await buildOpenAliceDataCatalogReport({
      warehouseRoot,
      repoDataRoot,
      aiScientistRoot,
      monitorOfflineBackfills: true,
      generatedAt: '2026-05-06T00:00:00.000Z',
    })

    expect(runtimeReport.monitorOfflineBackfills).toBe(false)
    expect(runtimeReport.summary.plannedBinancePublicDatasets).toBe(81)
    expect(runtimeReport.datasets.filter(dataset => dataset.source === 'binance_data_vision')).toHaveLength(81)
    expect(runtimeReport.blockers.some(blocker => blocker.startsWith('binance_dataset_'))).toBe(false)
    expect(runtimeReport.blockers.some(blocker => blocker.startsWith('binance_public_incomplete:'))).toBe(false)
    expect(runtimeReport.blockerActionability.categories.some(category => category.category === 'download_gap')).toBe(false)
    expect(runtimeReport.nextActions.some(action => action.includes('Binance Data Vision queue'))).toBe(false)

    expect(offlineAuditReport.monitorOfflineBackfills).toBe(true)
    expect(offlineAuditReport.blockers).toContain('binance_public_incomplete:0/81')
    expect(offlineAuditReport.blockers.filter(blocker => blocker.startsWith('binance_dataset_missing:'))).toHaveLength(81)
    expect(offlineAuditReport.blockerActionability.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'download_gap' }),
    ]))
  })

  it('writes catalog artifact and manifest sidecar', async () => {
    const root = await tempRoot()
    const warehouseRoot = join(root, 'warehouse')
    const repoDataRoot = join(root, 'repo-data')
    const outputPath = join(repoDataRoot, 'runtime/openalice_data_catalog.latest.json')
    await mkdir(join(repoDataRoot, 'runtime'), { recursive: true })

    const report = await runOpenAliceDataCatalog({
      warehouseRoot,
      repoDataRoot,
      aiScientistRoot: join(root, 'crypto_dl'),
      outputPath,
      json: true,
      allowBlockedExitZero: false,
      monitorOfflineBackfills: false,
    })

    expect(report.status).toBe('blocked')
    const persistedRaw = await readFile(outputPath, 'utf-8')
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(JSON.parse(persistedRaw)).toMatchObject({
      schemaVersion: 1,
      status: 'blocked',
    })
    expect(manifest).toMatchObject({
      job: 'openalice_data_catalog',
      artifactPath: outputPath,
      recordsIn: report.datasets.length,
      recordsOut: report.datasets.length,
      businessStatus: 'warn',
    })
    expect(manifest.artifactHash).toBe(sha256Hex(persistedRaw))
  })
})
