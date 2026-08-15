#!/usr/bin/env bash
# BTC real-time tracker - triggers when BTC moves > threshold
set -euo pipefail
ROOT="/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice"
CSV="$ROOT/data/market/live_5m/BTC_USDT_USDT_5m.csv"

# Get last 3 closes
PRICES=$(tail -4 "$CSV" | cut -d, -f5 | head -3)
CURRENT=$(echo "$PRICES" | tail -1)
PREV=$(echo "$PRICES" | head -1)

if [ -z "$CURRENT" ] || [ -z "$PREV" ]; then exit 0; fi

# Calculate change
CHANGE=$(python3 -c "print(abs(($CURRENT - $PREV) / $PREV * 100))" 2>/dev/null || echo "0")
THRESHOLD=0.15

if (( $(echo "$CHANGE > $THRESHOLD" | bc -l 2>/dev/null || echo 0) )); then
    DIR=$($ROOT/opt/homebrew/bin/python3 -c "print('UP' if $CURRENT > $PREV else 'DOWN')" 2>/dev/null)
    echo "BTC ${DIR}: \$$(printf '%.2f' $PREV) -> \$$(printf '%.2f' $CURRENT) (${CHANGE}%)"
fi
