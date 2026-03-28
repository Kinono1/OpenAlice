# Stage-C Sprint 2 Packet

Date: `2026-03-11`

## 1. Packet Intent

This packet is the integration / governance shell for Sprint 2.

It is not a final verdict yet. Its job is to gather the Sprint 2 research outputs and rollout outputs into one place so that a single `continue / re-scope / architecture-review` decision can be made without re-reading the whole repo.

## 2. Current Fixed Context

The following facts are already locked before Sprint 2 outputs arrive:

- platform MVP is runnable
- `G0-G2` are maintenance-only, not the current bottleneck
- `G3` remains the actual blocker
- `Sprint 1` ended as `re-scope`
- current rollout mode is `crypto-only + OKX demo + BTC/USD`
- current AI backend path is `vercel-ai-sdk + openai-compatible GMN`

Reference docs:

- `docs/research/openalice_status_audit_20260311.md`
- `docs/research/stage_c_sprint1_note_20260311.md`
- `docs/research/stage_c_sprint1_failure_analysis.md`
- `docs/research/rollout_r1_start_20260311.md`

## 3. Artifact Registry

Use this table as the single source of truth for Sprint 2 evidence.

| Category | Artifact Path | Role In Decision | Status |
| --- | --- | --- | --- |
| Baseline harness | `data/research/strategy/analysis/stage_c/latest_eval_harness.v1.json` | frozen baseline comparison anchor | `present` |
| Sprint 1 matrix | `data/research/strategy/analysis/stage_c/sprint1_smoke_matrix.json` | prior failed run used for delta reference | `present` |
| Sprint 2 candidate file | `docs/research/stage_c_strategy_candidates.v2.json` | current Workstream A input | `present` |
| CORE7 predictive scan JSON | `data/research/strategy/analysis/stage_c/core7_feature_predictive_scan.v1.json` | feature-layer viability | `present` |
| CORE7 predictive scan note | `docs/research/core7_feature_predictive_scan_20260311.md` | feature-layer interpretation | `present` |
| Selective-inference comparison JSON | `data/research/strategy/analysis/stage_c/selective_inference_v1_comparison.json` | Workstream B value check | `present` |
| Selective-inference note | `docs/research/selective_inference_v1_ab_20260311.md` | method-layer interpretation | `present` |
| Sprint 2 BH matrix JSON | `data/research/strategy/analysis/stage_c/sprint2_smoke_matrix.v2.bh.json` | current candidate sanity check | `present` |
| Sprint 2 BH note | `docs/research/stage_c_sprint2_bh_note_20260311.md` | current candidate interpretation | `present` |
| Rollout snapshot / review | `docs/research/rollout_r1_review_20260311.md` | runtime stability summary | `present` |
| Controlled restart result | `docs/research/rollout_r1_restart_test_20260311.md` | persistence + restart confidence | `present` |
| Sprint 2 note | `docs/research/stage_c_sprint2_note_20260311.md` | short decision memo | `present` |

## 4. Evidence Compression Slots

When the missing artifacts are available, compress them here.

## 4.1 Feature Layer

Question:

Does `CORE7` still carry usable predictive information for Stage-C, or is feature engineering now the real blocker?

To fill:

- top features for `1h`
- top features for `4h`
- null-baseline comparison
- one-line conclusion

Current value: `filled`

Compression:

- `CORE7` still contains measurable predictive structure at both `1h` and `4h`
- however the strongest surviving features are mostly raw price, volume/volatility, and temporal structure features
- this means the feature layer is not fully dead, but the current candidate abstraction is not extracting useful statistical candidates from it
- target redesign scan now points to `realized_vol_1h` as the strongest next target family

## 4.2 Candidate Layer

Question:

Does the `v2` candidate set improve on Sprint 1 under the current BH / baseline FDR path?

To fill:

- completed assets
- `fdrQ` sanity count
- delta vs frozen baseline
- delta vs Sprint 1
- one-line conclusion

Current value: `filled`

Compression:

- Sprint 2 `v2` candidate set is worse than Sprint 1 under the BH path
- `BTC/ETH/SOL` all remain `NO_GO`
- sanity count `fdrQ < 0.5` remains `0`
- `meanPbo` is worse on all three assets relative to Sprint 1

## 4.3 Method Layer

Question:

Does selective-inference improve the same candidate set enough to justify Workstream B continuing in parallel?

To fill:

- comparison candidate set
- `BH` result
- `selective-inference` result
- one-line conclusion

Current value: `filled`

Compression:

- selective-inference was tested on the Sprint 1 `v1` candidate pool
- it improved neither `BTC`, `ETH`, nor `SOL` in a decision-relevant way
- `assetsWhereSelectiveImproved = 0`
- `assetsWhereSelectivePassed = 0`
- Workstream B should not be treated as the current rescue path

## 4.4 Runtime Layer

Question:

Is the current `R1` demo rollout stable enough to keep running while research continues?

To fill:

- connector health
- heartbeat health
- crypto account health
- controlled restart result
- one-line conclusion

Current value: `filled`

Compression:

- rollout review is healthy when collected from the runtime-owning environment
- controlled restart restored `web`, `telegram`, `heartbeat`, `crypto/account`, and OpenAI/GMN request flow
- real trade permission has been confirmed
- non-empty `pnl-fills.jsonl` now exists and restart recovery is validated

## 5. Decision Gate

The packet must end in exactly one of these states.

### `continue`

Choose only if:

- feature layer remains viable
- `v2` candidate layer shows visible improvement over Sprint 1
- method layer is at least neutral
- runtime layer has no blocker

Mandatory next action:

- proceed to integrated Sprint 3 evaluation

### `re-scope`

Choose if:

- feature layer still looks viable, but
- candidate layer is still too weak or mixed
- runtime layer remains healthy enough to continue demo observation

Mandatory next action:

- keep rollout running
- tighten candidate family design again
- do not broaden scope or talk about live

### `architecture-review`

Choose if:

- feature layer is effectively dead, or
- candidate layer remains collapsed, or
- method layer provides no value, or
- runtime layer exposes blocker-level instability

Mandatory next action:

- stop iterative candidate tweaking
- reopen assumptions at the feature / methodology / runtime architecture level

## 6. Decision Outcome

Selected state: `architecture-review`

Reason:

- feature layer still has some predictive structure
- candidate layer remains collapsed and is now worse under Sprint 2 `v2`
- method layer adds no decision-relevant rescue value
- runtime layer is healthy enough that it is no longer the primary bottleneck

Immediate consequence:

- do not continue candidate-family expansion as if Sprint 2 were a mixed or partial success
- keep rollout in demo observation mode
- reopen Stage-C research assumptions before another Workstream A iteration
- architecture review result selects `feature_horizon_redesign` as the next research direction

## 7. Packet Completion Checklist

This packet is only complete when all items below are filled:

- artifact registry statuses updated
- four evidence compression slots filled
- one decision state selected
- one next action selected
- unresolved blockers listed explicitly

## 8. Next Action

- research: begin `feature_horizon_redesign`
- first redesigned target: `realized_vol_1h`
- rollout: continue `R1` demo observation from the restored BTC/USD demo baseline
- governance: do not update `decision_packet` and do not discuss live cutover
- monetization: keep OpenAlice in `human-in-the-loop` signal workstation mode rather than autonomous live mode

## 9. Uncertainty / Risk Slot

Use this section to hold anything that still prevents a clean decision.

Examples:

- selective-inference result is statistically ambiguous
- feature scan is mixed across assets
- rollout review shows non-blocker but recurring heartbeat degradation

Current uncertainty summary:

- the feature scan says signal still exists, but much of the surviving predictive ranking is carried by raw price/time structure rather than obviously richer derived features
- restart validation now covers the real non-empty fill path
- if the next architecture review still cannot convert the surviving feature signal into candidate-level improvements, Stage-C should stop iterating candidate families and return to feature/horizon redesign
