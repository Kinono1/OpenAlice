import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  acquireMonitorLock,
  buildMonitorCommand,
  evaluateMonitorState,
  parseMonitorArgs,
  type MonitorCommandResult,
} from './run_realtime_shadow_monitor.js'

describe('run_realtime_shadow_monitor', () => {
  it('defaults to live-only monitoring and skips heavyweight research steps', () => {
    const args = parseMonitorArgs([])

    expect(args.paperDataMode).toBe('live_only')
    expect(args.skipOptimize).toBe(true)
    expect(args.skipValidation).toBe(true)
    expect(args.skipData).toBe(false)
    expect(args.skipPaper).toBe(true)
    expect(args.skipSecondLevel).toBe(false)
    expect(args.requirePromotionV2).toBe(true)
    expect(args.maxCycles).toBeNull()
    expect(args.lockPath).toBe('data/runtime/locks/realtime_shadow_monitor.lock')
  })

  it('builds a safe paper-shadow-loop command for each monitor cycle', () => {
    const args = parseMonitorArgs(['--once', 'true', '--shadowSummaryPath', 'tmp/summary.json'])
    const command = buildMonitorCommand(args)

    expect(command.command).toBe('corepack')
    expect(command.args).toEqual([
      'pnpm',
      'paper:shadow-loop',
      '--',
      '--paperDataMode',
      'live_only',
      '--skipData',
      'false',
      '--skipOptimize',
      'true',
      '--skipValidation',
      'true',
      '--skipPaper',
      'true',
      '--skipSecondLevel',
      'false',
      '--requirePromotionV2',
      'true',
      '--summaryPath',
      'tmp/summary.json',
      '--timeoutMs',
      String(args.timeoutMs),
    ])
  })

  it('uses a singleton runtime lock for monitor instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-monitor-lock-'))
    const lockPath = join(dir, 'monitor.lock')
    const first = acquireMonitorLock(lockPath)
    const second = acquireMonitorLock(lockPath)

    expect(first).not.toBeNull()
    expect(second).toBeNull()

    first?.release()
    const afterRelease = acquireMonitorLock(lockPath)
    expect(afterRelease).not.toBeNull()
    afterRelease?.release()
    await rm(dir, { recursive: true, force: true })
  })

  it('treats live-only insufficient bars as a blocked but non-error monitor state', () => {
    const state = evaluateMonitorState({
      generatedAt: '2026-04-29T00:00:00.000Z',
      cycle: 1,
      pid: 123,
      paperDataMode: 'live_only',
      command: commandResult('passed'),
      shadowSummary: {
        status: 'passed',
        safety: { activeAccountCount: 0, unsafeAccounts: [], warnings: [] },
      },
      paperDecision: {
        status: 'blocked',
        dataMode: 'live_only',
        requiredBars: 507,
        blockReasons: ['live_only_insufficient_bars:BTC-USDT:300<507'],
        proposedOrders: [],
        executedTrades: [],
        promotionReadiness: {
          ready: false,
          reasons: ['insufficient_live_accumulated_history:300<507'],
          liveOnlyBarsAvailable: 300,
          netEdgePct: 0.108,
        },
      },
      statusPath: '/tmp/status.json',
      eventsPath: '/tmp/events.jsonl',
      shadowSummaryPath: '/tmp/shadow.json',
      paperDecisionPath: '/tmp/decision.json',
    })

    expect(state.status).toBe('blocked')
    expect(state.alerts).toEqual([])
    expect(state.decision.liveOnlyBarsAvailable).toBe(300)
  })

  it('raises alerts for paper activity and promotion readiness', () => {
    const state = evaluateMonitorState({
      generatedAt: '2026-04-29T00:00:00.000Z',
      cycle: 1,
      pid: 123,
      paperDataMode: 'live_only',
      command: commandResult('passed'),
      shadowSummary: {
        status: 'passed',
        safety: { activeAccountCount: 0, unsafeAccounts: [], warnings: [] },
      },
      paperDecision: {
        status: 'traded',
        dataMode: 'live_only',
        requiredBars: 507,
        blockReasons: [],
        proposedOrders: [{ symbol: 'BTC-USDT' }],
        executedTrades: [{ id: 'open_BTC-USDT_1' }],
        promotionReadiness: {
          ready: true,
          reasons: [],
          liveOnlyBarsAvailable: 600,
          netEdgePct: 0.5,
        },
      },
      statusPath: '/tmp/status.json',
      eventsPath: '/tmp/events.jsonl',
      shadowSummaryPath: '/tmp/shadow.json',
      paperDecisionPath: '/tmp/decision.json',
    })

    expect(state.status).toBe('alert')
    expect(state.alerts.map((alert) => alert.code)).toEqual([
      'paper_orders_proposed',
      'paper_trades_executed',
      'promotion_ready_review_required',
    ])
  })

  it('surfaces promotion v2 verdicts from the latest strategy promotion artifact', () => {
    const state = evaluateMonitorState({
      generatedAt: '2026-04-29T00:00:00.000Z',
      cycle: 1,
      pid: 123,
      paperDataMode: 'live_only',
      command: commandResult('passed'),
      shadowSummary: {
        status: 'passed',
        safety: { activeAccountCount: 0, unsafeAccounts: [], warnings: [] },
      },
      paperDecision: {
        status: 'no_signal',
        dataMode: 'live_only',
        blockReasons: [],
        proposedOrders: [],
        executedTrades: [],
        promotionReadiness: {
          ready: false,
          reasons: [],
        },
      },
      promotionReadinessV2: {
        finalVerdict: 'tiny_cap_candidate',
        humanReadableReason: 'all promotion gates passed',
      },
      statusPath: '/tmp/status.json',
      eventsPath: '/tmp/events.jsonl',
      shadowSummaryPath: '/tmp/shadow.json',
      paperDecisionPath: '/tmp/decision.json',
      promotionReadinessV2Path: '/tmp/strategy_promotion.latest.json',
    })

    expect(state.status).toBe('alert')
    expect(state.decision.promotionV2).toMatchObject({
      finalVerdict: 'tiny_cap_candidate',
      humanReadableReason: 'all promotion gates passed',
    })
    expect(state.alerts.map((alert) => alert.code)).toContain('promotion_v2_tiny_cap_review_required')
    expect(state.paths.promotionReadinessV2Path).toBe('/tmp/strategy_promotion.latest.json')
  })

  it('summarizes multi-account profiles and ignores stress-only diagnostics for trade alerts', () => {
    const state = evaluateMonitorState({
      generatedAt: '2026-04-30T00:00:00.000Z',
      cycle: 1,
      pid: 123,
      paperDataMode: 'live_only',
      command: commandResult('passed'),
      shadowSummary: {
        status: 'passed',
        safety: { activeAccountCount: 0, unsafeAccounts: [], warnings: [] },
      },
      paperDecision: {
        status: 'no_signal',
        dataMode: 'live_only',
        requiredBars: 300,
        blockReasons: [],
        proposedOrders: [],
        executedTrades: [],
        multiAccount: {
          enabled: true,
          profiles: [
            {
              id: 'spot_1x',
              label: 'Spot 1x baseline',
              mode: 'paper_trade',
              cadence: 'minute',
              timeframe: '5m',
              strategyLane: 'volume_breakout',
              minDecisionIntervalMs: 300000,
              leverage: 1,
              status: 'no_signal',
              proposedOrders: [],
              executedTrades: [],
              accountSnapshot: { equity: 100000, openPositions: 0 },
              risk: { liquidationMovePctApprox: 100, estimatedRoundTripCostPctOfMargin: 0.28 },
            },
            {
              id: 'liquidation_probe_100x',
              label: 'Liquidation probe 100x',
              mode: 'stress_only',
              cadence: 'second',
              timeframe: '1s',
              strategyLane: 'microstructure_stress',
              minDecisionIntervalMs: 1000,
              leverage: 100,
              status: 'stress_only',
              proposedOrders: [{ symbol: 'BTC-USDT' }],
              executedTrades: [{ id: 'diagnostic-only' }],
              accountSnapshot: null,
              risk: { liquidationMovePctApprox: 1, estimatedRoundTripCostPctOfMargin: 28 },
            },
          ],
        },
        promotionReadiness: {
          ready: false,
          reasons: [],
          liveOnlyBarsAvailable: 300,
          netEdgePct: 0.108,
        },
      },
      statusPath: '/tmp/status.json',
      eventsPath: '/tmp/events.jsonl',
      shadowSummaryPath: '/tmp/shadow.json',
      paperDecisionPath: '/tmp/decision.json',
    })

    expect(state.status).toBe('ok')
    expect(state.alerts).toEqual([])
    expect(state.decision.proposedOrders).toBe(0)
    expect(state.decision.executedTrades).toBe(0)
    expect(state.decision.multiAccount.enabled).toBe(true)
    expect(state.decision.multiAccount.profiles).toEqual([
      expect.objectContaining({
        id: 'spot_1x',
        mode: 'paper_trade',
        cadence: 'minute',
        timeframe: '5m',
        strategyLane: 'volume_breakout',
        minDecisionIntervalMs: 300000,
        leverage: 1,
        proposedOrders: 0,
        executedTrades: 0,
        equity: 100000,
      }),
      expect.objectContaining({
        id: 'liquidation_probe_100x',
        mode: 'stress_only',
        cadence: 'second',
        timeframe: '1s',
        strategyLane: 'microstructure_stress',
        minDecisionIntervalMs: 1000,
        leverage: 100,
        proposedOrders: 1,
        executedTrades: 1,
        equity: null,
        liquidationMovePctApprox: 1,
      }),
    ])
  })

  it('raises paper trade alerts when any paper-trade virtual profile executes', () => {
    const state = evaluateMonitorState({
      generatedAt: '2026-04-30T00:00:00.000Z',
      cycle: 1,
      pid: 123,
      paperDataMode: 'live_only',
      command: commandResult('passed'),
      shadowSummary: {
        status: 'passed',
        safety: { activeAccountCount: 0, unsafeAccounts: [], warnings: [] },
      },
      paperDecision: {
        status: 'traded',
        dataMode: 'live_only',
        requiredBars: 300,
        blockReasons: [],
        proposedOrders: [],
        executedTrades: [],
        multiAccount: {
          enabled: true,
          profiles: [
            {
              id: 'spot_1x',
              mode: 'paper_trade',
              cadence: 'minute',
              timeframe: '5m',
              strategyLane: 'volume_breakout',
              minDecisionIntervalMs: 300000,
              leverage: 1,
              status: 'no_signal',
              proposedOrders: [],
              executedTrades: [],
              accountSnapshot: { equity: 100000, openPositions: 0 },
              risk: { liquidationMovePctApprox: 100, estimatedRoundTripCostPctOfMargin: 0.28 },
            },
            {
              id: 'stress_10x',
              mode: 'paper_trade',
              cadence: 'second',
              timeframe: '1s',
              strategyLane: 'microstructure_stress',
              minDecisionIntervalMs: 1000,
              leverage: 10,
              status: 'traded',
              proposedOrders: [{ symbol: 'BTC-USDT' }],
              executedTrades: [{ id: 'open_stress_10x_BTC-USDT_1' }],
              accountSnapshot: { equity: 100000, openPositions: 1 },
              risk: { liquidationMovePctApprox: 10, estimatedRoundTripCostPctOfMargin: 2.8 },
            },
            {
              id: 'liquidation_probe_100x',
              mode: 'stress_only',
              cadence: 'second',
              timeframe: '1s',
              strategyLane: 'microstructure_stress',
              minDecisionIntervalMs: 1000,
              leverage: 100,
              status: 'stress_only',
              proposedOrders: [{ symbol: 'ETH-USDT' }],
              executedTrades: [],
              accountSnapshot: null,
              risk: { liquidationMovePctApprox: 1, estimatedRoundTripCostPctOfMargin: 28 },
            },
          ],
        },
        promotionReadiness: {
          ready: false,
          reasons: [],
          liveOnlyBarsAvailable: 300,
          netEdgePct: 0.108,
        },
      },
      statusPath: '/tmp/status.json',
      eventsPath: '/tmp/events.jsonl',
      shadowSummaryPath: '/tmp/shadow.json',
      paperDecisionPath: '/tmp/decision.json',
    })

    expect(state.status).toBe('alert')
    expect(state.decision.proposedOrders).toBe(1)
    expect(state.decision.executedTrades).toBe(1)
    expect(state.alerts.map((alert) => alert.code)).toEqual([
      'paper_orders_proposed',
      'paper_trades_executed',
    ])
  })

  it('includes second-level microstructure paper trades in monitor aggregation', () => {
    const state = evaluateMonitorState({
      generatedAt: '2026-04-30T00:00:00.000Z',
      cycle: 1,
      pid: 123,
      paperDataMode: 'live_only',
      command: commandResult('passed'),
      shadowSummary: {
        status: 'passed',
        safety: { activeAccountCount: 0, unsafeAccounts: [], warnings: [] },
      },
      paperDecision: {
        status: 'no_signal',
        dataMode: 'live_only',
        requiredBars: 300,
        blockReasons: [],
        proposedOrders: [],
        executedTrades: [],
        promotionReadiness: {
          ready: false,
          reasons: [],
          liveOnlyBarsAvailable: 300,
          netEdgePct: 0.108,
        },
      },
      microstructureDecision: {
        status: 'traded',
        profiles: [
          {
            id: 'liquidation_probe_100x',
            label: 'Liquidation probe 100x',
            mode: 'paper_trade',
            cadence: 'second',
            timeframe: '1s',
            strategyLane: 'microstructure_stress',
            minDecisionIntervalMs: 1000,
            leverage: 100,
            equity: 99990,
            openPositions: 1,
            proposedOrders: [{ symbol: 'BTC-USDT' }],
            executedTrades: [{ id: 'open_liquidation_probe_100x_BTC-USDT_1' }],
            risk: { liquidationMovePctApprox: 1 },
          },
        ],
      },
      statusPath: '/tmp/status.json',
      eventsPath: '/tmp/events.jsonl',
      shadowSummaryPath: '/tmp/shadow.json',
      paperDecisionPath: '/tmp/decision.json',
      microstructureDecisionPath: '/tmp/micro.json',
    })

    expect(state.status).toBe('alert')
    expect(state.decision.proposedOrders).toBe(1)
    expect(state.decision.executedTrades).toBe(1)
    expect(state.decision.secondLevel.enabled).toBe(true)
    expect(state.decision.secondLevel.profiles[0]).toMatchObject({
      id: 'liquidation_probe_100x',
      mode: 'paper_trade',
      cadence: 'second',
      timeframe: '1s',
      leverage: 100,
      equity: 99990,
      openPositions: 1,
    })
  })

  it('ignores stale microstructure artifacts when the current strict command skips that lane', () => {
    const state = evaluateMonitorState({
      generatedAt: '2026-04-30T00:00:00.000Z',
      cycle: 1,
      pid: 123,
      paperDataMode: 'live_only',
      command: {
        ...commandResult('passed'),
        args: [
          'pnpm',
          'paper:shadow-loop',
          '--',
          '--skipSecondLevel',
          'true',
          '--requirePromotionV2',
          'true',
        ],
      },
      shadowSummary: {
        status: 'passed',
        safety: { activeAccountCount: 0, unsafeAccounts: [], warnings: [] },
      },
      paperDecision: {
        status: 'blocked',
        dataMode: 'live_only',
        requiredBars: 300,
        blockReasons: [],
        proposedOrders: [],
        executedTrades: [],
        promotionReadiness: {
          ready: false,
          reasons: [],
          liveOnlyBarsAvailable: 300,
          netEdgePct: 0.108,
        },
      },
      microstructureDecision: {
        status: 'traded',
        profiles: [
          {
            id: 'stress_10x',
            mode: 'paper_trade',
            proposedOrders: [{ symbol: 'BTC-USDT' }],
            executedTrades: [{ id: 'stale-trade' }],
          },
        ],
      },
      statusPath: '/tmp/status.json',
      eventsPath: '/tmp/events.jsonl',
      shadowSummaryPath: '/tmp/shadow.json',
      paperDecisionPath: '/tmp/decision.json',
      microstructureDecisionPath: '/tmp/micro.json',
    })

    expect(state.status).toBe('blocked')
    expect(state.decision.proposedOrders).toBe(0)
    expect(state.decision.executedTrades).toBe(0)
    expect(state.decision.secondLevel.enabled).toBe(false)
    expect(state.alerts.map((alert) => alert.code)).not.toContain('paper_trades_executed')
  })

  it('raises a critical error when the shadow loop command fails', () => {
    const state = evaluateMonitorState({
      generatedAt: '2026-04-29T00:00:00.000Z',
      cycle: 1,
      pid: 123,
      paperDataMode: 'live_only',
      command: commandResult('failed', 'timeout'),
      shadowSummary: null,
      paperDecision: null,
      statusPath: '/tmp/status.json',
      eventsPath: '/tmp/events.jsonl',
      shadowSummaryPath: '/tmp/shadow.json',
      paperDecisionPath: '/tmp/decision.json',
    })

    expect(state.status).toBe('error')
    expect(state.alerts[0]).toMatchObject({
      severity: 'critical',
      code: 'shadow_loop_failed',
    })
  })
})

function commandResult(status: MonitorCommandResult['status'], error?: string): MonitorCommandResult {
  return {
    command: 'corepack',
    args: ['pnpm', 'paper:shadow-loop'],
    status,
    durationMs: 1,
    stdoutTail: '',
    stderrTail: '',
    error,
  }
}
