# OpenAlice Decision Packet Boundary

## Summary

`decision_packet/` is no longer the current build target for the active OpenAlice mainline, but it is also not pure archive. It remains a support-area governance packet that is still referenced by scripts, package commands, and adjacent evaluation flows.

## Scope

In scope:

- current contents of `decision_packet/`
- which scripts still write or validate it
- why it is support rather than archive

Out of scope:

- redesigning the decision packet format
- reviving it as the active runtime promotion path

## Current Files

Observed files:

- `decision_packet/evidence_pack.json`
- `decision_packet/experiment_verdict.v2.json`
- `decision_packet/release_gate_status.json`
- `decision_packet/verdict.json`
- `decision_packet/manifest.json`
- `decision_packet/replay_report.json`
- `decision_packet/gates/*.checkpoint.json`

## Current Operational Role

What is still true today:

- `package.json` still exposes:
  - `decision:build`
  - `decision:validate`
- multiple research and governance scripts still take `decision_packet/experiment_verdict.v2.json` as a baseline or output-adjacent reference
- `validate_decision_packet.py` still validates this folder shape

What is no longer true today:

- the active continuity pack explicitly says not to rebuild `decision_packet`
- the active task plan says the current objective is scheduled paper executor work, not packet rebuilding
- the executable runtime path no longer starts from `decision_packet/`; it starts from runtime artifacts such as:
  - `paper_champion_registry`
  - `release_gate_status`
  - runtime-faithful simulation artifacts

## Classification Decision

Final classification:

- `decision_packet/` = `support`

Reasoning:

- not `mainline`
  - current runtime execution does not depend on rebuilding this directory
- not `archive`
  - scripts, package commands, and governance validators still reference it
- therefore it remains a legacy-live governance packet in support status

## Practical Rule

Use `decision_packet/` as:

- a governance reference area
- a validation/reporting output zone
- a compatibility surface for older or adjacent workflows

Do not use it as:

- the primary source of truth for current paper-first runtime execution
- the current milestone target for implementation work

## Evidence

- `fact-code`: `package.json`
- `fact-code`: `scripts/build_decision_packet.py`
- `fact-code`: `scripts/validate_decision_packet.py`
- `fact-code`: `scripts/stage_c_round4_mapping_runner.py`
- `fact-code`: `scripts/stage_c_eval_harness.py`
- `fact-code`: `scripts/stage_c_smoke_matrix.py`
- `fact-operational`: `decision_packet/`
- `intent-doc`: `chatgpt/Memory.md`
- `intent-doc`: `chatgpt/task_plan.md`
- `evidence_relationship`: `supports`

## Stop Reason

- stop_reason: `exit_condition_met`
