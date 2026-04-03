/**
 * Crypto Operation Dispatcher
 *
 * Provider-agnostic bridge: Wallet Operation -> ICryptoTradingEngine method calls
 * Used as the WalletConfig.executeOperation callback
 */

import { randomUUID } from "node:crypto";
import { createCryptoOperationDispatcher as createDispatcher } from "./operation-dispatcher.core.js";
import type {
  CommitExecutorDeps,
  CommitOperation,
  CryptoOperationDispatcherOptions,
  PushResult,
} from "./operation-dispatcher.types.js";
import type { Operation } from "./wallet/types.js";

export { createCryptoOperationDispatcher } from "./operation-dispatcher.core.js";
export type {
  CommitExecutorDeps,
  CommitOperation,
  CryptoOperationDispatcher,
  CryptoOperationDispatcherOptions,
  OperationEntry,
  OperationOutcome,
  PlaceOrderHookInput,
  PlaceOrderResultHookInput,
  PushResult,
  SlippageConfig,
} from "./operation-dispatcher.types.js";

/**
 * @deprecated Use createCryptoOperationDispatcher().push() instead.
 * Thin wrapper kept for backward compatibility.
 */
export async function executeCommit(
  operations: CommitOperation[],
  deps: CommitExecutorDeps
): Promise<PushResult> {
  const options: CryptoOperationDispatcherOptions = {
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

  const dispatcher = createDispatcher(deps.engine, options);
  const commitId = randomUUID();
  const mappedOperations: Operation[] = operations.map(operation => ({
    action: operation.action as Operation["action"],
    params: { ...operation.params, ticketId: operation.ticketId },
  }));
  return dispatcher.push(commitId, mappedOperations);
}
