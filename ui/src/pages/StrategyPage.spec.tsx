import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../hooks/useStrategyRuntime', () => ({
  useStrategyRuntime: () => ({
    loading: false,
    error: null,
    saveConfig: vi.fn(),
    refresh: vi.fn(),
    config: {
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
    },
    runtime: {
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
        configuredEventCount: 0,
        active: {
          active: false,
          marketScope: 'crypto',
          activeWindows: [],
        },
      },
      factors: [
        { name: 'fundingRate', enabled: true, weight: 1 },
        { name: 'basis', enabled: true, weight: 1 },
      ],
      readiness: {
        governanceReady: true,
        factorLayerReady: true,
        dataIntegrationReady: false,
        runtimeIntegrationReady: false,
        notes: ['Governance and factor modules are available.'],
      },
    },
  }),
}))

vi.mock('../api', () => ({
  api: {
    strategy: {
      evaluate: vi.fn(async () => ({
        symbol: 'BTC/USD',
        factorSignals: [
          {
            name: 'momentum-composite',
            value: 0.8,
            confidence: 0.7,
            sourceTier: 'L2',
            decisionStrength: 'D2',
            metadata: {},
          },
        ],
        governance: {
          actionStatus: 'attack-lite',
          baseActionStatus: 'attack-lite',
          cappedByEventWindow: false,
          breakdown: {
            totalScore: 76,
            sourceQualityScore: 20,
            marketStructureScore: 25,
            eventSafetyScore: 16,
            sentimentAlignmentScore: 10,
            executionClarityScore: 5,
          },
        },
        ensemble: {
          weights: { 'momentum-composite': 1 },
          aggregateValue: 0.8,
          aggregateConfidence: 0.7,
          consensusScore: 1,
          decisionStrength: 'D2',
        },
        freeze: {
          active: false,
          marketScope: 'crypto',
          activeWindows: [],
        },
        derivedMetrics: {
          return1hPct: 1,
          return6hPct: 2,
          return24hPct: 4,
          return7dPct: 8,
          currentVolume: 100,
          averageVolume: 80,
          realizedVolPct: 10,
        },
        positionSizing: {
          allowed: true,
          maxPositionPctOfEquity: 0.3,
          recommendedPctOfEquity: 0.12,
          requestedPctOfEquity: 0.12,
          recommendedNotionalUsd: 12000,
          assetLayer: 'core',
          equity: 100000,
          method: 'kelly',
          reasons: [],
        },
      })),
    },
  },
}))

import { StrategyPage } from './StrategyPage'

describe('StrategyPage', () => {
  it('renders runtime and factor sections', () => {
    render(<StrategyPage />)

    expect(screen.getByText('Current Strategy State')).toBeTruthy()
    expect(screen.getByText('Governance')).toBeTruthy()
    expect(screen.getByText('Factors')).toBeTruthy()
    expect(screen.getByText('Event Calendar')).toBeTruthy()
    expect(screen.getByText('fundingRate')).toBeTruthy()
    expect(screen.getByText('Evaluate Snapshot')).toBeTruthy()
  })
})
