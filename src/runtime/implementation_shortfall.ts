import { existsSync, readFileSync } from 'node:fs'
import { appendJsonlSync } from './runtime_events.js'
import { writeJsonAtomic } from './atomic_write.js'

export interface ShortfallRecord {
  trade_id: string
  strategy: string
  symbol: string
  side: 'long' | 'short'
  intent_price: number
  fill_price: number
  fill_price_source: string
  bid_at_intent: number
  ask_at_intent: number
  mid_at_intent: number
  spread_bps_at_intent: number
  shortfall_bps: number
  spread_cost_bps: number
  latency_ms: number | null
  intent_at: string
  fill_at: string
  snapshot_age_ms: number
}

export interface ShortfallSummary {
  generated_at: string
  total_intents: number
  matched_fills: number
  unmatched_intents: number
  avg_shortfall_bps: number | null
  median_shortfall_bps: number | null
  avg_spread_cost_bps: number | null
  avg_latency_ms: number | null
  by_strategy: Record<string, {
    intents: number
    fills: number
    avg_shortfall_bps: number | null
  }>
}

const SHORTFALL_EVIDENCE_PATH = 'data/runtime/implementation_shortfall.latest.json'
const SHORTFALL_LEDGER_PATH = 'data/runtime/implementation_shortfall_ledger.jsonl'

interface LedgerIntent {
  type: 'intent'
  trade_id: string
  symbol: string
  side: 'long' | 'short'
  intent_price: number
  bid: number
  ask: number
  mid: number
  spread_bps: number
  snapshot_age_ms: number
  intent_at: string
  strategy: string
}

interface LedgerFill {
  type: 'fill'
  trade_id: string
  fill_price: number
  fill_price_source: string
  fill_at: string
  strategy: string
  shortfall_bps: number
  spread_cost_bps: number
  latency_ms: number | null
}

export function recordIntentEvidence(params: {
  trade_id: string
  symbol: string
  side: 'long' | 'short'
  intent_price: number
  bid: number
  ask: number
  mid: number
  spread_bps: number
  snapshot_age_ms: number
  intent_at: string
  strategy: string
}): void {
  appendJsonlSync(SHORTFALL_LEDGER_PATH, {
    type: 'intent',
    trade_id: params.trade_id,
    symbol: params.symbol,
    side: params.side,
    intent_price: params.intent_price,
    bid: params.bid,
    ask: params.ask,
    mid: params.mid,
    spread_bps: params.spread_bps,
    snapshot_age_ms: params.snapshot_age_ms,
    intent_at: params.intent_at,
    strategy: params.strategy,
  })
}

export function recordFillEvidence(
  tradeId: string,
  fillPrice: number,
  fillPriceSource: string,
  fillAt: string,
  strategy: string,
): ShortfallRecord | null {
  if (!existsSync(SHORTFALL_LEDGER_PATH)) return null

  const raw = readFileSync(SHORTFALL_LEDGER_PATH, 'utf-8')
  const lines = raw.trim().split('\n').filter(Boolean)

  let intent: LedgerIntent | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const record = JSON.parse(lines[i]) as LedgerIntent | LedgerFill
      if (record.type === 'intent' && record.trade_id === tradeId) {
        intent = record as LedgerIntent
        break
      }
    } catch {
      continue
    }
  }

  if (!intent) return null

  const shortfallBps = intent.intent_price > 0
    ? Math.round((fillPrice - intent.intent_price) / intent.intent_price * 10000)
    : 0

  const spreadCostBps = Math.round(intent.spread_bps / 2)

  const intentMs = new Date(intent.intent_at).getTime()
  const fillMs = new Date(fillAt).getTime()
  const latencyMs = Number.isFinite(intentMs) && Number.isFinite(fillMs)
    ? Math.max(0, fillMs - intentMs)
    : null

  appendJsonlSync(SHORTFALL_LEDGER_PATH, {
    type: 'fill',
    trade_id: tradeId,
    fill_price: fillPrice,
    fill_price_source: fillPriceSource,
    fill_at: fillAt,
    strategy,
    shortfall_bps: shortfallBps,
    spread_cost_bps: spreadCostBps,
    latency_ms: latencyMs,
  })

  const shortfallRecord: ShortfallRecord = {
    trade_id: tradeId,
    strategy,
    symbol: intent.symbol,
    side: intent.side,
    intent_price: intent.intent_price,
    fill_price: fillPrice,
    fill_price_source: fillPriceSource,
    bid_at_intent: intent.bid,
    ask_at_intent: intent.ask,
    mid_at_intent: intent.mid,
    spread_bps_at_intent: intent.spread_bps,
    shortfall_bps: shortfallBps,
    spread_cost_bps: spreadCostBps,
    latency_ms: latencyMs,
    intent_at: intent.intent_at,
    fill_at: fillAt,
    snapshot_age_ms: intent.snapshot_age_ms,
  }

  buildShortfallSummary()

  return shortfallRecord
}

export function buildShortfallSummary(sinceMs?: number): ShortfallSummary {
  let intents: LedgerIntent[] = []
  let fills: LedgerFill[] = []

  if (existsSync(SHORTFALL_LEDGER_PATH)) {
    const raw = readFileSync(SHORTFALL_LEDGER_PATH, 'utf-8')
    const lines = raw.trim().split('\n').filter(Boolean)

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as LedgerIntent | LedgerFill
        if (record.type === 'intent') intents.push(record as LedgerIntent)
        else if (record.type === 'fill') fills.push(record as LedgerFill)
      } catch {
        continue
      }
    }
  }

  if (sinceMs !== undefined) {
    const sinceDate = new Date(sinceMs).getTime()
    intents = intents.filter(i => new Date(i.intent_at).getTime() >= sinceDate)
    fills = fills.filter(f => new Date(f.fill_at).getTime() >= sinceDate)
  }

  const filledTradeIds = new Set(fills.map(f => f.trade_id))
  const matchedIntents = intents.filter(i => filledTradeIds.has(i.trade_id))
  const matchedFills = fills.filter(f => filledTradeIds.has(f.trade_id))

  const shortfallValues = matchedFills.map(f => f.shortfall_bps).filter(v => Number.isFinite(v))
  const spreadCostValues = matchedFills.map(f => f.spread_cost_bps).filter(v => Number.isFinite(v))
  const latencyValues = matchedFills.map(f => f.latency_ms).filter((v): v is number => v !== null && Number.isFinite(v))

  const avgShortfall = shortfallValues.length > 0
    ? Math.round(shortfallValues.reduce((a, b) => a + b, 0) / shortfallValues.length)
    : null

  const medianShortfall = shortfallValues.length > 0
    ? median(shortfallValues)
    : null

  const avgSpreadCost = spreadCostValues.length > 0
    ? Math.round(spreadCostValues.reduce((a, b) => a + b, 0) / spreadCostValues.length)
    : null

  const avgLatency = latencyValues.length > 0
    ? Math.round(latencyValues.reduce((a, b) => a + b, 0) / latencyValues.length)
    : null

  const byStrategy: Record<string, { intents: number; fills: number; avg_shortfall_bps: number | null }> = {}
  const strategyKeys = new Set([...intents.map(i => i.strategy), ...fills.map(f => f.strategy)])
  for (const key of strategyKeys) {
    const stratIntents = intents.filter(i => i.strategy === key)
    const stratFills = fills.filter(f => f.strategy === key && filledTradeIds.has(f.trade_id))
    const stratShort = stratFills.map(f => f.shortfall_bps).filter(v => Number.isFinite(v))
    byStrategy[key] = {
      intents: stratIntents.length,
      fills: stratFills.length,
      avg_shortfall_bps: stratShort.length > 0
        ? Math.round(stratShort.reduce((a, b) => a + b, 0) / stratShort.length)
        : null,
    }
  }

  const summary: ShortfallSummary = {
    generated_at: new Date().toISOString(),
    total_intents: intents.length,
    matched_fills: matchedIntents.length,
    unmatched_intents: intents.length - matchedIntents.length,
    avg_shortfall_bps: avgShortfall,
    median_shortfall_bps: medianShortfall,
    avg_spread_cost_bps: avgSpreadCost,
    avg_latency_ms: avgLatency,
    by_strategy: byStrategy,
  }

  writeJsonAtomic(SHORTFALL_EVIDENCE_PATH, summary)

  return summary
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

export function readShortfallSummary(): ShortfallSummary | null {
  if (!existsSync(SHORTFALL_EVIDENCE_PATH)) return null
  try {
    const raw = readFileSync(SHORTFALL_EVIDENCE_PATH, 'utf-8')
    return JSON.parse(raw) as ShortfallSummary
  } catch {
    return null
  }
}
