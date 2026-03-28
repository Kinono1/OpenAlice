# OpenAlice Layered Safety Map

## Summary

OpenAlice does not submit orders directly from strategy output. It routes execution through multiple protection layers. The highest-value invariant is that side effects must cross auditable, stateful gates before reaching the exchange.

## Scope

In scope:

- runtime hard gates
- wallet staging
- dispatcher pipeline
- risk policy
- exchange adapter behavior
- reconciliation and daily governance

Out of scope:

- strategy alpha quality
- UI permissions

## Safety Layers

### Layer 1 — Runtime gating

Owner:

- `paper_gate_status`
- `release_gate_status`
- `execution_semantics`

Purpose:

- block execution before it even becomes runnable

Hard gates:

- `paperGate.finalAllowPaperTrading`
- long-only execution semantics
- stale intent rejection

### Layer 2 — Wallet staging

Owner:

- `Wallet`

Purpose:

- make operations inspectable before side effects
- persist deterministic commit history and parent chain

Hard gates:

- no `push()` before `commit()`
- no `commit()` with empty staging area

### Layer 3 — Dispatcher execution pipeline

Owner:

- `createCryptoOperationDispatcher()`

Stages:

1. kill switch
2. decision ticket validation
3. exchange idempotency policy check
4. intent recording before execution
5. pre-place-order gate hook
6. retry override governance
7. cross-process idempotency reservation
8. risk check plus placeOrder under lock
9. after-hook telemetry
10. slippage check and intent result recording

Hard gates:

- kill switch
- ticket rejection
- idempotency rejection
- risk rejection
- pre-gate rejection

### Layer 4 — Risk policy

Owner:

- `preTradeRiskCheck()`
- guard pipeline

Checks:

- max open positions
- max leverage
- max order USD
- max position percent of equity
- realized PnL confidence gate
- daily loss soft caps
- CVaR soft caps
- consecutive loss controls
- high-volatility leverage clamping
- capital ramp scaling

Hard gates:

- all rejected trades return failed outcomes before exchange side effects

### Layer 5 — Exchange adapter

Owner:

- `CcxtTradingEngine`

Purpose:

- exchange normalization
- idempotency field mapping
- OKX-specific `posSide`
- demo/sandbox host handling

Hard gates:

- exchange auth/init failure prevents engine availability
- malformed order sizing rejects before placement

### Layer 6 — Reconciliation and daily governance

Owner:

- `PnLTracker`
- `LiveGateManager`
- execution quality store
- ramp-up store
- risk breaker store

Purpose:

- detect post-trade drift
- update execution breakers
- summarize daily governance state

Outputs:

- reconciliation alerts
- daily gate summary
- regime shift signal
- execution breaker activation

## High-Risk Action Map

| Action | Last Hard Gate Before Side Effect | Post-Effect Verification |
| --- | --- | --- |
| new open | runtime gate + dispatcher risk check | slippage telemetry + PnL tracker + daily governance |
| close position | dispatcher and exchange response | wallet commit history + optional sync |
| retry | retry governance + idempotency reservation | intent ledger + idempotency state |
| delayed fill sync | wallet sync path | PnL tracker reconciliation |

## Evidence

- `fact-code`: `src/runtime/paper_gate_status.ts`
- `fact-code`: `src/runtime/execution_semantics.ts`
- `fact-code`: `src/extension/crypto-trading/wallet/Wallet.ts`
- `fact-code`: `src/extension/crypto-trading/operation-dispatcher.ts`
- `fact-code`: `src/extension/crypto-trading/risk.ts`
- `fact-code`: `src/extension/crypto-trading/guards/guard-pipeline.ts`
- `fact-code`: `src/extension/crypto-trading/providers/ccxt/CcxtTradingEngine.ts`
- `fact-code`: `src/extension/crypto-trading/pnl-tracker.ts`
- `fact-code`: `src/runtime/live_gate_manager.ts`
- `fact-test`: `src/extension/crypto-trading/operation-dispatcher.spec.ts`
- `fact-test`: `src/extension/crypto-trading/pnl-tracker.spec.ts`
- `fact-test`: `src/runtime/live_gate_manager.spec.ts`

## Stop Reason

- stop_reason: `exit_condition_met`
