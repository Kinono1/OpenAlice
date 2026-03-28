# OpenAlice Takeover Pilot

## Metadata

- repo: `OpenAlice`
- generated_at: `2026-03-17`
- takeover_mode: `single-mainline`
- continuity_mode: `explicit`
- profile: `full`
- confidence_initial: `medium`
- review_after: `2026-03-31`
- takeover_root: `docs/takeover/openalice/`

## Summary

This pilot documents the current OpenAlice mainline without changing business code. The active path is a file-driven trading agent runtime centered on:

- `src/main.ts` as the composition root
- paper-first runtime controls under `src/runtime/`
- audited crypto execution under `src/extension/crypto-trading/`
- strategy expression under `src/extension/strategy-tools/`

The current scope remains:

- `OKX + BTC/ETH/SOL + 1h + long-only + demoTrading=true`

## Continuity Pack

Read in this order:

1. `chatgpt/Memory.md`
2. `chatgpt/task_plan.md`
3. `chatgpt/findings.md`
4. `chatgpt/progress.md`

Secondary context anchors:

- `README.md`
- `chatgpt/runtime_contract_v1.md`
- `chatgpt/paper_acceptance_v1.md`
- `chatgpt/alpha_contract_v1.md`

Conflict priority:

1. repo-local `chatgpt/` continuity pack
2. current code and tests
3. active top-level docs
4. archived docs last

## Pilot Scope

Included:

- system assembly and lifecycle
- provider and session layer
- paper-first runtime sequence
- crypto execution safety map
- strategy and artifact translation
- interface and notification flow

Explicitly excluded:

- automatic live trading enablement
- symbol or venue expansion
- archive research reactivation
- `decision_packet` regeneration

## Mainline Statement

The current mainline is the paper-first trading loop:

`research/runtime contracts -> paper gate -> runtime-faithful simulation -> paper executor -> wallet -> dispatcher -> exchange`

This is stronger than the UI layer, browser subsystem, or archived research because it is the only active path that simultaneously carries:

- runtime control
- trade intent
- wallet state
- exchange-side effects

## Deliverables In This Pilot

- `system_assembly.md`
- `runtime_sequence.md`
- `layered_safety.md`
- `artifact_translation.md`
- `module_classification.md`
- `backlog.md`
- `validation_checklist.md`
- `watchlist.txt`
- `calibration_note.md`
- `runtime_executor_deep_dive.md`
- `dispatcher_hard_gates.md`
- `live_gate_governance.md`
- `strategy_runtime_semantics.md`
- `decision_packet_boundary.md`
- `openclaw_boundary.md`
- `scripts/takeover/validate_openalice_takeover.py`
- `scripts/takeover/check_watchlist.py`

## Pilot Stop Budget

The pilot must pause early if the template clearly does not fit reality.

Pause immediately if, across the first three phases:

- two or more phases trigger `architecture_model_invalidated`
- two or more phases exceed budget by more than `50%`
- one phase both exceeds budget by more than `50%` and invalidates the architecture model

Status for this pilot:

- pause_not_triggered: `true`

## Evidence Sources

Primary source files:

- `src/main.ts`
- `src/core/config.ts`
- `src/core/session.ts`
- `src/core/ai-provider.ts`
- `src/runtime/paper_champion_registry.ts`
- `src/runtime/paper_gate_status.ts`
- `src/runtime/runtime_faithful_simulation.ts`
- `src/runtime/paper_demo_executor.ts`
- `src/extension/crypto-trading/operation-dispatcher.ts`
- `src/extension/crypto-trading/providers/ccxt/CcxtTradingEngine.ts`
- `src/extension/strategy-tools/strategies.ts`
- `src/connectors/web/web-plugin.ts`
- `scripts/run_runtime_faithful_simulation.ts`
- `scripts/run_paper_demo_executor_cycle.ts`

## Stop Reason

- stop_reason: `exit_condition_met`
