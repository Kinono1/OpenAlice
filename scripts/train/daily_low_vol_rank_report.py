#!/usr/bin/env python3
"""
Daily Low-Vol Rank Report

Reads OKX live tickers (if available) and Binance historical daily klines
to compute realized_vol_21d for each symbol, ranks by volatility, and
outputs a daily report.

Observation ONLY — no orders, no signals, no trade instructions.

Usage:
    cd /Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice
    /opt/miniconda3/bin/python3 scripts/train/daily_low_vol_rank_report.py
    cat data/research/daily_low_vol_rank_report.json
"""

import json
import os
import sys
import zipfile
from datetime import datetime, timezone, timedelta, date
from typing import Optional

import numpy as np

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
OKX_TICKER_DIR = '/Volumes/shield/cryptoData/openalice-data/market/okx-live/tickers'
BINANCE_BASE = '/Volumes/shield/cryptoData/openalice-data/market/binance-public'
KLINES_DIR = f'{BINANCE_BASE}/spot-all-usdt-klines-1d/spot'
OUTPUT_PATH = 'data/research/daily_low_vol_rank_report.json'

# Exclude leveraged / derivative tokens and stablecoin pairs
LEVERAGED_PATTERNS = ('UPUSDT', 'DOWNUSDT', 'BULLUSDT', 'BEARUSDT')
STABLECOIN_SYMBOLS = frozenset([
    'USDCUSDT', 'USDTUSDT', 'DAIUSDT', 'TUSDUSDT', 'FDUSDUSDT',
    'BUSDUSDT', 'EURUSDT', 'GBPUSDT', 'AUDUSDT', 'PAXUSDT',
])

TODAY = date.today()


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def parse_ts_to_date(ts_str):
    """Adaptive timestamp: 13 digits = ms, 16 digits = μs."""
    ts = int(ts_str)
    if len(ts_str) >= 16:
        return datetime.fromtimestamp(ts / 1_000_000, tz=timezone.utc).strftime('%Y-%m-%d')
    else:
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime('%Y-%m-%d')


def load_okx_tickers(target_date: date) -> Optional[dict[str, float]]:
    """Load OKX tickers from JSON file.

    Expected path:
        /Volumes/shield/cryptoData/openalice-data/market/okx-live/tickers/
            {YYYY-MM}/tickers_{YYYY-MM-DD}.json

    Format: {"data": [{"instId": "BTC-USDT", "last": "50000", ...}]}
    Returns {normalized_symbol: last_price} or None if unavailable.
    """
    ym = target_date.strftime('%Y-%m')
    ds = target_date.strftime('%Y-%m-%d')
    fp = os.path.join(OKX_TICKER_DIR, ym, f'tickers_{ds}.json')
    if not os.path.isfile(fp):
        return None
    try:
        with open(fp) as f:
            raw = json.load(f)
    except Exception:
        return None

    out: dict[str, float] = {}
    for item in raw.get('data', []):
        inst_id = (item.get('instId') or '')
        last_str = item.get('last')
        if not inst_id or not last_str:
            continue
        # Normalize: OKX uses "BTC-USDT" -> "BTCUSDT"
        sym = inst_id.replace('-', '')
        try:
            out[sym] = float(last_str)
        except (ValueError, TypeError):
            continue
    return out if out else None


def okx_symbol_filter(symbol: str, exclude_leveraged: bool = True) -> bool:
    """Check if an OKX symbol is valid for analysis."""
    if exclude_leveraged and any(symbol.endswith(p) for p in LEVERAGED_PATTERNS):
        return False
    if symbol in STABLECOIN_SYMBOLS:
        return False
    return True


def discover_binance_symbols(max_symbols: int = 100) -> list[str]:
    """Return top Binance USDT spot symbols by available monthly ZIP count.

    Filters out leveraged tokens (UP/DOWN/BULL/BEAR) and stablecoins.
    """
    results: list[tuple[int, str]] = []
    for d in os.listdir(KLINES_DIR):
        if any(d.endswith(p) for p in LEVERAGED_PATTERNS):
            continue
        if d in STABLECOIN_SYMBOLS:
            continue
        kp = os.path.join(KLINES_DIR, d, '1d')
        if not os.path.isdir(kp):
            continue
        files = sorted(f for f in os.listdir(kp) if f.endswith('.zip'))
        if not files:
            continue
        results.append((len(files), d))
    results.sort(reverse=True)
    return [s for _, s in results[:max_symbols]]


def load_binance_klines(symbol: str) -> dict[str, float]:
    """Load daily klines for a symbol from recent monthly ZIP files.

    Binance CSV columns (pipe-delimited):
        open_time(us), open, high, low, close, volume, close_time,
        quote_asset_volume, trades, taker_buy_vol, taker_buy_quote, ignore

    Returns {date_str: close_price}.
    """
    kp = os.path.join(KLINES_DIR, symbol, '1d')
    if not os.path.isdir(kp):
        return {}
    closes: dict[str, float] = {}
    files = sorted(f for f in os.listdir(kp) if f.endswith('.zip'))
    # Load the most recent 4 monthly ZIPs (typically ~120 days)
    for fname in files[-4:]:
        fpath = os.path.join(kp, fname)
        try:
            with zipfile.ZipFile(fpath) as z:
                names = z.namelist()
                if not names:
                    continue
                text = z.read(names[0]).decode('utf-8', errors='replace')
                for line in text.strip().split('\n'):
                    cols = line.split(',')
                    if len(cols) < 5:
                        continue
                    try:
                        ts_us = int(cols[0])      # microseconds
                        close = float(cols[4])     # close price
                        dt = datetime.fromtimestamp(ts_us / 1_000_000, tz=timezone.utc)
                        closes[dt.strftime('%Y-%m-%d')] = close
                    except (ValueError, IndexError):
                        continue
        except Exception:
            continue
    return closes


# ---------------------------------------------------------------------------
# Volatility computation
# ---------------------------------------------------------------------------


def compute_realized_vol(
    closes: dict[str, float],
    window: int = 21,
) -> Optional[float]:
    """Compute realized vol = sample std of daily returns over *window* days.

    Requires at least *window* + 1 price points.
    Returns None if insufficient or invalid data.
    """
    if len(closes) < window + 1:
        return None
    dates = sorted(closes.keys())
    recent = dates[-(window + 1):]

    returns: list[float] = []
    for i in range(1, len(recent)):
        p, c = closes[recent[i - 1]], closes[recent[i]]
        if p > 0:
            returns.append((c - p) / p)

    if len(returns) < max(2, window):
        return None

    vol = float(np.std(returns, ddof=1))
    return vol if (not np.isnan(vol) and vol > 0) else None


# ---------------------------------------------------------------------------
# Report helpers
# ---------------------------------------------------------------------------


def _write_report(report: dict, out_path: str) -> None:
    """Write report JSON to disk."""
    os.makedirs(os.path.dirname(out_path) or '.', exist_ok=True)
    with open(out_path, 'w') as f:
        json.dump(report, f, indent=2)


def _find_latest_common_date(closes_map: dict[str, dict[str, float]]) -> Optional[str]:
    """Find the latest date that appears in any symbol's close data."""
    latest: Optional[str] = None
    for closes in closes_map.values():
        if not closes:
            continue
        d = max(closes.keys())
        if latest is None or d > latest:
            latest = d
    return latest


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    print('Daily Low-Vol Rank Report Generator')
    print(f'Run date: {TODAY.isoformat()}')
    print('=' * 50)

    # ------------------------------------------------------------------
    # Step 1: Try OKX live tickers (today, yesterday, day-before)
    # ------------------------------------------------------------------
    okx_tickers: Optional[dict[str, float]] = None
    live_data_missing = False

    for days_ago in range(5):
        d = TODAY - timedelta(days=days_ago)
        tickers = load_okx_tickers(d)
        if tickers:
            okx_tickers = tickers
            print(f'OKX live data loaded: {len(tickers)} tickers from {d}')
            break

    if not okx_tickers:
        live_data_missing = True
        print('OKX live tickers unavailable -- falling back to Binance historical data')

    # ------------------------------------------------------------------
    # Step 2: Determine the symbol universe
    # ------------------------------------------------------------------
    if okx_tickers:
        # Use OKX symbols, filtered for leveraged/stablecoin
        all_symbols = sorted(
            s for s in okx_tickers
            if okx_symbol_filter(s, exclude_leveraged=True)
        )
        print(f'Universe: {len(all_symbols)} filtered OKX symbols')
    else:
        all_symbols = discover_binance_symbols(max_symbols=100)
        if not all_symbols:
            all_symbols = discover_binance_symbols(max_symbols=200)
        print(f'Universe: {len(all_symbols)} Binance symbols (top by data availability)')

    if not all_symbols:
        report: dict = {
            'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'date': TODAY.isoformat(),
            'status': 'data_missing',
            'message': 'No symbols found in any data source',
            'buy_candidates': [],
            'avoid': [],
            'btc_vol_percentile': None,
            'n_symbols_total': 0,
            'n_symbols_with_data': 0,
        }
        _write_report(report, OUTPUT_PATH)
        print(f'\nERROR: No symbols available from any source')
        print(f'Output: {OUTPUT_PATH}')
        return

    # ------------------------------------------------------------------
    # Step 3: Load Binance klines for each symbol
    # ------------------------------------------------------------------
    print('Loading Binance daily klines...')
    all_closes: dict[str, dict[str, float]] = {}
    loaded = 0
    for sym in all_symbols:
        closes = load_binance_klines(sym)
        if closes:
            all_closes[sym] = closes
            loaded += 1
            if loaded <= 5 or loaded % 25 == 0:
                print(f'  {loaded}/{len(all_symbols)} loaded...', end='\r')

    print(f'\n  Symbols with historical data: {loaded}/{len(all_symbols)}')

    if not all_closes:
        report = {
            'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'date': TODAY.isoformat(),
            'status': 'data_missing',
            'message': 'No Binance historical data available',
            'buy_candidates': [],
            'avoid': [],
            'btc_vol_percentile': None,
            'n_symbols_total': len(all_symbols),
            'n_symbols_with_data': 0,
        }
        _write_report(report, OUTPUT_PATH)
        print(f'\nERROR: No historical data available')
        print(f'Output: {OUTPUT_PATH}')
        return

    # Determine report date = most recent data date across all symbols
    report_date_str = _find_latest_common_date(all_closes) or TODAY.isoformat()
    if live_data_missing:
        print(f'Report data date: {report_date_str} (Binance latest)')
    else:
        print(f'Report data date: {report_date_str}')

    # ------------------------------------------------------------------
    # Step 4: Compute realized_vol_21d
    # ------------------------------------------------------------------
    print('Computing realized_vol_21d...')
    vol_data: dict[str, float] = {}
    latest_prices: dict[str, float] = {}

    for sym, closes in all_closes.items():
        vol = compute_realized_vol(closes, window=21)
        if vol is not None:
            vol_data[sym] = vol
            # Latest price: prefer OKX ticker, else Binance most recent close
            if okx_tickers and sym in okx_tickers:
                latest_prices[sym] = okx_tickers[sym]
            else:
                sorted_dates = sorted(closes.keys())
                latest_prices[sym] = closes[sorted_dates[-1]]

    print(f'  Symbols with valid vol data: {len(vol_data)}')

    if len(vol_data) < 3:
        report = {
            'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'date': report_date_str,
            'status': 'data_missing',
            'message': f'Insufficient symbols with vol data ({len(vol_data)})',
            'buy_candidates': [],
            'avoid': [],
            'btc_vol_percentile': None,
            'n_symbols_total': len(all_symbols),
            'n_symbols_with_data': len(vol_data),
        }
        if live_data_missing:
            report['note'] = 'live_data_missing: using Binance historical'
        _write_report(report, OUTPUT_PATH)
        print(f'\nInsufficient data to rank (n={len(vol_data)})')
        print(f'Output: {OUTPUT_PATH}')
        return

    # ------------------------------------------------------------------
    # Step 5: Rank by vol (ascending = lowest vol first)
    # ------------------------------------------------------------------
    ranked = sorted(vol_data.items(), key=lambda x: x[1])
    ranked_list = []
    for rank, (sym, vol) in enumerate(ranked, 1):
        ranked_list.append({
            'symbol': sym,
            'vol_21d': round(vol, 6),
            'price': round(latest_prices.get(sym, 0), 8),
            'rank': rank,
        })

    n = len(ranked_list)
    n_buy = max(1, int(np.ceil(n * 0.25)))
    n_avoid = max(1, n_buy)

    buy_candidates = ranked_list[:n_buy]
    avoid = ranked_list[-n_avoid:]

    # BTC volatility percentile (lower = less volatile relative to universe)
    btc_vol = vol_data.get('BTCUSDT')
    btc_vol_pct: Optional[float] = None
    if btc_vol is not None:
        below = sum(1 for v in vol_data.values() if v <= btc_vol)
        btc_vol_pct = round(below / len(vol_data), 4)

    # ------------------------------------------------------------------
    # Step 6: Build & write report
    # ------------------------------------------------------------------
    report = {
        'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'date': report_date_str,
        'buy_candidates': buy_candidates,
        'avoid': avoid,
        'btc_vol_percentile': btc_vol_pct,
        'n_symbols_total': len(all_symbols),
        'n_symbols_with_data': len(vol_data),
    }

    if live_data_missing:
        report['note'] = 'live_data_missing: using Binance historical'

    _write_report(report, OUTPUT_PATH)

    # ------------------------------------------------------------------
    # Step 7: Human-readable summary
    # ------------------------------------------------------------------
    buy_names = [c['symbol'] for c in buy_candidates]
    avoid_names = [a['symbol'] for a in avoid]

    print()
    print(f'Daily Low-Vol Rank Report -- {report_date_str}')
    print('=' * 55)
    print(f'Symbols analyzed: {len(vol_data)}/{len(all_symbols)}')
    if live_data_missing:
        print('Note: live_data_missing -- using Binance historical')
    print(f'Buy candidates (lowest vol): {", ".join(buy_names)}')
    print(f'Avoid (highest vol):         {", ".join(avoid_names)}')
    if btc_vol is not None:
        print(f'BTC vol: {btc_vol:.6f}  (percentile: {btc_vol_pct:.0%})')
    print()
    print(f'Output: {OUTPUT_PATH}')


if __name__ == '__main__':
    main()
