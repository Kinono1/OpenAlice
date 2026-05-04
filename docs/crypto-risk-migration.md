# OpenAlice Crypto Risk Migration

This document is the operator-facing migration note for the current crypto runtime contract.

## Canonical config split

- `data/config/crypto.json`
  - exchange/provider wiring
  - policy guards only: `symbol-whitelist`, `cooldown`
- `data/config/risk.json`
  - numeric execution limits and hard gates
  - leverage, position-size, max order notional, daily loss, CVaR, and capital-ramp rules
- `data/config/auth.json`
  - auth enforcement policy for web and MCP surfaces

## Deprecated crypto guards

The following crypto guard types are deprecated and skipped at runtime:

- `max-position-size`
- `max-leverage`

When present, OpenAlice logs a warning and ignores them:

- `guard: "max-position-size" is deprecated and was skipped`
- `guard: "max-leverage" is deprecated and was skipped`

These limits must now be configured in `data/config/risk.json`.

## Risk fields that replace deprecated guards

Use `risk.json` for numeric gates:

- `maxLeverage`
- `maxOrderUsd`
- `maxPositionPctOfEquity`
- `maxOpenPositions`
- `maxDailyLossUsd`
- `dailyLossPctSoftCap`
- `cvarLossPctSoftCap`
- `consecutiveLossDaysLimit`
- `consecutiveLossPctThreshold`
- `capitalScaleRules[*]`

The dispatcher-level `preTradeRiskCheck` is the only numeric risk authority for crypto execution.

## Auth and readiness

`auth.enforceAuth` is now secure-by-default.

- If auth is enforced and `AUTH_TOKEN` / `TRADE_TOKEN` are missing, protected routes return `401`.
- In the same state, readiness reports `not-ready`.
- Readiness becomes `ready` only when auth requirements and exchange/config checks are all satisfied.
