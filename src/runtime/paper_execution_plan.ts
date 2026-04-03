import type { CryptoPosition } from "../extension/crypto-trading/interfaces.js";
import type { PortfolioRebalancePlan } from "../portfolio/rebalance.js";
import { planPortfolioRebalance } from "../portfolio/rebalance.js";
import {
  buildPortfolioTargetFromWeights,
  type PortfolioTarget,
} from "../portfolio/target.js";
import type { PaperGateMode } from "./paper_gate.js";

export type PaperExecutionPlan =
  | BlockedPaperExecutionPlan
  | FlatPaperExecutionPlan
  | ActivePaperExecutionPlan;

export interface BlockedPaperExecutionPlan {
  kind: "blocked";
  blockingReasons: string[];
  decidedAt: string;
}

export interface ActivePaperExecutionPlan {
  kind: "active";
  decidedAt: string;
  targetSymbols: string[];
  portfolioTarget: PortfolioTarget;
  rebalancePlan: PortfolioRebalancePlan;
  walletOperations: Array<Record<string, unknown>>;
}

export interface FlatPaperExecutionPlan {
  kind: "flat";
  decidedAt: string;
  flatReasons: string[];
  targetSymbols: string[];
  portfolioTarget: PortfolioTarget;
  rebalancePlan: PortfolioRebalancePlan;
  walletOperations: Array<Record<string, unknown>>;
}

export interface PaperExecutionPlanInput {
  promotionPass: boolean;
  paperGateAllowsPaperTrading: boolean;
  paperGateMode?: PaperGateMode;
  paperGateAllowsExecution?: boolean;
  paperGateBlockingReasons?: string[];
  paperGateFlatOnlyReasons?: string[];
  championRegistryState: "valid" | "missing" | "invalid";
  championSetComplete?: boolean;
  regimeSeverity?: "stable" | "watch" | "high";
  portfolioTarget: PortfolioTarget;
  currentPositions: CryptoPosition[];
  pricesBySymbol: Record<string, number>;
  turnoverCap?: number;
  now?: Date;
}

export function buildPaperExecutionPlan(
  input: PaperExecutionPlanInput,
): PaperExecutionPlan {
  const blockingReasons: string[] = [];
  const flatReasons: string[] = [];
  const useExplicitPaperGate =
    input.paperGateMode !== undefined ||
    input.paperGateAllowsExecution !== undefined ||
    input.paperGateBlockingReasons !== undefined ||
    input.paperGateFlatOnlyReasons !== undefined ||
    input.championSetComplete !== undefined;

  const paperGateMode = input.paperGateMode;
  const paperGateAllowsExecution =
    input.paperGateAllowsExecution ?? paperGateMode !== "blocked";

  if (useExplicitPaperGate) {
    if (!paperGateAllowsExecution || paperGateMode === "blocked") {
      blockingReasons.push(
        ...(input.paperGateBlockingReasons ?? ["paper_gate_blocked"]),
      );
    } else if (paperGateMode === "flat") {
      flatReasons.push(
        ...(input.paperGateFlatOnlyReasons ?? ["paper_gate_flat_only"]),
      );
    }
  } else {
    if (!input.promotionPass) {
      blockingReasons.push("promotion_gate_blocked");
    }
    if (!input.paperGateAllowsPaperTrading) {
      blockingReasons.push("paper_gate_blocked");
    }
  }

  if (!input.promotionPass) {
    if (useExplicitPaperGate) {
      flatReasons.push("promotion_gate_blocked");
    }
  }
  if (input.championRegistryState === "missing") {
    blockingReasons.push("paper_champion_registry_missing");
  } else if (input.championRegistryState === "invalid") {
    blockingReasons.push("paper_champion_registry_invalid");
  }
  if (
    useExplicitPaperGate &&
    input.championSetComplete === false &&
    input.championRegistryState === "valid"
  ) {
    flatReasons.push("paper_champion_set_incomplete");
  }
  if (input.regimeSeverity === "high") {
    if (useExplicitPaperGate) {
      flatReasons.push("regime_high_blocks_new_exposure");
    } else {
      blockingReasons.push("regime_high_blocks_new_exposure");
    }
  }

  const decidedAt = (input.now ?? new Date()).toISOString();
  if (blockingReasons.length > 0) {
    return {
      kind: "blocked",
      blockingReasons: unique(blockingReasons),
      decidedAt,
    };
  }

  if (flatReasons.length > 0) {
    const flatTarget = buildFlatPortfolioTarget(input.portfolioTarget, decidedAt);
    const rebalancePlan = planPortfolioRebalance({
      target: flatTarget,
      currentPositions: input.currentPositions,
      pricesBySymbol: input.pricesBySymbol,
    });

    return {
      kind: "flat",
      decidedAt,
      flatReasons: unique(flatReasons),
      targetSymbols: flatTarget.positions.map(position => position.symbol),
      portfolioTarget: flatTarget,
      rebalancePlan,
      walletOperations: rebalancePlan.entries.flatMap(entry =>
        entry.operations.map(operation => ({
          action: operation.action,
          params: { ...operation.params },
        })),
      ),
    };
  }

  const maxTurnoverPct = resolveMaxTurnoverPct(
    input.portfolioTarget.maxTurnoverPct,
    input.turnoverCap,
    input.regimeSeverity,
  );
  const effectiveTarget: PortfolioTarget = {
    ...input.portfolioTarget,
    maxTurnoverPct,
    notes: [
      ...(input.portfolioTarget.notes ?? []),
      input.regimeSeverity === "watch"
        ? `watch_regime_turnover_cap=${maxTurnoverPct}`
        : `runtime_turnover_cap=${maxTurnoverPct}`,
    ],
  };

  const rebalancePlan = planPortfolioRebalance({
    target: effectiveTarget,
    currentPositions: input.currentPositions,
    pricesBySymbol: input.pricesBySymbol,
  });

  return {
    kind: "active",
    decidedAt,
    targetSymbols: effectiveTarget.positions.map(position => position.symbol),
    portfolioTarget: effectiveTarget,
    rebalancePlan,
    walletOperations: rebalancePlan.entries.flatMap(entry =>
      entry.operations.map(operation => ({
        action: operation.action,
        params: { ...operation.params },
      })),
    ),
  };
}

function buildFlatPortfolioTarget(
  target: PortfolioTarget,
  generatedAt: string,
): PortfolioTarget {
  return buildPortfolioTargetFromWeights({
    basisEquityUsd: target.basisEquityUsd,
    generatedAt,
    maxTurnoverPct: target.maxTurnoverPct,
    weights: Object.fromEntries(
      target.positions.map(position => [position.symbol, 0]),
    ),
    notes: [
      ...(target.notes ?? []),
      "paper_execution_plan=flat_mode",
    ],
  });
}

function resolveMaxTurnoverPct(
  current: number,
  override: number | undefined,
  regimeSeverity: "stable" | "watch" | "high" | undefined,
): number {
  const base = positiveFinite(override ?? current, "maxTurnoverPct");
  if (regimeSeverity === "watch" && override !== undefined) {
    return base / 2;
  }
  return base;
}

function positiveFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive finite number.`);
  }
  return value;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
