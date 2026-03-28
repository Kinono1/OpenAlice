# Rollout R1 Observation Window

Date: `2026-03-11`

## Objective

Keep `R1` in demo observation mode long enough to answer one question:

Can the current `crypto-only + OKX demo + BTC/USD + web + telegram + heartbeat` stack remain healthy under routine use without hidden reconnect or notification drift?

## Fixed Scope

- exchange: `OKX`
- mode: `demoTrading=true`
- symbol scope: `BTC/USD`
- connectors: `web`, `telegram`
- AI path: `vercel-ai-sdk + openai-compatible GMN`
- heartbeat: `enabled`, `15m`

No scope expansion is allowed during this window.

## Checkpoints

### 24h check

Run and record:

- `GET /api/crypto/account`
- `GET /api/dev/registry`
- `GET /api/heartbeat/status`
- `GET /api/events/recent?limit=50`
- `POST /api/chat` with `OPENAI_OK`
- `POST /api/dev/send` with a manual Telegram message

### 72h check

Repeat the same full set.

## What Must Be Logged

- any reconnect failure
- any loss of `telegram` in registry
- any repeated `heartbeat.error`
- any `risk.rejected`
- any `pnl.reconciliation.alert`
- whether runtime stayed reachable throughout

## Exit Conditions

Mark the observation window as `pass` only if:

- account stays reachable
- `web` and `telegram` remain present
- heartbeat stays enabled
- `OPENAI_OK` chat probe continues to succeed
- Telegram delivery continues to succeed

Mark it as `degraded` if:

- runtime remains reachable, but repeatable non-blockers appear

Mark it as `blocked` if:

- runtime becomes unreachable
- connector registry drops `telegram`
- heartbeat repeatedly fails
- reconnect breaks crypto availability

## Fill Recovery Status

Non-empty fill restart validation is now complete.
