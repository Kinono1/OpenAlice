# Arbitrage Path Reopen Decision

Date: `2026-03-11`

## Decision Question

Should the cross-exchange arbitrage path be reopened now?

## Current Answer

No.

## Reason

There are two blockers, and either one is enough to keep the path closed:

1. Binance-linked fields are still missing from the final feature tables
2. Even before reopening the path, the current evidence says the old basis/spread path was too weak to survive the research gates

## What Must Happen Before Reopen

Both conditions must be satisfied:

1. Binance merge/alignment repair is completed
2. A fresh feature-base rebuild proves that these columns are non-null on the relevant assets:
   - `has_binance_spot_bar`
   - `spread_spot_pct`
   - `spread_um_pct`
   - `binance_basis_pct`

Only after that should the arbitrage path be re-evaluated for net profitability after fees.

## Conclusion

Current decision: `keep_closed`
