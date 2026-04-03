import type {
  ICryptoTradingEngine,
  CryptoPlaceOrderRequest,
  CryptoOrderResult,
} from "./interfaces.js";
import type { Operation } from "./wallet/types.js";
import type { RiskCheckContext, RiskCheckResult, RiskConfig } from "./risk.js";
import type { DecisionTicketStore } from "./decision-ticket.js";
import type { IntentLedger } from "./intent-ledger.js";
import type { TradeIdempotencyStore } from "./idempotency-store.js";
import type { KillSwitch } from "./kill-switch.js";

export interface PlaceOrderHookInput {
  operation: Operation;
  request: CryptoPlaceOrderRequest;
  expectedPrice?: number;
  riskContext?: RiskCheckContext;
}

export interface PlaceOrderResultHookInput extends PlaceOrderHookInput {
  result: CryptoOrderResult;
}

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

export interface SimpleActionResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

/** @deprecated Use OperationOutcome instead */
export type OperationEntry = OperationOutcome;

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
  ticketStore?: DecisionTicketStore;
  intentLedger?: IntentLedger;
  idempotencyStore?: TradeIdempotencyStore;
  killSwitch?: KillSwitch;
  exchangeId?: string;
  slippageConfig?: { maxSlippagePct: number; reduceOnlyMultiplier: number };
  eventLog?: { append: (type: string, payload: unknown) => Promise<unknown> };
}

export interface SlippageConfig {
  maxSlippagePct: number;
  reduceOnlyMultiplier: number;
}

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
