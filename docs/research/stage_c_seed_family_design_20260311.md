# Stage-C Seed Family Design

Date: `2026-03-11`

## Objective

Translate the `feature_horizon_redesign` decision into the smallest possible executable research family.

This is not a broad family search. It is a single seed family designed to test whether `realized_vol_1h` can improve candidate quality when used as a gating target.

## Family Definition

Selected seed family:

- `vol_gated_breakout_seed`

Implemented strategy type:

- `volBreakout`

## Core Logic

- compute current realized volatility over a recent window
- compare it to a baseline volatility regime
- only allow breakout entries when the volatility gate is open
- reuse trailing breakout exits for position management
- do not treat volatility itself as direction

## Why This Seed

It is the smallest faithful implementation of the current architecture review:

- `realized_vol_1h` is treated as gating, not direction
- the family count is fixed at one
- long-only is enforced for the first pass
- old direct return-based direction families remain frozen

## Parameter Grid

First-pass core grid:

- `volTriggerRatio`: 3 levels
- `breakoutPeriod`: 3 levels
- `breakoutExitPeriod`: linked to breakout period

Total first-pass candidates:

- `9`

## Constraints

- no additional families
- no short-side expansion
- no selective-inference rescue logic
- no parameter sweep beyond the first 9 combinations until this seed shows sanity-level improvement
