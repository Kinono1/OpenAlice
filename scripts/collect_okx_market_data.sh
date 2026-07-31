#!/usr/bin/env bash
# Collects OKX market data to /Volumes/shield/cryptoData/openalice-data/market/okx-live/
# Run daily: 0 1 * * * /path/to/scripts/collect_okx_market_data.sh
set -euo pipefail

OKX_BASE="https://www.okx.com"
OUTPUT_BASE="/Volumes/shield/cryptoData/openalice-data/market/okx-live"
YEAR_MONTH=$(date +%Y-%m)
TODAY=$(date +%Y-%m-%d)
DRY_RUN=false

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
  esac
done

# Helper: ensure directory exists
ensure_dir() {
  local dir="$1"
  if [ "$DRY_RUN" = true ]; then
    echo "[dry-run] mkdir -p $dir" >&2
  else
    mkdir -p "$dir"
  fi
}

# Helper: fetch URL to file with retry
fetch_url() {
  local url="$1"
  local outfile="$2"
  local label="$3"

  if [ "$DRY_RUN" = true ]; then
    echo "[dry-run] curl -s \"$url\" > \"$outfile\"" >&2
    return 0
  fi

  # Attempt fetch
  curl -s --max-time 30 "$url" > "$outfile" || true

  # Check for empty or error response
  if [ ! -s "$outfile" ] || head -c 200 "$outfile" | grep -q '"code" *: *"[1-9]' ; then
    echo "[$label] empty or error response, retrying after 5s..." >&2
    sleep 5
    curl -s --max-time 30 "$url" > "$outfile" || true
  fi

  # Final check
  if [ ! -s "$outfile" ]; then
    echo "[$label] FATAL: empty response after retry" >&2
    return 1
  fi
  if head -c 200 "$outfile" | grep -q '"code" *: *"[1-9]' ; then
    local err_code
    err_code=$(head -c 500 "$outfile" | grep -o '"code" *: *"[^"]*"' | head -1)
    echo "[$label] ERROR: OKX API returned $err_code" >&2
    return 1
  fi

  local size
  size=$(wc -c < "$outfile")
  echo "[$label] OK $(echo "scale=1; $size / 1024" | bc)KB" >&2
}

echo "[okx-collector] Starting OKX market data collection for $TODAY" >&2

# -------------------------------------------------
# 1. Top 20 spot tickers
# -------------------------------------------------
TICKERS_DIR="$OUTPUT_BASE/tickers/$YEAR_MONTH"
TICKERS_FILE="$TICKERS_DIR/tickers_$TODAY.json"
ensure_dir "$TICKERS_DIR"
fetch_url "$OKX_BASE/api/v5/market/tickers?instType=SPOT" "$TICKERS_FILE" "tickers"
sleep 0.1

# -------------------------------------------------
# 2. BTC 1h candles (last 300)
# -------------------------------------------------
CANDLES_DIR="$OUTPUT_BASE/candles/$YEAR_MONTH"
BTC_CANDLES_FILE="$CANDLES_DIR/btc_1h_$TODAY.json"
ensure_dir "$CANDLES_DIR"
fetch_url "$OKX_BASE/api/v5/market/candles?instId=BTC-USDT&bar=1H" "$BTC_CANDLES_FILE" "btc_candles"
sleep 0.1

# -------------------------------------------------
# 3. ETH 1h candles (last 300)
# -------------------------------------------------
ETH_CANDLES_FILE="$CANDLES_DIR/eth_1h_$TODAY.json"
fetch_url "$OKX_BASE/api/v5/market/candles?instId=ETH-USDT&bar=1H" "$ETH_CANDLES_FILE" "eth_candles"
sleep 0.1

# -------------------------------------------------
# 4. BTC funding rate
# -------------------------------------------------
FUNDING_DIR="$OUTPUT_BASE/funding/$YEAR_MONTH"
FUNDING_FILE="$FUNDING_DIR/btc_funding_$TODAY.json"
ensure_dir "$FUNDING_DIR"
fetch_url "$OKX_BASE/api/v5/public/funding-rate?instId=BTC-USDT-SWAP" "$FUNDING_FILE" "funding"
sleep 0.1

# -------------------------------------------------
# 5. BTC open interest
# -------------------------------------------------
OI_DIR="$OUTPUT_BASE/oi/$YEAR_MONTH"
OI_FILE="$OI_DIR/btc_oi_$TODAY.json"
ensure_dir "$OI_DIR"
fetch_url "$OKX_BASE/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP" "$OI_FILE" "oi"
sleep 0.1

# -------------------------------------------------
# 6. BTC/ETH trades (逐笔成交, last 500)
# -------------------------------------------------
TRADES_DIR="$OUTPUT_BASE/trades/$YEAR_MONTH"
ensure_dir "$TRADES_DIR"
echo "[okx-collector] Fetching BTC trades..." >&2
fetch_url "$OKX_BASE/api/v5/market/history-trades?instId=BTC-USDT&limit=500" \
  "$TRADES_DIR/btc_trades_$TODAY.json" "trades"
sleep 0.1
echo "[okx-collector] Fetching ETH trades..." >&2
fetch_url "$OKX_BASE/api/v5/market/history-trades?instId=ETH-USDT&limit=500" \
  "$TRADES_DIR/eth_trades_$TODAY.json" "trades"
sleep 0.1
echo "[okx-collector] Trades collection enabled." >&2

# -------------------------------------------------
# 7. BTC/ETH order book depth (L2, 5档)
# -------------------------------------------------
BOOKS_DIR="$OUTPUT_BASE/books/$YEAR_MONTH"
ensure_dir "$BOOKS_DIR"
echo "[okx-collector] Fetching BTC books..." >&2
fetch_url "$OKX_BASE/api/v5/market/books?instId=BTC-USDT&sz=5" \
  "$BOOKS_DIR/btc_books_$TODAY.json" "books"
sleep 0.1
echo "[okx-collector] Fetching ETH books..." >&2
fetch_url "$OKX_BASE/api/v5/market/books?instId=ETH-USDT&sz=5" \
  "$BOOKS_DIR/eth_books_$TODAY.json" "books"
sleep 0.1

# -------------------------------------------------
# 8. Liquidation orders (合约清算)
# -------------------------------------------------
LIQ_DIR="$OUTPUT_BASE/liquidations/$YEAR_MONTH"
ensure_dir "$LIQ_DIR"
echo "[okx-collector] Fetching liquidation orders..." >&2
fetch_url "$OKX_BASE/api/v5/public/liquidation-orders?instType=SWAP&state=unfilled&limit=100" \
  "$LIQ_DIR/liquidations_$TODAY.json" "liquidations"
sleep 0.1

echo "[okx-collector] Done." >&2
