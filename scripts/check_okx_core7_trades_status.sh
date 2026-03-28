#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SESSION_NAME="${SESSION_NAME:-okx_core7_trades}"
DATASET_ROOT="${DATASET_ROOT:-data/market/okx_core7_trades}"
LOG_FILE="${LOG_FILE:-logs/okx_core7_trades.log}"

printf -- '---tmux---\n'
tmux list-sessions 2>/dev/null | rg "^${SESSION_NAME}:" || true

printf -- '\n---capture---\n'
tmux capture-pane -pt "$SESSION_NAME" -S -40 2>/dev/null || true

printf -- '\n---log-tail---\n'
tail -n 40 "$LOG_FILE" 2>/dev/null || true

printf -- '\n---summary---\n'
python3 - <<'PY'
import json
from pathlib import Path
p = Path("data/market/okx_core7_trades/reports/trades_summary.v1.json")
if p.exists():
    obj = json.loads(p.read_text())
    print(obj.get("totals", {}))
else:
    print("MISSING")
PY
