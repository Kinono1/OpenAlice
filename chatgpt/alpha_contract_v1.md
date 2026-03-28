# Alpha Contract V1

Last updated: `2026-03-13`

## Purpose

Freeze the three directional families for the OKX paper-first program so research does not drift into ad-hoc family expansion.

## Family: `vol_gated_breakout`

- `market_inefficiency_hypothesis`: high-volatility expansion on `1h` crypto bars can create short breakout continuation over the next `1-3` bars.
- `favorable_regime`: volatility rising, directional expansion, low recent fake-break frequency.
- `failure_regime`: noisy range, liquidity vacuum reversals, event-driven spikes that mean-revert immediately.
- `expected_holding_time`: `1-12` bars.
- `expected_trade_frequency`: `0.3-1.0` trades per symbol per day.
- `fee_slippage_sensitivity`: high; edge collapses quickly under wide market-order drag.
- `kill_metrics`: rolling false-break rate, post-entry expectancy after cost, realized hold-time inflation, slippage-adjusted PF.
- `parameter_neighborhood_rule`: breakout/exit/vol-threshold perturbations must keep non-negative expectancy across most immediate neighbors.

## Family: `vol_gated_trend`

- `market_inefficiency_hypothesis`: high-volatility trend phases in `BTC/ETH/SOL` can continue long enough that long-only SMA-style trend filters retain positive expectancy after cost.
- `favorable_regime`: sustained directional move, volatility elevated but not panic-like, correlation not forcing portfolio over-concentration.
- `failure_regime`: chop, post-spike exhaustion, rapid correlation spikes with weak follow-through.
- `expected_holding_time`: `4-48` bars.
- `expected_trade_frequency`: `0.1-0.5` trades per symbol per day.
- `fee_slippage_sensitivity`: medium-high; turnover must stay low enough that market-order drag does not dominate.
- `kill_metrics`: rolling expectancy after cost, monthly non-negative consistency, trade concentration, drawdown drift.
- `parameter_neighborhood_rule`: trend fast/slow plus vol-threshold perturbations must preserve top-tier ranking and non-negative expectancy.

## Family: `mixed_directional_gate`

- `market_inefficiency_hypothesis`: the same volatility regime signal can route capital between breakout-style and trend-style entries better than either family alone.
- `favorable_regime`: regime classification is stable for multiple bars and does not flip every event window.
- `failure_regime`: unstable routing, family switching on noise, one branch dominating all realized PnL.
- `expected_holding_time`: `2-24` bars.
- `expected_trade_frequency`: `0.2-0.8` trades per symbol per day.
- `fee_slippage_sensitivity`: high; routing complexity is only acceptable if net improvement survives cost.
- `kill_metrics`: routing instability, branch concentration, veto-adjusted expectancy, regime-bucket PnL concentration.
- `parameter_neighborhood_rule`: branch-weight or routing-threshold perturbations cannot reveal a thin parameter needle.

## Program Constraints

- `1h`
- `OKX`
- `BTC/USD`, `ETH/USD`, `SOL/USD`
- `long-only`
- `market orders only`
- no fourth family before one of the three directional families becomes the paper champion
