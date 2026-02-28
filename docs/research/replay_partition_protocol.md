# Replay Partition Protocol

This document defines the partition-aware V2 replay workflow for OpenAlice.

## Goals

- Compare pooled training with partitioned training under the same V2 protocol.
- Separate directional-improvement evidence (`stage1`) from strict readiness gates (`stage2` and `hard`).
- Produce matrix-level artifacts that are machine-readable and human-readable.

## Entry Point

```bash
bash scripts/run_v2_protocol_replay.sh --run-id my_run
```

Default behavior (since 2026-02-27):

- single-run default gate profile is `stage2`
- matrix defaults no longer include `stage1`; they run `stage2` + `hard`

## Key Parameters

### Replay script (`scripts/run_v2_protocol_replay.sh`)

- `--matrix full|smoke|off`
- `--max-symbols <n>` (for fast sanity runs; `0` means full universe)
- `--symbol-allowlist <csv>` (base symbols like `BTC/USDT` or qualified keys like `BTC/USDT::okx`)
- `--partition-mode none|exchange|exchange_regime`
- `--regime-scheme rule_v1|kmeans_v1`
- `--gate-profile stage1|stage2|hard`
- `--matrix-output-dir <path>`

### Training pipeline (`scripts/wait_clean_and_retrain.py`)

- `--partition-mode none|exchange|exchange_regime`
- `--regime-scheme rule_v1|kmeans_v1`
- `--partition-manifest-out <path>`

Outputs include:

- `clean/partition_manifest.json`
- `clean/summary.json`
- `retrain/summary.json`

### Completion (`scripts/run_openalice_completion.ts`)

- `--gateProfile stage1|stage2|hard`
- `--partitionMode none|exchange|exchange_regime`
- `--regimeScheme rule_v1|kmeans_v1`

Completion output includes:

- `input.experiment` metadata
- `metricsByPartition[]`

## Gate Profiles

### stage1 (directional evidence)

- `minSignificancePassRatio=0.05`
- `maxMeanPbo=0.75`
- `minMeanDsrProbability=0.20`
- `enforceSignificanceHardGate=false`
- `maxScoreWhenHardGateFails=100`

### stage2 (convergence)

- `minSignificancePassRatio=0.20`
- `maxMeanPbo=0.60`
- `minMeanDsrProbability=0.35`
- `enforceSignificanceHardGate=true`
- `maxScoreWhenHardGateFails=70`

### hard (production-style)

- `minSignificancePassRatio=0.60`
- `maxMeanPbo=0.20`
- `minMeanDsrProbability=0.50`
- `enforceSignificanceHardGate=true`
- `maxScoreWhenHardGateFails=55`

## Matrix Outputs

After matrix replay, the root report directory contains:

- `replay_comparison_matrix.md`
- `replay_comparison_matrix.json`
- `matrix_cases.tsv`

Each matrix case directory contains:

- `training/retrain/summary.json`
- `report/completion_replay.json`
- `compare_vs_all_replay/replay_comparison.md`

## Suggested Workflow

1. Run matrix with `stage2` as the baseline convergence gate.
2. Use `stage1` only for directional diagnosis when `stage2` repeatedly fails.
3. Re-check shortlisted candidates under `hard` profile before any readiness claim.

## Fast Sanity Run (End-to-End)

Use this when you need to verify train + completion + compare wiring without running the full universe:

```bash
bash scripts/run_v2_protocol_replay.sh \
  --matrix off \
  --run-id sanity_btc_exchange_regime_stage2 \
  --partition-mode exchange_regime \
  --regime-scheme rule_v1 \
  --gate-profile stage2 \
  --max-symbols 12 \
  --symbol-allowlist "BTC/USDT::binance_um,BTC/USDT::binance_spot,BTC/USDT::okx" \
  --top-symbols 3
```
