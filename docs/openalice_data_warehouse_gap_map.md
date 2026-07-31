# OpenAlice Data Warehouse Gap Map

Updated: 2026-05-05

This document maps the current crypto data footprint to the target
multi-source warehouse. It is intentionally fail-closed: anything not
explicitly verified below is treated as missing or incomplete.

## Current verified state

### Binance market data

- External Binance public data is already present under
  `/Volumes/shield/cryptoData/openalice-data/market/binance-public`.
- Verified complete datasets currently include:
  - `spot-all-usdt-klines-1d`
  - `spot-all-usdt-klines-1h`
  - `spot-all-usdt-klines-5m`
  - `spot-all-usdt-klines-1m`
  - `um-all-usdt-klines-1d`
  - `um-all-usdt-klines-1h`
  - `um-all-usdt-klines-5m`
  - `um-all-usdt-klines-1m`
- The managed downloader and auditor exist:
  - `scripts/fast_binance_data_vision_backfill.ts`
  - `scripts/run_fast_binance_data_vision_dataset.ts`
  - `scripts/run_fast_binance_data_vision_full_backfill.sh`
  - `scripts/finalize_fast_binance_data_vision_summary.ts`
  - `scripts/audit_fast_binance_data_vision_downloads.ts`

### Live market layers already in repo

- `data/market/live_1s`
- `data/market/live_5m`
- `data/market/live_accumulated`
- `data/market/multi_assets`
- `data/market/gate`

These are useful inputs, but they are not yet a unified warehouse contract.

### External derivatives

- A single append-only JSONL exists:
  - `data/external/derivatives/binance_usdm_derivatives_events.jsonl`
- A collector exists:
  - `scripts/collect_external_derivatives_data.ts`
- This is still a single-source, single-schema feed. It is not yet a
  warehouse with catalog, normalized tables, and cross-source auditing.

## What still needs expansion

### 1. Unified data catalog

Missing:

- One machine-readable registry for all data sources and datasets.
- Per-dataset fields for:
  - source
  - market
  - granularity
  - start/end coverage
  - update cadence
  - location
  - format
  - status
  - checksum / provenance
  - retry/finalize state

Why this matters:

- Without a registry, the warehouse is a collection of folders, not a
  contract.
- Audit and resume logic cannot be generalized across sources.

### 2. Canonical normalization layer

Missing:

- A `raw -> normalized/parquet` path for each source.
- Canonical schemas for:
  - OHLCV
  - trades / aggTrades
  - funding rate
  - open interest
  - order book / book ticker
  - on-chain metrics
  - asset metadata

Why this matters:

- Raw zip/csv/jsonl files are not directly usable as stable model inputs.
- Feature generation needs a consistent as-of join surface.

### 3. On-chain source integration

Missing:

- At least one public/low-cost on-chain source with a retryable collector.
- Suggested first source:
  - Coin Metrics Community or an equivalent public API/flat-file source.

Minimum useful coverage:

- active addresses
- transactions
- fees
- supply / realized-cap style fields
- exchange flow indicators, if available

### 4. Asset metadata layer

Missing:

- A canonical asset registry.
- Required fields:
  - symbol mapping
  - venue mapping
  - listing date
  - delisting date
  - contract address
  - decimals
  - market type
  - timestamp precision
  - active/inactive state

Why this matters:

- It prevents survivorship bias and symbol drift.
- It makes point-in-time joins possible.

### 5. Cross-source provenance

Missing:

- A standard provenance envelope for every dataset and every derived
  table.
- Required fields:
  - source URL or endpoint
  - fetch timestamp
  - code version / git commit
  - input manifest hash
  - artifact hash
  - retry count
  - finalize status
  - last-success timestamp

### 6. Warehouse audit layer

Missing:

- One audit pass that can score all sources with the same vocabulary:
  - `complete`
  - `partial`
  - `failed`
  - `missing`
  - `stale`
  - `needs_retry`

Needed checks:

- coverage completeness
- missing intervals
- duplicate files / duplicate rows
- time-order monotonicity
- timestamp precision mismatch
- checksum mismatches
- source drift / schema drift

### 7. Resume / finalize / reconcile semantics

Missing or source-specific:

- A generalized resume token for all collectors.
- A shared `finalize` pass that can refresh summaries after retries.
- A shared `reconcile` pass that can detect a dataset is complete even if
  the first discovery pass ended in a stale or partial summary.
- Shared `.part` cleanup and idempotent write behavior.

### 8. Feature / backtest input layer

Missing:

- A normalized feature store or snapshot layer.
- Explicit point-in-time join contracts.
- Train/validation/test snapshot manifests.
- Cost model inputs:
  - fee
  - spread
  - slippage
  - funding
  - open-interest / liquidation context

Why this matters:

- Backtests should not read raw source files directly.
- Strategy code should consume stable snapshots, not mutable downloads.

### 9. Time-span policy by source

Missing:

- A per-source coverage policy that records:
  - earliest available history
  - current latest available point
  - update cadence
  - lag tolerance

Current working rule:

- Binance spot public history should prioritize `2017-08 -> now`.
- Binance USD-M futures public history should prioritize `2019-09 -> now`.
- Other sources should use their earliest available history, but the rule
  must be recorded per source.

### 10. License / usage policy

Missing:

- Source-level license metadata and usage constraints.
- A clear separation of:
  - free/public research sources
  - community sources
  - commercial sources

Why this matters:

- The warehouse needs to be usable, not just downloadable.

## Recommended build order

1. Build the unified catalog and provenance envelope.
2. Normalize Binance market and derivatives into canonical parquet tables.
3. Add on-chain source integration.
4. Add asset metadata and symbol listing/delisting history.
5. Add a warehouse-wide audit report.
6. Add resume/finalize/reconcile semantics across all collectors.
7. Add feature/backtest snapshots with point-in-time joins.

## Completion rule

The warehouse is not complete until every source has:

- a download/collection script
- a normalized output
- a machine-readable audit result
- a retry/finalize path
- a documented time-span policy

