/**
 * Social Media Signals — informal news, sentiment, and whale alerts.
 *
 * Sources:
 *   - Reddit RSS (free, no auth): r/cryptocurrency, r/bitcoin, r/ethereum
 *   - Telegram channel mirrors (RSS bridges, if configured)
 *   - Generic RSS feeds from crypto news aggregators
 *
 * Signal types:
 *   - whale_alert: large transfer detected
 *   - sentiment_spike: sudden change in discussion sentiment
 *   - trending_topic: topic mentioned by multiple sources
 *   - fud_detected: fear/uncertainty/doubt spike
 *   - hype_detected: euphoric/excessive bullish sentiment
 */

export type SocialSignalType =
  | 'whale_alert'
  | 'sentiment_spike'
  | 'trending_topic'
  | 'fud_detected'
  | 'hype_detected'
  | 'exchange_incident'
  | 'regulatory_fud'
  | 'influencer_call'

export interface SocialSignal {
  type: SocialSignalType
  title: string
  content: string
  source: string
  url: string | null
  timestamp: number
  /** Sentiment score [-1, 1] where -1 = extreme fear, +1 = extreme greed */
  sentimentScore: number
  /** Relevance to crypto markets [0, 1] */
  relevanceScore: number
  /** Estimated market impact [0, 1] */
  impactScore: number
}

export interface SocialSignalConfig {
  /** Reddit subreddits to monitor */
  redditSubreddits?: string[]
  /** Minimum relevance score to include signal */
  minRelevance?: number
  /** Lookback window in hours */
  lookbackHours?: number
}

const DEFAULT_CONFIG: Required<SocialSignalConfig> = {
  redditSubreddits: ['cryptocurrency', 'bitcoin', 'ethereum', 'CryptoCurrency', 'defi'],
  minRelevance: 0.3,
  lookbackHours: 12,
}

const REDDIT_RSS = 'https://www.reddit.com/r/SUBREDDIT/new/.rss?limit=25'

// ==================== Keyword-Based Signal Detection ====================

const WHALE_PATTERNS = [
  /\b(\d+[,\d]*)\s*(BTC|ETH|bitcoin|ethereum)\b.*\b(moved|transferred|sent|withdrawn|deposited)\b/i,
  /\b(whale|large transfer|massive|mega)\b.*\b(BTC|ETH|bitcoin|ethereum|USDT|USDC)\b/i,
  /\b(whale alert|whale watch|whale movement)\b/i,
  /\b(institutional|institution)\b.*\b(buy|buying|purchased|acquired|accumulated)\b/i,
]

const FUD_PATTERNS = [
  /\b(crash|collapsing|plummet|plunge|dump|panic|fear)\b/i,
  /\b(ban|banned|illegal|criminal|crackdown|enforcement|arrested)\b/i,
  /\b(hacked|hack|exploit|exploited|vulnerability|breach|stolen)\b/i,
  /\b(delist|delisted|suspension|halted|frozen|locked)\b/i,
  /\b(rug pull|scam|ponzi|fraud|phishing)\b/i,
]

const HYPE_PATTERNS = [
  /\b(moon|moonshot|parabolic|to the moon|100x|1000x|millionaire)\b/i,
  /\b(bull run|bull market|super cycle|supercycle|ATH|all.time.high)\b/i,
  /\b(everyone.*buy|don't miss|FOMO|fear.of.missing|get in now)\b/i,
  /\b(guaranteed|definitely.*pump|about to explode|next big thing)\b/i,
  /\b(gem|hidden gem|undervalued gem|sleeping giant)\b/i,
]

const REGULATORY_PATTERNS = [
  /\b(SEC|CFTC|FED|Federal Reserve|Treasury|Congress|regulated|regulation)\b/i,
  /\b(lawsuit|sued|sue|litigation|court|ruling|judge|verdict)\b/i,
  /\b(ETF|exchange.traded fund|filing|approval|approved|rejected|denied)\b/i,
  /\b(KYC|AML|compliance|sanction|sanctioned|blacklist|blacklisted)\b/i,
]

const EXCHANGE_INCIDENT_PATTERNS = [
  /\b(binance|bybit|okx|coinbase|kraken|kucoin|gate|bitget)\b.*\b(hack|down|outage|suspends|halt|freeze|insolvent)\b/i,
  /\b(exchange)\b.*\b(hacked|down|offline|breach|lost|stolen)\b/i,
]

const INFLUENCER_PATTERNS = [
  /\b(elon musk|CZ|changpeng|vitalik|saylor|michael saylor|jack dorsey|brian armstrong)\b/i,
  /\b(tweeted|tweet|said|announced|revealed|confirmed|stated)\b/i,
]

// ==================== Sentiment Analysis ====================

const BULLISH_WORDS = [
  'bullish', 'buy', 'long', 'surge', 'rally', 'soar', 'pump', 'gain', 'growth',
  'adoption', 'partnership', 'launch', 'upgrade', 'breakthrough', 'support',
  'accumulation', 'undervalued', 'opportunity', 'positive', 'optimistic',
  '涨', '利好', '突破', '起飞', '翻倍', '牛市',
]

const BEARISH_WORDS = [
  'bearish', 'sell', 'short', 'dump', 'crash', 'plunge', 'decline', 'loss',
  'risk', 'warning', 'correction', 'bubble', 'overvalued', 'manipulation',
  'distribution', 'exit scam', 'negative', 'pessimistic', 'caution',
  '跌', '利空', '暴跌', '崩盘', '熊市', '割肉',
]

function computeSentiment(text: string): number {
  const lower = text.toLowerCase()
  let bullish = 0
  let bearish = 0

  for (const word of BULLISH_WORDS) {
    if (lower.includes(word)) bullish++
  }
  for (const word of BEARISH_WORDS) {
    if (lower.includes(word)) bearish++
  }

  const total = bullish + bearish
  if (total === 0) return 0
  return (bullish - bearish) / total
}

function computeRelevance(text: string): number {
  const cryptoKeywords = [
    'btc', 'eth', 'bitcoin', 'ethereum', 'crypto', 'blockchain', 'defi',
    'token', 'nft', 'mining', 'wallet', 'exchange', 'trading', 'altcoin',
    'stablecoin', 'layer', 'metaverse', 'web3', 'solana', 'binance',
  ]
  const lower = text.toLowerCase()
  const hits = cryptoKeywords.filter(k => lower.includes(k)).length
  return Math.min(hits / 5, 1)
}

function detectSignalType(title: string, content: string): SocialSignalType[] {
  const text = `${title} ${content}`
  const types: SocialSignalType[] = []

  if (WHALE_PATTERNS.some(p => p.test(text))) types.push('whale_alert')
  if (FUD_PATTERNS.some(p => p.test(text))) types.push('fud_detected')
  if (HYPE_PATTERNS.some(p => p.test(text))) types.push('hype_detected')
  if (REGULATORY_PATTERNS.some(p => p.test(text))) types.push('regulatory_fud')
  if (EXCHANGE_INCIDENT_PATTERNS.some(p => p.test(text))) types.push('exchange_incident')
  if (INFLUENCER_PATTERNS.some(p => p.test(text))) types.push('influencer_call')

  // Trending topic: if no specific type but high relevance
  if (types.length === 0 && computeRelevance(text) > 0.6) {
    types.push('trending_topic')
  }

  return types
}

// ==================== RSS Fetching ====================

export interface ParsedFeedItem {
  title: string
  content: string
  link: string | null
  pubDate: Date | null
}

async function fetchRedditRSS(subreddit: string): Promise<ParsedFeedItem[]> {
  const url = REDDIT_RSS.replace('SUBREDDIT', subreddit)
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'OpenAlice/1.0 SocialSignals' },
    })
    if (!res.ok) return []
    const xml = await res.text()

    const items: ParsedFeedItem[] = []
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
    const itemRegex = /<item>([\s\S]*?)<\/item>/g

    for (const match of xml.matchAll(entryRegex)) {
      items.push(parseEntry(match[1]))
    }
    for (const match of xml.matchAll(itemRegex)) {
      items.push(parseItem(match[1]))
    }

    return items
  } catch {
    return []
  }
}

function parseEntry(xml: string): ParsedFeedItem {
  return {
    title: extractTag(xml, 'title') ?? '',
    content: extractTag(xml, 'content') ?? extractTag(xml, 'summary') ?? '',
    link: extractAttr(xml, 'link', 'href'),
    pubDate: parseDate(extractTag(xml, 'published') ?? extractTag(xml, 'updated')),
  }
}

function parseItem(xml: string): ParsedFeedItem {
  return {
    title: extractTag(xml, 'title') ?? '',
    content: extractTag(xml, 'description') ?? '',
    link: extractTag(xml, 'link'),
    pubDate: parseDate(extractTag(xml, 'pubDate')),
  }
}

function extractTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const match = regex.exec(xml)
  if (!match) return null
  // Strip CDATA and HTML
  return match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim()
}

function extractAttr(xml: string, tag: string, attr: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*${attr}\\s*=\\s*["']([^"']+)["']`, 'i')
  const match = regex.exec(xml)
  return match?.[1] ?? null
}

function parseDate(value: string | null): Date | null {
  if (!value) return null
  const d = new Date(value)
  return isNaN(d.getTime()) ? null : d
}

// ==================== Main Signal Collection ====================

export interface SocialSignalResult {
  signals: SocialSignal[]
  summary: {
    totalSources: number
    totalSignals: number
    dominantSentiment: 'fear' | 'neutral' | 'greed'
    sentimentScore: number
    topSignals: SocialSignalType[]
    fudCount: number
    hypeCount: number
    whaleAlertCount: number
    influencerCount: number
  }
}

export async function collectSocialSignals(
  config: SocialSignalConfig = {},
): Promise<SocialSignalResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const now = Date.now()
  const windowMs = cfg.lookbackHours * 3600_000
  const signals: SocialSignal[] = []

  // Fetch Reddit RSS for each subreddit
  for (const subreddit of cfg.redditSubreddits) {
    const items = await fetchRedditRSS(subreddit)
    for (const item of items) {
      if (!item.pubDate || now - item.pubDate.getTime() > windowMs) continue

      const text = `${item.title} ${item.content}`
      const relevance = computeRelevance(text)
      if (relevance < cfg.minRelevance) continue

      const sentiment = computeSentiment(text)
      const types = detectSignalType(item.title, item.content)
      const impact = calculateImpact(types, relevance, Math.abs(sentiment))

      for (const type of types) {
        signals.push({
          type,
          title: item.title,
          content: item.content.slice(0, 500),
          source: `reddit.com/r/${subreddit}`,
          url: item.link,
          timestamp: item.pubDate.getTime(),
          sentimentScore: sentiment,
          relevanceScore: relevance,
          impactScore: impact,
        })
      }
    }
  }

  // Sort by impact (highest first)
  signals.sort((a, b) => b.impactScore - a.impactScore)

  // Summary
  const sentimentScores = signals.map(s => s.sentimentScore)
  const avgSentiment = sentimentScores.length > 0
    ? sentimentScores.reduce((s, v) => s + v, 0) / sentimentScores.length
    : 0

  const typeCounts = new Map<SocialSignalType, number>()
  for (const s of signals) typeCounts.set(s.type, (typeCounts.get(s.type) ?? 0) + 1)

  const typeRanking = [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type]) => type)

  return {
    signals,
    summary: {
      totalSources: new Set(signals.map(s => s.source)).size,
      totalSignals: signals.length,
      dominantSentiment: avgSentiment < -0.2 ? 'fear' : avgSentiment > 0.2 ? 'greed' : 'neutral',
      sentimentScore: avgSentiment,
      topSignals: typeRanking,
      fudCount: typeCounts.get('fud_detected') ?? 0,
      hypeCount: typeCounts.get('hype_detected') ?? 0,
      whaleAlertCount: typeCounts.get('whale_alert') ?? 0,
      influencerCount: typeCounts.get('influencer_call') ?? 0,
    },
  }
}

function calculateImpact(types: SocialSignalType[], relevance: number, sentimentMag: number): number {
  let base = relevance * 0.5 + sentimentMag * 0.5
  for (const type of types) {
    switch (type) {
      case 'whale_alert': base *= 1.4; break
      case 'exchange_incident': base *= 1.5; break
      case 'regulatory_fud': base *= 1.3; break
      case 'influencer_call': base *= 1.2; break
      case 'fud_detected': base *= 1.15; break
      case 'hype_detected': base *= 1.1; break
    }
  }
  return Math.min(base, 1)
}

// ==================== Integration with News Gate ====================

/**
 * Combine formal news impact with social signals into a unified risk decision.
 * Social signals act as an amplifier/confirmer, not a primary source.
 */
export function combineNewsAndSocialRisk(
  newsRiskRegime: 'normal' | 'elevated' | 'severe',
  newsHardVeto: boolean,
  socialSummary: SocialSignalResult['summary'],
): {
  riskRegime: 'normal' | 'elevated' | 'severe'
  hardVeto: boolean
  reason: string
} {
  // Social signals confirm/amplify formal news
  const socialFearFactor =
    (socialSummary.fudCount * 2 + socialSummary.whaleAlertCount * 3) / Math.max(socialSummary.totalSignals, 1)

  // Upgrade risk if social signals show strong fear
  if (newsRiskRegime === 'normal' && socialSummary.dominantSentiment === 'fear' && socialFearFactor > 0.3) {
    return {
      riskRegime: 'elevated',
      hardVeto: false,
      reason: `Social fear detected: fud=${socialSummary.fudCount} whale=${socialSummary.whaleAlertCount}`,
    }
  }

  // Upgrade to severe if formal news is elevated AND social is panicking
  if (newsRiskRegime === 'elevated' && socialSummary.dominantSentiment === 'fear' && socialFearFactor > 0.5) {
    return {
      riskRegime: 'severe',
      hardVeto: true,
      reason: `Formal elevated risk + social panic: fud=${socialSummary.fudCount} sentiment=${socialSummary.sentimentScore.toFixed(2)}`,
    }
  }

  // Downgrade if formal news is severe but social is not confirming
  if (newsRiskRegime === 'severe' && socialSummary.dominantSentiment !== 'fear' && newsHardVeto) {
    // Social data unavailable (Reddit blocked etc.) — allow trading with reduced size
    if (socialSummary.totalSignals === 0) {
      return {
        riskRegime: 'elevated',
        hardVeto: false,
        reason: 'Formal severe risk (social data unavailable, trading at reduced exposure)',
      }
    }
    return {
      riskRegime: 'severe',
      hardVeto: true,
      reason: 'Formal severe risk maintained (social not confirming but formal threshold met)',
    }
  }

  return {
    riskRegime: newsRiskRegime,
    hardVeto: newsHardVeto,
    reason: `Formal=${newsRiskRegime} social=${socialSummary.dominantSentiment}`,
  }
}
