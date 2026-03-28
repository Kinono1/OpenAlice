#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if command -v pnpm >/dev/null 2>&1; then
  PNPM_BIN="$(command -v pnpm)"
elif [[ -x "$HOME/.local/share/pnpm/pnpm" ]]; then
  PNPM_BIN="$HOME/.local/share/pnpm/pnpm"
elif [[ -x "$HOME/Library/pnpm/pnpm" ]]; then
  PNPM_BIN="$HOME/Library/pnpm/pnpm"
elif [[ -x "$HOME/.volta/bin/pnpm" ]]; then
  PNPM_BIN="$HOME/.volta/bin/pnpm"
elif compgen -G "$HOME/.nvm/versions/node/*/bin/pnpm" >/dev/null; then
  PNPM_BIN="$(printf '%s\n' "$HOME"/.nvm/versions/node/*/bin/pnpm | sort -V | tail -n 1)"
else
  echo "run_okx_candles_swarm: pnpm not found in PATH." >&2
  exit 1
fi

DATASET_ROOT="${DATASET_ROOT:-data/market/okx_historical}"
AGENTS="${AGENTS:-6}"
WORKERS_PER_AGENT="${WORKERS_PER_AGENT:-1}"
TIMEFRAMES="${TIMEFRAMES:-1h,15m,5m}"
MAX_RETRIES="${MAX_RETRIES:-8}"
SLEEP_MS="${SLEEP_MS:-150}"
APPEND_MODE="${APPEND_MODE:-true}"
START_DATE="${START_DATE:-}"
END_DATE="${END_DATE:-}"
DRY_RUN="${DRY_RUN:-0}"
MAX_SYMBOLS="${MAX_SYMBOLS:-}"
SYMBOLS_FILE="${SYMBOLS_FILE:-}"
RATE_LIMIT_STRATEGY="${RATE_LIMIT_STRATEGY:-alert_and_rerun}"
LOG_DIR="${LOG_DIR:-$ROOT_DIR/logs}"
LOAD_ENV="${LOAD_ENV:-1}"

if [[ "$LOAD_ENV" == "1" ]] && [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PROXY_URL="${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-${ALL_PROXY:-${all_proxy:-}}}}}}"
if [[ -n "$PROXY_URL" ]] && [[ -z "${NODE_USE_ENV_PROXY:-}" ]]; then
  export NODE_USE_ENV_PROXY=1
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
SWARM_DIR="$DATASET_ROOT/reports/swarm"
SHARDS_DIR="$SWARM_DIR/shards"
MANIFEST_TSV="$SWARM_DIR/swarm_manifest_${RUN_ID}.tsv"
PIDS_FILE="$SWARM_DIR/swarm_pids_${RUN_ID}.json"
LATEST_PIDS="$SWARM_DIR/swarm_pids.latest.json"

mkdir -p "$SWARM_DIR" "$SHARDS_DIR" "$DATASET_ROOT/state" "$DATASET_ROOT/reports" "$LOG_DIR"
: > "$MANIFEST_TSV"

log() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[$ts] $*"
}

log "Swarm config:"
log "  DATASET_ROOT=$DATASET_ROOT"
log "  AGENTS=$AGENTS"
log "  TIMEFRAMES=$TIMEFRAMES"
log "  WORKERS_PER_AGENT=$WORKERS_PER_AGENT"
log "  MAX_RETRIES=$MAX_RETRIES SLEEP_MS=$SLEEP_MS"
log "  APPEND_MODE=$APPEND_MODE"
log "  START_DATE=${START_DATE:-<default>} END_DATE=${END_DATE:-<default>}"
log "  DRY_RUN=$DRY_RUN MAX_SYMBOLS=${MAX_SYMBOLS:-<none>}"
log "  SYMBOLS_FILE=${SYMBOLS_FILE:-<auto from completion truth>}"
log "  RATE_LIMIT_STRATEGY=$RATE_LIMIT_STRATEGY"
log "  NODE_USE_ENV_PROXY=${NODE_USE_ENV_PROXY:-0}"
log "  PNPM_BIN=$PNPM_BIN"

if [[ -z "$SYMBOLS_FILE" ]]; then
  BUILD_CMD=(python3 scripts/build_okx_completion_truth.py --dataset-root "$DATASET_ROOT" --output-dir "$SWARM_DIR")
  log "CMD: ${BUILD_CMD[*]}"
  "${BUILD_CMD[@]}"
  PARTITION_CMD=(
    python3 scripts/partition_okx_symbols_weighted.py
    --dataset-root "$DATASET_ROOT"
    --completion-truth "$SWARM_DIR/completion_truth.v1.json"
    --output-dir "$SWARM_DIR"
    --agents "$AGENTS"
  )
else
  PARTITION_CMD=(
    python3 scripts/partition_okx_symbols_weighted.py
    --dataset-root "$DATASET_ROOT"
    --symbols-file "$SYMBOLS_FILE"
    --output-dir "$SWARM_DIR"
    --agents "$AGENTS"
  )
fi

if [[ -n "$MAX_SYMBOLS" ]]; then
  PARTITION_CMD+=(--max-symbols "$MAX_SYMBOLS")
fi

log "CMD: ${PARTITION_CMD[*]}"
"${PARTITION_CMD[@]}"

launched=0
for i in $(seq 1 "$AGENTS"); do
  shard_id="$(printf "%02d" "$i")"
  shard_file="$SHARDS_DIR/symbols_shard_${shard_id}.txt"
  if [[ ! -f "$shard_file" ]]; then
    continue
  fi
  symbols_count="$(grep -cve '^[[:space:]]*$' "$shard_file" || true)"
  if [[ "${symbols_count:-0}" -eq 0 ]]; then
    continue
  fi
  symbols_csv="$(tr '\n' ',' < "$shard_file" | sed 's/,$//')"
  state_path="$DATASET_ROOT/state/candles.agent${shard_id}.state.v1.json"
  summary_path="$DATASET_ROOT/reports/candles_summary.agent${shard_id}.v1.json"
  report_dir="$DATASET_ROOT/reports/agent${shard_id}"
  agent_log="$LOG_DIR/okx_candles_agent${shard_id}_${RUN_ID}.log"

  CMD=(
    "$PNPM_BIN" tsx scripts/okx_download_candles_historical.ts
    --datasetRoot "$DATASET_ROOT"
    --symbols "$symbols_csv"
    --timeframes "$TIMEFRAMES"
    --workers "$WORKERS_PER_AGENT"
    --append "$APPEND_MODE"
    --maxRetries "$MAX_RETRIES"
    --sleepMs "$SLEEP_MS"
    --statePath "$state_path"
    --summaryPath "$summary_path"
    --reportDir "$report_dir"
  )
  if [[ -n "$START_DATE" ]]; then
    CMD+=(--start "$START_DATE")
  fi
  if [[ -n "$END_DATE" ]]; then
    CMD+=(--end "$END_DATE")
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN agent${shard_id}: ${CMD[*]}"
    continue
  fi

  log "START agent${shard_id}: symbols=$symbols_count log=$agent_log"
  nohup "${CMD[@]}" >"$agent_log" 2>&1 &
  pid="$!"
  launched=$((launched + 1))
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "agent${shard_id}" "$pid" "$shard_file" "$agent_log" "$state_path" "$summary_path" "$report_dir" "$symbols_count" \
    >> "$MANIFEST_TSV"
done

if [[ "$DRY_RUN" == "1" ]]; then
  log "Dry run complete. No process launched."
  exit 0
fi

if [[ "$launched" -eq 0 ]]; then
  log "No non-empty shard found, nothing launched."
  exit 1
fi

python3 - "$MANIFEST_TSV" "$PIDS_FILE" "$LATEST_PIDS" "$RUN_ID" "$DATASET_ROOT" "$AGENTS" "$RATE_LIMIT_STRATEGY" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

manifest = Path(sys.argv[1])
pids_file = Path(sys.argv[2])
latest_file = Path(sys.argv[3])
run_id = sys.argv[4]
dataset_root = sys.argv[5]
agents_requested = int(sys.argv[6])
rate_limit_strategy = sys.argv[7]

entries = []
for line in manifest.read_text(encoding="utf-8").splitlines():
    parts = line.split("\t")
    if len(parts) != 8:
        continue
    entries.append(
        {
            "agentId": parts[0],
            "pid": int(parts[1]),
            "shardFile": parts[2],
            "logFile": parts[3],
            "statePath": parts[4],
            "summaryPath": parts[5],
            "reportDir": parts[6],
            "symbolsCount": int(parts[7]),
        }
    )

payload = {
    "schemaVersion": "okx_swarm_pids.v1",
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "runId": run_id,
    "datasetRoot": dataset_root,
    "agentsRequested": agents_requested,
    "rateLimitStrategy": rate_limit_strategy,
    "entries": entries,
}
pids_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
latest_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"wrote pids manifest: {pids_file}")
print(f"updated latest manifest: {latest_file}")
PY

log "Launched agents: $launched"
log "PIDS_FILE=$PIDS_FILE"
log "Monitor command:"
log "  python3 scripts/monitor_okx_swarm.py --pids-file \"$PIDS_FILE\" --watch true"

