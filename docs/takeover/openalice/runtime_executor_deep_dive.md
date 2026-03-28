# OpenAlice Runtime-to-Executor Deep Dive

## Summary

This document tightens the boundary between runtime-approved artifacts and executable paper orders. It focuses on the exact state transitions from `PaperChampionRegistry` and `ReleaseGateStatus` to `Wallet.push()`.

## Scope

In scope:

- registry validation
- release and paper gate interaction
- simulation commit generation
- executor commit selection
- journal dedupe
- wallet operation materialization

Out of scope:

- exchange adapter internals after wallet push
- UI-triggered config edits

## Core State Machine

### State 1 — Champion contract available

Entry object:

- `PaperChampionRegistry`

Required fields:

- strategy family
- strategy params
- symbols
- resolved market identity
- policy versions
- checksum

Exit criteria:

- registry loaded
- checksum valid
- runtime expectations matched

Failure modes:

- missing registry file
- checksum mismatch
- resolved identity mismatch
- policy version mismatch

### State 2 — Release context available

Entry object:

- `PersistedReleaseGateStatus`

Meaning:

- `allowPaperTrading` is the upstream research/governance approval signal
- `allowLiveTrading` is stronger and not required for demo-paper flow

Failure modes:

- missing release gate status
- expired release gate status
- failed gate checks

### State 3 — Runtime admissibility computed

Entry object:

- bars by symbol
- runtime flags
- champion validation result
- release gate status

Logic:

1. evaluate data contract by symbol
2. aggregate `allDataQualityValid`
3. evaluate paper gate booleans
4. resolve runtime strategy family mapping

Hard block:

- `paperGate.finalAllowPaperTrading === false`

This is the final hard gate before runtime simulation can yield executable commits.

### State 4 — Simulation artifact materialized

Producer:

- `runRuntimeFaithfulSimulation()`

Key behaviors:

- aligns bar timeline across symbols
- computes strategy decisions with registry params
- enforces max concurrent positions
- applies correlation cap
- applies veto decider
- rejects stale or invalid intents
- emits deterministic `SimulationCommit[]`

Artifact outputs:

- simulation commits
- final positions
- per-symbol data contract results
- summary counters
- paper gate snapshot

### State 5 — Runnable commit subset selected

Producer:

- `selectRunnableSimulationCommits()`

Key behaviors:

- checks `artifact.paperGate.finalAllowPaperTrading`
- filters out already executed simulation commits via `PaperExecutorJournal`

Failure modes:

- paper gate false
- all commits already journaled

### State 6 — Wallet operations materialized

Producer:

- `buildWalletOperationsFromSimulationCommit()`

Key behaviors:

- `placeOrder` operations become USD-sized wallet opens
- decision tickets are issued during operation build
- original simulation idempotency key is preserved
- `closePosition` operations remain symbol-only closes

Important invariant:

- sizing happens at executor time using `accountEquity`, not at strategy evaluation time

### State 7 — Wallet commit executed

Producer:

- `executePaperExecutorCycle()`

Key behaviors:

1. `wallet.add()` for each operation
2. `wallet.commit()` with `paper-executor:<family>:<simulationCommitId>`
3. `wallet.push()`
4. append journal entry

Important invariant:

- journal append happens only after wallet push succeeds

## Blocking Order

If paper execution does not happen, check in this exact order:

1. registry existence and checksum
2. release gate status presence and freshness
3. paper gate booleans
4. supported runtime strategy family
5. simulation artifact has non-empty commits
6. journal is not already consuming them
7. wallet push completes without dispatcher failure

## Test Anchors

Strong runtime-contract tests:

- `src/runtime/runtime_faithful_simulation.spec.ts`
- `src/runtime/paper_gate_status.spec.ts`
- `src/runtime/paper_demo_executor.spec.ts`
- `src/runtime/paper_executor_journal.spec.ts`
- `src/runtime/paper_champion_registry.spec.ts`

These are important because they make several conclusions `fact-test`, not just `fact-code`.

## Evidence

- `fact-code`: `src/runtime/paper_champion_registry.ts`
- `fact-code`: `src/runtime/paper_gate_status.ts`
- `fact-code`: `src/runtime/runtime_faithful_simulation.ts`
- `fact-code`: `src/runtime/paper_demo_executor.ts`
- `fact-code`: `src/runtime/paper_executor_journal.ts`
- `fact-code`: `scripts/run_runtime_faithful_simulation.ts`
- `fact-code`: `scripts/run_paper_demo_executor_cycle.ts`
- `fact-test`: `src/runtime/runtime_faithful_simulation.spec.ts`
- `fact-test`: `src/runtime/paper_demo_executor.spec.ts`
- `fact-test`: `src/runtime/paper_executor_journal.spec.ts`

## Stop Reason

- stop_reason: `exit_condition_met`
