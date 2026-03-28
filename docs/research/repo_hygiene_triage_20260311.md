# OpenAlice Repo Hygiene Triage 2026-03-11

## Summary

This is a first-pass repository hygiene triage, not a destructive cleanup.

Current worktree state at triage time:

- `git status --short`: `252` entries
- tracked modifications: `42`
- untracked files: `210`

Top-level concentration:

- `scripts/`: `113`
- `docs/`: `91`
- `src/`: `34`
- `decision_packet/`: `11`
- `tmp/`: `1`

The repo is now dirty enough that it will slow down further work and make it easy to confuse:

- current runtime truth
- current research truth
- superseded Stage-A/B/C planning artifacts
- one-off temporary outputs

The right next step is not blanket deletion. The right next step is:

1. remove low-risk temporary files
2. archive clearly superseded research artifacts
3. keep current runtime/research sources intact
4. postpone any `decision_packet/` cleanup until after the worktree is structurally cleaner

## Buckets

### 1. Safe Delete Now

These files look like one-off backups or temporary sweep outputs that are not part of the active runtime or active research source of truth.

Immediate delete candidates:

- `tmp/crypto.json.pre_wif_test`
- `tmp/engine.json.pre_wif_test`
- `tmp/risk.json.pre_wif_test`
- `tmp/wfo_sweep_20260303/`

Rationale:

- the `.pre_wif_test` files are one-off safety backups from the WIF real-trade test
- the `wfo_sweep_20260303` tree is a temporary parameter sweep output under `tmp/`, not a durable repo artifact
- none of these paths are part of the current runtime baseline

### 2. Archive Candidate

These files should not be deleted blindly, but they should stop living next to current truth as first-class active artifacts.

#### 2.1 Superseded G3/G4 governance packets

Archive candidates:

- `docs/research/g3g4_candidate_decision_20260303.md`
- `docs/research/g3g4_codex_topvenue_plan_20260303.md`
- `docs/research/g3g4_execution_runbook_20260303.md`
- `docs/research/g3g4_governance_review_20260303.md`
- `docs/research/g3g4_precontinue_decision_latest.md`
- `docs/research/g3g4_provisional_baseline_20260303.md`
- `docs/research/g3g4_stageA_gate_result_latest.md`
- `docs/research/g3g4_stageB_governance_packet_latest.md`
- `docs/research/g3g4_stageC_rebuild_backlog_20260303.md`
- `docs/research/g3g4_stageC_rebuild_charter_20260303.md`
- `docs/research/g3g4_subagent_validation_20260303.md`
- `docs/research/g3_g4_recovery_iteration_playbook_20260302.md`
- `docs/research/g3_g4_top_venue_research_brief_20260302.md`
- `docs/research/g3_g4_top_venue_research_brief_20260303_update.md`

Rationale:

- these were useful to get into Stage-C
- they are no longer the active truth source after:
  - `stage_c_architecture_review_20260311.md`
  - `stage_c_round3_path_decision_20260311.md`
  - `runtime_truth_reconciliation_20260311.md`

Recommended action:

- move to a dedicated `docs/research/archive/g3g4-202603/` bucket
- keep them searchable, but clearly mark them superseded

#### 2.2 Latest/provisional/ghost packet artifacts

Archive candidates:

- `docs/research/advisor_committee_packet_latest.md`
- `docs/research/paper_board_latest.md`
- `docs/research/quant_hiring_scorecard_latest.md`
- `docs/research/quant_policy_pack_latest.md`
- `docs/research/ghost_completion_status_20260303.md`
- `docs/research/ghost_task_backlog_20260303.md`
- `docs/research/strategy_candidates.phaseb_r1.json`

Rationale:

- `latest` filenames are especially risky because they imply current truth but are likely tied to older packets
- `ghost_*` files look like ad hoc workflow residue, not durable current-state artifacts
- `phaseb` explicitly belongs to a prior research phase

Recommended action:

- archive under `docs/research/archive/legacy-packets/`
- stop treating these as active repo entry points

#### 2.3 Templates and schema packs that belong together but are currently untracked

Review-before-archive candidates:

- `docs/research/templates/advisor_committee_packet.schema.v1.json`
- `docs/research/templates/citation_network.schema.v1.json`
- `docs/research/templates/fdr_bottleneck_report.schema.v1.json`
- `docs/research/templates/fdr_frontier_shortlist.schema.v1.json`
- `docs/research/templates/hypothesis_backlog.schema.v1.json`
- `docs/research/templates/local_param_search_report.schema.v1.json`
- `docs/research/templates/multi_asset_matrix.schema.v1.json`
- `docs/research/templates/paper_board.schema.v1.json`
- `docs/research/templates/pdf_extract_report.schema.v1.json`
- `docs/research/templates/plan_switchboard.schema.v1.json`
- `docs/research/templates/precontinue_decision.schema.v1.json`
- `docs/research/templates/provisional_baseline.schema.v1.json`
- `docs/research/templates/quant_hiring_scorecard.schema.v1.json`
- `docs/research/templates/quant_policy_pack.schema.v1.json`
- `docs/research/templates/research_digest.schema.v2.json`
- `docs/research/templates/stagea_gate_result.schema.v1.json`
- `docs/research/templates/stageb_governance_packet.schema.v1.json`
- `docs/research/templates/threshold_sensitivity.schema.v1.json`

Rationale:

- these are not obviously trash
- but they are not part of the active Stage-C round that is currently being used
- they should either be committed as a coherent schema pack or moved out of the primary active path

Recommended action:

- keep for now
- batch-review later as one coherent schema inventory

### 3. Must Keep

These files are current truth or current implementation and should not be cleaned casually.

#### 3.1 Current runtime truth and rollout truth

Keep:

- `docs/research/runtime_truth_reconciliation_20260311.md`
- `docs/research/rollout_r1_review_20260311.md`
- `docs/research/rollout_r1_restart_test_20260311.md`
- `docs/research/rollout_r1_observation_window_20260311.md`
- `docs/research/non_empty_fill_restart_validation_20260311.md`
- `docs/research/non_empty_fill_restore_inspection_20260311.md`
- `docs/research/real_trade_wif_test_20260311.md`

#### 3.2 Current Stage-C research truth

Keep:

- `docs/research/stage_c_arch_review_signal_audit_20260311.md`
- `docs/research/stage_c_arch_review_horizon_20260311.md`
- `docs/research/stage_c_arch_review_candidate_design_20260311.md`
- `docs/research/stage_c_arch_review_methodology_20260311.md`
- `docs/research/stage_c_architecture_review_20260311.md`
- `docs/research/stage_c_feature_horizon_redesign_20260311.md`
- `docs/research/stage_c_target_to_trade_mapping_20260311.md`
- `docs/research/stage_c_feature_horizon_input_pack_20260311.md`
- `docs/research/stage_c_round3_path_decision_20260311.md`
- `docs/research/stage_c_seed_family_design_20260311.md`
- `docs/research/stage_c_seed_family_smoke_20260311.md`
- `docs/research/stage_c_seed_family_round2_design_20260311.md`
- `docs/research/stage_c_seed_family_round2_smoke_20260311.md`
- `docs/research/stage_c_sprint2_note_20260311.md`
- `docs/research/stage_c_sprint2_packet_20260311.md`

#### 3.3 Current research machine-readable artifacts

Keep:

- `docs/research/stage_c_strategy_candidates.seed_family.v1.json`
- `docs/research/stage_c_strategy_candidates.seed_family.r2.json`
- `docs/research/stage_c_strategy_candidates.v1.json`
- `docs/research/stage_c_strategy_candidates.v2.json`
- `data/research/strategy/analysis/stage_c/`

Rationale:

- these are the real evidence chain for current Stage-C conclusions
- deleting or archiving them prematurely would break provenance

#### 3.4 Active implementation and tests

Keep all current tracked changes under:

- `src/`
- `decision_packet/`
- `package.json`
- `README.md`

Rationale:

- `src/` holds the current runtime and strategy implementation truth
- `decision_packet/` is dirty but still active and should be cleaned only after the repo is structurally quieter

### 4. Keep But Reclassify Later

These scripts likely matter, but they should be explicitly sorted into current-mainline versus historical-tooling before any cleanup.

#### 4.1 Current mainline scripts

Likely keep:

- `scripts/stage_c_candidate_generator_seed_family.py`
- `scripts/stage_c_candidate_generator_seed_family_r2.py`
- `scripts/stage_c_candidate_generator_v2.py`
- `scripts/stage_c_eval_harness.py`
- `scripts/stage_c_selective_compare.py`
- `scripts/stage_c_smoke_matrix.py`
- `scripts/core7_feature_predictive_scan.py`
- `scripts/core7_target_horizon_scan.py`
- `scripts/core7_materialize_redesigned_targets.py`
- `scripts/diagnose_binance_core7_alignment.py`
- `scripts/inspect_pnl_tracker_restore.ts`
- `scripts/rollout_r1_collect.py`

#### 4.2 Historical or phase-specific scripts

Likely archive candidates after review:

- `scripts/strategy_phaseb_family_search.py`
- `scripts/run_g3g4_multi_asset_matrix.py`
- `scripts/strategy_g3g4_failure_breakdown.py`
- `scripts/strategy_g3g4_iteration.py`
- `scripts/research_fdr_shortlist.py`
- `scripts/research_hypothesis_compile.py`
- `scripts/research_hypothesis_to_candidates.py`
- `scripts/research_methodology_execute.py`
- `scripts/research_plan_switch.py`

Rationale:

- these appear tied to prior G3/G4 and Phase-B/Stage-C transition work
- they may still be valuable, but not as front-and-center active tooling

#### 4.3 Infrastructure / ingestion scripts

Likely keep, but move into a cleaner grouped story later:

- `scripts/normalize_okx_core7_1m.py`
- `scripts/normalize_binance_core7_1m.py`
- `scripts/build_core7_feature_base.py`
- `scripts/train_core7_baseline.py`
- `scripts/train_core7_baseline_matrix.py`
- `scripts/run_core7_feature_pipeline.sh`
- `scripts/okx_*`
- `scripts/check_okx_*`
- `scripts/run_okx_*`

Rationale:

- these support the data path and should not be deleted until the data pipeline is simplified

## Recommended Cleanup Order

### Phase 1: Safe cleanup now

Do now:

- delete `tmp/crypto.json.pre_wif_test`
- delete `tmp/engine.json.pre_wif_test`
- delete `tmp/risk.json.pre_wif_test`
- delete `tmp/wfo_sweep_20260303/`

### Phase 2: Archive docs without changing technical truth

Do next:

- create a research archive folder
- move superseded `g3g4_*`, `g3_g4_*`, `ghost_*`, `*_latest.md`, and `phaseb` packet files there

### Phase 3: Script inventory

Do after docs archive:

- split `scripts/` into:
  - active Stage-C scripts
  - active data/ingestion scripts
  - historical research scripts
  - one-off utility scripts

### Phase 4: `decision_packet/` review

Do last:

- only once the noise floor is down
- otherwise it is too easy to mix current experiment state with stale research artifacts

## Do Not Clean Yet

Avoid touching these in the first hygiene pass:

- `src/`
- `decision_packet/`
- `data/research/strategy/analysis/stage_c/`
- `data/crypto-trading/pnl-fills.jsonl`

Rationale:

- these currently hold active implementation truth or active evidence truth

## Final Recommendation

Yes, the repo should be cleaned now.

But the right first move is:

1. delete `tmp/`
2. archive superseded research docs
3. leave `src/`, `decision_packet/`, and current Stage-C evidence untouched

This triage should be treated as the source list for the first hygiene pass.
