import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const runtimeSummary = {
  process: { status: 'ok', uptime: 42 },
  webReadiness: {
    status: 'ready',
    ready: true,
    checks: {
      config: { ok: true, detail: 'Config loaded' },
      auth: { ok: true, detail: 'Auth tokens configured' },
      connectors: { ok: true, detail: 'Outbound connector available' },
    },
  },
  signalReadiness: {
    status: 'ready',
    ready: true,
    mode: 'paper_only',
    authEnforced: true,
    authConfigured: true,
    supportedSymbols: ['BTC/USD'],
    tradingReady: true,
    reasons: [],
  },
  accounts: [
    {
      id: 'bybit-main',
      label: 'Bybit Main',
      type: 'ccxt',
      enabled: true,
      health: {
        status: 'healthy',
        recovering: false,
        disabled: false,
        consecutiveFailures: 0,
      },
      cryptoExecutionRuntime: {
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
      },
    },
  ],
}

vi.mock('../hooks/useTradingConfig', () => ({
  useTradingConfig: () => ({
    accounts: [
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
    ],
    loading: false,
    error: null,
    saveAccount: vi.fn(),
    deleteAccount: vi.fn(),
    reconnectAccount: vi.fn(),
    refresh: vi.fn(),
  }),
}))

vi.mock('../hooks/useAccountHealth', () => ({
  useAccountHealth: () => ({
    'bybit-main': {
      status: 'healthy',
      recovering: false,
      disabled: false,
      consecutiveFailures: 0,
    },
  }),
}))

vi.mock('../hooks/useTradingRuntimeSummary', () => ({
  useTradingRuntimeSummary: () => ({
    runtime: runtimeSummary,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}))

vi.mock('../api', () => ({
  api: {
    trading: {
      getBrokerTypes: vi.fn().mockResolvedValue({
        brokerTypes: [
          {
            type: 'ccxt',
            name: 'CCXT',
            description: 'Crypto exchange',
            badge: 'CX',
            badgeColor: 'text-green',
            fields: [],
            subtitleFields: [],
            guardCategory: 'crypto',
          },
        ],
      }),
      testConnection: vi.fn(),
    },
  },
}))

import { TradingPage } from './TradingPage'

describe('TradingPage', () => {
  it('renders operator readiness and CCXT execution badges', async () => {
    render(<TradingPage />)

    expect(screen.getByText('Operator Readiness')).toBeTruthy()
    expect(screen.getByText('Process Health')).toBeTruthy()
    expect(screen.getByText('Signal Intake')).toBeTruthy()
    expect(screen.getByText('Crypto Dispatcher')).toBeTruthy()
    expect(screen.getByText('Paper Only')).toBeTruthy()
    expect(screen.getByText(/Kill Switch:/)).toBeTruthy()
  })
})
