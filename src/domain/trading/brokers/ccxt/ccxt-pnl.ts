const REALIZED_PNL_KEYS = [
  'todayRealizedPnl',
  'dailyRealizedPnl',
  'totalRealizedPnl',
  'totalRealisedPnl',
  'cumRealizedPnl',
  'cumRealisedPnl',
  'realizedPnl',
  'realisedPnl',
  'realizedProfit',
  'realisedProfit',
  'closedPnl',
  'closed_pnl',
  'pnl',
  'realized_pl',
  'realised_pl',
] as const

interface NumericMatch {
  depth: number
  value: number
}

interface MatchByKey {
  value: number
  key: string
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/,/g, '')
    if (!normalized) return undefined
    const parsed = Number(normalized)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function collectKeyMatches(
  node: unknown,
  key: string,
  depth: number,
  visited: Set<unknown>,
  matches: NumericMatch[],
): void {
  if (!node || typeof node !== 'object') return
  if (visited.has(node)) return
  visited.add(node)

  if (Array.isArray(node)) {
    for (const item of node) {
      collectKeyMatches(item, key, depth + 1, visited, matches)
    }
    return
  }

  const record = node as Record<string, unknown>
  const own = parseFiniteNumber(record[key])
  if (own !== undefined) {
    matches.push({ depth, value: own })
  }

  for (const child of Object.values(record)) {
    if (child && typeof child === 'object') {
      collectKeyMatches(child, key, depth + 1, visited, matches)
    }
  }
}

function findBestMatchByKey(payload: unknown, key: string): number | undefined {
  const matches: NumericMatch[] = []
  collectKeyMatches(payload, key, 0, new Set<unknown>(), matches)
  if (matches.length === 0) return undefined

  const minDepth = Math.min(...matches.map((m) => m.depth))
  const values = matches.filter((m) => m.depth === minDepth).map((m) => m.value)
  return values.length === 1 ? values[0] : values.reduce((sum, value) => sum + value, 0)
}

function findBestMatch(payload: unknown): MatchByKey | null {
  for (const key of REALIZED_PNL_KEYS) {
    const match = findBestMatchByKey(payload, key)
    if (match !== undefined) {
      return { value: match, key }
    }
  }
  return null
}

export interface RealizedPnlExtractionResult {
  realizedPnl: number
  found: boolean
  matchedKey?: string
}

export function extractRealizedPnlDetailsFromBalancePayload(
  payload: unknown,
): RealizedPnlExtractionResult {
  const match = findBestMatch(payload)
  if (match) {
    return {
      realizedPnl: match.value,
      found: true,
      matchedKey: match.key,
    }
  }
  return { realizedPnl: 0, found: false }
}

export interface RealizedPnlLedgerExtractionResult {
  realizedPnl: number
  found: boolean
  matchedTradeCount: number
}

function extractTradeRealizedPnl(trade: unknown): number | undefined {
  if (!trade || typeof trade !== 'object') return undefined
  const record = trade as Record<string, unknown>
  const direct = findBestMatch(record)
  if (direct) return direct.value

  const info = record.info
  const fromInfo = findBestMatch(info)
  if (fromInfo) return fromInfo.value

  return undefined
}

export function extractRealizedPnlDetailsFromClosedTradesLedger(
  trades: unknown,
): RealizedPnlLedgerExtractionResult {
  if (!Array.isArray(trades)) {
    return { realizedPnl: 0, found: false, matchedTradeCount: 0 }
  }

  let sum = 0
  let matchedTradeCount = 0
  for (const trade of trades) {
    const pnl = extractTradeRealizedPnl(trade)
    if (typeof pnl === 'number' && Number.isFinite(pnl)) {
      sum += pnl
      matchedTradeCount++
    }
  }

  return {
    realizedPnl: matchedTradeCount > 0 ? sum : 0,
    found: matchedTradeCount > 0,
    matchedTradeCount,
  }
}

export function extractRealizedPnlFromBalancePayload(payload: unknown): number {
  return extractRealizedPnlDetailsFromBalancePayload(payload).realizedPnl
}
