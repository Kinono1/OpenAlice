import { describe, expect, it } from "vitest";
import type { CryptoPosition } from "../extension/crypto-trading/interfaces.js";
import { buildPortfolioTargetFromWeights } from "../portfolio/target.js";
import { buildPaperExecutionPlan } from "./paper_execution_plan.js";

const pricesBySymbol = {
  "BTC/USD": 100,
  "ETH/USD": 50,
};

const emptyPositions: CryptoPosition[] = [];

function createTarget() {
  return buildPortfolioTargetFromWeights({
    basisEquityUsd: 1_000,
    weights: {
      "BTC/USD": 0.6,
      "ETH/USD": 0.4,
    },
    maxTurnoverPct: 1,
  });
}

describe("paper_execution_plan", () => {
  it("blocks when promotion is blocked", () => {
    const plan = buildPaperExecutionPlan({
      promotionPass: false,
      paperGateAllowsPaperTrading: true,
      championRegistryState: "valid",
      regimeSeverity: "stable",
      portfolioTarget: createTarget(),
      currentPositions: emptyPositions,
      pricesBySymbol,
    });

    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") {
      expect(plan.blockingReasons).toContain("promotion_gate_blocked");
    }
  });

  it("blocks when paper gate is blocked", () => {
    const plan = buildPaperExecutionPlan({
      promotionPass: true,
      paperGateAllowsPaperTrading: false,
      championRegistryState: "valid",
      regimeSeverity: "stable",
      portfolioTarget: createTarget(),
      currentPositions: emptyPositions,
      pricesBySymbol,
    });

    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") {
      expect(plan.blockingReasons).toContain("paper_gate_blocked");
    }
  });

  it("blocks on missing registry", () => {
    const plan = buildPaperExecutionPlan({
      promotionPass: true,
      paperGateAllowsPaperTrading: true,
      championRegistryState: "missing",
      regimeSeverity: "stable",
      portfolioTarget: createTarget(),
      currentPositions: emptyPositions,
      pricesBySymbol,
    });

    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") {
      expect(plan.blockingReasons).toContain("paper_champion_registry_missing");
    }
  });

  it("blocks on invalid registry", () => {
    const plan = buildPaperExecutionPlan({
      promotionPass: true,
      paperGateAllowsPaperTrading: true,
      championRegistryState: "invalid",
      regimeSeverity: "stable",
      portfolioTarget: createTarget(),
      currentPositions: emptyPositions,
      pricesBySymbol,
    });

    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") {
      expect(plan.blockingReasons).toContain("paper_champion_registry_invalid");
    }
  });

  it("blocks on high-severity regime", () => {
    const plan = buildPaperExecutionPlan({
      promotionPass: true,
      paperGateAllowsPaperTrading: true,
      championRegistryState: "valid",
      regimeSeverity: "high",
      portfolioTarget: createTarget(),
      currentPositions: emptyPositions,
      pricesBySymbol,
    });

    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") {
      expect(plan.blockingReasons).toContain(
        "regime_high_blocks_new_exposure",
      );
    }
  });

  it("keeps blocked reasons explicit and deterministic", () => {
    const plan = buildPaperExecutionPlan({
      promotionPass: false,
      paperGateAllowsPaperTrading: false,
      championRegistryState: "invalid",
      regimeSeverity: "high",
      portfolioTarget: createTarget(),
      currentPositions: emptyPositions,
      pricesBySymbol,
    });

    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") {
      expect(plan.blockingReasons).toEqual([
        "promotion_gate_blocked",
        "paper_gate_blocked",
        "paper_champion_registry_invalid",
        "regime_high_blocks_new_exposure",
      ]);
    }
  });

  it("builds an active stable execution plan for BTC and ETH portfolio targets", () => {
    const plan = buildPaperExecutionPlan({
      promotionPass: true,
      paperGateAllowsPaperTrading: true,
      paperGateMode: "active",
      paperGateAllowsExecution: true,
      championRegistryState: "valid",
      championSetComplete: true,
      regimeSeverity: "stable",
      portfolioTarget: createTarget(),
      currentPositions: emptyPositions,
      pricesBySymbol,
    });

    expect(plan.kind).toBe("active");
    if (plan.kind === "active") {
      expect(plan.targetSymbols).toEqual(["BTC/USD", "ETH/USD"]);
      expect(plan.rebalancePlan.entries.map(entry => entry.symbol)).toEqual([
        "BTC/USD",
        "ETH/USD",
      ]);
      expect(plan.rebalancePlan.totalPlannedTurnoverUsd).toBeCloseTo(1000, 8);
      expect(plan.walletOperations).toEqual([
        {
          action: "placeOrder",
          params: {
            symbol: "BTC/USD",
            side: "buy",
            type: "market",
            usd_size: 600,
          },
        },
        {
          action: "placeOrder",
          params: {
            symbol: "ETH/USD",
            side: "buy",
            type: "market",
            usd_size: 400,
          },
        },
      ]);
    }
  });

  it("scales turnover in watch regime when an override cap is provided", () => {
    const plan = buildPaperExecutionPlan({
      promotionPass: true,
      paperGateAllowsPaperTrading: true,
      paperGateMode: "active",
      paperGateAllowsExecution: true,
      championRegistryState: "valid",
      championSetComplete: true,
      regimeSeverity: "watch",
      portfolioTarget: createTarget(),
      currentPositions: emptyPositions,
      pricesBySymbol,
      turnoverCap: 1,
    });

    expect(plan.kind).toBe("active");
    if (plan.kind === "active") {
      expect(plan.portfolioTarget.maxTurnoverPct).toBeCloseTo(0.5, 8);
      expect(plan.rebalancePlan.totalPlannedTurnoverUsd).toBeCloseTo(500, 8);
      expect(plan.walletOperations).toEqual([
        {
          action: "placeOrder",
          params: {
            symbol: "BTC/USD",
            side: "buy",
            type: "market",
            usd_size: 300,
          },
        },
        {
          action: "placeOrder",
          params: {
            symbol: "ETH/USD",
            side: "buy",
            type: "market",
            usd_size: 200,
          },
        },
      ]);
    }
  });

  it("returns a flat plan when explicit paper gate mode is flat-only", () => {
    const plan = buildPaperExecutionPlan({
      promotionPass: true,
      paperGateAllowsPaperTrading: false,
      paperGateMode: "flat",
      paperGateAllowsExecution: true,
      paperGateFlatOnlyReasons: ["paper_stability_window_incomplete"],
      championRegistryState: "valid",
      championSetComplete: true,
      regimeSeverity: "stable",
      portfolioTarget: createTarget(),
      currentPositions: [
        {
          symbol: "BTC/USD",
          side: "long",
          size: 4,
          entryPrice: 100,
          markPrice: 100,
          unrealizedPnl: 0,
          leverage: 1,
          liquidationPrice: null,
        },
      ],
      pricesBySymbol,
    });

    expect(plan.kind).toBe("flat");
    if (plan.kind === "flat") {
      expect(plan.flatReasons).toEqual(["paper_stability_window_incomplete"]);
      expect(plan.portfolioTarget.targetGrossExposure).toBe(0);
      expect(plan.walletOperations).toEqual([
        {
          action: "closePosition",
          params: {
            symbol: "BTC/USD",
            size: 4,
          },
        },
      ]);
    }
  });

  it("forces flat mode on high-severity regime when explicit paper gate data is available", () => {
    const plan = buildPaperExecutionPlan({
      promotionPass: true,
      paperGateAllowsPaperTrading: true,
      paperGateMode: "active",
      paperGateAllowsExecution: true,
      championRegistryState: "valid",
      championSetComplete: true,
      regimeSeverity: "high",
      portfolioTarget: createTarget(),
      currentPositions: emptyPositions,
      pricesBySymbol,
    });

    expect(plan.kind).toBe("flat");
    if (plan.kind === "flat") {
      expect(plan.flatReasons).toContain("regime_high_blocks_new_exposure");
    }
  });

  it("preserves legacy blocking behavior when richer paper gate fields are absent", () => {
    const plan = buildPaperExecutionPlan({
      promotionPass: false,
      paperGateAllowsPaperTrading: true,
      championRegistryState: "valid",
      regimeSeverity: "stable",
      portfolioTarget: createTarget(),
      currentPositions: emptyPositions,
      pricesBySymbol,
    });

    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") {
      expect(plan.blockingReasons).toEqual(["promotion_gate_blocked"]);
    }
  });
});
