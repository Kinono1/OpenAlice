# Runtime Truth Reconciliation

Date: `2026-03-11`

## Purpose

This note resolves the conflict between:

- worker-side rollout evidence collected from a shell that could not reach the runtime
- runtime-owning shell checks that successfully reached the active OpenAlice process

Without this reconciliation, the repo contains two incompatible readings of `R1`.

## Conflicting Inputs

### Blocked reading

Blocked evidence came from a shell that returned connection/runtime binding failures while trying to read:

- `/api/crypto/account`
- `/api/dev/registry`
- `/api/heartbeat/status`
- `/api/events/recent`

This reading is useful only as evidence that not every shell on the host owns the runtime.

### Runtime-owning reading

Runtime-owning evidence succeeded on:

- `GET /api/crypto/account`
- `GET /api/dev/registry`
- `GET /api/heartbeat/status`
- `POST /api/chat` returning `OPENAI_OK`
- `POST /api/dev/send` returning `delivered=true`

This reading reflects the actual current rollout state.

## Resolved Truth

The current runtime truth is:

- `R1 runtime = reachable`
- `R1 connector set = web + telegram`
- `R1 heartbeat = enabled`
- `R1 crypto demo engine = reachable`
- `R1 OpenAI-compatible GMN path = working on /api/chat`
- `R1 outbound Telegram path = working`

## Updated Runtime Evidence

New evidence now exists:

- real trade permission was confirmed via a real WIF round-trip
- `data/crypto-trading/pnl-fills.jsonl` is non-empty
- non-empty fill restart validation has completed successfully

This supersedes the earlier zero-fill-only runtime caveat.

## Resolved Runtime Truth

The current runtime truth is now:

- `R1 runtime = reachable and healthy`
- `trade permission = confirmed`
- `non-empty pnl-fills = generated`
- `non-empty fill restart validation = passed`

## Documentation Rule

From this point on:

- use `rollout_r1_review_20260311.md` as the current rollout truth document
- treat blocked worker-shell rollout snapshots as stale context, not current state
- do not write any new doc that says `R1` is runtime-blocked unless the runtime-owning shell reproduces the same failure
