import { afterEach, describe, expect, it, vi } from 'vitest'
import { Contract, Order, OrderState } from '@traderalice/ibkr'
import { IbkrBroker } from './IbkrBroker.js'

const LIVE_TRADING_CONFIRMATION = 'I_UNDERSTAND_LIVE_TRADING_RISK'

function makeOrder(): Order {
  const order = new Order()
  order.action = 'BUY'
  order.orderType = 'MKT'
  order.totalQuantity = 1 as any
  order.tif = 'DAY'
  return order
}

function makeContract(): Contract {
  const contract = new Contract()
  contract.symbol = 'AAPL'
  contract.secType = 'STK'
  return contract
}

describe('IbkrBroker live write safety', () => {
  afterEach(() => {
    delete process.env.OPENALICE_ALLOW_LIVE_TRADING
    delete process.env.OPENALICE_LIVE_TRADING_CONFIRMATION
  })

  it('blocks live placeOrder without explicit confirmation', async () => {
    const broker = new IbkrBroker({ paper: false } as any)
    const placeOrder = vi.fn()
    ;(broker as any).client = { placeOrder }

    const result = await broker.placeOrder(makeContract(), makeOrder())

    expect(result.success).toBe(false)
    expect(result.error).toContain('requires explicit live trading confirmation')
    expect(placeOrder).not.toHaveBeenCalled()
  })

  it('blocks live modifyOrder without explicit confirmation', async () => {
    const broker = new IbkrBroker({ paper: false } as any)
    const placeOrder = vi.fn()
    ;(broker as any).client = { placeOrder }
    ;(broker as any).bridge = { requestOrder: vi.fn() }

    const result = await broker.modifyOrder('101', makeOrder())

    expect(result.success).toBe(false)
    expect(result.error).toContain('requires explicit live trading confirmation')
    expect(placeOrder).not.toHaveBeenCalled()
  })

  it('blocks live cancelOrder without explicit confirmation', async () => {
    const broker = new IbkrBroker({ paper: false } as any)
    const cancelOrder = vi.fn()
    ;(broker as any).client = { cancelOrder }
    ;(broker as any).bridge = { requestOrder: vi.fn() }

    const result = await broker.cancelOrder('101')

    expect(result.success).toBe(false)
    expect(result.error).toContain('requires explicit live trading confirmation')
    expect(cancelOrder).not.toHaveBeenCalled()
  })

  it('blocks live closePosition without explicit confirmation before reading positions', async () => {
    const broker = new IbkrBroker({ paper: false } as any)
    ;(broker as any).bridge = { getAccountCache: vi.fn() }

    const result = await broker.closePosition(makeContract())

    expect(result.success).toBe(false)
    expect(result.error).toContain('requires explicit live trading confirmation')
    expect((broker as any).bridge.getAccountCache).not.toHaveBeenCalled()
  })

  it('allows paper placeOrder without live confirmation', async () => {
    const broker = new IbkrBroker({ paper: true } as any)
    const orderState = new OrderState()
    orderState.status = 'Submitted'
    const placeOrder = vi.fn()
    ;(broker as any).bridge = {
      getNextOrderId: vi.fn().mockReturnValue(101),
      requestOrder: vi.fn().mockResolvedValue({ orderState }),
    }
    ;(broker as any).client = { placeOrder }

    const result = await broker.placeOrder(makeContract(), makeOrder())

    expect(result.success).toBe(true)
    expect(result.orderId).toBe('101')
    expect(placeOrder).toHaveBeenCalledOnce()
  })

  it('allows live placeOrder with explicit config confirmation', async () => {
    const broker = new IbkrBroker({
      paper: false,
      allowLiveTrading: true,
      liveTradingConfirmation: LIVE_TRADING_CONFIRMATION,
    } as any)
    const orderState = new OrderState()
    orderState.status = 'Submitted'
    const placeOrder = vi.fn()
    ;(broker as any).bridge = {
      getNextOrderId: vi.fn().mockReturnValue(202),
      requestOrder: vi.fn().mockResolvedValue({ orderState }),
    }
    ;(broker as any).client = { placeOrder }

    const result = await broker.placeOrder(makeContract(), makeOrder())

    expect(result.success).toBe(true)
    expect(result.orderId).toBe('202')
    expect(placeOrder).toHaveBeenCalledOnce()
  })
})
