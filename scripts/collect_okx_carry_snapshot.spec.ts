import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildOkxCarrySnapshotRow,
  parseOkxCarrySnapshotArgs,
} from './collect_okx_carry_snapshot.js'

describe('collect_okx_carry_snapshot', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parseOkxCarrySnapshotArgs([
      '--symbols',
      'BTCUSDT,ETHUSDT',
      '--report',
      'none',
      '--dryRun',
      'true',
      '--timeoutMs',
      '1234',
      '--retryAttempts',
      '0',
      '--retryDelayMs',
      '0',
    ])).toMatchObject({
      symbols: ['BTCUSDT', 'ETHUSDT'],
      outputPath: expect.stringMatching(/data\/normalized\/derivatives\/okx_swap_eth_carry_live\.normalized\.jsonl$/),
      reportPath: null,
      dryRun: true,
      timeoutMs: 1234,
      retryAttempts: 0,
      retryDelayMs: 0,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:eth-carry:okx-snapshot']).toContain('collect_okx_carry_snapshot.ts')
    expect(scripts['status:research-evidence']).toContain('collect_okx_carry_snapshot.ts')
    expect(scripts['research:eth-carry:okx-snapshot']).not.toContain('/Volumes/shield')
  })

  it('builds a research-only normalized OKX carry row with explicit lineage', () => {
    const row = buildOkxCarrySnapshotRow({
      symbol: 'ETHUSDT',
      instId: 'ETH-USDT-SWAP',
      indexInstId: 'ETH-USDT',
      fetchedAt: '2026-05-07T00:30:00.000Z',
      observedAt: '2026-05-07T00:30:01.000Z',
      availableAt: '2026-05-07T00:30:02.000Z',
      jobId: 'job-1',
      reportPath: '/repo/data/runtime/okx_carry_snapshot_collect.latest.json',
      manifestPath: '/repo/data/runtime/okx_carry_snapshot_collect.latest.json.manifest.json',
      mark: {
        instId: 'ETH-USDT-SWAP',
        markPx: '2345.03',
        ts: '1778113666169',
      },
      index: {
        instId: 'ETH-USDT',
        idxPx: '2346',
        ts: '1778113665881',
      },
      funding: {
        instId: 'ETH-USDT-SWAP',
        fundingRate: '0.0000808849757152',
        fundingTime: '1778140800000',
        nextFundingTime: '1778169600000',
        prevFundingTime: '1778112000000',
        ts: '1778113633229',
      },
    })

    expect(row).toMatchObject({
      schemaVersion: 'openalice.external_derivatives.normalized.v1',
      eventTime: '2026-05-07T00:27:46.169Z',
      eventTimeMs: 1778113666169,
      exchange: 'okx',
      market: 'swap',
      symbol: 'ETHUSDT',
      endpointId: 'okxCarrySnapshot',
      sourceEndpoint: '/api/v5/public/okx-carry-snapshot',
      sourceTimestampBasis: 'exchange_snapshot_max_ts',
      fetchedAt: '2026-05-07T00:30:00.000Z',
      observedAt: '2026-05-07T00:30:01.000Z',
      availableAt: '2026-05-07T00:30:02.000Z',
      jobId: 'job-1',
      collectionRunId: 'job-1',
      lineageStatus: 'explicit_row_lineage',
      reportPath: '/repo/data/runtime/okx_carry_snapshot_collect.latest.json',
      manifestPath: '/repo/data/runtime/okx_carry_snapshot_collect.latest.json.manifest.json',
      fields: {
        symbol: 'ETHUSDT',
        instId: 'ETH-USDT-SWAP',
        indexInstId: 'ETH-USDT',
        markPrice: 2345.03,
        indexPrice: 2346,
        lastFundingRate: 0.0000808849757152,
        fundingRate: 0.0000808849757152,
        fundingTime: 1778140800000,
        nextFundingTime: 1778169600000,
        prevFundingTime: 1778112000000,
      },
    })
    expect(row.dedupKey).toBe('okx|swap|okxCarrySnapshot|ETHUSDT|1778113666169')
    expect(row.rawPayloadHash).toHaveLength(64)
    expect(row.normalizedPayloadHash).toHaveLength(64)
  })
})
