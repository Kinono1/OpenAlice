# OpenAlice Dispatcher Hard Gates

## Summary

This document isolates the exact rejection and persistence behavior inside the crypto dispatcher, with emphasis on what happens before exchange side effects and what must be recovered later by sync or reconciliation.

## Scope

In scope:

- `createCryptoOperationDispatcher()`
- place-order path
- non-place-order path
- sync and reconciliation implications

Out of scope:

- strategy selection
- release gate generation

## Place Order Path

`executePlaceOrder()` is the critical path. It serializes trade execution and layers multiple pre-side-effect checks.

### Stage 0 — Request normalization

Creates:

- `ticketId`
- `intentId`
- `contextId`
- `CryptoPlaceOrderRequest`
- `idempotencyKey`

Persistence:

- none yet

### Stage 1 — Intent recording

Action:

- records trade intent before execution if `IntentLedger` is configured

Purpose:

- creates an audit trail even when execution later fails

### Stage 2 — Kill switch

Rejects:

- blocked symbol
- blocked open path

Persistence:

- event log append
- intent failure result

Side-effect boundary:

- still before exchange

### Stage 3 — Decision ticket validation

Rejects:

- missing or invalid ticket where required

Persistence:

- event log append
- intent failure result

### Stage 4 — Exchange idempotency policy

Rejects:

- exchanges or modes that do not allow the intended idempotency semantics

Persistence:

- event log append
- intent failure result

### Stage 5 — Custom pre-gate hook

Producer:

- `LiveGateManager.beforePlaceOrder()`

Rejects:

- release gate blocks
- paper/live mode blocks
- regime shift blocks
- execution breaker active
- manual override pause

Persistence:

- intent failure result
- optional risk rejection hook

### Stage 6 — Retry override governance

Rejects:

- forced retry without reason
- forced retry without approval ticket when ticketing is enabled
- invalid retry approval ticket

Purpose:

- prevents unsafe replay or manual override abuse

### Stage 7 — Cross-process idempotency reservation

Rejects:

- duplicate active key
- reservation failure

Purpose:

- prevents replay across processes, not just within one wallet instance

### Stage 8 — Risk check plus engine placement under lock

Serialized section:

- `preTradeRiskCheck()`
- `engine.placeOrder()`

Important invariant:

- risk evaluation and order placement happen under one place-order lock
- this prevents obvious TOCTOU races between multiple concurrent opens

Rejects:

- leverage breach
- max open positions breach
- realized PnL confidence gate
- daily loss / CVaR / consecutive loss blocks
- high-vol leverage clamp violations

### Stage 9 — After-hook telemetry

Purpose:

- non-blocking telemetry path

Important:

- never fails the order path

### Stage 10 — Slippage and final intent result

Actions:

- slippage telemetry
- intent ledger result write
- idempotency finalize

Important:

- slippage excess is logged, not automatically rejected after placement
- by this point exchange side effects already happened

## Non-PlaceOrder Path

Actions:

- `closePosition`
- `cancelOrder`
- `adjustLeverage`

Behavior:

- these bypass most of the place-order path
- kill switch still applies for some non-open actions
- close logic depends on current exchange position lookup

This means the richest safety layering exists on new opens, not uniformly on every operation type.

## Replay-Safety Invariants

- no new open without a valid intent trail
- no retry override without explicit metadata
- no duplicate idempotency key reservation
- no risk check outside the serialized place-order lock
- no journaled success before wallet/exchange path finishes

## Recovery and Reconciliation

What the dispatcher guarantees immediately:

- pre-side-effect rejections are explicit and auditable
- post-side-effect results are written to intent/idempotency state

What still needs later recovery:

- pending orders require sync
- fill-state changes require wallet sync commits
- realized/unrealized PnL consistency requires `PnLTracker`
- execution quality, ramp-up, and breaker logic require `LiveGateManager` daily flow

## Test Anchors

- `src/extension/crypto-trading/operation-dispatcher.spec.ts`
- `src/extension/crypto-trading/pnl-tracker.spec.ts`
- `src/extension/crypto-trading/providers/ccxt/CcxtTradingEngine.account.spec.ts`

## Evidence

- `fact-code`: `src/extension/crypto-trading/operation-dispatcher.ts`
- `fact-code`: `src/extension/crypto-trading/risk.ts`
- `fact-code`: `src/extension/crypto-trading/pnl-tracker.ts`
- `fact-code`: `src/extension/crypto-trading/providers/ccxt/CcxtTradingEngine.ts`
- `fact-code`: `src/runtime/live_gate_manager.ts`
- `fact-test`: `src/extension/crypto-trading/operation-dispatcher.spec.ts`
- `fact-test`: `src/extension/crypto-trading/pnl-tracker.spec.ts`
- `fact-test`: `src/runtime/live_gate_manager.spec.ts`

## Stop Reason

- stop_reason: `exit_condition_met`
