# Runtime Contract V1

Last updated: `2026-03-13`

## Contract Evolution Note

This document still describes the baseline runtime semantics that must remain true.

Canonical machine-readable contracts now also exist for integration work:
- `research_decision.v1`
- `execution_intent.v1`

Those newer contracts should inherit the timing, idempotency, and governance semantics documented here rather than redefine them.

## DataContract

```yaml
bar_interval: 1h
signal_bar_requirement: completed_only
required_fields: [tsOpenMs, barIntervalMs, barCloseMs, completed, sourceDomain]
max_missing_bars_in_execution_window: 0
duplicate_bars: reject
timestamp_alignment: exact_open_boundary
clock_skew_threshold_ms: 30000
invalid_ohlc: reject
partial_data_fallback: no_new_opens_allow_reduction_only
```

## ExecutionSemanticsContract

```yaml
signal_generation: at_completed_bar_close
submit_timing: immediate_after_close
submit_deadline_ms: 15000
order_type: market_only
position_mode: long_only
max_net_position_per_symbol: 1
client_order_id: mandatory
timeout_rule: reconcile_by_clOrdId_before_retry
blind_retry: forbidden
order_stale_ms: 30000
```

## EventBlockRules

```yaml
macro_high_risk_window: T_minus_60m_to_T_plus_60m_block_new_opens
exchange_outage: block_all_new_opens
security_incident: block_all_new_opens
major_unlock_or_forced_flow: no_new_opens_allow_reduction_only
deterministic_blocks_override_ai_veto: true
event_clock_source: exchange_server_time
allowed_flag_classes: [macro, exchange_ops, security_incident, token_unlock]
```

## VetoCounterfactualSpec

```yaml
veto_outputs: [approve, downsize, skip]
symbol_or_side_mutation: forbidden
baseline_set: all_deterministic_proposed_trades
monthly_metrics: [delta_expectancy_after_cost, delta_profitFactor, delta_maxDrawdownPct, delta_realized_volatility]
downsize_baseline: full_size_deterministic_trade
required_audit_fields: [veto_policy_version, allowed_inputs_schema_version, reason_code, confidence, input_snapshot_hash, counterfactual_trade_id]
intervention_rate_guardrail: 0.40_for_2_monthly_reviews
non_positive_uplift_guardrail: 2_consecutive_monthly_reviews
```
