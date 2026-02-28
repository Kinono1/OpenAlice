// Extension adapter
export { createCryptoTradingTools } from "./adapter";

// Trading domain types
export type {
  ICryptoTradingEngine,
  CryptoPlaceOrderRequest,
  CryptoOrderResult,
  CryptoOrder,
  CryptoPosition,
  CryptoAccountInfo,
  CryptoAllowedSymbol,
  SymbolPrecision,
} from "./interfaces";
export { CRYPTO_ALLOWED_SYMBOLS, initCryptoAllowedSymbols } from "./interfaces";

// Wallet domain
export { Wallet } from "./wallet/Wallet";
export type { IWallet, WalletConfig } from "./wallet/interfaces";
export type {
  Operation,
  WalletCommit,
  WalletExportState,
  CommitHash,
  OrderStatusUpdate,
  SyncResult,
} from "./wallet/types";

// Provider infrastructure
export { createCryptoTradingEngine } from "./factory";
export type { CryptoTradingEngineResult } from "./factory";
export { createCryptoOperationDispatcher } from "./operation-dispatcher";
export type {
  CryptoOperationDispatcherOptions,
  PlaceOrderHookInput,
  PlaceOrderResultHookInput,
} from "./operation-dispatcher";
export { createCryptoWalletStateBridge } from "./wallet-state-bridge";
export { preTradeRiskCheck } from "./risk";
export type { RiskConfig, RiskCheckResult, RiskCheckContext } from "./risk";

// Safety infrastructure
export { DecisionTicketStore } from "./decision-ticket";
export type { DecisionTicket, DecisionTicketConfig, TicketValidationResult } from "./decision-ticket";
export { IntentLedger } from "./intent-ledger";
export type { TradeIntent, IntentResult, IntentLedgerEntry } from "./intent-ledger";
export { TradeIdempotencyStore } from "./idempotency-store";
export type {
  TradeIdempotencyRecord,
  ReserveIdempotencyInput,
  ReserveIdempotencyResult,
  FinalizeIdempotencyInput,
} from "./idempotency-store";
export { KillSwitch } from "./kill-switch";
export type { KillSwitchPolicy, KillSwitchConfig, KillSwitchState, KillSwitchCheckResult } from "./kill-switch";
export { getExchangeCapability, getIdempotencyPolicy, CLIENT_ORDER_ID_FIELD } from "./exchange-capabilities";
export type { ExchangeCapability, IdempotencyDegradation } from "./exchange-capabilities";
export { PnLTracker } from "./pnl-tracker";
export type { PnLFill, PositionPnL, FIFOPositionPnL, ReconciliationResult } from "./pnl-tracker";
export { executeCommit } from "./operation-dispatcher";
export type {
  OperationEntry,
  OperationOutcome,
  PushResult,
  CommitOperation,
  SlippageConfig,
  CommitExecutorDeps,
} from "./operation-dispatcher";
