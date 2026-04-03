import { describe, expect, it } from "vitest";
import { planPortfolioRebalance } from "./rebalance.js";
import { buildPortfolioTargetFromWeights } from "./target.js";

describe("portfolio rebalance planner", () => {
  it("reduces existing exposure and opens missing target legs", () => {
    const target = buildPortfolioTargetFromWeights({
      basisEquityUsd: 1_000,
      weights: {
        "BTC/USD": 0.2,
        "ETH/USD": 0.3,
      },
      maxTurnoverPct: 1,
    });

    const plan = planPortfolioRebalance({
      target,
      currentPositions: [
        {
          symbol: "BTC/USD",
          side: "long",
          size: 2,
          entryPrice: 190,
          leverage: 1,
          margin: 400,
          liquidationPrice: 100,
          markPrice: 200,
          unrealizedPnL: 20,
          positionValue: 400,
        },
      ],
      pricesBySymbol: {
        "BTC/USD": 200,
        "ETH/USD": 100,
      },
    });

    expect(plan.entries).toHaveLength(2);
    const btc = plan.entries.find(entry => entry.symbol === "BTC/USD");
    const eth = plan.entries.find(entry => entry.symbol === "ETH/USD");
    expect(btc?.action).toBe("reduce_long");
    expect(btc?.operations).toEqual([
      {
        action: "closePosition",
        params: {
          symbol: "BTC/USD",
          size: 1,
        },
      },
    ]);
    expect(eth?.action).toBe("open_long");
    expect(eth?.operations).toEqual([
      {
        action: "placeOrder",
        params: {
          symbol: "ETH/USD",
          side: "buy",
          type: "market",
          usd_size: 300,
        },
      },
    ]);
  });

  it("clips rebalance turnover against the portfolio target cap", () => {
    const target = buildPortfolioTargetFromWeights({
      basisEquityUsd: 1_000,
      weights: {
        "BTC/USD": 1,
      },
      maxTurnoverPct: 0.2,
    });

    const plan = planPortfolioRebalance({
      target,
      currentPositions: [],
      pricesBySymbol: {
        "BTC/USD": 100,
      },
    });

    expect(plan.scaleApplied).toBeCloseTo(0.2, 8);
    expect(plan.totalPlannedTurnoverUsd).toBeCloseTo(200, 8);
    expect(plan.entries[0].operations[0]).toEqual({
      action: "placeOrder",
      params: {
        symbol: "BTC/USD",
        side: "buy",
        type: "market",
        usd_size: 200,
      },
    });
  });

  it("flips opposing exposure by closing first and reopening in the new direction", () => {
    const target = buildPortfolioTargetFromWeights({
      basisEquityUsd: 1_000,
      weights: {
        "BTC/USD": 0.25,
      },
      maxTurnoverPct: 1,
    });

    const plan = planPortfolioRebalance({
      target,
      currentPositions: [
        {
          symbol: "BTC/USD",
          side: "short",
          size: 1,
          entryPrice: 100,
          leverage: 1,
          margin: 100,
          liquidationPrice: 200,
          markPrice: 100,
          unrealizedPnL: 0,
          positionValue: 100,
        },
      ],
      pricesBySymbol: {
        "BTC/USD": 100,
      },
    });

    expect(plan.entries[0].action).toBe("flip_to_long");
    expect(plan.entries[0].operations).toEqual([
      {
        action: "closePosition",
        params: {
          symbol: "BTC/USD",
          size: 1,
        },
      },
      {
        action: "placeOrder",
        params: {
          symbol: "BTC/USD",
          side: "buy",
          type: "market",
          usd_size: 250,
        },
      },
    ]);
  });
});
