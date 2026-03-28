# Reproducibility Fingerprint V1

Last updated: `2026-03-13`

## Purpose

Define the minimum fingerprint that must accompany every paper champion so research, simulation, and runtime all know they are using the same artifact.

## Required Fields

- `strategy_family`
- `strategy_params`
- `symbols`
- `bar_interval`
- `ccxtSymbol_by_symbol`
- `instId_by_symbol`
- `domainBaseUrl`
- `cost_model_version`
- `veto_policy_version`
- `runtime_schema_version`
- `research_dataset_hash`
- `bar_data_snapshot_id`
- `feature_pipeline_version`
- `signal_code_commit_hash`
- `candidate_list_hash`
- `search_policy_hash`
- `trial_count`
- `accepted_oos_window`
- `accepted_metrics`
- `generated_at`

## Validation Rules

- any missing field => `championLoaded=false`
- any runtime mismatch on symbol resolution, policy version, or commit hash => `policyVersionMatch=false`
- registry activation requires checksum verification before scheduling
