import { describe, expect, it } from "vitest";
import {
  buildExecutionResultV1,
  validateExecutionResultV1,
} from "./execution_result_contract.js";

describe("execution_result_contract", () => {
  it("builds and validates a canonical execution result", () => {
    const payload = buildExecutionResultV1({
      generatedAt: "2026-03-26T12:00:00.000Z",
      symbol: "BTC/USD",
      action: "placeOrder",
      success: true,
      producer: "openalice.live_gate_manager",
      environment: "paper",
      side: "buy",
      reduceOnly: false,
      type: "market",
      idempotencyKey: "intent-001",
      orderStatus: "filled",
      message: "paper fill completed",
      record: {
        orderId: "ord-123",
        symbol: "BTC/USD",
        side: "buy",
        expectedPrice: 100,
        actualPrice: 101,
        requestedQty: 0.2,
        filledQty: 0.2,
        submittedAtMs: 1_774_000_000_000,
        firstFillAtMs: 1_774_000_000_500,
        completedAtMs: 1_774_000_001_000,
      },
    });

    expect(payload.schemaVersion).toBe("execution_result.v1");
    expect(payload.outcome.slippageBps).toBe(100);
    expect(validateExecutionResultV1(payload).valid).toBe(true);
  });

  it("rejects inconsistent execution outcomes", () => {
    const result = validateExecutionResultV1({
      schemaVersion: "execution_result.v1",
      generatedAt: "2026-03-26T12:00:00.000Z",
      symbol: "BTC/USD",
      action: "closePosition",
      success: true,
      provenance: {
        producer: "openalice.paper_executor",
        environment: "paper",
      },
      request: {
        side: "sell",
        reduceOnly: true,
        type: "market",
      },
      outcome: {
        orderId: "ord-bad",
        orderStatus: "filled",
        requestedQty: 0.2,
        filledQty: 0,
        expectedPrice: 100,
        actualPrice: 101,
        slippageBps: 100,
        submittedAtMs: 1_000,
        firstFillAtMs: 900,
        completedAtMs: 800,
      },
    });

    expect(result.valid).toBe(false);
    expect(result.blockingReasons).toContain(
      "execution_result_filled_without_quantity",
    );
    expect(result.blockingReasons).toContain(
      "execution_result_completed_before_submit",
    );
    expect(result.blockingReasons).toContain(
      "execution_result_first_fill_before_submit",
    );
  });
});
