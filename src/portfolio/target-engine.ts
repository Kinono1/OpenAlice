import { computeAnnualizedVolatility, computeCorrelation } from "./allocator.js";

export interface PortfolioTargetSignal {
  symbol: string;
  conviction: number;
  currentWeight?: number;
}

export type PortfolioSignalInput = PortfolioTargetSignal;

export interface PortfolioTargetConfig {
  grossExposureCap?: number;
  perSymbolCap?: number;
  turnoverBudget?: number;
  correlationThreshold?: number;
  correlatedPairCap?: number;
  annualizationFactor?: number;
}

export interface PortfolioTargetArtifact {
  schemaVersion: "portfolio_target.v1";
  generatedAt: string;
  targetWeights: Record<string, number>;
  grossExposure: number;
  netExposure: number;
  turnoverUsed: number;
  reasonCodes: string[];
}

const DEFAULT_CONFIG: Required<PortfolioTargetConfig> = {
  grossExposureCap: 1,
  perSymbolCap: 0.4,
  turnoverBudget: 0.5,
  correlationThreshold: 0.8,
  correlatedPairCap: 0.6,
  annualizationFactor: 365,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function shrinkForCorrelation(
  weights: Record<string, number>,
  returnsByAsset: Record<string, number[]> | undefined,
  correlationThreshold: number,
  pairCap: number,
): boolean {
  if (!returnsByAsset) return false;
  let adjusted = false;
  const names = Object.keys(weights).filter(
    (name) =>
      Array.isArray(returnsByAsset[name]) && returnsByAsset[name].length >= 3,
  );
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const left = names[i];
      const right = names[j];
      const corr = Math.abs(
        computeCorrelation(returnsByAsset[left], returnsByAsset[right]),
      );
      const combined =
        Math.abs(weights[left] ?? 0) + Math.abs(weights[right] ?? 0);
      if (corr >= correlationThreshold && combined > pairCap) {
        const scale = pairCap / combined;
        weights[left] *= scale;
        weights[right] *= scale;
        adjusted = true;
      }
    }
  }
  return adjusted;
}

export function buildCorrelationMatrix(
  returnsByAsset: Record<string, number[]>,
): Record<string, Record<string, number>> {
  const names = Object.keys(returnsByAsset);
  const out: Record<string, Record<string, number>> = {};
  for (const left of names) {
    out[left] = {};
    for (const right of names) {
      out[left][right] =
        left === right
          ? 1
          : computeCorrelation(returnsByAsset[left], returnsByAsset[right]);
    }
  }
  return out;
}

export function buildPortfolioTarget(input: {
  signals: PortfolioTargetSignal[];
  returnsByAsset?: Record<string, number[]>;
  generatedAt?: string;
  config?: PortfolioTargetConfig;
}): PortfolioTargetArtifact {
  const config = { ...DEFAULT_CONFIG, ...(input.config ?? {}) };
  const reasonCodes: string[] = [];
  const raw: Record<string, number> = {};

  for (const signal of input.signals) {
    const conviction = clamp(signal.conviction, -1, 1);
    if (conviction === 0) continue;
    const annualizedVolatility = input.returnsByAsset?.[signal.symbol]
      ? computeAnnualizedVolatility(
          input.returnsByAsset[signal.symbol],
          config.annualizationFactor,
        )
      : 1;
    raw[signal.symbol] = conviction / Math.max(annualizedVolatility, 1e-6);
  }

  const denominator =
    Object.values(raw).reduce((sum, value) => sum + Math.abs(value), 0) || 1;
  const targetWeights: Record<string, number> = {};
  for (const [symbol, value] of Object.entries(raw)) {
    targetWeights[symbol] = clamp(
      (value / denominator) * config.grossExposureCap,
      -config.perSymbolCap,
      config.perSymbolCap,
    );
  }

  if (
    shrinkForCorrelation(
      targetWeights,
      input.returnsByAsset,
      config.correlationThreshold,
      config.correlatedPairCap,
    )
  ) {
    reasonCodes.push("correlation_shrink_applied");
  }

  const grossExposure = Object.values(targetWeights).reduce(
    (sum, value) => sum + Math.abs(value),
    0,
  );
  if (grossExposure > config.grossExposureCap) {
    const scale = config.grossExposureCap / grossExposure;
    for (const key of Object.keys(targetWeights)) {
      targetWeights[key] *= scale;
    }
    reasonCodes.push("gross_exposure_cap_applied");
  }

  const currentWeights = Object.fromEntries(
    input.signals.map((signal) => [signal.symbol, signal.currentWeight ?? 0]),
  );
  const rawTurnover = Object.keys({
    ...currentWeights,
    ...targetWeights,
  }).reduce(
    (sum, symbol) =>
      sum +
      Math.abs((targetWeights[symbol] ?? 0) - (currentWeights[symbol] ?? 0)),
    0,
  );
  if (rawTurnover > config.turnoverBudget && rawTurnover > 0) {
    const scale = config.turnoverBudget / rawTurnover;
    for (const symbol of Object.keys(targetWeights)) {
      const current = currentWeights[symbol] ?? 0;
      targetWeights[symbol] =
        current + (targetWeights[symbol] - current) * scale;
    }
    reasonCodes.push("turnover_budget_applied");
  }

  const turnoverUsed = Object.keys({
    ...currentWeights,
    ...targetWeights,
  }).reduce(
    (sum, symbol) =>
      sum +
      Math.abs((targetWeights[symbol] ?? 0) - (currentWeights[symbol] ?? 0)),
    0,
  );
  const finalGross = Object.values(targetWeights).reduce(
    (sum, value) => sum + Math.abs(value),
    0,
  );
  const netExposure = Object.values(targetWeights).reduce(
    (sum, value) => sum + value,
    0,
  );

  return {
    schemaVersion: "portfolio_target.v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    targetWeights: Object.fromEntries(
      Object.entries(targetWeights).map(([key, value]) => [key, round(value)]),
    ),
    grossExposure: round(finalGross),
    netExposure: round(netExposure),
    turnoverUsed: round(turnoverUsed),
    reasonCodes,
  };
}
