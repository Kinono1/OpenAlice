# OpenAlice Takeover Backlog

## Summary

This backlog prioritizes the next deep-read or implementation-adjacent follow-up work using risk scoring rather than file-count ordering.

## Scope

In scope:

- remaining deep-read priorities after the initial pilot
- follow-up classification and ambiguity cleanup
- next implementation-adjacent understanding work

Out of scope:

- archive-wide cleanup
- broad feature roadmap planning

Scoring dimensions:

- side_effect
- test_gap
- ambiguity
- fanout
- operational_criticality

Priority mapping:

- `P0`: 8-10
- `P1`: 6-7
- `P2`: 4-5
- `P3`: 2-3

## Backlog

## Completed Follow-Up Deep Reads

- completed_by:
  - `runtime_executor_deep_dive.md`
- original_priority: `P0`
- result:
  - state machine from registry and release gate to wallet push documented

- completed_by:
  - `dispatcher_hard_gates.md`
- original_priority: `P0`
- result:
  - pre-side-effect rejection layers and replay-safe invariants documented

- completed_by:
  - `live_gate_governance.md`
- original_priority: `P1`
- result:
  - pre-open, in-flight, and end-of-day governance roles separated

- completed_by:
  - `strategy_runtime_semantics.md`
- original_priority: `P1`
- result:
  - runtime-supported families and gating-only semantics reconciled

- completed_by:
  - `decision_packet_boundary.md`
- original_priority: `P2`
- result:
  - `decision_packet/` is now classified as support rather than ambiguous

- completed_by:
  - `openclaw_boundary.md`
- original_priority: `P3`
- result:
  - current OpenClaw import boundary and support-only role are now explicit

## Remaining Backlog

### P0 — Runtime contracts to executor boundary

- score: `9`
- breakdown:
  - side_effect `2`
  - test_gap `1`
  - ambiguity `2`
  - fanout `2`
  - operational_criticality `2`
- why:
  - this is the narrowest bridge between approved artifacts and executable paper orders
- evidence:
  - `src/runtime/runtime_faithful_simulation.ts`
  - `src/runtime/paper_demo_executor.ts`
  - `scripts/run_paper_demo_executor_cycle.ts`
- next action:
  - deep-read exact assumptions around supported strategy families, artifact shapes, and block reasons
- exit condition:
  - one page can explain every block and state transition between simulation artifact and wallet push
- status: `completed`

### P0 — Dispatcher hard gates and replay-safe execution

- score: `9`
- breakdown:
  - side_effect `3`
  - test_gap `1`
  - ambiguity `1`
  - fanout `2`
  - operational_criticality `2`
- why:
  - this is the only live side-effect path to exchange execution
- evidence:
  - `src/extension/crypto-trading/operation-dispatcher.ts`
  - `src/extension/crypto-trading/risk.ts`
  - `src/extension/crypto-trading/providers/ccxt/CcxtTradingEngine.ts`
- next action:
  - map which rejections happen before exchange side effects and which require later reconciliation
- exit condition:
  - every dispatcher stage is mapped to its owner, failure mode, and persistence artifact
- status: `completed`

### P1 — LiveGateManager governance surface

- score: `7`
- breakdown:
  - side_effect `2`
  - test_gap `1`
  - ambiguity `1`
  - fanout `2`
  - operational_criticality `1`
- why:
  - cross-cuts release gate, volatility, regime shift, ramp-up, and daily summaries
- evidence:
  - `src/runtime/live_gate_manager.ts`
  - `src/runtime/daily_gate_summary.ts`
  - `src/runtime/risk_breaker_state.ts`
- next action:
  - separate pre-trade, post-trade, and end-of-day governance responsibilities
- exit condition:
  - governance roles can be split into pre-open, in-flight, and daily-finalization categories
- status: `completed`

### P1 — Strategy family to runtime semantics

- score: `6`
- breakdown:
  - side_effect `1`
  - test_gap `1`
  - ambiguity `2`
  - fanout `1`
  - operational_criticality `1`
- why:
  - current runtime only supports a subset of strategy families, and operator assumptions live partly in docs
- evidence:
  - `src/extension/strategy-tools/strategies.ts`
  - `src/extension/strategy-tools/backtest.ts`
  - `chatgpt/alpha_contract_v1.md`
- next action:
  - reconcile documented family set with runtime-supported family set
- exit condition:
  - supported, unsupported, and regime-only families are explicitly listed
- status: `completed`

### P2 — Decision packet ambiguity cleanup

- score: `5`
- breakdown:
  - side_effect `0`
  - test_gap `1`
  - ambiguity `2`
  - fanout `1`
  - operational_criticality `1`
- why:
  - still present in repo and adjacent to release/governance artifacts, but no longer the current build target
- evidence:
  - `decision_packet/`
  - `chatgpt/task_plan.md`
  - `README.md`
- next action:
  - document exactly which files are reference-only versus still operationally consumed
- exit condition:
  - `decision_packet/` can be classified as support or legacy-live without ambiguity
- status: `completed`

### P3 — OpenClaw boundary note

- score: `3`
- breakdown:
  - side_effect `1`
  - test_gap `0`
  - ambiguity `1`
  - fanout `1`
  - operational_criticality `0`
- why:
  - large subtree with limited current mainline impact
- evidence:
  - `src/extension/browser/adapter.ts`
  - `src/openclaw/`
- next action:
  - produce a short boundary note describing what OpenAlice actually imports from OpenClaw
- exit condition:
  - future readers stop assuming OpenClaw is the trading runtime core
- status: `completed`

## Drift-Carrying Items

None discovered during this pilot that require immediate `mixed-drift` escalation.

## Evidence

- `fact-code`: `src/runtime/runtime_faithful_simulation.ts`
- `fact-code`: `src/runtime/paper_demo_executor.ts`
- `fact-code`: `src/runtime/live_gate_manager.ts`
- `fact-code`: `src/extension/strategy-tools/strategies.ts`
- `fact-operational`: `docs/takeover/openalice/runtime_executor_deep_dive.md`
- `fact-operational`: `docs/takeover/openalice/dispatcher_hard_gates.md`
- `fact-operational`: `docs/takeover/openalice/live_gate_governance.md`
- `fact-operational`: `docs/takeover/openalice/strategy_runtime_semantics.md`
- `fact-operational`: `docs/takeover/openalice/decision_packet_boundary.md`
- `fact-operational`: `docs/takeover/openalice/openclaw_boundary.md`

## Stop Reason

- stop_reason: `exit_condition_met`
