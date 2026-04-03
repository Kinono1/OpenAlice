import { describe, expect, it } from 'vitest'
import { validateExecutionTicket } from './index.js'

describe('strategy ticket lifecycle', () => {
  it('rejects active swap tickets without stop-loss', () => {
    const result = validateExecutionTicket({
      ticketId: 't1',
      market: 'crypto',
      venue: 'bybit',
      instrument: 'BTC/USDT:USDT',
      productType: 'SWAP',
      direction: 'BUY',
      orderType: 'limit',
      entryPrice: 100000,
      size: 0.01,
      leverage: 3,
      riskIfFilled: 500,
      generatedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      cancelIf: 'event freeze',
      invalidateRule: 'price drift',
      priorityRank: 1,
      assetLayer: 'core',
      status: 'active',
    })

    expect(result.valid).toBe(false)
    expect(result.reasons[0]).toContain('stop-loss')
  })

  it('rejects duplicate active tickets on same market/instrument/direction', () => {
    const active = {
      ticketId: 't0',
      market: 'crypto',
      venue: 'bybit',
      instrument: 'BTC/USDT:USDT',
      productType: 'SPOT' as const,
      direction: 'BUY' as const,
      orderType: 'limit' as const,
      entryPrice: 100000,
      size: 0.01,
      sl: 95000,
      riskIfFilled: 500,
      generatedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      cancelIf: 'event freeze',
      invalidateRule: 'price drift',
      priorityRank: 1,
      assetLayer: 'core' as const,
      status: 'active' as const,
    }

    const result = validateExecutionTicket(
      { ...active, ticketId: 't1' },
      [active],
    )

    expect(result.valid).toBe(false)
    expect(result.reasons.join(' ')).toContain('duplicate active ticket')
  })

  it('accepts well-formed active tickets', () => {
    const result = validateExecutionTicket({
      ticketId: 't1',
      market: 'crypto',
      venue: 'bybit',
      instrument: 'BTC/USDT:USDT',
      productType: 'SPOT',
      direction: 'BUY',
      orderType: 'limit',
      entryPrice: 100000,
      size: 0.01,
      sl: 95000,
      riskIfFilled: 500,
      generatedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      cancelIf: 'event freeze',
      invalidateRule: 'price drift',
      priorityRank: 1,
      assetLayer: 'core',
      status: 'active',
      latestReferencePrice: 100500,
    })

    expect(result.valid).toBe(true)
  })
})
