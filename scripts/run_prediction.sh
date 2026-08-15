#!/usr/bin/env bash
set -euo pipefail

# crypto_dl_predict — placeholder: real AI-Scientist pipeline TBD
# When implemented, this script should:
#   1. Run AI-Scientist inference for crypto_dl models
#   2. Write sidecar_signal_intake.latest.json with proper envelope
#   3. Write sidecar status file with current-slot metadata
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] crypto_dl_predict: pipeline not yet implemented — writing blocked status"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$REPO_ROOT/data/runtime"

# Write blocked status
cat > "$REPO_ROOT/data/runtime/crypto_dl_sidecar_status.latest.json" <<'JSONEOF'
{
  "schema_version": 1,
  "status": "blocked",
  "ready": false,
  "errorClass": "PIPELINE_NOT_IMPLEMENTED",
  "errorMessage": "crypto_dl predict pipeline not yet implemented — run_prediction.sh is a stub",
  "started_at": "PLACEHOLDER",
  "finished_at": null,
  "slot_id": "",
  "run_id": "",
  "signals_count": 0
}
JSONEOF
exit 0
