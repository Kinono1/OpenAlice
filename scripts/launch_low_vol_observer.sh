#!/bin/bash
# launch_low_vol_observer.sh
# Daily low-vol strategy observation pipeline.
# Runs via launchd at 02:00 daily.
# Collects OKX data → generates rank report → runs DL inference → records observation.
set -euo pipefail

REPO="/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice"
cd "$REPO"

# Log
log() { echo "[$(date +%Y-%m-%dT%H:%M:%S%z)] $*"; }

log "Starting low-vol observer pipeline"

# Step 1: Collect OKX market data
log "Collecting OKX market data..."
bash scripts/collect_okx_market_data.sh 2>&1 || log "WARNING: OKX collect failed (network may be unavailable)"

# Step 2: Generate daily mainstream rank report
log "Generating daily mainstream rank report..."
/opt/miniconda3/bin/python3 scripts/train/daily_mainstream_rank_report.py 2>&1 || log "WARNING: Rank report failed"

# Step 3: Train DL model if not exists (one-time install)
MODEL_FILE="models/signals/btc_direction_model.joblib"
if [ ! -f "$MODEL_FILE" ]; then
    log "Training DL model (first run)..."
    /opt/miniconda3/bin/python3 scripts/train/train_dl_model.py 2>&1 || log "WARNING: DL model training failed"
fi

# Step 4: Run daily DL inference
log "Running daily DL inference..."
/opt/miniconda3/bin/python3 scripts/train/daily_dl_inference.py 2>&1 || log "WARNING: DL inference failed"

# Step 5: Record observation to ledger
REPORT="data/research/daily_low_vol_rank_report.json"
if [ -f "$REPORT" ]; then
    LONG_LIST=$(python3 -c "
import json
r = json.load(open('$REPORT'))
# Prefer new signals.long, fallback to buy_candidates
longs = r.get('signals', {}).get('long', r.get('buy_candidates', []))
print(','.join(s['symbol'] for s in longs))
" 2>/dev/null)
    SHORT_LIST=$(python3 -c "
import json
r = json.load(open('$REPORT'))
shorts = r.get('signals', {}).get('short', r.get('avoid', []))
print(','.join(s['symbol'] for s in shorts))
" 2>/dev/null)
    VOL_WIN=$(python3 -c "
import json
r = json.load(open('$REPORT'))
ap = r.get('adaptive_params', {})
print(ap.get('vol_window_selected', '?'))
" 2>/dev/null)
    log "Observation: long=[$LONG_LIST] short=[$SHORT_LIST] window=[$VOL_WIN]"
fi

# Step 6: Show DL inference summary
DL_REPORT="data/research/daily_dl_inference_report.json"
if [ -f "$DL_REPORT" ]; then
    DL_SUMMARY=$(python3 -c "
import json
r=json.load(open('$DL_REPORT'))
p=r.get('prediction',{})
d=p.get('predicted_direction','?')
c=p.get('confidence',0)
print(f'DL inference: BTC {d} (confidence={c:.1%})')
" 2>/dev/null || echo "DL inference: unavailable")
    log "$DL_SUMMARY"
fi

log "Low-vol observer pipeline complete"
