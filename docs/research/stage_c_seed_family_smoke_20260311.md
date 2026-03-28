# Stage-C Seed Family Smoke

Date: `2026-03-11`

## Objective

Record the first smoke result for the `vol_gated_breakout_seed` family built from the `realized_vol_1h` gating target.

## Inputs

- candidate file: `docs/research/stage_c_strategy_candidates.seed_family.v1.json`
- compare target: `data/research/strategy/analysis/stage_c/sprint2_smoke_matrix.v2.bh.json`
- output: `data/research/strategy/analysis/stage_c/seed_family_smoke.v1.json`

## Result

This section must be read against the JSON output.

- completed assets: `3`
- assets with `fdrQ < 0.5`: `3`
- assets with `meanPbo < 0.3`: `0`
- delta vs previous smoke:
  - `fdrQ` improved materially on all three assets
  - `meanDsrProbability` improved on all three assets
  - `meanPbo` did not improve

## Per-Asset Readout

| asset | result | meanPbo | meanDsrProbability | fdrQ |
| --- | --- | ---: | ---: | ---: |
| BTC | `NO_GO` | `1.0000` | `0.0642` | `0.0556` |
| ETH | `NO_GO` | `1.0000` | `0.0642` | `0.0556` |
| SOL | `NO_GO` | `1.0000` | `0.0642` | `0.0556` |

## Interpretation

The seed family did not pass the full research gate, but it did clear the intended sanity check:

- the old seed-free return-based candidate path stayed pinned near `fdrQ ~ 1.0`
- this new vol-gated breakout seed pushed `fdrQ` below `0.5` on all three assets

That means the gating-target redesign is not obviously dead on arrival.

What still failed:

- `meanPbo` remained catastrophic
- `meanDsrProbability` remained far below the hard threshold
- no candidate became release-eligible

## Decision

Exactly one of:

- `keep_seed`
- `kill_seed`
- `redefine_target_mapping`

Current decision: `keep_seed`

Reason:

- this is the first post-review family to show a real sanity-level improvement
- the improvement is not enough to talk about promotion
- but it is enough to justify one deeper iteration on the same seed before abandoning the redesigned target
