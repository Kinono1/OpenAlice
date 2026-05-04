import type { CryptoPosition } from "../extension/crypto-trading/interfaces.js";
import type { Operation } from "../extension/crypto-trading/wallet/types.js";
import type { PortfolioTarget } from "./target.js";

export interface PortfolioRebalancePlannerConfig {
  minTradeNotionalUsd?: number;
}

export interface PortfolioRebalanceEntry {
  symbol: string;
  currentWeight: number;
  targetWeight: number;
  effectiveTargetWeight: number;
  currentNotionalUsd: number;
  targetNotionalUsd: number;
  effectiveTargetNotionalUsd: number;
  deltaNotionalUsd: number;
  turnoverUsd: number;
  scaleApplied: number;
  action:
    | "hold"
    | "open_long"
    | "open_short"
    | "increase_long"
    | "increase_short"
    | "reduce_long"
    | "reduce_short"
    | "close_long"
    | "close_short"
    | "flip_to_long"
    | "flip_to_short";
  operations: Operation[];
}

export interface PortfolioRebalancePlan {
  version: 1;
  generatedAt: string;
  basisEquityUsd: number;
  maxTurnoverUsd: number;
  totalRequestedTurnoverUsd: number;
  totalPlannedTurnoverUsd: number;
  plannedTurnoverPct: number;
  scaleApplied: number;
  entries: PortfolioRebalanceEntry[];
}

export interface PlanPortfolioRebalanceInput {
  target: PortfolioTarget;
  currentPositions: CryptoPosition[];
  pricesBySymbol: Record<string, number>;
  config?: PortfolioRebalancePlannerConfig;
}

export function planPortfolioRebalance(
  input: PlanPortfolioRebalanceInput
): PortfolioRebalancePlan {
  const basisEquityUsd = positiveNumber(
    input.target.basisEquityUsd,
    "target.basisEquityUsd"
  );
  const minTradeNotionalUsd = positiveNumber(
    input.config?.minTradeNotionalUsd ?? 10,
    "minTradeNotionalUsd"
  );
  const maxTurnoverUsd = basisEquityUsd * input.target.maxTurnoverPct;

  const currentBySymbol = new Map(
    input.currentPositions.map(position => [position.symbol, position])
  );
  const targetBySymbol = new Map(
    input.target.positions.map(position => [position.symbol, position])
  );
  const allSymbols = [...new Set([...currentBySymbol.keys(), ...targetBySymbol.keys()])].sort();

  const rawDeltas = allSymbols.map(symbol => {
    const currentPosition = currentBySymbol.get(symbol);
    const currentNotionalUsd = signedCurrentNotional(
      currentPosition,
      input.pricesBySymbol[symbol]
    );
    const targetNotionalUsd =
      targetBySymbol.get(symbol)?.targetNotionalUsd ?? 0;
    return { symbol, currentNotionalUsd, targetNotionalUsd };
  });

  const totalRequestedTurnoverUsd = rawDeltas.reduce(
    (sum, item) => sum + Math.abs(item.targetNotionalUsd - item.currentNotionalUsd),
    0
  );
  const scaleApplied =
    totalRequestedTurnoverUsd > maxTurnoverUsd && totalRequestedTurnoverUsd > 0
      ? maxTurnoverUsd / totalRequestedTurnoverUsd
      : 1;

  const entries = allSymbols.map(symbol => {
    const currentPosition = currentBySymbol.get(symbol);
    const targetPosition = targetBySymbol.get(symbol);
    const price = resolvePrice(
      currentPosition,
      input.pricesBySymbol[symbol],
      targetPosition?.priceHint,
      symbol
    );
    const currentNotionalUsd = signedCurrentNotional(currentPosition, price);
    const targetNotionalUsd = targetPosition?.targetNotionalUsd ?? 0;
    const effectiveTargetNotionalUsd =
      currentNotionalUsd +
      (targetNotionalUsd - currentNotionalUsd) * scaleApplied;
    const deltaNotionalUsd = effectiveTargetNotionalUsd - currentNotionalUsd;
    const turnoverUsd = Math.abs(deltaNotionalUsd);

    return buildEntry({
      symbol,
      price,
      basisEquityUsd,
      currentPosition,
      currentNotionalUsd,
      targetWeight: targetPosition?.targetWeight ?? 0,
      targetNotionalUsd,
      effectiveTargetNotionalUsd,
      scaleApplied,
      minTradeNotionalUsd,
    });
  });

  const totalPlannedTurnoverUsd = entries.reduce(
    (sum, entry) => sum + entry.turnoverUsd,
    0
  );

  return {
    version: 1,
    generatedAt: input.target.generatedAt,
    basisEquityUsd,
    maxTurnoverUsd,
    totalRequestedTurnoverUsd,
    totalPlannedTurnoverUsd,
    plannedTurnoverPct: totalPlannedTurnoverUsd / basisEquityUsd,
    scaleApplied,
    entries,
  };
}

interface BuildEntryInput {
  symbol: string;
  price: number;
  basisEquityUsd: number;
  currentPosition?: CryptoPosition;
  currentNotionalUsd: number;
  targetWeight: number;
  targetNotionalUsd: number;
  effectiveTargetNotionalUsd: number;
  scaleApplied: number;
  minTradeNotionalUsd: number;
}

function buildEntry(input: BuildEntryInput): PortfolioRebalanceEntry {
  const deltaNotionalUsd =
    input.effectiveTargetNotionalUsd - input.currentNotionalUsd;
  const turnoverUsd = Math.abs(deltaNotionalUsd);
  const currentWeight = input.currentNotionalUsd / input.basisEquityUsd;
  const effectiveTargetWeight =
    input.effectiveTargetNotionalUsd / input.basisEquityUsd;
  const operations: Operation[] = [];

  if (turnoverUsd < input.minTradeNotionalUsd) {
    return {
      symbol: input.symbol,
      currentWeight,
      targetWeight: input.targetWeight,
      effectiveTargetWeight,
      currentNotionalUsd: input.currentNotionalUsd,
      targetNotionalUsd: input.targetNotionalUsd,
      effectiveTargetNotionalUsd: input.effectiveTargetNotionalUsd,
      deltaNotionalUsd,
      turnoverUsd: 0,
      scaleApplied: input.scaleApplied,
      action: "hold",
      operations,
    };
  }

  const currentSign = sign(input.currentNotionalUsd);
  const targetSign = sign(input.effectiveTargetNotionalUsd);

  if (currentSign === 0) {
    operations.push({
      action: "placeOrder",
      params: {
        symbol: input.symbol,
        side: targetSign > 0 ? "buy" : "sell",
        type: "market",
        usd_size: Math.abs(input.effectiveTargetNotionalUsd),
      },
    });
    return {
      symbol: input.symbol,
      currentWeight,
      targetWeight: input.targetWeight,
      effectiveTargetWeight,
      currentNotionalUsd: input.currentNotionalUsd,
      targetNotionalUsd: input.targetNotionalUsd,
      effectiveTargetNotionalUsd: input.effectiveTargetNotionalUsd,
      deltaNotionalUsd,
      turnoverUsd,
      scaleApplied: input.scaleApplied,
      action: targetSign > 0 ? "open_long" : "open_short",
      operations,
    };
  }

  if (targetSign === 0) {
    operations.push({
      action: "closePosition",
      params: {
        symbol: input.symbol,
        size: resolveCloseSize(currentSign, input, Math.abs(input.currentNotionalUsd)),
      },
    });
    return {
      symbol: input.symbol,
      currentWeight,
      targetWeight: input.targetWeight,
      effectiveTargetWeight,
      currentNotionalUsd: input.currentNotionalUsd,
      targetNotionalUsd: input.targetNotionalUsd,
      effectiveTargetNotionalUsd: input.effectiveTargetNotionalUsd,
      deltaNotionalUsd,
      turnoverUsd,
      scaleApplied: input.scaleApplied,
      action: currentSign > 0 ? "close_long" : "close_short",
      operations,
    };
  }

  if (currentSign !== targetSign) {
    operations.push({
      action: "closePosition",
      params: {
        symbol: input.symbol,
        size: resolveCloseSize(currentSign, input, Math.abs(input.currentNotionalUsd)),
      },
    });
    operations.push({
      action: "placeOrder",
      params: {
        symbol: input.symbol,
        side: targetSign > 0 ? "buy" : "sell",
        type: "market",
        usd_size: Math.abs(input.effectiveTargetNotionalUsd),
      },
    });
    return {
      symbol: input.symbol,
      currentWeight,
      targetWeight: input.targetWeight,
      effectiveTargetWeight,
      currentNotionalUsd: input.currentNotionalUsd,
      targetNotionalUsd: input.targetNotionalUsd,
      effectiveTargetNotionalUsd: input.effectiveTargetNotionalUsd,
      deltaNotionalUsd,
      turnoverUsd,
      scaleApplied: input.scaleApplied,
      action: targetSign > 0 ? "flip_to_long" : "flip_to_short",
      operations,
    };
  }

  if (Math.abs(input.effectiveTargetNotionalUsd) > Math.abs(input.currentNotionalUsd)) {
    operations.push({
      action: "placeOrder",
      params: {
        symbol: input.symbol,
        side: targetSign > 0 ? "buy" : "sell",
        type: "market",
        usd_size:
          Math.abs(input.effectiveTargetNotionalUsd) -
          Math.abs(input.currentNotionalUsd),
      },
    });
    return {
      symbol: input.symbol,
      currentWeight,
      targetWeight: input.targetWeight,
      effectiveTargetWeight,
      currentNotionalUsd: input.currentNotionalUsd,
      targetNotionalUsd: input.targetNotionalUsd,
      effectiveTargetNotionalUsd: input.effectiveTargetNotionalUsd,
      deltaNotionalUsd,
      turnoverUsd,
      scaleApplied: input.scaleApplied,
      action: targetSign > 0 ? "increase_long" : "increase_short",
      operations,
    };
  }

  operations.push({
    action: "closePosition",
    params: {
      symbol: input.symbol,
      size: resolveCloseSize(
        currentSign,
        input,
        Math.abs(input.currentNotionalUsd) -
          Math.abs(input.effectiveTargetNotionalUsd)
      ),
    },
  });
  return {
    symbol: input.symbol,
    currentWeight,
    targetWeight: input.targetWeight,
    effectiveTargetWeight,
    currentNotionalUsd: input.currentNotionalUsd,
    targetNotionalUsd: input.targetNotionalUsd,
    effectiveTargetNotionalUsd: input.effectiveTargetNotionalUsd,
    deltaNotionalUsd,
    turnoverUsd,
    scaleApplied: input.scaleApplied,
    action: currentSign > 0 ? "reduce_long" : "reduce_short",
    operations,
  };
}

function resolveCloseSize(
  currentSign: number,
  input: BuildEntryInput,
  notionalToCloseUsd: number
): number {
  if (input.currentPosition && input.currentPosition.size > 0) {
    const fullNotionalUsd = Math.abs(input.currentNotionalUsd);
    if (fullNotionalUsd > 0) {
      return Math.min(
        input.currentPosition.size,
        (notionalToCloseUsd / fullNotionalUsd) * input.currentPosition.size
      );
    }
    return input.currentPosition.size;
  }

  const size = notionalToCloseUsd / input.price;
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(
      `Unable to derive close size for ${input.symbol} (${currentSign}).`
    );
  }
  return size;
}

function signedCurrentNotional(
  position: CryptoPosition | undefined,
  fallbackPrice?: number
): number {
  if (!position) {
    return 0;
  }

  const rawNotional =
    position.positionValue > 0
      ? position.positionValue
      : position.size * resolvePrice(position, fallbackPrice, undefined, position.symbol);
  return position.side === "long" ? rawNotional : -rawNotional;
}

function resolvePrice(
  position: CryptoPosition | undefined,
  priceFromMap: number | undefined,
  priceHint: number | undefined,
  symbol: string
): number {
  const candidates = [position?.markPrice, priceFromMap, priceHint];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  throw new Error(`Missing usable price for ${symbol}.`);
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
  return value;
}

function sign(value: number): number {
  if (Math.abs(value) < 1e-9) {
    return 0;
  }
  return value > 0 ? 1 : -1;
}
