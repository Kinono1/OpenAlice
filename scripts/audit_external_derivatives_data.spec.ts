import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseAuditExternalDerivativesArgs,
  runAuditExternalDerivatives,
} from './audit_external_derivatives_data.js'
import { runNormalizeExternalDerivatives } from './normalize_external_derivatives_data.js'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'oa-external-derivatives-audit-'))
}

describe('audit_external_derivatives_data', () => {
  it('parses nullable output', () => {
    expect(parseAuditExternalDerivativesArgs([
      '--input',
      '/tmp/normalized.jsonl',
      '--output',
      'null',
      '--json',
    ])).toEqual({
      inputPath: '/tmp/normalized.jsonl',
      outputPath: null,
      json: true,
    })
  })

  it('keeps legacy rows partial when manifest lineage is not recoverable', async () => {
    const root = await tempRoot()
    const rawPath = join(root, 'raw.jsonl')
    const normalizedPath = join(root, 'normalized.jsonl')
    const runLedgerPath = join(root, 'runs.jsonl')
    await mkdir(root, { recursive: true })
    await writeFile(rawPath, [
      rawEvent('BTCUSDT', '/fapi/v1/fundingRate', 1_777_939_200_000),
      rawEvent('BTCUSDT', '/fapi/v1/premiumIndex', 1_777_939_201_000),
      rawEvent('BTCUSDT', '/fapi/v1/openInterest', 1_777_939_202_000),
      rawEvent('BTCUSDT', '/futures/data/openInterestHist', 1_777_939_203_000),
      rawEvent('BTCUSDT', '/futures/data/globalLongShortAccountRatio', 1_777_939_204_000),
    ].join('\n') + '\n', 'utf-8')
    await writeFile(runLedgerPath, `${JSON.stringify({
      runId: 'legacy-run',
      generatedAt: '2026-05-05T00:00:06.000Z',
      appendedRows: 5,
      reportPath: '/tmp/legacy-report.json',
    })}\n`, 'utf-8')

    await runNormalizeExternalDerivatives({
      inputPath: rawPath,
      outputPath: normalizedPath,
      reportPath: null,
      runLedgerPath,
      json: false,
    })
    const audit = await runAuditExternalDerivatives({
      inputPath: normalizedPath,
      outputPath: null,
      json: false,
    })

    expect(audit).toMatchObject({
      status: 'partial',
      rowCount: 5,
      eventTimeCoveragePct: 100,
      availableAtCoveragePct: 100,
      jobIdCoveragePct: 100,
      generatedAtCoveragePct: 100,
      dedupKeyCoveragePct: 100,
      reportPathCoveragePct: 100,
      manifestPathCoveragePct: 0,
      lineageStatusCounts: {
        recovered_from_run_ledger: 5,
      },
    })
    expect(audit.blockers).toEqual(['external_derivatives_manifest_path_incomplete:0'])
  })
})

function rawEvent(symbol: string, endpoint: string, ms: number): string {
  return JSON.stringify({
    schemaVersion: 'external_derivatives_event.v1',
    exchange: 'binance',
    market: 'usdm',
    symbol,
    sourceEndpoint: endpoint,
    sourceTimestamp: new Date(ms).toISOString(),
    sourceTimestampBasis: 'exchange_event',
    fetchTimestamp: new Date(ms + 1000).toISOString(),
    payloadReceivedAt: new Date(ms + 1500).toISOString(),
    ingestedAt: new Date(ms + 2000).toISOString(),
    dedupKey: `binance|usdm|${endpoint}|${symbol}|${ms}`,
    rawPayloadHash: `${ms}`.padStart(64, '0').slice(0, 64),
    payload: {
      symbol,
      time: ms,
      fundingTime: ms,
      timestamp: ms,
      markPrice: '65000',
      indexPrice: '64990',
      openInterest: '1000',
      sumOpenInterest: '1000',
      longShortRatio: '1.01',
    },
  })
}
