# Operator Playbook V1

Last updated: `2026-03-13`

## Purpose

Define the minimum human operating rules for the paper-first automatic system.

## Anomaly Severity

- `P0`: duplicate orders, restart divergence, corrupted registry, data contract breach
- `P1`: connector unhealthy, exchange timeout spike, execution-quality breaker active
- `P2`: warning-only concentration or intervention-rate drift

## Pause / Resume Rules

- `P0` → immediate manual pause required
- `P1` → automatic pause of new opens, manual review required
- `P2` → continue only with warning and same-day review
- resume requires:
  - current anomaly cleared
  - `paperGate.finalAllowPaperTrading=true`
  - active registry checksum matches approved snapshot

## Champion Change Rules

- only one active champion at a time
- champion activation requires:
  - valid registry payload
  - checksum verification
  - matching `signal_code_commit_hash`
  - matching `veto_policy_version`
- failed rollout reverts to previous approved champion or to `no active champion`

## Mandatory Daily Checks

- runtime health
- release gate freshness
- paper gate status
- data quality status
- execution quality breaker status
- intervention rate drift
