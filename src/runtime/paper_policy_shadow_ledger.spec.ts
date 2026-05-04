import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appendPaperPolicyShadowOpen,
  appendPaperPolicyShadowOutcome,
  buildPaperPolicyShadowId,
  evaluatePaperPolicyShadowLedger,
  readPaperPolicyShadowLedger,
} from './paper_policy_shadow_ledger.js'

function baseShadow(overrides = {}) {
  return {
    counterfactualType: 'trade_level_shadow' as const,
    eventType: 'open' as const,
    shadowId: 'volume_breakout_1x:BTC-USDT:1700000000000',
    lane: 'volume_breakout_1x',
    symbol: 'BTC-USDT',
    side: 'long' as const,
    entryPrice: 100,
    openTs: '2026-05-02T00:00:00.000Z',
    openBarTime: 1_700_000_000_000,
    horizonMs: 300_000,
    notionalUsd: 1_000,
    stopLossPrice: 98,
    blockReasons: ['break_quality_low', 'spread_unknown'],
    context: {
      contextSnapshotId: 'market_intel:schema:1:generation:7:lane:volume_breakout_1x:flash:3:pro:4:news:5',
      decisionTime: '2026-05-02T00:00:00.000Z',
      marketDataWatermarkAtDecisionTime: '2026-05-02T00:00:00.000Z',
      watermark: '2026-05-02T00:00:00.000Z',
      featuresAvailableAtDecisionTime: true,
      featureSchemaVersion: 'paper_open_context.v3',
      contextGenerationAtOpen: 7,
      contextStatus: 'ok',
      flashContextStatus: 'ok',
      contextReason: null,
      flashEpochAtOpen: 3,
      flashConfidenceLowAtOpen: 0.42,
      proEpochAtOpen: 4,
      marketIntelTriggerAtOpen: 'cached_market_intel',
    },
    quality: {
      confidence: 0.41,
      breakQuality: 0.22,
      liquidityStatus: 'pass',
      spreadStatus: 'unknown',
    },
    cost: {
      roundTripCostBpsAtOpen: 28,
      routeCostBpsAtOpen: 28,
      markMatchStatusAtOpen: 'stale_or_missing',
    },
    ...overrides,
  }
}

async function tempLedgerPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paper-policy-shadow-'))
  return join(root, 'ledger.jsonl')
}

describe('paper_policy_shadow_ledger', () => {
  it('builds deterministic hash shadow ids from trade, policy version, entry time, and policy', () => {
    const input = {
      tradeId: 'volume_breakout:volume_breakout_1x:BTC-USDT:1700000000000:long',
      shadowPolicyVersion: 'volume_breakout_shadow_v1',
      entryTs: 1_700_000_000_000,
      policyId: 'volume_breakout_1x',
    }

    expect(buildPaperPolicyShadowId(input)).toBe(buildPaperPolicyShadowId(input))
    expect(buildPaperPolicyShadowId(input)).toMatch(/^[a-f0-9]{64}$/)
    expect(buildPaperPolicyShadowId({
      ...input,
      shadowPolicyVersion: 'volume_breakout_shadow_v2',
    })).not.toBe(buildPaperPolicyShadowId(input))
    expect(buildPaperPolicyShadowId({
      ...input,
      policyId: 'volume_breakout_3x',
    })).not.toBe(buildPaperPolicyShadowId(input))
  })

  it('appends blocked trade-level shadow signals as JSONL', async () => {
    const path = await tempLedgerPath()

    const result = appendPaperPolicyShadowOpen(baseShadow(), path)

    expect(result).toEqual({
      appended: true,
      shadowId: 'volume_breakout_1x:BTC-USDT:1700000000000',
    })
    const raw = await readFile(path, 'utf-8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({
      counterfactualType: 'trade_level_shadow',
      eventType: 'open',
      shadowId: 'volume_breakout_1x:BTC-USDT:1700000000000',
      lane: 'volume_breakout_1x',
      symbol: 'BTC-USDT',
      side: 'long',
      entryPrice: 100,
      blockReasons: ['break_quality_low', 'spread_unknown'],
      context: {
        contextGenerationAtOpen: 7,
        watermark: '2026-05-02T00:00:00.000Z',
        flashContextStatus: 'ok',
        featureSchemaVersion: 'paper_open_context.v3',
      },
      quality: { breakQuality: 0.22, spreadStatus: 'unknown' },
      cost: {
        roundTripCostBpsAtOpen: 28,
        routeCostBpsAtOpen: 28,
        markMatchStatusAtOpen: 'stale_or_missing',
      },
    })
  })

  it('rejects new shadow opens without complete v3 decision-time context', async () => {
    const path = await tempLedgerPath()

    const result = appendPaperPolicyShadowOpen(baseShadow({
      context: {
        contextGenerationAtOpen: 7,
        contextStatus: 'ok',
        flashConfidenceLowAtOpen: 0.42,
      },
    }), path)

    expect(result).toEqual({
      appended: false,
      shadowId: 'volume_breakout_1x:BTC-USDT:1700000000000',
      reason: 'invalid_v3_context',
      missingContextFields: expect.arrayContaining([
        'contextSnapshotId',
        'decisionTime',
        'featureSchemaVersion',
        'flashContextStatus',
        'marketDataWatermarkAtDecisionTime_or_watermark',
        'featuresAvailableAtDecisionTime',
        'featureSchemaVersion_v3',
      ]),
    })
    expect(readPaperPolicyShadowLedger(path)).toHaveLength(0)
  })

  it('dedupes shadowId for open records and closed outcomes', async () => {
    const path = await tempLedgerPath()

    expect(appendPaperPolicyShadowOpen(baseShadow(), path).appended).toBe(true)
    expect(appendPaperPolicyShadowOpen(baseShadow(), path)).toEqual({
      appended: false,
      shadowId: 'volume_breakout_1x:BTC-USDT:1700000000000',
      reason: 'duplicate_shadow_id',
    })

    const evaluation = evaluatePaperPolicyShadowLedger([{
      symbol: 'BTC-USDT',
      price: 102,
      barTime: 1_700_000_300_000,
      ts: '2026-05-02T00:05:00.000Z',
    }], path)
    const outcome = evaluation.dueOutcomes[0]
    expect(appendPaperPolicyShadowOutcome(outcome, path).appended).toBe(true)
    expect(appendPaperPolicyShadowOutcome(outcome, path)).toEqual({
      appended: false,
      shadowId: 'volume_breakout_1x:BTC-USDT:1700000000000',
      reason: 'duplicate_shadow_id',
    })
    expect(readPaperPolicyShadowLedger(path)).toHaveLength(2)
  })

  it('fails closed without appending when the ledger append lock is already held', async () => {
    const path = await tempLedgerPath()
    await mkdir(`${path}.append.lock`)

    expect(appendPaperPolicyShadowOpen(baseShadow(), path, {
      lockWaitMs: 0,
    })).toEqual({
      appended: false,
      shadowId: 'volume_breakout_1x:BTC-USDT:1700000000000',
      reason: 'ledger_locked',
    })
    expect(readPaperPolicyShadowLedger(path)).toHaveLength(0)
  })

  it('rejects closed outcomes that do not have a matching open shadow', async () => {
    const path = await tempLedgerPath()

    expect(appendPaperPolicyShadowOutcome({
      counterfactualType: 'trade_level_shadow',
      eventType: 'closed',
      shadowId: 'missing-open',
      lane: 'volume_breakout_1x',
      symbol: 'BTC-USDT',
      side: 'long',
      entryPrice: 100,
      closePrice: 102,
      openTs: '2026-05-02T00:00:00.000Z',
      openBarTime: 1_700_000_000_000,
      closeTs: '2026-05-02T00:05:00.000Z',
      closeBarTime: 1_700_000_300_000,
      horizonMs: 300_000,
      pnlPct: 2,
      pnlUsd: 20,
      closeReason: 'shadow_horizon_expired',
    }, path)).toEqual({
      appended: false,
      shadowId: 'missing-open',
      reason: 'missing_open_shadow_id',
    })
    expect(readPaperPolicyShadowLedger(path)).toHaveLength(0)
  })

  it('evaluates due shadows at horizon expiry with pnl outcome', async () => {
    const path = await tempLedgerPath()
    appendPaperPolicyShadowOpen(baseShadow(), path)

    const result = evaluatePaperPolicyShadowLedger([{
      symbol: 'BTC-USDT',
      price: 103,
      barTime: 1_700_000_300_000,
      ts: '2026-05-02T00:05:00.000Z',
    }], path)

    expect(result.notDueShadows).toHaveLength(0)
    expect(result.dueOutcomes).toHaveLength(1)
    expect(result.dueOutcomes[0]).toMatchObject({
      counterfactualType: 'trade_level_shadow',
      eventType: 'closed',
      shadowId: 'volume_breakout_1x:BTC-USDT:1700000000000',
      closePrice: 103,
      pnlPct: 3,
      pnlUsd: 30,
      closeReason: 'shadow_horizon_expired',
    })
  })

  it('evaluates stop-loss hit before horizon when stopLossPrice is present', async () => {
    const path = await tempLedgerPath()
    appendPaperPolicyShadowOpen(baseShadow(), path)

    const result = evaluatePaperPolicyShadowLedger([{
      symbol: 'BTC-USDT',
      price: 97.5,
      barTime: 1_700_000_060_000,
      ts: '2026-05-02T00:01:00.000Z',
    }], path)

    expect(result.notDueShadows).toHaveLength(0)
    expect(result.dueOutcomes[0]).toMatchObject({
      closeReason: 'shadow_stop_loss',
      closePrice: 97.5,
      pnlPct: -2.5,
      pnlUsd: -25,
    })
  })

  it('uses linear entry-relative returns for short shadow outcomes', async () => {
    const path = await tempLedgerPath()
    appendPaperPolicyShadowOpen(baseShadow({
      shadowId: 'volume_breakout_1x:ETH-USDT:1700000000000:short',
      symbol: 'ETH-USDT',
      side: 'short',
      entryPrice: 100,
      stopLossPrice: 104,
    }), path)

    const result = evaluatePaperPolicyShadowLedger([{
      symbol: 'ETH-USDT',
      price: 95,
      barTime: 1_700_000_300_000,
      ts: '2026-05-02T00:05:00.000Z',
    }], path)

    expect(result.dueOutcomes).toHaveLength(1)
    expect(result.dueOutcomes[0]).toMatchObject({
      side: 'short',
      closeReason: 'shadow_horizon_expired',
      closePrice: 95,
      pnlPct: 5,
      pnlUsd: 50,
    })
  })

  it('keeps shadows not due when horizon has not expired and stop is not hit', async () => {
    const path = await tempLedgerPath()
    appendPaperPolicyShadowOpen(baseShadow(), path)

    const result = evaluatePaperPolicyShadowLedger([{
      symbol: 'BTC-USDT',
      price: 101,
      barTime: 1_700_000_060_000,
      ts: '2026-05-02T00:01:00.000Z',
    }], path)

    expect(result.dueOutcomes).toHaveLength(0)
    expect(result.notDueShadows).toHaveLength(1)
    expect(result.notDueShadows[0]).toMatchObject({
      shadowId: 'volume_breakout_1x:BTC-USDT:1700000000000',
      counterfactualType: 'trade_level_shadow',
    })
  })
})
