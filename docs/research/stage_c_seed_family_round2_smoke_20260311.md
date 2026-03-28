# Stage-C Seed Family Round 2 Smoke

Date: `2026-03-11`

## Objective

Record whether the Round 2 deepening of the `vol_gated_breakout_seed` survives once cooldown logic is introduced.

## Inputs

- candidate file: `docs/research/stage_c_strategy_candidates.seed_family.r2.json`
- compare target: `data/research/strategy/analysis/stage_c/seed_family_smoke.v1.json`
- output: `data/research/strategy/analysis/stage_c/seed_family_round2_smoke.v1.json`

## Result

- completed assets: `3`
- assets with `fdrQ < 0.5`: `0`
- assets with `meanPbo < 0.3`: `0`

## Per-Asset Readout

| asset | result | meanPbo | meanDsrProbability | fdrQ |
| --- | --- | ---: | ---: | ---: |
| BTC | `NO_GO` | `0.7857` | `0.0000011` | `1.0000` |
| ETH | `NO_GO` | `0.6714` | `0.0000056` | `1.0000` |
| SOL | `NO_GO` | `0.8714` | `0.0000100` | `1.0000` |

## Interpretation

Round 2 improved `meanPbo` relative to Round 1 on all three assets, but it destroyed the only thing that had become promising:

- `fdrQ` fell back to the collapse regime
- `meanDsrProbability` collapsed toward zero

This means the first deeper iteration did not stabilize the seed. It destabilized it.

## Decision

- `continue_seed`: no
- `tighten_seed`: no
- `kill_seed`: yes

Reason:

- the Round 1 sanity improvement could not survive a modest structural refinement
- there is no basis to promote this seed as the current single-venue mainline
