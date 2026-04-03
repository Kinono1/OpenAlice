import type { AllocationResult, InverseVolAllocatorConfig } from "./allocator.js";
import { allocateInverseVolatilityPortfolio } from "./allocator.js";

export interface PortfolioTargetPosition {
  symbol: string;
  targetWeight: number;
  targetNotionalUsd: number;
  confidence?: number;
  sizingReason?: string;
  regimeTag?: string;
  priceHint?: number;
}

export interface PortfolioTarget {
  version: 1;
  generatedAt: string;
  basisEquityUsd: number;
  targetGrossExposure: number;
  targetNetExposure: number;
  maxTurnoverPct: number;
  positions: PortfolioTargetPosition[];
  notes?: string[];
}

export interface BuildPortfolioTargetFromWeightsInput {
  basisEquityUsd: number;
  weights: Record<string, number>;
  generatedAt?: string;
  maxTurnoverPct?: number;
  confidenceBySymbol?: Record<string, number>;
  sizingReasonBySymbol?: Record<string, string>;
  regimeTagBySymbol?: Record<string, string>;
  priceHintsBySymbol?: Record<string, number>;
  notes?: string[];
}

export interface BuildInverseVolatilityPortfolioTargetInput {
  basisEquityUsd: number;
  returnsByAsset: Record<string, number[]>;
  allocatorConfig?: InverseVolAllocatorConfig;
  generatedAt?: string;
  maxTurnoverPct?: number;
  confidenceBySymbol?: Record<string, number>;
  sizingReasonBySymbol?: Record<string, string>;
  regimeTagBySymbol?: Record<string, string>;
  priceHintsBySymbol?: Record<string, number>;
  notes?: string[];
}

export interface InverseVolatilityPortfolioTargetResult {
  allocation: AllocationResult;
  target: PortfolioTarget;
}

export function buildPortfolioTargetFromWeights(
  input: BuildPortfolioTargetFromWeightsInput
): PortfolioTarget {
  const basisEquityUsd = positiveNumber(input.basisEquityUsd, "basisEquityUsd");
  const maxTurnoverPct = positiveNumber(
    input.maxTurnoverPct ?? 1,
    "maxTurnoverPct"
  );

  const positions = Object.entries(input.weights)
    .map(([symbol, targetWeight]) => {
      if (!symbol.trim()) {
        throw new Error("Portfolio target symbols must be non-empty.");
      }
      if (!Number.isFinite(targetWeight)) {
        throw new Error(`Portfolio target weight for ${symbol} must be finite.`);
      }

      const target: PortfolioTargetPosition = {
        symbol,
        targetWeight,
        targetNotionalUsd: targetWeight * basisEquityUsd,
      };

      const confidence = input.confidenceBySymbol?.[symbol];
      if (isFiniteNumber(confidence)) {
        target.confidence = confidence;
      }

      const sizingReason = input.sizingReasonBySymbol?.[symbol];
      if (typeof sizingReason === "string" && sizingReason.trim()) {
        target.sizingReason = sizingReason.trim();
      }

      const regimeTag = input.regimeTagBySymbol?.[symbol];
      if (typeof regimeTag === "string" && regimeTag.trim()) {
        target.regimeTag = regimeTag.trim();
      }

      const priceHint = input.priceHintsBySymbol?.[symbol];
      if (isFiniteNumber(priceHint) && priceHint > 0) {
        target.priceHint = priceHint;
      }

      return target;
    })
    .sort((left, right) => left.symbol.localeCompare(right.symbol));

  return {
    version: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    basisEquityUsd,
    targetGrossExposure: sumAbs(positions.map(position => position.targetWeight)),
    targetNetExposure: positions.reduce(
      (sum, position) => sum + position.targetWeight,
      0
    ),
    maxTurnoverPct,
    positions,
    notes:
      input.notes && input.notes.length > 0 ? [...input.notes] : undefined,
  };
}

export function buildInverseVolatilityPortfolioTarget(
  input: BuildInverseVolatilityPortfolioTargetInput
): InverseVolatilityPortfolioTargetResult {
  const allocation = allocateInverseVolatilityPortfolio(
    input.returnsByAsset,
    input.allocatorConfig
  );

  return {
    allocation,
    target: buildPortfolioTargetFromWeights({
      basisEquityUsd: input.basisEquityUsd,
      weights: allocation.scaledWeights,
      generatedAt: input.generatedAt,
      maxTurnoverPct: input.maxTurnoverPct,
      confidenceBySymbol: input.confidenceBySymbol,
      sizingReasonBySymbol: input.sizingReasonBySymbol,
      regimeTagBySymbol: input.regimeTagBySymbol,
      priceHintsBySymbol: input.priceHintsBySymbol,
      notes: input.notes,
    }),
  };
}

function sumAbs(values: number[]): number {
  return values.reduce((sum, value) => sum + Math.abs(value), 0);
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
  return value;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
