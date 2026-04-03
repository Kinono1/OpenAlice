import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCryptoOperationDispatcher, executeCommit } from './operation-dispatcher.js';
import type { ICryptoTradingEngine, CryptoPosition } from './interfaces.js';
import type { Operation } from './wallet/types.js';

// ==================== Mock Factory ====================

function createMockEngine(overrides: Partial<ICryptoTradingEngine> = {}): ICryptoTradingEngine {
  return {
    placeOrder: vi.fn().mockResolvedValue({
      success: true,
      orderId: 'ord-001',
      filledPrice: 95000,
      filledSize: 0.1,
    }),
    getPositions: vi.fn().mockResolvedValue([]),
    getOrders: vi.fn().mockResolvedValue([]),
    getAccount: vi.fn().mockResolvedValue({
      balance: 10000, totalMargin: 0, unrealizedPnL: 0,
      equity: 10000, realizedPnL: 0, totalPnL: 0,
    }),
    cancelOrder: vi.fn().mockResolvedValue(true),
    adjustLeverage: vi.fn().mockResolvedValue({ success: true }),
    getTicker: vi.fn().mockResolvedValue({
      symbol: 'BTC/USD', last: 95000, bid: 94999, ask: 95001,
      high: 96000, low: 94000, volume: 1000, timestamp: new Date(),
    }),
    getFundingRate: vi.fn().mockResolvedValue({
      symbol: 'BTC/USD', fundingRate: 0.0001, timestamp: new Date(),
    }),
    getOrderBook: vi.fn().mockResolvedValue({
      symbol: 'BTC/USD', bids: [], asks: [], timestamp: new Date(),
    }),
    ...overrides,
  };
}

function makeLongPosition(overrides: Partial<CryptoPosition> = {}): CryptoPosition {
  return {
    symbol: 'BTC/USD', side: 'long', size: 0.5, entryPrice: 90000,
    leverage: 5, margin: 9000, liquidationPrice: 72000,
    markPrice: 95000, unrealizedPnL: 2500, positionValue: 47500,
    ...overrides,
  };
}

function makeShortPosition(overrides: Partial<CryptoPosition> = {}): CryptoPosition {
  return {
    symbol: 'ETH/USD', side: 'short', size: 10, entryPrice: 3500,
    leverage: 3, margin: 11667, liquidationPrice: 4500,
    markPrice: 3400, unrealizedPnL: 1000, positionValue: 34000,
    ...overrides,
  };
}

// ==================== Tests ====================

describe('createCryptoOperationDispatcher', () => {
  let engine: ICryptoTradingEngine;
  let dispatch: (op: Operation) => Promise<unknown>;

  beforeEach(() => {
    engine = createMockEngine();
    dispatch = createCryptoOperationDispatcher(engine);
  });

  // ==================== placeOrder ====================

  describe('placeOrder', () => {
    it('maps Operation params to CryptoPlaceOrderRequest', async () => {
      const op: Operation = {
        action: 'placeOrder',
        params: {
          symbol: 'BTC/USD', side: 'buy', type: 'limit',
          size: 0.5, price: 90000, leverage: 10, reduceOnly: false,
        },
      };

      await dispatch(op);

      expect(engine.placeOrder).toHaveBeenCalledWith({
        symbol: 'BTC/USD', side: 'buy', type: 'limit',
        size: 0.5, usd_size: undefined, price: 90000,
        leverage: 10, reduceOnly: false,
      });
    });

    it('passes usd_size when size is not provided', async () => {
      const op: Operation = {
        action: 'placeOrder',
        params: { symbol: 'BTC/USD', side: 'buy', type: 'market', usd_size: 1000 },
      };

      await dispatch(op);

      expect(engine.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({ size: undefined, usd_size: 1000 }),
      );
    });

    it('wraps successful filled result', async () => {
      const op: Operation = {
        action: 'placeOrder',
        params: { symbol: 'BTC/USD', side: 'buy', type: 'market' },
      };

      const result = await dispatch(op);

      expect(result).toEqual({
        success: true,
        error: undefined,
        order: {
          id: 'ord-001',
          status: 'filled',
          filledPrice: 95000,
          filledQuantity: 0.1,
        },
      });
    });

    it('wraps successful pending result (no filledPrice)', async () => {
      engine = createMockEngine({
        placeOrder: vi.fn().mockResolvedValue({
          success: true, orderId: 'ord-002',
          filledPrice: undefined, filledSize: undefined,
        }),
      });
      dispatch = createCryptoOperationDispatcher(engine);

      const result = await dispatch({
        action: 'placeOrder',
        params: { symbol: 'BTC/USD', side: 'buy', type: 'limit', price: 90000 },
      });

      expect(result).toEqual({
        success: true,
        error: undefined,
        order: {
          id: 'ord-002',
          status: 'pending',
          filledPrice: undefined,
          filledQuantity: undefined,
        },
      });
    });

    it('wraps failed result with error', async () => {
      engine = createMockEngine({
        placeOrder: vi.fn().mockResolvedValue({
          success: false, error: 'Insufficient balance',
        }),
      });
      dispatch = createCryptoOperationDispatcher(engine);

      const result = await dispatch({
        action: 'placeOrder',
        params: { symbol: 'BTC/USD', side: 'buy', type: 'market', size: 100 },
      });

      expect(result).toEqual({
        success: false,
        error: 'Insufficient balance',
        order: undefined,
      });
    });
  });

  // ==================== closePosition ====================

  describe('closePosition', () => {
    it('places sell order with reduceOnly for long position', async () => {
      engine = createMockEngine({
        getPositions: vi.fn().mockResolvedValue([makeLongPosition()]),
      });
      dispatch = createCryptoOperationDispatcher(engine);

      await dispatch({ action: 'closePosition', params: { symbol: 'BTC/USD' } });

      expect(engine.placeOrder).toHaveBeenCalledWith({
        symbol: 'BTC/USD', side: 'sell', type: 'market',
        size: 0.5, reduceOnly: true,
      });
    });

    it('places buy order with reduceOnly for short position', async () => {
      engine = createMockEngine({
        getPositions: vi.fn().mockResolvedValue([makeShortPosition()]),
      });
      dispatch = createCryptoOperationDispatcher(engine);

      await dispatch({ action: 'closePosition', params: { symbol: 'ETH/USD' } });

      expect(engine.placeOrder).toHaveBeenCalledWith({
        symbol: 'ETH/USD', side: 'buy', type: 'market',
        size: 10, reduceOnly: true,
      });
    });

    it('uses specified partial size', async () => {
      engine = createMockEngine({
        getPositions: vi.fn().mockResolvedValue([makeLongPosition()]),
      });
      dispatch = createCryptoOperationDispatcher(engine);

      await dispatch({ action: 'closePosition', params: { symbol: 'BTC/USD', size: 0.2 } });

      expect(engine.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({ size: 0.2 }),
      );
    });

    it('returns error when no position exists', async () => {
      const result = await dispatch({
        action: 'closePosition', params: { symbol: 'BTC/USD' },
      });

      expect(result).toEqual({
        success: false,
        error: 'No open position for BTC/USD',
      });
      expect(engine.placeOrder).not.toHaveBeenCalled();
    });

    it('wraps the placeOrder result in standard format', async () => {
      engine = createMockEngine({
        getPositions: vi.fn().mockResolvedValue([makeLongPosition()]),
      });
      dispatch = createCryptoOperationDispatcher(engine);

      const result = await dispatch({
        action: 'closePosition', params: { symbol: 'BTC/USD' },
      });

      expect(result).toEqual({
        success: true,
        error: undefined,
        order: {
          id: 'ord-001',
          status: 'filled',
          filledPrice: 95000,
          filledQuantity: 0.1,
        },
      });
    });
  });

  // ==================== cancelOrder ====================

  describe('cancelOrder', () => {
    it('returns success when cancellation succeeds', async () => {
      const result = await dispatch({
        action: 'cancelOrder', params: { orderId: 'ord-001' },
      });

      expect(engine.cancelOrder).toHaveBeenCalledWith('ord-001');
      expect(result).toEqual({ success: true, error: undefined });
    });

    it('returns error when cancellation fails', async () => {
      engine = createMockEngine({
        cancelOrder: vi.fn().mockResolvedValue(false),
      });
      dispatch = createCryptoOperationDispatcher(engine);

      const result = await dispatch({
        action: 'cancelOrder', params: { orderId: 'ord-999' },
      });

      expect(result).toEqual({ success: false, error: 'Failed to cancel order' });
    });
  });

  // ==================== adjustLeverage ====================

  describe('adjustLeverage', () => {
    it('passes through to engine.adjustLeverage', async () => {
      const result = await dispatch({
        action: 'adjustLeverage',
        params: { symbol: 'BTC/USD', newLeverage: 10 },
      });

      expect(engine.adjustLeverage).toHaveBeenCalledWith('BTC/USD', 10);
      expect(result).toEqual({ success: true });
    });

    it('returns error from engine', async () => {
      engine = createMockEngine({
        adjustLeverage: vi.fn().mockResolvedValue({
          success: false, error: 'Leverage too high',
        }),
      });
      dispatch = createCryptoOperationDispatcher(engine);

      const result = await dispatch({
        action: 'adjustLeverage',
        params: { symbol: 'BTC/USD', newLeverage: 125 },
      });

      expect(result).toEqual({ success: false, error: 'Leverage too high' });
    });
  });

  // ==================== unknown action ====================

  describe('unknown action', () => {
    it('throws for unknown action', async () => {
      await expect(
        dispatch({ action: 'syncOrders', params: {} }),
      ).rejects.toThrow('Unknown operation action: syncOrders');
    });
  });

  describe('push', () => {
    it('stops after first failure and marks remaining operations as skipped', async () => {
      const dispatcher = createCryptoOperationDispatcher(engine);

      const result = await dispatcher.push('commit-1', [
        { action: 'cancelOrder', params: { orderId: 'ord-001' } },
        { action: 'closePosition', params: { symbol: 'BTC/USD' } },
        { action: 'adjustLeverage', params: { symbol: 'BTC/USD', newLeverage: 3 } },
      ]);

      expect(engine.cancelOrder).toHaveBeenCalledWith('ord-001');
      expect(engine.getPositions).toHaveBeenCalledTimes(1);
      expect(engine.adjustLeverage).not.toHaveBeenCalled();
      expect(result.operations.map((entry) => entry.status)).toEqual([
        'success',
        'failed',
        'skipped',
      ]);
      expect(result.summary).toEqual({
        succeeded: 1,
        failed: 1,
        skipped: 1,
      });
    });
  });

  describe('executeCommit', () => {
    it('passes idempotency store through to the place-order pipeline', async () => {
      const idempotencyStore = {
        reserve: vi.fn().mockResolvedValue({
          acquired: true,
          retriedFromFailed: false,
        }),
        finalize: vi.fn().mockResolvedValue(undefined),
      };

      const result = await executeCommit(
        [
          {
            action: 'placeOrder',
            ticketId: 'ticket-1',
            params: {
              symbol: 'BTC/USD',
              side: 'buy',
              type: 'market',
            },
          },
        ],
        {
          engine,
          idempotencyStore: idempotencyStore as any,
        },
      );

      expect(idempotencyStore.reserve).toHaveBeenCalledWith({
        key: 'ticket:ticket-1',
        symbol: 'BTC/USD',
        ticketId: 'ticket-1',
        allowRetryOnFailed: false,
      });
      expect(idempotencyStore.finalize).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'ticket:ticket-1',
          status: 'succeeded',
          orderId: 'ord-001',
        }),
      );
      expect(result.summary).toEqual({
        succeeded: 1,
        failed: 0,
        skipped: 0,
      });
    });
  });
});
