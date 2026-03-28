# Stage-C Architecture Review — Horizon Review

Date: `2026-03-11`

## Decision Question

What is the single best next move for the current `1m feature -> 1h/4h forward return` mapping?

## Evaluated Options

### Option 1

Keep `1m -> 1h/4h` unchanged and only redesign candidates.

Reason to reject:

- Sprint 2 already showed that making candidates more conservative did not help
- surviving top features still look more like structural state variables than direct fixed-horizon alpha

### Option 2

Keep the feature base, but redesign target horizon / aggregation.

Reason to keep:

- the feature scan still shows predictive structure
- current candidate collapse suggests the main mismatch may be target definition rather than total feature absence
- this is the smallest architecture change that still addresses the strongest current failure mode

### Option 3

Move immediately to `5m/15m` feature frequency before doing anything else.

Reason to reject for now:

- it is a larger pipeline move than current evidence requires
- current evidence is sufficient to justify target/horizon redesign first without immediately forcing a full feature-pipeline rewrite

## Single Recommendation

Selected recommendation: `feature_horizon_redesign`

Target scan follow-up result:

- `docs/research/stage_c_feature_horizon_redesign_20260311.md`
- recommended target: `realized_vol_1h`
- target kind: `magnitude`

## What This Means

The next research sprint should not directly generate more classical candidates from the current mapping.

Instead it should:

- keep the current feature base as the starting point
- redesign the forecast target toward `realized_vol_1h` first
- test whether shorter aggregated horizons or regime-oriented targets preserve the surviving signal better

## Immediate Consequence

Do not start a new candidate-family expansion until the next research input definition is rebuilt around the `realized_vol_1h` target family and validated.
