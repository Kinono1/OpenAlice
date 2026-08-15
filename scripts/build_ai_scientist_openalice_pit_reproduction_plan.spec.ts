import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildAiScientistPitReproductionPlanReport,
  parseAiScientistPitReproductionPlanArgs,
  runAiScientistPitReproductionPlan,
} from './build_ai_scientist_openalice_pit_reproduction_plan.js'

describe('build_ai_scientist_openalice_pit_reproduction_plan', () => {
  it('parses args and keeps package script wired', () => {
    expect(parseAiScientistPitReproductionPlanArgs([
      '--queuePath',
      '/tmp/queue.json',
      '--sourceManifestPath',
      '/tmp/source.json',
      '--readinessPath',
      '/tmp/readiness.json',
      '--dataCatalogPath',
      '/tmp/catalog.json',
      '--aiScientistRoot',
      '/tmp/ai',
      '--maxCandidates',
      '2',
      '--output',
      'none',
      '--json',
      'true',
    ])).toMatchObject({
      queuePath: '/tmp/queue.json',
      sourceManifestPath: '/tmp/source.json',
      readinessPath: '/tmp/readiness.json',
      dataCatalogPath: '/tmp/catalog.json',
      aiScientistRoot: '/tmp/ai',
      maxCandidates: 2,
      outputPath: null,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:ai-scientist:pit-reproduction-plan']).toContain(
      'build_ai_scientist_openalice_pit_reproduction_plan.ts',
    )
  })

  it('blocks AI-Scientist CSV inputs that lack explicit availability timestamps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-pit-plan-blocked-'))
    const runDir = join(root, 'run_candidate')
    const foldDir = join(runDir, 'fold_01')
    const dataDir = join(root, 'data', 'binance_usds_1h_2024_2026')
    await mkdir(foldDir, { recursive: true })
    await mkdir(dataDir, { recursive: true })
    const csvPath = join(dataDir, 'BTC_USDT_USDT_1h.csv')
    const evaluationPath = join(runDir, 'walk_forward_evaluation.json')
    const dataManifestPath = join(foldDir, 'data_manifest.json')
    await writeFile(csvPath, [
      'timestamp,datetime,open,high,low,close,volume,symbol',
      '1704067200000,2024-01-01 00:00:00+00:00,1,2,0.5,1.5,10,BTC_USDT_USDT',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(dataManifestPath, JSON.stringify({
      source: 'openalice_local_csv',
      source_path: 'data/binance_usds_1h_2024_2026',
      selected_files: ['data/binance_usds_1h_2024_2026/BTC_USDT_USDT_1h.csv'],
      funding_available_time_policy: 'raw funding timestamp is treated as available only after that timestamp',
    }), 'utf-8')
    await writeFile(evaluationPath, JSON.stringify({
      proof_status: 'not_proven',
      fold_pass_rate: 0,
      candidate: {
        model: 'direction_gbdt_regime',
        feature_set: 'sentiment_derivatives_regime',
        target_mode: 'extreme_reversal_event',
        horizon: 12,
        lookback: 48,
      },
      source_manifest: {
        source: 'openalice_local_csv',
        source_path: 'data/binance_usds_1h_2024_2026',
        selected_files: ['data/binance_usds_1h_2024_2026/BTC_USDT_USDT_1h.csv'],
        synthetic: false,
      },
      folds: [{
        fold: 1,
        data_dir: 'data/binance_usds_1h_2024_2026',
        run_dir: 'run_candidate/fold_01',
        selected_strategy: 'model',
        status: 'completed',
        research_only: true,
        promotion_eligible: false,
        paper_trading_allowed: false,
        live_trading_allowed: false,
        label_window_separation: { asserted: true },
      }],
    }), 'utf-8')

    const report = await buildAiScientistPitReproductionPlanReport({
      queuePath: '/tmp/queue.json',
      sourceManifestPath: '/tmp/source.json',
      readinessPath: '/tmp/readiness.json',
      dataCatalogPath: '/tmp/catalog.json',
      aiScientistRoot: root,
      maxCandidates: 1,
      generatedAt: '2026-05-06T13:10:00.000Z',
      queue: makeQueue({ runDir, evaluationPath }),
      sourceManifest: makeSourceManifest({ runDir, evaluationPath }),
      readiness: makeReadiness(),
      dataCatalog: {
        datasets: [{
          datasetId: 'binance-public:spot:klines:1h:usdt',
          status: 'complete',
          storagePath: '/Volumes/shield/cryptoData/openalice-data/market/binance-public/spot-all-usdt-klines-1h',
        }],
      },
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-06T13:10:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked_pit_contract_missing',
      counts: {
        queuedCandidates: 1,
        candidatesPlanned: 1,
        candidatesReadyForOpenAlicePitReproduction: 0,
        csvInputFiles: 1,
        csvFilesWithExplicitAvailableAt: 0,
        csvFilesWithObservedOrFetchedAt: 0,
        foldManifestsFound: 1,
        foldManifestsWithAvailableTimePolicy: 1,
        openAliceWarehouseLinkedInputs: 0,
      },
    })
    expect(report.candidates[0]).toMatchObject({
      runId: 'run_candidate',
      candidateId: 'direction_gbdt_regime',
      pitAuditStatus: 'blocked',
      openAlicePitAuditPassed: false,
      proofStatus: 'not_proven',
      selectedSource: 'openalice_local_csv',
      inputFiles: [expect.objectContaining({
        kind: 'csv',
        exists: true,
        columns: ['timestamp', 'datetime', 'open', 'high', 'low', 'close', 'volume', 'symbol'],
        hasEventTime: true,
        hasAvailableAt: false,
        hasObservedAt: false,
        hasFetchedAt: false,
        warehouseLinkStatus: 'not_openalice_warehouse_path',
      })],
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'run_candidate:csv_available_time_missing:data/binance_usds_1h_2024_2026/BTC_USDT_USDT_1h.csv',
      'run_candidate:csv_observed_or_fetched_time_missing:data/binance_usds_1h_2024_2026/BTC_USDT_USDT_1h.csv',
      'run_candidate:openalice_warehouse_link_missing:data/binance_usds_1h_2024_2026/BTC_USDT_USDT_1h.csv:not_openalice_warehouse_path',
      'run_candidate:walk_forward_proof_status:not_proven',
      'ai_scientist_pit_plan_research_only',
      'openalice_pit_audit_still_required',
    ]))
  })

  it('marks PIT reproduction startable only when CSVs carry explicit availability fields and warehouse lineage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-pit-plan-ready-'))
    const warehouseDir = join(root, 'warehouse')
    const runDir = join(root, 'run_candidate')
    const foldDir = join(runDir, 'fold_01')
    await mkdir(warehouseDir, { recursive: true })
    await mkdir(foldDir, { recursive: true })
    const csvPath = join(warehouseDir, 'BTC_USDT_USDT_1h.csv')
    const evaluationPath = join(runDir, 'walk_forward_evaluation.json')
    await writeFile(csvPath, [
      'eventTime,observedAt,availableAt,open,high,low,close,volume,symbol',
      '2024-01-01T00:00:00.000Z,2024-01-01T00:01:00.000Z,2024-01-01T00:01:00.000Z,1,2,0.5,1.5,10,BTC_USDT_USDT',
      '',
    ].join('\n'), 'utf-8')
    await writeFile(join(foldDir, 'data_manifest.json'), JSON.stringify({
      selected_files: [csvPath],
      feature_available_time_policy: 'explicit availableAt columns are required',
    }), 'utf-8')
    await writeFile(evaluationPath, JSON.stringify({
      proof_status: 'proven',
      fold_pass_rate: 1,
      candidate: {
        model: 'direction_gbdt_regime',
        feature_set: 'sentiment_derivatives_regime',
        target_mode: 'extreme_reversal_event',
        horizon: 12,
        lookback: 48,
      },
      source_manifest: {
        source: 'openalice_warehouse',
        source_path: warehouseDir,
        selected_files: [csvPath],
        synthetic: false,
      },
      folds: [{
        fold: 1,
        run_dir: 'run_candidate/fold_01',
        selected_strategy: 'model',
        status: 'completed',
        research_only: true,
        promotion_eligible: false,
        paper_trading_allowed: false,
        live_trading_allowed: false,
        label_window_separation: { asserted: true },
      }],
    }), 'utf-8')

    const report = await buildAiScientistPitReproductionPlanReport({
      queuePath: '/tmp/queue.json',
      sourceManifestPath: '/tmp/source.json',
      readinessPath: '/tmp/readiness.json',
      dataCatalogPath: '/tmp/catalog.json',
      aiScientistRoot: root,
      maxCandidates: 1,
      generatedAt: '2026-05-06T13:11:00.000Z',
      queue: makeQueue({ runDir, evaluationPath }),
      sourceManifest: makeSourceManifest({ runDir, evaluationPath }),
      readiness: makeReadiness(),
      dataCatalog: {
        datasets: [{
          datasetId: 'openalice-normalized:pit-feature-sample',
          status: 'complete',
          storagePath: warehouseDir,
        }],
      },
    })

    expect(report).toMatchObject({
      status: 'ready_for_openalice_pit_reproduction',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      counts: {
        candidatesReadyForOpenAlicePitReproduction: 1,
        csvInputFiles: 1,
        csvFilesWithExplicitAvailableAt: 1,
        csvFilesWithObservedOrFetchedAt: 1,
        openAliceWarehouseLinkedInputs: 1,
      },
    })
    expect(report.candidates[0]).toMatchObject({
      pitAuditStatus: 'ready_for_reproduction',
      openAlicePitAuditPassed: false,
      inputFiles: [expect.objectContaining({
        hasEventTime: true,
        hasObservedAt: true,
        hasAvailableAt: true,
        warehouseLinkStatus: 'linked_to_complete_openalice_warehouse_dataset',
        matchingCatalogDatasetIds: ['openalice-normalized:pit-feature-sample'],
        blockers: [],
      })],
    })
    expect(report.blockers).toEqual([
      'ai_scientist_pit_plan_research_only',
      'openalice_pit_audit_still_required',
    ])
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-pit-plan-write-'))
    const queuePath = join(root, 'queue.json')
    const sourceManifestPath = join(root, 'source_manifest.json')
    const readinessPath = join(root, 'readiness.json')
    const dataCatalogPath = join(root, 'catalog.json')
    const outputPath = join(root, 'pit_plan.json')
    const runDir = join(root, 'run_candidate')
    await mkdir(runDir, { recursive: true })
    const evaluationPath = join(runDir, 'walk_forward_evaluation.json')
    await writeFile(evaluationPath, JSON.stringify({
      proof_status: 'not_proven',
      source_manifest: {
        selected_files: ['missing.csv'],
        synthetic: false,
      },
      folds: [],
    }), 'utf-8')
    await writeFile(queuePath, JSON.stringify(makeQueue({ runDir, evaluationPath })), 'utf-8')
    await writeFile(sourceManifestPath, JSON.stringify(makeSourceManifest({ runDir, evaluationPath })), 'utf-8')
    await writeFile(readinessPath, JSON.stringify(makeReadiness()), 'utf-8')
    await writeFile(dataCatalogPath, JSON.stringify({ datasets: [] }), 'utf-8')

    const report = await runAiScientistPitReproductionPlan({
      queuePath,
      sourceManifestPath,
      readinessPath,
      dataCatalogPath,
      aiScientistRoot: root,
      maxCandidates: 1,
      outputPath,
      json: false,
    })

    expect(report.status).toBe('blocked_pit_contract_missing')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'ai_scientist_openalice_pit_reproduction_plan',
      businessStatus: 'fail',
      recordsIn: 1,
    })
  })
})

function makeQueue(input: { runDir: string; evaluationPath: string }) {
  return {
    queue: [{
      queueRank: 1,
      queueStatus: 'queued_research_only',
      executionAllowed: false,
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      runId: 'run_candidate',
      runDir: input.runDir,
      family: 'event_reversal',
      candidateId: 'direction_gbdt_regime',
      sourceFiles: ['walk_forward_evaluation.json'],
      sourceArtifactPaths: [input.evaluationPath],
    }],
  }
}

function makeSourceManifest(input: { runDir: string; evaluationPath: string }) {
  return {
    status: 'locked_research_only',
    candidates: [{
      runId: 'run_candidate',
      runDir: input.runDir,
      candidateId: 'direction_gbdt_regime',
      status: 'locked',
      presentFileCount: 1,
      missingFileCount: 0,
      files: [{
        relativePath: 'walk_forward_evaluation.json',
        path: input.evaluationPath,
        exists: true,
        sizeBytes: 100,
        mtimeMs: 1770000000000,
        sha256: 'a'.repeat(64),
        blocker: null,
      }],
    }],
  }
}

function makeReadiness() {
  return {
    status: 'blocked_openalice_validation_missing',
    candidates: [{
      runId: 'run_candidate',
      candidateId: 'direction_gbdt_regime',
      sourceManifestStatus: 'locked',
      sourceFilesPresent: 1,
      sourceFilesMissing: 0,
      readyForOpenAliceReproduction: true,
      nextGateId: 'pit_audit',
      blockers: ['openalice_pit_audit_missing'],
    }],
  }
}
