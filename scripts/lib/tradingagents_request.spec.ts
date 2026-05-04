import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  normalizeNewsItem,
  readCandles,
  readNewsItems,
} from "./tradingagents_request.js";

describe("tradingagents_request", () => {
  it("returns an empty candle set for an out-of-range strict window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openalice-ta-request-"));
    const csv = join(dir, "btc.csv");
    await writeFile(
      csv,
      [
        "timestamp,iso,open,high,low,close,volume",
        "1,2026-01-01T00:00:00.000Z,100,110,90,105,10",
        "2,2026-01-01T01:00:00.000Z,105,112,101,108,12",
      ].join("\n"),
      "utf-8",
    );

    const candles = await readCandles(csv, {
      lookbackBars: 10,
      windowStart: "2026-02-01T00:00:00.000Z",
      windowEnd: "2026-02-02T00:00:00.000Z",
    });

    expect(candles).toEqual([]);
  });

  it("normalizes news into the strict sidecar fields", async () => {
    expect(
      normalizeNewsItem({
        title: "BTC ETF flow stabilizes",
        description: "Spot ETF outflows slowed during the US session.",
        publisher: "Market Desk",
        published_at: "2026-04-11T00:00:00.000Z",
        link: "https://example.test/news",
      }),
    ).toEqual({
      headline: "BTC ETF flow stabilizes",
      summary: "Spot ETF outflows slowed during the US session.",
      source: "Market Desk",
      publishedAt: "2026-04-11T00:00:00.000Z",
      url: "https://example.test/news",
    });
  });

  it("reads JSONL news files and preserves headline summary source publishedAt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openalice-ta-news-"));
    const news = join(dir, "news.jsonl");
    await writeFile(
      news,
      [
        JSON.stringify({
          headline: "Miner selling cools",
          summary: "Desk flow shows lighter miner sell pressure.",
          source: "FlowWire",
          publishedAt: "2026-04-11T01:00:00.000Z",
        }),
        JSON.stringify({
          headline: "Volatility ticked higher",
          summary: "Options desks raised near-term implied volatility.",
          source: "VolDesk",
          publishedAt: "2026-04-11T02:00:00.000Z",
        }),
      ].join("\n"),
      "utf-8",
    );

    await expect(readNewsItems(news)).resolves.toEqual([
      {
        headline: "Miner selling cools",
        summary: "Desk flow shows lighter miner sell pressure.",
        source: "FlowWire",
        publishedAt: "2026-04-11T01:00:00.000Z",
      },
      {
        headline: "Volatility ticked higher",
        summary: "Options desks raised near-term implied volatility.",
        source: "VolDesk",
        publishedAt: "2026-04-11T02:00:00.000Z",
      },
    ]);
  });
});
