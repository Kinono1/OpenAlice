# Stage-C Sprint 2 Note

Date: `2026-03-11`

## 1. Purpose

This note is the decision-facing summary for Sprint 2.

It is intentionally structured so the remaining Sprint 2 artifacts can be dropped in without changing the document shape. It does **not** invent metrics. Any section marked `TBD` must be filled from the corresponding artifact path once that artifact exists.

## 2. Locked Baseline

Sprint 2 starts from the following already-existing baseline:

- `docs/research/stage_c_sprint1_note_20260311.md`
- `docs/research/stage_c_sprint1_failure_analysis.md`
- `docs/research/stage_c_strategy_candidates.v2.json`
- `data/research/strategy/analysis/stage_c/latest_eval_harness.v1.json`
- `data/research/strategy/analysis/stage_c/sprint1_smoke_matrix.json`
- `docs/research/rollout_r1_start_20260311.md`

Baseline interpretation already fixed by Sprint 1:

- `Sprint 1 decision = re-scope`
- `fdrQ` remained pinned near `1.0`
- `meanDsrProbability` deteriorated on all three assets
- `meanPbo` improved on `BTC` and `SOL`, but not enough to justify a straight continue

## 3. Sprint 2 Required Inputs

The following Sprint 2 artifacts are expected to populate this note:

| Artifact | Purpose | Status |
| --- | --- | --- |
| `data/research/strategy/analysis/stage_c/core7_feature_predictive_scan.v1.json` | Establish whether CORE7 features still carry predictive information at `1h` / `4h` horizon | `present` |
| `docs/research/core7_feature_predictive_scan_20260311.md` | Human-readable feature-scan interpretation | `present` |
| `data/research/strategy/analysis/stage_c/selective_inference_v1_comparison.json` | Method-level A/B on Sprint 1 `v1` candidate set | `present` |
| `docs/research/selective_inference_v1_ab_20260311.md` | Selective-inference interpretation | `present` |
| `data/research/strategy/analysis/stage_c/sprint2_smoke_matrix.v2.bh.json` | `v2` candidate result under current BH / baseline FDR path | `present` |
| `docs/research/stage_c_sprint2_bh_note_20260311.md` | BH-only Sprint 2 interpretation | `present` |
| `docs/research/rollout_r1_review_20260311.md` | Demo rollout review | `present` |
| `docs/research/rollout_r1_restart_test_20260311.md` | Controlled restart result | `present` |

## 4. Decision Questions

Sprint 2 must answer these four questions explicitly:

1. Does the `CORE7` feature base still contain enough predictive structure to justify another Stage-C iteration?
2. Are `v2` candidates materially better than Sprint 1 on at least one sanity dimension?
3. Does selective-inference improve the same candidate set enough to keep Workstream B active?
4. Is `R1` demo rollout stable enough to continue observing without first returning to platform repair?

## 5. Evidence Slots

## 5.1 CORE7 Predictive Scan

Source:

- `data/research/strategy/analysis/stage_c/core7_feature_predictive_scan.v1.json`
- `docs/research/core7_feature_predictive_scan_20260311.md`

Fill this section with:

- top predictive features at `1h`
- top predictive features at `4h`
- whether predictive strength is above shuffle / null baseline
- one sentence conclusion:
  - `signal still exists`
  - or `signal too weak, return to feature engineering`

Current status: `filled`

Observed result:

- aggregate conclusion at `1h`: `signal still exists`
- aggregate conclusion at `4h`: `signal still exists`
- top predictive features are still present, but they are dominated by price/volatility/time-structure features such as `okx_pair_close`, `okx_swap_close`, `okx_close`, `okx_rv_60m`, `hour_of_day`, and `day_of_week`

Decision impact:

- this is not evidence that CORE7 is dead
- it is also not evidence that the current candidate families are well specified
- Sprint 2 should therefore not return to feature engineering first; the more immediate blocker remains candidate/method collapse

## 5.2 Sprint 2 BH Smoke Matrix

Source:

- `data/research/strategy/analysis/stage_c/sprint2_smoke_matrix.v2.bh.json`
- `docs/research/stage_c_sprint2_bh_note_20260311.md`

Fill this section with:

- completed assets
- assets with `fdrQ < 0.5`
- delta vs frozen baseline
- delta vs Sprint 1 `v1`
- one sentence classification:
  - `better_than_sprint1`
  - `flat_vs_sprint1`
  - `worse_than_sprint1`

Current status: `filled`

Observed result:

- completed assets: `3`
- assets with `fdrQ < 0.5`: `0`
- all three assets remained `NO_GO`
- relative to Sprint 1, `meanPbo` worsened on all three assets
- relative to Sprint 1, `meanDsrProbability` improved on only one asset and only marginally
- relative to Sprint 1, `fdrQ` did not move in a decision-relevant way

Classification:

- `worse_than_sprint1`

## 5.3 Selective-Inference A/B

Source:

- `data/research/strategy/analysis/stage_c/selective_inference_v1_comparison.json`
- `docs/research/selective_inference_v1_ab_20260311.md`

Fill this section with:

- which candidate set was compared
- `BH` vs `selective-inference` metric difference
- whether the method is meaningfully helpful even on a weak candidate set
- one sentence conclusion:
  - `keep_workstream_b`
  - `deprioritize_workstream_b`

Current status: `filled`

Observed result:

- completed assets: `3`
- assets where selective improved over BH: `0`
- assets where selective produced a pass: `0`
- prototype conclusion: `keep_workstream_b = no`

Decision impact:

- Workstream B did not demonstrate standalone value on the current weak candidate pool
- it should not be treated as a rescue path for Sprint 2

## 5.4 Rollout Lane R1

Source:

- `docs/research/rollout_r1_review_20260311.md`
- `docs/research/rollout_r1_restart_test_20260311.md`

Fill this section with:

- whether `web + telegram + heartbeat + crypto demo` remained healthy
- whether controlled restart preserved `pnl-fills.jsonl` recovery
- whether any blocker runtime issue was discovered
- one sentence conclusion:
  - `continue_rollout_observation`
  - `return_to_platform_repair`

Current status: `filled`

Observed result:

- runtime-owning probes show the current rollout path is reachable and healthy
- the formal blocker in the stale worker-shell review is no longer treated as current truth
- controlled restart preserved:
  - `web`
  - `telegram`
  - `heartbeat.enabled=true`
  - `crypto/account`
  - OpenAI/GMN request path
- runtime-side fill recovery is no longer pending:
  - real WIF fills exist
  - non-empty fill restart validation completed successfully

## 6. Decision Section

Exactly one of the following must be selected:

### Option A — `continue`

Use this only if all of the following are true:

- feature scan says signal still exists
- Sprint 2 `v2` BH matrix is visibly better than Sprint 1 on at least one sanity dimension
- selective-inference is neutral-to-helpful, not actively misleading
- rollout review has no blocker

Decision body:

`not selected`

### Option B — `re-scope`

Use this if:

- feature scan says there is still signal, but
- `v2` candidates still fail sanity, or
- rollout is stable but research output is still weak

Decision body:

`not selected`

### Option C — `architecture-review`

Use this if any of the following is true:

- feature scan says predictive structure is effectively absent
- `v2` BH matrix is flat or worse again
- selective-inference gives no help and candidate quality remains collapsed
- rollout review exposes blocker-level runtime instability

Decision body:

Selected.

Rationale:

- the feature layer still shows some predictive structure, so Sprint 2 is not blocked by total feature collapse
- the `v2` candidate layer is worse than Sprint 1 under the BH path
- selective-inference adds no decision-relevant improvement on the same candidate pool
- rollout is healthy enough to continue observing, which isolates the remaining failure to the research side rather than the runtime side

Therefore the correct Sprint 2 outcome is not “continue iterating candidates as-is” and not “return to runtime repair first”. It is an architecture-level review of the Stage-C research path before another candidate-family expansion.

The architecture review is now completed and selects:

- `feature_horizon_redesign`

## 7. Recommended Next Action Slot

Once the decision is chosen, fill exactly one next-action block:

- `continue`:
  - move to Sprint 3 integrated evaluation
- `re-scope`:
  - preserve only the best-performing family and regenerate candidate set
- `architecture-review`:
  - stop candidate-family tuning and reopen CORE7 / methodology assumptions

Current recommendation: `architecture-review`

Recommended next action:

- keep `R1` rollout running in demo observation mode
- freeze Workstream A expansion beyond the current `v2` set
- deprioritize Workstream B as a rescue path
- begin the next research sprint as `feature_horizon_redesign`, not as `candidate_redesign`
- set the first redesigned target to `realized_vol_1h`
- only after target/horizon redesign is complete may a new single-seed candidate family be authorized
