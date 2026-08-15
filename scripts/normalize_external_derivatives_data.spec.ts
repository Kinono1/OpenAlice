import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseNormalizeExternalDerivativesArgs,
  runNormalizeExternalDerivatives,
} from './normalize_external_derivatives_data.js'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'oa-external-derivatives-normalize-'))
}

describe('normalize_external_derivatives_data', () => {
  it('parses defaults with run ledger enabled', () => {
    expect(parseNormalizeExternalDerivativesArgs([
      '--input',
      '/tmp/in.jsonl',
      '--output',
      '/tmp/out.jsonl',
      '--report',
      'null',
      '--runLedger',
      'null',
      '--json',
    ])).toEqual({
      inputPath: '/tmp/in.jsonl',
      outputPath: '/tmp/out.jsonl',
      reportPath: null,
      runLedgerPath: null,
      json: true,
    })
  })

  it('normalizes PIT fields and recovers legacy row lineage from the collect run ledger', async () => {
    const root = await tempRoot()
    const inputPath = join(root, 'raw.jsonl')
    const outputPath = join(root, 'normalized.jsonl')
    const reportPath = join(root, 'normalize.latest.json')
    const runLedgerPath = join(root, 'collect.runs.jsonl')
    await mkdir(root, { recursive: true })
    await writeFile(inputPath, [
      JSON.stringify({
        schemaVersion: 'external_derivatives_event.v1',
        exchange: 'binance',
        market: 'usdm',
        symbol: 'BTCUSDT',
        sourceEndpoint: '/fapi/v1/premiumIndex',
        sourceTimestamp: '2026-05-05T00:00:00.000Z',
        sourceTimestampBasis: 'exchange_event',
        fetchTimestamp: '2026-05-05T00:00:01.000Z',
        payloadReceivedAt: '2026-05-05T00:00:01.500Z',
        ingestedAt: '2026-05-05T00:00:02.000Z',
        dedupKey: 'binance|usdm|premiumIndex|BTCUSDT|1777939200000',
        rawPayloadHash: 'a'.repeat(64),
        payload: {
          symbol: 'BTCUSDT',
          markPrice: '65000',
          indexPrice: '64990',
          time: 1777939200000,
        },
      }),
      JSON.stringify({
        schemaVersion: 'external_derivatives_event.v1',
        exchange: 'binance',
        market: 'usdm',
        symbol: 'ETHUSDT',
        sourceEndpoint: '/fapi/v1/premiumIndex',
        sourceTimestamp: '2026-05-05T00:00:03.000Z',
        sourceTimestampBasis: 'exchange_event',
        fetchTimestamp: '2026-05-05T00:00:04.000Z',
        payloadReceivedAt: '2026-05-05T00:00:04.500Z',
        ingestedAt: '2026-05-05T00:00:05.000Z',
        collectionRunId: 'explicit-run',
        reportPath: '/tmp/explicit-report.json',
        manifestPath: '/tmp/explicit-report.json.manifest.json',
        dedupKey: 'binance|usdm|premiumIndex|ETHUSDT|1777939203000',
        rawPayloadHash: 'b'.repeat(64),
        payload: {
          symbol: 'ETHUSDT',
          markPrice: '3200',
          indexPrice: '3199',
          time: 1777939203000,
        },
      }),
    ].join('\n') + '\n', 'utf-8')
    await writeFile(runLedgerPath, `${JSON.stringify({
      runId: 'legacy-run',
      generatedAt: '2026-05-05T00:00:06.000Z',
      appendedRows: 1,
      reportPath: '/tmp/legacy-report.json',
    })}\n`, 'utf-8')

    const report = await runNormalizeExternalDerivatives({
      inputPath,
      outputPath,
      reportPath,
      runLedgerPath,
      json: false,
    })

    expect(report).toMatchObject({
      status: 'complete',
      rowsRead: 2,
      rowsNormalized: 2,
      lineage: {
        explicitRows: 1,
        recoveredRows: 1,
        missingRows: 0,
        eventTimeCoveragePct: 100,
        jobIdCoveragePct: 100,
        generatedAtCoveragePct: 50,
        reportPathCoveragePct: 100,
        manifestPathCoveragePct: 50,
      },
    })
    const rows = (await readFile(outputPath, 'utf-8')).trim().split('\n').map(line => JSON.parse(line))
    expect(rows[0]).toMatchObject({
      schemaVersion: 'openalice.external_derivatives.normalized.v1',
      eventTime: '2026-05-05T00:00:00.000Z',
      eventTimeMs: 1777939200000,
      sourceTimestampMs: 1777939200000,
      jobId: 'legacy-run',
      generatedAt: '2026-05-05T00:00:06.000Z',
      lineageStatus: 'recovered_from_run_ledger',
      reportPath: '/tmp/legacy-report.json',
      manifestPath: null,
    })
    expect(rows[1]).toMatchObject({
      jobId: 'explicit-run',
      generatedAt: null,
      lineageStatus: 'explicit_row_lineage',
      reportPath: '/tmp/explicit-report.json',
      manifestPath: '/tmp/explicit-report.json.manifest.json',
    })
  })
})
