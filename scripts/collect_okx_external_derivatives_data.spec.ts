import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildOkxDedupKey, collectOkxExternalDerivatives, parseOkxExternalCollectArgs, type FetchLike } from './collect_okx_external_derivatives_data.js'

function fixtures(map: Map<string, unknown>): FetchLike {
  return async url => ({ ok: map.has(url), status: map.has(url) ? 200 : 404, text: async () => JSON.stringify(map.get(url) ?? { code: '404', msg: 'missing' }) })
}

describe('collect_okx_external_derivatives_data', () => {
  it('defaults the production CLI to OKX and local runtime storage', () => {
    expect(parseOkxExternalCollectArgs(['--dryRun', 'true'])).toMatchObject({
      host: 'https://www.okx.com',
      symbols: [],
      symbolMode: 'all_active_stablecoin_swaps',
      endpoints: ['fundingRate', 'premiumIndex', 'openInterest', 'openInterestHist', 'longShort'],
      symbolBatchSize: 25,
      outputPath: expect.stringMatching(/data\/external\/derivatives\/okx_swap_derivatives_events\.jsonl$/),
      checkpointPath: expect.stringMatching(/data\/runtime\/external_derivatives_data_collect\.checkpoint\.json$/),
    })
  })

  it('includes venue and instrument id in dedup keys', () => {
    expect(buildOkxDedupKey({ endpoint: 'fundingRate', symbol: 'ETHUSDT', instrumentId: 'ETH-USDT-SWAP', period: '5m', timestamp: 1 }))
      .toBe('okx|swap|fundingRate|ETHUSDT|ETH-USDT-SWAP|5m|1')
  })

  it('collects all five normalized endpoint families and deduplicates a repeated run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'okx-external-'))
    const host = 'https://www.okx.com'
    const fixtureMap = new Map<string, unknown>([
      [`${host}/api/v5/public/funding-rate-history?instId=ETH-USDT-SWAP&limit=100`, { code: '0', data: [{ instId: 'ETH-USDT-SWAP', fundingRate: '0.0001', fundingTime: '1800000000000' }] }],
      [`${host}/api/v5/public/mark-price?instType=SWAP&instId=ETH-USDT-SWAP`, { code: '0', data: [{ instId: 'ETH-USDT-SWAP', markPx: '3201', ts: '1800000000100' }] }],
      [`${host}/api/v5/market/index-tickers?instId=ETH-USDT`, { code: '0', data: [{ instId: 'ETH-USDT', idxPx: '3200', ts: '1800000000200' }] }],
      [`${host}/api/v5/public/open-interest?instType=SWAP&instId=ETH-USDT-SWAP`, { code: '0', data: [{ instId: 'ETH-USDT-SWAP', oi: '10', oiCcy: '1', oiUsd: '32000', ts: '1800000000300' }] }],
      [`${host}/api/v5/rubik/stat/contracts/open-interest-volume?ccy=ETH&period=5m`, { code: '0', data: [['1800000000000', '30000', '2000']] }],
      [`${host}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=ETH&period=5m`, { code: '0', data: [['1800000000000', '1.2']] }],
    ])
    const args = {
      symbols: ['ETHUSDT'], endpoints: ['fundingRate', 'premiumIndex', 'openInterest', 'openInterestHist', 'longShort'] as const,
      period: '5m', outputPath: join(root, 'events.jsonl'), reportPath: join(root, 'latest.json'), runLedgerPath: join(root, 'runs.jsonl'),
      lockDir: join(root, 'lock'), host, fetchTimeoutMs: 1_000, maxRetries: 1, dryRun: false, json: true,
    }
    const first = await collectOkxExternalDerivatives(args, fixtures(fixtureMap))
    const second = await collectOkxExternalDerivatives(args, fixtures(fixtureMap))
    expect(first).toMatchObject({ venue: 'okx', fetchedRows: 5, appendedRows: 5, errors: [] })
    expect(second).toMatchObject({ fetchedRows: 5, appendedRows: 0, skippedDuplicateRows: 5, errors: [] })
    const rows = (await readFile(args.outputPath, 'utf-8')).trim().split('\n').map(line => JSON.parse(line))
    expect(rows).toHaveLength(5)
    expect(rows.every(row => row.exchange === 'okx' && row.market === 'swap' && row.instrumentId === 'ETH-USDT-SWAP')).toBe(true)
    expect(rows.map(row => row.sourceEndpoint)).toEqual(expect.arrayContaining([
      '/api/v5/public/funding-rate-history',
      '/api/v5/public/mark-price+/api/v5/market/index-tickers',
      '/api/v5/public/open-interest',
      '/api/v5/rubik/stat/contracts/open-interest-volume',
      '/api/v5/rubik/stat/contracts/long-short-account-ratio',
    ]))
    const reportRaw = await readFile(args.reportPath, 'utf-8')
    const latest = JSON.parse(reportRaw)
    const manifest = JSON.parse(await readFile(`${args.reportPath}.manifest.json`, 'utf-8'))
    expect(latest.evidenceManifest).toMatchObject({
      manifestPath: `${args.reportPath}.manifest.json`,
      evidenceTrust: expect.stringMatching(/^(pass|quarantine)$/),
      dqStatus: expect.stringMatching(/^(pass|quarantine)$/),
      businessStatus: 'pass',
      exitCode: 0,
    })
    expect(manifest.artifactHash).toBe(createHash('sha256').update(reportRaw).digest('hex'))
  })

  it('does not retry permanent HTTP 451 errors', async () => {
    let calls = 0
    const fetch: FetchLike = async () => { calls += 1; return { ok: false, status: 451, text: async () => 'restricted' } }
    const root = await mkdtemp(join(tmpdir(), 'okx-external-'))
    const report = await collectOkxExternalDerivatives({
      symbols: ['ETHUSDT'], endpoints: ['fundingRate'], period: '5m', outputPath: join(root, 'events.jsonl'), reportPath: join(root, 'latest.json'),
      runLedgerPath: join(root, 'runs.jsonl'), lockDir: join(root, 'lock'), host: 'https://www.okx.com', fetchTimeoutMs: 1_000, maxRetries: 3, dryRun: true, json: true,
    }, fetch)
    expect(calls).toBe(1)
    expect(report.errors[0]).toMatchObject({ errorClass: 'http_permanent', permanent: true })
  })

  it('records unsupported Rubik metrics without failing the usable symbol batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'okx-external-'))
    const host = 'https://www.okx.com'
    const fetch: FetchLike = async url => {
      if (url.includes('/funding-rate-history')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: '0', data: [{ instId: 'AI-USDT-SWAP', fundingRate: '0.0001', fundingTime: '1800000000000' }] }) }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: '51012', msg: 'Token does not exist', data: [] }) }
    }
    const report = await collectOkxExternalDerivatives({
      symbols: ['AIUSDT'], endpoints: ['fundingRate', 'openInterestHist', 'longShort'], period: '5m',
      outputPath: join(root, 'events.jsonl'), reportPath: join(root, 'latest.json'), runLedgerPath: join(root, 'runs.jsonl'),
      lockDir: join(root, 'lock'), host, fetchTimeoutMs: 1_000, maxRetries: 1, dryRun: false, json: true,
    }, fetch)

    expect(report).toMatchObject({ fetchedRows: 1, appendedRows: 1, errors: [] })
    expect(report.unavailableEndpoints).toEqual([
      expect.objectContaining({ symbol: 'AIUSDT', endpoint: 'openInterestHist', errorClass: 'metric_not_available', permanent: true }),
      expect.objectContaining({ symbol: 'AIUSDT', endpoint: 'longShort', errorClass: 'metric_not_available', permanent: true }),
    ])
    expect(report.endpointDiagnostics.filter(item => item.status === 'unavailable')).toHaveLength(2)
    expect(report.evidenceManifest?.exitCode).toBe(0)
    expect(report.evidenceManifest?.businessStatus).toBe('warn')
  })

  it('discovers every active USDT/USDC swap and persists a checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'okx-external-'))
    const host = 'https://www.okx.com'
    const fixtureMap = new Map<string, unknown>([
      [`${host}/api/v5/public/instruments?instType=SWAP`, { code: '0', data: [
        { instId: 'BTC-USDT-SWAP', settleCcy: 'USDT', state: 'live' },
        { instId: 'ETH-USDC-SWAP', settleCcy: 'USDC', state: 'live' },
        { instId: 'OLD-USDT-SWAP', settleCcy: 'USDT', state: 'suspend' },
        { instId: 'BTC-USD-SWAP', settleCcy: 'BTC', state: 'live' },
      ] }],
      [`${host}/api/v5/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=100`, { code: '0', data: [{ instId: 'BTC-USDT-SWAP', fundingRate: '0.0001', fundingTime: '1800000000000' }] }],
      [`${host}/api/v5/public/funding-rate-history?instId=ETH-USDC-SWAP&limit=100`, { code: '0', data: [{ instId: 'ETH-USDC-SWAP', fundingRate: '0.0002', fundingTime: '1800000000001' }] }],
    ])
    const checkpointPath = join(root, 'checkpoint.json')
    const report = await collectOkxExternalDerivatives({
      symbols: [], symbolMode: 'all_active_stablecoin_swaps', endpoints: ['fundingRate'], period: '5m',
      outputPath: join(root, 'events.jsonl'), reportPath: join(root, 'latest.json'), runLedgerPath: join(root, 'runs.jsonl'), checkpointPath,
      lockDir: join(root, 'lock'), host, fetchTimeoutMs: 1_000, maxRetries: 1, dryRun: false, json: true,
    }, fixtures(fixtureMap))
    expect(report).toMatchObject({
      symbols: ['BTCUSDT', 'ETHUSDC'], symbolMode: 'all_active_stablecoin_swaps',
      universeSize: 2, symbolBatchSize: 2, batchCursor: 0, nextBatchCursor: 0,
      fetchedRows: 2, appendedRows: 2, errors: [],
    })
    expect(JSON.parse(await readFile(checkpointPath, 'utf-8'))).toMatchObject({
      schemaVersion: 'okx_external_derivatives_checkpoint.v1',
      symbols: ['BTCUSDT', 'ETHUSDC'],
      latestBySeries: {
        'BTC-USDT-SWAP|/api/v5/public/funding-rate-history': '2027-01-15T08:00:00.000Z',
        'ETH-USDC-SWAP|/api/v5/public/funding-rate-history': '2027-01-15T08:00:00.001Z',
      },
      universeSize: 2,
      batchCursor: 0,
      nextBatchCursor: 0,
    })
  })

  it('rotates bounded symbol batches from the persisted checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'okx-external-'))
    const host = 'https://www.okx.com'
    const instruments = ['A-USDT-SWAP', 'B-USDT-SWAP', 'C-USDT-SWAP'].map(instId => ({ instId, settleCcy: 'USDT', state: 'live' }))
    const fixtureMap = new Map<string, unknown>([
      [`${host}/api/v5/public/instruments?instType=SWAP`, { code: '0', data: instruments }],
      ...instruments.map(({ instId }, index) => [
        `${host}/api/v5/public/funding-rate-history?instId=${instId}&limit=100`,
        { code: '0', data: [{ instId, fundingRate: '0.0001', fundingTime: String(1_800_000_000_000 + index) }] },
      ] as [string, unknown]),
    ])
    const checkpointPath = join(root, 'checkpoint.json')
    const args = {
      symbols: [], symbolMode: 'all_active_stablecoin_swaps' as const, endpoints: ['fundingRate'] as const,
      symbolBatchSize: 2, period: '5m', outputPath: join(root, 'events.jsonl'), reportPath: join(root, 'latest.json'),
      runLedgerPath: join(root, 'runs.jsonl'), checkpointPath, lockDir: join(root, 'lock'), host,
      fetchTimeoutMs: 1_000, maxRetries: 1, dryRun: false, json: true,
    }

    const first = await collectOkxExternalDerivatives(args, fixtures(fixtureMap))
    const second = await collectOkxExternalDerivatives(args, fixtures(fixtureMap))

    expect(first).toMatchObject({ symbols: ['AUSDT', 'BUSDT'], universeSize: 3, batchCursor: 0, nextBatchCursor: 2 })
    expect(second).toMatchObject({ symbols: ['CUSDT', 'AUSDT'], universeSize: 3, batchCursor: 2, nextBatchCursor: 1 })
  })
})
