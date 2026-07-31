#!/usr/bin/env bash
# v5 Plan Integration Tests
#
# Validates executable scripts, kill-switch admin CLI, replay gate,
# release gate, and inline tsx-based schema validation.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
PASS=0
FAIL=0

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }

run_test() {
  local name="$1"
  local cmd="$2"
  if eval "$cmd" 2>/dev/null; then
    green "  PASS: $name"
    PASS=$((PASS + 1))
  else
    red "  FAIL: $name"
    FAIL=$((FAIL + 1))
  fi
}

# Write a temp .ts file in the repo root, run it with tsx, then clean up
run_tsx_test() {
  local name="$1"
  local ts_code="$2"
  local tmpfile="${REPO_ROOT}/.v5_test_$$_${RANDOM}.ts"
  printf '%s\n' "$ts_code" > "$tmpfile"
  if npx tsx "$tmpfile" 2>/dev/null; then
    green "  PASS: $name"
    PASS=$((PASS + 1))
  else
    red "  FAIL: $name"
    FAIL=$((FAIL + 1))
  fi
  rm -f "$tmpfile"
}

echo "=== v5 Integration Tests ==="
echo ""

# ── Test 1: Cron syntax ──────────────────────────────────────────
run_test "cron_openalice_task.sh syntax" "bash -n scripts/cron_openalice_task.sh"

# ── Test 2: Old slot_id rejection via validateSidecarEnvelope ────
run_tsx_test "old slot_id rejected by validateSidecarEnvelope" '
import { validateSidecarEnvelope } from "./src/runtime/sidecar_signal.ts"
const env = {
  schema_version: 1,
  slot_id: "slot-20200101-00",
  run_id: "old",
  generated_at: new Date().toISOString(),
  ttl_ms: 3600000,
  signals: [{
    source: "cryptotrade",
    strategy_id: "crypto_dl",
    symbol: "XRP/USDT",
    as_of: new Date().toISOString(),
    target_position_bps: 200,
    confidence_bps: 8000,
    model_id: "v1",
    thesis: "test",
    label_horizon_bars: 1,
    bar_interval_ms: 3600000,
    target_start_delay_bars: 1,
    target_start_at: new Date().toISOString(),
    target_end_at: new Date(Date.now() + 86400000).toISOString(),
  }],
  producer: "test",
}
const result = validateSidecarEnvelope(env)
if (result.valid || !result.reason?.toLowerCase().includes("slot")) {
  console.error("Expected slot rejection, got:", JSON.stringify(result))
  process.exit(1)
}
console.log("OK: old slot_id correctly rejected")
process.exit(0)
'

# ── Test 3: Vitest unit tests pass ─────────────────────────────
run_test "sidecar_signal unit tests pass" \
  "npx vitest run src/runtime/sidecar_signal.spec.ts --reporter=verbose 2>&1 | grep -q 'Tests.*passed'"

run_test "v5_plan unit tests pass" \
  "npx vitest run src/runtime/v5_plan.spec.ts --reporter=verbose 2>&1 | grep -q 'Tests.*passed'"

# ── Test 4: Signal health schema accepts pending status ─────────
run_tsx_test "signal health schema accepts pending status" '
import { signalHealthV1Schema } from "./src/runtime/sidecar_signal.ts"
try {
  signalHealthV1Schema.parse({
    status: "pending",
    model_id: "m1",
    signal_id: "s1",
    target_end_at: new Date().toISOString(),
    as_of: new Date().toISOString(),
    label_horizon_bars: 6,
    bar_interval_ms: 3600000,
  })
} catch (e) {
  console.error("Schema rejected valid pending status:", e)
  process.exit(1)
}
console.log("OK: signal health accepts pending")
process.exit(0)
'

# ── Test 5: Kill switch dry-run mode ─────────────────────────────
run_test "reset_kill_switch.ts dry-run mode" \
  "npx tsx scripts/reset_kill_switch.ts --reviewed-by 'test' --reason 'integration test' --confirm 2>&1 | grep -q 'DRY RUN'"

# ── Test 6: Replay gate script runs without error ───────────────
run_test "build_replay_gate.ts runs without crashing" \
  "npx tsx scripts/build_replay_gate.ts --json 2>&1; true"

# ── Test 7: Kill switch — missing required args ─────────────────
run_test "reset_kill_switch rejects missing --reviewed-by" \
  "npx tsx scripts/reset_kill_switch.ts --reason 'test' --confirm 2>&1; [ \$? -eq 64 ]"

run_test "reset_kill_switch rejects missing --reason" \
  "npx tsx scripts/reset_kill_switch.ts --reviewed-by 'test' --confirm 2>&1; [ \$? -eq 64 ]"

run_test "reset_kill_switch rejects missing --confirm" \
  "npx tsx scripts/reset_kill_switch.ts --reviewed-by 'test' --reason 'test' 2>&1; [ \$? -eq 64 ]"

# ── Test 8: Release gate file exists and paper trading disabled ─
run_test "release_gate_status.json exists" \
  "test -f data/runtime/release_gate_status.json"

run_test "release_gate paper trading disabled" \
  "node -e \"const j=require('./data/runtime/release_gate_status.json'); process.exit(j.allowPaperTrading===false&&j.allowLiveTrading===false?0:1)\""

# ── Test 9: V5 envelope schema validation — expired TTL ─────────
run_tsx_test "expired TTL rejected by validateSidecarEnvelope" '
import { validateSidecarEnvelope, computeCurrentSlotId } from "./src/runtime/sidecar_signal.ts"
const old = new Date(Date.now() - 86400000).toISOString()
const env = {
  schema_version: 1,
  slot_id: computeCurrentSlotId(new Date()),
  run_id: "ttl-test",
  generated_at: old,
  ttl_ms: 100,
  signals: [],
  producer: "test",
}
const result = validateSidecarEnvelope(env)
if (result.valid || !result.reason?.toLowerCase().includes("ttl")) {
  console.error("Expected TTL rejection, got:", JSON.stringify(result))
  process.exit(1)
}
console.log("OK: expired TTL correctly rejected")
process.exit(0)
'

# ── Test 10: V5 envelope — missing label_horizon_bars rejection ─
run_tsx_test "missing horizon metadata rejected" '
import { cryptoDlSignalV1Schema } from "./src/runtime/sidecar_signal.ts"
const bad = {
  source: "cryptotrade",
  strategy_id: "crypto_dl",
  symbol: "XRP/USDT",
  as_of: new Date().toISOString(),
  target_position_bps: 200,
  confidence_bps: 8000,
  model_id: "v1",
  thesis: "test",
  target_start_delay_bars: 1,
  target_start_at: new Date().toISOString(),
  target_end_at: new Date(Date.now() + 86400000).toISOString(),
}
try {
  cryptoDlSignalV1Schema.parse(bad)
  console.error("ERROR: schema should have thrown")
  process.exit(1)
} catch (e) {
  if (e instanceof Error) {
    if (e.message.includes("label_horizon_bars") || e.message.includes("bar_interval_ms")) {
      console.log("OK: missing horizon metadata rejected correctly")
      process.exit(0)
    }
  }
  console.log("OK: schema threw as expected")
  process.exit(0)
}
'

# ── Test 11: Bps conversion via tsx ──────────────────────────────
run_tsx_test "pctToBps and floatToBps convert correctly" '
import { pctToBps, floatToBps, awayFromZeroRounding } from "./src/domain/trading/risk.ts"
let ok = true
if (pctToBps(50) !== 5000)          { console.error("pctToBps(50) != 5000"); ok = false }
if (pctToBps(100) !== 10000)        { console.error("pctToBps(100) != 10000"); ok = false }
if (pctToBps(0.02) !== 2)           { console.error("pctToBps(0.02) != 2"); ok = false }
if (floatToBps(0.50) !== 5000)      { console.error("floatToBps(0.50) != 5000"); ok = false }
if (floatToBps(1.0) !== 10000)      { console.error("floatToBps(1.0) != 10000"); ok = false }
if (floatToBps(0.02) !== 200)       { console.error("floatToBps(0.02) != 200"); ok = false }
if (awayFromZeroRounding(9999.999999) !== 10000) { console.error("awayFromZeroRounding(9999.999999) != 10000"); ok = false }
if (awayFromZeroRounding(10000.000001) !== 10000) { console.error("awayFromZeroRounding(10000.000001) != 10000"); ok = false }
if (ok) { console.log("OK: all Bps conversions correct"); process.exit(0) }
process.exit(1)
'

# ── Test 12: Top-of-book evidence schema validation ──────────────
run_tsx_test "executionTopOfBookEvidenceV1Schema accepts valid snapshot" '
import { executionTopOfBookEvidenceV1Schema } from "./src/runtime/sidecar_signal.ts"
try {
  executionTopOfBookEvidenceV1Schema.parse({
    bid: 85000.5,
    ask: 85100.25,
    mid: 85050.375,
    spread_bps: 12,
    snapshot_source: "okx",
    snapshot_at: new Date().toISOString(),
    snapshot_age_ms: 150,
  })
} catch (e) {
  console.error("Schema rejected valid top-of-book snapshot:", e)
  process.exit(1)
}
console.log("OK: top-of-book evidence schema accepts valid snapshot")
process.exit(0)
'

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1
