# Research Takeaways v1

Date: `2026-03-13`

## Adopt Now
- promote `clOrdId`, timeout reconciliation, and no-blind-retry into the execution contract
- treat completed-bar semantics, timestamp anchoring, duplicate-bar rejection, and clock skew as DataContract fields
- require `trial_count`, `candidate_list_hash`, and `search_policy_hash` for any DSR/PBO/FDR-based promotion
- keep AI in veto-only mode with whitelist inputs and counterfactual audit
- keep paper/live gate semantics separate

## Adopt As Warning, Not Hard Block
- trade/month/regime concentration metrics for trend-like families
- top-trade concentration diagnostics
- regime PnL concentration diagnostics

## Future Work, Not v1 Blocker
- `tgtCcy` and `banAmend` become mandatory when the mainline expands into OKX spot flows
- region/domain pinning beyond current swap demo baseline
- richer event calendars and macro sources after deterministic event blocks are stable

## Reject As Overstatement
- “there is no real system until raw OHLCV fetch is proven” is false for this repo; runtime, wallet, guards, demo mode, and backtest/gate infrastructure already exist
- “concentration must always be a hard blocker” is too strong for skewed trend families
