import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { StrategyConfig, StrategyRuntimeSummary } from '../api/types'

export interface UseStrategyRuntimeResult {
  config: StrategyConfig | null
  runtime: StrategyRuntimeSummary | null
  loading: boolean
  error: string | null
  saveConfig: (next: StrategyConfig) => Promise<void>
  refresh: () => Promise<void>
}

export function useStrategyRuntime(): UseStrategyRuntimeResult {
  const [config, setConfig] = useState<StrategyConfig | null>(null)
  const [runtime, setRuntime] = useState<StrategyRuntimeSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const [nextConfig, nextRuntime] = await Promise.all([
        api.strategy.loadConfig(),
        api.strategy.runtime(),
      ])
      setConfig(nextConfig)
      setRuntime(nextRuntime)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const saveConfig = useCallback(async (next: StrategyConfig) => {
    const saved = await api.strategy.updateConfig(next)
    setConfig(saved)
    const runtimeSummary = await api.strategy.runtime()
    setRuntime(runtimeSummary)
  }, [])

  return {
    config,
    runtime,
    loading,
    error,
    saveConfig,
    refresh: load,
  }
}
