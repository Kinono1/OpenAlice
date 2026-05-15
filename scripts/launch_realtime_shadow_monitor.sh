#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_ROOT/scripts/openalice_env.sh"

cd "$REPO_ROOT"

# IMPORTANT: /opt/homebrew/bin/node (v25.2.1) must come BEFORE Cellar node (v24.10.0)
# because corepack uses #!/usr/bin/env node and picks the first node in PATH.
# Cellar node 24.10.0 has a broken simdjson library dependency.
REPO_BIN="$REPO_ROOT/node_modules/.bin"
export PATH="/opt/homebrew/bin:$REPO_BIN:/opt/homebrew/Cellar/node/24.10.0/bin:/usr/local/bin:/usr/bin:/bin"

# Resolve skip flags
SKIP_DATA="${OPENALICE_PAPER_MONITOR_SKIP_DATA:-false}"
SKIP_PAPER="${OPENALICE_PAPER_MONITOR_SKIP_PAPER:-false}"
SKIP_OPTIMIZE="${OPENALICE_PAPER_MONITOR_SKIP_OPTIMIZE:-false}"
SKIP_VALIDATION="${OPENALICE_PAPER_MONITOR_SKIP_VALIDATION:-false}"
SKIP_SECOND="${OPENALICE_SKIP_SECOND_LEVEL:-true}"
REQUIRE_PROMO_V2="${OPENALICE_PAPER_MONITOR_REQUIRE_PROMOTION_V2:-false}"
PAPER_DATA_MODE="${OPENALICE_PAPER_MONITOR_PAPER_DATA_MODE:-auto}"

if [[ "${OPENALICE_CRON_DIAGNOSTIC_MODE:-false}" != "true" ]]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] launch_realtime_shadow_monitor.sh requires OPENALICE_CRON_DIAGNOSTIC_MODE=true for ungated paper execution" | tee -a "$REPO_ROOT/logs/realtime_shadow_monitor.cycle.err.log"
  exit 0
fi

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
logerr() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >&2; }

log "starting paper-shadow monitor (60s loop)"
log "  skipData=$SKIP_DATA skipPaper=$SKIP_PAPER skipOptimize=$SKIP_OPTIMIZE skipValidation=$SKIP_VALIDATION"

NODE="/opt/homebrew/bin/node"
TSX_CLI="$REPO_ROOT/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs"

while true; do
  # Direct volume breakout (bypasses shadow loop dry-run issue)
  "$NODE" "$TSX_CLI" scripts/paper_trade_volume_breakout.ts \
    --dryRun false --allowUngatedPaperLane true \
    2>>"$REPO_ROOT/logs/realtime_shadow_monitor.cycle.err.log"
  "$NODE" "$TSX_CLI" scripts/paper_trade_low_vol.ts \
    --dryRun false \
    2>>"$REPO_ROOT/logs/realtime_shadow_monitor.cycle.err.log"

  "$NODE" "$TSX_CLI" scripts/run_realtime_shadow_monitor.ts \
    --once \
    --intervalMs 300000 \
    --skipData "$SKIP_DATA" \
    --skipPaper "$SKIP_PAPER" \
    --skipOptimize "$SKIP_OPTIMIZE" \
    --skipValidation "$SKIP_VALIDATION" \
    --skipSecondLevel "$SKIP_SECOND" \
    --requirePromotionV2 "$REQUIRE_PROMO_V2" \
    2>>"$REPO_ROOT/logs/realtime_shadow_monitor.cycle.err.log"

  log "cycle complete, sleeping 60s"
  sleep 30
done
