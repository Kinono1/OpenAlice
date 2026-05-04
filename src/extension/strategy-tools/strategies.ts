import {
  BBANDS,
  RSI,
} from "../../domain/analysis/indicator/functions/technical.js";
import { SMA } from "../../domain/analysis/indicator/functions/statistics.js";
import type { MarketData } from "../analysis-kit/data/interfaces.js";
import type {
  PositionSignal,
  ResolvedStrategyParams,
  StrategyEnsembleWeights,
  StrategyDecision,
  StrategyEvaluationInput,
  StrategyName,
  StrategyParams,
  StrategyRegimeLabel,
} from "./types.js";
import { DEFAULT_STRATEGY_PARAMS } from "./types.js";

interface RegimeSnapshot {
  label: StrategyRegimeLabel;
  volMix: number;
  volThreshold: number;
  trendStrength: number;
  absTrendStrength: number;
  trendThreshold: number;
}

function closes(candles: MarketData[], endInclusive: number): number[] {
  return candles.slice(0, endInclusive + 1).map(c => c.close);
}

function highs(
  candles: MarketData[],
  start: number,
  endInclusive: number
): number[] {
  return candles.slice(start, endInclusive + 1).map(c => c.high);
}

function lows(
  candles: MarketData[],
  start: number,
  endInclusive: number
): number[] {
  return candles.slice(start, endInclusive + 1).map(c => c.low);
}

function mean(values: number[]): number {
  if (values.length < 1) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length < 1) {
    return 0;
  }
  const center = mean(values);
  const variance =
    values.reduce((sum, value) => {
      const diff = value - center;
      return sum + diff * diff;
    }, 0) / values.length;
  return Math.sqrt(Math.max(variance, 0));
}

function quantile(values: number[], q: number): number {
  if (values.length < 1) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.max(0, Math.min(1, q));
  const position = (sorted.length - 1) * clamped;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function emaSeries(values: number[], period: number): number[] {
  if (values.length < 1) {
    return [];
  }
  const safePeriod = Math.max(1, Math.floor(period));
  const alpha = 2 / (safePeriod + 1);
  const out = [values[0]];
  for (let index = 1; index < values.length; index++) {
    out.push(alpha * values[index] + (1 - alpha) * out[out.length - 1]);
  }
  return out;
}

function rollingStd(values: number[], window: number): number[] {
  const safeWindow = Math.max(1, Math.floor(window));
  const out: number[] = [];
  for (let index = 0; index < values.length; index++) {
    const start = Math.max(0, index - safeWindow + 1);
    out.push(std(values.slice(start, index + 1)));
  }
  return out;
}

function rollingMean(values: number[], window: number): number[] {
  const safeWindow = Math.max(1, Math.floor(window));
  const out: number[] = [];
  for (let index = 0; index < values.length; index++) {
    const start = Math.max(0, index - safeWindow + 1);
    out.push(mean(values.slice(start, index + 1)));
  }
  return out;
}

function trueRangeSeries(candles: MarketData[], closeSeries: number[]): number[] {
  const out: number[] = [];
  let prevClose = closeSeries[0] ?? 0;
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index];
    out.push(
      Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - prevClose),
        Math.abs(candle.low - prevClose),
      ),
    );
    prevClose = candle.close;
  }
  return out;
}

function sanitizeWeight(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function resolveEnsembleWeights(
  input: StrategyEnsembleWeights | undefined
): ResolvedStrategyParams["ensembleWeights"] {
  const fallback = DEFAULT_STRATEGY_PARAMS.ensembleWeights;
  const trend = sanitizeWeight(input?.trend, fallback.trend);
  const meanReversion = sanitizeWeight(
    input?.meanReversion,
    fallback.meanReversion
  );
  const breakout = sanitizeWeight(input?.breakout, fallback.breakout);
  return { trend, meanReversion, breakout };
}

function normalizeRegimeLabel(value: unknown): StrategyRegimeLabel | null {
  if (
    value === "HighVolTrend" ||
    value === "HighVolMeanRevert" ||
    value === "LowVolTrend" ||
    value === "LowVolCarry"
  ) {
    return value;
  }
  return null;
}

function resolveAllowedEntryRegimes(
  input: StrategyParams["allowedEntryRegimes"]
): StrategyRegimeLabel[] {
  const normalized = Array.isArray(input)
    ? input
        .map(item => normalizeRegimeLabel(item))
        .filter((item): item is StrategyRegimeLabel => item !== null)
    : [];
  if (normalized.length < 1) {
    return [...DEFAULT_STRATEGY_PARAMS.allowedEntryRegimes];
  }
  return Array.from(new Set(normalized));
}

function regimeLabelToCode(label: StrategyRegimeLabel): number {
  switch (label) {
    case "HighVolTrend":
      return 3;
    case "HighVolMeanRevert":
      return 2;
    case "LowVolTrend":
      return 1;
    case "LowVolCarry":
    default:
      return 0;
  }
}

export function resolveStrategyParams(
  params: StrategyParams | undefined
): ResolvedStrategyParams {
  const rawThreshold =
    params?.ensembleThreshold ?? DEFAULT_STRATEGY_PARAMS.ensembleThreshold;
  const ensembleThreshold = Math.max(0, Math.min(1, rawThreshold));
  return {
    allowShort: params?.allowShort ?? DEFAULT_STRATEGY_PARAMS.allowShort,
    trendFastPeriod:
      params?.trendFastPeriod ?? DEFAULT_STRATEGY_PARAMS.trendFastPeriod,
    trendSlowPeriod:
      params?.trendSlowPeriod ?? DEFAULT_STRATEGY_PARAMS.trendSlowPeriod,
    trendConfirmBars: Math.max(
      1,
      Math.floor(
        params?.trendConfirmBars ?? DEFAULT_STRATEGY_PARAMS.trendConfirmBars
      )
    ),
    trendMinDiffPct: Math.max(
      0,
      params?.trendMinDiffPct ?? DEFAULT_STRATEGY_PARAMS.trendMinDiffPct
    ),
    regimeVolWindow: Math.max(
      2,
      Math.floor(params?.regimeVolWindow ?? DEFAULT_STRATEGY_PARAMS.regimeVolWindow)
    ),
    regimeAtrPeriod: Math.max(
      2,
      Math.floor(params?.regimeAtrPeriod ?? DEFAULT_STRATEGY_PARAMS.regimeAtrPeriod)
    ),
    regimeFastPeriod: Math.max(
      2,
      Math.floor(params?.regimeFastPeriod ?? DEFAULT_STRATEGY_PARAMS.regimeFastPeriod)
    ),
    regimeSlowPeriod: Math.max(
      3,
      Math.floor(params?.regimeSlowPeriod ?? DEFAULT_STRATEGY_PARAMS.regimeSlowPeriod)
    ),
    allowedEntryRegimes: resolveAllowedEntryRegimes(params?.allowedEntryRegimes),
    exitOnRegimeMismatch:
      params?.exitOnRegimeMismatch ?? DEFAULT_STRATEGY_PARAMS.exitOnRegimeMismatch,
    rsiPeriod: params?.rsiPeriod ?? DEFAULT_STRATEGY_PARAMS.rsiPeriod,
    rsiOversold: params?.rsiOversold ?? DEFAULT_STRATEGY_PARAMS.rsiOversold,
    rsiOverbought:
      params?.rsiOverbought ?? DEFAULT_STRATEGY_PARAMS.rsiOverbought,
    bbPeriod: params?.bbPeriod ?? DEFAULT_STRATEGY_PARAMS.bbPeriod,
    bbStdDev: params?.bbStdDev ?? DEFAULT_STRATEGY_PARAMS.bbStdDev,
    breakoutPeriod:
      params?.breakoutPeriod ?? DEFAULT_STRATEGY_PARAMS.breakoutPeriod,
    breakoutExitPeriod:
      params?.breakoutExitPeriod ?? DEFAULT_STRATEGY_PARAMS.breakoutExitPeriod,
    ensembleThreshold,
    ensembleWeights: resolveEnsembleWeights(params?.ensembleWeights),
  };
}

export function getStrategyMinimumBars(
  strategy: StrategyName,
  params?: StrategyParams
): number {
  const p = resolveStrategyParams(params);
  const trendBars = p.trendSlowPeriod + p.trendConfirmBars - 1;
  if (strategy === "trend") {
    return trendBars;
  }
  if (strategy === "regimeTrend") {
    return Math.max(
      trendBars,
      p.regimeSlowPeriod,
      p.regimeVolWindow + 1,
      p.regimeAtrPeriod,
    );
  }
  if (strategy === "meanReversion") {
    return Math.max(p.rsiPeriod + 1, p.bbPeriod);
  }
  const breakoutBars = Math.max(p.breakoutPeriod + 1, p.breakoutExitPeriod + 1);
  if (strategy === "breakout") return breakoutBars;
  return Math.max(
    p.trendSlowPeriod,
    Math.max(p.rsiPeriod + 1, p.bbPeriod),
    breakoutBars
  );
}

export function evaluateStrategy({
  strategy,
  candles,
  index,
  currentPosition,
  params,
}: StrategyEvaluationInput & { strategy: StrategyName }): StrategyDecision {
  const resolved = resolveStrategyParams(params);
  if (index < 0 || index >= candles.length) {
    throw new Error(`index out of bounds: ${index}`);
  }

  if (strategy === "trend") {
    return evaluateTrend(candles, index, currentPosition, resolved);
  }
  if (strategy === "regimeTrend") {
    return evaluateRegimeTrend(candles, index, currentPosition, resolved);
  }
  if (strategy === "meanReversion") {
    return evaluateMeanReversion(candles, index, currentPosition, resolved);
  }
  if (strategy === "breakout") {
    return evaluateBreakout(candles, index, currentPosition, resolved);
  }
  return evaluateEnsemble(candles, index, currentPosition, resolved);
}

function evaluateTrend(
  candles: MarketData[],
  index: number,
  currentPosition: PositionSignal,
  p: ResolvedStrategyParams
): StrategyDecision {
  const series = closes(candles, index);
  const requiredBars = p.trendSlowPeriod + p.trendConfirmBars - 1;
  if (series.length < requiredBars) {
    return {
      strategy: "trend",
      signal: 0,
      reason: "Not enough bars for trend signal.",
      indicators: { bars: series.length, requiredBars },
    };
  }

  const diffs: number[] = [];
  for (let offset = 0; offset < p.trendConfirmBars; offset++) {
    const endInclusive = series.length - 1 - offset;
    const window = series.slice(0, endInclusive + 1);
    const fast = SMA(window, p.trendFastPeriod);
    const slow = SMA(window, p.trendSlowPeriod);
    diffs.push(((fast - slow) / slow) * 100);
  }
  const latestDiff = diffs[0];
  const confirmedLong = diffs.every(diff => diff >= p.trendMinDiffPct);
  const confirmedShort = diffs.every(diff => diff <= -p.trendMinDiffPct);

  let signal: PositionSignal = currentPosition;
  if (confirmedLong) signal = 1;
  if (confirmedShort) signal = p.allowShort ? -1 : 0;

  return {
    strategy: "trend",
    signal,
    reason: buildTrendReason({
      signal,
      allowShort: p.allowShort,
      confirmedLong,
      confirmedShort,
      confirmBars: p.trendConfirmBars,
      minDiffPct: p.trendMinDiffPct,
    }),
    indicators: {
      close: series[series.length - 1],
      smaDiffPct: latestDiff,
      trendConfirmBars: p.trendConfirmBars,
      trendMinDiffPct: p.trendMinDiffPct,
      confirmedLong: confirmedLong ? 1 : 0,
      confirmedShort: confirmedShort ? 1 : 0,
    },
  };
}

function buildTrendReason(input: {
  signal: PositionSignal;
  allowShort: boolean;
  confirmedLong: boolean;
  confirmedShort: boolean;
  confirmBars: number;
  minDiffPct: number;
}): string {
  const bandText =
    input.minDiffPct > 0
      ? ` with ${input.minDiffPct.toFixed(2)}% minimum SMA spread`
      : "";
  const confirmText =
    input.confirmBars > 1
      ? ` over ${input.confirmBars} confirming bars`
      : "";

  if (input.signal === 1 && input.confirmedLong) {
    return `Fast SMA stayed above slow SMA${bandText}${confirmText}.`;
  }
  if (input.signal === -1 && input.confirmedShort) {
    return `Fast SMA stayed below slow SMA${bandText}${confirmText}.`;
  }
  if (!input.allowShort && input.confirmedShort) {
    return "Short trend confirmed but shorting is disabled.";
  }
  return "Trend confirmation is not strong enough.";
}

function buildRuleBasedRegimeSnapshot(
  candles: MarketData[],
  index: number,
  p: ResolvedStrategyParams
): RegimeSnapshot {
  const visibleCandles = candles.slice(0, index + 1);
  const closeSeries = visibleCandles.map(candle => candle.close);
  const returns = [0];
  for (let cursor = 1; cursor < closeSeries.length; cursor++) {
    const prev = closeSeries[cursor - 1];
    returns.push(prev > 0 ? closeSeries[cursor] / prev - 1 : 0);
  }

  const vol20 = rollingStd(returns, p.regimeVolWindow);
  const emaFast = emaSeries(closeSeries, p.regimeFastPeriod);
  const emaSlow = emaSeries(closeSeries, p.regimeSlowPeriod);
  const trend = closeSeries.map((_, cursor) =>
    emaSlow[cursor] ? emaFast[cursor] / emaSlow[cursor] - 1 : 0,
  );
  const atr = rollingMean(trueRangeSeries(visibleCandles, closeSeries), p.regimeAtrPeriod);
  const atrPct = atr.map((value, cursor) =>
    closeSeries[cursor] > 0 ? value / closeSeries[cursor] : 0,
  );
  const volMix = closeSeries.map((_, cursor) => Math.max(vol20[cursor], atrPct[cursor]));

  const warmup = Math.min(120, Math.max(20, Math.floor(visibleCandles.length / 3)));
  const start = Math.min(Math.max(1, warmup), Math.max(1, visibleCandles.length - 1));
  const volTrain = volMix.slice(start);
  const trendTrain = trend.slice(start).map(value => Math.abs(value));
  const currentVolMix = volMix[volMix.length - 1] ?? 0;
  const currentTrend = trend[trend.length - 1] ?? 0;
  const currentAbsTrend = Math.abs(currentTrend);
  const volThreshold = quantile(volTrain.length > 0 ? volTrain : volMix, 0.65);
  const trendThreshold = quantile(
    trendTrain.length > 0 ? trendTrain : trend.map(value => Math.abs(value)),
    0.6,
  );

  const highVol = currentVolMix >= volThreshold;
  const trending = currentAbsTrend >= trendThreshold;
  let label: StrategyRegimeLabel = "LowVolCarry";
  if (highVol && trending) {
    label = "HighVolTrend";
  } else if (highVol) {
    label = "HighVolMeanRevert";
  } else if (trending) {
    label = "LowVolTrend";
  }

  return {
    label,
    volMix: currentVolMix,
    volThreshold,
    trendStrength: currentTrend,
    absTrendStrength: currentAbsTrend,
    trendThreshold,
  };
}

function evaluateRegimeTrend(
  candles: MarketData[],
  index: number,
  currentPosition: PositionSignal,
  p: ResolvedStrategyParams
): StrategyDecision {
  const series = closes(candles, index);
  const requiredBars = getStrategyMinimumBars("regimeTrend", p);
  if (series.length < requiredBars) {
    return {
      strategy: "regimeTrend",
      signal: 0,
      reason: "Not enough bars for regime-filtered trend signal.",
      indicators: { bars: series.length, requiredBars },
    };
  }

  const trendDecision = evaluateTrend(candles, index, currentPosition, p);
  const regime = buildRuleBasedRegimeSnapshot(candles, index, p);
  const regimeAllowed = p.allowedEntryRegimes.includes(regime.label);

  let signal: PositionSignal = trendDecision.signal;
  let reason = `Regime ${regime.label} allows trend signal.`;

  if (!regimeAllowed) {
    if (currentPosition !== 0 && p.exitOnRegimeMismatch) {
      signal = 0;
      reason = `Current regime ${regime.label} is outside allowed entry regimes; exiting active position.`;
    } else if (trendDecision.signal !== currentPosition) {
      signal = currentPosition;
      reason = `Trend transition is blocked by current regime ${regime.label}.`;
    } else {
      signal = currentPosition;
      reason = `Current regime ${regime.label} is outside allowed entry regimes.`;
    }
  } else {
    reason = `${trendDecision.reason} Regime ${regime.label} permits the signal.`;
  }

  return {
    strategy: "regimeTrend",
    signal,
    reason,
    indicators: {
      ...trendDecision.indicators,
      currentRegimeCode: regimeLabelToCode(regime.label),
      regimeAllowed: regimeAllowed ? 1 : 0,
      regimeVolMix: regime.volMix,
      regimeVolThreshold: regime.volThreshold,
      regimeTrendStrength: regime.trendStrength,
      regimeAbsTrendStrength: regime.absTrendStrength,
      regimeTrendThreshold: regime.trendThreshold,
      exitOnRegimeMismatch: p.exitOnRegimeMismatch ? 1 : 0,
    },
  };
}

function evaluateMeanReversion(
  candles: MarketData[],
  index: number,
  currentPosition: PositionSignal,
  p: ResolvedStrategyParams
): StrategyDecision {
  const series = closes(candles, index);
  const minBars = Math.max(p.rsiPeriod + 1, p.bbPeriod);
  if (series.length < minBars) {
    return {
      strategy: "meanReversion",
      signal: 0,
      reason: "Not enough bars for mean-reversion signal.",
      indicators: { bars: series.length },
    };
  }

  const close = series[series.length - 1];
  const rsi = RSI(series, p.rsiPeriod);
  const bb = BBANDS(series, p.bbPeriod, p.bbStdDev);

  let signal: PositionSignal = currentPosition;
  let reason = "No edge detected.";

  if (close < bb.lower && rsi < p.rsiOversold) {
    signal = 1;
    reason = "Price is below lower band and RSI is oversold.";
  } else if (close > bb.upper && rsi > p.rsiOverbought) {
    signal = p.allowShort ? -1 : 0;
    reason = p.allowShort
      ? "Price is above upper band and RSI is overbought."
      : "Overbought setup detected but shorting is disabled.";
  } else if (currentPosition === 1 && (close >= bb.middle || rsi >= 50)) {
    signal = 0;
    reason = "Long mean-reversion target reached at middle band / RSI mean.";
  } else if (currentPosition === -1 && (close <= bb.middle || rsi <= 50)) {
    signal = 0;
    reason = "Short mean-reversion target reached at middle band / RSI mean.";
  }

  return {
    strategy: "meanReversion",
    signal,
    reason,
    indicators: {
      close,
      rsi,
      bbUpper: bb.upper,
      bbMiddle: bb.middle,
      bbLower: bb.lower,
    },
  };
}

function evaluateBreakout(
  candles: MarketData[],
  index: number,
  currentPosition: PositionSignal,
  p: ResolvedStrategyParams
): StrategyDecision {
  const minBars = Math.max(p.breakoutPeriod + 1, p.breakoutExitPeriod + 1);
  if (index + 1 < minBars) {
    return {
      strategy: "breakout",
      signal: 0,
      reason: "Not enough bars for breakout signal.",
      indicators: { bars: index + 1 },
    };
  }

  const close = candles[index].close;
  const breakoutHigh = Math.max(
    ...highs(candles, index - p.breakoutPeriod, index - 1)
  );
  const breakoutLow = Math.min(
    ...lows(candles, index - p.breakoutPeriod, index - 1)
  );
  const exitHigh = Math.max(
    ...highs(candles, index - p.breakoutExitPeriod, index - 1)
  );
  const exitLow = Math.min(
    ...lows(candles, index - p.breakoutExitPeriod, index - 1)
  );

  let signal: PositionSignal = currentPosition;
  let reason = "No breakout signal.";

  if (currentPosition === 0) {
    if (close > breakoutHigh) {
      signal = 1;
      reason = "Close broke above Donchian upper channel.";
    } else if (close < breakoutLow) {
      signal = p.allowShort ? -1 : 0;
      reason = p.allowShort
        ? "Close broke below Donchian lower channel."
        : "Downside breakout ignored because shorting is disabled.";
    }
  } else if (currentPosition === 1) {
    if (close < exitLow) {
      signal = 0;
      reason = "Long exit: close fell below trailing exit channel.";
    }
  } else if (currentPosition === -1) {
    if (close > exitHigh) {
      signal = 0;
      reason = "Short exit: close rose above trailing exit channel.";
    }
  }

  return {
    strategy: "breakout",
    signal,
    reason,
    indicators: {
      close,
      breakoutHigh,
      breakoutLow,
      exitHigh,
      exitLow,
    },
  };
}

function evaluateEnsemble(
  candles: MarketData[],
  index: number,
  currentPosition: PositionSignal,
  p: ResolvedStrategyParams
): StrategyDecision {
  const trend = evaluateTrend(candles, index, currentPosition, p);
  const meanReversion = evaluateMeanReversion(
    candles,
    index,
    currentPosition,
    p
  );
  const breakout = evaluateBreakout(candles, index, currentPosition, p);

  const weightedSignal =
    trend.signal * p.ensembleWeights.trend +
    meanReversion.signal * p.ensembleWeights.meanReversion +
    breakout.signal * p.ensembleWeights.breakout;
  const weightSum =
    p.ensembleWeights.trend +
    p.ensembleWeights.meanReversion +
    p.ensembleWeights.breakout;
  const normalizedScore = weightSum > 0 ? weightedSignal / weightSum : 0;

  let signal: PositionSignal = 0;
  if (normalizedScore >= p.ensembleThreshold) {
    signal = 1;
  } else if (normalizedScore <= -p.ensembleThreshold) {
    signal = p.allowShort ? -1 : 0;
  }

  const longVotes = [trend.signal, meanReversion.signal, breakout.signal].filter(
    value => value > 0,
  ).length;
  const shortVotes = [trend.signal, meanReversion.signal, breakout.signal].filter(
    value => value < 0,
  ).length;

  let reason = "Ensemble score is neutral.";
  if (signal === 1) {
    reason = `Weighted consensus is long (${normalizedScore.toFixed(2)} >= ${p.ensembleThreshold.toFixed(2)}).`;
  } else if (signal === -1) {
    reason = `Weighted consensus is short (${normalizedScore.toFixed(2)} <= -${p.ensembleThreshold.toFixed(2)}).`;
  } else if (!p.allowShort && normalizedScore <= -p.ensembleThreshold) {
    reason = "Short consensus detected but shorting is disabled.";
  }

  return {
    strategy: "ensemble",
    signal,
    reason,
    indicators: {
      ensembleScore: normalizedScore,
      ensembleThreshold: p.ensembleThreshold,
      trendSignal: trend.signal,
      meanReversionSignal: meanReversion.signal,
      breakoutSignal: breakout.signal,
      trendWeight: p.ensembleWeights.trend,
      meanReversionWeight: p.ensembleWeights.meanReversion,
      breakoutWeight: p.ensembleWeights.breakout,
      longVotes,
      shortVotes,
    },
  };
}
