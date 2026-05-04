import { describe, expect, it } from "vitest";
import type { CryptoPosition } from "../domain/trading/operation-dispatcher.types.js";
import { buildPortfolioTargetFromWeights } from "../portfolio/target.js";
import { buildPaperExecutionPlan } from "./paper_execution_plan.js";
import {
  PROMOTION_V2_SCHEMA_VERSION,
  buildPromotionReadinessV2,
  makeGateResult,
  type PromotionReadinessV2,
} from "./promotion_v2.js";

const pricesBySymbol = {
  "BTC/USD": 100,
  "ETH/USD": 50,
};

const emptyPositions: CryptoPosition[] = [];
const now = new Date("2026-04-30T12:00:00.000Z");
const future = "2026-04-30T13:00:00.000Z";

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

function createPromotionReadiness(
  overrides: Partial<PromotionReadinessV2> = {},
): PromotionReadinessV2 {
  const readiness = buildPromotionReadinessV2({
    schemaMeta: {
      schemaName: "strategy_promotion",
      schemaVersion: PROMOTION_V2_SCHEMA_VERSION,
      createdBy: "vitest",
      createdAt: now.toISOString(),
      codeCommit: "test",
    },
    strategyId: "cross-sectional-v2",
    experimentId: "experiment-1",
    generatedAt: now.toISOString(),
    globalReleaseGate: makeGateResult({ gateName: "global_release", expiresAt: future }),
    researchGate: makeGateResult({ gateName: "research", expiresAt: future }),
    monetizationGate: makeGateResult({ gateName: "monetization", expiresAt: future }),
    paperGate: makeGateResult({ gateName: "paper", expiresAt: future }),
    liveGate: makeGateResult({
      gateName: "live",
      hardBlocks: ["tiny_cap_not_reviewed"],
      expiresAt: future,
    }),
    monetization: {
      netExpectancyBpsPerTrade: 30,
      netExpectancyUsdPerTrade: 3,
      netExpectancyUsdPerDay: 6,
      netExpectancyUsdPerMonth: 180,
      validSignalsPerMonth: 30,
      executableCapacityUsd: 5_000,
      turnoverPerDay: 0.2,
      routeAdjustedBreakEvenBps: 14,
      benchmarkExcessReturnBps: 18,
    },
    execution: {
      recentOrderCount: 20,
      slippageViolationCount: 0,
      actualToSimulatedCostRatio: 1.1,
      missedFillRate: 0.2,
      decayCircuitBreakerTriggered: false,
    },
    dataFreshness: {
      latestDecisionStatus: "fresh",
      staleBlockCount: 0,
      maxDataLatencyMinutes: 3,
    },
    evidence: {
      supportingEvidenceIds: ["evidence-1"],
      blockingEvidenceIds: [],
      missingRequiredEvidence: [],
    },
    now,
  });

  return {
    ...readiness,
    ...overrides,
  };
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

  it("blocks when v2.6 promotion readiness is required but missing", () => {
    const plan = buildPaperExecutionPlan({
      promotionPass: true,
      paperGateAllowsPaperTrading: true,
      requirePromotionV2: true,
      championRegistryState: "valid",
      regimeSeverity: "stable",
      portfolioTarget: createTarget(),
      currentPositions: emptyPositions,
      pricesBySymbol,
      now,
    });

    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") {
      expect(plan.blockingReasons).toContain("promotion_v2_readiness_missing");
    }
  });

  it("blocks when v2.6 promotion readiness is not paper-allowed", () => {
    const plan = buildPaperExecutionPlan({
      promotionPass: true,
      paperGateAllowsPaperTrading: true,
      promotionReadinessV2: createPromotionReadiness({
        finalVerdict: "research_only",
        humanReadableReason: "monetization:gross_to_cost_ratio_below_threshold",
      }),
      championRegistryState: "valid",
      regimeSeverity: "stable",
      portfolioTarget: createTarget(),
      currentPositions: emptyPositions,
      pricesBySymbol,
      now,
    });

    expect(plan.kind).toBe("blocked");
    if (plan.kind === "blocked") {
      expect(plan.blockingReasons).toContain("promotion_v2_blocks_paper_orders:research_only");
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
          leverage: 1,
          margin: 400,
          liquidationPrice: 0,
          markPrice: 100,
          unrealizedPnL: 0,
          positionValue: 400,
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
