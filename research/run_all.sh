#!/usr/bin/env bash
# Run all three research pipelines sequentially.
# Usage: bash run_all.sh [SYMBOL] [START] [END]
#
# Example: bash run_all.sh BTC/USDT 2024-01-01 2025-12-31

set -euo pipefail
cd "$(dirname "$0")"

SYMBOL="${1:-BTC/USDT}"
START="${2:-2024-01-01}"
END="${3:-2025-12-31}"
EXCHANGE="${4:-binance}"

echo "========================================"
echo "OpenAlice Research Pipeline"
echo "Symbol: $SYMBOL  Period: $START → $END"
echo "========================================"

echo ""
echo "[1/3] IC Factor Analysis..."
python3 ic-research/run_ic_analysis.py \
    --symbol "$SYMBOL" --start "$START" --end "$END" --exchange "$EXCHANGE"

echo ""
echo "[2/3] LSTM/PatchTST Training..."
python3 ml-training/train_patchtst.py \
    --symbol "$SYMBOL" --start "$START" --end "$END" --exchange "$EXCHANGE" \
    --architecture lstm --epochs 100 --patience 15 \
    --export-onnx "ml-training/artifacts/lstm_forecast.onnx"

echo ""
echo "[3/3] Meta-Labeling..."
python3 meta-labeling/run_meta_labeling.py \
    --symbol "$SYMBOL" --start "$START" --end "$END" --exchange "$EXCHANGE"

echo ""
echo "========================================"
echo "All pipelines complete."
echo "Results in: cache/ic_results/, cache/meta_labeling_results/, ml-training/artifacts/"
echo "========================================"
