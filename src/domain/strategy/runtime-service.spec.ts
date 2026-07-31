import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mocks = vi.hoisted(() => ({
  readStrategyConfig: vi.fn(),
}))

vi.mock('../../core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/config.js')>()
  return {
    ...actual,
    readStrategyConfig: mocks.readStrategyConfig,
  }
})

import { evaluateRuntimeStrategySnapshotFromSources } from './runtime-service.js'
import type { StrategyConfig } from '../../core/config.js'

function makeCandles(count: number) {
  const intervalMs = 60 * 60_000
  const startMs = Date.now() - (count - 1) * intervalMs
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(startMs + index * intervalMs).toISOString(),
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
    volume: 1000 + index,
  }))
}

function makePosition(input: {
  symbol: string
  side: 'long' | 'short'
  quantity: number
  marketValue: number
}) {
  return {
    contract: {
      symbol: input.symbol,
      localSymbol: input.symbol,
      aliceId: input.symbol,
    },
    side: input.side,
    quantity: {
      toNumber: () => input.quantity,
    },
    avgCost: input.marketValue / input.quantity,
    marketPrice: input.marketValue / input.quantity,
    marketValue: input.marketValue,
    unrealizedPnL: 0,
    realizedPnL: 0,
  } as any
}

function makeAccountManager(positions: any[]) {
  return {
    resolve: vi.fn(() => [
      {
        id: 'uta-1',
        getAccount: vi.fn(async () => ({ netLiquidation: 10000 })),
        getPositions: vi.fn(async () => positions),
      },
    ]),
  } as any
}

const baseConfig: StrategyConfig = {
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
    meanReversion: { enabled: true, weight: 1 },
    volatilityRegime: { enabled: true, weight: 1 },
    liquidationPressure: { enabled: true, weight: 1 },
    crossTimeframeDivergence: { enabled: true, weight: 1 },
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
}

describe('runtime service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readStrategyConfig.mockResolvedValue(baseConfig)
  })

  it('finalizes provenance without throwing for derivative-free runtime snapshots', async () => {
    const snapshot = await evaluateRuntimeStrategySnapshotFromSources({
      cryptoClient: {
        getHistorical: vi.fn(async () => makeCandles(48)),
      } as any,
      accountManager: {
        resolve: vi.fn(() => []),
      } as any,
      request: {
        symbol: 'BTC/USD',
      },
    })

    expect(snapshot.dataProvenance).toMatchObject({
      candles: expect.objectContaining({ status: 'resolved', source: 'market-data' }),
      fundingRate: expect.objectContaining({ status: 'missing' }),
      basis: expect.objectContaining({ status: 'missing' }),
      openInterest: expect.objectContaining({ status: 'missing' }),
      liquidation: expect.objectContaining({ status: 'missing' }),
      completeness: 'minimal',
    })
  })

  it('routes same-direction orders through the new-open sizing path even when reduceOnly is set', async () => {
    const snapshot = await evaluateRuntimeStrategySnapshotFromSources({
      cryptoClient: {
        getHistorical: vi.fn(async () => makeCandles(48)),
      } as any,
      accountManager: makeAccountManager([
        makePosition({
          symbol: 'BTC/USDT:USDT',
          side: 'long',
          quantity: 1,
          marketValue: 50000,
        }),
      ]),
      request: {
        symbol: 'BTC/USDT:USDT',
        source: 'uta-1',
        side: 'buy',
        requestedUsdSize: 6000,
        reduceOnly: true,
        fundingRatePct: 0.01,
      },
    })

    expect(snapshot.executionPreview?.mode).toBe('applied')
    expect(snapshot.executionPreview?.effectiveUsdSize).toBeLessThan(6000)
  })

  it('passes genuine reductions through without forcing the new-open sizing path', async () => {
    const snapshot = await evaluateRuntimeStrategySnapshotFromSources({
      cryptoClient: {
        getHistorical: vi.fn(async () => makeCandles(48)),
      } as any,
      accountManager: makeAccountManager([
        makePosition({
          symbol: 'BTC/USDT:USDT',
          side: 'long',
          quantity: 1,
          marketValue: 50000,
        }),
      ]),
      request: {
        symbol: 'BTC/USDT:USDT',
        source: 'uta-1',
        side: 'sell',
        requestedUsdSize: 1000,
      },
    })

    expect(snapshot.executionPreview?.mode).toBe('pass-through')
    expect(snapshot.executionPreview?.effectiveUsdSize).toBe(1000)
  })

  it('passes request history fields through to runtime factor evaluation', async () => {
    const now = Date.now()
    const hourMs = 60 * 60 * 1000
    const liquidationHistory = [
      ...Array.from({ length: 9 }, (_, index) => ({
        value: 100,
        timestampMs: now - (index + 1) * hourMs,
      })),
      {
        value: 1000,
        timestampMs: now - 6 * hourMs,
      },
    ]

    const snapshot = await evaluateRuntimeStrategySnapshotFromSources({
      cryptoClient: {
        getHistorical: vi.fn(async () => makeCandles(48)),
      } as any,
      accountManager: {
        resolve: vi.fn(() => []),
      } as any,
      request: {
        symbol: 'BTC/USD',
        liquidationHistory,
      },
    })

    expect(snapshot.factorSignals.some((signal) => signal.name === 'liquidation-aftermath')).toBe(true)
    expect(snapshot.derivedMetrics.liquidationNotional24h).toBeNull()
  })

  it('persists IC monitor snapshot to disk after strategy evaluation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-save-'))
    process.env.OPENALICE_DATA_DIR = tmpDir

    vi.resetModules()
    const mod = await import('./runtime-service.js')
    const snapshot = await mod.evaluateRuntimeStrategySnapshotFromSources({
      cryptoClient: { getHistorical: vi.fn(async () => makeCandles(48)) } as any,
      accountManager: { resolve: vi.fn(() => []) } as any,
      request: { symbol: 'BTC/USD' },
    })

    expect(snapshot).toBeDefined()
    expect(snapshot.icMonitorSnapshot).toBeDefined()

    const byKeyPath = path.join(tmpDir, 'runtime', 'ic_monitor_snapshot.by_key.json')
    const saved = JSON.parse(fs.readFileSync(byKeyPath, 'utf-8'))
    const keys = Object.keys(saved)
    expect(keys.length).toBeGreaterThan(0)

    process.env.OPENALICE_DATA_DIR = undefined
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('starts fresh without crash when no IC snapshot file exists', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-clean-'))
    process.env.OPENALICE_DATA_DIR = tmpDir

    vi.resetModules()
    const mod = await import('./runtime-service.js')
    const snapshot = await mod.evaluateRuntimeStrategySnapshotFromSources({
      cryptoClient: { getHistorical: vi.fn(async () => makeCandles(48)) } as any,
      accountManager: { resolve: vi.fn(() => []) } as any,
      request: { symbol: 'BTC/USD' },
    })

    expect(snapshot).toBeDefined()

    process.env.OPENALICE_DATA_DIR = undefined
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
