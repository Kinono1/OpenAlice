# Rollout R1 Runbook

Date: `2026-03-11`

> Superseded for release promotion work.
> Use [docs/operations/canary_release_runbook.md](/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice/docs/operations/canary_release_runbook.md) for the official paper-to-micro-live path.

## Purpose

This runbook is the operator reference for the current `R1` crypto demo rollout.

It covers:

- start
- stop
- controlled restart
- health checks
- failure triage

It does **not** authorize live trading. Current rollout scope is still:

- `crypto` only
- `OKX demo`
- `BTC/USD`
- `heartbeat` enabled
- `web + telegram` connectors active

## Start Command

Use the current proxy-aware start path:

```bash
cd /Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice
OPENALICE_HTTP_PROXY=http://127.0.0.1:7892 corepack pnpm dev
```

Recommended operator-controlled start:

```bash
cd /Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice
mkdir -p tmp
OPENALICE_HTTP_PROXY=http://127.0.0.1:7892 corepack pnpm dev > tmp/rollout_r1.log 2>&1 &
echo $! > tmp/rollout_r1.pid
```

## Stop Command

If started with a PID file:

```bash
kill "$(cat tmp/rollout_r1.pid)"
```

If started in the foreground:

- stop with `Ctrl-C`

## Restart Command

Use the exact same environment as start:

```bash
kill "$(cat tmp/rollout_r1.pid)"
sleep 3
OPENALICE_HTTP_PROXY=http://127.0.0.1:7892 corepack pnpm dev > tmp/rollout_r1.log 2>&1 &
echo $! > tmp/rollout_r1.pid
sleep 12
```

After every restart, run the health checks below in order.

## Mandatory Health Checks

### 1. Connector registry

```bash
curl -sS http://127.0.0.1:3002/api/dev/registry
```

Expected:

- `web` present
- `telegram` present

### 2. Heartbeat state

```bash
curl -sS http://127.0.0.1:3002/api/heartbeat/status
```

Expected:

- `enabled=true`

### 3. Crypto account

```bash
curl -sS http://127.0.0.1:3002/api/crypto/account
```

Expected:

- real JSON payload
- no disconnected error

### 4. Web request path / OpenAI probe

```bash
curl -sS -X POST http://127.0.0.1:3002/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"reply with exactly: RUNBOOK_OK"}'
```

Expected:

- `RUNBOOK_OK`

### 5. Telegram outbound

```bash
curl -sS -X POST http://127.0.0.1:3002/api/dev/send \
  -H 'content-type: application/json' \
  -d '{"text":"OpenAlice runbook health check","channel":"telegram","source":"manual"}'
```

Expected:

- `delivered=true`

### 6. Event tail

```bash
curl -sS 'http://127.0.0.1:3002/api/events/recent?limit=20'
```

Watch for:

- `heartbeat.error`
- `risk.rejected`
- `pnl.reconciliation.alert`

### 7. Disk tails

```bash
tail -n 10 data/event-log/events.jsonl
tail -n 10 data/crypto-trading/pnl-fills.jsonl 2>/dev/null || true
```

Use this to confirm:

- event sequence is progressing
- PnL persistence is not regressing

## Observation Loop

During the `24h-72h` R1 observation window, repeat this minimal loop:

```bash
curl -sS http://127.0.0.1:3002/api/crypto/account
curl -sS http://127.0.0.1:3002/api/dev/registry
curl -sS http://127.0.0.1:3002/api/heartbeat/status
curl -sS 'http://127.0.0.1:3002/api/events/recent?limit=50'
```

If any of these fail, treat it as a runtime issue first, not a research issue.

## Failure Triage

### Case A: `crypto/account` fails

Likely impact:

- exchange connection not restored
- reconnect path broken

Immediate action:

1. check `tmp/rollout_r1.log`
2. restart the process once
3. re-run the mandatory health checks

If it still fails:

- stop rollout expansion
- escalate as platform/runtime blocker

### Case B: `telegram` missing from registry or outbound send fails

Likely impact:

- no active notification path

Immediate action:

1. inspect `data/config/connectors.json`
2. restart the process
3. re-run `POST /api/dev/send`

If it still fails:

- do not continue unattended observation
- classify as blocker

### Case C: `heartbeat.enabled` is false or repeated `heartbeat.error`

Likely impact:

- self-check chain not functioning

Immediate action:

```bash
curl -sS -X PUT http://127.0.0.1:3002/api/heartbeat/enabled \
  -H 'content-type: application/json' \
  -d '{"enabled":true}'
curl -sS -X POST http://127.0.0.1:3002/api/heartbeat/trigger
```

If repeated errors continue:

- classify as blocker
- keep rollout in demo only

### Case D: new `pnl.reconciliation.alert`

Likely impact:

- internal position/PnL bookkeeping diverged

Immediate action:

1. inspect the alert payload in `/api/events/recent`
2. inspect `data/crypto-trading/pnl-fills.jsonl`
3. do not widen rollout until the cause is understood

If the alert appeared immediately after restart without new fills:

- treat it as a restart/persistence bug

## Escalation Rules

These conditions immediately outrank Stage-C research work:

- crypto account unreachable
- connector registry missing `telegram`
- heartbeat repeatedly failing
- restart breaks event continuity
- PnL persistence regresses
- unexplained reconciliation alert appears

Required response:

1. freeze rollout expansion
2. preserve logs and event tails
3. route the issue back to platform/runtime repair

## Non-Goals

This runbook does not cover:

- live trading cutover
- `securities`
- strategy quality review
- `G3` release decisions

Those remain outside `R1` operations.
