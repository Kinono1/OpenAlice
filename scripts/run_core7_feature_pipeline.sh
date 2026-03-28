#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OKX_INPUT_ROOT="${OKX_INPUT_ROOT:-data/market/okx_1m_core7}"
BINANCE_INPUT_ROOT="${BINANCE_INPUT_ROOT:-data/market/binance_1m_core7}"
OKX_NORM_ROOT="${OKX_NORM_ROOT:-data/market/okx_1m_core7_norm}"
BINANCE_NORM_ROOT="${BINANCE_NORM_ROOT:-data/market/binance_1m_core7_norm}"
FEATURE_ROOT="${FEATURE_ROOT:-data/market/core7_feature_base_1m}"
TRAIN_ROOT="${TRAIN_ROOT:-data/market/core7_models}"
TRAIN_LABEL="${TRAIN_LABEL:-label_dir_fwd_5m}"
TRAIN_TARGET="${TRAIN_TARGET:-BTC-USDT}"
DRY_RUN="${DRY_RUN:-0}"
PYTHON_BIN="${PYTHON_BIN:-/opt/miniconda3/bin/python}"

run_step() {
  local name="$1"
  shift
  echo "=== ${name} ==="
  echo "$*"
  if [[ "$DRY_RUN" == "1" ]]; then
    return 0
  fi
  "$@"
}

mkdir -p "$TRAIN_ROOT"

run_step "normalize_okx" \
  "$PYTHON_BIN" scripts/normalize_okx_core7_1m.py \
    --dataset-root "$OKX_INPUT_ROOT" \
    --output-root "$OKX_NORM_ROOT"

run_step "normalize_binance" \
  "$PYTHON_BIN" scripts/normalize_binance_core7_1m.py \
    --input-root "$BINANCE_INPUT_ROOT" \
    --output-root "$BINANCE_NORM_ROOT"

run_step "build_feature_base" \
  "$PYTHON_BIN" scripts/build_core7_feature_base.py \
    --okx-root "$OKX_NORM_ROOT" \
    --binance-root "$BINANCE_NORM_ROOT" \
    --output-root "$FEATURE_ROOT"

TRAIN_INPUT="$FEATURE_ROOT/okx_inst_id=${TRAIN_TARGET}/data.csv.zst"
TRAIN_OUTPUT="$TRAIN_ROOT/${TRAIN_TARGET//\//_}.${TRAIN_LABEL}.summary.json"

run_step "train_baseline" \
  "$PYTHON_BIN" scripts/train_core7_baseline.py \
    --input "$TRAIN_INPUT" \
    --label-col "$TRAIN_LABEL" \
    --output "$TRAIN_OUTPUT"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "dry-run complete"
else
  echo "pipeline complete"
  echo "train_summary=$TRAIN_OUTPUT"
fi
