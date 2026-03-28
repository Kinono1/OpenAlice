import type { MarketData } from "../extension/analysis-kit/data/interfaces.js";
import {
  detectRegimeShift,
  type RegimeShiftResult,
} from "./regime_shift.js";

export type RegimeId = "trend_up" | "trend_down" | "range" | "event_vol";

export interface RegimeSnapshotConfig {
  recentBars: number;
  momentumThresholdPct: number;
  eventIntensityThreshold: number;
  elevatedVolZThreshold: number;
}

export interface RegimeSnapshotArtifact {
  schemaVersion: "regime_snapshot.v1";
  generatedAt: string;
  symbol: string;
  regimeId: RegimeId;
  confidence: number;
  allowedStrategyFamilies: string[];
  thresholdProfile: {
    maxExposureScale: number;
    allowAdding: boolean;
    minCompositeScoreBump: number;
  };
  reasonCodes: string[];
  eventIntensity: number;
  metrics: {
    recentBars: number;
    momentumPct: number;
    recentVolatility: number;
    recentMeanReturnPct: number;
    volZ: number;
    trendZ: number;
  };
}

function allowedStrategyFamiliesFor(regimeId: RegimeId): string[] {
  switch (regimeId) {
    case "trend_up":
    case "trend_down":
      return [
        "core_trend",
        "core_breakout",
        "core_ensemble",
        "volatility_gated",
      ];
    case "event_vol":
      return ["volatility_gated", "core_ensemble"];
    case "range":
      return ["core_mean_reversion", "core_ensemble"];
  }
}

function thresholdProfileFor(regimeId: RegimeId): RegimeSnapshotArtifact["thresholdProfile"] {
  switch (regimeId) {
    case "trend_up":
    case "trend_down":
      return {
        maxExposureScale: 1,
        allowAdding: true,
        minCompositeScoreBump: 0,
      };
    case "range":
      return {
        maxExposureScale: 0.7,
        allowAdding: false,
        minCompositeScoreBump: 0.05,
      };
    case "event_vol":
      return {
        maxExposureScale: 0.45,
        allowAdding: false,
        minCompositeScoreBump: 0.12,
      };
  }
}

export interface BuildRegimeSnapshotInput {
  symbol: string;
  bars: MarketData[];
  eventIntensity?: number;
  generatedAt?: string;
  config?: Partial<RegimeSnapshotConfig>;
}

const DEFAULT_CONFIG: RegimeSnapshotConfig = {
  recentBars: 24,
  momentumThresholdPct: 0.015,
  eventIntensityThreshold: 0.65,
  elevatedVolZThreshold: 1.5,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function computeRecentVolatility(closes: number[]): number {
  if (closes.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const next = closes[i];
    if (prev > 0 && Number.isFinite(prev) && Number.isFinite(next)) {
      returns.push(next / prev - 1);
    }
  }
  if (returns.length < 2) return 0;
  const mean =
    returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => {
      const centered = value - mean;
      return sum + centered * centered;
    }, 0) / returns.length;
  return Math.sqrt(Math.max(variance, 0));
}

function classifyRegime(args: {
  eventIntensity: number;
  momentumPct: number;
  shift: RegimeShiftResult;
  config: RegimeSnapshotConfig;
}): {
  regimeId: RegimeId;
  reasonCodes: string[];
} {
  const reasons: string[] = [];
  if (args.eventIntensity >= args.config.eventIntensityThreshold) {
    reasons.push("event_intensity_above_threshold");
    return { regimeId: "event_vol", reasonCodes: reasons };
  }
  if (
    args.shift.triggered &&
    args.shift.metrics.volZ >= args.config.elevatedVolZThreshold
  ) {
    reasons.push("volatility_shift_detected");
    return { regimeId: "event_vol", reasonCodes: reasons };
  }
  if (args.momentumPct >= args.config.momentumThresholdPct) {
    reasons.push("positive_momentum_above_threshold");
    return { regimeId: "trend_up", reasonCodes: reasons };
  }
  if (args.momentumPct <= -args.config.momentumThresholdPct) {
    reasons.push("negative_momentum_above_threshold");
    return { regimeId: "trend_down", reasonCodes: reasons };
  }
  reasons.push("momentum_within_range_band");
  return { regimeId: "range", reasonCodes: reasons };
}

export function buildRegimeSnapshot(
  input: BuildRegimeSnapshotInput,
): RegimeSnapshotArtifact {
  const config: RegimeSnapshotConfig = {
    ...DEFAULT_CONFIG,
    ...input.config,
  };
  if (input.bars.length < config.recentBars + 1) {
    throw new Error(
      `regime snapshot requires at least ${config.recentBars + 1} bars, got ${input.bars.length}`,
    );
  }
  const sorted = [...input.bars].sort((a, b) => a.time - b.time);
  const recent = sorted.slice(-config.recentBars);
  const closes = sorted.map((bar) => bar.close);
  const recentCloses = recent.map((bar) => bar.close);
  const momentumPct =
    recentCloses.length < 2
      ? 0
      : recentCloses[recentCloses.length - 1] / recentCloses[0] - 1;
  const recentMeanReturnPct =
    recentCloses.length < 2
      ? 0
      : recentCloses[recentCloses.length - 1] / recentCloses[0] - 1;
  const shift = detectRegimeShift(closes, {
    recentBars: config.recentBars,
  });
  const eventIntensity = clamp(input.eventIntensity ?? 0, 0, 1);
  const classification = classifyRegime({
    eventIntensity,
    momentumPct,
    shift,
    config,
  });
  const confidence = clamp(
    Math.max(
      Math.abs(momentumPct) / Math.max(config.momentumThresholdPct, 1e-6),
      eventIntensity,
      Math.abs(shift.metrics.volZ) / Math.max(config.elevatedVolZThreshold, 1e-6),
    ) / 2,
    0,
    1,
  );

  return {
    schemaVersion: "regime_snapshot.v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    symbol: input.symbol,
    regimeId: classification.regimeId,
    confidence: round(confidence),
    allowedStrategyFamilies: allowedStrategyFamiliesFor(classification.regimeId),
    thresholdProfile: thresholdProfileFor(classification.regimeId),
    reasonCodes: [...classification.reasonCodes, shift.reason],
    eventIntensity: round(eventIntensity),
    metrics: {
      recentBars: config.recentBars,
      momentumPct: round(momentumPct),
      recentVolatility: round(computeRecentVolatility(recentCloses)),
      recentMeanReturnPct: round(recentMeanReturnPct),
      volZ: round(shift.metrics.volZ),
      trendZ: round(shift.metrics.trendZ),
    },
  };
}
