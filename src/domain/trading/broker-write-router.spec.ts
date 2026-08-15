import { describe, expect, it, vi } from 'vitest'
import {
  constrainBrokerWriteOutcomeToRoute,
  resolveAuthorizedBrokerWriter,
  SIDECAR_UNVERIFIED_BROKER_FINAL,
  type AuthorizedBrokerWriter,
} from './broker-write-router.js'
import type { ICryptoTradingEngine } from './operation-dispatcher.types.js'

function engineStub(): ICryptoTradingEngine {
  return {
    placeOrder: vi.fn().mockResolvedValue({ success: true }),
    getPositions: vi.fn().mockResolvedValue([]),
    getOrders: vi.fn().mockResolvedValue([]),
    getAccount: vi.fn(),
    cancelOrder: vi.fn().mockResolvedValue(true),
    adjustLeverage: vi.fn().mockResolvedValue({ success: true }),
    getTicker: vi.fn(),
    getFundingRate: vi.fn(),
    getOrderBook: vi.fn(),
  }
}

function writerStub(): AuthorizedBrokerWriter {
  return {
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    adjustLeverage: vi.fn(),
  }
}

describe('resolveAuthorizedBrokerWriter', () => {
  it('downgrades an unverified sidecar broker-final claim to submission unknown', () => {
    expect(constrainBrokerWriteOutcomeToRoute('sidecar', {
      kind: 'broker_final',
      result: { success: true, orderId: 'simulated-order' },
    })).toEqual({
      kind: 'submission_unknown',
      error: SIDECAR_UNVERIFIED_BROKER_FINAL,
    })

    const native = { kind: 'broker_final' as const, result: { success: true } }
    expect(constrainBrokerWriteOutcomeToRoute('native', native)).toBe(native)
  })

  it('constrains every method of a custom sidecar writer at the route boundary', async () => {
    const engine = engineStub()
    const writer: AuthorizedBrokerWriter = {
      placeOrder: vi.fn().mockResolvedValue({
        kind: 'broker_final', result: { success: true, orderId: 'forged-order' },
      }),
      cancelOrder: vi.fn().mockResolvedValue({ kind: 'broker_final', result: true }),
      adjustLeverage: vi.fn().mockResolvedValue({
        kind: 'broker_final', result: { success: false, error: 'forged-failure' },
      }),
    }
    const resolved = resolveAuthorizedBrokerWriter(engine, { route: 'sidecar', writer })
    expect(resolveAuthorizedBrokerWriter(engine, { route: 'sidecar', writer }).writer)
      .toBe(resolved.writer)
    const authorization = { kind: 'test_bypass' as const }
    const expected = {
      kind: 'submission_unknown',
      error: SIDECAR_UNVERIFIED_BROKER_FINAL,
    }

    await expect(resolved.writer.placeOrder(
      { symbol: 'BTC/USD', side: 'buy', type: 'market' },
      authorization,
    )).resolves.toEqual(expected)
    await expect(resolved.writer.cancelOrder('order-1', authorization)).resolves.toEqual(expected)
    await expect(resolved.writer.adjustLeverage('BTC/USD', 2, authorization)).resolves.toEqual(expected)
    expect(writer.placeOrder).toHaveBeenCalledTimes(1)
    expect(writer.cancelOrder).toHaveBeenCalledTimes(1)
    expect(writer.adjustLeverage).toHaveBeenCalledTimes(1)
    expect(engine.placeOrder).not.toHaveBeenCalled()
    expect(engine.cancelOrder).not.toHaveBeenCalled()
    expect(engine.adjustLeverage).not.toHaveBeenCalled()
  })

  it('rejects an invalid runtime route instead of silently selecting native', () => {
    const engine = engineStub()
    expect(() => resolveAuthorizedBrokerWriter(engine, {
      route: 'nautilus_sidecar' as never,
    })).toThrow('broker_write_route_invalid')
    expect(engine.placeOrder).not.toHaveBeenCalled()
  })

  it('rejects a custom writer when the sidecar route is omitted or native', () => {
    const engine = engineStub()
    const writer = writerStub()
    expect(() => resolveAuthorizedBrokerWriter(engine, { writer }))
      .toThrow('broker_write_custom_writer_requires_explicit_sidecar_route')
    expect(() => resolveAuthorizedBrokerWriter(engine, { route: 'native', writer }))
      .toThrow('broker_write_custom_writer_requires_sidecar_route')
    expect(engine.placeOrder).not.toHaveBeenCalled()
  })

  it('rejects sidecar selection without a writer', () => {
    const engine = engineStub()
    expect(() => resolveAuthorizedBrokerWriter(engine, { route: 'sidecar' }))
      .toThrow('broker_write_sidecar_writer_missing')
    expect(engine.placeOrder).not.toHaveBeenCalled()
  })

  it('keeps the legacy native default explicit and single-call', async () => {
    const engine = engineStub()
    const resolved = resolveAuthorizedBrokerWriter(engine, {})
    expect(resolved.route).toBe('native')
    await resolved.writer.placeOrder(
      { symbol: 'BTC/USD', side: 'buy', type: 'limit', size: 0.001, price: 95_000 },
      { kind: 'test_bypass' },
    )
    expect(engine.placeOrder).toHaveBeenCalledTimes(1)
  })
})
