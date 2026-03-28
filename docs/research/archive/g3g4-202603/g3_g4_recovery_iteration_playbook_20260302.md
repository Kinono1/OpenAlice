# G3/G4 Recovery Iteration Playbook (2026-03-02)

## Goal
- Keep governance thresholds unchanged.
- Improve strategy candidate quality until `G3=pass` and `G4=pass`.
- Preserve every run with immutable archive snapshots.

## Candidate Matrix
- Source file: `docs/research/strategy_candidates.v1.json`
- Candidate count: `12`
- Families:
  - trend: `T1/T2/T3/T4`
  - meanReversion: `M1/M2/M3`
  - breakout: `B1/B2/B3`
  - ensemble: `E1/E2`

## Run Commands
- Full iteration (includes baseline/env/freeze/preflight):
```bash
pnpm run strategy:g3g4:iterate
```

- Fast iteration (strategy + gates + decision only):
```bash
pnpm run strategy:g3g4:iterate-fast
```

- Standalone breakdown report:
```bash
pnpm run strategy:g3g4:breakdown
```

## Outputs
- Iteration report:
  - latest: `data/research/strategy/runs/latest_strategy_g3g4_iteration.{json,md}`
  - archive: `data/research/strategy/runs/archive/<run_id>/strategy_g3g4_iteration.{json,md}`
- Failure breakdown:
  - latest: `data/research/strategy/analysis/g3g4/latest_strategy_g3g4_breakdown.{json,md}`
  - archive: `data/research/strategy/analysis/g3g4/archive/<run_id>/strategy_g3g4_breakdown.{json,md}`
- Core decision artifacts are copied into iteration archive using original relative paths.

## Hard Acceptance
- `G3.checkpoint.json` status must be `pass`.
- `G4.checkpoint.json` status must be `pass`.
- `experiment_verdict.v2.json` must be `result=GO`.
- `decision:validate` must not rely on threshold relaxation or manual override.

## Stop Condition
- If three consecutive iterations still return `NO_GO`, keep strict `no-decision` and open a new phase for feature/model family expansion.
