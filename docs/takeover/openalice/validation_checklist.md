# OpenAlice Takeover Validation Checklist

## Summary

This checklist is the mechanical validation surface for the OpenAlice takeover pack. It verifies document completeness, evidence model sanity, backlog integrity, and the presence of minimal automation.

## Structure

- [x] `takeover.md` exists
- [x] `system_assembly.md` exists
- [x] `runtime_sequence.md` exists
- [x] `layered_safety.md` exists
- [x] `artifact_translation.md` exists
- [x] `module_classification.md` exists
- [x] `backlog.md` exists
- [x] `watchlist.txt` exists
- [x] `calibration_note.md` exists
- [x] `runtime_executor_deep_dive.md` exists
- [x] `dispatcher_hard_gates.md` exists
- [x] `live_gate_governance.md` exists
- [x] `strategy_runtime_semantics.md` exists
- [x] `decision_packet_boundary.md` exists
- [x] `openclaw_boundary.md` exists

## Scope

In scope:

- structural completeness of the takeover pack
- evidence model sanity
- backlog integrity
- minimal automation presence

Out of scope:

- validating trading correctness
- validating runtime health in production

## Chapter Completeness

- [x] each document has a summary
- [x] each document defines scope
- [x] each document lists evidence
- [x] each document records a `stop_reason`

## Evidence Model

- [x] evidence source classes use only:
  - `fact-code`
  - `fact-config`
  - `fact-operational`
  - `fact-test`
  - `intent-doc`
- [x] `drift` is not used as an evidence source class
- [x] `drift` only appears as an evidence relationship concept

## Mainline Sanity

- [x] current runtime mainline is explicitly described
- [x] `paperGate.finalAllowPaperTrading` is treated as a hard gate
- [x] exchange side effects are routed through the wallet and dispatcher path
- [x] `openclaw` is classified as support, not mainline
- [x] archive directories are explicitly demoted
- [x] `decision_packet/` is classified as support, not ambiguous

## Backlog Integrity

- [x] every backlog item has a score
- [x] every backlog item has score breakdown
- [x] every backlog item binds to evidence
- [x] every backlog item has an exit condition

## Pilot Accounting

- [x] calibration note records `RU/TU/AU`
- [x] calibration note records per-phase `stop_reason`
- [x] calibration note records `unnecessary_overhead`
- [x] pilot stop budget was evaluated

## Mechanical Gaps

- [x] automated validator script exists
- [x] CI watchlist warning is implemented
The current automation is intentionally minimal:

- validator checks structure and watchlist basics
- CI emits refresh hints without blocking on major/minor changes

## Evidence

- `fact-code`: `scripts/takeover/validate_openalice_takeover.py`
- `fact-code`: `scripts/takeover/check_watchlist.py`
- `fact-operational`: `.github/workflows/openalice-takeover.yml`
- `fact-operational`: `docs/takeover/openalice/*`

## Stop Reason

- stop_reason: `exit_condition_met`
