import type {
  CryptoPlaceOrderRequest,
  CryptoPosition,
  ICryptoTradingEngine,
} from "./interfaces.js";

export interface CapitalScaleRule {
  stage: string;
  maxOpenPositions?: number;
  maxLeverage?: number;
  maxOrderUsd?: number;
  maxPositionPctOfEquity?: number;
  highVolatilityMaxLeverage?: number;
}

export interface RiskConfig {
  enabled: boolean;
  killSwitch: boolean;
  maxOpenPositions: number;
  maxLeverage: number;
  maxOrderUsd: number;
  maxPositionPctOfEquity: number;
  maxDailyLossUsd: number;
  enforceRealizedPnlConfidence?: boolean;
  minRealizedPnlConfidence?: number;
  trustedRealizedPnlSources?: Array<"balance_payload" | "closed_trades_ledger">;
  dailyLossPctSoftCap?: number;
  cvarLossPctSoftCap?: number;
  cvarLookbackDays?: number;
  cvarTailAlpha?: number;
  consecutiveLossDaysLimit?: number;
  consecutiveLossPctThreshold?: number;
  highVolatilityQuantileCut?: number;
  capitalScaleRules?: CapitalScaleRule[];
}

export interface RiskCheckContext {
  dailyLossPct?: number;
  cvarDailyLossPct?: number;
  consecutiveLossDays?: number;
  consecutiveLossPct?: number;
  volatilityQuantile?: number;
  capitalRampStage?: string;
}

export interface RiskCheckResult {
  approved: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

interface EffectiveRiskLimits {
  maxOpenPositions: number;
  maxLeverage: number;
  maxOrderUsd: number;
  maxPositionPctOfEquity: number;
  capitalRampStage?: string;
  highVolatilityClampActive: boolean;
}

function resolveCapitalScaleRule(
  riskConfig: RiskConfig,
  context?: RiskCheckContext
): CapitalScaleRule | undefined {
  const rules = riskConfig.capitalScaleRules;
  const stage = context?.capitalRampStage?.trim();
  if (!rules || rules.length === 0 || !stage) {
    return undefined;
  }
  const normalizedStage = stage.toLowerCase();
  return rules.find(
    rule => rule.stage.trim().toLowerCase() === normalizedStage
  );
}

function resolveEffectiveLimits(
  riskConfig: RiskConfig,
  context?: RiskCheckContext
): EffectiveRiskLimits {
  const matchedScaleRule = resolveCapitalScaleRule(riskConfig, context);

  let maxLeverage = matchedScaleRule?.maxLeverage ?? riskConfig.maxLeverage;

  const highVolatilityClampActive =
    typeof riskConfig.highVolatilityQuantileCut === "number" &&
    typeof context?.volatilityQuantile === "number" &&
    context.volatilityQuantile >= riskConfig.highVolatilityQuantileCut;

  if (highVolatilityClampActive) {
    const highVolatilityMaxLeverage =
      matchedScaleRule?.highVolatilityMaxLeverage ?? 1;
    maxLeverage = Math.min(maxLeverage, highVolatilityMaxLeverage);
  }

  return {
    maxOpenPositions:
      matchedScaleRule?.maxOpenPositions ?? riskConfig.maxOpenPositions,
    maxLeverage,
    maxOrderUsd: matchedScaleRule?.maxOrderUsd ?? riskConfig.maxOrderUsd,
    maxPositionPctOfEquity:
      matchedScaleRule?.maxPositionPctOfEquity ??
      riskConfig.maxPositionPctOfEquity,
    capitalRampStage: matchedScaleRule?.stage,
    highVolatilityClampActive,
  };
}

function estimateOrderNotionalUsd(
  order: CryptoPlaceOrderRequest,
  existingPosition: CryptoPosition | undefined
): number | null {
  if (typeof order.usd_size === "number" && order.usd_size > 0) {
    return order.usd_size;
  }
  if (
    typeof order.size === "number" &&
    order.size > 0 &&
    typeof order.price === "number" &&
    order.price > 0
  ) {
    return order.size * order.price;
  }
  if (
    typeof order.size === "number" &&
    order.size > 0 &&
    typeof existingPosition?.markPrice === "number" &&
    existingPosition.markPrice > 0
  ) {
    return order.size * existingPosition.markPrice;
  }
  return null;
}

export async function preTradeRiskCheck(
  engine: ICryptoTradingEngine,
  order: CryptoPlaceOrderRequest,
  riskConfig: RiskConfig | undefined,
  context?: RiskCheckContext
): Promise<RiskCheckResult> {
  if (!riskConfig || !riskConfig.enabled) {
    return { approved: true };
  }

  const effectiveLimits = resolveEffectiveLimits(riskConfig, context);

  if (riskConfig.killSwitch && !order.reduceOnly) {
    return {
      approved: false,
      reason: "Kill switch is ON; only reduce-only operations are allowed.",
    };
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
    };
  }

  const [positions, account] = await Promise.all([
    engine.getPositions(),
    engine.getAccount(),
  ]);
  const existing = positions.find(p => p.symbol === order.symbol);

  const isNewOpen = !order.reduceOnly && !existing;

  if (
    isNewOpen &&
    (riskConfig.enforceRealizedPnlConfidence ?? true)
  ) {
    const minConfidence = riskConfig.minRealizedPnlConfidence ?? 0.7;
    const trustedSources = riskConfig.trustedRealizedPnlSources ?? [
      "balance_payload",
      "closed_trades_ledger",
    ];
    const source = account.realizedPnlSource ?? "derived_fallback";
    const confidence =
      typeof account.realizedPnlConfidence === "number"
        ? account.realizedPnlConfidence
        : 0;
    const sourceTrusted = trustedSources.includes(
      source as "balance_payload" | "closed_trades_ledger"
    );
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
      };
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
    };
  }

  if (account.realizedPnL <= -riskConfig.maxDailyLossUsd) {
    return {
      approved: false,
      reason: `Current realized PnL ${account.realizedPnL.toFixed(2)} breached maxDailyLossUsd -${riskConfig.maxDailyLossUsd}.`,
      details: {
        realizedPnL: account.realizedPnL,
        totalPnL: account.totalPnL,
        maxDailyLossUsd: riskConfig.maxDailyLossUsd,
      },
    };
  }

  if (
    isNewOpen &&
    typeof riskConfig.dailyLossPctSoftCap === "number" &&
    typeof context?.dailyLossPct === "number" &&
    context.dailyLossPct <= riskConfig.dailyLossPctSoftCap
  ) {
    return {
      approved: false,
      reason: `Current daily loss ${context.dailyLossPct.toFixed(2)}% breached dailyLossPctSoftCap ${riskConfig.dailyLossPctSoftCap}%; new opens are blocked.`,
      details: {
        dailyLossPct: context.dailyLossPct,
        dailyLossPctSoftCap: riskConfig.dailyLossPctSoftCap,
      },
    };
  }

  if (
    isNewOpen &&
    typeof riskConfig.cvarLossPctSoftCap === "number" &&
    typeof context?.cvarDailyLossPct === "number" &&
    context.cvarDailyLossPct <= riskConfig.cvarLossPctSoftCap
  ) {
    return {
      approved: false,
      reason: `Tail risk CVaR ${context.cvarDailyLossPct.toFixed(2)}% breached cvarLossPctSoftCap ${riskConfig.cvarLossPctSoftCap}%; new opens are blocked.`,
      details: {
        cvarDailyLossPct: context.cvarDailyLossPct,
        cvarLossPctSoftCap: riskConfig.cvarLossPctSoftCap,
      },
    };
  }

  if (
    isNewOpen &&
    typeof riskConfig.consecutiveLossDaysLimit === "number" &&
    typeof riskConfig.consecutiveLossPctThreshold === "number" &&
    typeof context?.consecutiveLossDays === "number" &&
    typeof context?.consecutiveLossPct === "number" &&
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
    };
  }

  const orderNotional = estimateOrderNotionalUsd(order, existing);
  if (orderNotional !== null && orderNotional > effectiveLimits.maxOrderUsd) {
    return {
      approved: false,
      reason: `Order notional $${orderNotional.toFixed(2)} exceeds maxOrderUsd $${effectiveLimits.maxOrderUsd}.`,
      details: {
        orderNotional,
        maxOrderUsd: effectiveLimits.maxOrderUsd,
        capitalRampStage: effectiveLimits.capitalRampStage,
      },
    };
  }

  if (orderNotional !== null && account.equity > 0) {
    const existingNotional = existing?.positionValue ?? 0;
    const projectedNotional = order.reduceOnly
      ? Math.max(0, existingNotional - orderNotional)
      : existingNotional + orderNotional;
    const projectedPct = (projectedNotional / account.equity) * 100;
    if (projectedPct > effectiveLimits.maxPositionPctOfEquity) {
      return {
        approved: false,
        reason: `Projected position size ${projectedPct.toFixed(1)}% exceeds maxPositionPctOfEquity ${effectiveLimits.maxPositionPctOfEquity}%.`,
        details: {
          projectedNotional,
          equity: account.equity,
          projectedPct,
          maxPositionPctOfEquity: effectiveLimits.maxPositionPctOfEquity,
          capitalRampStage: effectiveLimits.capitalRampStage,
        },
      };
    }
  }

  return { approved: true };
}
