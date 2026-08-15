import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildAiScientistPitContractStatusReport,
  parseAiScientistPitContractStatusArgs,
  runAiScientistPitContractStatus,
} from './build_ai_scientist_openalice_pit_contract_status.js'

describe('build_ai_scientist_openalice_pit_contract_status', () => {
  it('parses args and keeps package script wired', () => {
    expect(parseAiScientistPitContractStatusArgs([
      '--datasetReportPath',
      '/tmp/report.json',
      '--inputPath',
      '/tmp/rows.jsonl',
      '--nativeOhlcvRowsReportPath',
      '/tmp/native-report.json',
      '--nativeOhlcvRowsPath',
      '/tmp/native-rows.jsonl',
      '--output',
      'none',
      '--maxRows',
      '3',
      '--json',
    ])).toMatchObject({
      datasetReportPath: '/tmp/report.json',
      inputPath: '/tmp/rows.jsonl',
      nativeOhlcvRowsReportPath: '/tmp/native-report.json',
      nativeOhlcvRowsPath: '/tmp/native-rows.jsonl',
      outputPath: null,
      maxRows: 3,
      json: true,
    })

    expect(parseAiScientistPitContractStatusArgs([])).toMatchObject({
      maxRows: 0,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:ai-scientist:pit-contract-status']).toContain(
      'build_ai_scientist_openalice_pit_contract_status.ts',
    )
  })

  it('blocks file-mtime recovered PIT rows from becoming promotion evidence', () => {
    const report = buildAiScientistPitContractStatusReport({
      generatedAt: '2026-05-06T14:00:00.000Z',
      datasetReportPath: '/tmp/dataset-report.json',
      inputPath: '/tmp/rows.jsonl',
      nativeOhlcvRowsReportPath: null,
      nativeOhlcvRowsPath: null,
      datasetReport: {
        counts: {
          rowsNormalized: 2,
        },
      },
      nativeOhlcvRowsReport: null,
      nativeOhlcvRowsScanned: 0,
      rowParseErrors: 0,
      rows: [
        {
          runId: 'run_a',
          candidateId: 'direction_gbdt_regime',
          symbol: 'BTC/USDT:USDT',
          eventTime: '2024-01-01T00:00:00.000Z',
          availableAt: '2024-01-01T01:00:00.000Z',
          availableAtBasis: 'derived_bar_close_time',
          observedAt: '2026-05-06T12:00:00.000Z',
          fetchedAt: '2026-05-06T12:00:00.000Z',
          observedAtBasis: 'source_file_mtime_recovered',
          quality: {
            promotionGrade: false,
            blockers: ['row_not_promotion_grade'],
          },
        },
        {
          runId: 'run_a',
          candidateId: 'direction_gbdt_regime',
          symbol: 'ETH/USDT:USDT',
          eventTime: '2024-01-01T00:00:00.000Z',
          availableAt: '2024-01-01T01:00:00.000Z',
          availableAtBasis: 'derived_bar_close_time',
          observedAt: '2026-05-06T12:00:00.000Z',
          fetchedAt: '2026-05-06T12:00:00.000Z',
          observedAtBasis: 'source_file_mtime_recovered',
          quality: {
            promotionGrade: false,
            blockers: ['row_not_promotion_grade'],
          },
        },
      ],
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-06T14:00:00.000Z',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked_pit_contract_missing',
      counts: {
        datasetRowsReported: 2,
        nativeOhlcvRowsReported: 0,
        nativeOhlcvRowsScanned: 0,
        rowsScanned: 2,
        rowsWithEventTime: 2,
        rowsWithAvailableAt: 2,
        rowsWithAvailableAtFieldButNotPromotionGrade: 2,
        rowsWithRowExplicitAvailableAt: 0,
        rowsWithObservedAt: 2,
        rowsWithFetchedAt: 2,
        rowsWithObservedOrFetchedFieldButNotPromotionGrade: 2,
        rowsWithRowLineageScope: 0,
        rowsWithRowPITUsableForPromotionFalse: 0,
        rowsWithRowExplicitObservedOrFetchedAt: 0,
        rowsPromotionGrade: 0,
        rowsWithQualityBlockers: 2,
        distinctSymbols: 2,
      },
      coverage: {
        eventTimePct: 100,
        availableAtPct: 100,
        rowExplicitAvailableAtPct: 0,
        observedOrFetchedAtPct: 100,
        rowExplicitObservedOrFetchedAtPct: 0,
        promotionGradePct: 0,
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'row_explicit_available_at_missing:0/2',
      'row_explicit_observed_or_fetched_at_missing:0/2',
      'promotion_grade_rows_missing:0/2',
      'quality_blockers_present:2/2',
      'ai_scientist_pit_contract_research_only',
    ]))
  })

  it('allows row-explicit PIT rows only into research reproduction readiness', () => {
    const report = buildAiScientistPitContractStatusReport({
      generatedAt: '2026-05-06T14:10:00.000Z',
      datasetReportPath: '/tmp/dataset-report.json',
      inputPath: '/tmp/rows.jsonl',
      nativeOhlcvRowsReportPath: null,
      nativeOhlcvRowsPath: null,
      datasetReport: {
        counts: {
          rowsNormalized: 1,
        },
      },
      nativeOhlcvRowsReport: null,
      nativeOhlcvRowsScanned: 0,
      rowParseErrors: 0,
      rows: [
        {
          runId: 'run_explicit_pit',
          candidateId: 'direction_gbdt_regime',
          symbol: 'ETH/USDT:USDT',
          eventTime: '2024-01-01T00:00:00.000Z',
          availableAt: '2024-01-01T01:00:03.000Z',
          availableAtBasis: 'row_explicit_available_at',
          observedAt: '2024-01-01T01:00:04.000Z',
          observedAtBasis: 'row_explicit_observed_at',
          fetchedAt: '2024-01-01T01:00:05.000Z',
          fetchedAtBasis: 'row_explicit_fetched_at',
          quality: {
            promotionGrade: true,
            blockers: [],
          },
        },
      ],
    })

    expect(report).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'ready_for_research_reproduction',
      counts: {
        datasetRowsReported: 1,
        nativeOhlcvRowsReported: 0,
        nativeOhlcvRowsScanned: 0,
        rowsScanned: 1,
        rowsWithEventTime: 1,
        rowsWithAvailableAt: 1,
        rowsWithAvailableAtFieldButNotPromotionGrade: 0,
        rowsWithRowExplicitAvailableAt: 1,
        rowsWithObservedAt: 1,
        rowsWithFetchedAt: 1,
        rowsWithObservedOrFetchedFieldButNotPromotionGrade: 0,
        rowsWithRowLineageScope: 0,
        rowsWithRowPITUsableForPromotionFalse: 0,
        rowsWithRowExplicitObservedOrFetchedAt: 1,
        rowsPromotionGrade: 1,
        rowsWithQualityBlockers: 0,
        distinctSymbols: 1,
      },
      coverage: {
        eventTimePct: 100,
        availableAtPct: 100,
        rowExplicitAvailableAtPct: 100,
        observedOrFetchedAtPct: 100,
        rowExplicitObservedOrFetchedAtPct: 100,
        promotionGradePct: 100,
      },
      sampleRows: [{
        runId: 'run_explicit_pit',
        candidateId: 'direction_gbdt_regime',
        symbol: 'ETH/USDT:USDT',
        eventTime: '2024-01-01T00:00:00.000Z',
        availableAtBasis: 'row_explicit_available_at',
        observedAtBasis: 'row_explicit_observed_at',
        promotionGrade: true,
        blockers: [],
      }],
    })
    expect(report.blockers).toEqual(['ai_scientist_pit_contract_research_only'])
  })

  it('writes contract artifact and manifest from normalized JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-pit-contract-'))
    const inputPath = join(root, 'rows.jsonl')
    const reportPath = join(root, 'dataset-report.json')
    const outputPath = join(root, 'contract.json')
    await mkdir(root, { recursive: true })
    await writeFile(inputPath, `${JSON.stringify({
      runId: 'run_a',
      candidateId: 'direction_gbdt_regime',
      symbol: 'BTC/USDT:USDT',
      eventTime: '2024-01-01T00:00:00.000Z',
      availableAt: '2024-01-01T01:00:00.000Z',
      availableAtBasis: 'derived_bar_close_time',
      observedAt: '2026-05-06T12:00:00.000Z',
      fetchedAt: '2026-05-06T12:00:00.000Z',
      observedAtBasis: 'source_file_mtime_recovered',
      quality: {
        promotionGrade: false,
        blockers: ['row_not_promotion_grade'],
      },
    })}\n`, 'utf-8')
    await writeFile(reportPath, JSON.stringify({
      outputPath: inputPath,
      counts: {
        rowsNormalized: 1,
      },
    }), 'utf-8')

    const report = await runAiScientistPitContractStatus({
      datasetReportPath: reportPath,
      inputPath: null,
      nativeOhlcvRowsReportPath: null,
      nativeOhlcvRowsPath: null,
      outputPath,
      maxRows: 10,
      json: false,
    })

    expect(report.status).toBe('blocked_pit_contract_missing')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      status: 'blocked_pit_contract_missing',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      counts: {
        rowsScanned: 1,
        rowsPromotionGrade: 0,
      },
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'ai_scientist_openalice_pit_contract_status',
      businessStatus: 'fail',
      recordsIn: 1,
      recordsOut: 1,
    })
  })

  it('includes native OHLCV archive-materialized rows while keeping PIT promotion blocked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-pit-contract-native-'))
    const inputPath = join(root, 'rows.jsonl')
    const reportPath = join(root, 'dataset-report.json')
    const nativeRowsPath = join(root, 'native-rows.jsonl')
    const nativeReportPath = join(root, 'native-report.json')
    const outputPath = join(root, 'contract.json')
    await mkdir(root, { recursive: true })
    await writeFile(inputPath, `${JSON.stringify({
      runId: 'run_a',
      candidateId: 'direction_gbdt_regime',
      symbol: 'BTC/USDT:USDT',
      eventTime: '2024-01-01T00:00:00.000Z',
      availableAt: '2024-01-01T01:00:00.000Z',
      availableAtBasis: 'derived_bar_close_time',
      observedAt: '2026-05-06T12:00:00.000Z',
      fetchedAt: '2026-05-06T12:00:00.000Z',
      observedAtBasis: 'source_file_mtime_recovered',
      quality: {
        promotionGrade: false,
        blockers: ['row_not_promotion_grade'],
      },
    })}\n`, 'utf-8')
    await writeFile(nativeRowsPath, `${JSON.stringify({
      schemaVersion: 'openalice.ai_scientist.ohlcv_native_row_rebuild.v1',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      runId: 'run_a',
      candidateId: 'direction_gbdt_regime',
      symbol: 'ETH/USDT:USDT',
      eventTime: '2024-01-01T00:00:00.000Z',
      availableAt: '2026-05-06T14:00:00.000Z',
      availableAtBasis: 'archive_materialization_time_research_only_not_historical_decision_available_at',
      observedAt: '2026-05-06T14:00:00.000Z',
      observedAtBasis: 'materializer_observed_archive_row',
      fetchedAt: '2026-05-06T14:00:00.000Z',
      fetchedAtBasis: 'materializer_read_local_archive',
      lineageScope: 'row',
      rowPITUsableForPromotion: false,
      quality: {
        promotionGrade: false,
        blockers: [
          'archive_materialization_time_not_historical_decision_available_at',
          'row_pit_usable_for_promotion_false',
          'research_only_not_execution_evidence',
        ],
      },
    })}\n`, 'utf-8')
    await writeFile(reportPath, JSON.stringify({
      outputPath: inputPath,
      counts: {
        rowsNormalized: 1,
      },
    }), 'utf-8')
    await writeFile(nativeReportPath, JSON.stringify({
      outputPath: nativeRowsPath,
      counts: {
        rowsWritten: 1,
        promotionGradeRows: 0,
      },
    }), 'utf-8')

    const report = await runAiScientistPitContractStatus({
      datasetReportPath: reportPath,
      inputPath: null,
      nativeOhlcvRowsReportPath: nativeReportPath,
      nativeOhlcvRowsPath: null,
      outputPath,
      maxRows: 10,
      json: false,
    })

    expect(report).toMatchObject({
      status: 'blocked_pit_contract_missing',
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      sourceArtifacts: {
        nativeOhlcvRowsReport: nativeReportPath,
        nativeOhlcvRows: nativeRowsPath,
      },
      counts: {
        datasetRowsReported: 1,
        nativeOhlcvRowsReported: 1,
        nativeOhlcvRowsScanned: 1,
        rowsScanned: 2,
        rowsWithEventTime: 2,
        rowsWithAvailableAt: 2,
        rowsWithAvailableAtFieldButNotPromotionGrade: 2,
        rowsWithObservedAt: 2,
        rowsWithFetchedAt: 2,
        rowsWithObservedOrFetchedFieldButNotPromotionGrade: 2,
        rowsWithRowLineageScope: 1,
        rowsWithRowPITUsableForPromotionFalse: 1,
        rowsWithRowExplicitAvailableAt: 0,
        rowsWithRowExplicitObservedOrFetchedAt: 0,
        rowsPromotionGrade: 0,
        rowsWithQualityBlockers: 2,
        distinctSymbols: 2,
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'row_explicit_available_at_missing:0/2',
      'row_explicit_observed_or_fetched_at_missing:0/2',
      'row_pit_usable_for_promotion_false:1/2',
      'promotion_grade_rows_missing:0/2',
      'quality_blockers_present:2/2',
      'ai_scientist_pit_contract_research_only',
    ]))
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      counts: {
        nativeOhlcvRowsReported: 1,
        nativeOhlcvRowsScanned: 1,
        rowsPromotionGrade: 0,
      },
    })
  })
})
