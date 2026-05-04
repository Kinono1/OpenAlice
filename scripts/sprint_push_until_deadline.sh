#!/usr/bin/env bash
set -euo pipefail

# Sprint push runner:
# Keep running governance + queue drain loops until local deadline.
#
# Default deadline: tomorrow 17:00 (local machine time).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOCK_DIR="${LOCK_DIR:-$ROOT_DIR/.locks}"
LOCK_FILE="${LOCK_FILE:-$LOCK_DIR/sprint_push_until_deadline.lock}"
mkdir -p "$LOCK_DIR"

acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local existing_pid=""
    existing_pid="$(cat "$LOCK_FILE" 2>/dev/null || true)"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
      echo "sprint_push_until_deadline: another instance is running (pid=$existing_pid), skip."
      return 1
    fi
    rm -f "$LOCK_FILE"
  fi
  echo "$$" > "$LOCK_FILE"
  return 0
}

release_lock() {
  if [[ -f "$LOCK_FILE" ]] && [[ "$(cat "$LOCK_FILE" 2>/dev/null || true)" == "$$" ]]; then
    rm -f "$LOCK_FILE"
  fi
}

if ! acquire_lock; then
  exit 0
fi
trap release_lock EXIT INT TERM

if [[ -x "$ROOT_DIR/.venv/bin/python" ]]; then
  PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"
else
  echo "sprint_push_until_deadline: python3 not found" >&2
  exit 1
fi

DEFAULT_DEADLINE="$(
  "$PYTHON_BIN" - <<'PY'
import datetime as dt
now = dt.datetime.now()
target = (now + dt.timedelta(days=1)).replace(hour=17, minute=0, second=0, microsecond=0)
print(target.strftime("%Y-%m-%d %H:%M:%S"))
PY
)"

DEADLINE_LOCAL="${DEADLINE_LOCAL:-$DEFAULT_DEADLINE}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-900}"
MAX_CYCLES="${MAX_CYCLES:-0}"  # 0 means unlimited until deadline.

RUN_REVIEW_GATE="${RUN_REVIEW_GATE:-0}"
RUN_DATA_PULL="${RUN_DATA_PULL:-1}"
RUN_EXTERNAL_BENCHMARK="${RUN_EXTERNAL_BENCHMARK:-1}"
RUN_ADMISSION="${RUN_ADMISSION:-1}"
RUN_FAILURE_BREAKDOWN="${RUN_FAILURE_BREAKDOWN:-1}"
RUN_OPTIMIZE_LOOP="${RUN_OPTIMIZE_LOOP:-1}"
RUN_HEALTH_CHECK="${RUN_HEALTH_CHECK:-1}"
CONTINUE_ON_ERROR="${CONTINUE_ON_ERROR:-1}"

OPTIMIZE_DIRECTION_MODE="${OPTIMIZE_DIRECTION_MODE:-adaptive}"
OPTIMIZE_TOP_K="${OPTIMIZE_TOP_K:-2}"
OPTIMIZE_MAX_RUNS_PER_CARD="${OPTIMIZE_MAX_RUNS_PER_CARD:-4}"
OPTIMIZE_SKIP_WATCH="${OPTIMIZE_SKIP_WATCH:-1}"
OPTIMIZE_DRAIN_QUEUE_FIRST="${OPTIMIZE_DRAIN_QUEUE_FIRST:-1}"
OPTIMIZE_EXECUTE="${OPTIMIZE_EXECUTE:-1}"
OPTIMIZE_CONTINUE_ON_ERROR="${OPTIMIZE_CONTINUE_ON_ERROR:-1}"
OPTIMIZE_ALLOW_REPEAT_CARDS="${OPTIMIZE_ALLOW_REPEAT_CARDS:-1}"

QUEUE_DRAIN_MAX_ITEMS="${QUEUE_DRAIN_MAX_ITEMS:-2}"
QUEUE_DRAIN_CONTINUE_ON_ERROR="${QUEUE_DRAIN_CONTINUE_ON_ERROR:-1}"

LOG_DIR="${LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$LOG_DIR"
RUN_ID="$(date +%Y%m%dT%H%M%S)"
LOG_FILE="${LOG_FILE:-$LOG_DIR/sprint_push_until_deadline_${RUN_ID}.log}"

STATE_DIR="${STATE_DIR:-$ROOT_DIR/data/research/strategy-watch/sprint}"
mkdir -p "$STATE_DIR"
LATEST_STATE_FILE="${LATEST_STATE_FILE:-$STATE_DIR/latest_sprint_status.json}"
HISTORY_FILE="${HISTORY_FILE:-$STATE_DIR/sprint_history.ndjson}"

deadline_epoch="$(
  "$PYTHON_BIN" - "$DEADLINE_LOCAL" <<'PY'
import datetime as dt
import sys
raw = sys.argv[1].strip()
fmts = [
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M",
]
parsed = None
for fmt in fmts:
    try:
        parsed = dt.datetime.strptime(raw, fmt)
        break
    except ValueError:
        continue
if parsed is None:
    # Try fromisoformat as a fallback.
    try:
        parsed = dt.datetime.fromisoformat(raw)
    except Exception:
        print("invalid_deadline")
        raise SystemExit(2)
print(int(parsed.timestamp()))
PY
)"

if [[ "$deadline_epoch" == "invalid_deadline" ]]; then
  echo "sprint_push_until_deadline: invalid DEADLINE_LOCAL='$DEADLINE_LOCAL'" >&2
  exit 2
fi

now_epoch="$(date +%s)"
if (( now_epoch >= deadline_epoch )); then
  echo "sprint_push_until_deadline: deadline already passed ($DEADLINE_LOCAL)." >&2
  exit 0
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] sprint start" | tee -a "$LOG_FILE"
echo "deadline_local=$DEADLINE_LOCAL interval_seconds=$INTERVAL_SECONDS max_cycles=$MAX_CYCLES" | tee -a "$LOG_FILE"
echo "log_file=$LOG_FILE" | tee -a "$LOG_FILE"

cycle=0
while true; do
  now_epoch="$(date +%s)"
  if (( now_epoch >= deadline_epoch )); then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] deadline reached, stop." | tee -a "$LOG_FILE"
    break
  fi
  if (( MAX_CYCLES > 0 && cycle >= MAX_CYCLES )); then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] max cycles reached ($MAX_CYCLES), stop." | tee -a "$LOG_FILE"
    break
  fi
  cycle=$((cycle + 1))
  cycle_started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[$cycle_started] cycle=$cycle begin" | tee -a "$LOG_FILE"

  direction_json="$("$PYTHON_BIN" scripts/pick_optimize_direction.py --mode adaptive --dry-run || echo '{}')"
  parse_lines="$(
    DIRECTION_JSON="$direction_json" "$PYTHON_BIN" - <<'PY'
import json
import os

raw = os.environ.get("DIRECTION_JSON", "{}")
try:
    data = json.loads(raw or "{}")
except Exception:
    data = {}
print(str(data.get("direction", "regime")))
print(str(data.get("decision_reason", "")))
PY
  )"
  preferred_direction="$(printf '%s\n' "$parse_lines" | sed -n '1p')"
  decision_reason="$(printf '%s\n' "$parse_lines" | sed -n '2p')"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] cycle=$cycle adaptive_direction=$preferred_direction reason=${decision_reason:-n/a}" | tee -a "$LOG_FILE"

  governance_rc=0
  if env \
    RUN_REVIEW_GATE="$RUN_REVIEW_GATE" \
    RUN_DATA_PULL="$RUN_DATA_PULL" \
    RUN_EXTERNAL_BENCHMARK="$RUN_EXTERNAL_BENCHMARK" \
    RUN_ADMISSION="$RUN_ADMISSION" \
    RUN_FAILURE_BREAKDOWN="$RUN_FAILURE_BREAKDOWN" \
    RUN_OPTIMIZE_LOOP="$RUN_OPTIMIZE_LOOP" \
    RUN_HEALTH_CHECK="$RUN_HEALTH_CHECK" \
    CONTINUE_ON_ERROR="$CONTINUE_ON_ERROR" \
    OPTIMIZE_DIRECTION_MODE="$OPTIMIZE_DIRECTION_MODE" \
    OPTIMIZE_TOP_K="$OPTIMIZE_TOP_K" \
    OPTIMIZE_MAX_RUNS_PER_CARD="$OPTIMIZE_MAX_RUNS_PER_CARD" \
    OPTIMIZE_SKIP_WATCH="$OPTIMIZE_SKIP_WATCH" \
    OPTIMIZE_DRAIN_QUEUE_FIRST="$OPTIMIZE_DRAIN_QUEUE_FIRST" \
    OPTIMIZE_EXECUTE="$OPTIMIZE_EXECUTE" \
    OPTIMIZE_CONTINUE_ON_ERROR="$OPTIMIZE_CONTINUE_ON_ERROR" \
    OPTIMIZE_ALLOW_REPEAT_CARDS="$OPTIMIZE_ALLOW_REPEAT_CARDS" \
    bash scripts/daily_strategy_governance.sh >>"$LOG_FILE" 2>&1; then
    governance_rc=0
  else
    governance_rc=$?
  fi

  drain_rc=0
  DRAIN_CMD=(
    "$PYTHON_BIN" scripts/drain_strategy_queue.py
    --max-items "$QUEUE_DRAIN_MAX_ITEMS"
    --prefer-direction "$preferred_direction"
  )
  if [[ "$QUEUE_DRAIN_CONTINUE_ON_ERROR" == "1" ]]; then
    DRAIN_CMD+=(--continue-on-error)
  fi
  if "${DRAIN_CMD[@]}" >>"$LOG_FILE" 2>&1; then
    drain_rc=0
  else
    drain_rc=$?
  fi

  queue_len="$(
    "$PYTHON_BIN" - <<'PY'
import json
from pathlib import Path
path = Path("data/research/strategy-watch/execution/pending_queue.json")
if not path.exists():
    print(0)
else:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        print(len(payload) if isinstance(payload, list) else 0)
    except Exception:
        print(-1)
PY
  )"

  cycle_ended="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  status_json="$(
    "$PYTHON_BIN" - "$cycle" "$cycle_started" "$cycle_ended" "$preferred_direction" "$decision_reason" "$governance_rc" "$drain_rc" "$queue_len" "$DEADLINE_LOCAL" <<'PY'
import datetime as dt
import json
import sys

cycle = int(sys.argv[1])
cycle_started = sys.argv[2]
cycle_ended = sys.argv[3]
direction = sys.argv[4]
reason = sys.argv[5]
governance_rc = int(sys.argv[6])
drain_rc = int(sys.argv[7])
queue_len = int(sys.argv[8])
deadline_local = sys.argv[9]

payload = {
    "cycle": cycle,
    "cycle_started_at": cycle_started,
    "cycle_ended_at": cycle_ended,
    "adaptive_direction": direction,
    "decision_reason": reason,
    "governance_rc": governance_rc,
    "drain_rc": drain_rc,
    "queue_len": queue_len,
    "deadline_local": deadline_local,
    "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
}
print(json.dumps(payload, ensure_ascii=False))
PY
  )"

  printf '%s\n' "$status_json" >> "$HISTORY_FILE"
  printf '%s\n' "$status_json" > "$LATEST_STATE_FILE"
  echo "[$cycle_ended] cycle=$cycle done governance_rc=$governance_rc drain_rc=$drain_rc queue_len=$queue_len" | tee -a "$LOG_FILE"

  now_epoch="$(date +%s)"
  if (( now_epoch >= deadline_epoch )); then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] deadline reached after cycle $cycle, stop." | tee -a "$LOG_FILE"
    break
  fi
  if (( MAX_CYCLES > 0 && cycle >= MAX_CYCLES )); then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] max cycles reached ($MAX_CYCLES), stop." | tee -a "$LOG_FILE"
    break
  fi
  sleep "$INTERVAL_SECONDS"
done

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] sprint finished" | tee -a "$LOG_FILE"
