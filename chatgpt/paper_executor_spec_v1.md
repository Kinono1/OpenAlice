# Paper Executor Spec V1

Last updated: `2026-03-13`

## Purpose

Define the automatic paper execution loop for `OKX` demo trading using one approved champion registry.

## Paper Gate Structure

- `researchApproved`
- `runtimeHealthy`
- `dataFresh`
- `dataQualityValid`
- `connectorHealthy`
- `riskLimitsLoaded`
- `championLoaded`
- `policyVersionMatch`
- `paperExecutorEnabled`
- `finalAllowPaperTrading = all(true)`

## Scheduling and Flow

1. wait for completed `1h` bar
2. load active champion registry
3. compute deterministic signals for `BTC/USD`, `ETH/USD`, `SOL/USD`
4. apply portfolio ranking and exposure rules
5. run AI veto on shortlisted intents only
6. convert approved intents into wallet operations
7. `commit + push + sync + journal`

## Portfolio Rules

- `long-only`
- `market orders only`
- `max concurrent positions = 2`
- `per-symbol exposure cap = 15% equity`
- `total gross exposure cap = 30% equity`
- `correlated exposure cap = 25%` when `7d` or `30d` `1h` log-return correlation `>= 0.75`
- priority score = `expected_edge_score - slippage_penalty - correlation_penalty`
- deterministic tie-break = `BTC > ETH > SOL`

## Cooldowns

- `daily realized loss >= 2%` → pause new opens `24h`
- `drawdown from HWM >= 4%` → pause new opens `24h`
- deterministic event blocks override all new opens

## Runtime-Faithful Simulation Requirement

Paper promotion requires a pre-demo simulation using the same:

- scheduler timing
- signal path
- veto path
- wallet path
- order state machine
- restart/recovery behavior
