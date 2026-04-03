import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readStrategyConfig: vi.fn(),
  writeConfigSection: vi.fn(),
}))

vi.mock('../../../core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/config.js')>()
  return {
    ...actual,
    readStrategyConfig: mocks.readStrategyConfig,
    writeConfigSection: mocks.writeConfigSection,
  }
})

import { createStrategyRoutes } from '../routes/strategy.js'

describe('strategy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.AUTH_TOKEN = 'auth-token'
    mocks.readStrategyConfig.mockResolvedValue({
      enabled: true,
      governance: {
        useGovernanceGate: true,
        staleDataCapsExecution: true,
        preferReduceOnWeakSignal: false,
      },
      runtime: {
        marketScope: 'crypto',
        runtimeIntegrationEnabled: false,
      },
      eventCalendar: {
        enabled: true,
        events: [],
      },
      factors: {
        fundingRate: { enabled: true, weight: 1 },
        basis: { enabled: true, weight: 1 },
        volumeSurge: { enabled: true, weight: 1 },
        momentumComposite: { enabled: true, weight: 1 },
      },
      positionSizing: {
        enabled: true,
        method: 'fixed',
        defaultAssetLayer: 'core',
        targetVolPct: 10,
        maxPctOfEquity: 0.3,
        kellyFraction: 0.15,
        layerConfigs: [
          {
            layer: 'core',
            maxPositions: 5,
            maxPositionPctOfEquity: 0.3,
            minActionStatusToTrade: 'probe',
            requiresCoreNotRiskOff: false,
          },
        ],
      },
    })
    mocks.writeConfigSection.mockImplementation(async (_section, body) => body)
  })

  it('returns strategy runtime summary', async () => {
    const ctx = {
      cryptoClient: {
        getHistorical: vi.fn(async () => []),
      },
      accountManager: {
        setStrategyConfig: vi.fn(),
        reconnectAccount: vi.fn(async () => ({ success: true })),
      },
    } as any

    const app = new Hono()
    app.route('/api/strategy', createStrategyRoutes(ctx))

    const res = await app.request('/api/strategy/runtime', {
      headers: { Authorization: 'Bearer auth-token' },
    })

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, any>
    expect(body.enabled).toBe(true)
    expect(body.readiness.governanceReady).toBe(true)
    expect(body.factors).toHaveLength(4)
    expect(body.runtime.marketScope).toBe('crypto')
  })

  it('evaluates a strategy snapshot from runtime sources', async () => {
    const ctx = {
      cryptoClient: {
        getHistorical: vi.fn(async () =>
          Array.from({ length: 48 }, (_, index) => ({
            date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
            open: 100 + index,
            high: 101 + index,
            low: 99 + index,
            close: 100 + index,
            volume: 1000 + index,
          })),
        ),
      },
      accountManager: {
        setStrategyConfig: vi.fn(),
        reconnectAccount: vi.fn(async () => ({ success: true })),
        resolve: vi.fn(() => []),
      },
    } as any

    const app = new Hono()
    app.route('/api/strategy', createStrategyRoutes(ctx))

    const res = await app.request('/api/strategy/evaluate', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer auth-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        symbol: 'BTC/USD',
        interval: '1h',
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, any>
    expect(body.symbol).toBe('BTC/USD')
    expect(body.factorSignals.length).toBeGreaterThanOrEqual(2)
    expect(body.governance.actionStatus).toBeTruthy()
  })
})
