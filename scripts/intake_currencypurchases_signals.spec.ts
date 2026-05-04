import { describe, expect, it } from 'vitest'
import {
  evaluateLocalGates,
  type BridgePayload,
  type CPExtSignal,
  type ExecutedEntry,
} from './intake_currencypurchases_signals.js'

describe('intake_currencypurchases_signals', () => {
  const nowMs = Date.parse('2026-05-04T00:00:00.000Z')

  function signal(overrides: Partial<CPExtSignal> = {}): CPExtSignal {
    return {
      signal_id: 'CP-1',
      source: 'cp',
      strategy_id: 'test',
      symbol: 'BTC-USDT',
      as_of: '2026-05-03T23:59:30.000Z',
      ttl_ms: 120_000,
      target_position_pct: 0,
      confidence: 0.8,
      thesis: 'test',
      risk_note: 'test',
      trace: {},
      ...overrides,
    }
  }

  function payload(mode: BridgePayload['mode']): Pick<BridgePayload, 'mode'> {
    return { mode }
  }

  it('passes fresh observation signals while keeping execution suppressed', () => {
    const result = evaluateLocalGates(signal(), payload('observation'), [], new Set(['CP-1']), nowMs)

    expect(result).toEqual({
      status: 'pass',
      meta: {
        confidence: 0.8,
        ageMs: 30_000,
        targetPositionPct: 0,
        mode: 'observation',
        executionSuppressed: false,
        paperExecutionAllowed: false,
      },
    })
  })

  it('rejects observation payloads that carry non-zero targets', () => {
    const result = evaluateLocalGates(
      signal({ target_position_pct: 0.1 }),
      payload('observation'),
      [],
      new Set(['CP-1']),
      nowMs,
    )

    expect(result).toMatchObject({
      status: 'reject',
      meta: {
        reason: 'mode_target_mismatch:observation_nonzero_target',
        mode: 'observation',
        targetPositionPct: 0.1,
        paperExecutionAllowed: false,
      },
    })
  })

  it('allows ticket intent through local gates but marks execution suppressed', () => {
    const result = evaluateLocalGates(
      signal({ target_position_pct: 0.1 }),
      payload('ticket'),
      [],
      new Set(['CP-1']),
      nowMs,
    )

    expect(result).toMatchObject({
      status: 'pass',
      meta: {
        targetPositionPct: 0.1,
        mode: 'ticket',
        executionSuppressed: true,
        paperExecutionAllowed: false,
      },
    })
  })

  it('rejects invalid time and TTL fields fail-closed', () => {
    expect(evaluateLocalGates(
      signal({ as_of: 'not-a-date' }),
      payload('observation'),
      [],
      new Set(['CP-1']),
      nowMs,
    )).toMatchObject({ status: 'reject', meta: { reason: 'invalid_as_of' } })

    expect(evaluateLocalGates(
      signal({ ttl_ms: Number.NaN }),
      payload('observation'),
      [],
      new Set(['CP-1']),
      nowMs,
    )).toMatchObject({ status: 'reject', meta: { reason: 'invalid_ttl_ms' } })

    expect(evaluateLocalGates(
      signal({ ttl_ms: 0 }),
      payload('observation'),
      [],
      new Set(['CP-1']),
      nowMs,
    )).toMatchObject({ status: 'reject', meta: { reason: 'ttl_ms_out_of_bounds' } })
  })

  it('rejects stale, low-confidence, and already executed signals', () => {
    expect(evaluateLocalGates(
      signal({ as_of: '2026-05-03T23:00:00.000Z', ttl_ms: 120_000 }),
      payload('observation'),
      [],
      new Set(['CP-1']),
      nowMs,
    )).toMatchObject({ status: 'reject', meta: { reason: 'ttl_expired' } })

    expect(evaluateLocalGates(
      signal({ confidence: 0.49 }),
      payload('observation'),
      [],
      new Set(['CP-1']),
      nowMs,
    )).toMatchObject({ status: 'reject', meta: { reason: 'low_confidence' } })

    const executed: ExecutedEntry[] = [{ signal_id: 'CP-1', executedAt: nowMs - 1_000 }]
    expect(evaluateLocalGates(
      signal(),
      payload('observation'),
      executed,
      new Set(['CP-1']),
      nowMs,
    )).toMatchObject({ status: 'reject', meta: { reason: 'already_executed' } })
  })
})
