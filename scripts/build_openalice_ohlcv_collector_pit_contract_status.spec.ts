import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildOpenAliceOhlcvCollectorPitContractStatusReport,
  parseOpenAliceOhlcvCollectorPitContractStatusArgs,
  runOpenAliceOhlcvCollectorPitContractStatus,
} from './build_openalice_ohlcv_collector_pit_contract_status.js'
import {
  buildCollectorRunId,
  buildOhlcvCollectorPitRows,
  defaultCollectorPitRowsPath,
  resolveCollectorPitRowsPath,
} from './lib/ohlcv_collector_pit.js'

describe('build_openalice_ohlcv_collector_pit_contract_status', () => {
  it('parses defaults and nullable paths', () => {
    expect(parseOpenAliceOhlcvCollectorPitContractStatusArgs([])).toMatchObject({
      inputPath: defaultCollectorPitRowsPath(),
      maxRows: 5000,
      maxObservationAgeMinutes: 180,
    })

    expect(parseOpenAliceOhlcvCollectorPitContractStatusArgs([
      '--inputPath',
      'null',
      '--output',
      'null',
      '--maxRows',
      '10',
      '--maxObservationAgeMinutes',
      '30',
      '--json',
      'true',
    ])).toMatchObject({
      inputPath: null,
      outputPath: null,
      maxRows: 10,
      maxObservationAgeMinutes: 30,
      json: true,
    })
  })

  it('uses OPENALICE_DATA_ROOT for the collector PIT sidecar by default', () => {
    const previous = process.env.OPENALICE_DATA_ROOT
    process.env.OPENALICE_DATA_ROOT = '/local/openalice-data'
    try {
      expect(defaultCollectorPitRowsPath()).toBe(
        '/local/openalice-data/normalized/research/openalice_okx_public_ohlcv_pit_rows.research_only.jsonl',
      )
      expect(resolveCollectorPitRowsPath()).toBe(
        '/local/openalice-data/normalized/research/openalice_okx_public_ohlcv_pit_rows.research_only.jsonl',
      )
    } finally {
      if (previous == null) delete process.env.OPENALICE_DATA_ROOT
      else process.env.OPENALICE_DATA_ROOT = previous
    }
  })

  it('keeps row-explicit collector PIT rows research-only and non-promotional', () => {
    const generatedAt = '2026-05-07T01:00:00.000Z'
    const row = buildOhlcvCollectorPitRows({
      generatedAt,
      jobId: 'okx_public_ohlcv_1h_collector',
      collectionRunId: buildCollectorRunId({
        jobId: 'okx_public_ohlcv_1h_collector',
        generatedAt,
        timeframe: '1h',
      }),
      symbol: 'BTC-USDT',
      storageSymbol: 'BTC_USDT_USDT',
      instId: 'BTC-USDT-SWAP',
      timeframe: '1h',
      bar: '1H',
      limit: 300,
      requestStartedAt: '2026-05-07T01:00:01.000Z',
      responseObservedAt: '2026-05-07T01:00:02.000Z',
      candles: [{
        timestamp: 1778112000000,
        open: 64000,
        high: 64100,
        low: 63900,
        close: 64050,
        volume: 123.4,
      }],
    })[0]

    expect(row).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      eventTime: '2026-05-07T00:00:00.000Z',
      availableAtBasis: 'row_explicit_collector_response_time_research_availability',
      observedAtBasis: 'row_explicit_collector_response_time',
      fetchedAtBasis: 'row_explicit_collector_request_start_time',
      lineageScope: 'row',
      rowPITUsableForPromotion: false,
      quality: {
        promotionGrade: false,
        blockers: [
          'research_only_not_execution_evidence',
          'row_promotion_audit_not_passed',
        ],
      },
    })
    expect(row.sourceRequestPath).toContain('/api/v5/market/candles?')
    expect(row.sourceRowHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('reports ready for PIT audit when row-explicit fields are complete but keeps promotion grade at zero', () => {
    const generatedAt = '2026-05-07T01:00:00.000Z'
    const rows = buildOhlcvCollectorPitRows({
      generatedAt,
      jobId: 'okx_public_ohlcv_5m_collector',
      collectionRunId: 'run-1',
      symbol: 'ETH_USDT_USDT',
      storageSymbol: 'ETH_USDT_USDT',
      instId: 'ETH-USDT-SWAP',
      timeframe: '5m',
      bar: '5m',
      limit: 300,
      requestStartedAt: '2026-05-07T01:00:01.000Z',
      responseObservedAt: '2026-05-07T01:00:02.000Z',
      candles: [{
        timestamp: 1778112000000,
        open: 3000,
        high: 3010,
        low: 2990,
        close: 3005,
        volume: 99,
      }],
    })
    const report = buildOpenAliceOhlcvCollectorPitContractStatusReport({
      generatedAt,
      inputPath: '/tmp/collector.jsonl',
      rows,
      rowParseErrors: 0,
    })

    expect(report).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'ready_for_pit_audit_research_only',
      counts: {
        rowsScanned: 1,
        rowsWithRowExplicitAvailableAt: 1,
        rowsWithRowExplicitObservedOrFetchedAt: 1,
        rowsPromotionGrade: 0,
      },
      coverage: {
        rowExplicitAvailableAtPct: 100,
        rowExplicitObservedOrFetchedAtPct: 100,
        promotionGradePct: 0,
      },
      freshness: {
        latestObservedAt: '2026-05-07T01:00:02.000Z',
        latestCollectorObservationAgeMinutes: 0,
        maxObservationAgeMinutes: 180,
        stale: false,
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'row_pit_usable_for_promotion_false',
      'collector_rows_not_promotion_grade',
      'quality_blockers_present:1/1',
      'collector_pit_contract_research_only',
    ]))
  })

  it('fails closed when collector PIT observations are stale', () => {
    const generatedAt = '2026-05-07T06:00:00.000Z'
    const rows = buildOhlcvCollectorPitRows({
      generatedAt: '2026-05-07T01:00:00.000Z',
      jobId: 'okx_public_ohlcv_1h_collector',
      collectionRunId: 'run-1',
      symbol: 'BTC-USDT',
      storageSymbol: 'BTC_USDT_USDT',
      instId: 'BTC-USDT-SWAP',
      timeframe: '1h',
      bar: '1H',
      limit: 300,
      requestStartedAt: '2026-05-07T01:00:01.000Z',
      responseObservedAt: '2026-05-07T01:00:02.000Z',
      candles: [{ timestamp: 1778112000000, open: 1, high: 2, low: 1, close: 1.5, volume: 10 }],
    })

    const report = buildOpenAliceOhlcvCollectorPitContractStatusReport({
      generatedAt,
      inputPath: '/tmp/collector.jsonl',
      rows,
      rowParseErrors: 0,
      maxObservationAgeMinutes: 60,
    })

    expect(report).toMatchObject({
      status: 'blocked_collector_pit_contract_stale',
      freshness: {
        latestObservedAt: '2026-05-07T01:00:02.000Z',
        latestCollectorObservationAgeMinutes: 299.967,
        maxObservationAgeMinutes: 60,
        stale: true,
        staleTimeframes: ['1h'],
      },
      timeframeFreshness: [{
        timeframe: '1h',
        rows: 1,
        latestObservedAt: '2026-05-07T01:00:02.000Z',
        latestCollectorObservationAgeMinutes: 299.967,
        stale: true,
      }],
    })
    expect(report.blockers).toContain('collector_pit_timeframe_stale:1h:299.967>60m')
    expect(report.paperTradingAllowed).toBe(false)
    expect(report.liveTradingAllowed).toBe(false)
    expect(report.executionAllowed).toBe(false)
  })

  it('scans JSONL and fails closed when rows are missing', async () => {
    const root = await mkTmp()
    const inputPath = join(root, 'rows.jsonl')
    const outputPath = join(root, 'status.latest.json')
    const row = buildOhlcvCollectorPitRows({
      generatedAt: '2026-05-07T01:00:00.000Z',
      jobId: 'okx_public_ohlcv_1h_collector',
      collectionRunId: 'run-1',
      symbol: 'BTC-USDT',
      storageSymbol: 'BTC_USDT_USDT',
      instId: 'BTC-USDT-SWAP',
      timeframe: '1h',
      bar: '1H',
      limit: 300,
      requestStartedAt: '2026-05-07T01:00:01.000Z',
      responseObservedAt: '2026-05-07T01:00:02.000Z',
      candles: [{ timestamp: 1778112000000, open: 1, high: 2, low: 1, close: 1.5, volume: 10 }],
    })[0]
    await writeFile(inputPath, `${JSON.stringify(row)}\nnot json\n`, 'utf-8')

    const report = await runOpenAliceOhlcvCollectorPitContractStatus({
      inputPath,
      outputPath,
      maxRows: 0,
      maxObservationAgeMinutes: 1_000_000,
      json: false,
    })

    expect(report.counts.rowsScanned).toBe(1)
    expect(report.counts.rowParseErrors).toBe(1)
    expect(report.blockers).toContain('collector_pit_row_parse_errors:1')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      status: 'ready_for_pit_audit_research_only',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
    expect(JSON.parse(await readFile(`${inputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'openalice_ohlcv_collector_pit_rows_research_only_audit',
      artifactPath: inputPath,
      businessStatus: 'warn',
      evidenceTrust: 'quarantine',
      recordsIn: 1,
      recordsOut: 1,
      errorClass: 'collector_pit_contract_research_only',
    })
  })
})

async function mkTmp(): Promise<string> {
  const path = join(tmpdir(), `openalice-collector-pit-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await mkdir(path, { recursive: true })
  return path
}
