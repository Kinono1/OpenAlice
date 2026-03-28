#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DATASET_ROOT="${DATASET_ROOT:-data/market/okx_1m_core7}"
SESSION_NAME="${SESSION_NAME:-okx_core7_full}"
LOG_FILE="${LOG_FILE:-logs/okx_core7_tmux.log}"

printf -- '---tmux---\n'
tmux list-sessions 2>/dev/null | rg "^${SESSION_NAME}:" || true

printf -- '\n---capture---\n'
tmux capture-pane -pt "$SESSION_NAME" -S -40 2>/dev/null || true

printf -- '\n---log-tail---\n'
tail -n 40 "$LOG_FILE" 2>/dev/null || true

printf -- '\n---sizes---\n'
du -sh "$DATASET_ROOT/candles" 2>/dev/null || true

printf -- '\n---coverage---\n'
python3 - <<'PY'
from pathlib import Path

root = Path("data/market/okx_1m_core7/candles/1m")
for market in ("swap", "spot"):
    base = root / market
    print("MARKET", market)
    if not base.exists():
        print("  MISSING")
        continue
    for sym_dir in sorted([p for p in base.iterdir() if p.is_dir()]):
        files = sorted(sym_dir.glob("*"))
        if not files:
            print(" ", sym_dir.name, "EMPTY")
            continue
        print(" ", sym_dir.name, files[0].name, "->", files[-1].name, "count", len(files))
PY

printf -- '\n---validation-files---\n'
find "$DATASET_ROOT/reports/validation" -maxdepth 1 -type f 2>/dev/null | sort || true
