import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DecisionTicketStore } from './decision-ticket.js'

describe('DecisionTicketStore', () => {
  let store: DecisionTicketStore

  beforeEach(() => {
    store = new DecisionTicketStore()
  })

  afterEach(() => {
    store.destroy()
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
    const now = Date.now()
    while (Date.now() - now < 5) {
      // spin
    }
    const result = store2.validate(ticket.ticketId, 'BTC/USD', 'placeOrder')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('expired')
    store2.destroy()
  })

  it('skips validation when not required', () => {
    const store2 = new DecisionTicketStore({ required: false })
    const result = store2.validate('nonexistent', 'BTC/USD', 'placeOrder')
    expect(result.valid).toBe(true)
    store2.destroy()
  })
})

