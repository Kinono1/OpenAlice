# Rollout R1 Controlled Restart Test

Date: `2026-03-11`

## Purpose

This procedure validates that the current `R1` crypto demo rollout survives a planned process restart without losing its minimum operating guarantees:

- `web` connector comes back
- `telegram` connector comes back
- `heartbeat` remains enabled
- `crypto/account` is reachable again
- `data/crypto-trading/pnl-fills.jsonl` does not regress
- `data/event-log/events.jsonl` continues from the previous sequence instead of resetting

This is a runtime reliability test. It does **not** evaluate strategy quality or authorize live trading.

## Preconditions

- Repository root: `/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice`
- Current rollout scope stays fixed:
  - `crypto` only
  - `OKX demo`
  - `BTC/USD`
  - `heartbeat.enabled = true`
- Start command uses the current proxy path:

```bash
cd /Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice
OPENALICE_HTTP_PROXY=http://127.0.0.1:7892 corepack pnpm dev
```

- If you want a restartable process under explicit operator control, use:

```bash
cd /Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice
mkdir -p tmp
OPENALICE_HTTP_PROXY=http://127.0.0.1:7892 corepack pnpm dev > tmp/rollout_r1_restart.log 2>&1 &
echo $! > tmp/rollout_r1.pid
```

## Pre-Restart Capture

Run all of the following before stopping the process.

### 1. Capture account reachability

```bash
curl -sS http://127.0.0.1:3002/api/crypto/account
```

Expected:

- JSON response is returned
- response is not `Crypto engine not connected`

### 2. Capture connector registry

```bash
curl -sS http://127.0.0.1:3002/api/dev/registry
```

Expected:

- `web` is present
- `telegram` is present

### 3. Capture heartbeat status

```bash
curl -sS http://127.0.0.1:3002/api/heartbeat/status
```

Expected:

- `{"enabled":true}`

### 4. Capture recent event tail and sequence

```bash
curl -sS 'http://127.0.0.1:3002/api/events/recent?limit=20'
```

Record:

- `lastSeq`
- any recent `heartbeat.error`
- any recent `risk.rejected`
- any recent `pnl.reconciliation.alert`

### 5. Capture event-log disk tail

```bash
tail -n 10 data/event-log/events.jsonl
```

Record:

- last `seq`
- last event type

### 6. Capture PnL persistence state

```bash
ls -l data/crypto-trading/pnl-fills.jsonl 2>/dev/null || echo 'NO_PNL_FILE'
tail -n 10 data/crypto-trading/pnl-fills.jsonl 2>/dev/null || true
```

Interpretation:

- `pnl-fills.jsonl` exists and contains real WIF fills.
- This validation is now a non-empty fill restart test, not a zero-fill fallback.

### 7. Force one new event before restart

Use the web chat route so the post-restart sequence check has a clean baseline.

```bash
curl -sS -X POST http://127.0.0.1:3002/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"reply with exactly: RESTART_PRECHECK_OK"}'
```

Expected:

- response text is `RESTART_PRECHECK_OK`
- this creates fresh `message.received` and `message.sent` events

## Restart Action

If you started the process with a PID file:

```bash
kill "$(cat tmp/rollout_r1.pid)"
sleep 3
OPENALICE_HTTP_PROXY=http://127.0.0.1:7892 corepack pnpm dev > tmp/rollout_r1_restart.log 2>&1 &
echo $! > tmp/rollout_r1.pid
sleep 12
```

If the process was started manually in a foreground terminal:

- stop it with `Ctrl-C`
- restart with the same command
- wait until web + telegram + crypto demo initialization completes

## Post-Restart Validation

Run all of the following after the process is back up.

### 1. Re-check registry

```bash
curl -sS http://127.0.0.1:3002/api/dev/registry
```

Pass criteria:

- `web` present
- `telegram` present

### 2. Re-check heartbeat status

```bash
curl -sS http://127.0.0.1:3002/api/heartbeat/status
```

Pass criteria:

- still returns `enabled=true`

### 3. Re-check crypto account

```bash
curl -sS http://127.0.0.1:3002/api/crypto/account
```

Pass criteria:

- JSON account payload returned
- no reconnect failure / engine missing state

### 4. Re-check OpenAI/GMN request path

```bash
curl -sS -X POST http://127.0.0.1:3002/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"reply with exactly: RESTART_POSTCHECK_OK"}'
```

Pass criteria:

- response text is `RESTART_POSTCHECK_OK`

### 5. Re-check Telegram outbound delivery

```bash
curl -sS -X POST http://127.0.0.1:3002/api/dev/send \
  -H 'content-type: application/json' \
  -d '{"text":"OpenAlice controlled restart check","channel":"telegram","source":"manual"}'
```

Pass criteria:

- response contains `delivered=true`

### 6. Re-check event continuity

```bash
curl -sS 'http://127.0.0.1:3002/api/events/recent?limit=20'
tail -n 10 data/event-log/events.jsonl
```

Pass criteria:

- post-restart `lastSeq` is greater than the pre-restart value after post-check traffic is generated
- no reset back to `seq=1`
- no unexplained burst of `heartbeat.error`

### 7. Re-check PnL persistence

```bash
ls -l data/crypto-trading/pnl-fills.jsonl 2>/dev/null || echo 'NO_PNL_FILE'
tail -n 10 data/crypto-trading/pnl-fills.jsonl 2>/dev/null || true
```

Pass criteria:

- if the file existed before restart, it still exists after restart
- line count is unchanged unless new fills were legitimately created
- restart itself must not create fake fills

### 8. Re-check reconciliation noise

```bash
curl -sS 'http://127.0.0.1:3002/api/events/recent?limit=50&type=pnl.reconciliation.alert'
```

Pass criteria:

- no new reconciliation alert appears solely because of restart

## Result Classification

Mark the test as `PASS` only if all of the following are true:

- connectors restored
- heartbeat restored
- crypto account restored
- OpenAI/GMN web request still works
- Telegram outbound still works
- event log sequence continued
- PnL persistence did not regress

Mark the test as `FAIL` if any of the following happen:

- `web` or `telegram` missing after restart
- `heartbeat.enabled` flips to false
- `crypto/account` fails or returns disconnected state
- `RESTART_POSTCHECK_OK` chat probe fails
- event log sequence resets
- `pnl-fills.jsonl` disappears or replays incorrectly
- restart creates a fresh reconciliation alert without any new fill activity

## Escalation Rule

Any failure in this test is a platform blocker and outranks new Stage-C research work.

Required response:

1. stop widening rollout
2. capture `tmp/rollout_r1_restart.log`
3. capture `tail -n 50 data/event-log/events.jsonl`
4. file the issue under platform/runtime reliability, not under strategy research
