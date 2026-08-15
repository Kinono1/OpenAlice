import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultOkxMarketDataConfig } from '../../src/domain/market-data/okx-market-data-config.js'
import { isUsdtQuotedPublicInstrument, mapRateLimited, runOkxCollector } from './okx_collector_common.js'

describe('OKX public instrument currency filtering', () => {
  it('uses quote currency for spot and settlement currency for derivatives', () => {
    expect(isUsdtQuotedPublicInstrument({ instrumentType: 'SPOT', quoteCurrency: 'USDT', settleCurrency: null })).toBe(true)
    expect(isUsdtQuotedPublicInstrument({ instrumentType: 'SWAP', quoteCurrency: null, settleCurrency: 'USDT' })).toBe(true)
    expect(isUsdtQuotedPublicInstrument({ instrumentType: 'FUTURES', quoteCurrency: null, settleCurrency: 'USDT' })).toBe(true)
    expect(isUsdtQuotedPublicInstrument({ instrumentType: 'SWAP', quoteCurrency: 'USDT', settleCurrency: 'USD' })).toBe(false)
  })
})

describe('mapRateLimited', () => {
  it('preserves input order while processing bounded batches', async () => {
    const seen: number[] = []
    const result = await mapRateLimited([1, 2, 3, 4, 5], 2, 0, async value => { seen.push(value); return value * 10 })
    expect(result).toEqual([10, 20, 30, 40, 50])
    expect(seen).toEqual([1, 2, 3, 4, 5])
  })
})

describe('runOkxCollector lock', () => {
  it('returns skipped_lock_held without fetching when the task lock is live', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-collector-lock-'))
    const dataRoot = join(root, 'data')
    const config = { ...defaultOkxMarketDataConfig(), enabled: true, dataRoot }
    const configPath = join(root, 'config.json')
    const lockPath = join(dataRoot, 'runtime', 'locks', 'lock-test.collector.lock')
    await mkdir(join(dataRoot, 'runtime', 'locks'), { recursive: true })
    await writeFile(configPath, `${JSON.stringify(config)}\n`)
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid })}\n`)
    let fetched = false
    const report = await runOkxCollector({
      task: 'lock-test', runId: 'lock-test-run', configPath, pressureClass: 'essential',
      fetchEvents: async () => { fetched = true; return { events: [] } },
    })
    expect(fetched).toBe(false)
    expect(report).toMatchObject({ status: 'blocked', collectorLockStatus: 'skipped_lock_held', blockers: ['skipped_lock_held'] })
  })
})
