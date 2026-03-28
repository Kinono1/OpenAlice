# Stage-C Feature / Horizon Input Pack

Date: `2026-03-11`

## Purpose

This is the only input pack for the next research sprint.

## Locked Inputs

- selected next direction: `feature_horizon_redesign`
- selected next target: `realized_vol_1h`
- target role: `regime / gating target`

## Input Tables

Use:

- `data/research/strategy/analysis/stage_c/target_tables/okx_inst_id=BTC-USDT/data.csv`
- `data/research/strategy/analysis/stage_c/target_tables/okx_inst_id=ETH-USDT/data.csv`
- `data/research/strategy/analysis/stage_c/target_tables/okx_inst_id=SOL-USDT/data.csv`

These tables already include:

- `target_realized_vol_1h`
- `target_abs_return_1h`
- `target_forward_return_4h`
- `target_directional_persistence_1h`

## Required Constraint

The next candidate sprint must start from `target_realized_vol_1h`.

It may not:

- reopen the old direct forward-return sweep first
- widen family count first
- treat `realized_vol_1h` as a direct buy/sell target

## Current Seed Outcome

The first seed family exists only as historical evidence:

- `docs/research/stage_c_strategy_candidates.seed_family.v1.json`
- `docs/research/stage_c_seed_family_design_20260311.md`
- `docs/research/stage_c_seed_family_smoke_20260311.md`
- `docs/research/stage_c_strategy_candidates.seed_family.r2.json`
- `docs/research/stage_c_seed_family_round2_design_20260311.md`
- `docs/research/stage_c_seed_family_round2_smoke_20260311.md`

Current status:

- Round 1: `keep_seed`
- Round 2: `kill_seed`
- current active decision: do **not** deepen the existing breakout seed further

## Current Active Entry

The next active entry is no longer \"deepen the seed\".

The next active entry is:

- `docs/research/stage_c_round4_arch_review_20260311.md`
- `docs/research/stage_c_round4_mapping_experiment_20260311.md`

That means the next sprint must:

- keep `target_realized_vol_1h`
- compare low-complexity trade mappings from the same target
- avoid new family expansion until one mapping survives
