import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  admissionDecisionId,
  type AdmissionDecisionV1,
} from '../../runtime/admission.js'
import { createCryptoOperationDispatcher } from './operation-dispatcher.core.js'
import { DecisionTicketStore } from './decision-ticket.js'
import { TradeIdempotencyStore } from './idempotency-store.js'
import { KillSwitch } from './kill-switch.js'
import type { ICryptoTradingEngine } from './operation-dispatcher.types.js'
import type { ExecutionAuthorityProvider } from './execution-permit.js'
import { READY_DENY_ONLY_PRODUCTION_RISK_POLICY } from './production-risk-preflight.js'
import { authorizeBrokerWrite } from './operation-dispatcher.execution-gate.js'
import type { AuthorizedBrokerWriter } from './broker-write-router.js'

const stores: DecisionTicketStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.destroy()
})

describe('dispatcher execution permit hard gate', () => {
  it('returns the exact constructed permit request with the permit context', async () => {
    const engine = makeEngine()
    const harness = await makeHarness(makeDecision({ paperAllowed: true }))
    const authorization = await authorizeBrokerWrite(engine, harness.options, {
      intentId: 'intent-1',
      action: 'open',
      riskReducing: false,
      symbol: 'BTC/USD',
      side: 'buy',
      notionalUsd: 100,
      ticketId: 'ticket-1',
      idempotencyKey: 'idem-1',
      completedChecks: [
        'idempotency_reserved', 'kill_switch_passed', 'limits_passed',
        'risk_passed', 'slippage_policy_loaded', 'ticket_valid',
      ],
    })

    expect(authorization).toEqual(expect.objectContaining({ allowed: true }))
    if (!authorization.allowed) throw new Error('expected permit')
    expect(authorization.context).toEqual(expect.objectContaining({
      kind: 'execution_permit_v1',
      request: expect.objectContaining({
        intentId: 'intent-1', action: 'open', riskReducing: false,
        accountId: 'paper-main', accountMode: 'paper_only', symbol: 'BTC/USD',
        side: 'buy', notionalUsd: 100, ticketId: 'ticket-1', idempotencyKey: 'idem-1',
        completedChecks: expect.arrayContaining([
          'account_fresh', 'authority_fresh', 'market_data_fresh', 'positions_fresh',
          'idempotency_reserved', 'kill_switch_passed', 'limits_passed', 'risk_passed',
          'slippage_policy_loaded', 'ticket_valid',
        ]),
        now: expect.any(Date),
      }),
    }))
    if (authorization.context.kind === 'execution_permit_v1') {
      expect(authorization.context.permit.intentId).toBe(authorization.context.request.intentId)
      expect(authorization.context.permit.issuedAt).toBe(authorization.context.request.now?.toISOString())
    }
  })

  it('does not call the broker when live admission is true but arm is false', async () => {
    const engine = makeEngine()
    const receiptSink = vi.fn().mockResolvedValue(undefined)
    const harness = await makeHarness(makeDecision({
      paperAllowed: true,
      liveAllowed: true,
      liveArmed: false,
    }))
    const ticket = harness.ticketStore.issue({ symbol: 'BTC/USD', action: 'placeOrder' })
    const dispatcher = createCryptoOperationDispatcher(engine, {
      ...harness.options,
      accountMode: 'live_guarded',
      executionReceiptSink: receiptSink,
    })

    const result = await dispatcher.dispatch({
      action: 'placeOrder',
      params: {
        symbol: 'BTC/USD',
        side: 'buy',
        type: 'market',
        usd_size: 100,
        leverage: 3,
        lane: 'volume_breakout_3x',
        ticketId: ticket.ticketId,
        idempotencyKey: 'live-arm-false-1',
      },
    })

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('live_execution_not_armed'),
    })
    expect(engine.placeOrder).not.toHaveBeenCalled()
    expect(receiptSink).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 'execution_receipt.v1',
      status: 'rejected',
      reasonCodes: expect.arrayContaining(['live_execution_not_armed']),
    }))
  })

  it('submits a paper broker write only after permit, ticket, idempotency and risk checks pass', async () => {
    const engine = makeEngine()
    const harness = await makeHarness(makeDecision({ paperAllowed: true }))
    const ticket = harness.ticketStore.issue({ symbol: 'BTC/USD', action: 'placeOrder' })
    const dispatcher = createCryptoOperationDispatcher(engine, harness.options)

    const result = await dispatcher.dispatch({
      action: 'placeOrder',
      params: {
        symbol: 'BTC/USD',
        side: 'buy',
        type: 'market',
        usd_size: 100,
        leverage: 3,
        lane: 'volume_breakout_3x',
        ticketId: ticket.ticketId,
        idempotencyKey: 'paper-permit-1',
      },
    })

    expect(result).toEqual(expect.objectContaining({ success: true }))
    expect(engine.placeOrder).toHaveBeenCalledTimes(1)
  })

  it('keeps an injected sidecar broker-final claim unknown and never mutates the native engine', async () => {
    const engine = makeEngine()
    const harness = await makeHarness(makeDecision({ paperAllowed: true }))
    const ticket = harness.ticketStore.issue({ symbol: 'BTC/USD', action: 'placeOrder' })
    const writer: AuthorizedBrokerWriter = {
      placeOrder: vi.fn().mockResolvedValue({ kind: 'broker_final', result: {
        success: true, orderId: 'sidecar-order', filledPrice: 95_000, filledSize: 0.001,
      } }),
      cancelOrder: vi.fn(),
      adjustLeverage: vi.fn(),
    }
    const dispatcher = createCryptoOperationDispatcher(engine, {
      ...harness.options,
      brokerWriteRoute: 'sidecar',
      authorizedBrokerWriter: writer,
    })

    const result = await dispatcher.dispatch({ action: 'placeOrder', params: {
      symbol: 'BTC/USD', side: 'buy', type: 'market', usd_size: 100, leverage: 3,
      lane: 'volume_breakout_3x', ticketId: ticket.ticketId, idempotencyKey: 'sidecar-once-1',
    } })

    expect(result).toEqual(expect.objectContaining({
      success: false,
      unknown: true,
      pending: false,
      brokerWriteOutcome: 'submission_unknown',
      error: 'execution_sidecar_submission_unknown',
    }))
    expect(writer.placeOrder).toHaveBeenCalledTimes(1)
    expect(engine.placeOrder).not.toHaveBeenCalled()
  })

  it('does not fall back to native mutation when sidecar acceptance leaves broker completion pending', async () => {
    const engine = makeEngine()
    const receiptSink = vi.fn().mockResolvedValue(undefined)
    const harness = await makeHarness(makeDecision({ paperAllowed: true }))
    const ticket = harness.ticketStore.issue({ symbol: 'BTC/USD', action: 'placeOrder' })
    const writer: AuthorizedBrokerWriter = {
      placeOrder: vi.fn().mockResolvedValue({
        kind: 'command_accepted',
        commandId: '1'.repeat(64),
        permitV2Id: '2'.repeat(64),
        acceptedSequence: '7',
        clientOrderId: `OA${'A'.repeat(30)}`,
        message: 'credential=must-not-reach-caller',
      }),
      cancelOrder: vi.fn(),
      adjustLeverage: vi.fn(),
    }
    const dispatcher = createCryptoOperationDispatcher(engine, {
      ...harness.options,
      executionReceiptSink: receiptSink,
      brokerWriteRoute: 'sidecar',
      authorizedBrokerWriter: writer,
    })

    const result = await dispatcher.dispatch({ action: 'placeOrder', params: {
      symbol: 'BTC/USD', side: 'buy', type: 'market', usd_size: 100, leverage: 3,
      lane: 'volume_breakout_3x', ticketId: ticket.ticketId, idempotencyKey: 'sidecar-pending-1',
    } })

    expect(result).toEqual(expect.objectContaining({
      success: false,
      pending: true,
      brokerWriteOutcome: 'command_accepted',
      error: 'broker_outcome_pending',
    }))
    expect(engine.placeOrder).not.toHaveBeenCalled()
    await expect(harness.options.idempotencyStore.get('sidecar-pending-1'))
      .resolves.toEqual(expect.objectContaining({
        status: 'unresolved',
        commandId: '1'.repeat(64),
        permitV2Id: '2'.repeat(64),
        acceptedSequence: '7',
        clientOrderId: `OA${'A'.repeat(30)}`,
        error: 'broker_outcome_pending',
      }))
    expect(receiptSink).not.toHaveBeenCalledWith(expect.objectContaining({
      status: expect.stringMatching(/^broker_/),
    }))
  })

  it('does not fall back to native mutation when the sidecar reports submission_unknown or throws', async () => {
    const engine = makeEngine()
    const receiptSink = vi.fn().mockResolvedValue(undefined)
    const harness = await makeHarness(makeDecision({ paperAllowed: true }))
    const ticket = harness.ticketStore.issue({ symbol: 'BTC/USD', action: 'placeOrder' })
    const throwTicket = harness.ticketStore.issue({ symbol: 'BTC/USD', action: 'placeOrder' })
    const writer: AuthorizedBrokerWriter = {
      placeOrder: vi.fn()
        .mockResolvedValueOnce({ kind: 'submission_unknown', error: 'sidecar timeout' })
        .mockRejectedValueOnce(new Error('sidecar transport failed')),
      cancelOrder: vi.fn(),
      adjustLeverage: vi.fn(),
    }
    const dispatcher = createCryptoOperationDispatcher(engine, {
      ...harness.options,
      executionReceiptSink: receiptSink,
      brokerWriteRoute: 'sidecar', authorizedBrokerWriter: writer,
    })
    const order = (idempotencyKey: string, ticketId = ticket.ticketId) => dispatcher.dispatch({ action: 'placeOrder', params: {
      symbol: 'BTC/USD', side: 'buy', type: 'market', usd_size: 100, leverage: 3,
      lane: 'volume_breakout_3x', ticketId, idempotencyKey,
    } })

    await expect(order('sidecar-unknown-1')).resolves.toEqual(expect.objectContaining({
      success: false,
      unknown: true,
      brokerWriteOutcome: 'submission_unknown',
      error: 'execution_sidecar_submission_unknown',
    }))
    await expect(order('sidecar-throws-1', throwTicket.ticketId)).resolves.toEqual(expect.objectContaining({
      success: false,
      unknown: true,
      brokerWriteOutcome: 'submission_unknown',
      error: 'execution_sidecar_submission_unknown',
    }))
    expect(writer.placeOrder).toHaveBeenCalledTimes(2)
    expect(engine.placeOrder).not.toHaveBeenCalled()
    await expect(harness.options.idempotencyStore.get('sidecar-unknown-1'))
      .resolves.toEqual(expect.objectContaining({
        status: 'unresolved',
        error: 'execution_sidecar_submission_unknown',
      }))
    await expect(harness.options.idempotencyStore.get('sidecar-throws-1'))
      .resolves.toEqual(expect.objectContaining({
        status: 'unresolved',
        error: 'execution_sidecar_submission_unknown',
      }))
    expect(receiptSink).not.toHaveBeenCalledWith(expect.objectContaining({
      status: expect.stringMatching(/^broker_/),
    }))
  })

  it('finalizes a proven pre-submit rejection without classifying it as unknown', async () => {
    const engine = makeEngine()
    const receiptSink = vi.fn().mockResolvedValue(undefined)
    const harness = await makeHarness(makeDecision({ paperAllowed: true }))
    const ticket = harness.ticketStore.issue({ symbol: 'BTC/USD', action: 'placeOrder' })
    const writer: AuthorizedBrokerWriter = {
      placeOrder: vi.fn().mockResolvedValue({
        kind: 'pre_submit_rejected',
        error: 'execution_sidecar_time_in_force_required',
      }),
      cancelOrder: vi.fn(),
      adjustLeverage: vi.fn(),
    }
    const dispatcher = createCryptoOperationDispatcher(engine, {
      ...harness.options,
      executionReceiptSink: receiptSink,
      brokerWriteRoute: 'sidecar',
      authorizedBrokerWriter: writer,
    })

    const result = await dispatcher.dispatch({ action: 'placeOrder', params: {
      symbol: 'BTC/USD', side: 'buy', type: 'market', usd_size: 100, leverage: 3,
      lane: 'volume_breakout_3x', ticketId: ticket.ticketId,
      idempotencyKey: 'sidecar-pre-submit-1',
    } })

    expect(result).toEqual(expect.objectContaining({
      success: false,
      brokerWriteOutcome: 'pre_submit_rejected',
      error: 'execution_sidecar_pre_submit_rejected',
    }))
    expect(result).not.toEqual(expect.objectContaining({ unknown: true }))
    expect(engine.placeOrder).not.toHaveBeenCalled()
    await expect(harness.options.idempotencyStore.get('sidecar-pre-submit-1'))
      .resolves.toEqual(expect.objectContaining({ status: 'failed' }))
    expect(receiptSink).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }))
    expect(receiptSink).not.toHaveBeenCalledWith(expect.objectContaining({
      status: expect.stringMatching(/^broker_/),
    }))
  })

  it('classifies an outer dispatcher timeout after sidecar invocation as submission_unknown', async () => {
    const engine = makeEngine()
    const receiptSink = vi.fn().mockResolvedValue(undefined)
    const harness = await makeHarness(makeDecision({ paperAllowed: true }))
    const ticket = harness.ticketStore.issue({ symbol: 'BTC/USD', action: 'placeOrder' })
    const writer: AuthorizedBrokerWriter = {
      placeOrder: vi.fn().mockReturnValue(new Promise(() => {})),
      cancelOrder: vi.fn(),
      adjustLeverage: vi.fn(),
    }
    const dispatcher = createCryptoOperationDispatcher(engine, {
      ...harness.options,
      operationTimeoutMs: 5,
      executionReceiptSink: receiptSink,
      brokerWriteRoute: 'sidecar',
      authorizedBrokerWriter: writer,
    })

    const result = await dispatcher.dispatch({ action: 'placeOrder', params: {
      symbol: 'BTC/USD', side: 'buy', type: 'market', usd_size: 100, leverage: 3,
      lane: 'volume_breakout_3x', ticketId: ticket.ticketId, idempotencyKey: 'sidecar-outer-timeout-1',
    } })

    expect(result).toEqual(expect.objectContaining({
      success: false,
      unknown: true,
      brokerWriteOutcome: 'submission_unknown',
      error: 'execution_sidecar_submission_unknown',
    }))
    expect(engine.placeOrder).not.toHaveBeenCalled()
    await expect(harness.options.idempotencyStore.get('sidecar-outer-timeout-1'))
      .resolves.toEqual(expect.objectContaining({ status: 'unresolved' }))
    expect(receiptSink).not.toHaveBeenCalledWith(expect.objectContaining({
      status: expect.stringMatching(/^broker_/),
    }))
  })

  it('counts an unresolved sidecar command explicitly in push summary', async () => {
    const engine = makeEngine()
    const harness = await makeHarness(makeDecision({ paperAllowed: true }))
    const ticket = harness.ticketStore.issue({ symbol: 'BTC/USD', action: 'placeOrder' })
    const writer: AuthorizedBrokerWriter = {
      placeOrder: vi.fn().mockResolvedValue({ kind: 'command_accepted', commandId: '2'.repeat(64) }),
      cancelOrder: vi.fn(),
      adjustLeverage: vi.fn(),
    }
    const dispatcher = createCryptoOperationDispatcher(engine, {
      ...harness.options,
      brokerWriteRoute: 'sidecar',
      authorizedBrokerWriter: writer,
    })

    const result = await dispatcher.push('commit-sidecar-unknown-1', [{
      action: 'placeOrder',
      params: {
        symbol: 'BTC/USD', side: 'buy', type: 'market', usd_size: 100, leverage: 3,
        lane: 'volume_breakout_3x', ticketId: ticket.ticketId, idempotencyKey: 'sidecar-push-1',
      },
    }])

    expect(result.operations).toEqual([
      expect.objectContaining({ status: 'unknown' }),
    ])
    expect(result.summary).toEqual({ succeeded: 0, failed: 0, skipped: 0, unknown: 1 })
    expect(Object.values(result.summary).reduce((total, count) => total + count, 0))
      .toBe(result.operations.length)
  })

  it('persists unresolved simple-action idempotency when a sidecar write throws', async () => {
    const engine = makeEngine({
      getOrders: vi.fn().mockResolvedValue([{
        id: 'order-to-cancel',
        symbol: 'BTC/USD',
        side: 'buy',
        type: 'limit',
        size: 0.001,
        price: 95_000,
        status: 'pending',
        createdAt: new Date(),
      }]),
    })
    const receiptSink = vi.fn().mockResolvedValue(undefined)
    const harness = await makeHarness(makeDecision({ paperAllowed: true }))
    const ticket = harness.ticketStore.issue({ symbol: 'BTC/USD', action: 'cancelOrder' })
    const writer: AuthorizedBrokerWriter = {
      placeOrder: vi.fn(),
      cancelOrder: vi.fn().mockRejectedValue(new Error('sidecar cancel transport failed')),
      adjustLeverage: vi.fn(),
    }
    const dispatcher = createCryptoOperationDispatcher(engine, {
      ...harness.options,
      executionReceiptSink: receiptSink,
      brokerWriteRoute: 'sidecar',
      authorizedBrokerWriter: writer,
    })

    const result = await dispatcher.dispatch({ action: 'cancelOrder', params: {
      orderId: 'order-to-cancel',
      ticketId: ticket.ticketId,
      idempotencyKey: 'sidecar-cancel-throws-1',
    } })

    expect(result).toEqual(expect.objectContaining({
      success: false,
      unknown: true,
      brokerWriteOutcome: 'submission_unknown',
      error: 'execution_sidecar_submission_unknown',
    }))
    expect(writer.cancelOrder).toHaveBeenCalledTimes(1)
    expect(engine.cancelOrder).not.toHaveBeenCalled()
    await expect(harness.options.idempotencyStore.get('sidecar-cancel-throws-1'))
      .resolves.toEqual(expect.objectContaining({ status: 'unresolved' }))
    expect(receiptSink).not.toHaveBeenCalledWith(expect.objectContaining({
      status: expect.stringMatching(/^broker_/),
    }))
  })

  it('finalizes an unsupported sidecar simple action as pre-submit rejected', async () => {
    const engine = makeEngine({
      getOrders: vi.fn().mockResolvedValue([{
        id: 'order-to-cancel', symbol: 'BTC/USD', side: 'buy', type: 'limit',
        size: 0.001, price: 95_000, status: 'pending', createdAt: new Date(),
      }]),
    })
    const receiptSink = vi.fn().mockResolvedValue(undefined)
    const harness = await makeHarness(makeDecision({ paperAllowed: true }))
    const ticket = harness.ticketStore.issue({ symbol: 'BTC/USD', action: 'cancelOrder' })
    const writer: AuthorizedBrokerWriter = {
      placeOrder: vi.fn(),
      cancelOrder: vi.fn().mockResolvedValue({
        kind: 'pre_submit_rejected',
        error: 'execution_sidecar_cancel_unsupported',
      }),
      adjustLeverage: vi.fn(),
    }
    const dispatcher = createCryptoOperationDispatcher(engine, {
      ...harness.options,
      executionReceiptSink: receiptSink,
      brokerWriteRoute: 'sidecar',
      authorizedBrokerWriter: writer,
    })

    const result = await dispatcher.dispatch({ action: 'cancelOrder', params: {
      orderId: 'order-to-cancel', ticketId: ticket.ticketId,
      idempotencyKey: 'sidecar-cancel-pre-submit-1',
    } })

    expect(result).toEqual(expect.objectContaining({
      success: false,
      brokerWriteOutcome: 'pre_submit_rejected',
      error: 'execution_sidecar_pre_submit_rejected',
    }))
    expect(engine.cancelOrder).not.toHaveBeenCalled()
    await expect(harness.options.idempotencyStore.get('sidecar-cancel-pre-submit-1'))
      .resolves.toEqual(expect.objectContaining({ status: 'failed' }))
    expect(receiptSink).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }))
  })

  it('opens the account circuit when an unresolved simple action cannot persist', async () => {
    const engine = makeEngine({
      getOrders: vi.fn().mockResolvedValue([{
        id: 'order-to-cancel', symbol: 'BTC/USD', side: 'buy', type: 'limit',
        size: 0.001, price: 95_000, status: 'pending', createdAt: new Date(),
      }]),
    })
    const harness = await makeHarness(makeDecision({
      paperAllowed: true,
      accountScope: ['simple-action-persistence-circuit-account'],
    }))
    const cancelTicket = harness.ticketStore.issue({ symbol: 'BTC/USD', action: 'cancelOrder' })
    const placeTicket = harness.ticketStore.issue({ symbol: 'BTC/USD', action: 'placeOrder' })
    const writer: AuthorizedBrokerWriter = {
      placeOrder: vi.fn().mockResolvedValue({ kind: 'command_accepted', commandId: '9'.repeat(64) }),
      cancelOrder: vi.fn().mockResolvedValue({
        kind: 'command_accepted',
        commandId: '8'.repeat(64),
      }),
      adjustLeverage: vi.fn(),
    }
    vi.spyOn(harness.options.idempotencyStore, 'markUnresolved').mockRejectedValueOnce(
      new Error('credential=must-not-reach-logs-or-caller'),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const dispatcher = createCryptoOperationDispatcher(engine, {
      ...harness.options,
      accountId: 'simple-action-persistence-circuit-account',
      brokerWriteRoute: 'sidecar',
      authorizedBrokerWriter: writer,
    })

    try {
      await expect(dispatcher.dispatch({ action: 'cancelOrder', params: {
        orderId: 'order-to-cancel',
        ticketId: cancelTicket.ticketId,
        idempotencyKey: 'simple-action-persistence-fails-1',
      } })).resolves.toEqual(expect.objectContaining({
        success: false,
        unknown: true,
        brokerWriteOutcome: 'submission_unknown',
        error: 'SECURITY: sidecar place-order circuit open; restart required before submitting another order',
      }))
      await expect(dispatcher.dispatch({ action: 'placeOrder', params: {
        symbol: 'BTC/USD', side: 'buy', type: 'market', usd_size: 100, leverage: 3,
        lane: 'volume_breakout_3x', ticketId: placeTicket.ticketId,
        idempotencyKey: 'simple-action-persistence-fails-2',
      } })).resolves.toEqual(expect.objectContaining({
        success: false,
        error: 'SECURITY: sidecar place-order circuit open; restart required before submitting another order',
      }))
      expect(writer.cancelOrder).toHaveBeenCalledTimes(1)
      expect(writer.placeOrder).not.toHaveBeenCalled()
      expect(JSON.stringify(warn.mock.calls)).not.toContain('credential=must-not-reach-logs-or-caller')
    } finally {
      warn.mockRestore()
    }
  })

  it('passes a test_bypass through to the sidecar, which may reject it without native fallback', async () => {
    const engine = makeEngine()
    const writer: AuthorizedBrokerWriter = {
      placeOrder: vi.fn(async (_request, authorization) => {
        if (authorization.kind === 'test_bypass') {
          throw new Error('sidecar rejects test_bypass')
        }
        return { kind: 'broker_final' as const, result: { success: true } }
      }),
      cancelOrder: vi.fn(),
      adjustLeverage: vi.fn(),
    }
    const dispatcher = createCryptoOperationDispatcher(engine, {
      allowTestExecutionPermitBypass: true,
      brokerWriteRoute: 'sidecar',
      authorizedBrokerWriter: writer,
      productionRiskPreflightPolicy: READY_DENY_ONLY_PRODUCTION_RISK_POLICY,
    })

    await expect(dispatcher.dispatch({ action: 'placeOrder', params: {
      symbol: 'BTC/USD', side: 'buy', type: 'market', usd_size: 100, leverage: 3,
      lane: 'volume_breakout_3x',
    } })).resolves.toEqual(expect.objectContaining({
      success: false,
      unknown: true,
      brokerWriteOutcome: 'submission_unknown',
      error: 'execution_sidecar_submission_unknown',
    }))
    expect(writer.placeOrder).toHaveBeenCalledTimes(1)
    expect(engine.placeOrder).not.toHaveBeenCalled()
  })

  it('fails closed when the dispatcher has no authority provider', async () => {
    const engine = makeEngine()
    const dispatcher = createCryptoOperationDispatcher(engine, {
      accountId: 'paper-main',
      accountMode: 'paper_only',
      productionRiskPreflightPolicy: READY_DENY_ONLY_PRODUCTION_RISK_POLICY,
    })
    const result = await dispatcher.dispatch({
      action: 'placeOrder',
      params: {
        symbol: 'BTC/USD',
        side: 'buy',
        type: 'market',
        usd_size: 100,
        leverage: 3,
        lane: 'volume_breakout_3x',
      },
    })
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('execution_authority_provider_missing'),
    })
    expect(engine.placeOrder).not.toHaveBeenCalled()
  })

  it('permits a proven reduce-only write without allowing a new open', async () => {
    const engine = makeEngine({
      getPositions: vi.fn().mockResolvedValue([{
        symbol: 'BTC/USD',
        side: 'long',
        size: 0.5,
        entryPrice: 90_000,
        leverage: 3,
        margin: 15_000,
        liquidationPrice: 60_000,
        markPrice: 95_000,
        unrealizedPnL: 2_500,
        positionValue: 47_500,
      }]),
    })
    const harness = await makeHarness(makeDecision({}))
    const ticket = harness.ticketStore.issue({ symbol: 'BTC/USD', action: 'placeOrder' })
    const dispatcher = createCryptoOperationDispatcher(engine, harness.options)

    const result = await dispatcher.dispatch({
      action: 'placeOrder',
      params: {
        symbol: 'BTC/USD',
        side: 'sell',
        type: 'market',
        size: 0.1,
        leverage: 3,
        reduceOnly: true,
        lane: 'volume_breakout_3x',
        ticketId: ticket.ticketId,
        idempotencyKey: 'reduce-permit-1',
      },
    })

    expect(result).toEqual(expect.objectContaining({ success: true }))
    expect(engine.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      reduceOnly: true,
      side: 'sell',
    }))
  })
})

async function makeHarness(decision: AdmissionDecisionV1) {
  const tempDir = await mkdtemp(join(tmpdir(), 'execution-permit-dispatcher-'))
  const ticketStore = new DecisionTicketStore({ required: true, ttlMs: 60_000 })
  stores.push(ticketStore)
  const provider: ExecutionAuthorityProvider = async () => ({
    decision,
    identity: {
      runtimeRole: 'primary',
      sourceCommit: decision.sourceCommit,
      dirtyStateHash: decision.dirtyStateHash,
      releaseManifestHash: decision.releaseManifestHash,
    },
  })
  return {
    ticketStore,
    options: {
      ticketStore,
      idempotencyStore: new TradeIdempotencyStore(join(tempDir, 'idempotency.json')),
      killSwitch: new KillSwitch(),
      executionAuthorityProvider: provider,
      accountId: 'paper-main',
      accountMode: 'paper_only' as const,
      productionRiskPreflightPolicy: READY_DENY_ONLY_PRODUCTION_RISK_POLICY,
    },
  }
}

function makeEngine(overrides: Partial<ICryptoTradingEngine> = {}): ICryptoTradingEngine {
  return {
    placeOrder: vi.fn().mockResolvedValue({
      success: true,
      orderId: 'order-1',
      filledPrice: 95_000,
      filledSize: 0.001,
    }),
    getPositions: vi.fn().mockResolvedValue([]),
    getOrders: vi.fn().mockResolvedValue([]),
    getAccount: vi.fn().mockResolvedValue({
      balance: 10_000,
      equity: 10_000,
      totalMargin: 0,
      unrealizedPnL: 0,
      realizedPnL: 0,
      totalPnL: 0,
    }),
    cancelOrder: vi.fn().mockResolvedValue(true),
    adjustLeverage: vi.fn().mockResolvedValue({ success: true }),
    getTicker: vi.fn().mockResolvedValue({
      symbol: 'BTC/USD',
      last: 95_000,
      bid: 94_999,
      ask: 95_001,
      high: 96_000,
      low: 94_000,
      volume: 1_000,
      timestamp: new Date(),
    }),
    getFundingRate: vi.fn(),
    getOrderBook: vi.fn(),
    ...overrides,
  }
}

function makeDecision(input: {
  paperAllowed?: boolean
  liveAllowed?: boolean
  liveArmed?: boolean
  accountScope?: string[]
}): AdmissionDecisionV1 {
  const now = new Date()
  const paperAllowed = input.paperAllowed ?? false
  const liveAllowed = input.liveAllowed ?? false
  const liveArmed = input.liveArmed ?? false
  const gates = [
    'promotion_v2_6',
    'risk',
    'kill_switch',
    'data_freshness',
    ...(liveAllowed ? ['live_dual_approval'] : []),
  ]
  const core: Omit<AdmissionDecisionV1, 'schemaVersion' | 'decisionId'> = {
    candidateId: 'candidate-v2',
    evaluatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    sourceCommit: '1'.repeat(40),
    dirtyStateHash: '2'.repeat(64),
    releaseManifestHash: '3'.repeat(64),
    stage: liveAllowed ? 'live_allowed' : paperAllowed ? 'paper_allowed' : 'research_only',
    paperTradingAllowed: paperAllowed,
    liveTradingAllowed: liveAllowed,
    liveExecutionArmed: liveArmed,
    gateResults: gates.map((gateId, index) => ({
      gateId,
      status: 'pass' as const,
      evidenceRefs: [(index + 4).toString(16).repeat(64).slice(0, 64)],
      reasonCodes: [],
    })),
    blockingReasons: paperAllowed ? [] : ['paper_blocked'],
    evidenceRefs: gates.map((_, index) => (index + 4).toString(16).repeat(64).slice(0, 64)),
    approvalRefs: liveAllowed ? ['approval-a', 'approval-b'] : [],
    accountScope: input.accountScope ?? ['paper-main'],
    assetScope: ['BTC/USD'],
  }
  return {
    schemaVersion: 'admission_decision.v1',
    decisionId: admissionDecisionId(core),
    ...core,
  }
}
