"""
Generate feature matrix and cost-adjusted labels from Binance ZIP data.

Output:
  data/research/features.jsonl     — 11 features per row per symbol
  data/research/labels_24h.jsonl   — cost-adjusted forward returns, 24h horizon
  data/research/labels_48h.jsonl   — cost-adjusted forward returns, 48h horizon
"""
import argparse
import json
import os
import sys
import zipfile
import io
from datetime import datetime, timezone
from collections import defaultdict

import numpy as np

# ─── Config ──────────────────────────────────────────────────────────────
BASE = '/Volumes/shield/cryptoData/openalice-data/market/binance-public'
SPOT_KLINES_DIR = f'{BASE}/spot-all-usdt-klines-1h/spot'
FUNDING_DIR = f'{BASE}/um-all-usdt-fundingRate/um/fundingRate'
MARK_DIR = f'{BASE}/um-all-usdt-markPriceKlines-1h/um'
MIN_SPOT_MONTHS = 36
MIN_FUNDING_MONTHS = 12
MAX_SYMBOLS = 20
# Estimated costs in bps
FEE_BPS = 5
SPREAD_BPS = 5
SLIPPAGE_BPS = 5
TOTAL_COST_BPS = FEE_BPS + SPREAD_BPS + SLIPPAGE_BPS
TOTAL_COST_DEC = TOTAL_COST_BPS / 10000
DEFAULT_FEATURE_LATENCY_MS = 1
DEFAULT_LABEL_START_DELAY_MS = 1


# ─── Auto-discover symbols ──────────────────────────────────────────────

def discover_symbols(max_symbols: int = MAX_SYMBOLS):
    """Scan data directory, find symbols with sufficient coverage."""
    results = []
    if not os.path.isdir(SPOT_KLINES_DIR):
        print(f'Warning: {SPOT_KLINES_DIR} not found', file=sys.stderr)
        return ['BTCUSDT', 'ETHUSDT', 'BNBUSDT']  # fallback

    for sym_dir in sorted(os.listdir(SPOT_KLINES_DIR)):
        kline_path = os.path.join(SPOT_KLINES_DIR, sym_dir, '1h')
        if not os.path.isdir(kline_path):
            continue

        spot_files = sorted([f for f in os.listdir(kline_path) if f.endswith('.zip')])
        if len(spot_files) < MIN_SPOT_MONTHS:
            continue

        # Check funding data
        fund_path = os.path.join(FUNDING_DIR, sym_dir)
        fund_files = sorted([f for f in os.listdir(fund_path) if f.endswith('.zip')]) if os.path.isdir(fund_path) else []
        if len(fund_files) < MIN_FUNDING_MONTHS:
            continue

        first_month = spot_files[0].split('-')[-1].replace('.zip', '')
        last_month = spot_files[-1].split('-')[-1].replace('.zip', '')
        results.append({
            'symbol': sym_dir,
            'spot_months': len(spot_files),
            'funding_months': len(fund_files),
            'first_month': first_month,
            'last_month': last_month,
        })

    # Sort by data quality (most spot months first)
    results.sort(key=lambda r: r['spot_months'], reverse=True)
    selected = results[:max_symbols]

    print(f'\nDiscovered {len(results)} qualifying symbols, selected top {len(selected)}:')
    for r in selected:
        print(f'  {r["symbol"]}: {r["spot_months"]}mo spot, {r["funding_months"]}mo funding ({r["first_month"]} ~ {r["last_month"]})')

    return [r['symbol'] for r in selected]



# ─── ZIP Parsing ──────────────────────────────────────────────────────────

def read_csv_from_zip(path: str) -> list[list[str]]:
    """Read first CSV file from a ZIP archive, return rows as list of lists."""
    with open(path, 'rb') as f:
        buf = f.read()
    with zipfile.ZipFile(io.BytesIO(buf)) as z:
        names = z.namelist()
        if not names:
            return []
        csv_name = names[0]
        text = z.read(csv_name).decode('utf-8', errors='replace')
    rows = [line.split(',') for line in text.strip().split('\n') if line.strip()]
    return rows


def try_load_klines(sym: str, start_month: str, end_month: str) -> dict[int, dict]:
    """Load spot 1h klines from monthly ZIP files into {timestamp_ms: {ohlcv}}."""
    template = f'{BASE}/spot-all-usdt-klines-1h/spot/{{sym}}/1h/{{sym}}-1h-{{month}}.zip'
    all_bars = {}

    ym_start = datetime.strptime(start_month, '%Y-%m')
    ym_end = datetime.strptime(end_month, '%Y-%m')

    y, m = ym_start.year, ym_start.month
    while (y < ym_end.year or (y == ym_end.year and m <= ym_end.month)):
        month_str = f'{y}-{m:02d}'
        path = template.format(sym=sym, month=month_str)
        if os.path.exists(path):
            try:
                rows = read_csv_from_zip(path)
                for row in rows[1:]:  # skip header
                    if len(row) < 5:
                        continue
                    ts = int(row[0])
                    o = float(row[1])
                    h = float(row[2])
                    l = float(row[3])
                    c = float(row[4])
                    v = float(row[5]) if len(row) > 5 else 0
                    all_bars[ts] = {'open': o, 'high': h, 'low': l, 'close': c, 'volume': v}
            except Exception as e:
                print(f'  Warning: failed to load {path}: {e}', file=sys.stderr)
        else:
            print(f'  Warning: missing {path}', file=sys.stderr)
        m += 1
        if m > 12:
            y += 1
            m = 1

    return all_bars


def try_load_funding(sym: str, start_month: str, end_month: str) -> dict[int, float]:
    """Load funding rate data."""
    template = f'{BASE}/um-all-usdt-fundingRate/um/fundingRate/{{sym}}/{{sym}}-fundingRate-{{month}}.zip'
    rates = {}

    ym_start = datetime.strptime(start_month, '%Y-%m')
    ym_end = datetime.strptime(end_month, '%Y-%m')

    y, m = ym_start.year, ym_start.month
    while (y < ym_end.year or (y == ym_end.year and m <= ym_end.month)):
        month_str = f'{y}-{m:02d}'
        path = template.format(sym=sym, month=month_str)
        if os.path.exists(path):
            try:
                rows = read_csv_from_zip(path)
                for row in rows[1:]:
                    if len(row) >= 2:
                        ts = int(row[0])
                        rate = float(row[1])
                        rates[ts] = rate
            except Exception as e:
                print(f'  Warning: funding {path}: {e}', file=sys.stderr)
        m += 1
        if m > 12:
            y += 1
            m = 1

    return rates


def try_load_mark(sym: str, start_month: str, end_month: str) -> dict[int, float]:
    """Load mark price klines (contract prices)."""
    template = f'{BASE}/um-all-usdt-markPriceKlines-1h/um/{{sym}}/1h/{{sym}}-markPriceKlines-1h-{{month}}.zip'
    prices = {}

    ym_start = datetime.strptime(start_month, '%Y-%m')
    ym_end = datetime.strptime(end_month, '%Y-%m')

    y, m = ym_start.year, ym_start.month
    while (y < ym_end.year or (y == ym_end.year and m <= ym_end.month)):
        month_str = f'{y}-{m:02d}'
        path = template.format(sym=sym, month=month_str)
        if os.path.exists(path):
            try:
                rows = read_csv_from_zip(path)
                for row in rows[1:]:
                    if len(row) >= 5:
                        ts = int(row[0])
                        c = float(row[4])
                        prices[ts] = c
            except Exception as e:
                print(f'  Warning: mark {path}: {e}', file=sys.stderr)
        m += 1
        if m > 12:
            y += 1
            m = 1

    return prices


# ─── Feature Computation ──────────────────────────────────────────────────

def compute_features(sym: str, bars: dict, funding: dict, mark: dict,
                     btc_ret24: dict = None, all_ret24: dict = None,
                     feature_latency_ms: int = DEFAULT_FEATURE_LATENCY_MS):
    """Compute 11 features from aligned bar data. Yields (ts_ms, features_dict)."""
    sorted_ts = sorted(bars.keys())
    if len(sorted_ts) < 25:
        return

    # Build aligned arrays
    timestamps = sorted_ts
    closes = np.array([bars[t]['close'] for t in timestamps])
    volumes = np.array([bars[t]['volume'] for t in timestamps])

    n = len(timestamps)
    for i in range(24, n):
        ts = timestamps[i]

        # ret_1h, ret_4h, ret_24h
        ret1h = (closes[i] - closes[i - 1]) / closes[i - 1] if closes[i - 1] != 0 else None
        ret4h = (closes[i] - closes[i - 4]) / closes[i - 4] if i >= 4 and closes[i - 4] != 0 else None
        ret24h = (closes[i] - closes[i - 24]) / closes[i - 24] if i >= 24 and closes[i - 24] != 0 else None

        # realized_vol_24h
        if i >= 24:
            rets_24 = [(closes[j] - closes[j - 1]) / closes[j - 1] for j in range(i - 23, i + 1) if closes[j - 1] != 0]
            rv24 = float(np.std(rets_24, ddof=1)) if len(rets_24) >= 2 else None
        else:
            rv24 = None

        # volume_z_24h
        if i >= 24:
            vol_window = volumes[i - 23:i + 1]
            v_mean = float(np.mean(vol_window))
            v_std = float(np.std(vol_window, ddof=1))
            volZ = (volumes[i] - v_mean) / v_std if v_std > 1e-12 else None
        else:
            volZ = None

        # funding_rate (find closest <= current ts)
        fund_rates = [v for k, v in sorted(funding.items()) if k <= ts]
        fr = fund_rates[-1] if fund_rates else None

        # funding_z_30d (need ~720 1h funding samples)
        fz30 = None
        if fr is not None:
            recent_funding = [v for k, v in sorted(funding.items()) if ts - 720 * 3600000 <= k <= ts]
            if len(recent_funding) >= 30:
                f_mean = float(np.mean(recent_funding))
                f_std = float(np.std(recent_funding, ddof=1))
                fz30 = (fr - f_mean) / f_std if f_std > 1e-12 else 0.0

        # basis_bps: (mark - spot) / spot * 10000
        mark_vals = [v for k, v in sorted(mark.items()) if k <= ts]
        basis = None
        if mark_vals and bars[ts]['close'] > 0:
            m = mark_vals[-1]
            basis = ((m - bars[ts]['close']) / bars[ts]['close']) * 10000

        # oi_change_24h = None (no OI data)
        oi24 = None

        # btc_ret_24h
        btc24 = None
        if sym != 'BTCUSDT' and btc_ret24 and ts in btc_ret24:
            btc24 = btc_ret24[ts]

        # market_dispersion
        disp = None
        if all_ret24 and ts in all_ret24:
            vals = [v for v in all_ret24[ts].values() if v is not None]
            disp = float(np.std(vals, ddof=1)) if len(vals) >= 3 else None

        # feature freshness
        feat = [ret1h, ret4h, ret24h, rv24, volZ, fr, fz30, None, basis, btc24, disp]
        n_avail = sum(1 for v in feat if v is not None)
        freshness = n_avail / len(feat)

        decision_ts = ts + max(1, int(feature_latency_ms))
        yield ts, {
            'ret_1h': ret1h,
            'ret_4h': ret4h,
            'ret_24h': ret24h,
            'realized_vol_24h': rv24,
            'volume_z_24h': volZ,
            'funding_rate': fr,
            'funding_z_30d': fz30,
            'oi_change_24h': None,
            'basis_bps': basis,
            'btc_ret_24h': btc24,
            'market_dispersion': disp,
        }, freshness, decision_ts


def compute_labels(bars: dict, horizon_h: int, label_start_delay_ms: int = DEFAULT_LABEL_START_DELAY_MS):
    """Compute forward returns (both gross and net)."""
    sorted_ts = sorted(bars.keys())
    n = len(sorted_ts)
    if n < horizon_h + 1:
        return

    horizon_ms = horizon_h * 3600000
    closes = [bars[t]['close'] for t in sorted_ts]

    for i in range(n - horizon_h):
        t_now = sorted_ts[i]
        label_start = t_now + max(1, int(label_start_delay_ms))
        t_fwd = sorted_ts[i + horizon_h]
        gross = (closes[i + horizon_h] - closes[i]) / closes[i] if closes[i] != 0 else None
        net = gross - TOTAL_COST_DEC if gross is not None else None
        yield t_now, label_start, t_fwd, gross, net


# ─── Main ─────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Generate features + labels from Binance data')
    parser.add_argument('--symbols', default='auto', help='Comma-separated symbols, or "auto" for auto-discovery')
    parser.add_argument('--start-month', default='auto', help='e.g. 2020-01, or "auto" for earliest available')
    parser.add_argument('--end-month', default='2024-06', help='e.g. 2024-06')
    parser.add_argument('--max-symbols', type=int, default=30)
    parser.add_argument('--output-dir', default='data/research')
    parser.add_argument('--feature-latency-ms', type=int, default=DEFAULT_FEATURE_LATENCY_MS)
    parser.add_argument('--label-start-delay-ms', type=int, default=DEFAULT_LABEL_START_DELAY_MS)
    args = parser.parse_args()

    output_dir = args.output_dir
    os.makedirs(output_dir, exist_ok=True)

    # Auto-discover symbols if requested
    if args.symbols == 'auto':
        symbols = discover_symbols(args.max_symbols)
    else:
        symbols = [s.strip() for s in args.symbols.split(',')]

    if not symbols:
        print('No symbols found!', file=sys.stderr)
        return

    # Build SYMBOL_DATA dynamically
    sym_data = {}
    for sym in symbols:
        sym_data[sym] = {
            'spot_klines': f'{BASE}/spot-all-usdt-klines-1h/spot/{{sym}}/1h/',
            'funding': f'{BASE}/um-all-usdt-fundingRate/um/fundingRate/{{sym}}/',
            'mark': f'{BASE}/um-all-usdt-markPriceKlines-1h/um/{{sym}}/1h/',
        }

    # Determine auto date range from available data
    if args.start_month == 'auto':
        auto_start = None
        for sym in symbols:
            kline_path = f'{BASE}/spot-all-usdt-klines-1h/spot/{sym}/1h/'
            if os.path.isdir(kline_path):
                files = sorted([f for f in os.listdir(kline_path) if f.endswith('.zip')])
                if files:
                    first = files[0].split('-')[-2] + '-' + files[0].split('-')[-1].replace('.zip', '')
                    if auto_start is None or first < auto_start:
                        auto_start = first
        start_month = auto_start or '2020-01'
        print(f'Auto-start month: {start_month}')
    else:
        start_month = args.start_month

    print(f'Loading data for {len(symbols)} symbols from {start_month} to {args.end_month}...')

    # Phase 1: Load all raw data
    raw_data = {}
    for sym in symbols:
        print(f'\n{sym}:')
        print('  Loading spot 1h klines...')
        bars = try_load_klines(sym, start_month, args.end_month)
        print(f'  -> {len(bars)} bars')

        print('  Loading funding rate...')
        funding = try_load_funding(sym, start_month, args.end_month)
        print(f'  -> {len(funding)} points')

        print('  Loading mark price...')
        mark = try_load_mark(sym, start_month, args.end_month)
        print(f'  -> {len(mark)} prices')

        raw_data[sym] = {'bars': bars, 'funding': funding, 'mark': mark}

    # Phase 2: Compute BTC ret_24h as reference for all symbols
    btc_ret24 = {}
    if 'BTCUSDT' in raw_data:
        btc_bars = raw_data['BTCUSDT']['bars']
        sorted_ts = sorted(btc_bars.keys())
        for i in range(24, len(sorted_ts)):
            ts = sorted_ts[i]
            prev_close = btc_bars[sorted_ts[i - 24]]['close']
            curr_close = btc_bars[ts]['close']
            if prev_close > 0:
                btc_ret24[ts] = (curr_close - prev_close) / prev_close

    # Phase 3: Compute all ret_24h for market_dispersion
    all_ret24 = defaultdict(dict)
    for sym in symbols:
        bars = raw_data[sym]['bars']
        sorted_ts = sorted(bars.keys())
        for i in range(24, len(sorted_ts)):
            ts = sorted_ts[i]
            prev_close = bars[sorted_ts[i - 24]]['close']
            curr_close = bars[ts]['close']
            if prev_close > 0:
                all_ret24[ts][sym] = (curr_close - prev_close) / prev_close

    # Phase 4: Generate features
    print('\nGenerating features...')
    feat_path = os.path.join(output_dir, 'features.jsonl')
    feat_count = 0
    with open(feat_path, 'w') as f:
        for sym in symbols:
            bars = raw_data[sym]['bars']
            funding = raw_data[sym]['funding']
            mark = raw_data[sym]['mark']
            for ts, feat, freshness, decision_ts in compute_features(
                sym, bars, funding, mark, btc_ret24, all_ret24, args.feature_latency_ms
            ):
                if freshness < 0.6:
                    continue
                row = {
                        'timestamp': datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat(),
                        'symbol': sym,
                        'features': feat,
                        'metadata': {
                            'feature_freshness': round(freshness, 4),
                            'data_lag_ms': max(1, int(args.feature_latency_ms)),
                            'event_time': datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat(),
                            'observed_at': datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat(),
                            'available_at': datetime.fromtimestamp(decision_ts / 1000, tz=timezone.utc).isoformat(),
                            'decision_time': datetime.fromtimestamp(decision_ts / 1000, tz=timezone.utc).isoformat(),
                            'pit_policy': 'features_available_at_or_before_decision_time',
                            'execution_assumption': 'next_instant_after_bar_close_not_same_close',
                        },
                    }
                f.write(json.dumps(row) + '\n')
                feat_count += 1
    print(f'  {feat_count} feature rows → {feat_path}')

    # Phase 5: Generate labels
    for horizon in [24, 48]:
        label_path = os.path.join(output_dir, f'labels_{horizon}h.jsonl')
        label_count = 0
        with open(label_path, 'w') as f:
            for sym in symbols:
                bars = raw_data[sym]['bars']
                for ts, label_start, label_end, gross, net in compute_labels(bars, horizon, args.label_start_delay_ms):
                    row = {
                        'timestamp': datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat(),
                        'symbol': sym,
                        'forward_net_return': round(net, 8) if net is not None else None,
                        'forward_gross_return': round(gross, 8) if gross is not None else None,
                        'estimated_cost_bps': TOTAL_COST_BPS,
                        'horizon_hours': horizon,
                        'label_window_start': datetime.fromtimestamp(label_start / 1000, tz=timezone.utc).isoformat(),
                        'label_window_end': datetime.fromtimestamp(label_end / 1000, tz=timezone.utc).isoformat(),
                        'label_start_delay_ms': max(1, int(args.label_start_delay_ms)),
                    }
                    f.write(json.dumps(row) + '\n')
                    label_count += 1
        print(f'  {label_count} label rows → {label_path}')

    print(f'\nDone. Feature freshness threshold: 0.6, total cost: {TOTAL_COST_BPS} bps')


if __name__ == '__main__':
    main()
