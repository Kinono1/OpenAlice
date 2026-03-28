# OpenAlice Artifact Translation

## Summary

OpenAlice’s mainline depends on file artifacts that bridge research, runtime checks, simulation, and paper execution. The important question is not merely which files exist, but which ones are actually consumed by active code paths.

## Scope

In scope:

- current strategy candidate artifacts
- paper champion registry
- release gate status
- runtime-faithful simulation artifact
- paper gate status
- paper executor journal
- wallet state

Out of scope:

- archived research packets
- docs that are not read by code

## Translation Table

| Producer | Artifact | Consumer | Runtime Role |
| --- | --- | --- | --- |
| `stage_c_round4_candidate_generator.py` | `docs/research/stage_c_round4_candidates.*.json` | research workflow and decision docs | candidate generation artifact |
| research / operator flow | `data/runtime/paper_champion_registry.json` | `loadPaperChampionRegistry()` | champion contract for runtime |
| release gate builder / operator flow | `data/runtime/release_gate_status.json` | `loadReleaseGateStatus()` | paper/live approval boundary |
| market data replay / OpenBB pull | in-memory `barsBySymbol` | `runRuntimeFaithfulSimulation()` | data input for runtime validation |
| simulation CLI | `data/runtime/runtime_faithful_simulation.latest.json` | paper executor cycle | executable paper artifact |
| simulation CLI | `data/runtime/paper_gate_status.json` | operator and executor checks | persisted paper gate snapshot |
| paper executor cycle | `data/runtime/paper_executor_journal.json` | `loadPaperExecutorJournal()` | dedupe / already-executed memory |
| wallet commit hook | `data/crypto-trading/commit.json` | wallet restore | auditable execution state |
| fill tracker | `data/crypto-trading/pnl-fills.jsonl` | `PnLTracker.restoreFromDisk()` | realized/unrealized PnL continuity |

## Research to Runtime Notes

What is code-consumed today:

- `paper_champion_registry`
- `release_gate_status`
- CSV or live bars supplied to runtime simulation
- simulation artifact
- paper executor journal

What is still mostly documentation or operator context:

- root `chatgpt/*.md` contracts
- many `docs/research/*.md` analysis memos
- round4 decision narratives

This means the research layer is partly code-driven and partly human-governed. The code path activates only after the necessary runtime artifacts exist in the expected shapes.

## Strategy Family Translation

Current runtime mapping from registry family to executable strategy:

- `vol_gated_breakout` -> `volBreakout`
- `vol_gated_trend` -> `volTrend`
- unsupported family -> runtime block

Important restriction:

- `target_realized_vol_1h` is treated as a gating/regime signal, not a direct directional label

## Evidence Model

`long-only` is a `mixed` conclusion:

- `fact-code`
  - `src/runtime/execution_semantics.ts` rejects non-reduce-only sells as new opens
- `intent-doc`
  - repo continuity pack states long-only current scope
- `evidence_relationship`
  - `supports`

## Evidence

- `fact-code`: `scripts/stage_c_round4_mapping_runner.py`
- `fact-code`: `scripts/run_runtime_faithful_simulation.ts`
- `fact-code`: `scripts/run_paper_demo_executor_cycle.ts`
- `fact-code`: `src/runtime/paper_champion_registry.ts`
- `fact-code`: `src/runtime/runtime_faithful_simulation.ts`
- `fact-code`: `src/runtime/paper_demo_executor.ts`
- `fact-code`: `src/runtime/paper_executor_journal.ts`
- `fact-code`: `src/extension/strategy-tools/strategies.ts`
- `fact-operational`: `chatgpt/Memory.md`
- `intent-doc`: `chatgpt/alpha_contract_v1.md`
- `intent-doc`: `chatgpt/runtime_contract_v1.md`

## Stop Reason

- stop_reason: `exit_condition_met`
