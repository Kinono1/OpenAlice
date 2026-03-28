# Stage-C Sprint 1 Failure Analysis

Date: `2026-03-11`

## Objective

This note explains why Sprint 1 was marked `re-scope` instead of `continue`, and records the evidence used to redefine candidate generation for Sprint 2.

Primary evidence:

- `data/research/strategy/analysis/stage_c/sprint1_smoke_matrix.json`
- `docs/research/stage_c_strategy_candidates.v1.json`
- `docs/research/stage_c_sprint1_note_20260311.md`

## Hard Outcome

Sprint 1 did not pass even the interim sanity floor.

- completed assets: `3`
- assets with `fdrQ < 0.5`: `0`
- assets with `meanPbo < 0.3`: `0`

Per-asset summary:

- `BTC`: `meanPbo = 0.8714`, `meanDsrProbability = 0.0247`, `fdrQ = 1.0000`
- `ETH`: `meanPbo = 0.8857`, `meanDsrProbability = 0.0145`, `fdrQ = 1.0000`
- `SOL`: `meanPbo = 0.8286`, `meanDsrProbability = 0.0016`, `fdrQ = 1.0000`

## What Failed

### 1. FDR never moved off the ceiling

The strongest signal in the Sprint 1 output is not subtle:

- `fdrQ` stayed pinned at `~1.0` on all three assets
- no asset crossed `fdrQ < 0.5`
- every asset still ended as `NO_GO`

Interpretation:

- the candidate pool is still failing at the signal layer
- this is not a “more compute” problem
- this is not yet a selective-inference problem

Until at least one asset produces a materially better candidate distribution, methodology upgrades alone are unlikely to rescue the run.

### 2. DSR collapsed everywhere

`meanDsrProbability` deteriorated on all three assets versus the frozen baseline:

- `BTC`: `-0.1506`
- `ETH`: `-0.1608`
- `SOL`: `-0.1737`

Interpretation:

- the first Stage-C families may have increased regime diversity, but they did not produce confidence-worthy candidates
- the v1 generator was too permissive relative to the quality of the underlying signal
- shorter windows plus `allowShort=true` likely amplified noise instead of producing robust candidates

### 3. PBO improved only partially and was not enough

Sprint 1 did show one useful signal:

- `BTC` meanPbo improved by `-0.0143`
- `SOL` meanPbo improved by `-0.0571`

Interpretation:

- there is some evidence that the CORE7-driven direction can reduce overfit pressure on selected assets
- but this improvement did not translate into DSR or FDR improvement
- therefore Sprint 2 should preserve only the parts that moved PBO in the right direction and remove the rest

## Family-Level Diagnosis

## Family 1: cross-exchange basis / spread breakout

Evidence from Sprint 1:

- this family aligns best with the small PBO improvement seen on `BTC` and `SOL`
- however overall `fdrQ` stayed at `~1.0`
- `meanDsrProbability` still collapsed

Likely failure mode:

- 1m spread / basis cues are too noisy when directly converted into symmetric breakout variants
- `allowShort=true` likely adds churn faster than it adds useful opportunity
- the v1 windows were still too short to separate real compression/expansion from microstructure noise

Decision for Sprint 2:

- keep the family
- make it `long-only`
- use slower confirmation windows
- treat it as the only Sprint 1 direction worth preserving immediately

## Family 2: multi-timeframe volume / volatility trend

Evidence from Sprint 1:

- no visible FDR breakthrough
- no DSR recovery
- no clear evidence that the regime filters improved timing enough to matter

Likely failure mode:

- the regime descriptors are lagging the price move they are supposed to filter
- using them as broad trend-family multipliers still leaves the system entering too many weak states

Decision for Sprint 2:

- keep the family only in a reduced, more conservative form
- bias it toward slower confirmation and `long-only`
- do not expand this family until it can produce at least one asset with `fdrQ < 0.5`

## Family 3: adaptive ensemble

Evidence from Sprint 1:

- adaptive ensemble variants added complexity without improving `fdrQ`
- DSR still worsened on all assets

Likely failure mode:

- the adaptive weighting logic is mixing weak sub-signals rather than rescuing them
- thresholds in the `0.25-0.31` range were too permissive
- the ensemble accepted low-quality states instead of filtering them out

Decision for Sprint 2:

- replace the v1 adaptive family with a conservative trend-dominant ensemble
- raise voting thresholds
- remove short-side expansion
- use the ensemble as a stricter filter, not as a signal amplifier

## Re-Scope Rules For Sprint 2

Sprint 2 candidate re-scope should follow these rules:

1. Preserve only the parts of Sprint 1 that improved `meanPbo`.
2. Explicitly target `meanDsrProbability` recovery before chasing final-threshold `fdrQ`.
3. Remove short-side flexibility from the initial v2 pool.
4. Raise ensemble thresholds and reduce adaptive degrees of freedom.
5. Do not widen the candidate pool again until at least one asset crosses `fdrQ < 0.5`.

## Output Of This Failure Analysis

This analysis directly produced:

- `docs/research/stage_c_strategy_candidates.v2.json`

The `v2` candidate file applies the following shifts:

- `compressed_basis_breakout_long_only`
- `volume_confirmed_trend_long_only`
- `conservative_trend_dominant_ensemble`

The purpose of `v2` is not to pass `G3` immediately. The purpose is to answer a narrower question:

Can a lower-noise, long-only, more conservative Stage-C pool produce at least one asset with a visible sanity improvement over Sprint 1?
