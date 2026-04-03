import { describe, expect, it, vi } from 'vitest'
import Decimal from 'decimal.js'
import { Contract, Order, OrderState } from '@traderalice/ibkr'
import { UnifiedTradingAccount } from './UnifiedTradingAccount.js'
import { MockBroker } from './brokers/mock/index.js'

describe('UnifiedTradingAccount — executeOperation hook', () => {
  it('uses buildExecuteOperation override for push execution', async () => {
    const broker = new MockBroker()
    const executeOverride = vi.fn().mockResolvedValue({
      success: true,
      orderId: 'hook-order-1',
      orderState: Object.assign(new OrderState(), { status: 'Submitted' }),
    })

    const uta = new UnifiedTradingAccount(broker, {
      buildExecuteOperation: (_fallback) => executeOverride,
    })

    const contract = new Contract()
    contract.symbol = 'BTC/USD'
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal(1)

    uta.git.add({ action: 'placeOrder', contract, order })
    uta.git.commit('hooked crypto push')
    const result = await uta.push()

    expect(executeOverride).toHaveBeenCalledTimes(1)
    expect(broker.callCount('placeOrder')).toBe(0)
    expect(result.submitted).toEqual([
      expect.objectContaining({
        orderId: 'hook-order-1',
        status: 'submitted',
      }),
    ])
  })
})
