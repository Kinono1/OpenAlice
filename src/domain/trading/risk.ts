import type {
  CryptoAccountInfo,
  CryptoPlaceOrderRequest,
  CryptoPosition,
  ICryptoTradingEngine,
  CapitalScaleRule,
  RiskCheckContext,
  RiskCheckResult,
  RiskConfig,
} from './operation-dispatcher.types.js'

// ── Integer Bps risk calculations (v5) ──────────────────────────────
// 1.0x = 10000 bps, 0.02 = 200 bps

export type Bps = number

/**
 * Round half away from zero (banker-independent rounding).
 * Unlike Math.round which rounds .5 toward +infinity, this rounds
 * .5 away from zero: 0.5 → 1, -0.5 → -1.
 */
export function awayFromZeroRounding(value: number): number {
  if (value === 0) return 0
  return Math.sign(value) * Math.round(Math.abs(value) + Number.EPSILON)
}

/**
 * Convert a percentage (0-100 scale) to integer basis points.
 * pctToBps(50) = 5000 bps (50% = 5000 bps)
 */
export function pctToBps(pct: number): Bps {
  return awayFromZeroRounding(pct * 100) as Bps
}

/**
 * Convert integer basis points back to percentage (0-100 scale).
 * bpsToPct(5000) = 50 (5000 bps = 50%)
 */
export function bpsToPct(bps: Bps): number {
  return bps / 100
}

/**
 * Convert a decimal fraction to integer basis points.
 * floatToBps(0.50) = 5000 bps (0.50 = 50% = 5000 bps)
 *
 * @param value - Decimal fraction (e.g., 0.50 for 50%)
 * @param precision - Legacy compatibility parameter. v5 risk math always emits integer bps.
 */
export function floatToBps(value: number, precision?: number): Bps {
  void precision
  const raw = value * 10000
  return awayFromZeroRounding(raw) as Bps
}

interface EffectiveRiskLimits {
  maxOpenPositions: number
  maxLeverage: number
  maxOrderUsd: number
  maxPositionPctOfEquity: number
  maxSingleTradeLossUsd?: number
  maxTotalExposurePctOfEquity?: number
  maxSymbolExposurePctOfEquity?: number
  maxNetDirectionalExposurePctOfEquity?: number
  maxCorrelatedGroupExposurePctOfEquity?: number
  capitalRampStage?: string
  highVolatilityClampActive: boolean
}

const DAILY_PNL_FIELD_CANDIDATES = [
  'dailyPnL',
  'dailyPnl',
  'dailyRealizedPnl',
  'dailyRealizedPnL',
  'todayRealizedPnl',
  'todayRealizedPnL',
] as const

type DailyPnlField = (typeof DAILY_PNL_FIELD_CANDIDATES)[number]
type DailyPnlCarrier = Partial<Record<DailyPnlField, unknown>>

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim().replace(/,/g, ''))
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
}

function readDailyPnlFromCarrier(
  carrier: DailyPnlCarrier | undefined,
  sourcePrefix: 'context' | 'account',
): { value: number; source: string } | null {
  if (!carrier) return null

  for (const key of DAILY_PNL_FIELD_CANDIDATES) {
    const value = parseFiniteNumber(carrier[key])
    if (typeof value === 'number') {
      return { value, source: `${sourcePrefix}.${key}` }
    }
  }

  return null
}

function resolveDailyPnlUsd(
  account: CryptoAccountInfo,
  context?: RiskCheckContext,
): { value: number | null; source: string } {
  const explicitContextPnl = readDailyPnlFromCarrier(context, 'context')
  if (explicitContextPnl) return explicitContextPnl

  const explicitAccountPnl = readDailyPnlFromCarrier(account, 'account')
  if (explicitAccountPnl) return explicitAccountPnl

  const source = account.realizedPnlSource
  const realizedPnl = parseFiniteNumber(account.realizedPnL)
  if (
    typeof realizedPnl === 'number' &&
    (source === 'balance_payload' || source === 'closed_trades_ledger')
  ) {
    return {
      value: realizedPnl,
      source:
        source === 'balance_payload'
          ? 'account.realizedPnL(balance_payload)'
          : 'account.realizedPnL(closed_trades_ledger)',
    }
  }

  return { value: null, source: 'unavailable' }
}

function isRiskReducingOrder(
  order: CryptoPlaceOrderRequest,
  existing: CryptoPosition | undefined,
): boolean {
  if (!existing) return false
  if (order.reduceOnly) return true
  return (
    (existing.side === 'long' && order.side === 'sell') ||
    (existing.side === 'short' && order.side === 'buy')
  )
}

function projectPositionNotionalUsd(input: {
  existingNotional: number
  orderNotional: number
  riskReducing: boolean
}): number {
  if (!input.riskReducing) {
    return input.existingNotional + input.orderNotional
  }
  return Math.max(0, input.existingNotional - input.orderNotional)
}

function resolveCapitalScaleRule(
  riskConfig: RiskConfig,
  context?: RiskCheckContext,
): CapitalScaleRule | undefined {
  const rules = riskConfig.capitalScaleRules
  const stage = context?.capitalRampStage?.trim()
  if (!rules || rules.length === 0 || !stage) {
    return undefined
  }
  const normalizedStage = stage.toLowerCase()
  return rules.find(
    rule => rule.stage.trim().toLowerCase() === normalizedStage,
  )
}

function resolveEffectiveLimits(
  riskConfig: RiskConfig,
  context?: RiskCheckContext,
): EffectiveRiskLimits {
  const matchedScaleRule = resolveCapitalScaleRule(riskConfig, context)

  let maxLeverage = matchedScaleRule?.maxLeverage ?? riskConfig.maxLeverage

  const highVolatilityClampActive =
    typeof riskConfig.highVolatilityQuantileCut === 'number' &&
    typeof context?.volatilityQuantile === 'number' &&
    context.volatilityQuantile >= riskConfig.highVolatilityQuantileCut

  if (highVolatilityClampActive) {
    const highVolatilityMaxLeverage =
      matchedScaleRule?.highVolatilityMaxLeverage ?? 1
    maxLeverage = Math.min(maxLeverage, highVolatilityMaxLeverage)
  }

  return {
    maxOpenPositions:
      matchedScaleRule?.maxOpenPositions ?? riskConfig.maxOpenPositions,
    maxLeverage,
    maxOrderUsd: matchedScaleRule?.maxOrderUsd ?? riskConfig.maxOrderUsd,
    maxPositionPctOfEquity:
      matchedScaleRule?.maxPositionPctOfEquity ??
      riskConfig.maxPositionPctOfEquity,
    maxSingleTradeLossUsd:
      matchedScaleRule?.maxSingleTradeLossUsd ??
      riskConfig.maxSingleTradeLossUsd,
    maxTotalExposurePctOfEquity:
      matchedScaleRule?.maxTotalExposurePctOfEquity ??
      riskConfig.maxTotalExposurePctOfEquity,
    maxSymbolExposurePctOfEquity:
      matchedScaleRule?.maxSymbolExposurePctOfEquity ??
      riskConfig.maxSymbolExposurePctOfEquity,
    maxNetDirectionalExposurePctOfEquity:
      matchedScaleRule?.maxNetDirectionalExposurePctOfEquity ??
      riskConfig.maxNetDirectionalExposurePctOfEquity,
    maxCorrelatedGroupExposurePctOfEquity:
      matchedScaleRule?.maxCorrelatedGroupExposurePctOfEquity ??
      riskConfig.maxCorrelatedGroupExposurePctOfEquity,
    capitalRampStage: matchedScaleRule?.stage,
    highVolatilityClampActive,
  }
}

function estimateOrderNotionalUsd(
  order: CryptoPlaceOrderRequest,
  existingPosition: CryptoPosition | undefined,
): number | null {
  if (typeof order.usd_size === 'number' && order.usd_size > 0) {
    return order.usd_size
  }
  if (
    typeof order.size === 'number' &&
    order.size > 0 &&
    typeof order.price === 'number' &&
    order.price > 0
  ) {
    return order.size * order.price
  }
  if (
    typeof order.size === 'number' &&
    order.size > 0 &&
    typeof existingPosition?.markPrice === 'number' &&
    existingPosition.markPrice > 0
  ) {
    return order.size * existingPosition.markPrice
  }
  return null
}

function estimateRiskIfFilledUsd(input: {
  order: CryptoPlaceOrderRequest
  orderNotional: number | null
  context?: RiskCheckContext
}): number | null {
  const explicitRisk = parseFiniteNumber(input.context?.riskIfFilledUsd)
  if (typeof explicitRisk === 'number' && explicitRisk >= 0) {
    return explicitRisk
  }

  const entryPrice = parseFiniteNumber(input.context?.entryPrice ?? input.order.price)
  const stopLossPrice = parseFiniteNumber(input.context?.stopLossPrice)
  if (
    input.orderNotional == null ||
    entryPrice == null ||
    stopLossPrice == null ||
    entryPrice <= 0 ||
    stopLossPrice <= 0
  ) {
    return null
  }

  const stopDistancePct = Math.abs(entryPrice - stopLossPrice) / entryPrice
  return input.orderNotional * stopDistancePct
}

function projectTotalExposureNotionalUsd(input: {
  positions: CryptoPosition[]
  order: CryptoPlaceOrderRequest
  orderNotional: number | null
  existing: CryptoPosition | undefined
}): number | null {
  const currentExposure = input.positions.reduce(
    (sum, position) => sum + Math.max(0, position.positionValue),
    0,
  )
  if (input.orderNotional == null) {
    return currentExposure
  }
  const existingNotional = Math.max(0, input.existing?.positionValue ?? 0)
  if (isRiskReducingOrder(input.order, input.existing)) {
    return Math.max(0, currentExposure - Math.min(existingNotional, input.orderNotional))
  }
  return currentExposure + input.orderNotional
}

function signedPositionNotional(position: CryptoPosition): number {
  const notional = Math.max(0, position.positionValue)
  return position.side === 'short' ? -notional : notional
}

function signedOrderNotional(input: {
  order: CryptoPlaceOrderRequest
  orderNotional: number
  existing: CryptoPosition | undefined
}): number {
  if (isRiskReducingOrder(input.order, input.existing)) {
    if (!input.existing) return 0
    return input.existing.side === 'long'
      ? -input.orderNotional
      : input.orderNotional
  }
  return input.order.side === 'sell' ? -input.orderNotional : input.orderNotional
}

function resolveCorrelatedExposureGroup(
  symbol: string,
  groups: Record<string, string[]> | undefined,
): { groupId: string; symbols: string[] } | null {
  if (!groups) return null
  for (const [groupId, symbols] of Object.entries(groups)) {
    if (symbols.includes(symbol)) {
      return { groupId, symbols }
    }
  }
  return null
}

export async function preTradeRiskCheck(
  engine: ICryptoTradingEngine,
  order: CryptoPlaceOrderRequest,
  riskConfig: RiskConfig | undefined,
  context?: RiskCheckContext,
): Promise<RiskCheckResult> {
  if (!riskConfig || !riskConfig.enabled) {
    return { approved: true }
  }

  const effectiveLimits = resolveEffectiveLimits(riskConfig, context)

  if (riskConfig.killSwitch && !order.reduceOnly) {
    return {
      approved: false,
      reason: 'Kill switch is ON; only reduce-only operations are allowed.',
    }
  }

  if (order.leverage && order.leverage > effectiveLimits.maxLeverage) {
    return {
      approved: false,
      reason: `Leverage ${order.leverage}x exceeds maxLeverage ${effectiveLimits.maxLeverage}x.`,
      details: {
        requestedLeverage: order.leverage,
        maxLeverage: effectiveLimits.maxLeverage,
        capitalRampStage: effectiveLimits.capitalRampStage,
        highVolatilityClampActive: effectiveLimits.highVolatilityClampActive,
        volatilityQuantile: context?.volatilityQuantile,
        highVolatilityQuantileCut: riskConfig.highVolatilityQuantileCut,
      },
    }
  }

  const positions =
    context?.positions ??
    (await engine.getPositions())
  const account =
    context?.account ??
    (await engine.getAccount())
  const existing = positions.find(p => p.symbol === order.symbol)

  const isNewOpen = !order.reduceOnly && !existing

  if (
    isNewOpen &&
    (riskConfig.enforceRealizedPnlConfidence ?? true)
  ) {
    const minConfidence = riskConfig.minRealizedPnlConfidence ?? 0.7
    const trustedSources = riskConfig.trustedRealizedPnlSources ?? [
      'balance_payload',
      'closed_trades_ledger',
    ]
    const source = account.realizedPnlSource ?? 'derived_fallback'
    const confidence =
      typeof account.realizedPnlConfidence === 'number'
        ? account.realizedPnlConfidence
        : 0
    const sourceTrusted = trustedSources.includes(
      source as 'balance_payload' | 'closed_trades_ledger',
    )
    if (!sourceTrusted || confidence < minConfidence) {
      return {
        approved: false,
        reason: `Realized PnL confidence gate blocked new opens (source=${source}, confidence=${confidence.toFixed(2)}, min=${minConfidence}).`,
        details: {
          realizedPnlSource: source,
          realizedPnlConfidence: confidence,
          minRealizedPnlConfidence: minConfidence,
          trustedRealizedPnlSources: trustedSources,
        },
      }
    }
  }

  if (isNewOpen && positions.length >= effectiveLimits.maxOpenPositions) {
    return {
      approved: false,
      reason: `Open position count ${positions.length} reached maxOpenPositions ${effectiveLimits.maxOpenPositions}.`,
      details: {
        openPositions: positions.length,
        maxOpenPositions: effectiveLimits.maxOpenPositions,
        capitalRampStage: effectiveLimits.capitalRampStage,
      },
    }
  }

  const dailyPnl = resolveDailyPnlUsd(account, context)
  if (
    dailyPnl.value !== null &&
    dailyPnl.value <= -riskConfig.maxDailyLossUsd
  ) {
    return {
      approved: false,
      reason: `Current daily PnL ${dailyPnl.value.toFixed(2)} (${dailyPnl.source}) breached maxDailyLossUsd -${riskConfig.maxDailyLossUsd}.`,
      details: {
        dailyPnl: dailyPnl.value,
        dailyPnlSource: dailyPnl.source,
        maxDailyLossUsd: riskConfig.maxDailyLossUsd,
      },
    }
  }

  if (
    isNewOpen &&
    typeof riskConfig.dailyLossPctSoftCap === 'number' &&
    typeof context?.dailyLossPct === 'number' &&
    context.dailyLossPct <= riskConfig.dailyLossPctSoftCap
  ) {
    return {
      approved: false,
      reason: `Current daily loss ${context.dailyLossPct.toFixed(2)}% breached dailyLossPctSoftCap ${riskConfig.dailyLossPctSoftCap}%; new opens are blocked.`,
      details: {
        dailyLossPct: context.dailyLossPct,
        dailyLossPctSoftCap: riskConfig.dailyLossPctSoftCap,
      },
    }
  }

  if (
    isNewOpen &&
    typeof riskConfig.cvarLossPctSoftCap === 'number' &&
    typeof context?.cvarDailyLossPct === 'number' &&
    context.cvarDailyLossPct <= riskConfig.cvarLossPctSoftCap
  ) {
    return {
      approved: false,
      reason: `Tail risk CVaR ${context.cvarDailyLossPct.toFixed(2)}% breached cvarLossPctSoftCap ${riskConfig.cvarLossPctSoftCap}%; new opens are blocked.`,
      details: {
        cvarDailyLossPct: context.cvarDailyLossPct,
        cvarLossPctSoftCap: riskConfig.cvarLossPctSoftCap,
      },
    }
  }

  if (
    isNewOpen &&
    typeof riskConfig.consecutiveLossDaysLimit === 'number' &&
    typeof riskConfig.consecutiveLossPctThreshold === 'number' &&
    typeof context?.consecutiveLossDays === 'number' &&
    typeof context?.consecutiveLossPct === 'number' &&
    context.consecutiveLossDays >= riskConfig.consecutiveLossDaysLimit &&
    context.consecutiveLossPct <= riskConfig.consecutiveLossPctThreshold
  ) {
    return {
      approved: false,
      reason: `Consecutive loss breaker active at ${context.consecutiveLossDays} days and ${context.consecutiveLossPct.toFixed(2)}% <= ${riskConfig.consecutiveLossPctThreshold}%; new opens are blocked.`,
      details: {
        consecutiveLossDays: context.consecutiveLossDays,
        consecutiveLossDaysLimit: riskConfig.consecutiveLossDaysLimit,
        consecutiveLossPct: context.consecutiveLossPct,
        consecutiveLossPctThreshold: riskConfig.consecutiveLossPctThreshold,
      },
    }
  }

  const orderNotional = estimateOrderNotionalUsd(order, existing)
  const riskIfFilledUsd = estimateRiskIfFilledUsd({ order, orderNotional, context })
  if (
    isNewOpen &&
    typeof effectiveLimits.maxSingleTradeLossUsd === 'number' &&
    riskIfFilledUsd !== null &&
    riskIfFilledUsd > effectiveLimits.maxSingleTradeLossUsd
  ) {
    return {
      approved: false,
      reason: `Risk if filled $${riskIfFilledUsd.toFixed(2)} exceeds maxSingleTradeLossUsd $${effectiveLimits.maxSingleTradeLossUsd}.`,
      details: {
        riskIfFilledUsd,
        maxSingleTradeLossUsd: effectiveLimits.maxSingleTradeLossUsd,
        orderNotional,
        entryPrice: context?.entryPrice ?? order.price,
        stopLossPrice: context?.stopLossPrice,
        capitalRampStage: effectiveLimits.capitalRampStage,
      },
    }
  }

  if (orderNotional !== null && orderNotional > effectiveLimits.maxOrderUsd) {
    return {
      approved: false,
      reason: `Order notional $${orderNotional.toFixed(2)} exceeds maxOrderUsd $${effectiveLimits.maxOrderUsd}.`,
      details: {
        orderNotional,
        maxOrderUsd: effectiveLimits.maxOrderUsd,
        capitalRampStage: effectiveLimits.capitalRampStage,
      },
    }
  }

  const projectedTotalExposureNotional = projectTotalExposureNotionalUsd({
    positions,
    order,
    orderNotional,
    existing,
  })
  if (
    projectedTotalExposureNotional !== null &&
    account.equity > 0 &&
    typeof effectiveLimits.maxTotalExposurePctOfEquity === 'number'
  ) {
    const projectedTotalExposureBps = floatToBps(projectedTotalExposureNotional / account.equity)
    const maxTotalExposureBps = pctToBps(effectiveLimits.maxTotalExposurePctOfEquity)
    if (projectedTotalExposureBps > maxTotalExposureBps) {
      return {
        approved: false,
        reason: `Projected total exposure ${projectedTotalExposureBps} bps exceeds maxTotalExposurePctOfEquity ${maxTotalExposureBps} bps.`,
        details: {
          projectedTotalExposureNotional,
          equity: account.equity,
          projectedTotalExposureBps,
          projectedTotalExposurePct: bpsToPct(projectedTotalExposureBps),
          maxTotalExposureBps,
          maxTotalExposurePctOfEquity: effectiveLimits.maxTotalExposurePctOfEquity,
          capitalRampStage: effectiveLimits.capitalRampStage,
        },
      }
    }
  }

  if (
    orderNotional !== null &&
    account.equity > 0 &&
    typeof effectiveLimits.maxSymbolExposurePctOfEquity === 'number'
  ) {
    const existingSymbolExposure = positions
      .filter(position => position.symbol === order.symbol)
      .reduce((sum, position) => sum + Math.max(0, position.positionValue), 0)
    const projectedSymbolExposure = isRiskReducingOrder(order, existing)
      ? Math.max(0, existingSymbolExposure - orderNotional)
      : existingSymbolExposure + orderNotional
    const projectedSymbolExposureBps = floatToBps(projectedSymbolExposure / account.equity)
    const maxSymbolExposureBps = pctToBps(effectiveLimits.maxSymbolExposurePctOfEquity)
    if (projectedSymbolExposureBps > maxSymbolExposureBps) {
      return {
        approved: false,
        reason: `Projected symbol exposure ${projectedSymbolExposureBps} bps exceeds maxSymbolExposurePctOfEquity ${maxSymbolExposureBps} bps.`,
        details: {
          symbol: order.symbol,
          projectedSymbolExposure,
          equity: account.equity,
          projectedSymbolExposureBps,
          projectedSymbolExposurePct: bpsToPct(projectedSymbolExposureBps),
          maxSymbolExposureBps,
          maxSymbolExposurePctOfEquity: effectiveLimits.maxSymbolExposurePctOfEquity,
          capitalRampStage: effectiveLimits.capitalRampStage,
        },
      }
    }
  }

  if (
    orderNotional !== null &&
    account.equity > 0 &&
    typeof effectiveLimits.maxNetDirectionalExposurePctOfEquity === 'number'
  ) {
    const currentNetDirectionalNotional = positions.reduce(
      (sum, position) => sum + signedPositionNotional(position),
      0,
    )
    const projectedNetDirectionalNotional =
      currentNetDirectionalNotional + signedOrderNotional({ order, orderNotional, existing })
    const projectedNetDirectionalExposureBps = floatToBps(Math.abs(projectedNetDirectionalNotional) / account.equity)
    const maxNetDirectionalExposureBps = pctToBps(effectiveLimits.maxNetDirectionalExposurePctOfEquity)
    if (projectedNetDirectionalExposureBps > maxNetDirectionalExposureBps) {
      return {
        approved: false,
        reason: `Projected net directional exposure ${projectedNetDirectionalExposureBps} bps exceeds maxNetDirectionalExposurePctOfEquity ${maxNetDirectionalExposureBps} bps.`,
        details: {
          projectedNetDirectionalNotional,
          equity: account.equity,
          projectedNetDirectionalExposureBps,
          projectedNetDirectionalExposurePct: bpsToPct(projectedNetDirectionalExposureBps),
          maxNetDirectionalExposureBps,
          maxNetDirectionalExposurePctOfEquity: effectiveLimits.maxNetDirectionalExposurePctOfEquity,
          capitalRampStage: effectiveLimits.capitalRampStage,
        },
      }
    }
  }

  if (
    orderNotional !== null &&
    account.equity > 0 &&
    typeof effectiveLimits.maxCorrelatedGroupExposurePctOfEquity === 'number'
  ) {
    const group = resolveCorrelatedExposureGroup(
      order.symbol,
      riskConfig.correlatedExposureGroups,
    )
    if (group) {
      const currentGroupExposure = positions
        .filter(position => group.symbols.includes(position.symbol))
        .reduce((sum, position) => sum + Math.max(0, position.positionValue), 0)
      const existingInGroupExposure = group.symbols.includes(order.symbol)
        ? Math.max(0, existing?.positionValue ?? 0)
        : 0
      const projectedGroupExposure = isRiskReducingOrder(order, existing)
        ? Math.max(0, currentGroupExposure - Math.min(existingInGroupExposure, orderNotional))
        : currentGroupExposure + orderNotional
      const projectedCorrelatedGroupExposureBps = floatToBps(projectedGroupExposure / account.equity)
      const maxCorrelatedGroupExposureBps = pctToBps(effectiveLimits.maxCorrelatedGroupExposurePctOfEquity)
      if (projectedCorrelatedGroupExposureBps > maxCorrelatedGroupExposureBps) {
        return {
          approved: false,
          reason: `Projected correlated group exposure ${projectedCorrelatedGroupExposureBps} bps exceeds maxCorrelatedGroupExposurePctOfEquity ${maxCorrelatedGroupExposureBps} bps.`,
          details: {
            groupId: group.groupId,
            symbols: group.symbols,
            projectedGroupExposure,
            equity: account.equity,
            projectedCorrelatedGroupExposureBps,
            projectedCorrelatedGroupExposurePct: bpsToPct(projectedCorrelatedGroupExposureBps),
            maxCorrelatedGroupExposureBps,
            maxCorrelatedGroupExposurePctOfEquity: effectiveLimits.maxCorrelatedGroupExposurePctOfEquity,
            capitalRampStage: effectiveLimits.capitalRampStage,
          },
        }
      }
    }
  }

  if (orderNotional !== null && account.equity > 0) {
    const existingNotional = existing?.positionValue ?? 0
    const projectedNotional = projectPositionNotionalUsd({
      existingNotional,
      orderNotional,
      riskReducing: isRiskReducingOrder(order, existing),
    })
    const projectedBps = floatToBps(projectedNotional / account.equity)
    const maxPositionBps = pctToBps(effectiveLimits.maxPositionPctOfEquity)
    if (projectedBps > maxPositionBps) {
      return {
        approved: false,
        reason: `Projected position size ${projectedBps} bps exceeds max ${maxPositionBps} bps.`,
        details: {
          projectedNotional,
          equity: account.equity,
          projectedBps,
          maxPositionBps,
          capitalRampStage: effectiveLimits.capitalRampStage,
        },
      }
    }
  }

  return { approved: true }
}
