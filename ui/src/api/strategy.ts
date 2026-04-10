import { headers } from './client'
import type { StrategyConfig, StrategyEvaluationSnapshot, StrategyRuntimeSummary } from './types'

export const strategyApi = {
  async loadConfig(): Promise<StrategyConfig> {
    const res = await fetch('/api/strategy/config')
    if (!res.ok) throw new Error('Failed to load strategy config')
    return res.json()
  },

  async updateConfig(config: StrategyConfig): Promise<StrategyConfig> {
    const res = await fetch('/api/strategy/config', {
      method: 'PUT',
      headers,
      body: JSON.stringify(config),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Save failed' }))
      throw new Error(err.error || 'Save failed')
    }
    return res.json()
  },

  async runtime(): Promise<StrategyRuntimeSummary> {
    const res = await fetch('/api/strategy/runtime')
    if (!res.ok) throw new Error('Failed to load strategy runtime')
    return res.json()
  },

  async evaluate(input: {
    symbol: string
    interval?: string
    source?: string
    exchangeId?: string
    assetLayer?: 'core' | 'extended' | 'watch-only'
    winRate?: number
    avgWinLossRatio?: number
    side?: 'buy' | 'sell'
    requestedSize?: number
    requestedUsdSize?: number
    price?: number
    reduceOnly?: boolean
  }): Promise<StrategyEvaluationSnapshot> {
    const res = await fetch('/api/strategy/evaluate', {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Evaluation failed' }))
      throw new Error(err.error || 'Evaluation failed')
    }
    return res.json()
  },
}
