import { describe, expect, it } from 'vitest'
import {
  extractRealizedPnlDetailsFromBalancePayload,
  extractRealizedPnlDetailsFromClosedTradesLedger,
  extractRealizedPnlFromBalancePayload,
} from './ccxt-pnl.js'

describe('ccxt-pnl helpers', () => {
  it('prefers top-level realized PnL fields on balance payloads', () => {
    const details = extractRealizedPnlDetailsFromBalancePayload({
      info: {
        totalRealizedPnl: '-123.45',
        positions: [{ realizedPnl: '-10' }, { realizedPnl: '-20' }],
      },
    })

    expect(details.found).toBe(true)
    expect(details.matchedKey).toBe('totalRealizedPnl')
    expect(details.realizedPnl).toBeCloseTo(-123.45)
    expect(extractRealizedPnlFromBalancePayload({
      info: { totalRealizedPnl: '-123.45' },
    })).toBeCloseTo(-123.45)
  })

  it('aggregates same-depth realized values when only nested values exist', () => {
    const details = extractRealizedPnlDetailsFromBalancePayload({
      info: {
        positions: [
          { realizedPnl: '-50' },
          { realizedPnl: '25' },
          { realizedPnl: '-10' },
        ],
      },
    })

    expect(details.found).toBe(true)
    expect(details.realizedPnl).toBeCloseTo(-35)
  })

  it('returns 0 when no realized field exists on the balance payload', () => {
    const details = extractRealizedPnlDetailsFromBalancePayload({
      info: {
        totalUnrealizedProfit: '99.9',
      },
    })

    expect(details.found).toBe(false)
    expect(details.realizedPnl).toBe(0)
  })

  it('extracts realized pnl from closed trades ledgers', () => {
    const details = extractRealizedPnlDetailsFromClosedTradesLedger([
      { id: '1', info: { realizedPnl: '-10.5' } },
      { id: '2', pnl: '3.25' },
      { id: '3', info: { fee: '0.1' } },
    ])

    expect(details.found).toBe(true)
    expect(details.matchedTradeCount).toBe(2)
    expect(details.realizedPnl).toBeCloseTo(-7.25)
  })

  it('returns not-found when ledger entries do not contain realized pnl', () => {
    const details = extractRealizedPnlDetailsFromClosedTradesLedger([
      { id: '1', info: { fee: '0.1' } },
    ])

    expect(details.found).toBe(false)
    expect(details.matchedTradeCount).toBe(0)
    expect(details.realizedPnl).toBe(0)
  })
})
