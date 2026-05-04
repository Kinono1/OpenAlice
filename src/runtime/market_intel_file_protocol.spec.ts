import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { acquireRuntimeLock } from './runtime_lock'
import { writeJsonAtomicWithGeneration } from './atomic_write'
import { createBootstrapMarketIntelContext, readMarketIntelContext } from './market_intel_context'
import { createInflightCall, isInflightCallCurrent } from './inflight_call'
import { appendPaperTradeResult } from './paper_trade_result'
import { calculateAssociatedAvgPnlPct } from './recommendation_audit'
import {
  createEmptyProRiskPolicy,
  isProRiskPolicyActive,
  nextProRiskPolicy,
  readProRiskPolicy,
  writeProRiskPolicy,
} from './pro_risk_policy'

describe('market intel file protocol', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'openalice-market-intel-'))
    roots.push(root)
    return root
  }

  it('cleans a stale mkdir lock and reacquires it', () => {
    const root = tempRoot()
    const lockDir = join(root, 'state.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'info.json'), JSON.stringify({
      pid: 99999999,
      ts: Date.now() - 60_000,
      hostname: 'test',
      purpose: 'stale_test',
    }))

    const lock = acquireRuntimeLock(lockDir, {
      staleMs: 5,
      purpose: 'reacquire_test',
      eventLogPath: join(root, 'events.jsonl'),
    })

    expect(lock).not.toBeNull()
    lock?.release()
  })

  it('does not treat an old lock as stale while the owner process is alive', () => {
    const root = tempRoot()
    const lockDir = join(root, 'state.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'info.json'), JSON.stringify({
      pid: process.pid,
      ts: Date.now() - 60_000,
      hostname: 'test',
      purpose: 'active_old_lock',
    }))

    const lock = acquireRuntimeLock(lockDir, {
      staleMs: 5,
      purpose: 'should_not_reacquire',
      eventLogPath: join(root, 'events.jsonl'),
    })

    expect(lock).toBeNull()
    const info = JSON.parse(readFileSync(join(lockDir, 'info.json'), 'utf-8')) as { purpose: string }
    expect(info.purpose).toBe('active_old_lock')
  })

  it('enforces generation checks for atomic JSON writes', () => {
    const root = tempRoot()
    const latestPath = join(root, 'context.latest.json')

    const first = writeJsonAtomicWithGeneration({
      latestPath,
      value: { contextGeneration: 1, value: 'first' },
    })
    expect(first.written).toBe(true)

    const stale = writeJsonAtomicWithGeneration({
      latestPath,
      value: { contextGeneration: 2, value: 'stale' },
      expectedGeneration: 0,
    })
    expect(stale.written).toBe(false)
    expect(stale.reason).toBe('generation_mismatch')

    const parsed = JSON.parse(readFileSync(latestPath, 'utf-8')) as { value: string }
    expect(parsed.value).toBe('first')
  })

  it('creates a conservative bootstrap context when latest is missing', () => {
    const root = tempRoot()
    const context = readMarketIntelContext(join(root, 'missing.latest.json'))

    expect(context.contextGeneration).toBe(0)
    expect(context.riskMode).toBe('risk_off')
    expect(context.coldStartRoundsRemaining).toBeGreaterThan(0)
  })

  it('normalizes market-intel lane maps and drops generic model lanes', () => {
    const root = tempRoot()
    const path = join(root, 'context.latest.json')
    const bootstrap = createBootstrapMarketIntelContext()
    writeFileSync(path, JSON.stringify({
      ...bootstrap,
      contextGeneration: 5,
      riskMode: 'risk_on',
      allowNewPositionsByLane: {
        spot: true,
        perpetual: true,
        microstructure_10x: true,
      },
      exposureMultiplierByLane: {
        spot: 1,
        microstructure_10x: 0.4,
      },
      flashConfidenceByLane: {
        spot: { confidence: 0.9, confidenceLow: 0.8, confidenceHigh: 0.95 },
        microstructure_10x: { confidence: 0.8, confidenceLow: 0.7, confidenceHigh: 0.9 },
      },
    }))

    const context = readMarketIntelContext(path)
    expect(Object.prototype.hasOwnProperty.call(context.allowNewPositionsByLane, 'spot')).toBe(false)
    expect(context.allowNewPositionsByLane.microstructure_10x).toBe(true)
    expect(context.allowNewPositionsByLane.microstructure_100x).toBe(false)
    expect(context.exposureMultiplierByLane.microstructure_10x).toBe(0.4)
    expect(Object.prototype.hasOwnProperty.call(context.flashConfidenceByLane, 'spot')).toBe(false)
  })

  it('detects superseded inflight calls by callId', () => {
    const root = tempRoot()
    const path = join(root, 'inflight_call.json')
    const first = createInflightCall({ trigger: 'ttl', priority: 'low', path })
    expect(isInflightCallCurrent(first.callId, path)).toBe(true)

    createInflightCall({ trigger: 'event', priority: 'high', path, supersedesCallId: first.callId })
    expect(isInflightCallCurrent(first.callId, path)).toBe(false)
  })

  it('calculates associated average PnL from paper trade results by proEpoch', () => {
    const root = tempRoot()
    const path = join(root, 'paper_trade_result.jsonl')
    appendPaperTradeResult({
      tradeId: 't1',
      lane: 'microstructure_10x',
      symbol: 'BTC-USDT',
      leverage: 10,
      side: 'long',
      openTs: '2026-01-01T00:00:00.000Z',
      closeTs: '2026-01-01T00:01:00.000Z',
      openPrice: 100,
      closePrice: 101,
      pnlPct: 1,
      pnlUsd: 10,
      closeReason: 'take_profit',
      priceSource: '1s',
      priceStale: false,
      contextGenerationAtOpen: 1,
      flashConfidenceLowAtOpen: 0.8,
      ruleScoreAtOpen: 0.7,
      proEpochAtOpen: 42,
      marketIntelTriggerAtOpen: 'event',
    }, path)
    appendPaperTradeResult({
      tradeId: 't2',
      lane: 'microstructure_10x',
      symbol: 'ETH-USDT',
      leverage: 10,
      side: 'short',
      openTs: '2026-01-01T00:00:00.000Z',
      closeTs: '2026-01-01T00:01:00.000Z',
      openPrice: 100,
      closePrice: 99.5,
      pnlPct: 0.5,
      pnlUsd: 5,
      closeReason: 'take_profit',
      priceSource: '1s',
      priceStale: false,
      contextGenerationAtOpen: 1,
      flashConfidenceLowAtOpen: 0.8,
      ruleScoreAtOpen: 0.7,
      proEpochAtOpen: 42,
      marketIntelTriggerAtOpen: 'event',
    }, path)

    expect(calculateAssociatedAvgPnlPct(42, path)).toBe(0.75)
  })

  it('writes and expires Pro risk policy with generation checks', () => {
    const root = tempRoot()
    const path = join(root, 'pro_risk_policy.latest.json')
    const base = createEmptyProRiskPolicy(new Date('2026-01-01T00:00:00.000Z'))
    const policy = nextProRiskPolicy(base, {
      proEpoch: 1000,
      generatedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      verdict: 'reject_candidate',
      confidenceScore: 0.8,
      pauseLaneRecommendations: { microstructure_100x: true },
      symbolBlocks: ['APT-USDT'],
      suggestedRuleThresholdByLane: { microstructure_100x: 0.75 },
      riskReductionActions: ['pause bad lane'],
      autoApplyPolicy: 'risk_reduction_only',
      source: { reportPath: 'data/research/improvement_report.latest.json', model: 'deepseek-v4-pro' },
    })

    expect(writeProRiskPolicy(policy, { path, expectedGeneration: 0 })).toBe(true)
    const loaded = readProRiskPolicy(path)
    expect(loaded.generation).toBe(1)
    expect(loaded.pauseLaneRecommendations.microstructure_100x).toBe(true)
    expect(loaded.symbolBlocks).toEqual(['APT-USDT'])
    expect(isProRiskPolicyActive(loaded)).toBe(true)

    const stale = nextProRiskPolicy(loaded, {
      validUntil: new Date(Date.now() - 1_000).toISOString(),
    })
    expect(isProRiskPolicyActive(stale)).toBe(false)
  })
})
