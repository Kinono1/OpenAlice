import type { StrategyName, StrategyParams } from "./types.js";

export type AlphaCandidateFamily =
  | "core_trend"
  | "core_mean_reversion"
  | "core_breakout"
  | "core_ensemble"
  | "volatility_gated";

export type AlphaCandidateStatus =
  | "seed"
  | "screened_in"
  | "screened_out"
  | "paper_candidate"
  | "champion"
  | "retired";

export interface AlphaCandidate {
  candidateId: string;
  family: AlphaCandidateFamily;
  strategy: StrategyName;
  params: StrategyParams;
  seedName: string;
  tags: string[];
  status: AlphaCandidateStatus;
}

export interface CandidateFactoryOptions {
  allowShort?: boolean;
  includeFamilies?: AlphaCandidateFamily[];
}

const PARAM_ORDER: Array<keyof StrategyParams> = [
  "allowShort",
  "trendFastPeriod",
  "trendSlowPeriod",
  "rsiPeriod",
  "rsiOversold",
  "rsiOverbought",
  "bbPeriod",
  "bbStdDev",
  "breakoutPeriod",
  "breakoutExitPeriod",
  "volWindowBars",
  "volBaselineBars",
  "volTriggerRatio",
  "volCooldownBars",
  "ensembleThreshold",
  "ensembleWeights",
];

const ENSEMBLE_WEIGHT_ORDER: Array<keyof NonNullable<StrategyParams["ensembleWeights"]>> = [
  "trend",
  "meanReversion",
  "breakout",
];

function formatNumber(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(6).replace(/\.?0+$/, "");
}

function stableParamString(params: StrategyParams): string {
  const parts: string[] = [];
  for (const key of PARAM_ORDER) {
    const value = params[key];
    if (value === undefined) continue;
    if (key === "ensembleWeights" && value) {
      const weights = value as NonNullable<StrategyParams["ensembleWeights"]>;
      const weightParts: string[] = [];
      for (const weightKey of ENSEMBLE_WEIGHT_ORDER) {
        const weightValue = weights[weightKey];
        if (typeof weightValue === "number" && Number.isFinite(weightValue)) {
          weightParts.push(`${weightKey}=${formatNumber(weightValue)}`);
        }
      }
      if (weightParts.length > 0) {
        parts.push(`${key}(${weightParts.join(",")})`);
      }
      continue;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      parts.push(`${key}=${formatNumber(value)}`);
      continue;
    }

    if (typeof value === "boolean") {
      parts.push(`${key}=${value ? "1" : "0"}`);
    }
  }
  return parts.join("|");
}

export function buildAlphaCandidateId(input: {
  family: AlphaCandidateFamily;
  strategy: StrategyName;
  params?: StrategyParams;
}): string {
  const paramString = stableParamString(input.params ?? {});
  return paramString.length > 0
    ? `${input.family}:${input.strategy}:${paramString}`
    : `${input.family}:${input.strategy}`;
}

export function createAlphaCandidate(input: {
  family: AlphaCandidateFamily;
  strategy: StrategyName;
  params?: StrategyParams;
  seedName?: string;
  tags?: string[];
  status?: AlphaCandidateStatus;
}): AlphaCandidate {
  const params = input.params ?? {};
  return {
    candidateId: buildAlphaCandidateId({
      family: input.family,
      strategy: input.strategy,
      params,
    }),
    family: input.family,
    strategy: input.strategy,
    params,
    seedName: input.seedName ?? input.strategy,
    tags: input.tags ?? [],
    status: input.status ?? "seed",
  };
}

function withAllowShort(
  params: StrategyParams,
  allowShort: boolean | undefined,
): StrategyParams {
  return allowShort === undefined ? params : { ...params, allowShort };
}

function includeFamily(
  family: AlphaCandidateFamily,
  wanted: AlphaCandidateFamily[] | undefined,
): boolean {
  return !wanted || wanted.includes(family);
}

export function buildSeedAlphaCandidates(
  options: CandidateFactoryOptions = {},
): AlphaCandidate[] {
  const seeds: AlphaCandidate[] = [];

  if (includeFamily("core_trend", options.includeFamilies)) {
    seeds.push(
      createAlphaCandidate({
        family: "core_trend",
        strategy: "trend",
        seedName: "trend_fast_10_30",
        tags: ["trend", "seed"],
        params: withAllowShort(
          { trendFastPeriod: 10, trendSlowPeriod: 30 },
          options.allowShort,
        ),
      }),
      createAlphaCandidate({
        family: "core_trend",
        strategy: "trend",
        seedName: "trend_classic_20_50",
        tags: ["trend", "seed"],
        params: withAllowShort(
          { trendFastPeriod: 20, trendSlowPeriod: 50 },
          options.allowShort,
        ),
      }),
      createAlphaCandidate({
        family: "core_trend",
        strategy: "trend",
        seedName: "trend_slow_30_100",
        tags: ["trend", "seed"],
        params: withAllowShort(
          { trendFastPeriod: 30, trendSlowPeriod: 100 },
          options.allowShort,
        ),
      }),
    );
  }

  if (includeFamily("core_mean_reversion", options.includeFamilies)) {
    seeds.push(
      createAlphaCandidate({
        family: "core_mean_reversion",
        strategy: "meanReversion",
        seedName: "mean_reversion_default",
        tags: ["mean-reversion", "control"],
        params: withAllowShort(
          {
            rsiPeriod: 14,
            rsiOversold: 30,
            rsiOverbought: 70,
            bbPeriod: 20,
            bbStdDev: 2,
          },
          options.allowShort,
        ),
      }),
    );
  }

  if (includeFamily("core_breakout", options.includeFamilies)) {
    seeds.push(
      createAlphaCandidate({
        family: "core_breakout",
        strategy: "breakout",
        seedName: "breakout_20_10",
        tags: ["breakout", "seed"],
        params: withAllowShort(
          { breakoutPeriod: 20, breakoutExitPeriod: 10 },
          options.allowShort,
        ),
      }),
      createAlphaCandidate({
        family: "core_breakout",
        strategy: "breakout",
        seedName: "breakout_55_20",
        tags: ["breakout", "seed"],
        params: withAllowShort(
          { breakoutPeriod: 55, breakoutExitPeriod: 20 },
          options.allowShort,
        ),
      }),
    );
  }

  if (includeFamily("core_ensemble", options.includeFamilies)) {
    seeds.push(
      createAlphaCandidate({
        family: "core_ensemble",
        strategy: "ensemble",
        seedName: "ensemble_trend_heavy",
        tags: ["ensemble", "trend-heavy"],
        params: withAllowShort(
          {
            ensembleThreshold: 0.3,
            ensembleWeights: { trend: 2, meanReversion: 1, breakout: 1 },
          },
          options.allowShort,
        ),
      }),
      createAlphaCandidate({
        family: "core_ensemble",
        strategy: "ensemble",
        seedName: "ensemble_balanced",
        tags: ["ensemble", "balanced"],
        params: withAllowShort(
          {
            ensembleThreshold: 0.34,
            ensembleWeights: { trend: 1, meanReversion: 1, breakout: 1 },
          },
          options.allowShort,
        ),
      }),
    );
  }

  if (includeFamily("volatility_gated", options.includeFamilies)) {
    seeds.push(
      createAlphaCandidate({
        family: "volatility_gated",
        strategy: "volTrend",
        seedName: "vol_trend_default",
        tags: ["vol-gated", "trend"],
        params: withAllowShort(
          { volTriggerRatio: 1.4, volWindowBars: 48, volBaselineBars: 240 },
          options.allowShort,
        ),
      }),
      createAlphaCandidate({
        family: "volatility_gated",
        strategy: "volBreakout",
        seedName: "vol_breakout_default",
        tags: ["vol-gated", "breakout"],
        params: withAllowShort(
          { volTriggerRatio: 1.5, volWindowBars: 48, volBaselineBars: 240 },
          options.allowShort,
        ),
      }),
    );
  }

  return seeds;
}
