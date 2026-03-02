export interface InverseVolAllocatorConfig {
  annualizationFactor?: number;
  minVolatility?: number;
  correlationThreshold?: number;
  maxPairCombinedWeight?: number;
  correlationPasses?: number;
  targetAnnualVolatility?: number;
  leverageCap?: number;
}

export interface AllocationResult {
  normalizedWeights: Record<string, number>;
  scaledWeights: Record<string, number>;
  annualizedAssetVolatility: Record<string, number>;
  predictedAnnualVolatility: number;
  leverage: number;
  grossExposure: number;
  concentrationAdjusted: boolean;
}

const DEFAULT_CONFIG: Required<Omit<InverseVolAllocatorConfig, "targetAnnualVolatility">> = {
  annualizationFactor: 365,
  minVolatility: 1e-8,
  correlationThreshold: 0.8,
  maxPairCombinedWeight: 0.6,
  correlationPasses: 3,
  leverageCap: 3,
};

export function allocateInverseVolatilityPortfolio(
  returnsByAsset: Record<string, number[]>,
  config: InverseVolAllocatorConfig = {},
): AllocationResult {
  const assetNames = Object.keys(returnsByAsset);
  if (assetNames.length < 2) {
    throw new Error("At least 2 assets are required for allocation.");
  }

  const annualizationFactor = positiveNumber(
    config.annualizationFactor ?? DEFAULT_CONFIG.annualizationFactor,
    "annualizationFactor",
  );
  const minVolatility = positiveNumber(
    config.minVolatility ?? DEFAULT_CONFIG.minVolatility,
    "minVolatility",
  );
  const correlationThreshold = boundedNumber(
    config.correlationThreshold ?? DEFAULT_CONFIG.correlationThreshold,
    -1,
    1,
    "correlationThreshold",
  );
  const maxPairCombinedWeight = boundedNumber(
    config.maxPairCombinedWeight ?? DEFAULT_CONFIG.maxPairCombinedWeight,
    0,
    1,
    "maxPairCombinedWeight",
  );
  const correlationPasses = integerAtLeast(
    config.correlationPasses ?? DEFAULT_CONFIG.correlationPasses,
    1,
    "correlationPasses",
  );
  const leverageCap = positiveNumber(
    config.leverageCap ?? DEFAULT_CONFIG.leverageCap,
    "leverageCap",
  );

  const annualizedAssetVolatility: Record<string, number> = {};
  const inverseRisk: Record<string, number> = {};

  for (const asset of assetNames) {
    const returns = validateReturns(returnsByAsset[asset], asset);
    const annualVol = Math.max(computeAnnualizedVolatility(returns, annualizationFactor), minVolatility);
    annualizedAssetVolatility[asset] = annualVol;
    inverseRisk[asset] = 1 / annualVol;
  }

  let normalizedWeights = normalizeWeights(inverseRisk);
  const correlationAdjusted = applyCorrelationConcentrationCap(
    normalizedWeights,
    returnsByAsset,
    correlationThreshold,
    maxPairCombinedWeight,
    correlationPasses,
  );

  normalizedWeights = correlationAdjusted.weights;

  const predictedAnnualVolatility = computePortfolioAnnualizedVolatility(
    returnsByAsset,
    normalizedWeights,
    annualizationFactor,
  );

  const targetAnnualVolatility = config.targetAnnualVolatility;
  let leverage = 1;
  if (typeof targetAnnualVolatility === "number") {
    const target = positiveNumber(targetAnnualVolatility, "targetAnnualVolatility");
    if (predictedAnnualVolatility > 0) {
      leverage = Math.min(leverageCap, target / predictedAnnualVolatility);
    } else {
      leverage = leverageCap;
    }
  }

  const scaledWeights: Record<string, number> = {};
  for (const asset of assetNames) {
    scaledWeights[asset] = normalizedWeights[asset] * leverage;
  }

  const grossExposure = Object.values(scaledWeights).reduce((sum, value) => sum + Math.abs(value), 0);

  return {
    normalizedWeights,
    scaledWeights,
    annualizedAssetVolatility,
    predictedAnnualVolatility,
    leverage,
    grossExposure,
    concentrationAdjusted: correlationAdjusted.adjusted,
  };
}

export function computeAnnualizedVolatility(returns: number[], annualizationFactor = 365): number {
  const clean = validateReturns(returns, "returns");
  if (clean.length < 2) {
    return 0;
  }

  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  const variance = clean.reduce((sum, value) => {
    const centered = value - mean;
    return sum + centered * centered;
  }, 0) / clean.length;

  return Math.sqrt(Math.max(variance, 0)) * Math.sqrt(annualizationFactor);
}

export function computeCorrelation(seriesA: number[], seriesB: number[]): number {
  const n = Math.min(seriesA.length, seriesB.length);
  if (n < 3) {
    return 0;
  }

  const a = seriesA.slice(seriesA.length - n);
  const b = seriesB.slice(seriesB.length - n);

  const meanA = a.reduce((sum, value) => sum + value, 0) / n;
  const meanB = b.reduce((sum, value) => sum + value, 0) / n;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;

  for (let i = 0; i < n; i++) {
    const centeredA = a[i] - meanA;
    const centeredB = b[i] - meanB;
    covariance += centeredA * centeredB;
    varianceA += centeredA * centeredA;
    varianceB += centeredB * centeredB;
  }

  if (varianceA <= 0 || varianceB <= 0) {
    return 0;
  }

  return covariance / Math.sqrt(varianceA * varianceB);
}

export function computePortfolioAnnualizedVolatility(
  returnsByAsset: Record<string, number[]>,
  weights: Record<string, number>,
  annualizationFactor = 365,
): number {
  const names = Object.keys(weights).filter((name) => Math.abs(weights[name]) > 0);
  if (names.length === 0) {
    return 0;
  }

  const minLength = Math.min(...names.map((name) => returnsByAsset[name]?.length ?? 0));
  if (minLength < 2) {
    return 0;
  }

  const aligned: Record<string, number[]> = {};
  for (const name of names) {
    const series = validateReturns(returnsByAsset[name], name);
    aligned[name] = series.slice(series.length - minLength);
  }

  const covarianceMatrix: Record<string, Record<string, number>> = {};
  for (const left of names) {
    covarianceMatrix[left] = {};
    for (const right of names) {
      covarianceMatrix[left][right] = covariance(aligned[left], aligned[right]);
    }
  }

  let variance = 0;
  for (const left of names) {
    for (const right of names) {
      variance += weights[left] * weights[right] * covarianceMatrix[left][right];
    }
  }

  return Math.sqrt(Math.max(variance, 0)) * Math.sqrt(annualizationFactor);
}

function normalizeWeights(rawWeights: Record<string, number>): Record<string, number> {
  const sum = Object.values(rawWeights).reduce((acc, value) => acc + Math.max(0, value), 0);
  if (sum <= 0) {
    throw new Error("Weight normalization failed: non-positive weight sum.");
  }

  const normalized: Record<string, number> = {};
  for (const [asset, value] of Object.entries(rawWeights)) {
    normalized[asset] = Math.max(0, value) / sum;
  }
  return normalized;
}

function applyCorrelationConcentrationCap(
  weights: Record<string, number>,
  returnsByAsset: Record<string, number[]>,
  correlationThreshold: number,
  maxPairCombinedWeight: number,
  passes: number,
): { weights: Record<string, number>; adjusted: boolean } {
  const names = Object.keys(weights);
  const adjusted = { value: false };
  const working: Record<string, number> = { ...weights };

  for (let pass = 0; pass < passes; pass++) {
    let passChanged = false;

    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const left = names[i];
        const right = names[j];
        const corr = computeCorrelation(returnsByAsset[left], returnsByAsset[right]);

        if (corr < correlationThreshold) {
          continue;
        }

        const pairWeight = working[left] + working[right];
        if (pairWeight <= maxPairCombinedWeight || pairWeight <= 0) {
          continue;
        }

        const overflow = pairWeight - maxPairCombinedWeight;
        const leftShare = working[left] / pairWeight;
        const rightShare = working[right] / pairWeight;

        working[left] = Math.max(0, working[left] - overflow * leftShare);
        working[right] = Math.max(0, working[right] - overflow * rightShare);

        const otherNames = names.filter((name) => name !== left && name !== right);
        const otherWeightSum = otherNames.reduce((sum, name) => sum + Math.max(0, working[name]), 0);

        if (otherNames.length > 0) {
          if (otherWeightSum > 0) {
            for (const name of otherNames) {
              const share = working[name] / otherWeightSum;
              working[name] += overflow * share;
            }
          } else {
            const equalBump = overflow / otherNames.length;
            for (const name of otherNames) {
              working[name] += equalBump;
            }
          }
        }

        passChanged = true;
        adjusted.value = true;
      }
    }

    if (!passChanged) {
      break;
    }
  }

  return { weights: normalizeWeights(working), adjusted: adjusted.value };
}

function covariance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) {
    return 0;
  }

  const aa = a.slice(a.length - n);
  const bb = b.slice(b.length - n);
  const meanA = aa.reduce((sum, value) => sum + value, 0) / n;
  const meanB = bb.reduce((sum, value) => sum + value, 0) / n;

  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += (aa[i] - meanA) * (bb[i] - meanB);
  }
  return sum / n;
}

function validateReturns(values: number[] | undefined, label: string): number[] {
  if (!Array.isArray(values) || values.length < 2) {
    throw new Error(`${label} must contain at least 2 returns.`);
  }

  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      throw new Error(`${label} contains non-finite value at index ${i}.`);
    }
  }

  return values;
}

function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return value;
}

function boundedNumber(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

function integerAtLeast(value: number, min: number, label: string): number {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${label} must be an integer >= ${min}.`);
  }
  return value;
}
