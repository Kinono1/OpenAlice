import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewsCollectorStore } from '../store.js'
import type { NewsRecord } from '../types.js'
import { NewsCollector } from './rss.js'
import { fetchAndParseFeed } from './rss-parser.js'

vi.mock('./rss-parser.js', () => ({
  fetchAndParseFeed: vi.fn(),
}))

const mockFetchAndParseFeed = vi.mocked(fetchAndParseFeed)

describe('NewsCollector', () => {
  let root: string
  let logPath: string
  let store: NewsCollectorStore

  beforeEach(async () => {
    root = join(tmpdir(), `openalice-news-collector-${randomUUID()}`)
    logPath = join(root, 'news.jsonl')
    store = new NewsCollectorStore({ logPath, maxInMemory: 100, retentionDays: 7 })
    await store.init()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await store.close()
    await rm(root, { recursive: true, force: true })
  })

  it('records collector round and feed batch metadata for ingested RSS rows', async () => {
    mockFetchAndParseFeed
      .mockResolvedValueOnce([
        {
          title: 'BTC funding rises',
          content: 'Funding moved higher.',
          link: 'https://example.invalid/btc',
          guid: 'btc-1',
          pubDate: new Date('2026-05-04T00:00:00Z'),
        },
      ])
      .mockResolvedValueOnce([
        {
          title: 'ETH liquidity improves',
          content: 'Depth improved.',
          link: 'https://example.invalid/eth',
          guid: 'eth-1',
          pubDate: new Date('2026-05-04T00:01:00Z'),
        },
      ])

    const collector = new NewsCollector({
      store,
      intervalMs: 60_000,
      feeds: [
        { name: 'Feed A', url: 'https://example.invalid/a.xml', source: 'feed-a', categories: ['crypto'] },
        { name: 'Feed B', url: 'https://example.invalid/b.xml', source: 'feed-b' },
      ],
    })

    await expect(collector.fetchAll()).resolves.toEqual({ total: 2, new: 2 })

    const records = (await readFile(logPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as NewsRecord)

    expect(records).toHaveLength(2)
    const [first, second] = records
    expect(first.metadata.collectorRoundId).toEqual(second.metadata.collectorRoundId)
    expect(first.metadata.feedBatchId).not.toEqual(second.metadata.feedBatchId)
    expect(first.metadata.ingestedAt).toEqual(expect.any(String))
    expect(second.metadata.ingestedAt).toEqual(expect.any(String))
    expect(Date.parse(first.metadata.ingestedAt ?? '')).not.toBeNaN()
    expect(first.metadata).toMatchObject({
      source: 'feed-a',
      ingestSource: 'rss',
      dedupKey: 'guid:btc-1',
      categories: 'crypto',
    })
    expect(second.metadata).toMatchObject({
      source: 'feed-b',
      ingestSource: 'rss',
      dedupKey: 'guid:eth-1',
    })
  })
})
