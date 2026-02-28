#!/usr/bin/env bash
set -euo pipefail

# Reproduce V2 protocol on current codebase with optional partition matrix.
#
# Usage:
#   bash scripts/run_v2_protocol_replay.sh
#   bash scripts/run_v2_protocol_replay.sh --matrix off --run-id my-run
#
# Optional args:
#   --run-id <id>                  Run identifier; default UTC timestamp
#   --use-conda <true|false>       Use pnpm train:full-pipeline:conda (default true)
#   --output-root <path>           Training output root (single-run mode)
#   --top-symbols <n>              Completion top symbols (single-run mode)
#   --lookback-bars <n>            Completion lookback bars
#   --baseline-root <path>         Baseline training root for comparison report
#   --baseline-completion <path>   Optional explicit baseline completion report
#   --skip-train <true|false>      Skip training stage
#   --skip-completion <true|false> Skip completion stage
#   --skip-compare <true|false>    Skip compare/report stage
#   --max-symbols <n>              Max symbols for training (0 means no limit)
#   --symbol-allowlist <csv>       Comma-separated base or qualified symbols
#   --partition-mode <mode>        none|exchange|exchange_regime (single-run mode)
#   --regime-scheme <scheme>       rule_v1|kmeans_v1 (single-run mode)
#   --gate-profile <profile>       stage1|stage2|hard (single-run mode)
#   --matrix <mode>                full|smoke|off (default full)
#   --matrix-output-dir <path>     Optional matrix output directory

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

timestamp_utc() {
  date -u +"%Y%m%dT%H%M%SZ"
}

RUN_ID="$(timestamp_utc)"
USE_CONDA="true"
OUTPUT_ROOT=""
TOP_SYMBOLS="8"
LOOKBACK_BARS="3000"
BASELINE_ROOT="data/training-data/full-v2"
BASELINE_COMPLETION=""
SKIP_TRAIN="false"
SKIP_COMPLETION="false"
SKIP_COMPARE="false"
MAX_SYMBOLS="0"
SYMBOL_ALLOWLIST=""
PARTITION_MODE="exchange_regime"
REGIME_SCHEME="rule_v1"
GATE_PROFILE="stage2"
MATRIX="full"
MATRIX_OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      RUN_ID="${2:?missing value for --run-id}"
      shift 2
      ;;
    --use-conda)
      USE_CONDA="${2:?missing value for --use-conda}"
      shift 2
      ;;
    --output-root)
      OUTPUT_ROOT="${2:?missing value for --output-root}"
      shift 2
      ;;
    --top-symbols)
      TOP_SYMBOLS="${2:?missing value for --top-symbols}"
      shift 2
      ;;
    --lookback-bars)
      LOOKBACK_BARS="${2:?missing value for --lookback-bars}"
      shift 2
      ;;
    --baseline-root)
      BASELINE_ROOT="${2:?missing value for --baseline-root}"
      shift 2
      ;;
    --baseline-completion)
      BASELINE_COMPLETION="${2:?missing value for --baseline-completion}"
      shift 2
      ;;
    --skip-train)
      SKIP_TRAIN="${2:?missing value for --skip-train}"
      shift 2
      ;;
    --skip-completion)
      SKIP_COMPLETION="${2:?missing value for --skip-completion}"
      shift 2
      ;;
    --skip-compare)
      SKIP_COMPARE="${2:?missing value for --skip-compare}"
      shift 2
      ;;
    --max-symbols)
      MAX_SYMBOLS="${2:?missing value for --max-symbols}"
      shift 2
      ;;
    --symbol-allowlist)
      SYMBOL_ALLOWLIST="${2:?missing value for --symbol-allowlist}"
      shift 2
      ;;
    --partition-mode)
      PARTITION_MODE="${2:?missing value for --partition-mode}"
      shift 2
      ;;
    --regime-scheme)
      REGIME_SCHEME="${2:?missing value for --regime-scheme}"
      shift 2
      ;;
    --gate-profile)
      GATE_PROFILE="${2:?missing value for --gate-profile}"
      shift 2
      ;;
    --matrix)
      MATRIX="${2:?missing value for --matrix}"
      shift 2
      ;;
    --matrix-output-dir)
      MATRIX_OUTPUT_DIR="${2:?missing value for --matrix-output-dir}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "$USE_CONDA" == "true" ]]; then
  TRAIN_CMD=(pnpm train:full-pipeline:conda)
else
  TRAIN_CMD=(pnpm train:full-pipeline)
fi

if [[ -z "$OUTPUT_ROOT" ]]; then
  OUTPUT_ROOT="data/training-data/replay-v2-${RUN_ID}"
fi

REPORT_DIR="logs/research/replay_v2_${RUN_ID}"
mkdir -p "$REPORT_DIR"

if [[ -z "$MATRIX_OUTPUT_DIR" ]]; then
  MATRIX_OUTPUT_DIR="${REPORT_DIR}/matrix"
fi

run_case() {
  local case_id="$1"
  local case_output_root="$2"
  local case_report_dir="$3"
  local case_compare_dir="$4"
  local case_top_symbols="$5"
  local case_partition_mode="$6"
  local case_regime_scheme="$7"
  local case_gate_profile="$8"

  mkdir -p "$case_report_dir"

  echo "[replay:${case_id}] output-root=${case_output_root}"
  echo "[replay:${case_id}] report-dir=${case_report_dir}"

  if [[ "$SKIP_TRAIN" != "true" ]]; then
    echo "[replay:${case_id}] stage=train"
    TRAIN_STAGE_CMD=("${TRAIN_CMD[@]}" -- \
      --wait-downloads false \
      --output-root "${case_output_root}" \
      --min-bars 220 \
      --max-symbols "${MAX_SYMBOLS}" \
      --horizon-bars 1 \
      --train-ratio 0.8 \
      --selection-objective accuracyLift \
      --selection-mode max \
      --labeling-mode next_return_sign \
      --nas-enabled false \
      --include-models xgboost,lightgbm,catboost,randomForest,ridge \
      --seed 42 \
      --partition-mode "${case_partition_mode}" \
      --regime-scheme "${case_regime_scheme}" \
      --partition-manifest-out "${case_output_root}/clean/partition_manifest.json")
    if [[ -n "${SYMBOL_ALLOWLIST}" ]]; then
      TRAIN_STAGE_CMD+=(--symbol-allowlist "${SYMBOL_ALLOWLIST}")
    fi
    "${TRAIN_STAGE_CMD[@]}"
  fi

  local completion_path="${case_report_dir}/completion_replay.json"
  if [[ "$SKIP_COMPLETION" != "true" ]]; then
    echo "[replay:${case_id}] stage=completion"
    pnpm validation:completion -- \
      --trainingRoot "${case_output_root}" \
      --objectiveMetric accuracyLift \
      --objectiveMode max \
      --topSymbols "${case_top_symbols}" \
      --lookbackBars "${LOOKBACK_BARS}" \
      --runUnitTests true \
      --gateProfile "${case_gate_profile}" \
      --partitionMode "${case_partition_mode}" \
      --regimeScheme "${case_regime_scheme}" \
      --output "${completion_path}"
  fi

  if [[ "$SKIP_COMPARE" != "true" ]]; then
    mkdir -p "$case_compare_dir"
    echo "[replay:${case_id}] stage=compare"
    COMPARE_CMD=(
      python
      scripts/generate_replay_comparison.py
      --baseline-root "${BASELINE_ROOT}"
      --replay-root "${case_output_root}"
      --logs-dir "logs/research"
      --output-dir "${case_compare_dir}"
      --report-template "docs/research/templates/v2-replay-report-template.md"
    )
    if [[ -n "$BASELINE_COMPLETION" ]]; then
      COMPARE_CMD+=(--baseline-completion "$BASELINE_COMPLETION")
    fi
    if [[ -f "$completion_path" ]]; then
      COMPARE_CMD+=(--replay-completion "$completion_path")
    fi
    "${COMPARE_CMD[@]}"
  fi

  echo "[replay:${case_id}] training summary: ${case_output_root}/retrain/summary.json"
  if [[ "$SKIP_COMPLETION" == "true" ]]; then
    echo "[replay:${case_id}] completion: skipped"
  else
    echo "[replay:${case_id}] completion: ${completion_path}"
  fi
}

echo "[replay] run-id: ${RUN_ID}"
echo "[replay] matrix: ${MATRIX}"
echo "[replay] matrix-output-dir: ${MATRIX_OUTPUT_DIR}"

if [[ "$MATRIX" == "off" ]]; then
  run_case \
    "single" \
    "${OUTPUT_ROOT}" \
    "${REPORT_DIR}" \
    "${REPORT_DIR}" \
    "${TOP_SYMBOLS}" \
    "${PARTITION_MODE}" \
    "${REGIME_SCHEME}" \
    "${GATE_PROFILE}"

  echo "[replay] done"
  echo "[replay] comparison report: ${REPORT_DIR}/replay_comparison.md"
  exit 0
fi

mkdir -p "$MATRIX_OUTPUT_DIR"

case "$MATRIX" in
  full)
    PARTITIONS=(none exchange exchange_regime)
    REGIME_SCHEMES=(rule_v1 kmeans_v1)
    GATE_PROFILES=(stage2 hard)
    TOP_SYMBOLS_SET=(8 16)
    ;;
  smoke)
    PARTITIONS=(none exchange_regime)
    REGIME_SCHEMES=(rule_v1)
    GATE_PROFILES=(stage2)
    TOP_SYMBOLS_SET=(8)
    ;;
  *)
    echo "Unsupported --matrix value: ${MATRIX}. expected full|smoke|off" >&2
    exit 1
    ;;
esac

CASE_MANIFEST="${REPORT_DIR}/matrix_cases.tsv"
printf "case_id\tpartition_mode\tregime_scheme\tgate_profile\ttop_symbols\ttraining_root\treport_dir\n" > "$CASE_MANIFEST"

for partition_mode in "${PARTITIONS[@]}"; do
  for regime_scheme in "${REGIME_SCHEMES[@]}"; do
    for gate_profile in "${GATE_PROFILES[@]}"; do
      for top_symbols in "${TOP_SYMBOLS_SET[@]}"; do
        case_id="p_${partition_mode}__r_${regime_scheme}__g_${gate_profile}__t_${top_symbols}"
        case_root="${MATRIX_OUTPUT_DIR}/${case_id}"
        case_output_root="${case_root}/training"
        case_report_dir="${case_root}/report"
        case_compare_dir="${case_root}/compare_vs_all_replay"

        run_case \
          "${case_id}" \
          "${case_output_root}" \
          "${case_report_dir}" \
          "${case_compare_dir}" \
          "${top_symbols}" \
          "${partition_mode}" \
          "${regime_scheme}" \
          "${gate_profile}"

        printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
          "$case_id" "$partition_mode" "$regime_scheme" "$gate_profile" "$top_symbols" "$case_output_root" "$case_report_dir" \
          >> "$CASE_MANIFEST"
      done
    done
  done
done

if [[ "$SKIP_COMPARE" != "true" ]]; then
  echo "[replay] stage=matrix-compare"
  python scripts/generate_replay_comparison.py \
    --baseline-root "${BASELINE_ROOT}" \
    --matrix-root "${MATRIX_OUTPUT_DIR}" \
    --output-dir "${REPORT_DIR}" \
    --report-template "docs/research/templates/v2-replay-report-template.md"
fi

echo "[replay] done"
echo "[replay] matrix manifest: ${CASE_MANIFEST}"
if [[ "$SKIP_COMPARE" != "true" ]]; then
  echo "[replay] matrix report: ${REPORT_DIR}/replay_comparison_matrix.md"
fi
