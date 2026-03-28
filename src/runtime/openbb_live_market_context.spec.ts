import { describe, expect, it, vi } from "vitest";
import { createOpenBBCryptoLiveMarketContext } from "./openbb_live_market_context.js";

describe("openbb_live_market_context", () => {
  it("falls back to provider-compatible crypto symbols when slash pair returns no rows", async () => {
    const getHistorical = vi.fn(async (params: Record<string, unknown>) => {
      if (params.symbol === "BTC/USD") {
        return [];
      }
      if (params.symbol === "BTC-USD") {
        return [
          {
            date: "2026-03-17T00:00:00",
            open: 80000,
            high: 80500,
            low: 79500,
            close: 80250,
            volume: 123,
          },
        ];
      }
      return [];
    });

    const ctx = createOpenBBCryptoLiveMarketContext({
      client: { getHistorical } as any,
      symbols: ["BTC/USD"],
      interval: "1h",
      now: () => new Date("2026-03-17T12:00:00.000Z"),
    });

    const rows = await ctx.marketDataProvider.getMarketDataRange(
      new Date("2026-03-16T00:00:00.000Z"),
      new Date("2026-03-17T12:00:00.000Z"),
      "BTC/USD",
    );

    expect(getHistorical).toHaveBeenCalledTimes(2);
    expect(getHistorical).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ symbol: "BTC/USD" }),
    );
    expect(getHistorical).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ symbol: "BTC-USD" }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("BTC/USD");
    expect(rows[0].sourceDomain).toBe("openbb");
  });

  it("continues symbol fallback when the first provider call throws", async () => {
    const getHistorical = vi.fn(async (params: Record<string, unknown>) => {
      if (params.symbol === "BTC/USD") {
        throw new Error("OpenBB API error 400 on /price/historical: unsupported symbol");
      }
      if (params.symbol === "BTC-USD") {
        return [
          {
            date: "2026-03-17T00:00:00",
            open: 80000,
            high: 80500,
            low: 79500,
            close: 80250,
            volume: 123,
          },
        ];
      }
      return [];
    });

    const ctx = createOpenBBCryptoLiveMarketContext({
      client: { getHistorical } as any,
      symbols: ["BTC/USD"],
      interval: "1h",
      now: () => new Date("2026-03-17T12:00:00.000Z"),
    });

    const rows = await ctx.marketDataProvider.getMarketDataRange(
      new Date("2026-03-16T00:00:00.000Z"),
      new Date("2026-03-17T12:00:00.000Z"),
      "BTC/USD",
    );

    expect(getHistorical).toHaveBeenCalledTimes(2);
    expect(getHistorical).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ symbol: "BTC/USD" }),
    );
    expect(getHistorical).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ symbol: "BTC-USD" }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("BTC/USD");
  });

  it("keeps the original symbol when the first request returns data", async () => {
    const getHistorical = vi.fn(async () => [
      {
        date: "2026-03-17T11:00:00",
        open: 80000,
        high: 80500,
        low: 79500,
        close: 80250,
        volume: 123,
      },
    ]);

    const ctx = createOpenBBCryptoLiveMarketContext({
      client: { getHistorical } as any,
      symbols: ["BTC-USD"],
      interval: "1h",
      now: () => new Date("2026-03-17T12:00:00"),
    });

    const latest = await ctx.marketDataProvider.getMarketData(
      new Date("2026-03-17T12:00:00"),
      "BTC-USD",
    );

    expect(getHistorical).toHaveBeenCalledTimes(1);
    expect(latest.symbol).toBe("BTC-USD");
  });

  it("drops non-aligned partial rows before returning bars", async () => {
    const getHistorical = vi.fn(async () => [
      {
        date: "2026-03-17T11:00:00",
        open: 80000,
        high: 80500,
        low: 79500,
        close: 80250,
        volume: 123,
      },
      {
        date: "2026-03-17T11:11:00",
        open: 80250,
        high: 80300,
        low: 80100,
        close: 80200,
        volume: 50,
      },
    ]);

    const ctx = createOpenBBCryptoLiveMarketContext({
      client: { getHistorical } as any,
      symbols: ["BTC/USD"],
      interval: "1h",
      now: () => new Date("2026-03-17T12:00:00.000Z"),
    });

    const rows = await ctx.marketDataProvider.getMarketDataRange(
      new Date("2026-03-17T00:00:00.000Z"),
      new Date("2026-03-17T12:00:00.000Z"),
      "BTC/USD",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].tsOpenMs).toBe(Date.parse("2026-03-17T11:00:00"));
  });
});
