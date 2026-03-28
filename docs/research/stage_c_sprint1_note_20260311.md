# Stage-C Sprint 1 Note

Date: `2026-03-11`

## 1. Sprint Scope

Sprint 1 focused on two immediate deliverables:

1. establish the Stage-C evaluation wrapper around the existing strategy MVP validation path
2. generate the first CORE7-driven candidate set and run a BTC/ETH/SOL smoke matrix

This sprint did **not** aim to pass `G3`. The goal was to create a minimally runnable Stage-C loop and inspect the first direction of movement against the frozen baseline.

## 2. What Was Delivered

- `docs/research/stage_c_evaluation_contract.md`
- `scripts/stage_c_eval_harness.py`
- `scripts/stage_c_candidate_generator_v2.py`
- `scripts/stage_c_smoke_matrix.py`
- `docs/research/stage_c_strategy_candidates.v1.json`
- `data/research/strategy/analysis/stage_c/latest_eval_harness.v1.json`
- `data/research/strategy/analysis/stage_c/sprint1_smoke_matrix.json`

## 3. Smoke Matrix Summary

Source: `data/research/strategy/analysis/stage_c/sprint1_smoke_matrix.json`

- Completed assets: `3`
- Assets with `fdrQ < 0.5`: `0`
- Assets with `meanPbo < 0.3`: `0`

Per-asset result snapshot:

| asset | result | meanPbo | meanDsrProbability | fdrQ | delta meanPbo vs frozen | delta meanDsrProbability vs frozen | delta fdrQ vs frozen |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BTC | `NO_GO` | `0.8714` | `0.0247` | `1.0000` | `-0.0143` | `-0.1506` | `+0.00000029` |
| ETH | `NO_GO` | `0.8857` | `0.0145` | `1.0000` | `+0.0000` | `-0.1608` | `+0.00000029` |
| SOL | `NO_GO` | `0.8286` | `0.0016` | `1.0000` | `-0.0571` | `-0.1737` | `+0.00000029` |

## 4. Interpretation

What improved:

- `meanPbo` improved on `BTC` and `SOL`
- `SOL` showed the strongest PBO improvement among the three assets

What did not improve:

- `meanDsrProbability` deteriorated on all three assets
- `fdrQ` remained effectively pinned at `~1.0`
- no asset crossed the interim sanity floor `fdrQ < 0.5`

What this means:

- the first Stage-C candidate families are not yet producing statistically credible candidates
- CORE7-derived signals may be contributing some reduction in overfit pressure on select assets, but the candidate quality is still far from release-gate relevance
- the current candidate generator v2 should not be treated as a successful Stage-C breakthrough

## 5. Decision

Sprint 1 decision: `re-scope`

Rationale:

- there is enough signal to continue exploring Stage-C, because PBO moved in the right direction on two assets
- there is not enough evidence to justify a straight `continue` with the current candidate families unchanged
- a full `halt` is not warranted yet, because the evaluation wrapper and candidate generation loop are now runnable and comparable to the frozen baseline

## 6. Next Actions

1. Keep the Stage-C evaluation wrapper as the canonical comparison path for iterative work.
2. Re-scope candidate generation v2 before expanding compute budget:
   - tighten feature-family hypotheses
   - reduce weak adaptive variants
   - explicitly target DSR improvement instead of only spread/basis-style signal diversity
3. Prioritize Workstream A iteration first, then add Workstream B selective-inference comparison once the candidate pool stops collapsing at the signal layer.
4. Keep `Rollout Lane` independent from this result. Demo execution readiness can proceed, but this sprint does not change the `NO_GO` research conclusion.

## 7. Go / No-Go

- `continue`: no
- `re-scope`: yes
- `halt`: no
