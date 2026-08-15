import Decimal from 'decimal.js'
import {
  executionCommandV1Schema,
  executionEventV1Schema,
  type ExecutionCommandV1,
  type ExecutionEventV1,
} from './execution-protocol.js'

const UINT64_MAX = 18_446_744_073_709_551_615n
const POSITIVE_UINT64_RE = /^[1-9][0-9]*$/

export const EXECUTION_TERMINAL_STATUSES = [
  'ADMITTED_DURABLE_NOT_SUBMITTED',
  'ACKNOWLEDGED',
  'SUBMITTED',
  'PARTIALLY_FILLED',
  'SUBMISSION_UNKNOWN',
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
  'RECONCILIATION_BLOCKED',
  'CONFLICTED',
] as const

export type ExecutionTerminalStatus = typeof EXECUTION_TERMINAL_STATUSES[number]

export type ExecutionTerminalConflictCode =
  | 'invalid_event_contract'
  | 'same_sequence_different_event'
  | 'retrograde_sequence'
  | 'sequence_gap'
  | 'target_event_after_lifecycle_terminal'
  | 'target_event_after_reconciliation_block'
  | 'target_event_after_conflict'
  | 'client_order_id_drift'
  | 'venue_order_id_drift'
  | 'illegal_transition'
  | 'fill_without_order_quantity'
  | 'fill_quantity_nonprogressing'
  | 'fill_quantity_exceeds_order'
  | 'partial_fill_reaches_order_quantity'
  | 'filled_quantity_not_order_quantity'
  | 'rejected_after_fill'

export interface ExecutionTerminalConflict {
  readonly code: ExecutionTerminalConflictCode
  readonly message: string
  readonly priorStatus: ExecutionTerminalStatus
  readonly attemptedEventId?: string
  readonly attemptedSequence?: string
  readonly attemptedCommandId?: string
  readonly attemptedKind?: string
}

export interface ExecutionReconciliationBlock {
  readonly kind: 'drift' | 'suspended'
  readonly reason: string
  readonly eventId: string
  readonly sequence: string
}

export interface DurableExecutionAdmission {
  readonly command: ExecutionCommandV1
  /** Dedicated lifecycle sequence of the durable acknowledged event. */
  readonly acceptedSequence: string
}

/**
 * Pure projection of one command over a globally sequenced lifecycle stream.
 *
 * `terminal` means that this reducer cannot safely infer more lifecycle state.
 * `lifecycleTerminal` only classifies a terminal-looking event in the sidecar
 * stream.  It is not broker proof and must never release command idempotency
 * without a separately authenticated execution-adapter receipt.  A conflict
 * is terminal for this projection but never lifecycle-terminal.
 */
export interface ExecutionTerminalProjection {
  readonly commandId: string
  readonly commandKind: ExecutionCommandV1['payload']['kind']
  readonly acceptedSequence: string
  /** Last globally contiguous event cursor consumed by this projection. */
  readonly asOfSequence: string
  readonly lastEventId?: string
  readonly lastEventCommandId?: string
  readonly lastTargetEventId?: string
  readonly lastTargetEventKind?: ExecutionEventV1['kind']
  readonly status: ExecutionTerminalStatus
  readonly terminal: boolean
  readonly lifecycleTerminal: boolean
  readonly orderedQuantity?: string
  readonly cumulativeFilledQuantity: string
  readonly averagePrice?: string
  readonly clientOrderId?: string
  readonly venueOrderId?: string
  readonly lastReason?: string
  readonly reconciliationBlocks: readonly ExecutionReconciliationBlock[]
  readonly conflicts: readonly ExecutionTerminalConflict[]
}

/** Creates the explicit non-terminal state proven by durable command admission. */
export function createExecutionTerminalProjection(
  admission: DurableExecutionAdmission,
): ExecutionTerminalProjection {
  const command = executionCommandV1Schema.safeParse(admission.command)
  if (!command.success) throw new Error('execution_terminal_invalid_command')
  const acceptedSequence = requiredPositiveUint64(admission.acceptedSequence)
  const orderedQuantity = commandQuantity(command.data)
  return {
    commandId: command.data.commandId,
    commandKind: command.data.payload.kind,
    acceptedSequence,
    asOfSequence: acceptedSequence,
    status: 'ADMITTED_DURABLE_NOT_SUBMITTED',
    terminal: false,
    lifecycleTerminal: false,
    ...(orderedQuantity === undefined ? {} : { orderedQuantity }),
    ...(commandClientOrderId(command.data) === undefined
      ? {}
      : { clientOrderId: commandClientOrderId(command.data) }),
    cumulativeFilledQuantity: '0',
    reconciliationBlocks: [],
    conflicts: [],
  }
}

/**
 * Applies exactly one globally sequenced event without I/O or side effects.
 * Structurally invalid or non-contiguous evidence fails closed as CONFLICTED.
 */
export function applyExecutionEvent(
  projection: ExecutionTerminalProjection,
  input: unknown,
): ExecutionTerminalProjection {
  const parsed = executionEventV1Schema.safeParse(input)
  if (!parsed.success) {
    return conflictProjection(
      projection,
      'invalid_event_contract',
      parsed.error.issues
        .map(issue => `${issue.path.join('.') || '<root>'}:${issue.message}`)
        .join('; '),
      input,
    )
  }
  const event: ExecutionEventV1 = parsed.data
  const eventSequence = BigInt(event.sequence)
  const asOfSequence = BigInt(projection.asOfSequence)

  if (eventSequence === asOfSequence) {
    if (event.eventId === projection.lastEventId) return projection
    return conflictProjection(
      projection,
      'same_sequence_different_event',
      'the current global sequence was already consumed with a different event id',
      event,
    )
  }
  if (eventSequence < asOfSequence) {
    return conflictProjection(
      projection,
      'retrograde_sequence',
      'only an exact duplicate of the last consumed event may be replayed',
      event,
    )
  }
  if (asOfSequence === UINT64_MAX || eventSequence !== asOfSequence + 1n) {
    return conflictProjection(
      projection,
      'sequence_gap',
      'the global lifecycle stream is not contiguous',
      event,
    )
  }

  const advanced = advanceGlobalCursor(projection, event)
  // ReplayEvents is global. Other commands consume a cursor but must never
  // mutate this command's order identity or lifecycle state.
  if (event.commandId !== projection.commandId) return advanced

  if (isLifecycleTerminalStatus(projection.status)) {
    return conflictProjection(
      advanced,
      'target_event_after_lifecycle_terminal',
      `target event ${event.kind} followed lifecycle terminal state ${projection.status}`,
      event,
      projection.status,
    )
  }
  if (projection.status === 'CONFLICTED') {
    return conflictProjection(
      advanced,
      'target_event_after_conflict',
      'target command received more evidence after the projection became conflicted',
      event,
      projection.status,
    )
  }

  const identified = bindOrderIdentities(advanced, event, projection.status)
  if (identified.status === 'CONFLICTED') return identified
  const observed: ExecutionTerminalProjection = {
    ...identified,
    lastTargetEventId: event.eventId,
    lastTargetEventKind: event.kind,
    lastReason: event.reason,
  }
  if (
    projection.status === 'RECONCILIATION_BLOCKED'
    && event.kind !== 'reconciled'
    && event.kind !== 'drift'
    && event.kind !== 'suspended'
  ) {
    return conflictProjection(
      observed,
      'target_event_after_reconciliation_block',
      `target event ${event.kind} cannot automatically clear a reconciliation block`,
      event,
      projection.status,
    )
  }
  return applyTargetEvent(observed, event)
}

/** Applies a replay page in order, retaining an explicit conflict if one occurs. */
export function applyExecutionEvents(
  projection: ExecutionTerminalProjection,
  events: readonly unknown[],
): ExecutionTerminalProjection {
  return events.reduce(applyExecutionEvent, projection)
}

function applyTargetEvent(
  projection: ExecutionTerminalProjection,
  event: ExecutionEventV1,
): ExecutionTerminalProjection {
  switch (event.kind) {
    case 'reconciled':
      // A bare audit marker proves neither submission nor a lifecycle terminal,
      // and no lifecycle event by itself proves a broker outcome.
      return projection
    case 'drift':
    case 'suspended':
      return withStatus({
        ...projection,
        reconciliationBlocks: [
          ...projection.reconciliationBlocks,
          {
            kind: event.kind,
            // The protocol schema requires a reason for both branch kinds.
            reason: event.reason!,
            eventId: event.eventId,
            sequence: event.sequence,
          },
        ],
      }, 'RECONCILIATION_BLOCKED')
    case 'acknowledged':
      if (projection.status === 'RECONCILIATION_BLOCKED') return projection
      if (![
        'ADMITTED_DURABLE_NOT_SUBMITTED',
        'ACKNOWLEDGED',
        'SUBMISSION_UNKNOWN',
      ].includes(projection.status)) {
        return illegalTransition(projection, event)
      }
      return withStatus(projection, 'ACKNOWLEDGED')
    case 'submitted':
      if (projection.status === 'RECONCILIATION_BLOCKED') return projection
      if (![
        'ADMITTED_DURABLE_NOT_SUBMITTED',
        'ACKNOWLEDGED',
        'SUBMITTED',
        'SUBMISSION_UNKNOWN',
      ].includes(projection.status)) {
        return illegalTransition(projection, event)
      }
      return withStatus(projection, 'SUBMITTED')
    case 'submission_unknown':
      if (projection.status === 'RECONCILIATION_BLOCKED') return projection
      if (![
        'ADMITTED_DURABLE_NOT_SUBMITTED',
        'ACKNOWLEDGED',
        'SUBMITTED',
        'PARTIALLY_FILLED',
        'SUBMISSION_UNKNOWN',
      ].includes(projection.status)) {
        return illegalTransition(projection, event)
      }
      return withStatus(projection, 'SUBMISSION_UNKNOWN')
    case 'partially_filled': {
      const filled = applyFill(projection, event, false)
      if (filled.status === 'CONFLICTED') return filled
      if (projection.status === 'RECONCILIATION_BLOCKED') return filled
      if (![
        'ADMITTED_DURABLE_NOT_SUBMITTED',
        'ACKNOWLEDGED',
        'SUBMITTED',
        'PARTIALLY_FILLED',
        'SUBMISSION_UNKNOWN',
      ].includes(projection.status)) {
        return illegalTransition(filled, event, projection.status)
      }
      return withStatus(filled, 'PARTIALLY_FILLED')
    }
    case 'filled': {
      const filled = applyFill(projection, event, true)
      return filled.status === 'CONFLICTED' ? filled : withStatus(filled, 'FILLED')
    }
    case 'canceled':
      return withStatus(projection, 'CANCELED')
    case 'expired':
      return withStatus(projection, 'EXPIRED')
    case 'rejected':
      if (new Decimal(projection.cumulativeFilledQuantity).gt(0)) {
        return conflictProjection(
          projection,
          'rejected_after_fill',
          'a command with durable fill evidence cannot transition to rejected',
          event,
        )
      }
      return withStatus(projection, 'REJECTED')
  }
}

function applyFill(
  projection: ExecutionTerminalProjection,
  event: ExecutionEventV1,
  complete: boolean,
): ExecutionTerminalProjection {
  if (projection.orderedQuantity === undefined) {
    return conflictProjection(
      projection,
      'fill_without_order_quantity',
      `command kind ${projection.commandKind} has no authoritative order quantity`,
      event,
    )
  }
  // executionEventV1Schema proves both values exist for either fill kind.
  const next = new Decimal(event.filledQuantity!)
  const previous = new Decimal(projection.cumulativeFilledQuantity)
  const ordered = new Decimal(projection.orderedQuantity)
  if (next.lte(previous)) {
    return conflictProjection(
      projection,
      'fill_quantity_nonprogressing',
      'cumulative filled quantity must increase strictly',
      event,
    )
  }
  if (next.gt(ordered)) {
    return conflictProjection(
      projection,
      'fill_quantity_exceeds_order',
      'cumulative filled quantity exceeds the admitted order quantity',
      event,
    )
  }
  if (!complete && next.eq(ordered)) {
    return conflictProjection(
      projection,
      'partial_fill_reaches_order_quantity',
      'a partial fill cannot equal the admitted order quantity',
      event,
    )
  }
  if (complete && !next.eq(ordered)) {
    return conflictProjection(
      projection,
      'filled_quantity_not_order_quantity',
      'a filled event must equal the admitted order quantity',
      event,
    )
  }
  return {
    ...projection,
    cumulativeFilledQuantity: next.toFixed(),
    averagePrice: new Decimal(event.averagePrice!).toFixed(),
  }
}

function bindOrderIdentities(
  projection: ExecutionTerminalProjection,
  event: ExecutionEventV1,
  priorStatus: ExecutionTerminalStatus,
): ExecutionTerminalProjection {
  if (
    event.clientOrderId !== undefined
    && projection.clientOrderId !== undefined
    && event.clientOrderId !== projection.clientOrderId
  ) {
    return conflictProjection(
      projection,
      'client_order_id_drift',
      'clientOrderId changed after it was bound',
      event,
      priorStatus,
    )
  }
  if (
    event.venueOrderId !== undefined
    && projection.venueOrderId !== undefined
    && event.venueOrderId !== projection.venueOrderId
  ) {
    return conflictProjection(
      projection,
      'venue_order_id_drift',
      'venueOrderId changed after it was bound',
      event,
      priorStatus,
    )
  }
  return {
    ...projection,
    ...(projection.clientOrderId === undefined && event.clientOrderId !== undefined
      ? { clientOrderId: event.clientOrderId }
      : {}),
    ...(projection.venueOrderId === undefined && event.venueOrderId !== undefined
      ? { venueOrderId: event.venueOrderId }
      : {}),
  }
}

function advanceGlobalCursor(
  projection: ExecutionTerminalProjection,
  event: ExecutionEventV1,
): ExecutionTerminalProjection {
  return {
    ...projection,
    asOfSequence: event.sequence,
    lastEventId: event.eventId,
    lastEventCommandId: event.commandId,
  }
}

function illegalTransition(
  projection: ExecutionTerminalProjection,
  event: ExecutionEventV1,
  priorStatus: ExecutionTerminalStatus = projection.status,
): ExecutionTerminalProjection {
  return conflictProjection(
    projection,
    'illegal_transition',
    `event ${event.kind} cannot follow state ${priorStatus}`,
    event,
    priorStatus,
  )
}

function conflictProjection(
  projection: ExecutionTerminalProjection,
  code: ExecutionTerminalConflictCode,
  message: string,
  input?: unknown,
  priorStatus: ExecutionTerminalStatus = projection.status,
): ExecutionTerminalProjection {
  const metadata = eventMetadata(input)
  return {
    ...projection,
    status: 'CONFLICTED',
    terminal: true,
    lifecycleTerminal: false,
    conflicts: [
      ...projection.conflicts,
      {
        code,
        message,
        priorStatus,
        ...(metadata.eventId === undefined ? {} : { attemptedEventId: metadata.eventId }),
        ...(metadata.sequence === undefined ? {} : { attemptedSequence: metadata.sequence }),
        ...(metadata.commandId === undefined ? {} : { attemptedCommandId: metadata.commandId }),
        ...(metadata.kind === undefined ? {} : { attemptedKind: metadata.kind }),
      },
    ],
  }
}

function eventMetadata(input: unknown): {
  eventId?: string
  sequence?: string
  commandId?: string
  kind?: string
} {
  if (typeof input !== 'object' || input === null) return {}
  const record = input as Record<string, unknown>
  return {
    ...(typeof record.eventId === 'string' ? { eventId: record.eventId } : {}),
    ...(typeof record.sequence === 'string' ? { sequence: record.sequence } : {}),
    ...(typeof record.commandId === 'string' ? { commandId: record.commandId } : {}),
    ...(typeof record.kind === 'string' ? { kind: record.kind } : {}),
  }
}

function withStatus(
  projection: ExecutionTerminalProjection,
  status: ExecutionTerminalStatus,
): ExecutionTerminalProjection {
  const lifecycleTerminal = isLifecycleTerminalStatus(status)
  return {
    ...projection,
    status,
    terminal: lifecycleTerminal || status === 'CONFLICTED',
    lifecycleTerminal,
  }
}

function isLifecycleTerminalStatus(status: ExecutionTerminalStatus): boolean {
  return status === 'FILLED'
    || status === 'CANCELED'
    || status === 'REJECTED'
    || status === 'EXPIRED'
}

function commandQuantity(command: ExecutionCommandV1): string | undefined {
  if (command.payload.kind !== 'submit' && command.payload.kind !== 'replace') return undefined
  return new Decimal(command.payload.quantity).toFixed()
}

function commandClientOrderId(command: ExecutionCommandV1): string | undefined {
  switch (command.payload.kind) {
    case 'submit': return command.payload.clientOrderId
    case 'replace': return command.payload.replacementClientOrderId
    case 'cancel': return command.payload.targetClientOrderId
    case 'reconcile':
    case 'suspend':
      return undefined
  }
}

function requiredPositiveUint64(value: string): string {
  if (!POSITIVE_UINT64_RE.test(value) || BigInt(value) > UINT64_MAX) {
    throw new Error('execution_terminal_invalid_accepted_sequence')
  }
  return value
}
