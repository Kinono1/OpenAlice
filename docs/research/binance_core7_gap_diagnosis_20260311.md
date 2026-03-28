# Binance CORE7 Gap Diagnosis

Date: `2026-03-11`

## Decision Question

Is the current Binance gap caused by missing upstream data, or by a downstream merge/alignment failure?

## Observed Facts

The following are all true at the same time:

- raw Binance data directories exist under:
  - `data/market/binance_1m_core7/spot`
  - `data/market/binance_1m_core7/um`
- normalized Binance data directories also exist under:
  - `data/market/binance_1m_core7_norm/spot`
  - `data/market/binance_1m_core7_norm/um`
- symbols such as `BTCUSDT`, `ETHUSDT`, `SOLUSDT` are present in both raw and normalized roots
- but the redesigned target tables still show:
  - `has_binance_spot_bar = 0`
  - `has_binance_um_bar = 0`
  - `spread_spot_pct = null`
  - `spread_um_pct = null`
  - `binance_basis_pct = null`

## What This Rules Out

This is no longer consistent with the simple claim:

- “Binance data was never downloaded”

That claim is too weak, because the files are there.

## Most Likely Failure Layer

The strongest current hypothesis is:

- Binance ingestion exists
- normalization exists
- feature-base construction is failing to merge Binance data into the final per-instId tables

The likely failure class is:

- symbol/path mapping mismatch
- timestamp alignment mismatch
- stale feature-base build that did not re-ingest the newer normalized Binance tables

## Source Of Truth In Code

Relevant code path:

- `scripts/build_core7_feature_base.py`

This script:

- derives Binance symbol names from OKX base/quote
- loads Binance spot + UM normalized files
- merges them on `timestamp_ms`
- writes `has_binance_spot_bar`, `has_binance_um_bar`, `spread_spot_pct`, `spread_um_pct`, `binance_basis_pct`

So if all these fields remain null while normalized Binance data exists, the problem is now downstream of raw download.

## Immediate Next Step

Do not reopen the arbitrage path yet.

First do one focused engineering task:

- reproduce and fix the Binance merge/alignment failure inside `build_core7_feature_base.py`

## Conclusion

Current Binance gap diagnosis:

- upstream raw data: present
- normalized Binance data: present
- final feature merge: likely broken or stale

Therefore the correct next action is `merge/alignment repair`, not “download Binance again and hope”.
