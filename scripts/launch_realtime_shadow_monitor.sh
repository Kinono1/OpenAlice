#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_ROOT/scripts/openalice_env.sh"

cd "$REPO_ROOT"
exec corepack pnpm paper:monitor -- \
  --intervalMs "${OPENALICE_PAPER_MONITOR_INTERVAL_MS:-300000}" \
  --skipData "${OPENALICE_PAPER_MONITOR_SKIP_DATA:-true}" \
  --skipPaper "${OPENALICE_PAPER_MONITOR_SKIP_PAPER:-true}" \
  --skipOptimize "${OPENALICE_PAPER_MONITOR_SKIP_OPTIMIZE:-true}" \
  --skipValidation "${OPENALICE_PAPER_MONITOR_SKIP_VALIDATION:-true}" \
  --skipSecondLevel "${OPENALICE_SKIP_SECOND_LEVEL:-true}" \
  --requirePromotionV2 "${OPENALICE_PAPER_MONITOR_REQUIRE_PROMOTION_V2:-true}"
