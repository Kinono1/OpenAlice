import type {
  OfflineExecutionReceiptExpectedBinding,
  OfflineExecutionReceiptTrustPolicy,
  OfflineExecutionReceiptV1,
} from './offline-execution-receipt.js'
import type { ExecutionEventV2 } from './execution-protocol.js'

export interface ExecutionOfflineReceiptRequest {
  readonly receiptId: string
  readonly trustPolicy: OfflineExecutionReceiptTrustPolicy
  readonly expected: OfflineExecutionReceiptExpectedBinding
  readonly now?: Date
  readonly maxFutureMs?: number
}

export interface ExecutionOfflineReceiptReadOptions {
  readonly signal?: AbortSignal
}

export type ExecutionOfflineReceiptReadResult =
  | { readonly found: false }
  | {
      readonly found: true
      readonly finalizationEligible: false
      readonly receipt: OfflineExecutionReceiptV1
      readonly lifecycleEvent: ExecutionEventV2
      readonly canonicalReceiptJsonUtf8: Uint8Array
      readonly canonicalRequestJsonUtf8: Uint8Array
      readonly canonicalResponseJsonUtf8: Uint8Array
    }

/**
 * Trusted, read-only access to simulator evidence. A successful result remains
 * ineligible for broker finalization and cannot release unresolved idempotency.
 */
export interface ExecutionOfflineReceiptReadModel {
  getOfflineExecutionReceipt(
    request: ExecutionOfflineReceiptRequest,
    options?: ExecutionOfflineReceiptReadOptions,
  ): Promise<ExecutionOfflineReceiptReadResult>
}
