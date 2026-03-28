/**
 * Crypto Operation Dispatcher
 *
 * Provider-agnostic bridge: Wallet Operation -> ICryptoTradingEngine method calls
 * Used as the WalletConfig.executeOperation callback
 *
 * v2 — adds:
 *   - Decision Ticket validation (before placeOrder)
 *   - Intent ledger (record intent BEFORE, result AFTER)
 *   - Kill switch (per-symbol circuit breaker)
 *   - Exchange capability / idempotency check
 *   - Slippage protection (fill vs expected price)
 *   - Partial-success push() with stop-on-failure
 *
 * Return values must match the structure expected by Wallet.parseOperationResult (Wallet.ts):
 * - placeOrder: { success, order?: { id, status, filledPrice, filledQuantity, ...timing } }
 * - Others: { success, error? }
 */

import { randomUUID } from "node:crypto";
import type {
  ICryptoTradingEngine,
  CryptoPlaceOrderRequest,
  CryptoOrderResult,
} from "./interfaces.js";
import type { Operation } from "./wallet/types.js";
import type { RiskCheckContext, RiskCheckResult, RiskConfig } from "./risk.js";
import { preTradeRiskCheck } from "./risk.js";
import { getContextId } from "../../core/trusted-context.js";
import {
  DecisionTicketStore,
  type TicketValidationResult,
} from "./decision-ticket.js";
import {
  IntentLedger,
  type TradeIntent,
  type IntentResult,
} from "./intent-ledger.js";
import {
  TradeIdempotencyStore,
  type TradeIdempotencyRecord,
} from "./idempotency-store.js";
import { KillSwitch, type KillSwitchCheckResult } from "./kill-switch.js";
import {
  getIdempotencyPolicy,
  getExchangeCapability,
} from "./exchange-capabilities.js";

// ==================== Hook Interfaces ====================

export interface PlaceOrderHookInput {
  operation: Operation;
  request: CryptoPlaceOrderRequest;
  expectedPrice?: number;
  riskContext?: RiskCheckContext;
}

export interface PlaceOrderResultHookInput extends PlaceOrderHookInput {
  result: CryptoOrderResult;
}

// ==================== PushResult Types ====================

export interface OperationOutcome {
  opIndex: number;
  ticketId: string;
  intentId: string;
  status: "success" | "failed" | "skipped";
  result?: CryptoOrderResult;
  error?: string;
}

export interface PushResult {
  commitId: string;
  operations: OperationOutcome[];
  summary: { succeeded: number; failed: number; skipped: number };
}

export interface CryptoOperationDispatcher {
  (op: Operation): Promise<unknown>;
  dispatch: (op: Operation) => Promise<unknown>;
  push: (commitId: string, operations: Operation[]) => Promise<PushResult>;
}

interface SimpleActionResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

/** @deprecated Use OperationOutcome instead */
export type OperationEntry = OperationOutcome;

// ==================== Options ====================

export interface CryptoOperationDispatcherOptions {
  riskConfig?: RiskConfig;
  getRiskContext?: () => Promise<RiskCheckContext | undefined>;
  estimateExpectedPrice?: (
    input: Omit<PlaceOrderHookInput, "riskContext">
  ) => Promise<number | undefined>;
  beforePlaceOrderGate?: (
    input: Omit<PlaceOrderHookInput, "riskContext">
  ) => Promise<RiskCheckResult | undefined>;
  afterPlaceOrder?: (input: PlaceOrderResultHookInput) => Promise<void>;
  onRiskRejected?: (input: {
    operation: Operation;
    request: CryptoPlaceOrderRequest;
    reason: string;
    details?: Record<string, unknown>;
  }) => Promise<void>;
  // v2 additions
  ticketStore?: DecisionTicketStore;
  intentLedger?: IntentLedger;
  idempotencyStore?: TradeIdempotencyStore;
  killSwitch?: KillSwitch;
  exchangeId?: string;
  slippageConfig?: { maxSlippagePct: number; reduceOnlyMultiplier: number };
  eventLog?: { append: (type: string, payload: unknown) => Promise<unknown> };
}

// ==================== Slippage ====================

export interface SlippageConfig {
  maxSlippagePct: number;
  reduceOnlyMultiplier: number;
}

const DEFAULT_SLIPPAGE: SlippageConfig = {
  maxSlippagePct: 0.005,
  reduceOnlyMultiplier: 2,
};

function checkSlippage(
  expectedPrice: number | undefined,
  filledPrice: number | undefined,
  side: "buy" | "sell",
  reduceOnly: boolean,
  config: SlippageConfig
): { ok: boolean; slippagePct?: number; limit?: number } {
  if (!expectedPrice || !filledPrice || expectedPrice <= 0) return { ok: true };
  const slippagePct =
    side === "buy"
      ? (filledPrice - expectedPrice) / expectedPrice
      : (expectedPrice - filledPrice) / expectedPrice;
  const limit = reduceOnly
    ? config.maxSlippagePct * config.reduceOnlyMultiplier
    : config.maxSlippagePct;
  return { ok: slippagePct <= limit, slippagePct, limit };
}

function toWalletOrderStatus(
  result: CryptoOrderResult
): "filled" | "partially_filled" | "pending" | "cancelled" | "rejected" {
  if (
    result.orderStatus === "filled" ||
    result.orderStatus === "partially_filled" ||
    result.orderStatus === "pending" ||
    result.orderStatus === "cancelled" ||
    result.orderStatus === "rejected"
  ) {
    return result.orderStatus;
  }
  if (typeof result.filledSize === "number" && result.filledSize > 0) {
    if (
      typeof result.remainingSize === "number" &&
      result.remainingSize > 0
    ) {
      return "partially_filled";
    }
    return "filled";
  }
  return "pending";
}

function resolveIdempotencyKey(
  op: Operation,
  req: CryptoPlaceOrderRequest,
  ticketId: string
): string | undefined {
  const explicit = op.params.idempotencyKey;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  if (typeof req.idempotencyKey === "string" && req.idempotencyKey.trim()) {
    return req.idempotencyKey.trim();
  }
  if (ticketId.trim()) {
    return `ticket:${ticketId.trim()}`;
  }
  return undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

// ==================== Helpers ====================

function normalizeDispatcherOptions(
  optionsOrRiskConfig: CryptoOperationDispatcherOptions | RiskConfig | undefined
): CryptoOperationDispatcherOptions {
  if (!optionsOrRiskConfig) {
    return {};
  }
  if (isRiskConfig(optionsOrRiskConfig)) {
    return { riskConfig: optionsOrRiskConfig };
  }
  return optionsOrRiskConfig;
}

async function estimateExpectedPrice(
  req: CryptoPlaceOrderRequest,
  op: Operation,
  options: CryptoOperationDispatcherOptions
): Promise<number | undefined> {
  if (typeof req.price === "number" && req.price > 0) {
    return req.price;
  }
  const estimated = await options.estimateExpectedPrice?.({
    operation: op,
    request: req,
  });
  return typeof estimated === "number" &&
    Number.isFinite(estimated) &&
    estimated > 0
    ? estimated
    : undefined;
}

async function safeRunAfterHook(
  options: CryptoOperationDispatcherOptions,
  input: PlaceOrderResultHookInput
): Promise<void> {
  if (!options.afterPlaceOrder) {
    return;
  }
  try {
    await options.afterPlaceOrder(input);
  } catch {
    // Do not fail the order flow if telemetry hook fails.
  }
}

function isRiskConfig(value: unknown): value is RiskConfig {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as Partial<RiskConfig>;
  return (
    typeof v.enabled === "boolean" &&
    typeof v.killSwitch === "boolean" &&
    typeof v.maxOpenPositions === "number" &&
    typeof v.maxLeverage === "number"
  );
}

// ==================== Dispatcher Factory ====================

export function createCryptoOperationDispatcher(
  engine: ICryptoTradingEngine,
  optionsOrRiskConfig?: CryptoOperationDispatcherOptions | RiskConfig
): CryptoOperationDispatcher {
  const options = normalizeDispatcherOptions(optionsOrRiskConfig);
  let placeOrderQueue: Promise<void> = Promise.resolve();

  async function withPlaceOrderLock<T>(task: () => Promise<T>): Promise<T> {
    const prev = placeOrderQueue;
    let release!: () => void;
    placeOrderQueue = new Promise<void>(resolve => {
      release = resolve;
    });

    await prev;
    try {
      return await task();
    } finally {
      release();
    }
  }

  /**
   * Execute a single placeOrder through the full v2 pipeline.
   * Shared by both dispatch() and push().
   */
  async function executePlaceOrder(
    op: Operation,
    opIndex: number,
    commitId: string
  ): Promise<{ outcome: OperationOutcome; walletResult: unknown }> {
    const ticketId = (op.params.ticketId as string) ?? "";
    const intentId = randomUUID();
    const contextId = getContextId();

    const req: CryptoPlaceOrderRequest = {
      symbol: op.params.symbol as string,
      side: op.params.side as "buy" | "sell",
      type: op.params.type as "market" | "limit",
      size: op.params.size as number | undefined,
      usd_size: op.params.usd_size as number | undefined,
      price: op.params.price as number | undefined,
      leverage: op.params.leverage as number | undefined,
      reduceOnly: op.params.reduceOnly as boolean | undefined,
    };
    const idempotencyKey = resolveIdempotencyKey(op, req, ticketId);
    const forceRetryIdempotency = Boolean(op.params.forceRetryIdempotency);
    const retryReason = asTrimmedString(op.params.retryReason);
    const retryApprovedBy = asTrimmedString(op.params.retryApprovedBy);
    const retryApprovalTicketId = asTrimmedString(
      op.params.retryApprovalTicketId
    );
    if (idempotencyKey) {
      req.idempotencyKey = idempotencyKey;
    }
    let idempotencyReserved = false;

    async function finalizeIdempotency(
      status: "succeeded" | "failed",
      result?: CryptoOrderResult,
      error?: string
    ): Promise<void> {
      if (!idempotencyReserved || !idempotencyKey || !options.idempotencyStore) {
        return;
      }
      await options.idempotencyStore
        .finalize({
          key: idempotencyKey,
          status,
          orderId: result?.orderId,
          error: error ?? result?.error,
        })
        .catch(() => {});
    }

    const fail = (
      error: string
    ): { outcome: OperationOutcome; walletResult: unknown } => ({
      outcome: { opIndex, ticketId, intentId, status: "failed", error },
      walletResult: { success: false, error },
    });

    let intentRecorded = false;
    async function recordIntentIfNeeded(): Promise<void> {
      if (intentRecorded || !options.intentLedger) {
        return;
      }
      const cap = options.exchangeId
        ? getExchangeCapability(options.exchangeId)
        : undefined;
      const intent: TradeIntent = {
        intentId,
        ticketId,
        symbol: req.symbol,
        action: op.action,
        side: req.side,
        type: req.type,
        size: req.size,
        usdSize: req.usd_size,
        price: req.price,
        reduceOnly: req.reduceOnly,
        leverage: req.leverage,
        contextId,
        exchangeId: options.exchangeId,
        clientOrderId: cap?.supportsClientOrderId
          ? (idempotencyKey ?? intentId)
          : undefined,
        createdAt: Date.now(),
      };
      await options.intentLedger.recordIntent(intent);
      intentRecorded = true;
    }

    await recordIntentIfNeeded();

    // 1. Kill switch
    if (options.killSwitch) {
      const ksResult: KillSwitchCheckResult = options.killSwitch.check(
        req.symbol,
        !!req.reduceOnly,
        false
      );
      if (ksResult.blocked) {
        const error = `kill-switch: ${ksResult.reason ?? "blocked"}`;
        await options.eventLog
          ?.append("kill-switch.blocked", {
            commitId,
            opIndex,
            symbol: req.symbol,
            reason: ksResult.reason,
          })
          .catch(() => {});
        await recordIntentFailure(options, intentId, error);
        return fail(error);
      }
    }

    // 2. Decision ticket validation
    if (options.ticketStore && !ticketId) {
      await options.eventLog
        ?.append("ticket.skipped", {
          commitId,
          opIndex,
          reason: "no-ticket-id",
          required: options.ticketStore.isRequired(),
        })
        .catch(() => {});
    }
    if (options.ticketStore && ticketId) {
      const ticketResult: TicketValidationResult = options.ticketStore.validate(
        ticketId,
        req.symbol,
        op.action
      );
      if (!ticketResult.valid) {
        const error = `ticket: ${ticketResult.reason ?? "invalid"}`;
        await options.eventLog
          ?.append("ticket.rejected", {
            commitId,
            opIndex,
            ticketId,
            reason: ticketResult.reason,
          })
          .catch(() => {});
        await recordIntentFailure(options, intentId, error);
        return fail(error);
      }
    }

    // 3. Idempotency / exchange capability check
    if (options.exchangeId) {
      const idempPolicy = getIdempotencyPolicy(
        options.exchangeId,
        !!req.reduceOnly
      );
      if (!idempPolicy.allowed) {
        const error = `idempotency: ${idempPolicy.warning ?? "rejected"}`;
        await options.eventLog
          ?.append("idempotency.rejected", {
            commitId,
            opIndex,
            exchangeId: options.exchangeId,
            warning: idempPolicy.warning,
          })
          .catch(() => {});
        await recordIntentFailure(options, intentId, error);
        return fail(error);
      }
      if (idempPolicy.warning) {
        await options.eventLog
          ?.append("idempotency.warning", {
            commitId,
            opIndex,
            exchangeId: options.exchangeId,
            warning: idempPolicy.warning,
          })
          .catch(() => {});
      }
    }

    // 4. Record intent BEFORE execution
    await recordIntentIfNeeded();

    // 5. Pre-gate hook (custom)
    const expectedPrice = await estimateExpectedPrice(req, op, options);
    const preGate = await options.beforePlaceOrderGate?.({
      operation: op,
      request: req,
      expectedPrice,
    });
    if (preGate && !preGate.approved) {
      const error = `pre-gate: ${preGate.reason ?? "rejected"}`;
      await options.onRiskRejected?.({
        operation: op,
        request: req,
        reason: preGate.reason ?? "pre-place-order gate rejected order",
        details: preGate.details,
      });
      await recordIntentFailure(options, intentId, error);
      return fail(error);
    }

    // 5.4 Retry override governance:
    // forceRetryIdempotency requires explicit reason; when ticketing is enabled,
    // a dedicated retry-approval ticket is also required.
    if (forceRetryIdempotency) {
      if (!retryReason) {
        const error =
          "idempotency: forceRetryIdempotency requires non-empty retryReason";
        await options.eventLog
          ?.append("idempotency.retry_rejected", {
            commitId,
            opIndex,
            key: idempotencyKey,
            reason: "missing-retry-reason",
          })
          .catch(() => {});
        await recordIntentFailure(options, intentId, error);
        return fail(error);
      }

      if (options.ticketStore) {
        if (!retryApprovalTicketId) {
          const error =
            "idempotency: forceRetryIdempotency requires retryApprovalTicketId when ticketStore is enabled";
          await options.eventLog
            ?.append("idempotency.retry_rejected", {
              commitId,
              opIndex,
              key: idempotencyKey,
              reason: "missing-retry-approval-ticket",
            })
            .catch(() => {});
          await recordIntentFailure(options, intentId, error);
          return fail(error);
        }
        const retryTicketResult = options.ticketStore.validate(
          retryApprovalTicketId,
          req.symbol,
          op.action
        );
        if (!retryTicketResult.valid) {
          const error = `idempotency: retry approval ticket invalid (${retryTicketResult.reason ?? "invalid"})`;
          await options.eventLog
            ?.append("idempotency.retry_rejected", {
              commitId,
              opIndex,
              key: idempotencyKey,
              reason: "invalid-retry-approval-ticket",
              ticketId: retryApprovalTicketId,
              ticketValidationReason: retryTicketResult.reason,
            })
            .catch(() => {});
          await recordIntentFailure(options, intentId, error);
          return fail(error);
        }
      }
    }

    // 5.5 Cross-process idempotency reservation.
    if (idempotencyKey && options.idempotencyStore) {
      let reservation;
      try {
        reservation = await options.idempotencyStore.reserve({
          key: idempotencyKey,
          symbol: req.symbol,
          ticketId: ticketId || undefined,
          allowRetryOnFailed: forceRetryIdempotency,
        });
      } catch (err) {
        const error =
          err instanceof Error
            ? `idempotency: reserve failed (${err.message})`
            : `idempotency: reserve failed (${String(err)})`;
        await recordIntentFailure(options, intentId, error);
        return fail(error);
      }
      if (reservation && !reservation.acquired) {
        const prev = reservation.record;
        const duplicateError = `idempotency: duplicate key ${idempotencyKey} (status=${prev.status}${prev.orderId ? `, orderId=${prev.orderId}` : ""})`;
        await options.eventLog
          ?.append("idempotency.duplicate", {
            commitId,
            opIndex,
            key: idempotencyKey,
            previous: sanitizeIdempotencyRecord(prev),
          })
          .catch(() => {});
        await recordIntentFailure(options, intentId, duplicateError);
        return fail(duplicateError);
      }
      if (reservation?.acquired) {
        idempotencyReserved = true;
        if (reservation.retriedFromFailed) {
          await options.eventLog
            ?.append("idempotency.retry_override", {
              commitId,
              opIndex,
              key: idempotencyKey,
              retryReason,
              retryApprovedBy,
              retryApprovalTicketId,
            })
            .catch(() => {});
        }
      }
    }

    // 6-7. Risk check + order placement under one lock to prevent TOCTOU races.
    type LockedExecution =
      | {
          kind: "risk_rejected";
          riskContext?: RiskCheckContext;
          riskResult: RiskCheckResult;
        }
      | {
          kind: "executed";
          riskContext?: RiskCheckContext;
          riskResult: RiskCheckResult;
          orderResult: CryptoOrderResult;
        };

    let lockedExecution: LockedExecution;
    try {
      lockedExecution = await withPlaceOrderLock<LockedExecution>(
        async (): Promise<LockedExecution> => {
          const riskContext = await options.getRiskContext?.();
          const riskResult = await preTradeRiskCheck(
            engine,
            req,
            options.riskConfig,
            riskContext
          );

          if (!riskResult.approved) {
            return { kind: "risk_rejected", riskContext, riskResult };
          }

          const orderResult = await engine.placeOrder(req);
          return { kind: "executed", riskContext, riskResult, orderResult };
        }
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await finalizeIdempotency("failed", undefined, error);
      await recordIntentFailure(options, intentId, error);
      return fail(error);
    }

    const riskContext = lockedExecution.riskContext;
    const riskResult = lockedExecution.riskResult;
    if (lockedExecution.kind === "risk_rejected") {
      const error = `risk: ${riskResult.reason ?? "unknown reason"}`;
      await options.onRiskRejected?.({
        operation: op,
        request: req,
        reason: riskResult.reason ?? "risk gate rejected order",
        details: riskResult.details,
      });
      await finalizeIdempotency("failed", undefined, error);
      await recordIntentFailure(options, intentId, error);
      return fail(error);
    }
    const orderResult = lockedExecution.orderResult;

    // 8. After-hook (telemetry, non-blocking)
    await safeRunAfterHook(options, {
      operation: op,
      request: req,
      expectedPrice,
      riskContext,
      result: orderResult,
    });

    // 9. Slippage check
    if (orderResult.success && orderResult.filledPrice) {
      const slipCfg: SlippageConfig = options.slippageConfig
        ? { ...DEFAULT_SLIPPAGE, ...options.slippageConfig }
        : DEFAULT_SLIPPAGE;
      const slipCheck = checkSlippage(
        expectedPrice,
        orderResult.filledPrice,
        req.side,
        !!req.reduceOnly,
        slipCfg
      );
      if (!slipCheck.ok) {
        await options.eventLog
          ?.append("slippage.exceeded", {
            commitId,
            opIndex,
            intentId,
            symbol: req.symbol,
            expectedPrice,
            filledPrice: orderResult.filledPrice,
            slippagePct: slipCheck.slippagePct,
            limit: slipCheck.limit,
          })
          .catch(() => {});
      }
    }

    // 10. Record result to ledger
    if (options.intentLedger) {
      const intentResult: IntentResult = {
        intentId,
        status: orderResult.success ? "success" : "failed",
        orderId: orderResult.orderId,
        filledPrice: orderResult.filledPrice,
        filledSize: orderResult.filledSize,
        error: orderResult.error,
        completedAt: Date.now(),
      };
      await options.intentLedger.recordResult(intentResult).catch(() => {});
    }

    // 11. Build outcome
    if (!orderResult.success) {
      await finalizeIdempotency("failed", orderResult);
      return {
        outcome: {
          opIndex,
          ticketId,
          intentId,
          status: "failed",
          result: orderResult,
          error: orderResult.error,
        },
        walletResult: {
          success: false,
          error: orderResult.error,
        },
      };
    }

    await finalizeIdempotency("succeeded", orderResult);

    return {
      outcome: {
        opIndex,
        ticketId,
        intentId,
        status: "success",
        result: orderResult,
      },
      walletResult: {
        success: true,
        order: {
          id: orderResult.orderId,
          status: toWalletOrderStatus(orderResult),
          requestedSize: orderResult.requestedSize,
          remainingSize: orderResult.remainingSize,
          filledPrice: orderResult.filledPrice,
          filledQuantity: orderResult.filledSize,
          idempotencyKey: orderResult.idempotencyKey ?? idempotencyKey,
          firstFillAtMs: orderResult.firstFillAtMs,
          completedAtMs: orderResult.completedAtMs,
        },
      },
    };
  }

  /** Record an intent failure to the ledger (best-effort). */
  async function recordIntentFailure(
    opts: CryptoOperationDispatcherOptions,
    intentId: string,
    error: string
  ): Promise<void> {
    const intentResult: IntentResult = {
      intentId,
      status: "failed",
      error,
      completedAt: Date.now(),
    };
    await opts.intentLedger?.recordResult(intentResult).catch(() => {});
  }

  /**
   * Execute a non-placeOrder action directly on the engine.
   * Returns the raw result for Wallet compatibility.
   */
  async function executeSimpleAction(
    op: Operation
  ): Promise<SimpleActionResult> {
    switch (op.action) {
      case "closePosition": {
        const symbol = op.params.symbol as string;
        const size = op.params.size as number | undefined;
        const idempotencyKey = asTrimmedString(op.params.idempotencyKey);
        let idempotencyReserved = false;

        async function finalizeIdempotency(
          status: "succeeded" | "failed",
          result?: CryptoOrderResult,
          error?: string,
        ): Promise<void> {
          if (!idempotencyReserved || !idempotencyKey || !options.idempotencyStore) {
            return;
          }
          await options.idempotencyStore
            .finalize({
              key: idempotencyKey,
              status,
              orderId: result?.orderId,
              error: error ?? result?.error,
            })
            .catch(() => {});
        }

        if (idempotencyKey && options.exchangeId) {
          const idempPolicy = getIdempotencyPolicy(options.exchangeId, true);
          if (!idempPolicy.allowed) {
            return {
              success: false,
              error: `idempotency: ${idempPolicy.warning ?? "rejected"}`,
            };
          }
          if (idempPolicy.warning) {
            await options.eventLog
              ?.append("idempotency.warning", {
                action: op.action,
                exchangeId: options.exchangeId,
                warning: idempPolicy.warning,
              })
              .catch(() => {});
          }
        }

        if (idempotencyKey && options.idempotencyStore) {
          let reservation;
          try {
            reservation = await options.idempotencyStore.reserve({
              key: idempotencyKey,
              symbol,
            });
          } catch (err) {
            return {
              success: false,
              error:
                err instanceof Error
                  ? `idempotency: reserve failed (${err.message})`
                  : `idempotency: reserve failed (${String(err)})`,
            };
          }

          if (reservation && !reservation.acquired) {
            const prev = reservation.record;
            const duplicateError = `idempotency: duplicate key ${idempotencyKey} (status=${prev.status}${prev.orderId ? `, orderId=${prev.orderId}` : ""})`;
            await options.eventLog
              ?.append("idempotency.duplicate", {
                action: op.action,
                key: idempotencyKey,
                previous: sanitizeIdempotencyRecord(prev),
              })
              .catch(() => {});
            return { success: false, error: duplicateError };
          }

          idempotencyReserved = true;
        }

        let result: CryptoOrderResult;
        try {
          result = await withPlaceOrderLock(async () => {
            const positions = await engine.getPositions();
            const position = positions.find(p => p.symbol === symbol);
            if (!position) {
              throw new Error(`No open position for ${symbol}`);
            }

            const closeSide = position.side === "long" ? "sell" : "buy";
            const closeSize = size ?? position.size;

            return engine.placeOrder({
              symbol,
              side: closeSide,
              type: "market",
              size: closeSize,
              reduceOnly: true,
              idempotencyKey,
            });
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await finalizeIdempotency("failed", undefined, message);
          return { success: false, error: message };
        }

        if (!result.success) {
          await finalizeIdempotency("failed", result);
          return { success: false, error: result.error };
        }

        await finalizeIdempotency("succeeded", result);
        return {
          success: true,
          order: {
            id: result.orderId,
            status: toWalletOrderStatus(result),
            requestedSize: result.requestedSize,
            remainingSize: result.remainingSize,
            filledPrice: result.filledPrice,
            filledQuantity: result.filledSize,
            firstFillAtMs: result.firstFillAtMs,
            completedAtMs: result.completedAtMs,
          },
        };
      }

      case "cancelOrder": {
        const orderId = op.params.orderId as string;
        const success = await engine.cancelOrder(orderId);
        return {
          success,
          error: success ? undefined : "Failed to cancel order",
        };
      }

      case "adjustLeverage": {
        const symbol = op.params.symbol as string;
        const newLeverage = op.params.newLeverage as number;
        return await engine.adjustLeverage(symbol, newLeverage);
      }

      default:
        throw new Error(`Unknown operation action: ${op.action}`);
    }
  }

  // -------------------- dispatch (backward compat) --------------------

  async function dispatch(op: Operation): Promise<unknown> {
    if (op.action === "placeOrder") {
      const commitId = randomUUID();
      const { walletResult } = await executePlaceOrder(op, 0, commitId);
      return walletResult;
    }
    return executeSimpleAction(op);
  }

  // -------------------- push (batch, stop-on-failure) --------------------

  async function push(
    commitId: string,
    operations: Operation[]
  ): Promise<PushResult> {
    const contextId = getContextId();
    const results: OperationOutcome[] = [];
    let stopped = false;

    await options.eventLog
      ?.append("commit.started", {
        commitId,
        contextId,
        operationCount: operations.length,
      })
      .catch(() => {});

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];

      // Skip remaining after a failure
      if (stopped) {
        results.push({
          opIndex: i,
          ticketId: (op.params.ticketId as string) ?? "",
          intentId: "",
          status: "skipped",
        });
        continue;
      }

      if (op.action === "placeOrder") {
        try {
          const { outcome } = await executePlaceOrder(op, i, commitId);
          results.push(outcome);
          if (outcome.status === "failed") {
            stopped = true;
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          results.push({
            opIndex: i,
            ticketId: (op.params.ticketId as string) ?? "",
            intentId: "",
            status: "failed",
            error,
          });
          stopped = true;
        }
      } else {
        // Non-placeOrder actions: kill switch still applies
        if (options.killSwitch) {
          const symbol = (op.params.symbol as string) ?? "";
          if (symbol) {
            const isReduceOnly = op.action === "closePosition";
            const ksResult = options.killSwitch.check(
              symbol,
              isReduceOnly,
              false
            );
            if (ksResult.blocked) {
              results.push({
                opIndex: i,
                ticketId: (op.params.ticketId as string) ?? "",
                intentId: "",
                status: "failed",
                error: `kill-switch: ${ksResult.reason ?? "blocked"}`,
              });
              stopped = true;
              continue;
            }
          }
        }

        try {
          const simpleResult = await executeSimpleAction(op);
          if (simpleResult && !simpleResult.success) {
            const error = simpleResult.error ?? "operation failed";
            results.push({
              opIndex: i,
              ticketId: (op.params.ticketId as string) ?? "",
              intentId: "",
              status: "failed",
              error,
            });
            stopped = true;
          } else {
            results.push({
              opIndex: i,
              ticketId: (op.params.ticketId as string) ?? "",
              intentId: "",
              status: "success",
            });
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          results.push({
            opIndex: i,
            ticketId: (op.params.ticketId as string) ?? "",
            intentId: "",
            status: "failed",
            error,
          });
          stopped = true;
        }
      }
    }

    const summary = {
      succeeded: results.filter(r => r.status === "success").length,
      failed: results.filter(r => r.status === "failed").length,
      skipped: results.filter(r => r.status === "skipped").length,
    };

    await options.eventLog
      ?.append("commit.completed", {
        commitId,
        contextId,
        summary,
        operations: results,
      })
      .catch(() => {});

    return { commitId, operations: results, summary };
  }

  const dispatcher = (async (op: Operation) =>
    dispatch(op)) as CryptoOperationDispatcher;
  dispatcher.dispatch = dispatch;
  dispatcher.push = push;
  return dispatcher;
}

function sanitizeIdempotencyRecord(
  record: TradeIdempotencyRecord
): Record<string, unknown> {
  return {
    key: record.key,
    status: record.status,
    symbol: record.symbol,
    ticketId: record.ticketId,
    orderId: record.orderId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// ==================== Backward-compat exports ====================

/** @deprecated Use Operation from wallet/types instead */
export interface CommitOperation {
  action: string;
  params: Record<string, unknown>;
  ticketId: string;
}

/** @deprecated Use CryptoOperationDispatcherOptions instead */
export interface CommitExecutorDeps {
  engine: ICryptoTradingEngine;
  ticketStore?: DecisionTicketStore;
  intentLedger?: IntentLedger;
  idempotencyStore?: TradeIdempotencyStore;
  killSwitch?: KillSwitch;
  exchangeId?: string;
  slippageConfig?: SlippageConfig;
  riskConfig?: RiskConfig;
  getRiskContext?: () => Promise<RiskCheckContext | undefined>;
  estimateExpectedPrice?: (
    req: CryptoPlaceOrderRequest
  ) => Promise<number | undefined>;
  onEvent?: (type: string, payload: unknown) => Promise<void>;
}

/**
 * @deprecated Use createCryptoOperationDispatcher().push() instead.
 * Thin wrapper kept for backward compatibility.
 */
export async function executeCommit(
  operations: CommitOperation[],
  deps: CommitExecutorDeps
): Promise<PushResult> {
  const opts: CryptoOperationDispatcherOptions = {
    riskConfig: deps.riskConfig,
    getRiskContext: deps.getRiskContext,
    estimateExpectedPrice: deps.estimateExpectedPrice
      ? input => deps.estimateExpectedPrice!(input.request)
      : undefined,
    ticketStore: deps.ticketStore,
    intentLedger: deps.intentLedger,
    idempotencyStore: deps.idempotencyStore,
    killSwitch: deps.killSwitch,
    exchangeId: deps.exchangeId,
    slippageConfig: deps.slippageConfig,
    eventLog: deps.onEvent
      ? {
          append: (type, payload) =>
            deps.onEvent!(type, payload).then(() => undefined),
        }
      : undefined,
  };
  const dispatcher = createCryptoOperationDispatcher(deps.engine, opts);
  const commitId = randomUUID();
  const ops: Operation[] = operations.map(o => ({
    action: o.action as Operation["action"],
    params: { ...o.params, ticketId: o.ticketId },
  }));
  return dispatcher.push(commitId, ops);
}
