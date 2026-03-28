# Stage-C Sprint 2 BH Note

Date: `2026-03-11`

## 1. Scope

This note records the `BH / existing FDR path` result for the current Sprint 2 candidate set:

- candidates: `docs/research/stage_c_strategy_candidates.v2.json`
- compare target: `data/research/strategy/analysis/stage_c/sprint1_smoke_matrix.json`
- output: `data/research/strategy/analysis/stage_c/sprint2_smoke_matrix.v2.bh.json`

This is the `Workstream A` readout only. It does **not** include `selective-inference`.

## 2. Summary

- completed assets: `3`
- assets with `fdrQ < 0.5`: `0`
- assets with `meanPbo < 0.3`: `0`
- assets with `meanPbo` improvement vs frozen baseline: `0`
- assets with `meanDsrProbability` improvement vs frozen baseline: `0`
- assets with `fdrQ` improvement vs frozen baseline: `0`
- assets with `meanPbo` improvement vs Sprint 1 smoke: `0`
- assets with `meanDsrProbability` improvement vs Sprint 1 smoke: `1`
- assets with `fdrQ` improvement vs Sprint 1 smoke: `2`

The two `fdrQ` improvements versus Sprint 1 are numerically tiny and not decision-relevant. The candidate set still behaves as a full `NO_GO`.

## 3. Per-Asset Snapshot

| asset | result | meanPbo | meanDsrProbability | fdrQ | delta PBO vs Sprint 1 | delta DSR vs Sprint 1 | delta fdrQ vs Sprint 1 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BTC | `NO_GO` | `1.0000` | `0.0050` | `1.0000` | `+0.1286` | `-0.0197` | `~0` |
| ETH | `NO_GO` | `1.0000` | `0.0081` | `1.0000` | `+0.1143` | `-0.0063` | `~0` |
| SOL | `NO_GO` | `0.9857` | `0.0044` | `1.0000` | `+0.1571` | `+0.0028` | `~0` |

## 4. Interpretation

What changed:

- Sprint 2 `v2` candidates were more conservative and long-only.
- Despite that, `meanPbo` deteriorated sharply versus Sprint 1 on all three assets.
- `meanDsrProbability` remained extremely low across the board.
- `fdrQ` stayed pinned at `~1.0`.

What this means:

- The Sprint 2 `v2` re-scope did **not** improve candidate quality under the current `BH` path.
- The conservative redesign did not recover statistical credibility.
- The Stage-C problem is still not solved at the signal layer.

What this does **not** prove:

- It does not prove `selective-inference` is useless, because that path has not been applied here yet.
- It does not prove the rollout/runtime path is broken. This result is a research result, not an execution result.

## 5. Decision

Sprint 2 BH-only decision: `worse_than_sprint1`

Rationale:

- `meanPbo` worsened on all three assets.
- `meanDsrProbability` remained far below any sanity threshold.
- `fdrQ` remained effectively unchanged at `~1.0`.
- There is no basis to call this `partial_progress` under the BH path.

## 6. Next Action

1. Do **not** widen Workstream A candidate families again based on this result alone.
2. Continue the selective-inference A/B path in parallel so the methodology question is answered cleanly.
3. Use the upcoming CORE7 feature predictive scan to decide whether the next move is:
   - `signal family redesign`
   - or `return to CORE7 feature engineering / frequency choice`

## 7. Go / No-Go

- `better_than_sprint1`: no
- `flat_vs_sprint1`: no
- `worse_than_sprint1`: yes
