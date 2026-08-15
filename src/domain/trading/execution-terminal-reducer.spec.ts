import { describe, expect, it } from 'vitest'
import {
  buildExecutionCommandV1,
  buildExecutionEventV1,
  deriveOkxClientOrderId,
  type ExecutionCommandV1,
  type ExecutionEventV1,
} from './execution-protocol.js'
import {
  applyExecutionEvent,
  applyExecutionEvents,
  createExecutionTerminalProjection,
  type ExecutionTerminalProjection,
  type ExecutionTerminalStatus,
} from './execution-terminal-reducer.js'

const CLIENT_ORDER_ID = deriveOkxClientOrderId('terminal-reducer-intent')
const UNRELATED_COMMAND_ID = 'f'.repeat(64)

describe('execution terminal reducer', () => {
  it('starts from durable admission without claiming submission or a lifecycle terminal', () => {
    const projection = admitted()

    expect(projection).toMatchObject({
      commandId: COMMAND.commandId,
      commandKind: 'submit',
      acceptedSequence: '10',
      asOfSequence: '10',
      status: 'ADMITTED_DURABLE_NOT_SUBMITTED',
      terminal: false,
      lifecycleTerminal: false,
      orderedQuantity: '1.25',
      cumulativeFilledQuantity: '0',
      clientOrderId: CLIENT_ORDER_ID,
      reconciliationBlocks: [],
      conflicts: [],
    })
  })

  it.each([
    ['acknowledged', 'ACKNOWLEDGED', false, false],
    ['submitted', 'SUBMITTED', false, false],
    ['partially_filled', 'PARTIALLY_FILLED', false, false],
    ['submission_unknown', 'SUBMISSION_UNKNOWN', false, false],
    ['filled', 'FILLED', true, true],
    ['canceled', 'CANCELED', true, true],
    ['rejected', 'REJECTED', true, true],
    ['expired', 'EXPIRED', true, true],
    ['drift', 'RECONCILIATION_BLOCKED', false, false],
    ['suspended', 'RECONCILIATION_BLOCKED', false, false],
    ['reconciled', 'ADMITTED_DURABLE_NOT_SUBMITTED', false, false],
  ] as const)(
    'maps %s to %s with lifecycle terminal flags kept separate',
    (kind, status, terminal, lifecycleTerminal) => {
      const projection = applyExecutionEvent(admitted(), event('11', kind))
      expect(projection).toMatchObject({ status, terminal, lifecycleTerminal, asOfSequence: '11' })
    },
  )

  it('accumulates canonical fill evidence and preserves it through cancellation', () => {
    const projection = applyExecutionEvents(admitted(), [
      event('11', 'acknowledged', { venueOrderId: 'venue-1' }),
      event('12', 'submitted', { venueOrderId: 'venue-1' }),
      event('13', 'partially_filled', {
        venueOrderId: 'venue-1', filledQuantity: '0.5', averagePrice: '100.25',
      }),
      event('14', 'partially_filled', {
        venueOrderId: 'venue-1', filledQuantity: '0.75', averagePrice: '100.5',
      }),
      event('15', 'canceled', { venueOrderId: 'venue-1' }),
    ])

    expect(projection).toMatchObject({
      status: 'CANCELED',
      terminal: true,
      lifecycleTerminal: true,
      cumulativeFilledQuantity: '0.75',
      averagePrice: '100.5',
      venueOrderId: 'venue-1',
      asOfSequence: '15',
    })
  })

  it('preserves partial fill evidence through expiration', () => {
    const projection = applyExecutionEvents(admitted(), [
      event('11', 'partially_filled', { filledQuantity: '0.25', averagePrice: '99.5' }),
      event('12', 'expired'),
    ])
    expect(projection).toMatchObject({
      status: 'EXPIRED',
      cumulativeFilledQuantity: '0.25',
      averagePrice: '99.5',
      lifecycleTerminal: true,
    })
  })

  it('accepts an exact duplicate of only the last event as an object-identity no-op', () => {
    const acknowledged = event('11', 'acknowledged')
    const once = applyExecutionEvent(admitted(), acknowledged)
    const duplicate = applyExecutionEvent(once, acknowledged)

    expect(duplicate).toBe(once)
    expect(duplicate.conflicts).toEqual([])
  })

  it('conflicts on a different event at the same sequence without moving the cursor', () => {
    const once = applyExecutionEvent(admitted(), event('11', 'acknowledged'))
    const conflicted = applyExecutionEvent(once, event('11', 'submitted'))

    expectConflict(conflicted, 'same_sequence_different_event')
    expect(conflicted.asOfSequence).toBe('11')
  })

  it('conflicts on retrograde unseen evidence and a global sequence gap', () => {
    const once = applyExecutionEvent(admitted(), event('11', 'acknowledged'))
    const retrograde = applyExecutionEvent(once, event('10', 'submitted'))
    const gap = applyExecutionEvent(admitted(), event('12', 'submitted'))

    expectConflict(retrograde, 'retrograde_sequence')
    expect(retrograde.asOfSequence).toBe('11')
    expectConflict(gap, 'sequence_gap')
    expect(gap.asOfSequence).toBe('10')
  })

  it('conflicts on schema or event-hash tampering without trusting its cursor', () => {
    const valid = event('11', 'submission_unknown')
    const tampered = { ...valid, reason: 'different-reason' }
    const projection = applyExecutionEvent(admitted(), tampered)

    expectConflict(projection, 'invalid_event_contract')
    expect(projection.asOfSequence).toBe('10')
    expect(projection.conflicts[0]?.attemptedEventId).toBe(valid.eventId)
  })

  it('advances over unrelated globally sequenced events before the target terminal event', () => {
    const unrelated = event('11', 'submitted', { commandId: UNRELATED_COMMAND_ID })
    const terminal = event('12', 'filled')
    const projection = applyExecutionEvents(admitted(), [unrelated, terminal])

    expect(projection).toMatchObject({
      status: 'FILLED',
      lifecycleTerminal: true,
      terminal: true,
      asOfSequence: '12',
      lastEventCommandId: COMMAND.commandId,
      cumulativeFilledQuantity: '1.25',
    })
    expect(projection.conflicts).toEqual([])
  })

  it('advances unrelated events after terminal but conflicts on any later target event', () => {
    const filled = applyExecutionEvent(admitted(), event('11', 'filled'))
    const unrelated = applyExecutionEvent(
      filled,
      event('12', 'acknowledged', { commandId: UNRELATED_COMMAND_ID }),
    )
    const conflicted = applyExecutionEvent(unrelated, event('13', 'canceled'))

    expect(unrelated).toMatchObject({ status: 'FILLED', lifecycleTerminal: true, asOfSequence: '12' })
    expectConflict(conflicted, 'target_event_after_lifecycle_terminal')
    expect(conflicted).toMatchObject({
      lifecycleTerminal: false,
      terminal: true,
      cumulativeFilledQuantity: '1.25',
      asOfSequence: '13',
    })
    expect(conflicted.conflicts[0]?.priorStatus).toBe('FILLED')
  })

  it('binds venue identity once and conflicts on client or venue identity drift', () => {
    const submitted = applyExecutionEvent(
      admitted(),
      event('11', 'submitted', { venueOrderId: 'venue-1' }),
    )
    const venueDrift = applyExecutionEvent(
      submitted,
      event('12', 'partially_filled', {
        venueOrderId: 'venue-2', filledQuantity: '0.5', averagePrice: '100',
      }),
    )
    const clientDrift = applyExecutionEvent(
      admitted(),
      event('11', 'submitted', { clientOrderId: 'OTHERCLIENT1' }),
    )

    expectConflict(venueDrift, 'venue_order_id_drift')
    expect(venueDrift).toMatchObject({ venueOrderId: 'venue-1', asOfSequence: '12' })
    expectConflict(clientDrift, 'client_order_id_drift')
    expect(clientDrift.clientOrderId).toBe(CLIENT_ORDER_ID)
  })

  it('conflicts on lifecycle regressions instead of guessing a state', () => {
    const submitted = applyExecutionEvent(admitted(), event('11', 'submitted'))
    const acknowledged = applyExecutionEvent(submitted, event('12', 'acknowledged'))
    expectConflict(acknowledged, 'illegal_transition')

    const partial = applyExecutionEvent(admitted(), event('11', 'partially_filled'))
    const rejected = applyExecutionEvent(partial, event('12', 'rejected'))
    expectConflict(rejected, 'rejected_after_fill')
    expect(rejected.cumulativeFilledQuantity).toBe('0.5')
  })

  it.each([
    ['nonprogressing', [
      event('11', 'partially_filled', { filledQuantity: '0.5', averagePrice: '100' }),
      event('12', 'partially_filled', { filledQuantity: '0.5', averagePrice: '101' }),
    ], 'fill_quantity_nonprogressing'],
    ['regressing', [
      event('11', 'partially_filled', { filledQuantity: '0.5', averagePrice: '100' }),
      event('12', 'partially_filled', { filledQuantity: '0.4', averagePrice: '101' }),
    ], 'fill_quantity_nonprogressing'],
    ['overfilled', [event('11', 'filled', { filledQuantity: '1.5', averagePrice: '100' })],
      'fill_quantity_exceeds_order'],
    ['partial-at-total', [event('11', 'partially_filled', {
      filledQuantity: '1.25', averagePrice: '100',
    })], 'partial_fill_reaches_order_quantity'],
    ['filled-under-total', [event('11', 'filled', {
      filledQuantity: '1', averagePrice: '100',
    })], 'filled_quantity_not_order_quantity'],
  ] as const)('conflicts on %s fill evidence', (_name, events, code) => {
    expectConflict(applyExecutionEvents(admitted(), events), code)
  })

  it('treats reconciled as audit-only and does not clear submission unknown', () => {
    const unknown = applyExecutionEvent(admitted(), event('11', 'submission_unknown'))
    const reconciled = applyExecutionEvent(unknown, event('12', 'reconciled'))

    expect(reconciled).toMatchObject({
      status: 'SUBMISSION_UNKNOWN',
      terminal: false,
      lifecycleTerminal: false,
      asOfSequence: '12',
      lastTargetEventKind: 'reconciled',
    })
  })

  it('keeps drift and suspension reconciliation-blocked and never lifecycle-terminal', () => {
    const drift = applyExecutionEvent(admitted(), event('11', 'drift'))
    const reconciled = applyExecutionEvent(drift, event('12', 'reconciled'))
    const suspended = applyExecutionEvent(reconciled, event('13', 'suspended'))

    expect(suspended).toMatchObject({
      status: 'RECONCILIATION_BLOCKED',
      terminal: false,
      lifecycleTerminal: false,
      asOfSequence: '13',
    })
    expect(suspended.reconciliationBlocks.map(block => block.kind)).toEqual(['drift', 'suspended'])
  })

  it('never lets later broker-looking evidence automatically clear a reconciliation block', () => {
    const drift = applyExecutionEvent(admitted(), event('11', 'drift'))
    const filled = applyExecutionEvent(drift, event('12', 'filled'))

    expectConflict(filled, 'target_event_after_reconciliation_block')
    expect(filled).toMatchObject({
      lifecycleTerminal: false,
      cumulativeFilledQuantity: '0',
      asOfSequence: '12',
    })
  })

  it('permits submission uncertainty after submitted or partial evidence without terminalizing', () => {
    const submittedUnknown = applyExecutionEvents(admitted(), [
      event('11', 'submitted'),
      event('12', 'submission_unknown'),
    ])
    const partialUnknown = applyExecutionEvents(admitted(), [
      event('11', 'partially_filled'),
      event('12', 'submission_unknown'),
    ])

    expect(submittedUnknown).toMatchObject({
      status: 'SUBMISSION_UNKNOWN', terminal: false, lifecycleTerminal: false,
    })
    expect(partialUnknown).toMatchObject({
      status: 'SUBMISSION_UNKNOWN',
      cumulativeFilledQuantity: '0.5',
      terminal: false,
      lifecycleTerminal: false,
    })
  })

  it('rejects a structurally invalid admitted command before creating a projection', () => {
    expect(() => createExecutionTerminalProjection({
      command: { ...COMMAND, commandId: '0'.repeat(64) },
      acceptedSequence: '10',
    })).toThrow('execution_terminal_invalid_command')
  })

  it.each(['0', '01', '18446744073709551616'])(
    'rejects non-positive, noncanonical, or overflowing accepted sequence %s',
    acceptedSequence => {
      expect(() => createExecutionTerminalProjection({ command: COMMAND, acceptedSequence }))
        .toThrow('execution_terminal_invalid_accepted_sequence')
    },
  )
})

const COMMAND = makeCommand()

function makeCommand(): ExecutionCommandV1 {
  return buildExecutionCommandV1({
    schemaVersion: 'openalice_execution_command_payload.v1',
    accountId: 'paper-main',
    canonicalSymbol: 'BTC/USDT',
    venue: 'OKX',
    venueInstrumentId: 'BTC-USDT',
    idempotencyKey: 'terminal-reducer-intent',
    mode: 'PAPER_EXCHANGE',
    kind: 'submit',
    clientOrderId: CLIENT_ORDER_ID,
    side: 'buy',
    orderType: 'limit',
    quantity: '1.25',
    price: '100',
    timeInForce: 'GTC',
    reduceOnly: false,
    maxNotionalUsd: '125',
  })
}

function admitted(): ExecutionTerminalProjection {
  return createExecutionTerminalProjection({ command: COMMAND, acceptedSequence: '10' })
}

function event(
  sequence: string,
  kind: ExecutionEventV1['kind'],
  overrides: Partial<Omit<ExecutionEventV1, 'schemaVersion' | 'eventId' | 'sequence' | 'kind'>> = {},
): ExecutionEventV1 {
  const requiresFill = kind === 'partially_filled' || kind === 'filled'
  const requiresReason = [
    'rejected', 'expired', 'submission_unknown', 'drift', 'suspended',
  ].includes(kind)
  return buildExecutionEventV1({
    schemaVersion: 'openalice_execution_event.v1',
    commandId: COMMAND.commandId,
    sequence,
    occurredAt: '2026-08-15T00:00:00.000Z',
    kind,
    clientOrderId: CLIENT_ORDER_ID,
    ...(requiresFill ? { filledQuantity: kind === 'filled' ? '1.25' : '0.5', averagePrice: '100' } : {}),
    ...(requiresReason ? { reason: `${kind}_reason` } : {}),
    ...overrides,
  })
}

function expectConflict(projection: ExecutionTerminalProjection, code: string): void {
  expect(projection).toMatchObject({
    status: 'CONFLICTED',
    terminal: true,
    lifecycleTerminal: false,
  })
  expect(projection.conflicts.at(-1)?.code).toBe(code)
}
