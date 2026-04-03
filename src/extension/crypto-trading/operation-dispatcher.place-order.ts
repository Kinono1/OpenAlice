import { randomUUID } from "node:crypto";
import type {
  CryptoOrderResult,
  CryptoPlaceOrderRequest,
  ICryptoTradingEngine,
} from "./interfaces.js";
import type { Operation } from "./wallet/types.js";
import type {
  RiskCheckContext,
  RiskCheckResult,
} from "./risk.js";
import { preTradeRiskCheck } from "./risk.js";
import { getContextId } from "../../core/trusted-context.js";
import { getExchangeCapability, getIdempotencyPolicy } from "./exchange-capabilities.js";
import type {
  CryptoOperationDispatcherOptions,
  OperationOutcome,
  SlippageConfig,
} from "./operation-dispatcher.types.js";
import {
  DEFAULT_SLIPPAGE,
  asTrimmedString,
  checkSlippage,
  estimateExpectedPrice,
  resolveIdempotencyKey,
  safeRunAfterHook,
  sanitizeIdempotencyRecord,
  toWalletOrderStatus,
} from "./operation-dispatcher.helpers.js";
import { getPrefetchedRiskState } from "./prefetched-state.js";

interface PlaceOrderExecutorDeps {
  engine: ICryptoTradingEngine;
  options: CryptoOperationDispatcherOptions;
  withPlaceOrderLock: <T>(task: () => Promise<T>) => Promise<T>;
}

interface PlaceOrderExecutionResult {
  outcome: OperationOutcome;
  walletResult: unknown;
}

function warnOnAncillaryFailure(
  action: string,
  err: unknown,
  meta?: Record<string, unknown>,
): void {
  console.warn(
    `[crypto-dispatcher] ${action} failed`,
    meta ?? {},
    err instanceof Error ? err.message : err,
  );
}

export function createPlaceOrderExecutor({
  engine,
  options,
  withPlaceOrderLock,
}: PlaceOrderExecutorDeps) {
  return async function executePlaceOrder(
    op: Operation,
    opIndex: number,
    commitId: string
  ): Promise<PlaceOrderExecutionResult> {
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
    const prefetchedState = getPrefetchedRiskState(op);
    const prefetchedPositions = prefetchedState?.positions;
    const prefetchedAccount = prefetchedState?.account;
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
        .catch((err) => {
          warnOnAncillaryFailure("idempotency.finalize", err, {
            key: idempotencyKey,
            status,
            intentId,
          });
        });
    }

    const fail = (error: string): PlaceOrderExecutionResult => ({
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
      await options.intentLedger.recordIntent({
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
      });
      intentRecorded = true;
    }

    await recordIntentIfNeeded();

    if (options.killSwitch) {
      const ksResult = options.killSwitch.check(req.symbol, !!req.reduceOnly, false);
      if (ksResult.blocked) {
        const error = `kill-switch: ${ksResult.reason ?? "blocked"}`;
        await options.eventLog
          ?.append("kill-switch.blocked", {
            commitId,
            opIndex,
            symbol: req.symbol,
            reason: ksResult.reason,
          })
          .catch((err) => {
            warnOnAncillaryFailure("eventLog.append.kill-switch.blocked", err, {
              commitId,
              opIndex,
              intentId,
            });
          });
        await recordIntentFailure(options, intentId, error);
        return fail(error);
      }
    }

    if (options.ticketStore && !ticketId) {
      await options.eventLog
        ?.append("ticket.skipped", {
          commitId,
          opIndex,
          reason: "no-ticket-id",
          required: options.ticketStore.isRequired(),
        })
        .catch((err) => {
          warnOnAncillaryFailure("eventLog.append.ticket.skipped", err, {
            commitId,
            opIndex,
            intentId,
          });
        });
    }
    if (options.ticketStore && ticketId) {
      const ticketResult = options.ticketStore.validate(
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
          .catch((err) => {
            warnOnAncillaryFailure("eventLog.append.ticket.rejected", err, {
              commitId,
              opIndex,
              ticketId,
              intentId,
            });
          });
        await recordIntentFailure(options, intentId, error);
        return fail(error);
      }
    }

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
          .catch((err) => {
            warnOnAncillaryFailure("eventLog.append.idempotency.rejected", err, {
              commitId,
              opIndex,
              intentId,
            });
          });
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
          .catch((err) => {
            warnOnAncillaryFailure("eventLog.append.idempotency.warning", err, {
              commitId,
              opIndex,
              intentId,
            });
          });
      }
    }

    await recordIntentIfNeeded();

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
          .catch((err) => {
            warnOnAncillaryFailure("eventLog.append.idempotency.retry_rejected", err, {
              commitId,
              opIndex,
              intentId,
            });
          });
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
            .catch((err) => {
              warnOnAncillaryFailure("eventLog.append.idempotency.retry_rejected", err, {
                commitId,
                opIndex,
                intentId,
              });
            });
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
            .catch((err) => {
              warnOnAncillaryFailure("eventLog.append.idempotency.retry_rejected", err, {
                commitId,
                opIndex,
                intentId,
              });
            });
          await recordIntentFailure(options, intentId, error);
          return fail(error);
        }
      }
    }

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
          .catch((err) => {
            warnOnAncillaryFailure("eventLog.append.idempotency.duplicate", err, {
              commitId,
              opIndex,
              intentId,
            });
          });
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
            .catch((err) => {
              warnOnAncillaryFailure("eventLog.append.idempotency.retry_override", err, {
                commitId,
                opIndex,
                intentId,
              });
            });
        }
      }
    }

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
          const baseRiskContext = await options.getRiskContext?.();
          const riskContext: RiskCheckContext | undefined = baseRiskContext
            ? {
                ...baseRiskContext,
                positions: prefetchedPositions ?? baseRiskContext.positions,
                account: prefetchedAccount ?? baseRiskContext.account,
              }
            : prefetchedPositions || prefetchedAccount
              ? {
                  positions: prefetchedPositions,
                  account: prefetchedAccount,
                }
              : undefined;
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

    await safeRunAfterHook(options, {
      operation: op,
      request: req,
      expectedPrice,
      riskContext,
      result: orderResult,
    });

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
          .catch((err) => {
            warnOnAncillaryFailure("eventLog.append.slippage.exceeded", err, {
              commitId,
              opIndex,
              intentId,
            });
          });
      }
    }

    if (options.intentLedger) {
      await options.intentLedger
        .recordResult({
          intentId,
          status: orderResult.success ? "success" : "failed",
          orderId: orderResult.orderId,
          filledPrice: orderResult.filledPrice,
          filledSize: orderResult.filledSize,
          error: orderResult.error,
          completedAt: Date.now(),
        })
        .catch((err) => {
          warnOnAncillaryFailure("intentLedger.recordResult", err, {
            intentId,
            opIndex,
          });
        });
    }

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
  };
}

async function recordIntentFailure(
  options: CryptoOperationDispatcherOptions,
  intentId: string,
  error: string
): Promise<void> {
  await options.intentLedger
    ?.recordResult({
      intentId,
      status: "failed",
      error,
      completedAt: Date.now(),
    })
    .catch((err) => {
      warnOnAncillaryFailure("intentLedger.recordResult.failure", err, {
        intentId,
      });
    });
}
