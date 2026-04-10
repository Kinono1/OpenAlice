import { describe, expect, it } from 'vitest'
import { getExchangeCapability, getIdempotencyPolicy } from './exchange-capabilities.js'

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

