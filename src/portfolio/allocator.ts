export { computeHCAWeights } from './hca.js'
export { computeBlackLitterman, factorSignalsToBLViews } from './black-litterman.js'
import { computeHCAWeights } from './hca.js'
import { computeBlackLitterman, factorSignalsToBLViews } from './black-litterman.js'

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

export interface SignedRiskAllocatorConfig {
  annualizationFactor?: number;
  minVolatility?: number;
  minAbsAlpha?: number;
  targetGrossExposure?: number;
  maxNetExposure?: number;
  targetAnnualVolatility?: number;
  leverageCap?: number;
}

export interface SignedRiskAllocationResult {
  signedWeights: Record<string, number>;
  annualizedAssetVolatility: Record<string, number>;
  predictedAnnualVolatility: number;
  leverage: number;
  grossExposure: number;
  netExposure: number;
  netExposureAdjusted: boolean;
  allocationMode: "signed_risk_constrained";
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

/**
 * Signed long/short allocator for alpha-bearing portfolios.
 *
 * Inverse-vol / HRP style allocators are long-only risk budget tools. They
 * should not be post-hoc tilted with signed alpha, because that breaks the
 * risk-budget math. This allocator starts from signed alpha scores directly,
 * sizes by alpha / volatility, and then applies gross/net exposure constraints.
 */
export function allocateSignedRiskConstrainedPortfolio(
  returnsByAsset: Record<string, number[]>,
  alphaScores: Record<string, number>,
  config: SignedRiskAllocatorConfig = {},
): SignedRiskAllocationResult {
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
  const minAbsAlpha = Math.max(0, config.minAbsAlpha ?? 0);
  const targetGrossExposure = positiveNumber(
    config.targetGrossExposure ?? 1,
    "targetGrossExposure",
  );
  const maxNetExposure = boundedNumber(
    config.maxNetExposure ?? targetGrossExposure,
    0,
    targetGrossExposure,
    "maxNetExposure",
  );
  const leverageCap = positiveNumber(
    config.leverageCap ?? DEFAULT_CONFIG.leverageCap,
    "leverageCap",
  );

  const annualizedAssetVolatility: Record<string, number> = {};
  const rawSignedRisk: Record<string, number> = {};

  for (const asset of assetNames) {
    const alpha = alphaScores[asset] ?? 0;
    if (!Number.isFinite(alpha)) {
      throw new Error(`alphaScores.${asset} must be finite.`);
    }
    const returns = validateReturns(returnsByAsset[asset], asset);
    const annualVol = Math.max(computeAnnualizedVolatility(returns, annualizationFactor), minVolatility);
    annualizedAssetVolatility[asset] = annualVol;
    rawSignedRisk[asset] = Math.abs(alpha) >= minAbsAlpha ? alpha / annualVol : 0;
  }

  let signedWeights = normalizeSignedGross(rawSignedRisk, targetGrossExposure);
  const netAdjusted = applyNetExposureCap(signedWeights, maxNetExposure);
  signedWeights = netAdjusted.weights;

  const unleveredPredictedVol = computePortfolioAnnualizedVolatility(
    returnsByAsset,
    signedWeights,
    annualizationFactor,
  );

  let leverage = 1;
  if (typeof config.targetAnnualVolatility === "number") {
    const target = positiveNumber(config.targetAnnualVolatility, "targetAnnualVolatility");
    leverage = unleveredPredictedVol > 0
      ? Math.min(leverageCap, target / unleveredPredictedVol)
      : leverageCap;
  }

  signedWeights = Object.fromEntries(
    Object.entries(signedWeights).map(([asset, weight]) => [asset, weight * leverage]),
  );
  const grossExposure = Object.values(signedWeights).reduce((sum, value) => sum + Math.abs(value), 0);
  const netExposure = Object.values(signedWeights).reduce((sum, value) => sum + value, 0);

  return {
    signedWeights,
    annualizedAssetVolatility,
    predictedAnnualVolatility: computePortfolioAnnualizedVolatility(
      returnsByAsset,
      signedWeights,
      annualizationFactor,
    ),
    leverage,
    grossExposure,
    netExposure,
    netExposureAdjusted: netAdjusted.adjusted,
    allocationMode: "signed_risk_constrained",
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

function normalizeSignedGross(
  rawWeights: Record<string, number>,
  targetGrossExposure: number,
): Record<string, number> {
  const gross = Object.values(rawWeights).reduce((sum, value) => sum + Math.abs(value), 0);
  if (gross <= 0) {
    throw new Error("Signed weight normalization failed: zero gross alpha.");
  }
  return Object.fromEntries(
    Object.entries(rawWeights).map(([asset, value]) => [
      asset,
      (value / gross) * targetGrossExposure,
    ]),
  );
}

function applyNetExposureCap(
  weights: Record<string, number>,
  maxNetExposure: number,
): { weights: Record<string, number>; adjusted: boolean } {
  const net = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (Math.abs(net) <= maxNetExposure) {
    return { weights: { ...weights }, adjusted: false };
  }

  const signToReduce = net > 0 ? 1 : -1;
  const excess = Math.abs(net) - maxNetExposure;
  const sameSignAssets = Object.entries(weights).filter(([, weight]) => Math.sign(weight) === signToReduce);
  const sameSignGross = sameSignAssets.reduce((sum, [, weight]) => sum + Math.abs(weight), 0);
  if (sameSignGross <= 0) {
    return { weights: { ...weights }, adjusted: false };
  }

  const adjusted = { ...weights };
  for (const [asset, weight] of sameSignAssets) {
    const reduction = excess * (Math.abs(weight) / sameSignGross);
    adjusted[asset] = weight - signToReduce * reduction;
  }
  return { weights: adjusted, adjusted: true };
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

export interface HCABLAllocatorConfig {
  annualizationFactor?: number
  leverageCap?: number
  targetAnnualVolatility?: number
  /** BL tau: uncertainty of prior (default 0.05) */
  tau?: number
  /** BL risk aversion δ (default 2.5) */
  riskAversion?: number
}

export interface HCABLAllocationResult {
  /** HCA risk-budget weights (long-only, sum=1) */
  hcaWeights: Record<string, number>
  /** BL posterior expected returns */
  blReturns: Record<string, number>
  /** Final tilted weights after BL adjustment, scaled by leverage */
  finalWeights: Record<string, number>
  leverage: number
  grossExposure: number
  allocationMode: 'hca_bl'
}

/**
 * HCA-BL allocator: hierarchical risk-budget base + Black-Litterman tilt.
 *
 * 1. HCA computes correlation-stable risk-budget weights (long-only)
 * 2. BL posterior tilts those weights toward assets with strong factor signals
 * 3. Leverage is applied to hit target volatility
 *
 * @param returnsByAsset - historical return series per asset
 * @param factorSignals - tStat + confidence per asset from the factor ensemble
 */
export function allocateHCABL(
  returnsByAsset: Record<string, number[]>,
  factorSignals: Record<string, { tStat: number; confidence: number; annualizedReturn?: number }>,
  config: HCABLAllocatorConfig = {},
): HCABLAllocationResult {
  const assets = Object.keys(returnsByAsset)
  if (assets.length < 2) throw new Error('At least 2 assets required for HCA-BL allocation.')

  const annualizationFactor = config.annualizationFactor ?? 365
  const leverageCap = config.leverageCap ?? 3
  const tau = config.tau ?? 0.05
  const riskAversion = config.riskAversion ?? 2.5

  // Step 1: HCA risk-budget weights
  const { weights: hcaWeights } = computeHCAWeights(returnsByAsset)

  // Step 2: Build covariance matrix (diagonal approximation for BL)
  const covMatrix: number[][] = assets.map((a, i) =>
    assets.map((b, j) => {
      if (i !== j) return 0
      const r = returnsByAsset[a]!
      const mean = r.reduce((s, v) => s + v, 0) / r.length
      const variance = r.reduce((s, v) => s + (v - mean) ** 2, 0) / r.length
      return variance * annualizationFactor
    })
  )

  // Step 3: BL views from factor signals
  const views = factorSignalsToBLViews(factorSignals)
  const mktWeights = assets.map(a => hcaWeights[a] ?? 1 / assets.length)
  const { posteriorReturns } = computeBlackLitterman(assets, covMatrix, mktWeights, views, tau, riskAversion)

  // Step 4: Tilt HCA weights by BL posterior returns (proportional to positive return)
  const tiltedRaw: Record<string, number> = {}
  for (const a of assets) {
    const blRet = posteriorReturns[a] ?? 0
    const hcaW = hcaWeights[a] ?? 0
    // Tilt: multiply HCA weight by (1 + clamp(blRet, -0.5, 0.5))
    tiltedRaw[a] = hcaW * (1 + Math.max(-0.5, Math.min(0.5, blRet)))
  }

  // Renormalize to sum = 1
  const totalTilted = Object.values(tiltedRaw).reduce((s, v) => s + Math.abs(v), 0)
  const normalizedWeights: Record<string, number> = {}
  for (const a of assets) {
    normalizedWeights[a] = totalTilted > 0 ? (tiltedRaw[a] ?? 0) / totalTilted : 1 / assets.length
  }

  // Step 5: Leverage to hit target vol
  let leverage = 1
  if (typeof config.targetAnnualVolatility === 'number' && config.targetAnnualVolatility > 0) {
    const portVol = computePortfolioAnnualizedVolatility(returnsByAsset, normalizedWeights, annualizationFactor)
    if (portVol > 0) leverage = Math.min(leverageCap, config.targetAnnualVolatility / portVol)
  }

  const finalWeights: Record<string, number> = {}
  for (const a of assets) finalWeights[a] = (normalizedWeights[a] ?? 0) * leverage
  const grossExposure = Object.values(finalWeights).reduce((s, v) => s + Math.abs(v), 0)

  return { hcaWeights, blReturns: posteriorReturns, finalWeights, leverage, grossExposure, allocationMode: 'hca_bl' }
}
