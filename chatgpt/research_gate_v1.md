# Research Gate V1

Last updated: `2026-03-13`

## Purpose

Define the machine-checkable promotion rules for turning a directional family into the active paper champion.

## Hard Gates

- Aggregate portfolio:
  - `closedTrades >= 180`
  - `profitFactor >= 1.10`
  - `expectancy_after_cost > 0`
  - `maxDrawdownPct <= 15`
  - `fdrQ <= 0.20`
  - `meanPbo <= 0.30`
  - `meanDsrProbability >= 0.20`
  - at least `2/3` rolling monthly windows have non-negative expectancy after cost
- Per-symbol floors:
  - `closedTrades >= 40`
  - `profitFactor >= 1.00`
  - `expectancy_after_cost >= 0`
  - `maxDrawdownPct <= 18`

## Trial Accounting Requirement

- Champion artifact must include:
  - `trial_count`
  - `candidate_list_hash`
  - `search_policy_hash`
  - `fdr_method`
  - `pbo_method`
  - `dsr_method`
- If any of these are missing, `researchApproved=false`.

## Parameter Robustness

- Immediate 8-neighbor grid required.
- Axis perturbation checks required for each family’s primary parameters.
- At least `6/8` immediate neighbors must preserve:
  - `expectancy_after_cost >= 0`
  - `profitFactor >= 1.00`
- Champion must stay in neighborhood `top 30%` by cost-adjusted expectancy.
- Thin one-point parameter spikes are non-promotable.

## Concentration Warnings

These are warnings plus human review, not automatic hard blockers for directional families:

- single symbol > `60%` of total realized PnL
- single month > `50%` of total realized PnL
- top 5 trades > `45%` of total realized PnL
- single regime bucket > `70%` of total realized PnL

## Required Champion Output

- `accepted_metrics`
- `accepted_oos_window`
- `research_dataset_hash`
- `feature_pipeline_version`
- `signal_code_commit_hash`
- `cost_model_version`
