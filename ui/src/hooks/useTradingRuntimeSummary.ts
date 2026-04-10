import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'
import type { TradingRuntimeSummary } from '../api/types'

export interface UseTradingRuntimeSummaryResult {
  runtime: TradingRuntimeSummary | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useTradingRuntimeSummary(): UseTradingRuntimeSummaryResult {
  const [runtime, setRuntime] = useState<TradingRuntimeSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await api.trading.runtimeSummary()
      setRuntime(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return {
    runtime,
    loading,
    error,
    refresh: load,
  }
}
