import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { EventLog } from "../core/event-log.js";
import type {
  CryptoAccountInfo,
  CryptoPosition,
  ICryptoTradingEngine,
} from "../extension/crypto-trading/interfaces.js";
import {
  buildPaperExecutionPlan,
  type PaperExecutionPlan,
} from "./paper_execution_plan.js";
import { evaluatePaperGate, type PaperGateVerdict } from "./paper_gate.js";
import {
  buildPortfolioTargetFromWeights,
  type PortfolioTarget,
} from "../portfolio/target.js";

const supportedSources = ["tradingagents", "alphaswarm", "cryptotrade"] as const;

export const normalizedSidecarSignalSchema = z.object({
  signal_id: z.string().trim().min(1),
  source: z.enum(supportedSources),
  strategy_id: z.string().trim().min(1),
  symbol: z.string().trim().min(1),
  as_of: z.string().datetime(),
  ttl_ms: z.number().int().positive(),
  target_position_pct: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
  thesis: z.string().trim().min(1),
  risk_note: z.string().trim().min(1).optional(),
  trace: z.record(z.string(), z.unknown()).default({}),
});

export type NormalizedSidecarSignal = z.infer<typeof normalizedSidecarSignalSchema>;

export interface SidecarSignalIntakeOptions {
  signal: unknown;
  engine: ICryptoTradingEngine;
  eventLog: EventLog;
  now?: Date;
  supportedSymbols?: string[];
  maxTurnoverPct?: number;
  artifactPath?: string;
}

export interface SidecarSignalReadiness {
  ready: boolean;
  cryptoEngineConnected: boolean;
  supportedSymbols: string[];
  authEnforced: boolean;
  authConfigured: boolean;
  mode: "paper_only";
  reasons: string[];
}

export interface SidecarSignalIntakeResult {
  signal_id: string;
  accepted: boolean;
  paper_result: "executed" | "rejected" | "expired";
  live_result: "skipped";
  block_reason: string | null;
  current_target_position: number;
  proposed_delta:
    | {
        symbol: string;
        action: string;
        delta_notional_usd: number;
        target_weight: number;
        effective_target_weight: number;
      }
    | null;
  audit_refs: {
    received_seq?: number;
    planned_seq?: number;
    artifact_path?: string;
  };
  paper_gate: PaperGateVerdict | null;
  execution_plan_kind: PaperExecutionPlan["kind"] | null;
}

export function validateNormalizedSidecarSignal(
  input: unknown,
): NormalizedSidecarSignal {
  return normalizedSidecarSignalSchema.parse(input);
}

export function buildPortfolioTargetFromSidecarSignal(params: {
  signal: NormalizedSidecarSignal;
  account: CryptoAccountInfo;
  maxTurnoverPct?: number;
  now?: Date;
}): PortfolioTarget {
  const basisEquityUsd =
    params.account.equity > 0
      ? params.account.equity
      : params.account.balance > 0
        ? params.account.balance
        : 1_000;

  return buildPortfolioTargetFromWeights({
    basisEquityUsd,
    generatedAt: (params.now ?? new Date()).toISOString(),
    maxTurnoverPct: params.maxTurnoverPct ?? 1,
    weights: {
      [params.signal.symbol]: params.signal.target_position_pct,
    },
    confidenceBySymbol: {
      [params.signal.symbol]: params.signal.confidence,
    },
    sizingReasonBySymbol: {
      [params.signal.symbol]: `${params.signal.source}:${params.signal.strategy_id}`,
    },
    regimeTagBySymbol: {
      [params.signal.symbol]: "sidecar_signal",
    },
    notes: [
      "source=sidecar_signal",
      `signal_id=${params.signal.signal_id}`,
      `strategy_id=${params.signal.strategy_id}`,
    ],
  });
}

export async function runSidecarSignalPaperIntake(
  opts: SidecarSignalIntakeOptions,
): Promise<SidecarSignalIntakeResult> {
  const now = opts.now ?? new Date();
  const signal = validateNormalizedSidecarSignal(opts.signal);
  const supportedSymbols = uniqueSymbols(opts.supportedSymbols ?? []);
  const receivedEntry = await opts.eventLog.append("sidecar.signal.received", {
    signal_id: signal.signal_id,
    source: signal.source,
    strategy_id: signal.strategy_id,
    symbol: signal.symbol,
    as_of: signal.as_of,
  });

  if (
    supportedSymbols.length > 0 &&
    !supportedSymbols.includes(signal.symbol)
  ) {
    await opts.eventLog.append("sidecar.signal.rejected", {
      signal_id: signal.signal_id,
      reason: "unsupported_symbol",
      symbol: signal.symbol,
      supportedSymbols,
    });
    return {
      signal_id: signal.signal_id,
      accepted: false,
      paper_result: "rejected",
      live_result: "skipped",
      block_reason: "unsupported_symbol",
      current_target_position: signal.target_position_pct,
      proposed_delta: null,
      audit_refs: { received_seq: receivedEntry.seq },
      paper_gate: null,
      execution_plan_kind: null,
    };
  }

  if (isExpired(signal, now)) {
    await opts.eventLog.append("sidecar.signal.expired", {
      signal_id: signal.signal_id,
      symbol: signal.symbol,
      as_of: signal.as_of,
      ttl_ms: signal.ttl_ms,
    });
    return {
      signal_id: signal.signal_id,
      accepted: false,
      paper_result: "expired",
      live_result: "skipped",
      block_reason: "signal_expired",
      current_target_position: signal.target_position_pct,
      proposed_delta: null,
      audit_refs: { received_seq: receivedEntry.seq },
      paper_gate: null,
      execution_plan_kind: null,
    };
  }

  const [account, currentPositions] = await Promise.all([
    opts.engine.getAccount(),
    opts.engine.getPositions(),
  ]);
  const pricesBySymbol = await loadPricesBySymbol(opts.engine, currentPositions, signal.symbol);
  const portfolioTarget = buildPortfolioTargetFromSidecarSignal({
    signal,
    account,
    maxTurnoverPct: opts.maxTurnoverPct,
    now,
  });
  const paperGate = evaluatePaperGate({
    promotionGatePass: true,
    championRegistryState: "valid",
    championLoaded: true,
    policyVersionMatch: true,
    researchApproved: true,
    runtimeHealthy: true,
    dataFresh: true,
    dataQualityValid: true,
    connectorHealthy: true,
    riskLimitsLoaded: true,
    paperExecutorEnabled: true,
    now,
  });
  const executionPlan = buildPaperExecutionPlan({
    promotionPass: true,
    paperGateAllowsPaperTrading: paperGate.allowPaperTrading,
    paperGateMode: paperGate.mode,
    paperGateAllowsExecution: paperGate.allowPaperExecution,
    paperGateBlockingReasons: paperGate.blockingReasons,
    paperGateFlatOnlyReasons: paperGate.flatOnlyReasons,
    championRegistryState: "valid",
    championSetComplete: true,
    portfolioTarget,
    currentPositions,
    pricesBySymbol,
    now,
  });

  const artifactPath = opts.artifactPath ?? "data/runtime/sidecar_signal_intake.latest.json";
  const artifactPayload = {
    signal,
    paperGate,
    executionPlan,
    generatedAt: now.toISOString(),
  };
  await writeJsonArtifact(artifactPath, artifactPayload);
  const plannedEntry = await opts.eventLog.append("sidecar.signal.paper_planned", {
    signal_id: signal.signal_id,
    symbol: signal.symbol,
    paper_gate_mode: paperGate.mode,
    execution_plan_kind: executionPlan.kind,
    artifact_path: artifactPath,
  });

  return {
    signal_id: signal.signal_id,
    accepted: true,
    paper_result: executionPlan.kind === "blocked" ? "rejected" : "executed",
    live_result: "skipped",
    block_reason:
      executionPlan.kind === "blocked"
        ? executionPlan.blockingReasons[0] ?? "paper_gate_blocked"
        : executionPlan.kind === "flat"
          ? executionPlan.flatReasons[0] ?? null
          : null,
    current_target_position: signal.target_position_pct,
    proposed_delta:
      executionPlan.kind === "blocked"
        ? null
        : summarizeProposedDelta(executionPlan, signal.symbol),
    audit_refs: {
      received_seq: receivedEntry.seq,
      planned_seq: plannedEntry.seq,
      artifact_path: artifactPath,
    },
    paper_gate: paperGate,
    execution_plan_kind: executionPlan.kind,
  };
}

function isExpired(signal: NormalizedSidecarSignal, now: Date): boolean {
  const asOfMs = Date.parse(signal.as_of);
  if (!Number.isFinite(asOfMs)) {
    return true;
  }
  return asOfMs + signal.ttl_ms < now.getTime();
}

async function loadPricesBySymbol(
  engine: ICryptoTradingEngine,
  currentPositions: CryptoPosition[],
  signalSymbol: string,
): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};
  const symbols = uniqueSymbols([
    signalSymbol,
    ...currentPositions.map(position => position.symbol),
  ]);

  await Promise.all(
    symbols.map(async symbol => {
      const existingPosition = currentPositions.find(position => position.symbol === symbol);
      if (existingPosition?.markPrice && existingPosition.markPrice > 0) {
        prices[symbol] = existingPosition.markPrice;
        return;
      }
      try {
        const ticker = await engine.getTicker(symbol);
        if (Number.isFinite(ticker.last) && ticker.last > 0) {
          prices[symbol] = ticker.last;
        }
      } catch {
        // Best-effort only; downstream plan builder will throw if a required price is missing.
      }
    }),
  );

  return prices;
}

function summarizeProposedDelta(
  executionPlan: Exclude<PaperExecutionPlan, { kind: "blocked" }>,
  symbol: string,
): SidecarSignalIntakeResult["proposed_delta"] {
  const entry = executionPlan.rebalancePlan.entries.find(item => item.symbol === symbol);
  if (!entry) {
    return null;
  }
  return {
    symbol,
    action: entry.action,
    delta_notional_usd: entry.deltaNotionalUsd,
    target_weight: entry.targetWeight,
    effective_target_weight: entry.effectiveTargetWeight,
  };
}

async function writeJsonArtifact(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function uniqueSymbols(symbols: string[]): string[] {
  return Array.from(
    new Set(
      symbols.map(symbol => symbol.trim()).filter(Boolean),
    ),
  );
}
