#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SESSION_NAME="${SESSION_NAME:-okx_core7_trades_batches}"
DATASET_ROOT="${DATASET_ROOT:-data/market/okx_core7_trades}"
LOG_FILE="${LOG_FILE:-logs/okx_core7_trades_batches.log}"

printf -- '---tmux---\n'
tmux list-sessions 2>/dev/null | rg "^${SESSION_NAME}:" || true

printf -- '\n---capture---\n'
tmux capture-pane -pt "$SESSION_NAME" -S -40 2>/dev/null || true

printf -- '\n---log-tail---\n'
tail -n 60 "$LOG_FILE" 2>/dev/null || true

printf -- '\n---batch-summaries---\n'
DATASET_ROOT="$DATASET_ROOT" python3 - <<'PY'
import json
import os
from pathlib import Path
dataset_root = Path(os.environ["DATASET_ROOT"])
reports = sorted((dataset_root / "reports").glob("batch*.summary.v1.json"))
if not reports:
    print("MISSING")
else:
    for path in reports:
        obj = json.loads(path.read_text())
        print(path.name, obj.get("totals", {}))
PY

printf -- '\n---batch-state---\n'
DATASET_ROOT="$DATASET_ROOT" python3 - <<'PY'
import json
import os
from pathlib import Path

dataset_root = Path(os.environ["DATASET_ROOT"])
states = sorted((dataset_root / "state" / "batches").glob("batch*.state.v1.json"))
if not states:
    print("MISSING")
else:
    for path in states:
        obj = json.loads(path.read_text())
        items = obj.get("items", {})
        completed = sum(1 for row in items.values() if row.get("completed"))
        print(path.name, {"items": len(items), "completed": completed, "updatedAt": obj.get("updatedAt")})
        for key, row in sorted(items.items()):
            print(" ", key, {"completed": row.get("completed"), "oldestTs": row.get("oldestTs"), "after": row.get("after"), "updatedAt": row.get("updatedAt"), "error": row.get("error", "")})
PY
