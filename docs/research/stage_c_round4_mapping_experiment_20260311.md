# Stage-C Round 4 Mapping Experiment Card

Date: `2026-03-11`

## Objective

Determine whether `target_realized_vol_1h` is best used as:

- a pure no-trade filter
- a breakout enable flag
- a trend enable flag

This sprint is designed to answer a mapping question, not a family-expansion question.

## Locked Inputs

- target: `target_realized_vol_1h`
- assets: `BTC / ETH / SOL`
- evaluation path: existing `stage_c_eval_harness.py` + `stage_c_smoke_matrix.py`
- family count: `1`
- max mapping variants: `3`
- max core configurations per mapping: `3`

## Variants

### Variant 1 — `vol_as_no_trade_filter`

Interpretation:

- high predicted vol suppresses trading in the affected window
- target is used only to avoid unstable participation

Purpose:

- test whether the target is more useful for avoiding bad regimes than triggering entry

### Variant 2 — `vol_as_breakout_enable_flag`

Interpretation:

- high predicted vol allows a simple breakout path to activate
- keep logic simpler than the previous seed and avoid immediate structural widening

Purpose:

- test whether the Round 1 signal came from a real structural effect or from fragile parameter coupling

### Variant 3 — `vol_as_trend_enable_flag`

Interpretation:

- high predicted vol enables a simpler trend-following path instead of explicit breakout logic

Purpose:

- test whether the target is better at identifying continuation regimes than discrete breakout windows

## Metrics

Primary:

- `fdrQ`
- `meanPbo`
- `meanDsrProbability`

Secondary:

- per-asset stability of the same mapping
- whether any mapping produces sanity-level improvement without immediate collapse on minor refinement

## Kill Criteria

Kill the mapping-comparison sprint if all three variants satisfy both:

- `fdrQ ~ 1.0`
- no material `DSR` or `PBO` improvement vs the current best historical seed result

If that happens, the next step is not another mapping sprint.
The next step becomes:

- repair Binance alignment
- reopen architecture review with a data-path-first diagnosis

## Promotion Criteria

Promote exactly one mapping into the next sprint if it satisfies:

- at least one asset shows sanity-level `fdrQ` improvement
- the mapping remains interpretable as a regime/gating action
- it does not immediately collapse under a small refinement

## Explicit Non-Goals

This sprint does not:

- challenge `G3`
- update `decision_packet`
- reopen direct return prediction
- reopen the cross-venue path
