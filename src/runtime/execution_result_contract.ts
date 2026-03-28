import { z } from "zod";
import type { CryptoOrderStatus } from "../extension/crypto-trading/interfaces.js";
import {
  computeExecutionSlippageBps,
  type OrderExecutionRecord,
} from "../live/execution_quality.js";

const STRICT_UTC_ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const isoUtcSchema = z
  .string()
  .regex(STRICT_UTC_ISO_8601, "must be a strict ISO-8601 UTC timestamp");

const cryptoOrderStatusSchema = z.enum([
  "pending",
  "partially_filled",
  "filled",
  "cancelled",
  "rejected",
]);

export const executionResultV1Schema = z
  .object({
    schemaVersion: z.literal("execution_result.v1"),
    generatedAt: isoUtcSchema,
    symbol: z.string().min(1),
    action: z.enum(["placeOrder", "closePosition"]),
    success: z.boolean(),
    provenance: z
      .object({
        producer: z.string().min(1),
        environment: z.enum(["paper", "live", "demo"]),
      })
      .strict(),
    request: z
      .object({
        side: z.enum(["buy", "sell"]),
        reduceOnly: z.boolean(),
        type: z.enum(["market", "limit"]),
        idempotencyKey: z.string().min(1).optional(),
      })
      .strict(),
    outcome: z
      .object({
        orderId: z.string().min(1),
        orderStatus: cryptoOrderStatusSchema,
        requestedQty: z.number().positive(),
        filledQty: z.number().nonnegative(),
        expectedPrice: z.number().positive(),
        actualPrice: z.number().positive(),
        slippageBps: z.number().nullable(),
        submittedAtMs: z.number().int().nonnegative(),
        firstFillAtMs: z.number().int().nonnegative().nullable(),
        completedAtMs: z.number().int().nonnegative().nullable(),
        message: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

export type ExecutionResultV1 = z.infer<typeof executionResultV1Schema>;

export interface ContractValidationResult<T> {
  valid: boolean;
  blockingReasons: string[];
  value?: T;
}

export interface BuildExecutionResultV1Input {
  generatedAt?: string;
  symbol: string;
  action: "placeOrder" | "closePosition";
  success: boolean;
  producer: string;
  environment: "paper" | "live" | "demo";
  side: "buy" | "sell";
  reduceOnly: boolean;
  type: "market" | "limit";
  idempotencyKey?: string;
  orderStatus: CryptoOrderStatus;
  message?: string;
  record: OrderExecutionRecord;
}

function toBlockingReasons(
  prefix: string,
  issues: readonly z.ZodIssue[],
): string[] {
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${prefix}:${path}:${issue.message}`;
  });
}

export function validateExecutionResultV1(
  payload: unknown,
): ContractValidationResult<ExecutionResultV1> {
  const parsed = executionResultV1Schema.safeParse(payload);
  if (!parsed.success) {
    return {
      valid: false,
      blockingReasons: toBlockingReasons(
        "execution_result_schema_invalid",
        parsed.error.issues,
      ),
    };
  }

  const value = parsed.data;
  const blockingReasons: string[] = [];
  if (
    value.outcome.orderStatus === "filled" &&
    value.outcome.filledQty <= 0
  ) {
    blockingReasons.push("execution_result_filled_without_quantity");
  }
  if (
    value.outcome.completedAtMs !== null &&
    value.outcome.completedAtMs < value.outcome.submittedAtMs
  ) {
    blockingReasons.push("execution_result_completed_before_submit");
  }
  if (
    value.outcome.firstFillAtMs !== null &&
    value.outcome.firstFillAtMs < value.outcome.submittedAtMs
  ) {
    blockingReasons.push("execution_result_first_fill_before_submit");
  }
  if (value.success && value.outcome.actualPrice <= 0) {
    blockingReasons.push("execution_result_missing_actual_price");
  }

  return {
    valid: blockingReasons.length === 0,
    blockingReasons,
    value,
  };
}

export function buildExecutionResultV1(
  input: BuildExecutionResultV1Input,
): ExecutionResultV1 {
  const slippageBps = computeExecutionSlippageBps(input.record);
  const payload: ExecutionResultV1 = {
    schemaVersion: "execution_result.v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    symbol: input.symbol,
    action: input.action,
    success: input.success,
    provenance: {
      producer: input.producer,
      environment: input.environment,
    },
    request: {
      side: input.side,
      reduceOnly: input.reduceOnly,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
    },
    outcome: {
      orderId: input.record.orderId,
      orderStatus: input.orderStatus,
      requestedQty: input.record.requestedQty,
      filledQty: input.record.filledQty,
      expectedPrice: input.record.expectedPrice,
      actualPrice: input.record.actualPrice,
      slippageBps,
      submittedAtMs: input.record.submittedAtMs,
      firstFillAtMs: input.record.firstFillAtMs,
      completedAtMs: input.record.completedAtMs,
      message: input.message,
    },
  };

  const validation = validateExecutionResultV1(payload);
  if (!validation.valid || !validation.value) {
    throw new Error(validation.blockingReasons.join("; "));
  }
  return validation.value;
}
