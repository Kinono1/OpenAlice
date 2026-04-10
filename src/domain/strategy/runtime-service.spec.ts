import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
    volume: 1000 + index,
  }))
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
})
