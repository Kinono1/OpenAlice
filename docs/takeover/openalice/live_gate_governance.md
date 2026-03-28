# OpenAlice Live Gate Governance

## Summary

`LiveGateManager` is the governance cross-cutting layer that sits between raw execution capability and safe runtime operation. It is not the composition root, but it is the most important post-bootstrap runtime governor.

## Scope

In scope:

- pre-open blocking
- risk context construction
- expected price estimation
- post-trade execution quality recording
- daily finalization duties

Out of scope:

- strategy alpha generation
- wallet serialization mechanics

## Governance Roles

### Pre-open governance

- manual override pause
- release gate read and cache
- paper/live mode gate selection
- regime-shift blocking
- execution breaker blocking

### In-flight governance

- risk context assembly
- volatility quantile estimation
- capital ramp stage adjustment
- expected price estimation for slippage checks
- execution quality recording

### End-of-day governance

- execution summary finalization
- execution gate evaluation
- risk breaker updates
- ramp-up evaluation
- daily PnL persistence
- idempotency governance summary
- daily gate summary writing

## Why This Matters

This module is where several otherwise separate concerns converge:

- release governance
- market regime state
- execution quality
- capital ramp stage
- breaker state
- daily reporting

That makes it a `P1` deep-read item even though it is not itself the primary exchange adapter.

## Evidence

- `fact-code`: `src/runtime/live_gate_manager.ts`
- `fact-code`: `src/runtime/daily_gate_summary.ts`
- `fact-code`: `src/runtime/risk_breaker_state.ts`
- `fact-code`: `src/runtime/regime_shift.ts`
- `fact-test`: `src/runtime/live_gate_manager.spec.ts`

## Stop Reason

- stop_reason: `exit_condition_met`
