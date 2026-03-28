# Binance CORE7 Alignment Round 2

Date: `2026-03-11`

## Objective

Determine whether the Binance path is repaired enough to reopen cross-venue research.

## Input

- `data/research/strategy/analysis/stage_c/binance_alignment_diagnosis.v1.json`

## Result

This round is judged only on whether Binance-linked fields are still all empty in the final target tables.

Current decision: `keep_arbitrage_closed`

## Evidence

The machine-readable diagnosis confirms:

- raw Binance spot files exist
- raw Binance UM files exist
- normalized Binance spot files exist
- normalized Binance UM files exist
- but the final target tables still show zero effective Binance coverage on:
  - `has_binance_spot_bar`
  - `has_binance_um_bar`
  - `spread_spot_pct`
  - `spread_um_pct`
  - `binance_basis_pct`

This means the path is blocked at merge/alignment time, not by missing raw downloads.

## Conclusion

Round 2 does not repair the Binance path.

The correct immediate state is:

- keep arbitrage research closed
- treat Binance as a downstream merge/alignment bug, not as an active strategy branch
