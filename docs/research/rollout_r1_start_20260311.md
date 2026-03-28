# Rollout R1 Start

Date: `2026-03-11`

## Scope

This document freezes the actual start state of `Rollout Lane R1`.

- Venue: `OKX`
- Runtime mode: `demoTrading=true`
- Product line: `crypto` only
- Symbol scope: `BTC/USD`
- AI backend: `vercel-ai-sdk`
- Model provider path: `openai-compatible via GMN base URL`
- Connectors in scope: `web`, `telegram`
- Monitoring: `heartbeat` enabled every `15m`

This is **not** live trading and **not** a first-party shadow engine. Orders route to the exchange demo environment.

## Verified Start State

The following checks were re-verified at rollout start:

1. `data/config/crypto.json`
   - `exchange = okx`
   - `defaultMarketType = swap`
   - `demoTrading = true`
   - `allowedSymbols = ["BTC/USD"]`
2. `data/config/heartbeat.json`
   - `enabled = true`
   - `every = "15m"`
3. `data/config/ai-provider.json`
   - `backend = vercel-ai-sdk`
   - `provider = openai`
   - `model = gpt-5.4`
   - `baseUrl = https://gmn.chuangzuoli.com`
4. connector registry
   - `web` registered
   - `telegram` registered for private chat `7743786449`
5. OpenAI/GMN request path
   - `POST /api/chat` with `reply with exactly: OPENAI_OK`
   - returned `OPENAI_OK`
6. outbound notification path
   - `POST /api/dev/send`
   - returned `delivered=true` for Telegram
7. crypto account path
   - `GET /api/crypto/account`
   - returned demo account payload instead of `Crypto engine not connected`

## Current Account Snapshot

Snapshot taken from `GET /api/crypto/account` during rollout start:

- `balance = 19.657509451383937`
- `equity = 63.78837945138394`
- `totalMargin = 44.13087`
- `unrealizedPnL = 0`
- `realizedPnL = 0`
- `realizedPnlSource = derived_fallback`
- `realizedPnlConfidence = 0.2`

This snapshot is only a start marker. It is not a performance evaluation.

## Known Boundaries

- `securities` is not part of this rollout.
- `demoTrading=true` means exchange demo mode, not a first-party shadow runtime.
- `OpenBB equity` sidecar is still unavailable and remains out of scope for this crypto-only rollout.
- `GMN/OpenAI` has been validated on the web request path, but the observation window has not completed yet.
- `decision_packet` is still `NO_GO`; rollout does not override `G3`.

## Observation Checklist (24h-72h)

Check these endpoints and behaviors repeatedly during R1:

1. `GET /api/crypto/account`
   - account stays reachable
   - no reconnect drift after runtime restarts
2. `GET /api/dev/registry`
   - `telegram` remains registered
   - `web` remains registered
3. `GET /api/heartbeat/status`
   - stays `enabled=true`
4. `GET /api/events/recent?limit=50`
   - watch for:
     - `heartbeat.error`
     - `risk.rejected`
     - `pnl.reconciliation.alert`
     - connector silent failure
5. Telegram
   - outbound test still delivers
   - bot remains responsive to basic inbound commands

## Exit / Escalation Rule

If any runtime issue appears during R1, it outranks Stage-C research work and must flow back to platform repair first:

- reconnect causes crypto engine loss
- Telegram connector disappears
- heartbeat starts failing repeatedly
- risk / kill-switch / dispatcher hooks stop firing
- unexplained reconciliation alerts appear

Until those runtime issues are fixed, rollout should not widen and live trading should not be discussed.
