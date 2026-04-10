import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'
import type { AccountConfig, ReconnectResult } from '../api/types'

export interface UseTradingConfigResult {
  accounts: AccountConfig[]
  loading: boolean
  error: string | null

  saveAccount: (a: AccountConfig) => Promise<void>
  deleteAccount: (id: string) => Promise<void>
  reconnectAccount: (id: string) => Promise<ReconnectResult>
  refresh: () => Promise<void>
}

export function useTradingConfig(): UseTradingConfigResult {
  const [accounts, setAccounts] = useState<AccountConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await api.trading.loadTradingConfig()
      setAccounts(data.accounts)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const saveAccount = useCallback(async (a: AccountConfig) => {
    await api.trading.upsertAccount(a)
    setAccounts((prev) => {
      const idx = prev.findIndex((x) => x.id === a.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = a
        return next
      }
      return [...prev, a]
    })
  }, [])

  const deleteAccount = useCallback(async (id: string) => {
    await api.trading.deleteAccount(id)
    setAccounts((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const reconnectAccount = useCallback(async (id: string): Promise<ReconnectResult> => {
    return api.trading.reconnectAccount(id)
  }, [])

  return {
    accounts, loading, error,
    saveAccount, deleteAccount,
    reconnectAccount, refresh: load,
  }
}
