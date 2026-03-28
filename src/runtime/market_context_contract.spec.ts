import { describe, expect, it } from "vitest";
import {
  buildMarketContextV1,
  validateMarketContextV1,
} from "./market_context_contract.js";
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

describe("market_context_contract", () => {
  it("builds and validates a canonical market context payload", () => {
    const start = Date.parse("2026-03-26T00:00:00.000Z");
    const payload = buildMarketContextV1({
      generatedAt: "2026-03-26T12:00:00.000Z",
      symbol: "BTC/USD",
      interval: "1h",
      lookbackBars: 3,
      playheadTime: "2026-03-26T12:00:00.000Z",
      availableSymbols: ["BTC/USD", "ETH/USD"],
      provider: "openbb",
      bars: [
        makeBar(start),
        makeBar(start + 60 * 60 * 1000),
        makeBar(start + 2 * 60 * 60 * 1000),
      ],
    });

    expect(payload.schemaVersion).toBe("market_context.v1");
    expect(payload.bars).toHaveLength(3);
    expect(validateMarketContextV1(payload).valid).toBe(true);
  });

  it("rejects malformed or data-contract-invalid market context payloads", () => {
    const start = Date.parse("2026-03-26T00:00:00.000Z");
    const result = validateMarketContextV1({
      schemaVersion: "market_context.v1",
      generatedAt: "2026-03-26T12:00:00.000Z",
      symbol: "BTC/USD",
      interval: "1h",
      lookbackBars: 2,
      playheadTime: "2026-03-26T12:00:00.000Z",
      availableSymbols: ["BTC/USD"],
      source: {
        provider: "openbb",
        mode: "native",
      },
      bars: [
        makeBar(start),
        makeBar(start + 2 * 60 * 60 * 1000, { completed: false }),
      ],
    });

    expect(result.valid).toBe(false);
    expect(
      result.blockingReasons.some((reason) =>
        reason.includes("market_context_data_contract_failed"),
      ),
    ).toBe(true);
  });
});
