import type { ExecutionEvent } from './execution-protocol.js'

export interface ExecutionLifecycleSnapshotRequest {
  readonly accountId: string
  readonly canonicalSymbol: string
}

/**
 * A snapshot is opaque, canonical diagnostic state from the execution
 * sidecar.  It is deliberately not an order-terminal or broker-readiness
 * assertion; callers must use the lifecycle event stream for those claims.
 */
export type ExecutionLifecycleSnapshot =
  | { readonly found: false }
  | {
      readonly found: true
      readonly asOfSequence: string
      readonly canonicalJsonUtf8: Uint8Array
      readonly parsed: unknown
    }

export interface ExecutionLifecycleReplayRequest {
  /** Canonical uint64 cursor.  Returned events must begin at the next value. */
  readonly afterSequence: string
  /** Bounded page size accepted by the wire contract. */
  readonly limit: number
}

export interface ExecutionLifecycleStreamRequest {
  /** Canonical uint64 cursor.  Streamed events must begin at the next value. */
  readonly afterSequence: string
}

export interface ExecutionLifecycleReadOptions {
  readonly signal?: AbortSignal
}

export interface ExecutionLifecycleStreamOptions {
  /** Mandatory lifetime control; the live stream intentionally has no unary RPC deadline. */
  readonly signal: AbortSignal
}

/**
 * Read-only lifecycle API, intentionally separate from command admission.
 * It cannot submit commands, launch a broker client, or infer terminal state
 * from a snapshot.
 */
export interface ExecutionLifecycleReadModel {
  getSnapshot(
    request: ExecutionLifecycleSnapshotRequest,
    options?: ExecutionLifecycleReadOptions,
  ): Promise<ExecutionLifecycleSnapshot>
  replayEvents(
    request: ExecutionLifecycleReplayRequest,
    options?: ExecutionLifecycleReadOptions,
  ): Promise<readonly ExecutionEvent[]>
  streamEvents(
    request: ExecutionLifecycleStreamRequest,
    options: ExecutionLifecycleStreamOptions,
  ): AsyncIterable<ExecutionEvent>
}
