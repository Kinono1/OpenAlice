# Paper Champion Registry Spec V1

Last updated: `2026-03-13`

## Purpose

Define the minimum reproducible artifact the runtime must load before auto paper execution is allowed.

## Required Fields

- `strategy_family`
- `strategy_params`
- `symbols`
- `bar_interval`
- `resolved_market_identity`
- `paper_gate_snapshot`
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

## Resolved Market Identity

For each active symbol store:

- `internalSymbol`
- `ccxtSymbol`
- `instId`
- `instType`
- `settleCcy`
- `defaultMarketType`
- `domainBaseUrl`
- `demoMode`

## Load Rules

- If any required field is missing, `championLoaded=false`.
- If resolved market identity disagrees with runtime resolution, `championLoaded=false`.
- If `signal_code_commit_hash` or `veto_policy_version` mismatches runtime, `policyVersionMatch=false`.
- Registry activation must be checksum-verified before the scheduler can consume it.
