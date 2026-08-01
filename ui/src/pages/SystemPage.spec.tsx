import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const { status } = vi.hoisted(() => ({ status: {
  schemaVersion: 'system_status.v1',
  generatedAt: '2026-08-01T00:00:00.000Z',
  statusSource: 'stale',
  release: {
    currentCommit: null,
    previousCommit: null,
    manifestHash: null,
    runtimeRole: 'canary',
    dirtyState: 'unknown',
    evidenceTrust: 'stale',
  },
  scheduler: {
    owner: null,
    success: 0,
    failure: 0,
    circuitOpen: 0,
    pausedExternalDependency: 0,
  },
  dataFreshness: {
    market_1h: { status: 'stale', ageMs: 7_200_001, evidenceRef: null },
    market_5m: { status: 'missing', ageMs: null, evidenceRef: null },
  },
  pipelineRegistry: { registered: 0, total: 0, coveragePct: 0, registryHash: null },
  sidecars: [
    { source: 'tradingagents', commit: null, status: 'unknown', lastReceiptAt: null, reason: 'receipt_missing' },
    { source: 'alphaswarm', commit: null, status: 'blocked', lastReceiptAt: null, reason: 'invalid_receipt' },
  ],
  admission: {
    schemaVersion: 'admission_decision.v1',
    decisionId: 'a'.repeat(64),
    candidateId: null,
    evaluatedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-01T00:05:00.000Z',
    sourceCommit: '0'.repeat(40),
    dirtyStateHash: '0'.repeat(64),
    releaseManifestHash: '0'.repeat(64),
    stage: 'research_only',
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    liveExecutionArmed: false,
    gateResults: [],
    blockingReasons: ['candidate_missing'],
    evidenceRefs: [],
    approvalRefs: [],
    accountScope: [],
    assetScope: [],
  },
  nextAction: 'refresh_bound_release_and_admission_receipts',
  evidenceRefs: [],
} as const }))

vi.mock('../api', () => ({
  api: { system: { status: vi.fn().mockResolvedValue(status) } },
}))

import { SystemPage, statusTone } from './SystemPage'

describe('SystemPage', () => {
  it('never renders stale or missing evidence as green and exposes no mutation controls', async () => {
    render(<SystemPage />)

    const stale = await screen.findByTestId('freshness-market_1h')
    const missing = screen.getByTestId('freshness-market_5m')
    expect(stale.className).not.toContain('text-green')
    expect(missing.className).not.toContain('text-green')
    expect(screen.getByTestId('evidence-trust').className).not.toContain('text-green')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByText('Promotion and admission')).toBeTruthy()
    expect(screen.getByText(/candidate_missing/)).toBeTruthy()
  })

  it('requires trusted evidence before a positive state can be green', () => {
    expect(statusTone('fresh', false)).not.toContain('text-green')
    expect(statusTone('fresh', true)).toContain('text-green')
    expect(statusTone('stale', true)).not.toContain('text-green')
    expect(statusTone('missing', true)).not.toContain('text-green')
  })
})
