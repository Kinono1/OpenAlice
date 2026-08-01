import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  CryptoAccountInfo,
  CryptoFundingRate,
  CryptoOrder,
  CryptoOrderBook,
  CryptoOrderResult,
  CryptoPlaceOrderRequest,
  CryptoPosition,
  CryptoTicker,
  ICryptoTradingEngine,
} from '../src/domain/trading/operation-dispatcher.types.js'
import { readStrategyConfig } from '../src/core/config.js'
import { NewsCollectorStore } from '../src/domain/news/store.js'
import { evaluateFreezeWindows } from '../src/domain/strategy/event-calendar/index.js'
import { analyzeEthCarryNewsImpact } from '../src/runtime/news_impact.js'
import { buildPortfolioTargetFromWeights, type PortfolioTarget } from '../src/portfolio/target.js'
import { refreshRuntimeTruthMainline } from '../src/runtime/runtime_truth_mainline.js'
import { loadReleaseGateStatus } from '../src/runtime/release_gate_status.js'
import { DEFAULT_RUNTIME_STATUS_SNAPSHOT_BASE_DIR } from '../src/runtime/runtime_status_snapshot.js'
import { buildCarrySignalSeries, loadFundingHistory } from './lib/derivatives_history.ts'
import { loadCsvCandles } from './lib/pair_market_data.ts'

interface CliArgs {
  validationRunsPath: string
  verdictPath: string
  releaseGateStatusPath: string
  admissionDecisionPath: string
  registryPath: string
  portfolioTargetPath: string
  snapshotBaseDir: string
  ethCsv: string
  btcCsv: string
  ethSymbol: string
  btcSymbol: string
  basisEquityUsd: number
  controlArtifactDir?: string
  shadowArtifactDir?: string
  pairShadowArtifactDir?: string
  shadowComparisonPath?: string
  newsLogPath: string
  newsLookback: string
  newsLimit: number
  applyNewsOverlayToDefaultTarget: boolean
  ethFundingPath: string
  btcFundingPath: string
  dryRun?: boolean
}

interface RefreshEthCarryRuntimeStatusOptions extends CliArgs {
  runtimeSnapshotBaseDir?: string
}

interface RefreshEthCarryRuntimeStatusResult {
  summaryPath: string
  snapshotBaseDir: string
  portfolioTargetSource: 'file' | 'fallback_zero_target'
  promotionPass: boolean
  paperAllow: boolean
  executionKind: string
  phaseReadiness: ReturnType<typeof sanitizePhaseReadiness>
  pricesBySymbol: Record<string, number>
}

interface EthCarryStatusSnapshot {
  currentState?: string
  promotionPass: boolean
  paperAllow: boolean
  executionKind: string
  phaseReadiness: {
    paper?: { status?: string }
  }
  signalState?: {
    blockers?: string[]
    finalTargetHasExposure?: boolean
  }
  newsOverlay?: {
    hardVeto?: boolean
    riskRegime?: string
  } | null
  eventFreeze?: {
    active?: boolean
  } | null
  promotionDecision?: string | null
  controlCandidate?: {
    selectedParams?: { id?: string }
  } | null
  shortBiasShadow?: {
    selectedParams?: { id?: string }
  } | null
  pairShadowFamily?: {
    selectedParams?: { id?: string }
  } | null
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.dryRun) {
    console.log(JSON.stringify({
      family: 'eth_carry',
      command: 'refresh_eth_carry_runtime_status',
      executionMode: {
        dryRun: true,
        writesRuntimeStatusArtifacts: false,
        writesRuntimeTruthSnapshots: false,
        placesOrders: false,
      },
      inputPaths: {
        validationRunsPath: resolve(args.validationRunsPath),
        verdictPath: resolve(args.verdictPath),
        releaseGateStatusPath: resolve(args.releaseGateStatusPath),
        admissionDecisionPath: resolve(args.admissionDecisionPath),
        registryPath: resolve(args.registryPath),
        portfolioTargetPath: resolve(args.portfolioTargetPath),
        snapshotBaseDir: resolve(args.snapshotBaseDir),
      },
      optIn: {
        runRefresh: '--dryRun false',
      },
    }, null, 2))
    return
  }
  const result = await refreshEthCarryRuntimeStatus(args)
  console.log(result.summaryPath)
}

async function refreshEthCarryRuntimeStatus(
  args: RefreshEthCarryRuntimeStatusOptions,
): Promise<RefreshEthCarryRuntimeStatusResult> {
  const pricesBySymbol = await loadEthCarryPrices({
    ethCsv: args.ethCsv,
    btcCsv: args.btcCsv,
    ethSymbol: args.ethSymbol,
    btcSymbol: args.btcSymbol,
  })
  const releaseGateStatus = await loadReleaseGateStatus(args.releaseGateStatusPath)
  const strategyConfig = await readStrategyConfig()
  const news = await loadEthCarryNewsOverlay({
    logPath: args.newsLogPath,
    lookback: args.newsLookback,
    limit: args.newsLimit,
  })
  const freeze = evaluateFreezeWindows(
    Date.now(),
    strategyConfig.runtime.marketScope,
    strategyConfig.eventCalendar.events,
  )
  const baseTarget = JSON.parse(await readFile(resolve(args.portfolioTargetPath), 'utf-8')) as PortfolioTarget
  const baseTargetHasExposure = baseTarget.targetGrossExposure > 0
  const adjustedForNewsTarget = applyNewsOverlayToPortfolioTarget({
    target: baseTarget,
    newsImpact: news,
    ethSymbol: args.ethSymbol,
    btcSymbol: args.btcSymbol,
  })
  const adjustedTarget = applyFreezeOverlayToPortfolioTarget({
    target: adjustedForNewsTarget,
    freeze,
  })
  const baseTargetPath = resolve(args.snapshotBaseDir, 'eth_carry_base_paper_portfolio_target.json')
  const adjustedForNewsTargetPath = resolve(args.snapshotBaseDir, 'eth_carry_news_adjusted_paper_portfolio_target.json')
  const finalTargetPath = resolve(args.snapshotBaseDir, 'eth_carry_final_paper_portfolio_target.json')
  const newsOverlayPath = resolve(args.snapshotBaseDir, 'eth_carry_news_overlay.json')
  const freezePath = resolve(args.snapshotBaseDir, 'eth_carry_event_freeze.json')
  await mkdir(dirname(baseTargetPath), { recursive: true })
  await writeFile(baseTargetPath, `${JSON.stringify(baseTarget, null, 2)}\n`, 'utf-8')
  await writeFile(adjustedForNewsTargetPath, `${JSON.stringify(adjustedForNewsTarget, null, 2)}\n`, 'utf-8')
  await writeFile(finalTargetPath, `${JSON.stringify(adjustedTarget, null, 2)}\n`, 'utf-8')
  await writeFile(newsOverlayPath, `${JSON.stringify(news, null, 2)}\n`, 'utf-8')
  await writeFile(freezePath, `${JSON.stringify(freeze, null, 2)}\n`, 'utf-8')
  const shadowComparison = args.shadowComparisonPath
    ? JSON.parse(await readFile(resolve(args.shadowComparisonPath), 'utf-8'))
    : null
  const controlSummary = args.controlArtifactDir
    ? JSON.parse(await readFile(resolve(args.controlArtifactDir, 'eth_carry_summary.json'), 'utf-8'))
    : null
  const shadowSummary = args.shadowArtifactDir
    ? JSON.parse(await readFile(resolve(args.shadowArtifactDir, 'eth_carry_short_bias_summary.json'), 'utf-8'))
    : null
  const pairShadowSummary = args.pairShadowArtifactDir
    ? JSON.parse(await readFile(resolve(args.pairShadowArtifactDir, 'eth_carry_short_bias_pair_shadow_summary.json'), 'utf-8'))
    : null
  const runtimeSnapshotBaseDir = resolve(
    args.runtimeSnapshotBaseDir ?? DEFAULT_RUNTIME_STATUS_SNAPSHOT_BASE_DIR,
  )
  const promotedCandidate =
    shadowComparison?.promotionDecision === 'promote_shadow'
      ? shadowSummary?.selectedParams ?? null
      : controlSummary?.selectedParams ?? null
  const signalDiagnostics = promotedCandidate == null
    ? null
    : await buildCarrySignalDiagnostics({
        candidate: promotedCandidate,
        ethFundingPath: args.ethFundingPath,
        btcFundingPath: args.btcFundingPath,
      })

  const result = await refreshRuntimeTruthMainline(
    createCarryStatusEngine({
      basisEquityUsd: args.basisEquityUsd,
      pricesBySymbol,
    }),
    createCarryLiveGateManagerStub(releaseGateStatus),
    {
      symbols: [args.ethSymbol, args.btcSymbol],
      validationRunsPath: args.validationRunsPath,
      verdictPath: args.verdictPath,
      releaseGateStatusPath: args.releaseGateStatusPath,
      admissionDecisionPath: args.admissionDecisionPath,
      registryPath: args.registryPath,
      portfolioTargetPath: finalTargetPath,
      runtimePublishStatePath: resolve(args.snapshotBaseDir, 'runtime_publish_state.synthetic.json'),
      snapshotBaseDir: runtimeSnapshotBaseDir,
      now: new Date(),
    },
  )

  const summaryPath = resolve(args.snapshotBaseDir, 'eth_carry_runtime_status.json')
  const previousStatus = await readJsonIfExists<EthCarryStatusSnapshot>(summaryPath)
  await mkdir(dirname(summaryPath), { recursive: true })
  const payload = {
    generatedAt: new Date().toISOString(),
    family: 'eth_carry',
    inputPaths: {
      validationRunsPath: resolve(args.validationRunsPath),
      verdictPath: resolve(args.verdictPath),
      releaseGateStatusPath: resolve(args.releaseGateStatusPath),
      admissionDecisionPath: resolve(args.admissionDecisionPath),
      registryPath: resolve(args.registryPath),
      canonicalPortfolioTargetPath: resolve(args.portfolioTargetPath),
      runtimeTruthPortfolioTargetPath: finalTargetPath,
      newsOverlayPath,
      baseTargetPath,
      adjustedForNewsTargetPath,
      finalTargetPath,
      freezePath,
    },
    targetPaths: {
      base: baseTargetPath,
      newsAdjusted: adjustedForNewsTargetPath,
      final: finalTargetPath,
    },
    priceInputs: {
      [args.ethSymbol]: {
        csv: resolve(args.ethCsv),
        last: pricesBySymbol[args.ethSymbol],
      },
      [args.btcSymbol]: {
        csv: resolve(args.btcCsv),
        last: pricesBySymbol[args.btcSymbol],
      },
    },
    portfolioTargetSource: result.portfolioTargetSource,
    runtimeAvailability: result.runtimeAvailability,
    promotionPass: result.truth.promotionGate.pass,
    paperAllow: result.truth.paperGate.allowPaperTrading,
    executionKind: result.truth.executionPlan.kind,
    phaseReadiness: sanitizePhaseReadiness(result.phaseReadiness),
    newsOverlay: news.overlay ?? null,
    eventFreeze: {
      active: freeze.active,
      maxActionDuringFreeze: freeze.maxActionDuringFreeze ?? null,
      activeEvents: freeze.activeWindows.map((window) => ({
        name: window.event.name,
        severity: window.event.severity,
        startsAtUtc: new Date(window.startsAtUtc).toISOString(),
        endsAtUtc: new Date(window.endsAtUtc).toISOString(),
      })),
    },
    newsImpact: {
      totalNews: news.totalNews,
      highRiskNews: news.highRiskNews,
      sentimentScore: news.sentimentScore,
      riskScore: news.riskScore,
      flags: news.flags,
    },
    newsAdjustedTargetState: {
      applyNewsOverlayToDefaultTarget: args.applyNewsOverlayToDefaultTarget,
      overlayWriteDeprecated: args.applyNewsOverlayToDefaultTarget,
      baseTargetGrossExposure: baseTarget.targetGrossExposure,
      adjustedForNewsTargetGrossExposure: adjustedForNewsTarget.targetGrossExposure,
      adjustedTargetGrossExposure: adjustedTarget.targetGrossExposure,
      hardVeto: news.overlay?.hardVeto ?? false,
      riskRegime: news.overlay?.riskRegime ?? 'normal',
      exposureMultiplier: news.overlay?.exposureMultiplier ?? 1,
      favoredAsset: news.overlay?.assetPreference.favoredAsset ?? null,
      btcVsEthTilt: news.overlay?.assetPreference.btcVsEthTilt ?? 0,
      freezeActive: freeze.active,
      freezeMaxAction: freeze.maxActionDuringFreeze ?? null,
    },
    signalState: {
      baseTargetHasExposure,
      newsAdjustedTargetHasExposure: adjustedForNewsTarget.targetGrossExposure > 0,
      finalTargetHasExposure: adjustedTarget.targetGrossExposure > 0,
      blockers: [
        ...(baseTargetHasExposure ? [] : ['no_active_signal']),
        ...(news.overlay?.hardVeto ? ['news_hard_veto'] : []),
        ...(freeze.active ? ['event_freeze_active'] : []),
      ],
    },
    controlCandidate: controlSummary == null
      ? null
      : {
          artifactDir: resolve(args.controlArtifactDir!),
          selectedParams: controlSummary.selectedParams,
          selectedMetrics: controlSummary.selectedMetrics,
        },
    shortBiasShadow: shadowSummary == null
      ? null
      : {
          artifactDir: resolve(args.shadowArtifactDir!),
          selectedParams: shadowSummary.selectedParams,
          selectedMetrics: shadowSummary.selectedMetrics,
          releaseGate: shadowSummary.releaseGate,
        },
    pairShadowFamily: pairShadowSummary == null
      ? null
      : {
          artifactDir: resolve(args.pairShadowArtifactDir!),
          selectedParams: pairShadowSummary.selectedParams,
          selectedMetrics: pairShadowSummary.selectedMetrics,
          releaseGate: pairShadowSummary.releaseGate,
        },
    promotionDecision: shadowComparison?.promotionDecision ?? 'keep_control',
    shadowComparisonPath: args.shadowComparisonPath ? resolve(args.shadowComparisonPath) : null,
    statusSurface: 'synthetic_artifact_runtime' as const,
    signalDiagnostics,
  }
  const currentState = classifyEthCarryActionability(payload)
  const operatorAction = resolveEthCarryOperatorAction(payload, currentState)
  const recoveryHints = buildEthCarryRecoveryHints(payload)
  const payloadWithStatus = {
    ...payload,
    currentState,
    operatorAction,
    recoveryHints,
  }
  await writeFile(summaryPath, `${JSON.stringify(payloadWithStatus, null, 2)}\n`, 'utf-8')
  const transitionPath = resolve(args.snapshotBaseDir, 'eth_carry_transition_alert.json')
  const transition = buildEthCarryTransitionAlert(previousStatus, payloadWithStatus)
  await writeFile(transitionPath, `${JSON.stringify(transition, null, 2)}\n`, 'utf-8')
  const operatorPath = resolve(args.snapshotBaseDir, 'eth_carry_operator_summary.txt')
  await writeFile(operatorPath, `${renderEthCarryOperatorSummary(payloadWithStatus, transition)}\n`, 'utf-8')
  const notificationPath = resolve(args.snapshotBaseDir, 'eth_carry_actionability_notification.json')
  await writeFile(
    notificationPath,
    `${JSON.stringify(buildEthCarryActionabilityNotification(payloadWithStatus, transition), null, 2)}\n`,
    'utf-8',
  )

  return {
    summaryPath,
    snapshotBaseDir: resolve(args.snapshotBaseDir),
    portfolioTargetSource: result.portfolioTargetSource,
    promotionPass: result.truth.promotionGate.pass,
    paperAllow: result.truth.paperGate.allowPaperTrading,
    executionKind: result.truth.executionPlan.kind,
    phaseReadiness: sanitizePhaseReadiness(result.phaseReadiness),
    pricesBySymbol,
  }
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null
    }
    throw error
  }
}

async function loadEthCarryNewsOverlay(input: {
  logPath: string
  lookback: string
  limit: number
}) {
  const store = new NewsCollectorStore({
    logPath: input.logPath,
    maxInMemory: 2000,
    retentionDays: 14,
  })
  try {
    await store.init()
    const news = await store.getNewsV2({
      endTime: new Date(),
      lookback: input.lookback,
      limit: input.limit,
    })
    return analyzeEthCarryNewsImpact(news, { now: new Date() })
  } finally {
    await store.close()
  }
}

function applyNewsOverlayToPortfolioTarget(input: {
  target: PortfolioTarget
  newsImpact: ReturnType<typeof analyzeEthCarryNewsImpact>
  ethSymbol: string
  btcSymbol: string
}): PortfolioTarget {
  const overlay = input.newsImpact.overlay
  const weights = Object.fromEntries(
    input.target.positions.map((position) => [position.symbol, position.targetWeight]),
  ) as Record<string, number>

  if (!overlay || overlay.hardVeto) {
    return buildPortfolioTargetFromWeights({
      basisEquityUsd: input.target.basisEquityUsd,
      generatedAt: new Date().toISOString(),
      maxTurnoverPct: input.target.maxTurnoverPct,
      weights: Object.fromEntries(input.target.positions.map((position) => [position.symbol, 0])),
      notes: [
        ...(input.target.notes ?? []),
        'news_overlay_applied=true',
        'news_overlay_state=hard_veto_flat',
      ],
    })
  }

  const baseGross = input.target.targetGrossExposure
  const exposureMultiplier = overlay.exposureMultiplier
  const tiltedWeights = { ...weights }
  const btcMultiplier = clamp(1 + overlay.assetPreference.btcVsEthTilt, 0.9, 1.1)
  const ethMultiplier = clamp(1 - overlay.assetPreference.btcVsEthTilt, 0.9, 1.1)
  if (input.btcSymbol in tiltedWeights) {
    tiltedWeights[input.btcSymbol] *= btcMultiplier
  }
  if (input.ethSymbol in tiltedWeights) {
    tiltedWeights[input.ethSymbol] *= ethMultiplier
  }
  const tiltedGross = Object.values(tiltedWeights).reduce((sum, value) => sum + Math.abs(value), 0)
  const targetGross = baseGross * exposureMultiplier
  const normalizedWeights =
    tiltedGross > 0
      ? Object.fromEntries(
          Object.entries(tiltedWeights).map(([symbol, weight]) => [
            symbol,
            (weight / tiltedGross) * targetGross,
          ]),
        )
      : tiltedWeights

  return buildPortfolioTargetFromWeights({
    basisEquityUsd: input.target.basisEquityUsd,
    generatedAt: new Date().toISOString(),
    maxTurnoverPct: input.target.maxTurnoverPct,
    weights: normalizedWeights,
    notes: [
      ...(input.target.notes ?? []),
      'news_overlay_applied=true',
      `news_risk_regime=${overlay.riskRegime}`,
      `news_exposure_multiplier=${overlay.exposureMultiplier}`,
      `news_btc_eth_tilt=${overlay.assetPreference.btcVsEthTilt}`,
    ],
  })
}

function applyFreezeOverlayToPortfolioTarget(input: {
  target: PortfolioTarget
  freeze: ReturnType<typeof evaluateFreezeWindows>
}): PortfolioTarget {
  if (!input.freeze.active) {
    return input.target
  }
  return buildPortfolioTargetFromWeights({
    basisEquityUsd: input.target.basisEquityUsd,
    generatedAt: new Date().toISOString(),
    maxTurnoverPct: input.target.maxTurnoverPct,
    weights: Object.fromEntries(input.target.positions.map((position) => [position.symbol, 0])),
    notes: [
      ...(input.target.notes ?? []),
      'event_freeze_applied=true',
      `event_freeze_max_action=${input.freeze.maxActionDuringFreeze ?? 'unknown'}`,
      `event_freeze_active_count=${input.freeze.activeWindows.length}`,
    ],
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

async function loadEthCarryPrices(input: {
  ethCsv: string
  btcCsv: string
  ethSymbol: string
  btcSymbol: string
}): Promise<Record<string, number>> {
  const [ethCandles, btcCandles] = await Promise.all([
    loadCsvCandles(input.ethCsv, input.ethSymbol),
    loadCsvCandles(input.btcCsv, input.btcSymbol),
  ])
  const ethLast = ethCandles.at(-1)?.close
  const btcLast = btcCandles.at(-1)?.close
  if (!Number.isFinite(ethLast) || !Number.isFinite(btcLast)) {
    throw new Error('Failed to resolve latest ETH/BTC prices from local CSVs.')
  }
  return {
    [input.ethSymbol]: ethLast,
    [input.btcSymbol]: btcLast,
  }
}

function createCarryStatusEngine(input: {
  basisEquityUsd: number
  pricesBySymbol: Record<string, number>
}): ICryptoTradingEngine {
  return {
    async placeOrder(_order: CryptoPlaceOrderRequest): Promise<CryptoOrderResult> {
      throw new Error('refresh_eth_carry_runtime_status does not place orders.')
    },
    async getPositions(): Promise<CryptoPosition[]> {
      return []
    },
    async getOrders(): Promise<CryptoOrder[]> {
      return []
    },
    async getAccount(): Promise<CryptoAccountInfo> {
      return {
        accountId: 'eth-carry-runtime-status',
        currency: 'USD',
        balance: input.basisEquityUsd,
        equity: input.basisEquityUsd,
        freeMargin: input.basisEquityUsd,
        usedMargin: 0,
        leverage: 1,
        unrealizedPnl: 0,
        realizedPnlToday: 0,
      }
    },
    async cancelOrder(_orderId: string): Promise<boolean> {
      throw new Error('refresh_eth_carry_runtime_status does not cancel orders.')
    },
    async adjustLeverage(_symbol: string, _newLeverage: number): Promise<{ success: boolean; error?: string }> {
      throw new Error('refresh_eth_carry_runtime_status does not adjust leverage.')
    },
    async getTicker(symbol: string): Promise<CryptoTicker> {
      const last = input.pricesBySymbol[symbol]
      if (!Number.isFinite(last) || last <= 0) {
        throw new Error(`Missing local price for ${symbol}.`)
      }
      return {
        symbol,
        last,
        bid: last,
        ask: last,
        high: last,
        low: last,
        volume: 0,
        timestamp: new Date(),
      }
    },
    async getFundingRate(symbol: string): Promise<CryptoFundingRate> {
      return {
        symbol,
        fundingRate: 0,
        previousFundingRate: 0,
        timestamp: new Date(),
      }
    },
    async getOrderBook(symbol: string, _limit?: number): Promise<CryptoOrderBook> {
      const last = input.pricesBySymbol[symbol]
      if (!Number.isFinite(last) || last <= 0) {
        throw new Error(`Missing local price for ${symbol}.`)
      }
      return {
        symbol,
        bids: [[last, 1]],
        asks: [[last, 1]],
        timestamp: new Date(),
      }
    },
  }
}

function createCarryLiveGateManagerStub(
  releaseGateStatus: Awaited<ReturnType<typeof loadReleaseGateStatus>>,
) {
  return {
    async buildRuntimePlanningState() {
      return {
        regimeSeverity: 'stable' as const,
        regimeReason: null,
        capitalRampStage: '5%',
        releaseGateStatus,
        releaseGateBlocked: false,
        releaseGateBlockedReason: null,
        releaseGateAllowsPaperTrading: releaseGateStatus?.allowPaperTrading ?? null,
        releaseGateAllowsLiveTrading: releaseGateStatus?.allowLiveTrading ?? null,
      }
    },
  }
}

function sanitizePhaseReadiness(
  readiness: Awaited<ReturnType<typeof refreshRuntimeTruthMainline>>['phaseReadiness'],
) {
  return JSON.parse(JSON.stringify(readiness)) as Record<string, unknown>
}

function buildEthCarryTransitionAlert(
  previousStatus: EthCarryStatusSnapshot | null,
  currentStatus: any,
) {
  const previousBlockers = new Set(previousStatus?.signalState?.blockers ?? [])
  const currentBlockers = new Set(currentStatus.signalState?.blockers ?? [])
  const events: Array<{ code: string; severity: 'info' | 'warn'; summary: string }> = []

  if (previousStatus == null) {
    events.push({
      code: 'INITIAL_STATUS_SNAPSHOT',
      severity: 'info',
      summary: 'Initial ETH carry runtime status snapshot created.',
    })
  }

  if ((previousStatus?.promotionDecision ?? null) !== (currentStatus.promotionDecision ?? null)) {
    events.push({
      code: 'PROMOTION_DECISION_CHANGED',
      severity: 'info',
      summary: `Promotion decision changed from ${previousStatus?.promotionDecision ?? 'unknown'} to ${currentStatus.promotionDecision ?? 'unknown'}.`,
    })
  }

  if ((previousStatus?.phaseReadiness?.paper?.status ?? null) !== (currentStatus.phaseReadiness?.paper?.status ?? null)) {
    events.push({
      code: 'PAPER_STATUS_CHANGED',
      severity: 'info',
      summary: `Paper status changed from ${previousStatus?.phaseReadiness?.paper?.status ?? 'unknown'} to ${currentStatus.phaseReadiness?.paper?.status ?? 'unknown'}.`,
    })
  }

  if ((previousStatus?.newsOverlay?.hardVeto ?? false) !== (currentStatus.newsOverlay?.hardVeto ?? false)) {
    const nowHardVeto = currentStatus.newsOverlay?.hardVeto === true
    events.push({
      code: nowHardVeto ? 'NEWS_HARD_VETO_ACTIVATED' : 'NEWS_HARD_VETO_CLEARED',
      severity: nowHardVeto ? 'warn' : 'info',
      summary: nowHardVeto
        ? 'News hard veto is now active; target is forced flat.'
        : 'News hard veto cleared; target can recover if signal and gate allow.',
    })
  }

  if ((previousStatus?.eventFreeze?.active ?? false) !== (currentStatus.eventFreeze?.active ?? false)) {
    const nowFreeze = currentStatus.eventFreeze?.active === true
    events.push({
      code: nowFreeze ? 'EVENT_FREEZE_ACTIVATED' : 'EVENT_FREEZE_CLEARED',
      severity: nowFreeze ? 'warn' : 'info',
      summary: nowFreeze
        ? 'Macro event freeze is active; target is forced flat.'
        : 'Macro event freeze cleared.',
    })
  }

  if (previousBlockers.has('no_active_signal') && !currentBlockers.has('no_active_signal')) {
    events.push({
      code: 'ACTIVE_SIGNAL_RECOVERED',
      severity: 'info',
      summary: 'An active carry signal is now present.',
    })
  }

  if (!previousBlockers.has('no_active_signal') && currentBlockers.has('no_active_signal')) {
    events.push({
      code: 'ACTIVE_SIGNAL_LOST',
      severity: 'warn',
      summary: 'Carry signal is no longer active.',
    })
  }

  if (
    previousStatus?.signalState?.finalTargetHasExposure === false &&
    currentStatus.signalState?.finalTargetHasExposure === true
  ) {
    events.push({
      code: 'TARGET_RECOVERED_TO_NON_FLAT',
      severity: 'info',
      summary: 'Final target recovered from flat to non-flat exposure.',
    })
  }

  if (
    previousStatus?.signalState?.finalTargetHasExposure === true &&
    currentStatus.signalState?.finalTargetHasExposure === false
  ) {
    events.push({
      code: 'TARGET_FELL_BACK_TO_FLAT',
      severity: 'warn',
      summary: 'Final target fell back to flat exposure.',
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    changed: events.length > 0,
    currentState: currentStatus.currentState ?? classifyEthCarryActionability(currentStatus),
    events,
  }
}

function classifyEthCarryActionability(currentStatus: any): string {
  const blockers: string[] = currentStatus.signalState?.blockers ?? []
  if (!currentStatus.promotionPass || !currentStatus.paperAllow) {
    return 'blocked_by_release_gate'
  }
  if (blockers.includes('event_freeze_active') && blockers.includes('no_active_signal')) {
    return 'flat_because_no_signal_and_event_freeze'
  }
  if (blockers.includes('event_freeze_active')) {
    return 'flat_because_event_freeze'
  }
  if (blockers.includes('news_hard_veto') && blockers.includes('no_active_signal')) {
    return 'flat_because_no_signal_and_news_veto'
  }
  if (blockers.includes('news_hard_veto')) {
    return 'flat_because_news_veto'
  }
  if (
    currentStatus.signalState?.finalTargetHasExposure &&
    Number(currentStatus.newsAdjustedTargetState?.exposureMultiplier ?? 1) < 1
  ) {
    return 'ready_to_trade_reduced'
  }
  if (blockers.includes('no_active_signal')) {
    return 'flat_because_no_signal'
  }
  if (currentStatus.signalState?.finalTargetHasExposure) {
    return 'ready_to_trade'
  }
  return 'flat_unknown_reason'
}

function renderEthCarryOperatorSummary(
  currentStatus: any,
  transition: { currentState: string; events: Array<{ code: string; summary: string }> },
): string {
  const lines = [
    `ETH carry state: ${transition.currentState}`,
    `Status surface: ${currentStatus.statusSurface ?? 'unknown'}`,
    `Operator action: ${currentStatus.operatorAction ?? 'unknown'}`,
    `Promotion decision: ${currentStatus.promotionDecision ?? 'unknown'}`,
    `Paper status: ${currentStatus.phaseReadiness?.paper?.status ?? 'unknown'}`,
    `Control candidate: ${currentStatus.controlCandidate?.selectedParams?.id ?? 'unknown'}`,
    `Shadow candidate: ${currentStatus.shortBiasShadow?.selectedParams?.id ?? 'unknown'}`,
    `Blockers: ${(currentStatus.signalState?.blockers ?? []).join(', ') || 'none'}`,
    `News regime: ${currentStatus.newsOverlay?.riskRegime ?? 'unknown'}${currentStatus.newsOverlay?.hardVeto ? ' (hard veto)' : ''}`,
    `Event freeze active: ${currentStatus.eventFreeze?.active === true ? 'yes' : 'no'}`,
  ]
  if (Array.isArray(currentStatus.recoveryHints) && currentStatus.recoveryHints.length > 0) {
    lines.push('Recovery hints:')
    for (const hint of currentStatus.recoveryHints) {
      lines.push(`- ${hint}`)
    }
  }
  if (transition.events.length > 0) {
    lines.push('Recent transitions:')
    for (const event of transition.events) {
      lines.push(`- ${event.code}: ${event.summary}`)
    }
  }
  return lines.join('\n')
}

function buildEthCarryActionabilityNotification(
  currentStatus: any,
  transition: { currentState: string; events: Array<{ code: string; severity: string; summary: string }> },
) {
  const actionable =
    currentStatus.promotionPass === true &&
    currentStatus.paperAllow === true &&
    currentStatus.signalState?.finalTargetHasExposure === true
  const important = transition.events.filter((event) =>
    [
      'NEWS_HARD_VETO_CLEARED',
      'EVENT_FREEZE_CLEARED',
      'ACTIVE_SIGNAL_RECOVERED',
      'TARGET_RECOVERED_TO_NON_FLAT',
      'TARGET_FELL_BACK_TO_FLAT',
      'NEWS_HARD_VETO_ACTIVATED',
      'EVENT_FREEZE_ACTIVATED',
      'PROMOTION_DECISION_CHANGED',
      'PAPER_STATUS_CHANGED',
      'ACTIVE_SIGNAL_LOST',
    ].includes(event.code),
  )
  const currentState = transition.currentState
  const headline =
    currentState === 'ready_to_trade'
      ? 'ETH carry is actionable again.'
      : currentState === 'ready_to_trade_reduced'
        ? 'ETH carry is actionable with reduced size.'
        : currentState === 'flat_because_no_signal_and_news_veto'
          ? 'ETH carry is blocked by both no signal and news veto.'
          : currentState === 'flat_because_no_signal_and_event_freeze'
            ? 'ETH carry is blocked by both no signal and event freeze.'
            : currentState === 'flat_because_news_veto'
              ? 'ETH carry remains blocked by news veto.'
              : currentState === 'flat_because_event_freeze'
                ? 'ETH carry remains blocked by event freeze.'
                : currentState === 'flat_because_no_signal'
                  ? 'ETH carry is approved but waiting for a live signal.'
                  : 'ETH carry status updated.'
  const deliveryDecision = important.length > 0 ? 'notify' : 'suppress'
  const fullText = [
    headline,
    `State: ${currentState}`,
    `Operator action: ${currentStatus.operatorAction ?? 'unknown'}`,
    `Promotion decision: ${currentStatus.promotionDecision ?? 'unknown'}`,
    `Blockers: ${(currentStatus.signalState?.blockers ?? []).join(', ') || 'none'}`,
    ...(Array.isArray(currentStatus.recoveryHints) && currentStatus.recoveryHints.length > 0
      ? ['Recovery hints:', ...currentStatus.recoveryHints.map((hint: string) => `- ${hint}`)]
      : []),
  ].join('\n')
  return {
    generatedAt: new Date().toISOString(),
    shouldNotify: important.length > 0,
    deliveryDecision,
    currentState,
    actionable,
    severity:
      currentState === 'ready_to_trade' || currentState === 'ready_to_trade_reduced'
        ? 'info'
        : currentStatus.newsOverlay?.hardVeto || currentStatus.eventFreeze?.active
          ? 'warn'
          : 'info',
    headline,
    fullText,
    operatorAction: currentStatus.operatorAction ?? null,
    reasons: currentStatus.signalState?.blockers ?? [],
    events: important,
    controlCandidateId: currentStatus.controlCandidate?.selectedParams?.id ?? null,
    shadowCandidateId: currentStatus.shortBiasShadow?.selectedParams?.id ?? null,
    promotionDecision: currentStatus.promotionDecision ?? null,
  }
}

function resolveEthCarryOperatorAction(currentStatus: any, currentState: string): string {
  if (currentState === 'blocked_by_release_gate') {
    return 'review_runtime_bundle'
  }
  if (currentState === 'ready_to_trade' || currentState === 'ready_to_trade_reduced') {
    return 'review_runtime_bundle'
  }
  if (
    currentState === 'flat_because_news_veto' ||
    currentState === 'flat_because_no_signal_and_news_veto' ||
    currentState === 'flat_unknown_reason'
  ) {
    return 'review_runtime_bundle'
  }
  if (
    currentState === 'flat_because_event_freeze' ||
    currentState === 'flat_because_no_signal_and_event_freeze'
  ) {
    return 'monitor_next_refresh'
  }
  if (currentState === 'flat_because_no_signal') {
    return 'ignore'
  }
  return currentStatus.signalState?.finalTargetHasExposure ? 'review_runtime_bundle' : 'monitor_next_refresh'
}

function buildEthCarryRecoveryHints(currentStatus: any): string[] {
  const hints: string[] = []
  const blockers = new Set<string>(currentStatus.signalState?.blockers ?? [])
  if (blockers.has('no_active_signal')) {
    hints.push('Wait for the next non-flat carry target refresh before treating the strategy as actionable.')
    const diagnostics = currentStatus.signalDiagnostics
    if (diagnostics?.entryThresholds) {
      if (diagnostics.missingSpreadToTrigger > 0) {
        hints.push(`Funding spread is short by ${diagnostics.missingSpreadToTrigger.toFixed(8)} versus the active threshold.`)
      }
      if (diagnostics.missingZScoreToTrigger > 0) {
        hints.push(`Funding z-score is short by ${diagnostics.missingZScoreToTrigger.toFixed(4)} versus the active threshold.`)
      }
      if (diagnostics.persistenceBarsRequired > 0) {
        hints.push(`Signal still needs ${diagnostics.persistenceBarsRequired} persistence bars before entry would become valid.`)
      }
    }
  }
  if (blockers.has('news_hard_veto')) {
    hints.push('Review eth_carry_news_overlay.json and the flagged severe headlines before lifting the veto.')
  }
  if (blockers.has('event_freeze_active')) {
    hints.push('Wait until the active macro event freeze window clears, then re-check the final target.')
  }
  if (!currentStatus.promotionPass || !currentStatus.paperAllow) {
    hints.push('Review the release-gate bundle and runtime truth artifacts before treating paper trading as available.')
  }
  if (
    currentStatus.signalState?.finalTargetHasExposure &&
    Number(currentStatus.newsAdjustedTargetState?.exposureMultiplier ?? 1) < 1
  ) {
    hints.push('Exposure is scaled down by elevated news risk; do not interpret reduced size as a full-clear regime.')
  }
  return hints
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    validationRunsPath: raw.get('validationRunsPath') ?? 'data/research/strategy/strategy_validation_runs.json',
    verdictPath: raw.get('verdictPath') ?? 'data/research/strategy/experiment_verdict.v2.json',
    releaseGateStatusPath: raw.get('releaseGateStatusPath') ?? 'data/runtime/release_gate_status.json',
    admissionDecisionPath: raw.get('admissionDecisionPath') ?? 'data/runtime/admission_decision.v1.json',
    registryPath: raw.get('registryPath') ?? 'data/runtime/paper_champion_registry.json',
    portfolioTargetPath: raw.get('portfolioTargetPath') ?? 'data/runtime/paper_portfolio_target.json',
    snapshotBaseDir: raw.get('snapshotBaseDir') ?? 'data/runtime/eth_carry_status',
    ethCsv: raw.get('ethCsv') ?? 'data/market/gate/ETH_USDT_USDT_1h.csv',
    btcCsv: raw.get('btcCsv') ?? 'data/market/gate/BTC_USDT_USDT_1h.csv',
    ethSymbol: raw.get('ethSymbol') ?? 'ETH/USDT:USDT',
    btcSymbol: raw.get('btcSymbol') ?? 'BTC/USDT:USDT',
    basisEquityUsd: parseNumberArg(raw.get('basisEquityUsd'), 10_000, 'basisEquityUsd'),
    controlArtifactDir: raw.get('controlArtifactDir') ?? undefined,
    shadowArtifactDir: raw.get('shadowArtifactDir') ?? undefined,
    pairShadowArtifactDir: raw.get('pairShadowArtifactDir') ?? undefined,
    shadowComparisonPath: raw.get('shadowComparisonPath') ?? undefined,
    newsLogPath: raw.get('newsLogPath') ?? 'data/news-collector/news.jsonl',
    newsLookback: raw.get('newsLookback') ?? '72h',
    newsLimit: parseNumberArg(raw.get('newsLimit'), 200, 'newsLimit'),
    applyNewsOverlayToDefaultTarget: parseBoolArg(raw.get('applyNewsOverlayToDefaultTarget'), false),
    ethFundingPath:
      raw.get('ethFundingPath') ??
      'data/research/derivatives_history/binance_ETH_USDT_USDT_funding_history.json',
    btcFundingPath:
      raw.get('btcFundingPath') ??
      'data/research/derivatives_history/binance_BTC_USDT_USDT_funding_history.json',
    dryRun: parseBoolArg(raw.get('dryRun'), true),
  }
}

async function buildCarrySignalDiagnostics(input: {
  candidate: {
    minAbsFundingSpread?: number
    minAbsFundingZScore?: number
    signalPersistenceBars?: number
    shortEntry?: { minAbsFundingSpread?: number; minAbsFundingZScore?: number }
    longEntry?: { minAbsFundingSpread?: number; minAbsFundingZScore?: number }
  }
  ethFundingPath: string
  btcFundingPath: string
}) {
  const [ethFunding, btcFunding] = await Promise.all([
    loadFundingHistory(input.ethFundingPath),
    loadFundingHistory(input.btcFundingPath),
  ])
  const series = buildCarrySignalSeries({
    leaderFunding: ethFunding,
    hedgeFunding: btcFunding,
    zScoreLookback: 30,
  })
  const latest = series.at(-1)
  if (!latest) {
    return null
  }

  const entry =
    latest.fundingSpread > 0
      ? input.candidate.shortEntry ?? {
          minAbsFundingSpread: input.candidate.minAbsFundingSpread ?? 0,
          minAbsFundingZScore: input.candidate.minAbsFundingZScore,
        }
      : latest.fundingSpread < 0
        ? input.candidate.longEntry ?? {
            minAbsFundingSpread: input.candidate.minAbsFundingSpread ?? 0,
            minAbsFundingZScore: input.candidate.minAbsFundingZScore,
          }
        : {
            minAbsFundingSpread: input.candidate.minAbsFundingSpread ?? 0,
            minAbsFundingZScore: input.candidate.minAbsFundingZScore,
          }

  const absSpread = Math.abs(latest.fundingSpread)
  const absZScore = Math.abs(latest.fundingSpreadZScore)
  const minAbsFundingSpread = entry.minAbsFundingSpread ?? 0
  const minAbsFundingZScore = entry.minAbsFundingZScore ?? 0
  const persistenceBarsRequired = absSpread >= minAbsFundingSpread && absZScore >= minAbsFundingZScore
    ? 0
    : input.candidate.signalPersistenceBars ?? 0

  return {
    latestTime: latest.time,
    fundingSpread: latest.fundingSpread,
    fundingSpreadZScore: latest.fundingSpreadZScore,
    absFundingSpread: absSpread,
    absFundingZScore: absZScore,
    entryDirection: latest.fundingSpread > 0 ? 'short_pair' : latest.fundingSpread < 0 ? 'long_pair' : 'flat',
    entryThresholds: {
      minAbsFundingSpread,
      minAbsFundingZScore,
    },
    spreadGatePassed: absSpread >= minAbsFundingSpread,
    zScoreGatePassed: absZScore >= minAbsFundingZScore,
    missingSpreadToTrigger: Math.max(0, minAbsFundingSpread - absSpread),
    missingZScoreToTrigger: Math.max(0, minAbsFundingZScore - absZScore),
    persistenceBarsRequired,
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    index += 1
  }
  return out
}

function parseNumberArg(raw: string | undefined, fallback: number, label: string): number {
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number.`)
  }
  return value
}

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

export {
  buildEthCarryTransitionAlert,
  buildEthCarryActionabilityNotification,
  applyNewsOverlayToPortfolioTarget,
  createCarryLiveGateManagerStub,
  createCarryStatusEngine,
  classifyEthCarryActionability,
  loadEthCarryPrices,
  loadEthCarryNewsOverlay,
  parseArgs,
  renderEthCarryOperatorSummary,
  refreshEthCarryRuntimeStatus,
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
