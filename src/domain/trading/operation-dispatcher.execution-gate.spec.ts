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

const stores: DecisionTicketStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.destroy()
})

describe('dispatcher execution permit hard gate', () => {
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
    accountScope: ['paper-main'],
    assetScope: ['BTC/USD'],
  }
  return {
    schemaVersion: 'admission_decision.v1',
    decisionId: admissionDecisionId(core),
    ...core,
  }
}
