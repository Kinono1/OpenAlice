# OpenAlice Pilot Calibration Note

## Summary

This note records how the takeover template behaved on OpenAlice as the first full-profile sample. The goal is calibration, not perfect bookkeeping.

## Scope

In scope:

- budget usage
- stop budget behavior
- classification and watchlist fit
- overhead observations

Out of scope:

- future template redesign beyond what this pilot directly exposed

## Pilot Outcome

- pause_rule_triggered: `false`
- profile_used: `full`
- continuity_mode: `explicit`
- takeover_mode: `single-mainline`

## Budget Usage

| Phase | RU | TU | AU | Human Estimate | Stop Reason |
| --- | ---: | ---: | ---: | --- | --- |
| Continuity and framing | 5.0 | 2 | 0 | medium | exit_condition_met |
| System assembly | 9.0 | 6 | 0 | large | exit_condition_met |
| Critical runtime chain | 7.0 | 8 | 4 | large | exit_condition_met |
| Layered safety | 5.0 | 5 | 0 | medium | exit_condition_met |
| Artifact translation | 4.0 | 0 | 5 | medium | exit_condition_met |
| Classification and backlog | 3.0 | 0 | 0 | small | exit_condition_met |

## Budget Misfit

- `System assembly` is near the top of the budget because `src/main.ts` is a large composition root. This is acceptable and is exactly why weighted `RU` is better than equal file counts.
- `Critical runtime chain` consumed most of its `TU` and `AU` budget but still stayed inside limits. The current limits are viable for a complex but coherent mainline.
- No phase overshot budget by more than `50%`, so the pilot stop budget was not close to triggering.

## Stop Reason Summary

- `exit_condition_met`: 6
- `budget_exhausted`: 0
- `diverted_to_support`: 0
- `mainline_ambiguity`: 0
- `evidence_conflict`: 0
- `architecture_model_invalidated`: 0

## Invalidated Assumptions

None during this pilot. The earlier repo framing remained stable:

- single composition root
- single active trading mainline
- embedded browser subsystem as support, not core trading runtime

## Classification Misfit

- `decision_packet/` remains the only meaningful ambiguous zone.
- It still carries operational adjacency to release and governance artifacts, but the current continuity pack clearly says not to rebuild it as the active loop.
- This ambiguity is documentation and governance shaped, not a current code-execution conflict.

## Watchlist Quality

- watchlist quality: `good`
- strengths:
  - includes composition root
  - includes runtime gates
  - includes execution entrypoints
  - includes continuity pack anchors
- likely future adjustment:
  - add explicit CI workflow paths if the repo begins using takeover warnings in automation

## Unnecessary Overhead

### profile_overhead

- item: independent `module_classification.md`
- value: `low`
- reason:
  - useful in OpenAlice, but some of its content overlaps with `takeover.md` and `backlog.md`

### structure_overhead

- item: separate mention of `continuity_mode`
- value: `very low`
- reason:
  - OpenAlice already has a strong explicit continuity pack, so this field added little decision value here

### evidence_overhead

- item: repeated evidence sections in every small document
- value: `low`
- reason:
  - helpful for mechanical completeness, but some evidence lists are repetitive across neighboring docs

### budget_overhead

- item: dual reporting of exact `RU` and human estimate bucket
- value: `low`
- reason:
  - worthwhile for this pilot, but may be unnecessary in future runs once the weighted budget model stabilizes

No section produced zero value. The current full profile is heavy, but not clearly excessive for OpenAlice.

## Recommendation

- keep weighted `RU`
- keep `drift` as evidence relationship only
- keep OpenAlice on full profile
- postpone any template reduction until a second pilot on a smaller repo shows the full profile is consistently overweight

## Evidence

- `fact-operational`: `docs/takeover/openalice/takeover.md`
- `fact-operational`: `docs/takeover/openalice/system_assembly.md`
- `fact-operational`: `docs/takeover/openalice/runtime_sequence.md`
- `fact-operational`: `docs/takeover/openalice/layered_safety.md`
- `fact-operational`: `docs/takeover/openalice/artifact_translation.md`
- `fact-operational`: `docs/takeover/openalice/module_classification.md`
- `fact-operational`: `docs/takeover/openalice/backlog.md`
- `fact-operational`: `docs/takeover/openalice/watchlist.txt`

## Stop Reason

- stop_reason: `exit_condition_met`
