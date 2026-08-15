import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildAiScientistPitRebuildQueueReport,
  parseAiScientistPitRebuildQueueArgs,
  runAiScientistPitRebuildQueue,
} from './build_ai_scientist_openalice_pit_rebuild_queue.js'

describe('build_ai_scientist_openalice_pit_rebuild_queue', () => {
  it('parses args and keeps package scripts wired research-only', () => {
    expect(parseAiScientistPitRebuildQueueArgs([
      '--pitPlanPath',
      '/tmp/pit-plan.json',
      '--output',
      'none',
      '--maxTasks',
      '7',
      '--json',
      'true',
    ])).toMatchObject({
      pitPlanPath: '/tmp/pit-plan.json',
      outputPath: null,
      maxTasks: 7,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:ai-scientist:pit-rebuild-queue']).toContain(
      'build_ai_scientist_openalice_pit_rebuild_queue.ts',
    )
    expect(scripts['status:research-evidence']).toContain(
      'build_ai_scientist_openalice_pit_rebuild_queue.ts',
    )
  })

  it('turns blocked AI-Scientist PIT files into OpenAlice-native rebuild tasks without enabling trading', () => {
    const report = buildAiScientistPitRebuildQueueReport({
      generatedAt: '2026-05-06T15:10:00.000Z',
      pitPlanPath: '/tmp/pit-plan.json',
      maxTasks: 500,
      pitPlan: {
        schemaVersion: 1,
        status: 'blocked_pit_contract_missing',
        candidates: [{
          runId: 'run_walk_forward_binance_2024_2026_event_fine_gate',
          candidateId: 'direction_gbdt_regime',
          family: 'direction_gbdt_regime',
          queueRank: 1,
          inputFiles: [
            {
              relativePath: 'data/binance_usds_1h_2024_2026/BTC_USDT_USDT_1h.csv',
              path: '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl/data/binance_usds_1h_2024_2026/BTC_USDT_USDT_1h.csv',
              kind: 'csv',
              exists: true,
              sizeBytes: 123,
              hasEventTime: true,
              hasAvailableAt: false,
              hasObservedAt: false,
              hasFetchedAt: false,
              warehouseLinkStatus: 'linked_to_partial_openalice_warehouse_dataset',
              matchingCatalogDatasetIds: ['binance-public:um-all-usdt-klines-1h'],
            },
            {
              relativePath: 'warehouse/ETH_USDT_USDT_1h.csv',
              path: '/Volumes/shield/cryptoData/openalice-data/research/ETH_USDT_USDT_1h.csv',
              kind: 'csv',
              exists: true,
              sizeBytes: 456,
              hasEventTime: true,
              hasAvailableAt: true,
              hasObservedAt: true,
              hasFetchedAt: false,
              warehouseLinkStatus: 'linked_to_complete_openalice_warehouse_dataset',
              matchingCatalogDatasetIds: ['openalice-native:ai-scientist-pit:sample'],
            },
          ],
        }],
      },
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-06T15:10:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked_waiting_for_openalice_native_rebuild',
      counts: {
        pitCandidatesRead: 1,
        inputFilesRead: 2,
        csvInputFilesRead: 2,
        rebuildTasks: 1,
        openTasks: 1,
        missingEventTimeTasks: 0,
        missingAvailableAtTasks: 1,
        missingObservedOrFetchedAtTasks: 1,
        incompleteWarehouseLineageTasks: 1,
        completeWarehouseLineageInputs: 1,
        uniqueSymbols: 1,
        uniqueTimeframes: 1,
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'ai_scientist_pit_rebuild_tasks_open:1',
      'ai_scientist_pit_available_at_rebuild_required:1',
      'ai_scientist_pit_observed_or_fetched_at_rebuild_required:1',
      'ai_scientist_pit_complete_warehouse_lineage_required:1',
      'ai_scientist_pit_rebuild_queue_research_only',
    ]))
    expect(report.tasks).toHaveLength(1)
    expect(report.tasks[0]).toMatchObject({
      status: 'open',
      priority: 'P0',
      runId: 'run_walk_forward_binance_2024_2026_event_fine_gate',
      candidateId: 'direction_gbdt_regime',
      family: 'direction_gbdt_regime',
      queueRank: 1,
      symbol: 'BTC/USDT:USDT',
      rawSymbol: 'BTC_USDT_USDT',
      timeframe: '1h',
      sourceKind: 'csv',
      sourceExists: true,
      sourceSizeBytes: 123,
      warehouseLinkStatus: 'linked_to_partial_openalice_warehouse_dataset',
      matchingCatalogDatasetIds: ['binance-public:um-all-usdt-klines-1h'],
      missingFields: ['availableAt', 'observedAt_or_fetchedAt', 'completeOpenAliceWarehouseLineage'],
      blockers: expect.arrayContaining([
        'missing_availableAt',
        'missing_observedAt_or_fetchedAt',
        'missing_completeOpenAliceWarehouseLineage',
        'warehouse_lineage_partial:data/binance_usds_1h_2024_2026/BTC_USDT_USDT_1h.csv',
      ]),
      requiredOutputContract: {
        schema: 'openalice.ai_scientist.pit_input.native_rebuild.v1',
        requiredRowFields: expect.arrayContaining([
          'eventTime',
          'observedAt_or_fetchedAt',
          'availableAt',
          'exchange',
          'symbol',
          'sourceEndpoint',
          'captureJobId',
          'sourceRowHash',
        ]),
        forbiddenShortcuts: expect.arrayContaining([
          'source_file_mtime_recovered',
          'derived_bar_close_time_as_promotion_grade_availableAt',
          'candidate_supplied_metric_as_openalice_gate',
        ]),
      },
    })
    expect(report.tasks[0].taskId).toMatch(/^pit_rebuild\./)
  })

  it('fails closed when the PIT plan is missing', () => {
    const report = buildAiScientistPitRebuildQueueReport({
      generatedAt: '2026-05-06T15:11:00.000Z',
      pitPlanPath: '/tmp/missing-pit-plan.json',
      maxTasks: 10,
      pitPlan: null,
    })

    expect(report).toMatchObject({
      status: 'blocked_missing_pit_plan',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      counts: {
        pitCandidatesRead: 0,
        inputFilesRead: 0,
        rebuildTasks: 0,
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'ai_scientist_pit_reproduction_plan_missing',
      'ai_scientist_pit_rebuild_queue_research_only',
    ]))
  })

  it('writes queue artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-pit-rebuild-'))
    await mkdir(root, { recursive: true })
    const pitPlanPath = join(root, 'pit-plan.json')
    const outputPath = join(root, 'rebuild-queue.json')
    await writeJson(pitPlanPath, {
      schemaVersion: 1,
      status: 'blocked_pit_contract_missing',
      candidates: [{
        runId: 'run_a',
        candidateId: 'direction_gbdt_regime',
        family: 'direction_gbdt_regime',
        inputFiles: [{
          relativePath: 'data/binance_usds_1h_2024_2026/SOL_USDT_USDT_1h.csv',
          path: join(root, 'SOL_USDT_USDT_1h.csv'),
          kind: 'csv',
          exists: true,
          sizeBytes: 789,
          hasEventTime: true,
          hasAvailableAt: false,
          hasObservedAt: false,
          hasFetchedAt: false,
          warehouseLinkStatus: 'not_openalice_warehouse_path',
          matchingCatalogDatasetIds: [],
        }],
      }],
    })

    const report = await runAiScientistPitRebuildQueue({
      pitPlanPath,
      outputPath,
      maxTasks: 100,
      json: false,
    })

    expect(report.status).toBe('blocked_waiting_for_openalice_native_rebuild')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      status: 'blocked_waiting_for_openalice_native_rebuild',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      counts: {
        rebuildTasks: 1,
      },
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'ai_scientist_openalice_pit_rebuild_queue',
      businessStatus: 'fail',
      recordsIn: 1,
      recordsOut: 1,
    })
  })
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}
