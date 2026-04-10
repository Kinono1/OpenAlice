import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readAccountsConfig: vi.fn(),
}))

vi.mock('../../../core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/config.js')>()
  return {
    ...actual,
    readAccountsConfig: mocks.readAccountsConfig,
  }
})

import { createTradingConfigRoutes } from '../routes/trading-config.js'

describe('trading runtime route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.AUTH_TOKEN = 'auth-token'
    process.env.TRADE_TOKEN = 'trade-token'

    mocks.readAccountsConfig.mockResolvedValue([
      {
        id: 'bybit-main',
        type: 'ccxt',
        enabled: true,
        guards: [],
        brokerConfig: { exchange: 'bybit' },
        cryptoExecution: {
          mode: 'paper_only',
          enableCryptoDispatcher: true,
          requireDecisionTicket: false,
          ticketTtlMs: 600000,
          idempotencyTtlMs: 1800000,
          killSwitchDefaultPolicy: 'block_new_only',
        },
      },
      {
        id: 'alpaca-paper',
        type: 'alpaca',
        enabled: true,
        guards: [],
        brokerConfig: { paper: true },
      },
    ])
  })

  it('returns readiness snapshots and per-account crypto runtime', async () => {
    const ctx = {
      config: { engine: { pairs: ['BTC/USD', 'ETH/USD'] } },
      connectorCenter: { hasConnectors: () => true },
      accountManager: {
        listAccounts: () => [
          {
            id: 'bybit-main',
            label: 'Bybit Main',
            health: { status: 'healthy', recovering: false, disabled: false, consecutiveFailures: 0 },
          },
          {
            id: 'alpaca-paper',
            label: 'Alpaca Paper',
            health: { status: 'healthy', recovering: false, disabled: false, consecutiveFailures: 0 },
          },
        ],
        getExecutionRuntime: (id: string) => id === 'bybit-main'
          ? {
              enabled: true,
              mode: 'paper_only',
              requireDecisionTicket: false,
              ticketTtlMs: 600000,
              idempotencyTtlMs: 1800000,
              killSwitchDefaultPolicy: 'block_new_only',
              exchangeId: 'bybit',
              bridgeActive: true,
              intentLedgerPath: '/tmp/intent-ledger.jsonl',
              idempotencyStorePath: '/tmp/idempotency-store.json',
            }
          : undefined,
      },
    } as any

    const app = new Hono()
    app.route('/api/trading/config', createTradingConfigRoutes(ctx))

    const res = await app.request('/api/trading/config/runtime', {
      headers: { Authorization: 'Bearer auth-token' },
    })

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, any>
    expect(body.process.status).toBe('ok')
    expect(body.webReadiness.ready).toBe(true)
    expect(body.signalReadiness.ready).toBe(true)
    expect(body.accounts).toHaveLength(2)
    expect(body.accounts[0]).toMatchObject({
      id: 'bybit-main',
      cryptoExecutionRuntime: {
        bridgeActive: true,
        exchangeId: 'bybit',
      },
    })
    expect(body.accounts[1].cryptoExecutionRuntime).toBeUndefined()
  })
})
