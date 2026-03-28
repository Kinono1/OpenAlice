# OpenAlice Strategy Runtime Semantics

## Summary

This document reconciles the currently documented strategy family intent with the subset that is actually executable in the current runtime chain.

## Scope

In scope:

- strategy families defined in TypeScript
- runtime-supported family mapping
- regime-only versus directional semantics

Out of scope:

- archived experiment families
- historical rejected candidate loops

## Strategy Families In Code

Defined families:

- `trend`
- `meanReversion`
- `breakout`
- `ensemble`
- `volBreakout`
- `volTrend`
- `volNoTradeFilter`

## Runtime Support In Current Paper-First Chain

Current direct runtime family mapping:

- `vol_gated_breakout` -> `volBreakout`
- `vol_gated_trend` -> `volTrend`

Current non-directional regime/control family:

- `volNoTradeFilter`

Current unsupported runtime family case:

- any registry family not in the explicit runtime map blocks simulation execution

## Important Semantic Boundary

The active continuity pack and runtime implementation together imply:

- `target_realized_vol_1h` is not treated as a direct directional target
- volatility is used as a gating or regime-control layer
- the executable paper path expects a directional family after that gating decision

This is a `mixed` conclusion:

- `fact-code`
  - runtime family mapping only allows directional gated families
- `intent-doc`
  - continuity pack says volatility target is gating-only
- relationship
  - `supports`

## Why This Is P1

This area matters because:

- current runtime supports fewer families than the broader strategy namespace
- operator assumptions are split across code and docs
- unsupported family names fail closed in runtime simulation

## Evidence

- `fact-code`: `src/extension/strategy-tools/strategies.ts`
- `fact-code`: `src/extension/strategy-tools/backtest.ts`
- `fact-code`: `src/runtime/runtime_faithful_simulation.ts`
- `fact-operational`: `chatgpt/Memory.md`
- `intent-doc`: `chatgpt/alpha_contract_v1.md`
- `intent-doc`: `chatgpt/task_plan.md`

## Stop Reason

- stop_reason: `exit_condition_met`
