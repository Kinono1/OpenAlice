export interface RegimeShiftConfig {
  recentBars: number;
  baselineBars: number;
  volZWatch: number;
  volZHigh: number;
  trendZWatch: number;
  trendZHigh: number;
}

export interface RegimeShiftResult {
  triggered: boolean;
  severity: "none" | "watch" | "high";
  reason: string;
  metrics: {
    recentVol: number;
    baselineVolMean: number;
    baselineVolStd: number;
    recentMeanReturn: number;
    baselineMeanReturn: number;
    baselineMeanStd: number;
    volZ: number;
    trendZ: number;
  };
}

export const DEFAULT_REGIME_SHIFT_CONFIG: RegimeShiftConfig = {
  recentBars: 24,
  baselineBars: 24 * 90,
  volZWatch: 1.5,
  volZHigh: 2.5,
  trendZWatch: 1.5,
  trendZHigh: 2.5,
};

export function detectRegimeShift(
  closeSeries: number[],
  config: Partial<RegimeShiftConfig> = {},
): RegimeShiftResult {
  const resolved: RegimeShiftConfig = {
    ...DEFAULT_REGIME_SHIFT_CONFIG,
    ...config,
  };

  assertPositiveInt(resolved.recentBars, "recentBars");
  assertPositiveInt(resolved.baselineBars, "baselineBars");
  if (closeSeries.length < resolved.baselineBars + 2) {
    return {
      triggered: false,
      severity: "none",
      reason: "insufficient_data",
      metrics: {
        recentVol: 0,
        baselineVolMean: 0,
        baselineVolStd: 0,
        recentMeanReturn: 0,
        baselineMeanReturn: 0,
        baselineMeanStd: 0,
        volZ: 0,
        trendZ: 0,
      },
    };
  }

  const returns = toReturns(closeSeries);
  const recent = returns.slice(-resolved.recentBars);
  const baselineWindow = returns.slice(-(resolved.baselineBars + resolved.recentBars), -resolved.recentBars);
  if (baselineWindow.length < resolved.recentBars) {
    return {
      triggered: false,
      severity: "none",
      reason: "insufficient_baseline_windows",
      metrics: {
        recentVol: 0,
        baselineVolMean: 0,
        baselineVolStd: 0,
        recentMeanReturn: 0,
        baselineMeanReturn: 0,
        baselineMeanStd: 0,
        volZ: 0,
        trendZ: 0,
      },
    };
  }

  const baselineVols: number[] = [];
  const baselineMeans: number[] = [];
  for (let i = resolved.recentBars; i <= baselineWindow.length; i++) {
    const window = baselineWindow.slice(i - resolved.recentBars, i);
    baselineVols.push(stdDev(window));
    baselineMeans.push(mean(window));
  }

  const recentVol = stdDev(recent);
  const recentMean = mean(recent);
  const baselineVolMean = mean(baselineVols);
  const baselineVolStd = Math.max(stdDev(baselineVols), 1e-12);
  const baselineMeanReturn = mean(baselineMeans);
  const baselineMeanStd = Math.max(stdDev(baselineMeans), 1e-12);

  const volZ = (recentVol - baselineVolMean) / baselineVolStd;
  const trendZ = Math.abs(recentMean - baselineMeanReturn) / baselineMeanStd;

  const high = Math.abs(volZ) >= resolved.volZHigh || trendZ >= resolved.trendZHigh;
  if (high) {
    return {
      triggered: true,
      severity: "high",
      reason: "high_regime_shift",
      metrics: {
        recentVol,
        baselineVolMean,
        baselineVolStd,
        recentMeanReturn: recentMean,
        baselineMeanReturn,
        baselineMeanStd,
        volZ,
        trendZ,
      },
    };
  }

  const watch = Math.abs(volZ) >= resolved.volZWatch || trendZ >= resolved.trendZWatch;
  if (watch) {
    return {
      triggered: true,
      severity: "watch",
      reason: "watch_regime_shift",
      metrics: {
        recentVol,
        baselineVolMean,
        baselineVolStd,
        recentMeanReturn: recentMean,
        baselineMeanReturn,
        baselineMeanStd,
        volZ,
        trendZ,
      },
    };
  }

  return {
    triggered: false,
    severity: "none",
    reason: "stable_regime",
    metrics: {
      recentVol,
      baselineVolMean,
      baselineVolStd,
      recentMeanReturn: recentMean,
      baselineMeanReturn,
      baselineMeanStd,
      volZ,
      trendZ,
    },
  };
}

function toReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const next = closes[i];
    if (prev > 0 && Number.isFinite(prev) && Number.isFinite(next)) {
      out.push(next / prev - 1);
    }
  }
  return out;
}

function mean(values: number[]): number {
  if (values.length < 1) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const m = mean(values);
  const variance =
    values.reduce((sum, value) => {
      const centered = value - m;
      return sum + centered * centered;
    }, 0) / values.length;
  return Math.sqrt(Math.max(variance, 0));
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
