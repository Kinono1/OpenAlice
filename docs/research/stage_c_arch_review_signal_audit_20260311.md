# Stage-C Architecture Review — Signal Audit

Date: `2026-03-11`

## Decision Question

What surviving signal still exists in the current `CORE7` feature base, and why has the current candidate layer failed to turn it into a gate-worthy result?

## Inputs

- `docs/research/core7_feature_predictive_scan_20260311.md`
- `data/research/strategy/analysis/stage_c/core7_feature_predictive_scan.v1.json`
- `docs/research/stage_c_sprint2_bh_note_20260311.md`

## Observed Signal

The feature scan shows that signal still exists at both `1h` and `4h`.

The strongest recurring features are:

- raw or paired close series
- realized-volatility style features
- temporal structure features such as `hour_of_day` and `day_of_week`

What is missing from the top ranks is equally important:

- richer derived CORE7 features are not dominating the predictive ranking
- cross-exchange structure is not clearly emerging as the leading explanatory block

## Interpretation

This is not a “no signal remains” situation.

It is a “surviving signal is mostly structural, not yet candidate-ready” situation.

That means:

- the feature layer still contains information
- but the information looks closer to regime / time / volatility structure than to direct tradeable alpha in the current candidate form

## Why Current Candidates Failed

The current candidate layer appears to fail for two linked reasons:

- it assumes the surviving signal can be translated directly into classical trend / breakout / ensemble candidates
- it assumes the current target horizon is aligned with the surviving structure

The observed Sprint 2 result does not support either assumption.

## Hard Conclusion

Surviving signal exists, but it is dominated by price / volatility / temporal structure and is not being converted into usable candidates by the current abstraction.

This audit therefore rejects the idea that the next step should be “just add more candidate families”.

## Recommendation

Carry this result forward as:

- `signal survives`
- `candidate abstraction does not`
- `next decision must focus on horizon / target / aggregation design before more family expansion`
