import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildPortfolioTargetFromWeights } from '../src/portfolio/target.js'
import { buildRuntimeStatusSnapshotPaths } from '../src/runtime/runtime_status_snapshot.js'
import {
  buildEthCarryActionabilityNotification,
  buildEthCarryTransitionAlert,
  classifyEthCarryActionability,
  parseArgs,
  renderEthCarryOperatorSummary,
  refreshEthCarryRuntimeStatus,
} from './refresh_eth_carry_runtime_status.ts'

function makePortfolioTarget(input: {
  basisEquityUsd: number
  generatedAt: string
  weights: Record<string, number>
  notes?: string[]
}) {
  return buildPortfolioTargetFromWeights({
    basisEquityUsd: input.basisEquityUsd,
    generatedAt: input.generatedAt,
    maxTurnoverPct: 1,
    weights: input.weights,
    notes: input.notes ?? [],
  })
}

function makeNewsRecord(input: {
  pubTime: string
  title: string
  content: string
  source?: string
  seq?: number
}) {
  return {
    seq: input.seq ?? 1,
    ts: Date.parse(input.pubTime),
    pubTs: Date.parse(input.pubTime),
    dedupKey: `guid:${input.seq ?? 1}`,
    title: input.title,
    content: input.content,
    metadata: {
      source: input.source ?? 'Reuters',
      category: 'crypto-news',
    },
  }
}

describe('refresh_eth_carry_runtime_status', () => {
  it('defaults CLI execution to dry-run without runtime status writes', () => {
    const args = parseArgs([])

    expect(args.dryRun).toBe(true)
  })

  it('requires explicit opt-in before refreshing runtime status artifacts', () => {
    const args = parseArgs(['--dryRun', 'false'])

    expect(args.dryRun).toBe(false)
  })

  it('keeps the canonical target untouched while writing separate base, news-adjusted, and final artifacts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-15T03:18:40.606Z'))

    try {
      const dir = await mkdtemp(join(tmpdir(), 'eth-carry-runtime-status-'))
      const canonicalRuntimeDir = join(dir, 'canonical-runtime')
      const bundleRuntimeDir = join(dir, 'bundle-runtime')
      const researchDir = join(dir, 'research/strategy')
      const statusDir = join(dir, 'status')
      const controlArtifactDir = join(dir, 'control')
      const shadowArtifactDir = join(dir, 'shadow')
      const newsLogPath = join(dir, 'news/news.jsonl')
      const ethFundingPath = join(dir, 'eth_funding.json')
      const btcFundingPath = join(dir, 'btc_funding.json')
      const canonicalTargetPath = join(canonicalRuntimeDir, 'paper_portfolio_target.json')
      const workingTargetPath = join(bundleRuntimeDir, 'paper_portfolio_target.json')
      const validationRunsPath = join(researchDir, 'strategy_validation_runs.json')
      const verdictPath = join(researchDir, 'experiment_verdict.v2.json')
      const releaseGateStatusPath = join(bundleRuntimeDir, 'release_gate_status.json')
      const registryPath = join(bundleRuntimeDir, 'paper_champion_registry.json')
      const controlSummaryPath = join(controlArtifactDir, 'eth_carry_summary.json')
      const shadowSummaryPath = join(shadowArtifactDir, 'eth_carry_short_bias_summary.json')
      const shadowComparisonPath = join(statusDir, 'eth_carry_shadow_comparison.json')
      const baseTargetPath = join(statusDir, 'eth_carry_base_paper_portfolio_target.json')
      const newsOverlayPath = join(statusDir, 'eth_carry_news_overlay.json')
      const adjustedTargetPath = join(statusDir, 'eth_carry_news_adjusted_paper_portfolio_target.json')
      const finalTargetPath = join(statusDir, 'eth_carry_final_paper_portfolio_target.json')
      const freezePath = join(statusDir, 'eth_carry_event_freeze.json')
      const summaryPath = join(statusDir, 'eth_carry_runtime_status.json')
      const transitionPath = join(statusDir, 'eth_carry_transition_alert.json')
      const notificationPath = join(statusDir, 'eth_carry_actionability_notification.json')
      const operatorPath = join(statusDir, 'eth_carry_operator_summary.txt')

      await mkdir(canonicalRuntimeDir, { recursive: true })
      await mkdir(bundleRuntimeDir, { recursive: true })
      await mkdir(researchDir, { recursive: true })
      await mkdir(statusDir, { recursive: true })
      await mkdir(controlArtifactDir, { recursive: true })
      await mkdir(shadowArtifactDir, { recursive: true })
      await mkdir(join(dir, 'news'), { recursive: true })

      const canonicalTarget = makePortfolioTarget({
        basisEquityUsd: 10_000,
        generatedAt: '2026-04-15T01:00:00.000Z',
        weights: {
          'BTC/USDT:USDT': 0.35,
          'ETH/USDT:USDT': 0.25,
        },
        notes: ['canonical=true', 'news_overlay_applied=false'],
      })
      const workingTarget = makePortfolioTarget({
        basisEquityUsd: 10_000,
        generatedAt: '2026-04-15T01:00:00.000Z',
        weights: {
          'BTC/USDT:USDT': 0,
          'ETH/USDT:USDT': 0,
        },
        notes: ['working_target=true'],
      })
      const canonicalTargetBefore = `${JSON.stringify(canonicalTarget, null, 2)}\n`
      await writeFile(canonicalTargetPath, canonicalTargetBefore, 'utf-8')
      await writeFile(workingTargetPath, `${JSON.stringify(workingTarget, null, 2)}\n`, 'utf-8')

      await writeFile(
        validationRunsPath,
        `${JSON.stringify({
          schemaVersion: 'strategy_validation_runs.v1',
          generatedAt: '2026-04-15T01:00:00.000Z',
          championSet: [
            {
              symbol: 'ETH/USDT:USDT',
              strategyId: 'ETH_CARRY_SHORT_BIAS_V1',
            },
            {
              symbol: 'BTC/USDT:USDT',
              strategyId: 'ETH_CARRY_SHORT_BIAS_V1',
            },
          ],
          candidates: [
            {
              strategyId: 'ETH_CARRY_SHORT_BIAS_V1',
              strategy: 'carry',
              strategyName: 'ETH Carry Short Bias',
              sourceEligibility: {
                sourceValidity: {
                  runtimeMode: 'real_runtime',
                  sourceLineage: 'openalice_native',
                  evidenceStrength: 'live_or_internal',
                  fallbackReason: null,
                  blockers: [],
                },
                donorNative: false,
                promotionEligible: true,
                admissionIntent: 'promotion',
                eligibilityBlockers: [],
              },
            },
          ],
        }, null, 2)}\n`,
        'utf-8',
      )
      await writeFile(
        verdictPath,
        `${JSON.stringify({
          schemaVersion: 'experiment_verdict.v2',
          generatedAt: '2026-04-15T01:00:00.000Z',
          result: 'GO',
          reasonCodes: [],
          thresholds: {
            meanPboMax: 0.2,
            meanDsrProbabilityMin: 0.5,
            fdrQMax: 0.2,
          },
          aggregateMetrics: {
            meanPbo: 0.1,
            meanDsrProbability: 0.93,
            fdrQ: 0,
          },
        }, null, 2)}\n`,
        'utf-8',
      )
      await writeFile(
        releaseGateStatusPath,
        `${JSON.stringify({
          version: 1,
          generatedAt: '2026-04-15T01:00:00.000Z',
          allowPaperTrading: true,
          allowLiveTrading: true,
          failedChecks: [],
          warningChecks: [],
        }, null, 2)}\n`,
        'utf-8',
      )
      await writeFile(
        registryPath,
        `${JSON.stringify({
          version: 1,
          generatedAt: '2026-04-15T01:00:00.000Z',
          entries: [
            {
              strategyId: 'ETH_CARRY_SHORT_BIAS_V1',
              strategyFamily: 'carry',
              strategyName: 'ETH Carry Short Bias',
              symbols: ['ETH/USDT:USDT', 'BTC/USDT:USDT'],
            },
          ],
        }, null, 2)}\n`,
        'utf-8',
      )
      await writeFile(
        controlSummaryPath,
        `${JSON.stringify({
          selectedParams: { id: 'carry_24h_z13' },
          selectedMetrics: {
            tradeCount: 369,
            netExpectancyPct: 0.0005,
          },
          trades: [
            { netReturnPct: 0.02, exitTime: Date.now() - 90 * 24 * 60 * 60 * 1000 },
            { netReturnPct: -0.03, exitTime: Date.now() - 10 * 24 * 60 * 60 * 1000 },
            { netReturnPct: 0.01, exitTime: Date.now() - 1 * 24 * 60 * 60 * 1000 },
          ],
          releaseGate: {
            allowPaperTrading: true,
          },
          significance: {
            passed: false,
            pboResult: { pbo: 0.12 },
          },
        }, null, 2)}\n`,
        'utf-8',
      )
      await writeFile(
        shadowSummaryPath,
        `${JSON.stringify({
          selectedParams: { id: 'carry_short_bias_soft' },
          selectedMetrics: {
            tradeCount: 420,
            netExpectancyPct: 0.018,
          },
          trades: [
            { netReturnPct: 0.05, exitTime: Date.now() - 90 * 24 * 60 * 60 * 1000 },
            { netReturnPct: 0.03, exitTime: Date.now() - 10 * 24 * 60 * 60 * 1000 },
            { netReturnPct: 0.02, exitTime: Date.now() - 1 * 24 * 60 * 60 * 1000 },
          ],
          releaseGate: {
            allowPaperTrading: true,
          },
          significance: {
            passed: true,
            pboResult: { pbo: 0.04 },
          },
          topCandidates: [
            {
              recent90dTradeCount: 12,
              errorRate: 0.18,
              recent90dErrorRate: 0.14,
              netExpectancyPct: 0.018,
              tradeCount: 420,
              pbo: 0.04,
              dsrValue: 0.91,
              wfoPassed: true,
              failedWindows: 0,
              paper: true,
            },
          ],
        }, null, 2)}\n`,
        'utf-8',
      )
      await writeFile(
        shadowComparisonPath,
        `${JSON.stringify({
          generatedAt: '2026-04-15T01:00:00.000Z',
          controlCandidateId: 'carry_24h_z13',
          shadowChampionId: 'carry_short_bias_soft',
          promotionDecision: 'promote_shadow',
          reasonCodes: [],
          control: {
            tradeCount: 369,
            recent90dTradeCount: 9,
            errorRate: 0.39,
            recent90dErrorRate: 0.41,
            netExpectancyPct: 0.0005,
            pbo: 0.12,
            paper: true,
          },
          shadow: {
            tradeCount: 420,
            recent90dTradeCount: 12,
            errorRate: 0.18,
            recent90dErrorRate: 0.14,
            netExpectancyPct: 0.018,
            sharpe: 1.7,
            pbo: 0.04,
            dsrValue: 0.91,
            wfoPassed: true,
            failedWindows: 0,
            paper: true,
          },
          paths: {
            controlSummaryPath,
            shadowSummaryPath,
          },
        }, null, 2)}\n`,
        'utf-8',
      )
      await writeFile(
        newsLogPath,
        `${JSON.stringify(
          makeNewsRecord({
            pubTime: '2026-04-15T02:30:00.000Z',
            title: 'Binance hacked in exploit, withdrawals halted',
            content: 'A security breach and exploit triggered a withdrawal halt on Binance.',
            source: 'Reuters',
          }),
        )}\n`,
        'utf-8',
      )
      await writeFile(
        join(dir, 'ETH_USDT_USDT_1h.csv'),
        'timestamp,open,high,low,close,volume\n1710000000,1800,1810,1790,1805,100\n1710003600,1805,1815,1800,1810,120\n',
        'utf-8',
      )
      await writeFile(
        join(dir, 'BTC_USDT_USDT_1h.csv'),
        'timestamp,open,high,low,close,volume\n1710000000,60000,60100,59900,60050,200\n1710003600,60050,60200,60000,60100,220\n',
        'utf-8',
      )
      await writeFile(
        ethFundingPath,
        `${JSON.stringify([
          { symbol: 'ETH/USDT:USDT', fundingRate: -0.00001, timestamp: 1744689600000 },
          { symbol: 'ETH/USDT:USDT', fundingRate: -0.000011, timestamp: 1744718400000 },
          { symbol: 'ETH/USDT:USDT', fundingRate: -0.000012, timestamp: 1744747200000 },
          { symbol: 'ETH/USDT:USDT', fundingRate: -0.000013, timestamp: 1744776000000 },
          { symbol: 'ETH/USDT:USDT', fundingRate: -0.000014, timestamp: 1744804800000 },
          { symbol: 'ETH/USDT:USDT', fundingRate: -0.000015, timestamp: 1744833600000 },
          { symbol: 'ETH/USDT:USDT', fundingRate: -0.000016, timestamp: 1744862400000 },
          { symbol: 'ETH/USDT:USDT', fundingRate: -0.000017, timestamp: 1744891200000 },
          { symbol: 'ETH/USDT:USDT', fundingRate: -0.000018, timestamp: 1744920000000 },
        ], null, 2)}\n`,
        'utf-8',
      )
      await writeFile(
        btcFundingPath,
        `${JSON.stringify([
          { symbol: 'BTC/USDT:USDT', fundingRate: 0.00003, timestamp: 1744689600000 },
          { symbol: 'BTC/USDT:USDT', fundingRate: 0.000031, timestamp: 1744718400000 },
          { symbol: 'BTC/USDT:USDT', fundingRate: 0.000032, timestamp: 1744747200000 },
          { symbol: 'BTC/USDT:USDT', fundingRate: 0.000033, timestamp: 1744776000000 },
          { symbol: 'BTC/USDT:USDT', fundingRate: 0.000034, timestamp: 1744804800000 },
          { symbol: 'BTC/USDT:USDT', fundingRate: 0.000035, timestamp: 1744833600000 },
          { symbol: 'BTC/USDT:USDT', fundingRate: 0.000036, timestamp: 1744862400000 },
          { symbol: 'BTC/USDT:USDT', fundingRate: 0.000037, timestamp: 1744891200000 },
          { symbol: 'BTC/USDT:USDT', fundingRate: 0.000038, timestamp: 1744920000000 },
        ], null, 2)}\n`,
        'utf-8',
      )

      const runtimeSnapshotDir = join(dir, 'runtime-snapshots')
      const runtimeSnapshotPaths = buildRuntimeStatusSnapshotPaths(runtimeSnapshotDir)

      const result = await refreshEthCarryRuntimeStatus({
        validationRunsPath,
        verdictPath,
        releaseGateStatusPath,
        registryPath,
        portfolioTargetPath: workingTargetPath,
        snapshotBaseDir: statusDir,
        runtimeSnapshotBaseDir: runtimeSnapshotDir,
        ethCsv: join(dir, 'ETH_USDT_USDT_1h.csv'),
        btcCsv: join(dir, 'BTC_USDT_USDT_1h.csv'),
        ethSymbol: 'ETH/USDT:USDT',
        btcSymbol: 'BTC/USDT:USDT',
        basisEquityUsd: 10_000,
        controlArtifactDir,
        shadowArtifactDir,
        shadowComparisonPath,
        newsLogPath,
        newsLookback: '72h',
        newsLimit: 50,
        applyNewsOverlayToDefaultTarget: false,
        ethFundingPath,
        btcFundingPath,
      })

      expect(result.promotionPass).toBe(true)
      expect(result.paperAllow).toBe(true)
      expect(result.executionKind).toBe('active')

      expect(await readFile(canonicalTargetPath, 'utf-8')).toBe(canonicalTargetBefore)
      const runtimePaperGate = JSON.parse(
        await readFile(runtimeSnapshotPaths.paperGateStatus, 'utf-8'),
      ) as { finalAllowPaperTrading: boolean }
      const runtimeExecutor = JSON.parse(
        await readFile(runtimeSnapshotPaths.paperExecutorStatus, 'utf-8'),
      ) as { paperGateStatusPath: string; simulationOutput: string }
      const runtimeReadiness = JSON.parse(
        await readFile(runtimeSnapshotPaths.phaseReadiness, 'utf-8'),
      ) as { paper: { status: string } }
      expect(runtimePaperGate.finalAllowPaperTrading).toBe(true)
      expect(runtimeExecutor.paperGateStatusPath).toBe(runtimeSnapshotPaths.paperGateStatus)
      expect(runtimeExecutor.simulationOutput).toBe(
        runtimeSnapshotPaths.runtimeFaithfulSimulation,
      )
      expect(runtimeReadiness.paper.status).toBe('flat_only')

      const summary = JSON.parse(await readFile(summaryPath, 'utf-8')) as {
        statusSurface: string
        currentState: string
        operatorAction: string
        recoveryHints: string[]
        inputPaths: Record<string, string>
        targetPaths: Record<'base' | 'newsAdjusted' | 'final', string>
        newsAdjustedTargetState: {
          applyNewsOverlayToDefaultTarget: boolean
          overlayWriteDeprecated: boolean
        }
        signalState: {
          baseTargetHasExposure: boolean
          newsAdjustedTargetHasExposure: boolean
          finalTargetHasExposure: boolean
          blockers: string[]
        }
        newsOverlay: {
          hardVeto: boolean
          riskRegime: string
        }
        signalDiagnostics: {
          entryThresholds: { minAbsFundingSpread: number }
          zScoreGatePassed: boolean
          missingZScoreToTrigger: number
        } | null
        promotionDecision: string
        controlCandidate: { selectedParams: { id: string } } | null
        shortBiasShadow: { selectedParams: { id: string } } | null
      }
      expect(summary.statusSurface).toBe('synthetic_artifact_runtime')
      expect(summary.currentState).toBe('flat_because_no_signal_and_news_veto')
      expect(summary.operatorAction).toBe('review_runtime_bundle')
      expect(summary.recoveryHints).toEqual(
        expect.arrayContaining([
          'Wait for the next non-flat carry target refresh before treating the strategy as actionable.',
          'Review eth_carry_news_overlay.json and the flagged severe headlines before lifting the veto.',
        ]),
      )
      expect(summary.inputPaths).toMatchObject({
        canonicalPortfolioTargetPath: workingTargetPath,
        runtimeTruthPortfolioTargetPath: finalTargetPath,
        newsOverlayPath,
        baseTargetPath,
        adjustedForNewsTargetPath: adjustedTargetPath,
        finalTargetPath,
        freezePath,
      })
      expect(summary.targetPaths).toEqual({
        base: baseTargetPath,
        newsAdjusted: adjustedTargetPath,
        final: finalTargetPath,
      })
      expect(summary.newsAdjustedTargetState).toMatchObject({
        applyNewsOverlayToDefaultTarget: false,
        overlayWriteDeprecated: false,
      })
      expect(summary.signalState.baseTargetHasExposure).toBe(false)
      expect(summary.signalState.newsAdjustedTargetHasExposure).toBe(false)
      expect(summary.signalState.finalTargetHasExposure).toBe(false)
      expect(summary.signalState.blockers).toEqual(
        expect.arrayContaining(['no_active_signal', 'news_hard_veto']),
      )
      expect(summary.newsOverlay).toMatchObject({
        hardVeto: true,
        riskRegime: 'severe',
      })
      expect(summary.signalDiagnostics).toBeTruthy()
      expect(typeof summary.signalDiagnostics?.entryThresholds.minAbsFundingSpread).toBe('number')
      expect(summary.signalDiagnostics?.zScoreGatePassed).toBe(true)
      expect(summary.signalDiagnostics?.missingZScoreToTrigger).toBe(0)
      expect(summary.promotionDecision).toBe('promote_shadow')
      expect(summary.controlCandidate?.selectedParams.id).toBe('carry_24h_z13')
      expect(summary.shortBiasShadow?.selectedParams.id).toBe('carry_short_bias_soft')

      const transition = JSON.parse(await readFile(transitionPath, 'utf-8')) as {
        currentState: string
        events: Array<{ code: string }>
      }
      expect(transition.currentState).toBe('flat_because_no_signal_and_news_veto')
      expect(transition.events.map((event) => event.code)).toEqual(
        expect.arrayContaining([
          'INITIAL_STATUS_SNAPSHOT',
          'PROMOTION_DECISION_CHANGED',
          'PAPER_STATUS_CHANGED',
          'NEWS_HARD_VETO_ACTIVATED',
        ]),
      )

      const notification = JSON.parse(await readFile(notificationPath, 'utf-8')) as {
        currentState: string
        deliveryDecision: string
        shouldNotify: boolean
        reasons: string[]
        operatorAction: string | null
      }
      expect(notification.currentState).toBe('flat_because_no_signal_and_news_veto')
      expect(notification.deliveryDecision).toBe('notify')
      expect(notification.shouldNotify).toBe(true)
      expect(notification.reasons).toEqual(
        expect.arrayContaining(['no_active_signal', 'news_hard_veto']),
      )
      expect(notification.operatorAction).toBe('review_runtime_bundle')

      const operatorSummary = await readFile(operatorPath, 'utf-8')
      expect(operatorSummary).toContain('Status surface: synthetic_artifact_runtime')
      expect(operatorSummary).toContain('ETH carry state: flat_because_no_signal_and_news_veto')
      expect(operatorSummary).toContain('Operator action: review_runtime_bundle')
      expect(operatorSummary).toContain('Recovery hints:')

      expect(await readFile(adjustedTargetPath, 'utf-8')).toContain('news_overlay_applied')
      expect(await readFile(newsOverlayPath, 'utf-8')).toContain('"hardVeto": true')
      expect(await readFile(freezePath, 'utf-8')).toContain('"active": false')
    } finally {
      vi.useRealTimers()
    }
  })

  it('can express ready_to_trade_reduced in the helper outputs when exposure is intentionally scaled down', () => {
    const reducedStatus = {
      promotionPass: true,
      paperAllow: true,
      statusSurface: 'synthetic_artifact_runtime',
      operatorAction: 'review_runtime_bundle',
      promotionDecision: 'promote_shadow',
      phaseReadiness: { paper: { status: 'flat_only' } },
      controlCandidate: { selectedParams: { id: 'carry_24h_z13' } },
      shortBiasShadow: { selectedParams: { id: 'carry_short_bias_soft' } },
      signalState: {
        blockers: [],
        finalTargetHasExposure: true,
      },
      newsAdjustedTargetState: {
        exposureMultiplier: 0.5,
      },
      newsOverlay: {
        hardVeto: false,
        riskRegime: 'elevated',
      },
      recoveryHints: [
        'Exposure is scaled down by elevated news risk; do not interpret reduced size as a full-clear regime.',
      ],
    }

    expect(classifyEthCarryActionability(reducedStatus)).toBe('ready_to_trade_reduced')

    const transition = buildEthCarryTransitionAlert(null, {
      ...reducedStatus,
      currentState: 'ready_to_trade_reduced',
    })
    expect(transition.currentState).toBe('ready_to_trade_reduced')

    const notification = buildEthCarryActionabilityNotification(
      {
        ...reducedStatus,
        currentState: 'ready_to_trade_reduced',
      },
      {
        currentState: 'ready_to_trade_reduced',
        events: [
          {
            code: 'TARGET_RECOVERED_TO_NON_FLAT',
            severity: 'info',
            summary: 'Final target recovered from flat to non-flat exposure.',
          },
        ],
      },
    )
    expect(notification.currentState).toBe('ready_to_trade_reduced')
    expect(notification.headline).toBe('ETH carry is actionable with reduced size.')
    expect(notification.severity).toBe('info')
    expect(notification.deliveryDecision).toBe('notify')
    expect(notification.shouldNotify).toBe(true)
    expect(notification.operatorAction).toBe('review_runtime_bundle')
    expect(notification.fullText).toContain('State: ready_to_trade_reduced')
    expect(notification.fullText).toContain('Operator action: review_runtime_bundle')

    const operatorSummary = renderEthCarryOperatorSummary(
      {
        ...reducedStatus,
      },
      {
        currentState: 'ready_to_trade_reduced',
        events: [
          {
            code: 'TARGET_RECOVERED_TO_NON_FLAT',
            summary: 'Final target recovered from flat to non-flat exposure.',
          },
        ],
      },
    )
    expect(operatorSummary).toContain('ETH carry state: ready_to_trade_reduced')
    expect(operatorSummary).toContain('Operator action: review_runtime_bundle')
    expect(operatorSummary).toContain('Recovery hints:')
  })
})
