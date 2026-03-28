# Canary Release Runbook

This is the only supported operator path for advancing OpenAlice from preflight to paper canary and then to micro-live.

Do not hand-edit `data/runtime/canary_state.json`.
The file is checksum-protected. Manual edits will fail runtime validation and block new live opens.

## Entry Command

```bash
cd /Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice
corepack pnpm canary:release status
```

## Commands

### 1. Preflight

```bash
corepack pnpm canary:release preflight
```

This runs:

- `gates_preflight.py`
- `build_gate_checkpoints.py`
- `run_paper_runtime_diagnostic.ts`

Expected outcome:

- `phase=preflight_passed`
- no blocking reasons

### 2. Start Paper Canary

```bash
corepack pnpm canary:release start-paper
```

Expected outcome:

- `phase=paper_running`
- observation window starts now

### 3. Evaluate Paper Canary

```bash
corepack pnpm canary:release evaluate-paper
```

Pass criteria:

- paper observation window complete
- runtime health checks pass
- no `heartbeat.error`
- no `gate.circuit_open`
- no `cron.paused`
- no `pnl.reconciliation.alert`
- no paper executor failures
- no idempotency duplicates

Expected outcome:

- `phase=paper_passed`

If blocked:

- do not proceed to micro-live
- inspect `blockingReasons`

### 4. Approve Micro-Live

```bash
corepack pnpm canary:release approve-micro-live --approvedBy "$USER" --allowedSymbols BTC/USD
```

This writes a bounded authorization window.

Defaults:

- max symbols: `1`
- max concurrent opens: `1`
- max notional: `$25`
- max equity percent: `0.25`
- approval TTL: `48h`

Expected outcome:

- `phase=micro_live_approved`
- `expiresAt` present

### 5. Start Micro-Live

```bash
corepack pnpm canary:release start-micro-live
```

Expected outcome:

- `phase=micro_live_running`

### 6. Evaluate Micro-Live

```bash
corepack pnpm canary:release evaluate-micro-live
```

Pass criteria:

- micro-live observation window complete
- runtime health checks pass
- no heartbeat / gate / cron / pnl / idempotency threshold violations
- no stale pending orders above threshold

Expected outcome:

- `phase=micro_live_passed`

### 7. Roll Back

```bash
corepack pnpm canary:release rollback --reason "manual_rollback"
```

Use this whenever there is uncertainty.

Expected outcome:

- `phase=rolled_back`
- runtime refuses new live opens
- reduce-only exits remain allowed

## Runtime Hard Block

Live new opens are allowed only when:

- `phase` is `micro_live_running` or `micro_live_passed`
- state file parses cleanly
- checksum matches
- `expiresAt` is still in the future
- symbol is in `allowedSymbols`
- notional and equity limits are within bounds

Everything else is fail-closed.

## Status Files

- `data/runtime/canary_state.json`
- `data/runtime/gates_preflight_report.json`
- `data/runtime/paper_diagnostic_status.latest.json`
- `data/runtime/paper_executor_status.latest.json`
- `data/runtime/release_gate_status.json`
- `data/runtime/gates/gate_checkpoints_index.v1.json`
- `data/event-log/events.jsonl`

## Old Runbooks

Historical rollout and manual-trade runbooks remain as reference only.
They do not authorize live promotion.
