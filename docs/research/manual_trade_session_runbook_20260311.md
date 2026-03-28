# Manual Trade Session Runbook

Date: `2026-03-11`

> Reference only.
> This document is not a release authorization path. Use [docs/operations/canary_release_runbook.md](/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice/docs/operations/canary_release_runbook.md) for canary promotion and micro-live approval.

## Purpose

This runbook defines the exact operator loop for using OpenAlice as a `human-in-the-loop` trading workstation.

It is not a live automation runbook. It is a decision-support runbook.

## Session Start

Before looking at any setup:

1. verify runtime health
   - `GET /api/crypto/account`
   - `GET /api/dev/registry`
   - `GET /api/heartbeat/status`
   - `POST /api/chat` → `OPENAI_OK`
2. confirm no unresolved runtime anomaly
   - no repeated `heartbeat.error`
   - no `pnl.reconciliation.alert`
   - no connector drift

If runtime health is uncertain, stop. Do not trade.

## Required Tool Order

For every trade idea, use tools in this exact order:

1. `expertQuantDecision`
2. `strategyCompare`
3. `strategyGetSignal` only if a single strategy needs inspection
4. `mlEnsemblePredict` only as supporting evidence

## Minimum Go Rule

Only consider a trade if:

- `expertQuantDecision.tradeAllowed = true`
- `expertQuantDecision.action = long`
- ML and strategy direction agree
- news risk is below threshold

If any of these fail, the session action is `skip`, not “dig deeper until something looks tradable”.

## Daily Session Limits

- max attempts: `2`
- max concurrent symbol exposure: `1`
- allowed symbol in current manual mode: `BTC/USD`
- no discretionary shorting

## Session Stop Rule

End the session immediately if:

- two low-quality setups appear in a row
- one actual loss exceeds your session tolerance
- runtime health degrades
- connector or heartbeat reliability becomes uncertain

## Reminder

The point of this mode is to reduce bad trades, not to create more trades.
