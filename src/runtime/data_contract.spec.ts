import { describe, expect, it } from "vitest";
import { evaluateDataContract } from "./data_contract.js";
import type { LiveMarketDataBar } from "./live_gate_manager.js";

function makeBar(
  tsOpenMs: number,
  overrides: Partial<LiveMarketDataBar> = {},
): LiveMarketDataBar {
  return {
    symbol: "BTC/USD",
    time: Math.floor(tsOpenMs / 1000),
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1000,
    tsOpenMs,
    barIntervalMs: 60 * 60 * 1000,
    barCloseMs: tsOpenMs + 60 * 60 * 1000,
    completed: true,
    sourceDomain: "openbb",
    ...overrides,
  };
}

describe("data_contract", () => {
  it("passes a clean completed bar window", () => {
    const start = Date.parse("2026-03-14T00:00:00.000Z");
    const result = evaluateDataContract([
      makeBar(start),
      makeBar(start + 60 * 60 * 1000),
      makeBar(start + 2 * 60 * 60 * 1000),
    ]);

    expect(result.dataQualityValid).toBe(true);
    expect(result.blockingReasons).toHaveLength(0);
  });

  it("fails duplicate, incomplete, and missing bar conditions", () => {
    const start = Date.parse("2026-03-14T00:00:00.000Z");
    const result = evaluateDataContract([
      makeBar(start),
      makeBar(start, { completed: false }),
      makeBar(start + 2 * 60 * 60 * 1000),
    ]);

    expect(result.dataQualityValid).toBe(false);
    expect(result.blockingReasons).toContain("data_contract_duplicate_bar");
    expect(result.blockingReasons).toContain("data_contract_missing_bar");
    expect(result.blockingReasons).toContain("data_contract_incomplete_bar");
  });

  it("fails timestamp alignment, invalid ohlc, and clock skew", () => {
    const result = evaluateDataContract([
      makeBar(Date.parse("2026-03-14T00:30:00.000Z"), {
        high: 98,
        low: 99,
        clockSkewMs: 45_000,
      }),
    ]);

    expect(result.dataQualityValid).toBe(false);
    expect(result.blockingReasons).toContain(
      "data_contract_timestamp_misaligned",
    );
    expect(result.blockingReasons).toContain("data_contract_invalid_ohlc");
    expect(result.blockingReasons).toContain("data_contract_clock_skew");
  });
});
