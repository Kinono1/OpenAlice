#!/usr/bin/env bash
set -euo pipefail
exec /opt/miniconda3/bin/python3 "$(dirname "$0")/paper_trade_ml.py"
