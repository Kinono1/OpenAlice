# Paper Acceptance V1

Last updated: `2026-03-13`

## Purpose

Freeze the minimum acceptance rules for promoting one directional family into the automatic OKX demo paper executor.

## Aggregate Hard Gates

- `closedTrades >= 180`
- `profitFactor >= 1.10`
- `expectancy_after_cost > 0`
- `maxDrawdownPct <= 15`
- `fdrQ <= 0.20`
- `meanPbo <= 0.30`
- `meanDsrProbability >= 0.20`
- at least `2/3` rolling monthly windows have non-negative expectancy after cost

## Per-Symbol Floors

- `closedTrades >= 40`
- `profitFactor >= 1.00`
- `expectancy_after_cost >= 0`
- `maxDrawdownPct <= 18`

## Trial Accounting

The candidate is non-promotable if any of these are missing:

- `trial_count`
- `candidate_list_hash`
- `search_policy_hash`
- `fdr_method`
- `pbo_method`
- `dsr_method`

## Parameter Robustness

- immediate `8` neighbors required
- axis sensitivity checks required
- at least `6/8` neighbors keep non-negative expectancy and `PF >= 1.00`
- champion must stay inside neighborhood `top 30%` by cost-adjusted expectancy

## Concentration Warnings

These do not auto-kill directional families, but they force human review:

- single symbol > `60%` of total realized PnL
- single month > `50%` of total realized PnL
- top 5 trades > `45%` of total realized PnL
- single regime bucket > `70%` of total realized PnL
