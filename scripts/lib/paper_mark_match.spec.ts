import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearPaperMarkMatchSnapshotCacheForTest,
  findLatestPitSafeMarkSnapshot,
  normalizeBinanceUsdmSymbol,
  resolvePaperMarkMatchOpenFields,
} from './paper_mark_match.js'

describe('paper_mark_match', () => {
  afterEach(() => {
    delete process.env.OPENALICE_EXTERNAL_DERIVATIVES_EVENTS_PATH
    clearPaperMarkMatchSnapshotCacheForTest()
  })

  it('normalizes paper symbols to Binance USD-M symbols', () => {
    expect(normalizeBinanceUsdmSymbol('BTC-USDT')).toBe('BTCUSDT')
    expect(normalizeBinanceUsdmSymbol('eth/usdt')).toBe('ETHUSDT')
    expect(normalizeBinanceUsdmSymbol('SOL_USDT')).toBe('SOLUSDT')
  })

  it('uses the latest PIT-safe premiumIndex mark and computes bps over mark price', async () => {
    const path = await writeEvents([
      premiumRow({
        symbol: 'BTCUSDT',
        sourceTimestamp: '2026-05-02T00:00:00.000Z',
        fetchTimestamp: '2026-05-02T00:00:01.000Z',
        ingestedAt: '2026-05-02T00:00:02.000Z',
        markPrice: '99',
      }),
      premiumRow({
        symbol: 'BTCUSDT',
        sourceTimestamp: '2026-05-02T00:03:00.000Z',
        fetchTimestamp: '2026-05-02T00:03:01.000Z',
        ingestedAt: '2026-05-02T00:03:02.000Z',
        markPrice: '100',
      }),
      premiumRow({
        symbol: 'BTCUSDT',
        sourceTimestamp: '2026-05-02T00:04:00.000Z',
        fetchTimestamp: '2026-05-02T00:05:01.000Z',
        ingestedAt: '2026-05-02T00:05:02.000Z',
        markPrice: '101',
      }),
    ])

    const fields = resolvePaperMarkMatchOpenFields({
      symbol: 'BTC-USDT',
      decisionTime: '2026-05-02T00:05:00.000Z',
      matchPrice: 101,
      externalEventsPath: path,
    })

    expect(fields).toMatchObject({
      markPriceAtOpen: 100,
      markPriceTimestampAtOpen: '2026-05-02T00:03:00.000Z',
      matchPriceAtOpen: 101,
      matchPriceSourceAtOpen: 'simulated_fill',
      markMatchPenaltyBpsAtOpen: 100,
      markMatchStatusAtOpen: 'ok',
    })
  })

  it('rejects stale, future-fetched, invalid, and missing marks with conservative fallback', async () => {
    const path = await writeEvents([
      premiumRow({
        symbol: 'ETHUSDT',
        sourceTimestamp: '2026-05-02T00:00:00.000Z',
        fetchTimestamp: '2026-05-02T00:00:01.000Z',
        ingestedAt: '2026-05-02T00:00:02.000Z',
        markPrice: '100',
      }),
      premiumRow({
        symbol: 'ETHUSDT',
        sourceTimestamp: '2026-05-02T00:07:00.000Z',
        fetchTimestamp: '2026-05-02T00:08:01.000Z',
        ingestedAt: '2026-05-02T00:08:02.000Z',
        markPrice: '101',
      }),
    ])

    expect(resolvePaperMarkMatchOpenFields({
      symbol: 'ETH-USDT',
      decisionTime: '2026-05-02T00:20:01.000Z',
      matchPrice: 101,
      externalEventsPath: path,
    })).toMatchObject({
      markPriceAtOpen: null,
      markMatchPenaltyBpsAtOpen: 15,
      markMatchStatusAtOpen: 'stale_or_missing',
    })

    expect(findLatestPitSafeMarkSnapshot({
      symbol: 'ETH-USDT',
      decisionMs: Date.parse('2026-05-02T00:08:00.000Z'),
      externalEventsPath: path,
    })?.markPrice).toBe(100)

    expect(resolvePaperMarkMatchOpenFields({
      symbol: 'ETH-USDT',
      decisionTime: '2026-05-02T00:08:00.000Z',
      matchPrice: 0,
      externalEventsPath: path,
    })).toMatchObject({
      matchPriceAtOpen: null,
      markMatchStatusAtOpen: 'invalid',
    })

    expect(resolvePaperMarkMatchOpenFields({
      symbol: 'DOGE-USDT',
      decisionTime: '2026-05-02T00:08:00.000Z',
      matchPrice: 100,
      externalEventsPath: path,
    })).toMatchObject({
      markPriceAtOpen: null,
      markMatchStatusAtOpen: 'stale_or_missing',
    })
  })

  it('rejects stale external mark indexes before PIT lookup', async () => {
    const path = await writeEvents([
      premiumRow({
        symbol: 'BTCUSDT',
        sourceTimestamp: '2026-05-02T00:04:00.000Z',
        fetchTimestamp: '2026-05-02T00:04:02.000Z',
        ingestedAt: '2026-05-02T00:04:03.000Z',
        markPrice: '100',
      }),
    ])
    const staleMtime = new Date('2026-05-02T00:00:00.000Z')
    await utimes(path, staleMtime, staleMtime)

    expect(resolvePaperMarkMatchOpenFields({
      symbol: 'BTC-USDT',
      decisionTime: '2026-05-02T00:05:00.000Z',
      indexFreshnessNow: '2026-05-02T00:16:00.001Z',
      matchPrice: 101,
      externalEventsPath: path,
      maxIndexAgeMs: 15 * 60 * 1000,
    })).toMatchObject({
      markPriceAtOpen: null,
      markMatchPenaltyBpsAtOpen: 15,
      markMatchStatusAtOpen: 'stale_or_missing',
    })

    expect(resolvePaperMarkMatchOpenFields({
      symbol: 'BTC-USDT',
      decisionTime: '2026-05-02T00:05:00.000Z',
      indexFreshnessNow: '2026-05-02T00:14:59.999Z',
      matchPrice: 101,
      externalEventsPath: path,
      maxIndexAgeMs: 15 * 60 * 1000,
    })).toMatchObject({
      markPriceAtOpen: 100,
      markMatchPenaltyBpsAtOpen: 100,
      markMatchStatusAtOpen: 'ok',
    })
  })
})

async function writeEvents(rows: Array<Record<string, unknown>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paper-mark-match-'))
  await mkdir(root, { recursive: true })
  const path = join(root, 'events.jsonl')
  await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf-8')
  return path
}

function premiumRow(input: {
  symbol: string
  sourceTimestamp: string
  fetchTimestamp: string
  ingestedAt: string
  markPrice: string
}): Record<string, unknown> {
  return {
    schemaVersion: 'external_derivatives_event.v1',
    exchange: 'binance',
    market: 'usdm',
    symbol: input.symbol,
    sourceEndpoint: '/fapi/v1/premiumIndex',
    sourceTimestamp: input.sourceTimestamp,
    sourceTimestampBasis: 'exchange_event',
    fetchTimestamp: input.fetchTimestamp,
    payloadReceivedAt: input.fetchTimestamp,
    ingestedAt: input.ingestedAt,
    dedupKey: `binance|usdm|premiumIndex|${input.symbol}|${Date.parse(input.sourceTimestamp)}`,
    rawPayloadHash: 'hash',
    payload: {
      symbol: input.symbol,
      markPrice: input.markPrice,
      time: Date.parse(input.sourceTimestamp),
    },
  }
}
