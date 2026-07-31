import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  parseAiScientistPitInputDatasetArgs,
  runAiScientistPitInputDataset,
} from './build_ai_scientist_openalice_pit_input_dataset.js'

describe('build_ai_scientist_openalice_pit_input_dataset', () => {
  it('parses args and keeps package scripts wired research-only', () => {
    expect(parseAiScientistPitInputDatasetArgs([
      '--pitPlanPath',
      '/tmp/pit-plan.json',
      '--outputPath',
      '/tmp/rows.jsonl',
      '--reportPath',
      'none',
      '--maxCandidates',
      '2',
      '--maxRowsPerFile',
      '7',
      '--json',
      'true',
    ])).toMatchObject({
      pitPlanPath: '/tmp/pit-plan.json',
      outputPath: '/tmp/rows.jsonl',
      reportPath: null,
      maxCandidates: 2,
      maxRowsPerFile: 7,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:ai-scientist:pit-input-dataset']).toContain(
      'build_ai_scientist_openalice_pit_input_dataset.ts',
    )
    expect(scripts['status:research-evidence']).toContain(
      'build_ai_scientist_openalice_pit_input_dataset.ts',
    )
  })

  it('uses a local data root for its default research output', () => {
    const args = parseAiScientistPitInputDatasetArgs(['--dataRoot', '/tmp/openalice-data'])

    expect(args.outputPath).toBe('/tmp/openalice-data/normalized/research/ai_scientist/openalice_pit_inputs.sample.normalized.jsonl')
    expect(args.outputPath).not.toContain('/Volumes/shield')
  })

  it('normalizes sampled AI-Scientist CSV rows into PIT-shaped research-only JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-pit-input-'))
    const dataDir = join(root, 'data', 'binance_usds_1h_2024_2026')
    await mkdir(dataDir, { recursive: true })
    const csvPath = join(dataDir, 'BTC_USDT_USDT_1h.csv')
    const planPath = join(root, 'pit-plan.json')
    const outputPath = join(root, 'normalized.jsonl')
    const reportPath = join(root, 'report.json')
    await writeFile(csvPath, [
      'timestamp,datetime,open,high,low,close,volume,symbol',
      '1704067200000,2024-01-01 00:00:00+00:00,100,110,90,105,123,BTC_USDT_USDT',
      '1704070800000,2024-01-01 01:00:00+00:00,105,115,95,106,456,BTC_USDT_USDT',
      '',
    ].join('\n'), 'utf-8')
    const fixedMtime = new Date('2026-05-06T12:34:56.000Z')
    await utimes(csvPath, fixedMtime, fixedMtime)
    const fileInfo = await stat(csvPath)
    await writeFile(planPath, JSON.stringify({
      schemaVersion: 1,
      status: 'blocked_pit_contract_missing',
      candidates: [{
        runId: 'run_walk_forward_binance_2024_2026_event_fine_gate',
        candidateId: 'direction_gbdt_regime',
        family: 'direction_gbdt_regime',
        inputFiles: [{
          relativePath: 'data/binance_usds_1h_2024_2026/BTC_USDT_USDT_1h.csv',
          path: csvPath,
          kind: 'csv',
        }],
      }],
    }), 'utf-8')

    const report = await runAiScientistPitInputDataset({
      pitPlanPath: planPath,
      outputPath,
      reportPath,
      maxCandidates: 1,
      maxRowsPerFile: 1,
      json: false,
    })

    expect(report).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'research_dataset_ready_pit_blocked',
      sampling: {
        maxCandidates: 1,
        maxRowsPerFile: 1,
        sampled: true,
      },
      counts: {
        candidatesRead: 1,
        inputFilesRead: 1,
        csvFilesRead: 1,
        rowsRead: 1,
        rowsNormalized: 1,
        rowsDropped: 0,
        promotionGradeRows: 0,
        distinctSymbols: 1,
      },
      candidates: [{
        runId: 'run_walk_forward_binance_2024_2026_event_fine_gate',
        candidateId: 'direction_gbdt_regime',
        family: 'direction_gbdt_regime',
        files: 1,
        rowsNormalized: 1,
      }],
      symbols: ['BTC/USDT:USDT'],
      observedStartTime: '2024-01-01T00:00:00.000Z',
      observedEndTime: '2024-01-01T00:00:00.000Z',
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'pit_input_dataset_research_only',
      'pit_input_observed_at_recovered_from_file_mtime_not_row_explicit',
      'pit_input_available_at_derived_from_bar_close_not_exchange_observed',
      'pit_input_not_promotion_grade',
    ]))
    expect(report.outputHash).toMatch(/^[a-f0-9]{64}$/)

    const rows = (await readFile(outputPath, 'utf-8')).trim().split('\n').map(line => JSON.parse(line))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      schemaVersion: 'openalice.ai_scientist.pit_input.normalized.v1',
      runId: 'run_walk_forward_binance_2024_2026_event_fine_gate',
      candidateId: 'direction_gbdt_regime',
      source: 'ai_scientist_crypto_dl',
      exchange: 'binance',
      market: 'usds_futures',
      symbol: 'BTC/USDT:USDT',
      rawSymbol: 'BTC_USDT_USDT',
      timeframe: '1h',
      eventTime: '2024-01-01T00:00:00.000Z',
      eventTimeMs: 1704067200000,
      eventTimeBasis: 'source_bar_open_time',
      availableAt: '2024-01-01T01:00:00.000Z',
      availableAtMs: 1704070800000,
      availableAtBasis: 'derived_bar_close_time',
      fetchedAt: fixedMtime.toISOString(),
      observedAt: fixedMtime.toISOString(),
      observedAtBasis: 'source_file_mtime_recovered',
      generatedAt: report.generatedAt,
      jobId: report.jobId,
      sourceFilePath: csvPath,
      sourceFileMtime: fixedMtime.toISOString(),
      sourceFileSizeBytes: fileInfo.size,
      sourceRowIndex: 0,
      values: {
        timestamp: 1704067200000,
        datetime: '2024-01-01 00:00:00+00:00',
        open: 100,
        high: 110,
        low: 90,
        close: 105,
        volume: 123,
        symbol: 'BTC_USDT_USDT',
      },
      quality: {
        promotionGrade: false,
        pitLineageStatus: 'research_reproduction_only_file_mtime_recovered',
        blockers: [
          'available_at_derived_from_bar_close_not_exchange_observed',
          'fetched_at_recovered_from_file_mtime_not_row_explicit',
          'observed_at_recovered_from_file_mtime_not_row_explicit',
          'row_not_promotion_grade',
        ],
      },
    })
    expect(rows[0].sourceRowHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(await readFile(reportPath, 'utf-8'))).toMatchObject({
      status: 'research_dataset_ready_pit_blocked',
      outputPath,
      counts: {
        rowsNormalized: 1,
        promotionGradeRows: 0,
      },
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'ai_scientist_openalice_pit_input_rows',
      businessStatus: 'warn',
      recordsIn: 1,
      recordsOut: 1,
      artifactHash: report.outputHash,
    })
    expect(JSON.parse(await readFile(`${reportPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'ai_scientist_openalice_pit_input_dataset_report',
      businessStatus: 'warn',
      recordsIn: 1,
      recordsOut: 1,
    })
  })

  it('preserves row-explicit PIT timestamps for future promotion-grade research inputs without enabling trading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-pit-input-explicit-'))
    const dataDir = join(root, 'data', 'binance_usds_1h_2024_2026')
    await mkdir(dataDir, { recursive: true })
    const csvPath = join(dataDir, 'ETH_USDT_USDT_1h.csv')
    const planPath = join(root, 'pit-plan.json')
    const outputPath = join(root, 'normalized.jsonl')
    const reportPath = join(root, 'report.json')
    await writeFile(csvPath, [
      'eventTime,availableAt,observedAt,fetchedAt,open,high,low,close,volume,symbol,openalicePitContractStatus',
      '2024-01-01T00:00:00.000Z,2024-01-01T01:00:03.000Z,2024-01-01T01:00:04.000Z,2024-01-01T01:00:05.000Z,200,210,190,205,321,ETH_USDT_USDT,research_reproduction_ready',
      '',
    ].join('\n'), 'utf-8')
    const fixedMtime = new Date('2026-05-06T12:34:56.000Z')
    await utimes(csvPath, fixedMtime, fixedMtime)
    await writeFile(planPath, JSON.stringify({
      schemaVersion: 1,
      status: 'blocked_pit_contract_missing',
      candidates: [{
        runId: 'run_explicit_pit',
        candidateId: 'direction_gbdt_regime',
        family: 'direction_gbdt_regime',
        inputFiles: [{
          path: csvPath,
          kind: 'csv',
        }],
      }],
    }), 'utf-8')

    const report = await runAiScientistPitInputDataset({
      pitPlanPath: planPath,
      outputPath,
      reportPath,
      maxCandidates: 1,
      maxRowsPerFile: 10,
      json: false,
    })

    expect(report).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'research_dataset_ready_pit_blocked',
      counts: {
        rowsNormalized: 1,
        promotionGradeRows: 1,
      },
    })
    expect(report.blockers).toContain('pit_input_dataset_research_only')
    expect(report.blockers).not.toContain('pit_input_observed_at_recovered_from_file_mtime_not_row_explicit')
    expect(report.blockers).not.toContain('pit_input_available_at_derived_from_bar_close_not_exchange_observed')
    expect(report.blockers).not.toContain('pit_input_not_promotion_grade')

    const rows = (await readFile(outputPath, 'utf-8')).trim().split('\n').map(line => JSON.parse(line))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      runId: 'run_explicit_pit',
      symbol: 'ETH/USDT:USDT',
      eventTime: '2024-01-01T00:00:00.000Z',
      availableAt: '2024-01-01T01:00:03.000Z',
      availableAtMs: 1704070803000,
      availableAtBasis: 'row_explicit_available_at',
      observedAt: '2024-01-01T01:00:04.000Z',
      observedAtBasis: 'row_explicit_observed_at',
      fetchedAt: '2024-01-01T01:00:05.000Z',
      fetchedAtBasis: 'row_explicit_fetched_at',
      quality: {
        promotionGrade: true,
        pitLineageStatus: 'research_reproduction_ready',
        blockers: [],
      },
    })
    expect(rows[0].fetchedAt).not.toBe(fixedMtime.toISOString())
    expect(JSON.parse(await readFile(reportPath, 'utf-8'))).toMatchObject({
      status: 'research_dataset_ready_pit_blocked',
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      counts: {
        rowsNormalized: 1,
        promotionGradeRows: 1,
      },
    })
  })

  it('fails closed when the PIT reproduction plan is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-pit-input-missing-'))
    const report = await runAiScientistPitInputDataset({
      pitPlanPath: join(root, 'missing.json'),
      outputPath: join(root, 'rows.jsonl'),
      reportPath: join(root, 'report.json'),
      maxCandidates: 1,
      maxRowsPerFile: 1,
      json: false,
    })

    expect(report).toMatchObject({
      status: 'blocked_missing_plan',
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      counts: {
        candidatesRead: 0,
        rowsRead: 0,
        rowsNormalized: 0,
        promotionGradeRows: 0,
      },
      blockers: expect.arrayContaining([
        'ai_scientist_pit_reproduction_plan_missing',
        'ai_scientist_pit_input_rows_missing',
        'pit_input_not_promotion_grade',
      ]),
    })
    expect(await readFile(join(root, 'rows.jsonl'), 'utf-8')).toBe('')
    expect(JSON.parse(await readFile(`${join(root, 'rows.jsonl')}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'ai_scientist_openalice_pit_input_rows',
      businessStatus: 'fail',
      recordsOut: 0,
    })
  })
})
