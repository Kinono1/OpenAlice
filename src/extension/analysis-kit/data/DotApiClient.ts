import { readFile, writeFile, mkdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import type { MarketData, NewsItem } from './interfaces'
import {
  mergeInstitutionalNews,
  type MultiSourceNewsConfig,
} from './news-sources.js'

const DEFAULT_API_URL = 'https://dotapi.wond.dev/sandbox/realtime-data'
const API_URL = process.env.REALTIME_DATA_API_URL?.trim() || DEFAULT_API_URL
const CACHE_FILE = resolve('data/cache/realtime-data.json')
let realtimeFeedWarned = false

export interface DotApiResponse {
  currentTime: string
  lastUpdated: string
  marketData: Record<string, MarketData[]>
  news: NewsItem[]
}

interface RawNewsItem {
  time: string
  title: string
  content: string
  metadata: Record<string, string | null>
}

interface CacheEnvelope {
  cachedAt: string
  raw: unknown
}

export interface RealtimeDataFetchOptions {
  news?: MultiSourceNewsConfig
}

function parseRawResponse(raw: any): DotApiResponse {
  const parsedNews: NewsItem[] = Array.isArray(raw?.news)
    ? (raw.news as RawNewsItem[]).map((n) => ({
        ...n,
        time: new Date(n.time),
      }))
    : []

  return {
    ...raw,
    news: parsedNews,
  }
}

async function writeCache(raw: unknown): Promise<void> {
  try {
    await mkdir(dirname(CACHE_FILE), { recursive: true })
    const envelope: CacheEnvelope = { cachedAt: new Date().toISOString(), raw }
    await writeFile(CACHE_FILE, JSON.stringify(envelope, null, 2))
  } catch {
    // cache write failure is non-fatal
  }
}

async function readCache(): Promise<{ cachedAt: string; data: DotApiResponse } | null> {
  try {
    const text = await readFile(CACHE_FILE, 'utf-8')
    const envelope: CacheEnvelope = JSON.parse(text)
    return { cachedAt: envelope.cachedAt, data: parseRawResponse(envelope.raw) }
  } catch {
    return null
  }
}

export async function fetchRealtimeData(
  options?: RealtimeDataFetchOptions,
): Promise<DotApiResponse> {
  if (!realtimeFeedWarned && /\/sandbox\//i.test(API_URL)) {
    realtimeFeedWarned = true
    console.warn(
      `Realtime feed is using sandbox endpoint (${API_URL}). ` +
      'For true real-time trading, prefer direct exchange feed (e.g. OKX WS/REST) and unified execution clock.',
    )
  }
  const mergeNews = async (base: DotApiResponse): Promise<DotApiResponse> => {
    const newsConfig = options?.news
    if (!newsConfig) {
      return base
    }
    try {
      const mergedNews = await mergeInstitutionalNews(base.news, newsConfig)
      return { ...base, news: mergedNews }
    } catch (err) {
      console.warn('multi-source news merge failed, using base feed only:', err)
      return base
    }
  }

  try {
    const res = await fetch(API_URL)
    if (!res.ok) throw new Error(`DotAPI error: ${res.status}`)
    const raw = await res.json()
    await writeCache(raw)
    return await mergeNews(parseRawResponse(raw))
  } catch (err) {
    const cached = await readCache()
    if (cached) {
      console.warn(`DotAPI fetch failed, using cached data from ${cached.cachedAt}`)
      return await mergeNews(cached.data)
    }
    throw err
  }
}
