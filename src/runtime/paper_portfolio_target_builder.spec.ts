import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { NewsItem } from "../extension/analysis-kit/data/interfaces.js";
import type { KlineStore } from "../extension/analysis-kit/kline/KlineStore.js";
import type {
  CryptoAccountInfo,
  ICryptoTradingEngine,
} from "../domain/trading/operation-dispatcher.types.js";
import { buildPaperPortfolioTarget } from "./paper_portfolio_target_builder.js";

describe("paper_portfolio_target_builder", () => {
  it("builds a BTC+ETH target using trend candidates and news overlay", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "paper-portfolio-target-"));
    const candidatesPath = join(tempDir, "strategy_candidates.v1.json");
    await writeFile(
      candidatesPath,
      JSON.stringify(
        {
          candidates: [
            {
              strategy: "trend",
              applicableSymbols: ["BTC/USD", "ETH/USD"],
              params: {
                trendFastPeriod: 20,
                trendSlowPeriod: 55,
                allowShort: true,
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    const result = await buildPaperPortfolioTarget({
      engine: createEngine(),
      klineStore: createKlineStore(),
      newsProvider: {
        getNewsV2: vi.fn().mockResolvedValue(createNews()),
      },
      options: {
        symbols: ["BTC/USD", "ETH/USD"],
        releaseGateStatus: {
          version: 1,
          generatedAt: "2026-03-29T00:00:00.000Z",
          allowPaperTrading: true,
          allowLiveTrading: true,
          failedChecks: [],
          warningChecks: [],
        },
        candidateConfigPath: candidatesPath,
        now: new Date("2026-03-29T00:00:00.000Z"),
      },
    });

    expect(result.target.positions.map(position => position.symbol)).toEqual([
      "BTC/USD",
      "ETH/USD",
    ]);
    expect(result.decisions).toHaveLength(2);
    expect(result.target.targetGrossExposure).toBeGreaterThan(0);
  });
});

function createEngine(): ICryptoTradingEngine {
  return {
    placeOrder: vi.fn() as unknown as ICryptoTradingEngine["placeOrder"],
    getPositions: vi.fn().mockResolvedValue([]),
    getOrders: vi.fn().mockResolvedValue([]),
    getAccount: vi.fn().mockResolvedValue({
      balance: 1000,
      totalMargin: 0,
      unrealizedPnL: 0,
      equity: 1000,
      realizedPnL: 0,
      totalPnL: 0,
    } satisfies CryptoAccountInfo),
    cancelOrder: vi.fn() as unknown as ICryptoTradingEngine["cancelOrder"],
    adjustLeverage: vi.fn() as unknown as ICryptoTradingEngine["adjustLeverage"],
    getTicker: vi.fn() as unknown as ICryptoTradingEngine["getTicker"],
    getFundingRate: vi.fn() as unknown as ICryptoTradingEngine["getFundingRate"],
    getOrderBook: vi.fn() as unknown as ICryptoTradingEngine["getOrderBook"],
  };
}

function createKlineStore(): KlineStore {
  const makeSeries = (symbol: string, base: number) =>
    Array.from({ length: 180 }, (_, idx) => ({
      symbol,
      time: 1_700_000_000 + idx * 3600,
      open: base + idx * 0.5,
      high: base + idx * 0.5 + 1,
      low: base + idx * 0.5 - 1,
      close: base + idx * 0.5 + 0.3,
      volume: 1000 + idx,
    }));

  const seriesBySymbol = {
    "BTC/USD": makeSeries("BTC/USD", 100),
    "ETH/USD": makeSeries("ETH/USD", 60),
  } as const;

  return {
    marketDataProvider: {
      getMarketData: vi.fn(async (_time: Date, symbol: string) => {
        const rows = seriesBySymbol[symbol as keyof typeof seriesBySymbol];
        return rows[rows.length - 1];
      }),
      getMarketDataRange: vi.fn(
        async (_startTime: Date, _endTime: Date, symbol: string) =>
          seriesBySymbol[symbol as keyof typeof seriesBySymbol] ?? [],
      ),
      getAvailableSymbols: vi.fn(() => ["BTC/USD", "ETH/USD"]),
    },
    getPlayheadTime: () => new Date("2026-03-29T00:00:00.000Z"),
    calculatePreviousTime: (lookbackBars: number) => {
      const now = new Date("2026-03-29T00:00:00.000Z");
      now.setHours(now.getHours() - lookbackBars);
      return now;
    },
    getAvailableSymbols: () => ["BTC/USD", "ETH/USD"],
  };
}

function createNews(): NewsItem[] {
  return [
    {
      time: new Date("2026-03-28T20:00:00.000Z"),
      title: "Spot ETF inflows support Bitcoin accumulation",
      content: "ETF inflow and strategic reserve commentary mildly favor BTC.",
      metadata: { source: "Reuters" },
    },
    {
      time: new Date("2026-03-28T21:00:00.000Z"),
      title: "Ethereum roadmap upgrade wins developer support",
      content: "Upgrade and developer momentum support ETH follow-through.",
      metadata: { source: "TechFlow" },
    },
  ];
}
