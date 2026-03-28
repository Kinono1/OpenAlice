import { describe, expect, it } from "vitest";
import {
  isExecutionIntentStale,
  validateExecutionIntent,
  validateRetryAttempt,
} from "./execution_semantics.js";

describe("execution_semantics", () => {
  it("accepts a valid long-only execution intent", () => {
    const result = validateExecutionIntent({
      symbol: "BTC/USD",
      side: "buy",
      reduceOnly: false,
      idempotencyKey: "intent-001",
      signalBarCloseTs: 1_000,
      submitDecisionTs: 5_000,
      submitDeadlineMs: 15_000,
      orderStaleMs: 30_000,
    });

    expect(result.valid).toBe(true);
    expect(result.blockingReasons).toHaveLength(0);
  });

  it("rejects missing client order id, late submit, and long-only violations", () => {
    const result = validateExecutionIntent({
      symbol: "BTC/USD",
      side: "sell",
      reduceOnly: false,
      signalBarCloseTs: 10_000,
      submitDecisionTs: 30_500,
      submitDeadlineMs: 15_000,
      orderStaleMs: 30_000,
    });

    expect(result.valid).toBe(false);
    expect(result.blockingReasons).toContain(
      "execution_semantics_missing_client_order_id",
    );
    expect(result.blockingReasons).toContain(
      "execution_semantics_submit_deadline_exceeded",
    );
    expect(result.blockingReasons).toContain(
      "execution_semantics_long_only_violation",
    );
  });

  it("detects stale intents and rejects blind retry", () => {
    expect(
      isExecutionIntentStale(
        {
          signalBarCloseTs: 1_000,
          orderStaleMs: 30_000,
        },
        31_001,
      ),
    ).toBe(true);

    const retry = validateRetryAttempt({
      hasClientOrderId: false,
      reconcileCompleted: false,
      blindRetry: true,
    });
    expect(retry.valid).toBe(false);
    expect(retry.blockingReasons).toContain(
      "execution_semantics_retry_without_client_order_id",
    );
    expect(retry.blockingReasons).toContain(
      "execution_semantics_retry_without_reconcile",
    );
    expect(retry.blockingReasons).toContain(
      "execution_semantics_blind_retry_forbidden",
    );
  });
});
