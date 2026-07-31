#!/bin/bash
# Backfill OKX historical data for the past ~60 days
# OKX API limits: 300 candles per call, funding rate history available
set -euo pipefail

OKX_BASE="https://www.okx.com"
OUTPUT_BASE="/Volumes/shield/cryptoData/openalice-data/market/okx-live"

echo "[backfill] Starting OKX data backfill..."
echo ""

# 1. BTC 1h candles — get 300 bars (~12 days)
echo "[backfill] BTC 1h candles (300 bars)..."
BTC_CANDLES=$(curl -s --max-time 30 "$OKX_BASE/api/v5/market/history-candles?instId=BTC-USDT&bar=1H&limit=300")
MONTH_DIR="$OUTPUT_BASE/candles/$(date +%Y-%m)"
mkdir -p "$MONTH_DIR"
echo "$BTC_CANDLES" > "$MONTH_DIR/btc_1h_backfill.json"
echo "  Done: $(echo "$BTC_CANDLES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{len(d.get(\"data\",[]))} bars')" 2>/dev/null)"

# 2. ETH 1h candles
echo "[backfill] ETH 1h candles (300 bars)..."
ETH_CANDLES=$(curl -s --max-time 30 "$OKX_BASE/api/v5/market/history-candles?instId=ETH-USDT&bar=1H&limit=300")
echo "$ETH_CANDLES" > "$MONTH_DIR/eth_1h_backfill.json"
echo "  Done: $(echo "$ETH_CANDLES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{len(d.get(\"data\",[]))} bars')" 2>/dev/null)"

# 3. BTC funding rate history
echo "[backfill] BTC funding rate history..."
BTC_FUNDING=$(curl -s --max-time 30 "$OKX_BASE/api/v5/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=100")
MONTH_DIR="$OUTPUT_BASE/funding/$(date +%Y-%m)"
mkdir -p "$MONTH_DIR"
echo "$BTC_FUNDING" > "$MONTH_DIR/btc_funding_backfill.json"
echo "  Done: $(echo "$BTC_FUNDING" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{len(d.get(\"data\",[]))} entries')" 2>/dev/null)"

# 4. Current tickers (only current snapshot available)
echo "[backfill] Current tickers..."
TICKERS=$(curl -s --max-time 30 "$OKX_BASE/api/v5/market/tickers?instType=SPOT")
MONTH_DIR="$OUTPUT_BASE/tickers/$(date +%Y-%m)"
mkdir -p "$MONTH_DIR"
echo "$TICKERS" > "$MONTH_DIR/tickers_backfill_$(date +%Y-%m-%d).json"
echo "  Done: $(echo "$TICKERS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{len(d.get(\"data\",[]))} tickers')" 2>/dev/null)"

echo ""
echo "[backfill] Complete. Total OKX data size:"
du -sh "$OUTPUT_BASE"
