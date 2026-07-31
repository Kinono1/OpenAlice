import { dirname } from "node:path";
import { z } from "zod";
import type { EventLog } from "../core/event-log.js";
import type {
  CryptoAccountInfo,
  CryptoPosition,
  ICryptoTradingEngine,
} from "../domain/trading/operation-dispatcher.types.js";
import {
  buildPaperExecutionPlan,
  type PaperExecutionPlan,
} from "./paper_execution_plan.js";
import { evaluatePaperGate, type PaperGateVerdict } from "./paper_gate.js";
import {
  buildPortfolioTargetFromWeights,
  type PortfolioTarget,
} from "../portfolio/target.js";
import type { PromotionReadinessV2 } from "./promotion_v2.js";
import {
  DEFAULT_PROMOTION_READINESS_V2_PATH,
  tryLoadPromotionReadinessV2,
  tryLoadValidatedPromotionReadinessV2,
  type PromotionReadinessV2LoadResult,
  type PromotionReadinessV2ValidatedLoadResult,
} from "./promotion_v2_artifacts.js";
import { writeJsonAtomic } from "./atomic_write.js";

export const DEFAULT_MAX_ENVELOPE_AGE_MS = 2 * 60 * 60 * 1000 // 2 hours

const supportedSources = ["tradingagents", "alphaswarm", "cryptotrade", "currencypurchases"] as const;

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

// ── V5 sidecar envelope schemas ────────────────────────────────────

export const cryptoDlSignalV1Schema = z.object({
  source: z.literal('cryptotrade'),
  strategy_id: z.string().min(1),
  symbol: z.string().min(1),
  as_of: z.string().datetime(),
  target_position_bps: z.number().int(),
  confidence_bps: z.number().int().min(0).max(10000),
  model_id: z.string().min(1),
  thesis: z.string().min(1),
  label_horizon_bars: z.number().int().positive(),
  bar_interval_ms: z.number().int().positive(),
  target_start_delay_bars: z.number().int().nonnegative(),
  target_start_at: z.string().datetime(),
  target_end_at: z.string().datetime(),
})

export type CryptoDlSignalV1 = z.infer<typeof cryptoDlSignalV1Schema>

export const cryptoDlSidecarEnvelopeV1Schema = z.object({
  schema_version: z.literal(1),
  slot_id: z.string().min(1),
  run_id: z.string().min(1),
  generated_at: z.string().datetime(),
  ttl_ms: z.number().int().positive(),
  signals: z.array(cryptoDlSignalV1Schema),
  producer: z.string().min(1),
  model_metadata: z.record(z.string(), z.unknown()).optional(),
})

export type CryptoDlSidecarEnvelopeV1 = z.infer<typeof cryptoDlSidecarEnvelopeV1Schema>

export const cryptoDlSidecarStatusV1Schema = z.object({
  status: z.string(),
  slot_id: z.string(),
  run_id: z.string(),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime().nullable(),
  ready: z.boolean(),
  signals_count: z.number().int().nonnegative(),
  errorClass: z.string().optional(),
  errorMessage: z.string().optional(),
})

export type CryptoDlSidecarStatusV1 = z.infer<typeof cryptoDlSidecarStatusV1Schema>

export const signalHealthV1Schema = z.object({
  status: z.enum(['pending', 'warmup', 'healthy', 'decayed', 'blocked']),
  model_id: z.string(),
  signal_id: z.string(),
  target_end_at: z.string().datetime(),
  as_of: z.string().datetime(),
  label_horizon_bars: z.number().int().positive(),
  bar_interval_ms: z.number().int().positive(),
  rank_ic: z.number().optional(),
  direction_accuracy: z.number().optional(),
  signal_decay: z.number().optional(),
  blocked_reason: z.string().optional(),
})

export type SignalHealthV1 = z.infer<typeof signalHealthV1Schema>

export const executionTopOfBookEvidenceV1Schema = z.object({
  bid: z.number(),
  ask: z.number(),
  mid: z.number(),
  spread_bps: z.number().int(),
  snapshot_source: z.string(),
  snapshot_at: z.string().datetime(),
  snapshot_age_ms: z.number().int().nonnegative(),
})

export type ExecutionTopOfBookEvidenceV1 = z.infer<typeof executionTopOfBookEvidenceV1Schema>

export interface SidecarSignalIntakeOptions {
  signal: unknown;
  engine: ICryptoTradingEngine;
  eventLog: EventLog;
  now?: Date;
  supportedSymbols?: string[];
  maxTurnoverPct?: number;
  artifactPath?: string;
  promotionReadinessV2?: PromotionReadinessV2 | null;
  promotionReadinessV2Path?: string;
  requirePromotionV2?: boolean;
  validatePromotionV2Artifacts?: boolean;
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
  const promotionV2Load = await resolvePromotionReadinessV2ForSidecar(opts);
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
    promotionReadinessV2: promotionV2Load.readiness,
    requirePromotionV2: opts.requirePromotionV2,
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
    promotionV2: promotionV2Load.artifactSummary,
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

async function resolvePromotionReadinessV2ForSidecar(
  opts: SidecarSignalIntakeOptions,
): Promise<{
  readiness: PromotionReadinessV2 | null | undefined;
  artifactSummary: {
    required: boolean;
    path: string | null;
    loadStatus: "provided" | PromotionReadinessV2LoadResult["kind"] | PromotionReadinessV2ValidatedLoadResult["kind"] | "not_requested";
    error: string | null;
  };
}> {
  if (opts.promotionReadinessV2 !== undefined) {
    return {
      readiness: opts.promotionReadinessV2,
      artifactSummary: {
        required: opts.requirePromotionV2 === true,
        path: null,
        loadStatus: "provided",
        error: null,
      },
    };
  }

  const shouldLoad = opts.requirePromotionV2 === true || Boolean(opts.promotionReadinessV2Path);
  if (!shouldLoad) {
    return {
      readiness: undefined,
      artifactSummary: {
        required: false,
        path: null,
        loadStatus: "not_requested",
        error: null,
      },
    };
  }

  const path = opts.promotionReadinessV2Path ?? DEFAULT_PROMOTION_READINESS_V2_PATH;
  const validateArtifacts = opts.validatePromotionV2Artifacts ?? (opts.requirePromotionV2 === true);
  const result = validateArtifacts
    ? await tryLoadValidatedPromotionReadinessV2(dirname(path), { now: opts.now })
    : await tryLoadPromotionReadinessV2(path);
  return {
    readiness:
      result.kind === "loaded"
        ? result.readiness
        : result.kind === "invalid" && result.readiness
          ? result.readiness
          : null,
    artifactSummary: {
      required: opts.requirePromotionV2 === true,
      path: result.path,
      loadStatus: result.kind,
      error: result.kind === "loaded" ? null : result.error,
    },
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
  writeJsonAtomic(path, payload);
}

function uniqueSymbols(symbols: string[]): string[] {
  return Array.from(
    new Set(
      symbols.map(symbol => symbol.trim()).filter(Boolean),
    ),
  );
}

// ── V5 slot and envelope validation ─────────────────────────────────

export function computeCurrentSlotId(now?: Date): string {
  const d = now ?? new Date()
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  const hourSlot = Math.floor(d.getUTCHours() / 4) * 4
  const hour = String(hourSlot).padStart(2, '0')
  return `slot-${year}${month}${day}-${hour}`
}

export function validateSidecarEnvelope(envelope: unknown, opts?: { maxAgeMs?: number }): { valid: boolean; reason?: string } {
  try {
    const parsed = cryptoDlSidecarEnvelopeV1Schema.parse(envelope)

    // Validate TTL (not expired)
    const generatedAt = new Date(parsed.generated_at).getTime()
    const now = Date.now()
    if (!Number.isFinite(generatedAt)) {
      return { valid: false, reason: 'invalid generated_at timestamp' }
    }
    if (generatedAt + parsed.ttl_ms < now) {
      return { valid: false, reason: 'envelope TTL expired' }
    }

    const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_MAX_ENVELOPE_AGE_MS
    if (now - generatedAt > maxAgeMs) {
      return { valid: false, reason: `envelope too old: ${now - generatedAt}ms > ${maxAgeMs}ms max` }
    }

    // Validate slot matching
    const currentSlot = computeCurrentSlotId()
    if (parsed.slot_id !== currentSlot) {
      return { valid: false, reason: `slot_id mismatch: expected ${currentSlot}, got ${parsed.slot_id}` }
    }

    // Validate horizon metadata complete
    for (const signal of parsed.signals) {
      if (typeof signal.label_horizon_bars !== 'number' || signal.label_horizon_bars <= 0) {
        return { valid: false, reason: `signal ${signal.model_id} missing valid label_horizon_bars` }
      }
      if (typeof signal.bar_interval_ms !== 'number' || signal.bar_interval_ms <= 0) {
        return { valid: false, reason: `signal ${signal.model_id} missing valid bar_interval_ms` }
      }
    }

    return { valid: true }
  } catch (err) {
    return { valid: false, reason: err instanceof Error ? err.message : 'schema validation failed' }
  }
}
