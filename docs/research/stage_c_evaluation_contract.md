# Stage-C Evaluation Contract

Date: `2026-03-11`

## Purpose

This contract defines the minimum artifact and run conventions for `Stage-C` strategy rebuild experiments.

The goal is not to replace the existing validation chain. The goal is to wrap the current strategy validation path in a stable, repeatable interface so later candidate sets can be compared against the frozen baseline without inventing a second evaluation stack.

## Canonical Flow

`stage_c_candidate_generator_v2.py`  
→ candidate set JSON (`strategy_candidates.v1` compatible)  
→ `stage_c_eval_harness.py`  
→ existing `run_strategy_mvp_validation.ts`  
→ summary artifact with deltas vs frozen baseline

## Inputs

- Candidate set JSON must remain compatible with `strategy_candidates.v1`
- Baseline comparison source defaults to:
  - `decision_packet/experiment_verdict.v2.json`
- Validation runner defaults to:
  - `scripts/run_strategy_mvp_validation.ts`

## Run ID

- Format: `stagec-YYYYMMDDTHHMMSSZ`
- If a caller supplies `--run-id`, that value is used as-is.
- Every run must write into a single run-scoped directory under:
  - `data/research/strategy/analysis/stage_c/archive/<runId>/`

## Output Artifacts

The harness produces one latest summary file and one archived run directory.

Latest summary:

- `data/research/strategy/analysis/stage_c/latest_eval_harness.v1.json`

Archived run directory:

- `data/research/strategy/analysis/stage_c/archive/<runId>/`

Archived run contents:

- `strategy_validation_runs.json`
- `experiment_verdict.v2.json`
- `release_gate_status.json`
- `stage_c_eval_harness.v1.json`

## Summary Schema

`stage_c_eval_harness.v1.json` contains:

- `schemaVersion`
- `generatedAt`
- `runId`
- `inputs`
  - `candidates`
  - `baselineVerdict`
- `artifacts`
  - `validationRuns`
  - `experimentVerdict`
  - `releaseGateStatus`
- `aggregateMetrics`
  - `meanPbo`
  - `meanDsrProbability`
  - `fdrQ`
  - `result`
  - `reasonCodes`
- `baselineMetrics`
  - `meanPbo`
  - `meanDsrProbability`
  - `fdrQ`
  - `result`
- `delta`
  - `meanPbo`
  - `meanDsrProbability`
  - `fdrQ`
- `improvement`
  - `meanPboImproved`
  - `meanDsrProbabilityImproved`
  - `fdrQImproved`

## Acceptance Rules

- Harness output must be reproducible from the same candidate JSON and baseline verdict.
- When run against the frozen baseline candidate set, the harness should inherit the baseline FDR configuration from `experiment_verdict.v2.json` by default so the output metrics match the current `decision_packet` metrics within floating-point tolerance.
- Candidate generation output must contain at least `15` candidates across `3` explicit signal families.
- Any new Stage-C artifact intended for comparison must be archived under a run-specific directory.

## Non-Goals

- This contract does not change `decision_packet` semantics.
- This contract does not imply `G3` pass.
- This contract does not define live rollout policy.
