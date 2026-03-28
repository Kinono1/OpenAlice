export interface ExecutionIntent {
  symbol: string;
  side: "buy" | "sell";
  reduceOnly?: boolean;
  idempotencyKey?: string;
  signalBarCloseTs: number;
  submitDecisionTs: number;
  submitDeadlineMs: number;
  orderStaleMs: number;
}

export interface ExecutionSemanticsValidation {
  valid: boolean;
  blockingReasons: string[];
}

export function validateExecutionIntent(
  intent: ExecutionIntent,
): ExecutionSemanticsValidation {
  const blockingReasons: string[] = [];

  if (intent.submitDecisionTs < intent.signalBarCloseTs) {
    blockingReasons.push("execution_semantics_submit_before_signal_close");
  }
  if (
    intent.submitDecisionTs >
    intent.signalBarCloseTs + intent.submitDeadlineMs
  ) {
    blockingReasons.push("execution_semantics_submit_deadline_exceeded");
  }
  if (!intent.idempotencyKey || intent.idempotencyKey.trim().length === 0) {
    blockingReasons.push("execution_semantics_missing_client_order_id");
  }
  if (!intent.reduceOnly && intent.side !== "buy") {
    blockingReasons.push("execution_semantics_long_only_violation");
  }
  if (intent.submitDeadlineMs <= 0 || intent.orderStaleMs <= 0) {
    blockingReasons.push("execution_semantics_invalid_deadline");
  }

  return {
    valid: blockingReasons.length === 0,
    blockingReasons,
  };
}

export function isExecutionIntentStale(
  intent: Pick<ExecutionIntent, "signalBarCloseTs" | "orderStaleMs">,
  nowMs: number,
): boolean {
  return nowMs > intent.signalBarCloseTs + intent.orderStaleMs;
}

export interface RetryValidationInput {
  hasClientOrderId: boolean;
  reconcileCompleted: boolean;
  blindRetry: boolean;
}

export function validateRetryAttempt(
  input: RetryValidationInput,
): ExecutionSemanticsValidation {
  const blockingReasons: string[] = [];
  if (!input.hasClientOrderId) {
    blockingReasons.push("execution_semantics_retry_without_client_order_id");
  }
  if (!input.reconcileCompleted) {
    blockingReasons.push("execution_semantics_retry_without_reconcile");
  }
  if (input.blindRetry) {
    blockingReasons.push("execution_semantics_blind_retry_forbidden");
  }

  return {
    valid: blockingReasons.length === 0,
    blockingReasons,
  };
}
