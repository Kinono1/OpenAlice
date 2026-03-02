# OpenAlice V5 Risk-Fix Comparison

## Scope

This report compares the governance chain before and after the risk-fix changes requested in the V5 follow-up plan.

## A. Before vs After (Environment and Preflight)

### Before (unlocked runtime shell)
- `data/runtime/environment_verify_report_unlocked.json`
  - `passed=false`
  - mismatch:
    - expected `python=3.13.x`, actual `3.14.3`
    - expected `node=22.21.x`, actual `25.2.1`
- `data/runtime/gates_preflight_report_unlocked.json`
  - `passed=false`
  - `finalExitCode=2`
  - blocking step: `env:verify`

### After (locked runtime profile)
- `data/runtime/environment_verify_report_locked.json`
  - `passed=true`
- `data/runtime/gates_preflight_report_locked.json`
  - `passed=true`
  - `finalExitCode=0`

## B. Gate Status Snapshot

Source: `data/runtime/gates/gate_checkpoints_index.v1.json`

- `G0`: pass
- `G1`: pass
- `G2`: pass
- `G3`: fail
- `G4`: fail

Interpretation:
- Governance and research-contract gates are green (`G0-G2`).
- Strategy/decision gates fail as expected under current metrics (`G3-G4`), leading to `NO_GO`.

## C. Reason-Code Traceability Map

### Gate checkpoint reasons
- Source file: `data/runtime/gates/G3.checkpoint.json`
  - `HARD_EXPERIMENT_NO_GO`
  - `HARD_MEAN_PBO_THRESHOLD_FAIL`
  - `HARD_MEAN_DSR_PROBABILITY_THRESHOLD_FAIL`
  - `HARD_FDR_THRESHOLD_FAIL`
  - `HARD_RELEASE_GATE_BLOCKED`
- Source file: `data/runtime/gates/G4.checkpoint.json`
  - `HARD_UPSTREAM_GATE_FAILED`

### Decision verdict trace
- Source file: `decision_packet/verdict.json`
  - `hardGateFailureTrace` points to:
    - `gate_checkpoint_G3`
    - `gate_checkpoint_G4`
  - verdict: `NO_GO`

## D. Evidence Chain Completeness Checklist

- `data/runtime/research_contract_verify_report.json` exists and is used as canonical contract report.
- `data/runtime/research_contract_verify_outputs.json` is retained as legacy fallback target.
- `data/runtime/gates/gate_checkpoints_index.v1.json` includes:
  - `contractReportPathCanonical`
  - `contractReportPathLegacy`
  - `contractReportPathUsed`
  - `contractReportFallbackUsed`
- `decision_packet/gates/gate_checkpoints_index.v1.json` passes schema validation.
- `decision_packet/verdict.json` includes checkpoint-level hard-failure traceability.

## E. Command Repro (locked profile)

```bash
PATH=/tmp/openalice-runtime-lock/bin:$PATH pnpm run env:verify
PATH=/tmp/openalice-runtime-lock/bin:$PATH pnpm run freeze:verify
PATH=/tmp/openalice-runtime-lock/bin:$PATH pnpm run gates:preflight
PATH=/tmp/openalice-runtime-lock/bin:$PATH pnpm run research:mvp
PATH=/tmp/openalice-runtime-lock/bin:$PATH pnpm run strategy:mvp
PATH=/tmp/openalice-runtime-lock/bin:$PATH pnpm run gates:checkpoints
PATH=/tmp/openalice-runtime-lock/bin:$PATH pnpm run decision:build
PATH=/tmp/openalice-runtime-lock/bin:$PATH pnpm run decision:validate
```

Expected:
- `strategy:mvp` and `decision:validate` return `2` with `NO_GO`.
- Other steps return `0`.
