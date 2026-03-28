# OpenAlice Scripts Triage 2026-03-11

## Summary

This is the `Phase 3` scripts triage for the current dirty worktree.

At triage time, untracked scripts count:

- `scripts/` total: `110`
- `scripts/tests/` subset: `41`

The problem is not that all untracked scripts are bad. The problem is that active Stage-C tooling, active data pipeline tooling, legacy G3/G4 research tooling, and one-off diagnostics are all mixed in the same top-level folder with no explicit status boundary.

The right next step is not immediate deletion. The right next step is classification.

## Buckets

### 1. Active Mainline Stage-C Scripts

These are directly tied to the current Stage-C evidence chain and should remain in the active scripts surface.

Keep as active:

- `scripts/stage_c_candidate_generator_seed_family.py`
- `scripts/stage_c_candidate_generator_seed_family_r2.py`
- `scripts/stage_c_candidate_generator_v2.py`
- `scripts/stage_c_eval_harness.py`
- `scripts/stage_c_selective_compare.py`
- `scripts/stage_c_smoke_matrix.py`

Rationale:

- these are directly referenced by current Stage-C documents
- they produced current evidence artifacts
- they are part of the present research path, even when the current result is negative

### 2. Active Core7 / Data Pipeline Scripts

These support the current data path and should not be archived until a later pipeline consolidation pass.

Keep as active:

- `scripts/build_core7_feature_base.py`
- `scripts/core7_feature_predictive_scan.py`
- `scripts/core7_materialize_redesigned_targets.py`
- `scripts/core7_pipeline_utils.py`
- `scripts/core7_target_horizon_scan.py`
- `scripts/diagnose_binance_core7_alignment.py`
- `scripts/inspect_core7_feature_coverage.py`
- `scripts/normalize_binance_core7_1m.py`
- `scripts/normalize_okx_core7_1m.py`
- `scripts/run_core7_feature_pipeline.sh`
- `scripts/train_core7_baseline.py`
- `scripts/train_core7_baseline_matrix.py`

Keep as active but operational:

- `scripts/check_okx_core7_status.sh`
- `scripts/check_okx_core7_trades_batches_status.sh`
- `scripts/check_okx_core7_trades_status.sh`
- `scripts/run_okx_core7_resume_tmux.sh`
- `scripts/run_okx_core7_trades_batches_tmux.sh`
- `scripts/run_okx_core7_trades_tmux.sh`

Rationale:

- these scripts remain part of the current Core7 and venue-data workflow
- Binance alignment is still unresolved, so the data path is still live work

### 3. Active Runtime / Validation Utilities

Keep as active:

- `scripts/inspect_pnl_tracker_restore.ts`
- `scripts/rollout_r1_collect.py`
- `scripts/verify_okx_candles_completion.py`

Rationale:

- these scripts support current runtime truth, fill restore truth, and venue-data verification

### 4. Active OKX Ingestion / Historical Build Scripts

Keep as active but isolate conceptually as data-ingestion infrastructure:

- `scripts/build_okx_completion_truth.py`
- `scripts/build_okx_resume_state.py`
- `scripts/generate_okx_core_symbol_set.py`
- `scripts/monitor_okx_swarm.py`
- `scripts/okx_build_catalog.ts`
- `scripts/okx_data_coverage_report.ts`
- `scripts/okx_download_candles_historical.ts`
- `scripts/okx_download_full_dataset.ts`
- `scripts/okx_download_index_candles.ts`
- `scripts/okx_download_trades.ts`
- `scripts/okx_historical_common.ts`
- `scripts/okx_import_historical_trades.ts`
- `scripts/okx_materialize_training_csv.ts`
- `scripts/partition_okx_symbols_weighted.py`
- `scripts/restart_okx_failed_agents.py`
- `scripts/run_okx_candles_swarm.sh`
- `scripts/run_okx_historical_pipeline.sh`
- `scripts/supervise_okx_swarm.py`

Rationale:

- these are not junk
- but they are operational/data-infra scripts, not Stage-C reasoning scripts
- they should be grouped or moved later, not deleted now

### 5. Legacy Research / Historical Strategy Scripts

These are the best archive candidates inside `scripts/`, but they should be moved as a coherent batch, not deleted file by file.

Archive candidates:

- `scripts/run_g3g4_multi_asset_matrix.py`
- `scripts/strategy_g3g4_failure_breakdown.py`
- `scripts/strategy_g3g4_iteration.py`
- `scripts/strategy_local_param_search.py`
- `scripts/strategy_phaseb_family_search.py`
- `scripts/strategy_protocol_ablation.py`

Rationale:

- these names tie directly to older G3/G4 and Phase-B iterations
- current research truth now lives under Stage-C and the round-based seed-family analysis
- keeping these at top level makes it too easy to re-enter superseded loops

Recommended action:

- move them later into `scripts/archive/legacy-research/`
- move paired tests with them at the same time

### 6. Builder / Packet Generation Scripts

These are not necessarily legacy, but they are not part of the immediate Stage-C or runtime mainline.

Review later as one pack:

- `scripts/build_advisor_committee_packet.py`
- `scripts/build_citation_network.py`
- `scripts/build_precontinue_decision.py`
- `scripts/build_problem_driven_paper_board.py`
- `scripts/build_quant_hiring_scorecard.py`
- `scripts/build_quant_policy_pack.py`
- `scripts/build_stagea_gate_result.py`
- `scripts/build_stageb_governance_packet.py`
- `scripts/research_fdr_shortlist.py`
- `scripts/research_hypothesis_compile.py`
- `scripts/research_hypothesis_to_candidates.py`
- `scripts/research_methodology_execute.py`
- `scripts/research_pdf_extract.py`
- `scripts/research_plan_switch.py`

Rationale:

- they build packet/report artifacts rather than powering the active runtime or active seed-family path
- some may still be worth keeping, but they should not be mixed into the current core execution story

Recommended action:

- keep for now
- batch-review together after docs archive and before any broad script moves

### 7. Diagnostics and One-Off Analysis Helpers

Keep for now, but mark as low-frequency support tools:

- `scripts/diagnose_fdr_bottleneck.py`
- `scripts/evaluate_threshold_sensitivity.py`
- `scripts/check_and_dedup_risk_symbols.py`
- `scripts/selective_inference.py`

Rationale:

- these are useful sidecar diagnostics
- but they are not core path scripts anymore
- especially `selective_inference.py` should remain parked, not promoted back to primary use

### 8. Tests

Current untracked script tests: `41`

Keep the tests that correspond to active scripts:

- `scripts/tests/test_core7_feature_predictive_scan.py`
- `scripts/tests/test_core7_materialize_redesigned_targets.py`
- `scripts/tests/test_core7_target_horizon_scan.py`
- `scripts/tests/test_diagnose_binance_core7_alignment.py`
- `scripts/tests/test_stage_c_candidate_generator_seed_family.py`
- `scripts/tests/test_stage_c_candidate_generator_seed_family_r2.py`
- `scripts/tests/test_stage_c_candidate_generator_v2.py`
- `scripts/tests/test_stage_c_eval_harness.py`
- `scripts/tests/test_run_core7_feature_pipeline.py`
- `scripts/tests/test_normalize_binance_core7_1m.py`
- `scripts/tests/test_normalize_okx_core7_1m.py`
- `scripts/tests/test_train_core7_baseline.py`
- `scripts/tests/test_train_core7_baseline_matrix.py`
- `scripts/tests/test_verify_okx_candles_completion.py`

Archive together with legacy scripts later:

- `scripts/tests/test_run_g3g4_multi_asset_matrix.py`
- `scripts/tests/test_strategy_g3g4_failure_breakdown.py`
- `scripts/tests/test_strategy_g3g4_iteration.py`
- `scripts/tests/test_strategy_local_param_search.py`
- `scripts/tests/test_strategy_phaseb_family_search.py`
- `scripts/tests/test_strategy_protocol_ablation.py`

Review later with packet builders:

- `scripts/tests/test_build_advisor_committee_packet.py`
- `scripts/tests/test_build_citation_network.py`
- `scripts/tests/test_build_precontinue_decision.py`
- `scripts/tests/test_build_problem_driven_paper_board.py`
- `scripts/tests/test_build_quant_hiring_scorecard.py`
- `scripts/tests/test_build_quant_policy_pack.py`
- `scripts/tests/test_build_stagea_gate_result.py`
- `scripts/tests/test_build_stageb_governance_packet.py`
- `scripts/tests/test_research_fdr_shortlist.py`
- `scripts/tests/test_research_hypothesis_compile.py`
- `scripts/tests/test_research_hypothesis_to_candidates.py`
- `scripts/tests/test_research_methodology_execute.py`
- `scripts/tests/test_research_pdf_extract.py`
- `scripts/tests/test_research_plan_switch.py`
- `scripts/tests/test_schema_contracts.py`
- `scripts/tests/test_selective_inference.py`
- `scripts/tests/test_strategy_research_watch_multisource.py`

## Recommended Cleanup Order

### Phase 3A: No-move classification only

Completed by this document.

### Phase 3B: Move legacy research scripts

Recommended next move:

- move `strategy_g3g4_*`, `strategy_phaseb_*`, `strategy_local_param_search.py`, `strategy_protocol_ablation.py`, and `run_g3g4_multi_asset_matrix.py`
- move their paired tests with them

Target bucket:

- `scripts/archive/legacy-research/`
- `scripts/tests/archive/legacy-research/`

### Phase 3C: Group active scripts by role

Recommended after Phase 3B:

- create role-level folders or at least documented clusters for:
  - `stage_c/`
  - `core7/`
  - `okx_ingestion/`
  - `rollout/`

This does not need to happen immediately if it creates too much churn, but it is the right long-term cleanup.

### Phase 3D: Review packet-build scripts as a bundle

Do not split these ad hoc.

Review as a single class:

- `build_*`
- `research_*`
- their tests

## Do Not Move Yet

Avoid moving or cleaning these in the current pass:

- all `stage_c_*` scripts
- all active `core7_*` scripts
- all `okx_*` data-ingestion scripts
- `scripts/inspect_pnl_tracker_restore.ts`
- `scripts/rollout_r1_collect.py`

Rationale:

- these files still define current truth or current reproducibility

## Final Recommendation

The repo is still noisy, but after `tmp/` cleanup and research-doc archive, the next cleanup target should be:

1. legacy research scripts and their paired tests
2. only then the packet-builder cluster

Do not clean active Stage-C or active data-ingestion scripts in the next pass.
