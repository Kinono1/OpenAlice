import { describe, it, expect, beforeEach } from 'vitest'
import { getExchangeCapability, getIdempotencyPolicy } from './exchange-capabilities.js'
import { DecisionTicketStore } from './decision-ticket.js'
import { KillSwitch } from './kill-switch.js'

describe('exchange-capabilities', () => {
  it('bybit uses orderLinkId', () => {
    const cap = getExchangeCapability('bybit')
    expect(cap.supportsClientOrderId).toBe(true)
    expect(cap.clientOrderIdField).toBe('orderLinkId')
  })

  it('unknown exchange has no clientOrderId support', () => {
    const cap = getExchangeCapability('unknown-exchange')
    expect(cap.supportsClientOrderId).toBe(false)
  })

  it('rejects new position on unsupported exchange', () => {
    const result = getIdempotencyPolicy('unknown-exchange', false)
    expect(result.allowed).toBe(false)
    expect(result.degradation).toBe('reject')
  })

  it('allows reduceOnly on unsupported exchange with warning', () => {
    const result = getIdempotencyPolicy('unknown-exchange', true)
    expect(result.allowed).toBe(true)
    expect(result.degradation).toBe('allow-with-warning')
  })
})

describe('DecisionTicketStore', () => {
  let store: DecisionTicketStore

  beforeEach(() => {
    store = new DecisionTicketStore()
  })

  it('issues and validates a ticket', () => {
    const ticket = store.issue({ symbol: 'BTC/USD', action: 'placeOrder' })
    const result = store.validate(ticket.ticketId, 'BTC/USD', 'placeOrder')
    expect(result.valid).toBe(true)
  })

  it('rejects consumed ticket', () => {
    const ticket = store.issue({ symbol: 'BTC/USD', action: 'placeOrder' })
    store.validate(ticket.ticketId, 'BTC/USD', 'placeOrder')
    const result = store.validate(ticket.ticketId, 'BTC/USD', 'placeOrder')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('already consumed')
  })

  it('rejects symbol mismatch', () => {
    const ticket = store.issue({ symbol: 'BTC/USD', action: 'placeOrder' })
    const result = store.validate(ticket.ticketId, 'ETH/USD', 'placeOrder')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('symbol mismatch')
  })

  it('rejects expired ticket', () => {
    const store2 = new DecisionTicketStore({ ttlMs: 1 })
    const ticket = store2.issue({ symbol: 'BTC/USD', action: 'placeOrder' })
    // Wait for expiry
    const now = Date.now()
    while (Date.now() - now < 5) { /* spin */ }
    const result = store2.validate(ticket.ticketId, 'BTC/USD', 'placeOrder')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('expired')
  })

  it('skips validation when not required', () => {
    const store2 = new DecisionTicketStore({ required: false })
    const result = store2.validate('nonexistent', 'BTC/USD', 'placeOrder')
    expect(result.valid).toBe(true)
  })
})

describe('KillSwitch', () => {
  let ks: KillSwitch

  beforeEach(() => {
    ks = new KillSwitch()
  })

  it('allows when no kill switch active', () => {
    expect(ks.check('BTC/USD', false).blocked).toBe(false)
  })

  it('block_new_only blocks new positions', () => {
    ks.activate('BTC/USD', 'test', 'block_new_only')
    expect(ks.check('BTC/USD', false).blocked).toBe(true)
  })

  it('block_new_only allows reduceOnly', () => {
    ks.activate('BTC/USD', 'test', 'block_new_only')
    expect(ks.check('BTC/USD', true).blocked).toBe(false)
  })

  it('block_all blocks everything', () => {
    ks.activate('BTC/USD', 'test', 'block_all')
    expect(ks.check('BTC/USD', false).blocked).toBe(true)
    expect(ks.check('BTC/USD', true).blocked).toBe(true)
  })

  it('block_all allows emergency close', () => {
    ks.activate('BTC/USD', 'test', 'block_all')
    expect(ks.check('BTC/USD', true, true).blocked).toBe(false)
  })

  it('deactivate removes kill switch', () => {
    ks.activate('BTC/USD', 'test')
    ks.deactivate('BTC/USD')
    expect(ks.check('BTC/USD', false).blocked).toBe(false)
  })
})
