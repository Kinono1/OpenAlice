import type { LiveMarketDataBar } from "./live_gate_manager.js";

export interface DataContractConfig {
  barIntervalMs: number;
  clockSkewThresholdMs: number;
  maxMissingBarsInExecutionWindow: number;
}

export interface DataContractEvaluation {
  dataQualityValid: boolean;
  blockingReasons: string[];
  duplicateBarsDetected: boolean;
  missingBarCount: number;
  timestampAligned: boolean;
  allBarsCompleted: boolean;
  validOhlc: boolean;
  clockSkewValid: boolean;
}

export const DEFAULT_DATA_CONTRACT_CONFIG: DataContractConfig = {
  barIntervalMs: 60 * 60 * 1000,
  clockSkewThresholdMs: 30_000,
  maxMissingBarsInExecutionWindow: 0,
};

function normalizeTs(bar: LiveMarketDataBar): number {
  return bar.tsOpenMs ?? bar.time * 1000;
}

function isValidOhlc(bar: LiveMarketDataBar): boolean {
  const { open, high, low, close } = bar;
  if (
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close) ||
    open <= 0 ||
    high <= 0 ||
    low <= 0 ||
    close <= 0
  ) {
    return false;
  }
  return high >= Math.max(open, close) && low <= Math.min(open, close);
}

export function evaluateDataContract(
  bars: LiveMarketDataBar[],
  config: Partial<DataContractConfig> = {},
): DataContractEvaluation {
  const resolved = {
    ...DEFAULT_DATA_CONTRACT_CONFIG,
    ...config,
  };
  const blockingReasons: string[] = [];

  if (bars.length === 0) {
    return {
      dataQualityValid: false,
      blockingReasons: ["data_contract_empty_window"],
      duplicateBarsDetected: false,
      missingBarCount: 0,
      timestampAligned: false,
      allBarsCompleted: false,
      validOhlc: false,
      clockSkewValid: false,
    };
  }

  const sorted = [...bars].sort((a, b) => normalizeTs(a) - normalizeTs(b));
  const seen = new Set<number>();
  let duplicateBarsDetected = false;
  let missingBarCount = 0;
  let timestampAligned = true;
  let allBarsCompleted = true;
  let validOhlc = true;
  let clockSkewValid = true;

  for (let i = 0; i < sorted.length; i++) {
    const bar = sorted[i];
    const ts = normalizeTs(bar);
    if (seen.has(ts)) {
      duplicateBarsDetected = true;
    }
    seen.add(ts);

    if (ts % resolved.barIntervalMs !== 0) {
      timestampAligned = false;
    }
    if (bar.completed !== true) {
      allBarsCompleted = false;
    }
    if (!isValidOhlc(bar)) {
      validOhlc = false;
    }
    if (
      typeof bar.clockSkewMs === "number" &&
      Math.abs(bar.clockSkewMs) > resolved.clockSkewThresholdMs
    ) {
      clockSkewValid = false;
    }

    if (i > 0) {
      const prevTs = normalizeTs(sorted[i - 1]);
      const gapBars = Math.round((ts - prevTs) / resolved.barIntervalMs) - 1;
      if (gapBars > 0) {
        missingBarCount += gapBars;
      }
    }
  }

  if (duplicateBarsDetected) {
    blockingReasons.push("data_contract_duplicate_bar");
  }
  if (missingBarCount > resolved.maxMissingBarsInExecutionWindow) {
    blockingReasons.push("data_contract_missing_bar");
  }
  if (!timestampAligned) {
    blockingReasons.push("data_contract_timestamp_misaligned");
  }
  if (!allBarsCompleted) {
    blockingReasons.push("data_contract_incomplete_bar");
  }
  if (!validOhlc) {
    blockingReasons.push("data_contract_invalid_ohlc");
  }
  if (!clockSkewValid) {
    blockingReasons.push("data_contract_clock_skew");
  }

  return {
    dataQualityValid: blockingReasons.length === 0,
    blockingReasons,
    duplicateBarsDetected,
    missingBarCount,
    timestampAligned,
    allBarsCompleted,
    validOhlc,
    clockSkewValid,
  };
}
