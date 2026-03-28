import {
  BBANDS,
  RSI,
} from "../analysis-kit/indicator/functions/technical.js";
import { SMA } from "../analysis-kit/indicator/functions/statistics.js";
import type { MarketData } from "../analysis-kit/data/interfaces.js";
import type {
  PositionSignal,
  ResolvedStrategyParams,
  StrategyEnsembleWeights,
  StrategyDecision,
  StrategyEvaluationInput,
  StrategyName,
  StrategyParams,
} from "./types.js";
import { DEFAULT_STRATEGY_PARAMS } from "./types.js";

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
    volWindowBars:
      params?.volWindowBars ?? DEFAULT_STRATEGY_PARAMS.volWindowBars,
    volBaselineBars:
      params?.volBaselineBars ?? DEFAULT_STRATEGY_PARAMS.volBaselineBars,
    volTriggerRatio:
      params?.volTriggerRatio ?? DEFAULT_STRATEGY_PARAMS.volTriggerRatio,
    volCooldownBars:
      params?.volCooldownBars ?? DEFAULT_STRATEGY_PARAMS.volCooldownBars,
    ensembleThreshold,
    ensembleWeights: resolveEnsembleWeights(params?.ensembleWeights),
  };
}

export function getStrategyMinimumBars(
  strategy: StrategyName,
  params?: StrategyParams
): number {
  const p = resolveStrategyParams(params);
  const volGateBars = p.volWindowBars + p.volBaselineBars + 2;
  if (strategy === "trend") return p.trendSlowPeriod;
  if (strategy === "meanReversion")
    return Math.max(p.rsiPeriod + 1, p.bbPeriod);
  const breakoutBars = Math.max(p.breakoutPeriod + 1, p.breakoutExitPeriod + 1);
  if (strategy === "breakout") return breakoutBars;
  if (strategy === "volNoTradeFilter") return volGateBars;
  if (strategy === "volTrend") {
    return Math.max(p.trendSlowPeriod, volGateBars);
  }
  if (strategy === "volBreakout") {
    return Math.max(
      breakoutBars,
      volGateBars
    );
  }
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
  if (strategy === "meanReversion") {
    return evaluateMeanReversion(candles, index, currentPosition, resolved);
  }
  if (strategy === "breakout") {
    return evaluateBreakout(candles, index, currentPosition, resolved);
  }
  if (strategy === "volNoTradeFilter") {
    return evaluateVolNoTradeFilter(candles, index, currentPosition, resolved);
  }
  if (strategy === "volBreakout") {
    return evaluateVolBreakout(candles, index, currentPosition, resolved);
  }
  if (strategy === "volTrend") {
    return evaluateVolTrend(candles, index, currentPosition, resolved);
  }
  return evaluateEnsemble(candles, index, currentPosition, resolved);
}

function realizedVolOverWindow(
  candles: MarketData[],
  endInclusive: number,
  windowBars: number
): number | null {
  if (endInclusive < windowBars) {
    return null;
  }
  const values: number[] = [];
  for (let idx = endInclusive - windowBars + 1; idx <= endInclusive; idx++) {
    const prev = candles[idx - 1]?.close;
    const current = candles[idx]?.close;
    if (!prev || !current || prev <= 0 || current <= 0) continue;
    values.push(Math.log(current / prev));
  }
  if (values.length < Math.max(5, Math.floor(windowBars / 4))) {
    return null;
  }
  const variance =
    values.reduce((sum, value) => sum + value * value, 0) / values.length;
  return Math.sqrt(variance);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[mid];
  return (ordered[mid - 1] + ordered[mid]) / 2;
}

interface VolGateState {
  currentVol: number;
  baselineVol: number;
  volRatio: number;
  gateOpen: boolean;
}

function getVolGateState(
  candles: MarketData[],
  index: number,
  p: ResolvedStrategyParams
): VolGateState {
  const currentVol = realizedVolOverWindow(candles, index, p.volWindowBars);
  const baselineVols: number[] = [];
  for (
    let cursor = index - 1;
    cursor >= 0 && baselineVols.length < p.volBaselineBars;
    cursor--
  ) {
    const vol = realizedVolOverWindow(candles, cursor, p.volWindowBars);
    if (typeof vol === "number" && Number.isFinite(vol) && vol > 0) {
      baselineVols.push(vol);
    }
  }
  const baselineVol = median(baselineVols);
  const volRatio = currentVol && baselineVol > 0 ? currentVol / baselineVol : 0;
  return {
    currentVol: currentVol ?? 0,
    baselineVol,
    volRatio,
    gateOpen: volRatio >= p.volTriggerRatio,
  };
}

function volGateIndicators(
  state: VolGateState,
  p: ResolvedStrategyParams
): Record<string, number> {
  return {
    currentVol: state.currentVol,
    baselineVol: state.baselineVol,
    volRatio: state.volRatio,
    volTriggerRatio: p.volTriggerRatio,
    volGateOpen: state.gateOpen ? 1 : 0,
  };
}

function evaluateTrend(
  candles: MarketData[],
  index: number,
  currentPosition: PositionSignal,
  p: ResolvedStrategyParams
): StrategyDecision {
  const series = closes(candles, index);
  if (series.length < p.trendSlowPeriod) {
    return {
      strategy: "trend",
      signal: 0,
      reason: "Not enough bars for trend signal.",
      indicators: { bars: series.length },
    };
  }

  const fast = SMA(series, p.trendFastPeriod);
  const slow = SMA(series, p.trendSlowPeriod);
  const diff = ((fast - slow) / slow) * 100;

  let signal: PositionSignal = currentPosition;
  if (fast > slow) signal = 1;
  if (fast < slow) signal = p.allowShort ? -1 : 0;

  return {
    strategy: "trend",
    signal,
    reason:
      signal === 1
        ? "Fast SMA is above slow SMA."
        : signal === -1
          ? "Fast SMA is below slow SMA."
          : "Trend direction is neutral.",
    indicators: {
      close: series[series.length - 1],
      fastSma: fast,
      slowSma: slow,
      smaDiffPct: diff,
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

function evaluateVolNoTradeFilter(
  candles: MarketData[],
  index: number,
  currentPosition: PositionSignal,
  p: ResolvedStrategyParams
): StrategyDecision {
  const minBars = p.volWindowBars + p.volBaselineBars + 2;
  if (index + 1 < minBars) {
    return {
      strategy: "volNoTradeFilter",
      signal: 0,
      reason: "Not enough bars for vol no-trade filter.",
      indicators: { bars: index + 1 },
    };
  }

  const state = getVolGateState(candles, index, p);
  const close = candles[index].close;
  const reason = state.gateOpen
    ? "High-vol filter active; stay flat."
    : "Filter-only control remains flat while volatility stays below the suppression threshold.";

  return {
    strategy: "volNoTradeFilter",
    signal: 0,
    reason,
    indicators: {
      close,
      ...volGateIndicators(state, p),
      volFilterActive: state.gateOpen ? 1 : 0,
      priorPosition: currentPosition,
    },
  };
}

function evaluateVolBreakout(
  candles: MarketData[],
  index: number,
  currentPosition: PositionSignal,
  p: ResolvedStrategyParams
): StrategyDecision {
  const breakoutBars = Math.max(p.breakoutPeriod + 1, p.breakoutExitPeriod + 1);
  const minBars = Math.max(
    breakoutBars,
    p.volWindowBars + p.volBaselineBars + 2
  );
  if (index + 1 < minBars) {
    return {
      strategy: "volBreakout",
      signal: 0,
      reason: "Not enough bars for vol-breakout signal.",
      indicators: { bars: index + 1 },
    };
  }

  const state = getVolGateState(candles, index, p);
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
  let reason = state.gateOpen
    ? "Vol gate open but no breakout trigger."
    : "Vol gate closed; breakout entries suppressed.";

  let cooldownActive = false;
  if (currentPosition === 0 && state.gateOpen && p.volCooldownBars > 0) {
    const cooldownStart = Math.max(minBars - 1, index - p.volCooldownBars);
    for (let cursor = cooldownStart; cursor < index; cursor++) {
      const priorHigh = Math.max(
        ...highs(candles, cursor - p.breakoutPeriod, cursor - 1)
      );
      const priorLow = Math.min(
        ...lows(candles, cursor - p.breakoutPeriod, cursor - 1)
      );
      const priorClose = candles[cursor].close;
      if (priorClose > priorHigh || priorClose < priorLow) {
        cooldownActive = true;
        break;
      }
    }
  }

  if (currentPosition === 0) {
    if (state.gateOpen && !cooldownActive && close > breakoutHigh) {
      signal = 1;
      reason = "Vol gate open and close broke above breakout channel.";
    } else if (state.gateOpen && !cooldownActive && close < breakoutLow) {
      signal = p.allowShort ? -1 : 0;
      reason = p.allowShort
        ? "Vol gate open and close broke below breakout channel."
        : "Vol gate open but downside breakout ignored because shorting is disabled.";
    } else if (state.gateOpen && cooldownActive) {
      reason = "Vol gate open but cooldown suppresses repeated breakout entries.";
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
    strategy: "volBreakout",
    signal,
    reason,
    indicators: {
      close,
      breakoutHigh,
      breakoutLow,
      exitHigh,
      exitLow,
      ...volGateIndicators(state, p),
      volCooldownBars: p.volCooldownBars,
      cooldownActive: cooldownActive ? 1 : 0,
    },
  };
}

function evaluateVolTrend(
  candles: MarketData[],
  index: number,
  currentPosition: PositionSignal,
  p: ResolvedStrategyParams
): StrategyDecision {
  const minBars = Math.max(
    p.trendSlowPeriod,
    p.volWindowBars + p.volBaselineBars + 2
  );
  if (index + 1 < minBars) {
    return {
      strategy: "volTrend",
      signal: 0,
      reason: "Not enough bars for vol-trend signal.",
      indicators: { bars: index + 1 },
    };
  }

  const state = getVolGateState(candles, index, p);
  if (currentPosition === 0 && !state.gateOpen) {
    return {
      strategy: "volTrend",
      signal: 0,
      reason: "Vol gate closed; trend entries suppressed.",
      indicators: {
        close: candles[index].close,
        ...volGateIndicators(state, p),
      },
    };
  }

  const trend = evaluateTrend(candles, index, currentPosition, p);
  let reason = trend.reason;
  if (currentPosition === 0 && state.gateOpen) {
    reason =
      trend.signal === 0
        ? "Vol gate open but trend signal is neutral."
        : `Vol gate open. ${trend.reason}`;
  } else if (currentPosition !== 0 && !state.gateOpen) {
    reason = `Vol gate closed, but existing position still follows trend exit logic. ${trend.reason}`;
  }

  return {
    strategy: "volTrend",
    signal: trend.signal,
    reason,
    indicators: {
      ...trend.indicators,
      ...volGateIndicators(state, p),
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

  const longVotes = [
    trend.signal,
    meanReversion.signal,
    breakout.signal,
  ].filter(s => s > 0).length;
  const shortVotes = [
    trend.signal,
    meanReversion.signal,
    breakout.signal,
  ].filter(s => s < 0).length;

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
