"""
Order-book / ticker spread strategies using OKX order book + tick data.

Tests 3 strategies on cross-exchange (OKX vs Binance) and intra-exchange
(order book, funding, OI) signals.

Usage: /opt/miniconda3/bin/python3 scripts/train/strategy_orderbook.py
"""
import json, os, zipfile
from datetime import datetime, timezone, timedelta
from collections import defaultdict
import numpy as np

# ── Paths ────────────────────────────────────────────────────────────────────
OKX_DIR   = '/Volumes/shield/cryptoData/openalice-data/market/okx-live'
BIN_DIR   = '/Volumes/shield/cryptoData/openalice-data/market/binance-public'
BIN_SPOT  = f'{BIN_DIR}/spot-all-usdt-klines-1d/spot'
BIN_SPOT_1H = f'{BIN_DIR}/spot-all-usdt-klines-1h/spot'
BIN_FUND  = f'{BIN_DIR}/um-all-usdt-fundingRate/um/fundingRate'

OUT = 'data/research/strategy_orderbook_report.json'

# ── Helpers ───────────────────────────────────────────────────────────────────
def parse_ts_to_date(ts_str):
    """Adaptive timestamp: 13 digits = ms, 16 digits = μs."""
    ts = int(ts_str)
    if len(ts_str) >= 16:
        return datetime.fromtimestamp(ts / 1_000_000, tz=timezone.utc).strftime('%Y-%m-%d')
    else:
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime('%Y-%m-%d')


def _fmt(ts_ms):
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).isoformat().replace('+00:00', 'Z')

def _pct(a, b):
    if a is None or b is None or b == 0:
        return None
    return (a - b) / b

def _days_between(iso_a, iso_b):
    """Approx days between two ISO date strings (date portion only)."""
    try:
        da = datetime.strptime(iso_a[:10], '%Y-%m-%d')
        db = datetime.strptime(iso_b[:10], '%Y-%m-%d')
        return abs((da - db).days)
    except Exception:
        return 999


# ── OKX Data Loaders ─────────────────────────────────────────────────────────

def load_okx_tickers():
    """Load OKX ticker snapshots (SPOT).
    Returns {snapshot_label: {symbol: {last, askPx, bidPx, vol24h, ts}}}
    """
    snapshots = {}
    files = [
        ('live', f'{OKX_DIR}/tickers/2026-05/tickers_2026-05-10.json'),
        ('backfill', f'{OKX_DIR}/tickers/2026-05/tickers_backfill_2026-05-10.json'),
    ]
    for label, fpath in files:
        if not os.path.exists(fpath):
            continue
        with open(fpath) as f:
            raw = json.load(f)
        items = {}
        for item in raw.get('data', []):
            sym = item['instId']
            try:
                items[sym] = {
                    'last': float(item['last']) if item['last'] else None,
                    'askPx': float(item['askPx']) if item['askPx'] else None,
                    'bidPx': float(item['bidPx']) if item['bidPx'] else None,
                    'volCcy24h': float(item['volCcy24h']) if item['volCcy24h'] else 0,
                    'ts': int(item['ts']),
                }
            except (ValueError, TypeError):
                continue
        if items:
            snapshots[label] = {
                'ts_iso': _fmt(items[list(items.keys())[0]]['ts']),
                'items': items,
            }
    return snapshots


def load_okx_funding():
    """Load OKX BTC funding rates (8h intervals).
    Returns sorted list of {fundingTime_iso, fundingRate, realizedRate}
    """
    entries = []
    fpath = f'{OKX_DIR}/funding/2026-05/btc_funding_backfill.json'
    if not os.path.exists(fpath):
        return entries
    with open(fpath) as f:
        raw = json.load(f)
    for item in raw.get('data', []):
        entries.append({
            'fundingTime': int(item['fundingTime']),
            'fundingTime_iso': _fmt(int(item['fundingTime'])),
            'fundingRate': float(item['fundingRate']),
            'realizedRate': float(item['realizedRate']),
        })
    entries.sort(key=lambda x: x['fundingTime'])
    return entries


def load_okx_oi():
    """Load OKX BTC OI snapshots."""
    entries = []
    for root, dirs, files in os.walk(f'{OKX_DIR}/oi'):
        for fn in files:
            if fn.endswith('.json'):
                with open(os.path.join(root, fn)) as f:
                    raw = json.load(f)
                for item in raw.get('data', []):
                    entries.append({
                        'ts': int(item['ts']),
                        'ts_iso': _fmt(int(item['ts'])),
                        'oi': float(item['oi']),
                        'oiCcy': float(item['oiCcy']),
                        'oiUsd': float(item['oiUsd']),
                    })
    return entries


def load_okx_orderbook():
    """Load OKX orderbook spread snapshots from parquet.
    Returns {symbol: [{eventTime_iso, midPrice, spreadBps, ...}]}
    """
    real = '/Volumes/shield/cryptoData/openalice-data/parquet/orderbook/okx_swap_orderbook_spread_live.normalized.jsonl'
    if not os.path.exists(real):
        return {}

    by_sym = defaultdict(list)
    with open(real) as f:
        for line in f:
            d = json.loads(line)
            fld = d.get('fields', {})
            sym = fld.get('symbol')
            if not sym:
                continue
            by_sym[sym].append({
                'eventTime': d['eventTime'],
                'midPrice': fld.get('midPrice'),
                'spreadBps': fld.get('spreadBps'),
                'spreadAbs': fld.get('spreadAbs'),
                'imbalanceTop': fld.get('imbalanceTop'),
                'bidNotionalTop': fld.get('bidNotionalTop'),
                'askNotionalTop': fld.get('askNotionalTop'),
            })
    return dict(by_sym)


def load_okx_candles_1h(symbol='btc'):
    """Load OKX 1h candles from backfill + daily files."""
    candles = []
    prefix = symbol.lower()
    for fname in sorted(os.listdir(f'{OKX_DIR}/candles/2026-05/')):
        if not fname.startswith(prefix):
            continue
        with open(f'{OKX_DIR}/candles/2026-05/{fname}') as f:
            raw = json.load(f)
        for row in raw.get('data', []):
            candles.append({
                'ts': int(row[0]),
                'time': _fmt(int(row[0])),
                'open': float(row[1]),
                'high': float(row[2]),
                'low': float(row[3]),
                'close': float(row[4]),
                'vol': float(row[5]),
            })
    candles.sort(key=lambda x: x['ts'])
    return candles


# ── Binance Data Loaders ──────────────────────────────────────────────────────

def load_binance_spot_1h(symbols, max_files=3):
    """Load Binance spot 1h klines (most recent files only).
    Returns {symbol: {timestamp_ms: close_price}}
    """
    result = {}
    for sym in symbols:
        path = os.path.join(BIN_SPOT_1H, sym, '1h')
        if not os.path.isdir(path):
            continue
        closes = {}
        zips = sorted([z for z in os.listdir(path) if z.endswith('.zip')])
        for zf in zips[-max_files:]:
            try:
                with zipfile.ZipFile(os.path.join(path, zf)) as z:
                    text = z.read(z.namelist()[0]).decode('utf-8', errors='replace')
                    for line in text.strip().split('\n'):
                        cols = line.split(',')
                        if len(cols) >= 5:
                            ts_us = int(cols[0])
                            close = float(cols[4])
                            closes[ts_us // 1000] = close  # micro -> ms
            except Exception:
                continue
        if closes:
            result[sym] = closes
    return result


def load_binance_spot_daily(symbols):
    """Load Binance spot 1d klines for requested symbols.
    Returns {symbol: {date_str: close_price}}
    """
    result = {}
    for sym in symbols:
        path = os.path.join(BIN_SPOT, sym, '1d')
        if not os.path.isdir(path):
            continue
        closes = {}
        for zf in sorted(os.listdir(path))[-12:]:
            if not zf.endswith('.zip'):
                continue
            try:
                with zipfile.ZipFile(os.path.join(path, zf)) as z:
                    text = z.read(z.namelist()[0]).decode('utf-8', errors='replace')
                    for line in text.strip().split('\n'):
                        cols = line.split(',')
                        if len(cols) >= 5:
                            ts_us = int(cols[0])
                            close = float(cols[4])
                            date = datetime.fromtimestamp(ts_us // 1_000_000, tz=timezone.utc).strftime('%Y-%m-%d')
                            closes[date] = close
            except Exception:
                continue
        if closes:
            result[sym] = closes
    return result


def load_binance_funding(sym='BTCUSDT'):
    """Load Binance funding rates 2026 onward. Returns {date_str: rate}."""
    path = os.path.join(BIN_FUND, sym)
    if not os.path.isdir(path):
        return {}
    rates = {}
    for year in range(2026, 2027):
        for month in range(1, 13):
            fname = f'{sym}-fundingRate-{year}-{month:02d}.zip'
            fpath = os.path.join(path, fname)
            if not os.path.exists(fpath):
                continue
            try:
                with zipfile.ZipFile(fpath) as z:
                    text = z.read(z.namelist()[0]).decode('utf-8', errors='replace')
                    for line in text.strip().split('\n'):
                        cols = line.split(',')
                        if len(cols) >= 2:
                            ts = int(cols[0])
                            rate = float(cols[1])
                            date = parse_ts_to_date(cols[0])
                            rates[date] = rate
            except Exception:
                continue
    return rates


# ── Strategy A: OKX-Binance Spread ────────────────────────────────────────────
"""
If OKX price > Binance spot by > 0.2% -> buy (OKX demand higher)
If OKX < Binance by > 0.2% -> sell.
Top 10 coins where both prices available. Rebalance daily.
WFO: train=180d, test=30d, step=7d

CRITICAL CONSTRAINT: Binance spot data ends 2026-04-30.
OKX ticker data starts 2026-05-10. No chronological overlap for
same-day spread computation. We compute pseudo-spread using the
closest available Binance price and flag the gap in days.
"""
def strategy_a_spread(okx_tickers, binance_1h, binance_daily):
    results = {
        'description': (
            'OKX-Binance spread: if OKX spot > Binance spot by >0.2% -> long, '
            'if < -0.2% -> short. Top 10 coins by abs spread. '
            'Rebalance daily with WFO train=180d, test=30d, step=7d.'
        ),
        'data_gaps': {},
        'snapshots': [],
        'wfo_status': 'SKIPPED — no chronological data overlap for WFO',
    }

    # Determine latest Binance date
    latest_bin_date = None
    for sym, closes in binance_daily.items():
        for d in sorted(closes.keys(), reverse=True):
            if latest_bin_date is None or d > latest_bin_date:
                latest_bin_date = d

    for sym, closes in binance_1h.items():
        last_ts = max(closes.keys())
        last_dt = datetime.fromtimestamp(last_ts / 1000, tz=timezone.utc).strftime('%Y-%m-%d')
        if latest_bin_date is None or last_dt > latest_bin_date:
            latest_bin_date = last_dt

    results['binance_latest_date'] = latest_bin_date

    for label, snap in okx_tickers.items():
        items = snap['items']
        snap_date = snap['ts_iso'][:10]
        gap_days = _days_between(snap_date, latest_bin_date) if latest_bin_date else 999

        spreads = []
        for inst_id, tick in items.items():
            okx_last = tick['last']
            if okx_last is None:
                continue

            bin_sym = inst_id.replace('-', '')
            bin_price = None
            price_source = None

            # Prefer 1h data (more recent timestamps)
            if bin_sym in binance_1h:
                ts_sorted = sorted(binance_1h[bin_sym].keys())
                if ts_sorted:
                    bin_price = binance_1h[bin_sym][ts_sorted[-1]]
                    price_source = '1h'

            # Fallback to daily
            if bin_price is None and bin_sym in binance_daily:
                closes = binance_daily[bin_sym]
                dates = sorted(d for d in closes if d <= snap_date)
                if dates:
                    bin_price = closes[dates[-1]]
                    price_source = 'daily'

            if bin_price is None:
                continue

            spread = _pct(okx_last, bin_price)
            if spread is None:
                continue

            spreads.append({
                'instId': inst_id,
                'okx_price': okx_last,
                'binance_price': round(bin_price, 6),
                'binance_price_source': price_source,
                'spread_pct': round(spread, 6),
                'spread_bps': round(spread * 10000, 2),
                'abs_spread': abs(spread),
                'vol24h': tick['volCcy24h'],
            })

        if not spreads:
            continue

        # Report overall time gap
        spreads.sort(key=lambda x: x['abs_spread'], reverse=True)
        top10 = spreads[:10]

        signals = []
        for s in top10:
            if s['spread_pct'] > 0.002:
                signals.append({**s, 'signal': 'LONG', 'reason': 'OKX > Binance by > 0.2%'})
            elif s['spread_pct'] < -0.002:
                signals.append({**s, 'signal': 'SHORT', 'reason': 'OKX < Binance by < -0.2%'})
            else:
                signals.append({**s, 'signal': 'NEUTRAL', 'reason': 'Spread within threshold'})

        snapshot = {
            'snapshot_label': label,
            'snapshot_time': snap['ts_iso'],
            'okx_date': snap_date,
            'binance_latest_date': latest_bin_date,
            'time_gap_days': gap_days,
            'n_coins_total': len(spreads),
            'n_coins_above_threshold': sum(1 for s in spreads if abs(s['spread_pct']) > 0.002),
            'long_signals': [s for s in signals if s['signal'] == 'LONG'],
            'short_signals': [s for s in signals if s['signal'] == 'SHORT'],
            'neutral_signals': [s for s in signals if s['signal'] == 'NEUTRAL'],
            'max_abs_spread': max(s['abs_spread'] for s in spreads),
            'mean_abs_spread': round(np.mean([s['abs_spread'] for s in spreads]), 6),
        }
        results['snapshots'].append(snapshot)

    # Data gap assessment
    results['data_gaps']['time_gap'] = (
        f'Binance spot data ends {latest_bin_date or "N/A"}. '
        f'OKX tickers start {list(okx_tickers.keys())[0] if okx_tickers else "N/A"} '
        f'on 2026-05-10. No same-day comparison is possible. '
        f'Spread values reflect price movement over the ~10-day gap, not exchange-level spread.'
    )
    results['data_gaps']['wfo'] = (
        'WFO requires daily snapshots for 180d train + 30d test windows. '
        'Not feasible with current data coverage.'
    )
    if len(okx_tickers) < 5:
        results['data_gaps']['ticker_frequency'] = (
            f'Only {len(okx_tickers)} ticker snapshot(s) available. '
            'Daily snapshots needed for meaningful rebalance simulation.'
        )

    return results


# ── Strategy B: Funding Rate Regime ───────────────────────────────────────────
"""
If BTC funding rate > 0.05% for 3+ consecutive days -> market overheated, reduce 50%.
If funding < -0.01% for 3+ days -> oversold, increase 50%.
Overlay on V6a baseline.
"""
def strategy_b_funding_regime(okx_funding):
    results = {
        'description': (
            'Funding rate regime overlay: BTC funding > 0.05% for 3+ consecutive '
            'days -> reduce positions 50%. Funding < -0.01% for 3+ days -> '
            'increase positions 50%. Overlay on V6a baseline.'
        ),
        'data_gaps': {},
        'funding_summary': {},
        'regime_analysis': [],
        'overlay_signals': [],
    }

    if not okx_funding:
        results['data_gaps']['funding_data'] = 'No OKX funding data available.'
        return results

    # Aggregate 8h funding to daily mean
    daily_rates = defaultdict(list)
    for e in okx_funding:
        date = e['fundingTime_iso'][:10]
        daily_rates[date].append(e['fundingRate'])

    daily = {}
    for date in sorted(daily_rates.keys()):
        daily[date] = float(np.mean(daily_rates[date]))

    dates = sorted(daily.keys())
    n_days = len(dates)
    rates_arr = np.array(list(daily.values()))

    results['funding_summary'] = {
        'n_entries_8h': len(okx_funding),
        'n_days': n_days,
        'date_range': {'start': dates[0], 'end': dates[-1]} if dates else None,
        'mean_daily_rate': round(float(np.mean(rates_arr)), 8) if n_days else None,
        'median_daily_rate': round(float(np.median(rates_arr)), 8) if n_days else None,
        'max_daily_rate': round(float(np.max(rates_arr)), 8) if n_days else None,
        'min_daily_rate': round(float(np.min(rates_arr)), 8) if n_days else None,
        'pct_positive_days': round(float(np.mean(rates_arr > 0)), 4) if n_days else None,
        'pct_days_above_0_05pct': round(float(np.mean(rates_arr > 0.0005)), 4) if n_days else None,
        'pct_days_below_neg_0_01pct': round(float(np.mean(rates_arr < -0.0001)), 4) if n_days else None,
    }

    # Regime detection: consecutive days exceeding thresholds
    overheat_streak = 0
    oversold_streak = 0
    regimes = []
    signals = []

    for date, rate in daily.items():
        if rate > 0.0005:
            overheat_streak += 1
            oversold_streak = 0
        elif rate < -0.0001:
            oversold_streak += 1
            overheat_streak = 0
        else:
            overheat_streak = 0
            oversold_streak = 0

        regime = 'normal'
        action = 'none'
        if overheat_streak >= 3:
            regime = 'overheated'
            action = 'reduce_50pct'
        elif oversold_streak >= 3:
            regime = 'oversold'
            action = 'increase_50pct'

        regimes.append({
            'date': date,
            'funding_rate': round(rate, 8),
            'regime': regime,
            'action': action,
            'overheat_streak': overheat_streak,
            'oversold_streak': oversold_streak,
        })

        if action != 'none':
            signals.append({
                'date': date,
                'rate': round(rate, 8),
                'action': action,
            })

    results['regime_analysis'] = regimes
    results['overlay_signals'] = signals
    results['summary'] = {
        'total_regime_days_analyzed': n_days,
        'overheat_signal_days': sum(1 for s in signals if s['action'] == 'reduce_50pct'),
        'oversold_signal_days': sum(1 for s in signals if s['action'] == 'increase_50pct'),
        'pct_overheat_days': round(sum(1 for s in signals if s['action'] == 'reduce_50pct') / n_days, 4) if n_days else 0,
        'pct_oversold_days': round(sum(1 for s in signals if s['action'] == 'increase_50pct') / n_days, 4) if n_days else 0,
    }

    if n_days < 210:
        results['data_gaps']['funding_history'] = (
            f'Only {n_days} days of OKX funding data ({dates[0]} to {dates[-1]}). '
            'For WFO (train=180d, test=30d, step=7d), at least 210 days needed. '
            'Regime detection works with current data since it only requires 3-day streaks.'
        )

    return results


# ── Strategy C: OI Divergence ────────────────────────────────────────────────
"""
If OI is rising but price is flat -> big move coming.
Buy if OI up + price flat. Sell if OI down + price flat.
Use BTC OI data. Rebalance weekly.
"""
def strategy_c_oi_divergence(okx_oi, okx_candles_1h):
    results = {
        'description': (
            'OI divergence: OI rising + price flat -> buy. '
            'OI falling + price flat -> sell. BTC OI data. Weekly rebalance.'
        ),
        'data_gaps': {},
        'oi_snapshots': [],
        'btc_price_context': {},
        'signals': [],
        'wfo_status': 'SKIPPED — only 1 OI snapshot exists, cannot detect trends',
    }

    if not okx_oi:
        results['data_gaps']['oi_data'] = 'No OKX OI data available.'
        return results

    for e in okx_oi:
        results['oi_snapshots'].append({
            'time': e['ts_iso'],
            'oi_contracts': e['oi'],
            'oi_btc': float(e['oiCcy']),
            'oi_usd': float(e['oiUsd']),
        })

    # Analyze BTC 1h candle context around OI snapshot
    snap_ts = okx_oi[0]['ts']
    candles_before = [c for c in okx_candles_1h if c['ts'] <= snap_ts][-168:]  # ~7 days
    candles_after = [c for c in okx_candles_1h if c['ts'] >= snap_ts][:24]    # ~1 day

    if candles_before:
        prices_before = [c['close'] for c in candles_before]
        results['btc_price_context'] = {
            'n_candles_1h_available': len(okx_candles_1h),
            'candle_date_range': {
                'start': okx_candles_1h[0]['time'] if okx_candles_1h else None,
                'end': okx_candles_1h[-1]['time'] if okx_candles_1h else None,
            },
            'price_7d_before_oi': {
                'open': candles_before[0]['close'],
                'close': candles_before[-1]['close'],
                'high': max(prices_before),
                'low': min(prices_before),
                'change_pct': round(_pct(candles_before[-1]['close'], candles_before[0]['close']), 6) if candles_before[0]['close'] else None,
                'volatility_1h': round(float(np.std(prices_before, ddof=1)), 2),
            },
        }
    if candles_after:
        prices_after = [c['close'] for c in candles_after]
        results['btc_price_context']['price_1d_after_oi'] = {
            'open': candles_after[0]['close'],
            'close': candles_after[-1]['close'],
            'change_pct': round(_pct(candles_after[-1]['close'], candles_after[0]['close']), 6),
            'volatility_1h': round(float(np.std(prices_after, ddof=1)), 2),
        }

    results['data_gaps']['oi_history'] = (
        f'Only {len(okx_oi)} OI snapshot(s) available (2026-05-10). '
        'OI divergence requires a time series (min 3+ weeks of daily data). '
        'Cannot detect OI-price divergence without trend data.'
    )
    results['data_gaps']['oi_weekly_wfo'] = (
        'Weekly rebalance WFO not possible with < 210 days of OI data.'
    )

    return results


# ── Additional: Orderbook Liquidity Analysis ───────────────────────────────────
"""
Bonus analysis: OKX orderbook spread snapshots (BTC/ETH/SOL, 376 rows).
Shows liquidity evolution over time.
"""
def analyze_orderbook_liquidity(ob_data):
    if not ob_data:
        return {'status': 'no_data'}

    analysis = {}
    for sym, entries in ob_data.items():
        mids = [e['midPrice'] for e in entries if e['midPrice']]
        spreads = [e['spreadBps'] for e in entries if e['spreadBps'] is not None]
        imbalances = [e['imbalanceTop'] for e in entries if e['imbalanceTop'] is not None]
        bid_ntl = [e['bidNotionalTop'] for e in entries if e['bidNotionalTop']]
        ask_ntl = [e['askNotionalTop'] for e in entries if e['askNotionalTop']]

        analysis[sym] = {
            'n_snapshots': len(entries),
            'date_range': {
                'start': entries[0]['eventTime'] if entries else None,
                'end': entries[-1]['eventTime'] if entries else None,
            },
            'mid_price': {
                'mean': round(float(np.mean(mids)), 2) if mids else None,
                'min': round(float(np.min(mids)), 2) if mids else None,
                'max': round(float(np.max(mids)), 2) if mids else None,
            },
            'spread_bps': {
                'mean': round(float(np.mean(spreads)), 4) if spreads else None,
                'min': round(float(np.min(spreads)), 4) if spreads else None,
                'max': round(float(np.max(spreads)), 4) if spreads else None,
            },
            'top_imbalance': {
                'mean': round(float(np.mean(imbalances)), 4) if imbalances else None,
                'min': round(float(np.min(imbalances)), 4) if imbalances else None,
                'max': round(float(np.max(imbalances)), 4) if imbalances else None,
            },
            'bid_notional_top_usd': {
                'mean': round(float(np.mean(bid_ntl)), 2) if bid_ntl else None,
            },
            'ask_notional_top_usd': {
                'mean': round(float(np.mean(ask_ntl)), 2) if ask_ntl else None,
            },
        }
    return analysis


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print('=== Strategy Orderbook Report ===')
    print()

    # ── Load OKX data ─────────────────────────────────────────────────────────
    print('Loading OKX data...')
    okx_tickers = load_okx_tickers()
    okx_funding = load_okx_funding()
    okx_oi = load_okx_oi()
    okx_orderbook = load_okx_orderbook()
    okx_candles_btc = load_okx_candles_1h('btc')

    print(f'  Tickers: {len(okx_tickers)} snapshot(s)')
    for label, snap in okx_tickers.items():
        usdt_count = len([k for k in snap['items'] if k.endswith('USDT') and k.count('-') == 1])
        print(f'    {label}: {snap["ts_iso"]} ({len(snap["items"])} total, {usdt_count} USDT pairs)')
    print(f'  Funding: {len(okx_funding)} 8h entries')
    if okx_funding:
        print(f'    {okx_funding[0]["fundingTime_iso"][:10]} -> {okx_funding[-1]["fundingTime_iso"][:10]}')
    print(f'  OI: {len(okx_oi)} snapshot(s)')
    print(f'  Orderbook spread: {len(okx_orderbook)} coin(s)')
    for sym, entries in okx_orderbook.items():
        print(f'    {sym}: {len(entries)} snapshots')
    print(f'  BTC 1h candles: {len(okx_candles_btc)}')

    # ── Load Binance data ─────────────────────────────────────────────────────
    print()
    print('Loading Binance data...')

    # Get top-volume OKX USDT pairs
    top50_usdt_syms = []
    if okx_tickers:
        snap = next(iter(okx_tickers.values()))
        vol_items = [(t['volCcy24h'], i.replace('-', ''))
                     for i, t in snap['items'].items()
                     if i.endswith('USDT') and i.count('-') == 1 and t['last']]
        vol_items.sort(key=lambda x: x[0], reverse=True)
        top50_usdt_syms = [s for _, s in vol_items[:50]]

    binance_1h = load_binance_spot_1h(top50_usdt_syms, max_files=2)
    binance_daily = load_binance_spot_daily(top50_usdt_syms)
    print(f'  Binance 1h: {len(binance_1h)} symbols with data')
    print(f'  Binance daily: {len(binance_daily)} symbols with data')

    # Find latest Binance timestamp
    latest_bin = None
    for sym, closes in binance_1h.items():
        if closes:
            t = max(closes.keys())
            d = datetime.fromtimestamp(t / 1000, tz=timezone.utc)
            if latest_bin is None or d > latest_bin:
                latest_bin = d
    if latest_bin:
        print(f'  Latest Binance 1h timestamp: {latest_bin}')
    else:
        print(f'  No Binance 1h data loaded')

    for sym, closes in binance_daily.items():
        dates = sorted(closes.keys())
        if dates:
            print(f'  Latest Binance daily date: {dates[-1]}')
            break

    # ── Strategy A: Spread ────────────────────────────────────────────────────
    print()
    print('=== Strategy A: OKX-Binance Spread ===')
    strat_a = strategy_a_spread(okx_tickers, binance_1h, binance_daily)
    print(f'  Binance latest date: {strat_a.get("binance_latest_date", "N/A")}')

    for snap in strat_a.get('snapshots', []):
        print(f'  Snapshot: {snap["snapshot_label"]} (@ {snap["snapshot_time"]})')
        print(f'    OKX date: {snap["okx_date"]}, Binance latest: {snap["binance_latest_date"]}')
        print(f'    Time gap: {snap["time_gap_days"]} days')
        print(f'    Coins compared: {snap["n_coins_total"]}')
        print(f'    Above 0.2% threshold: {snap["n_coins_above_threshold"]}')
        print(f'    Long/Short/Neutral: {len(snap["long_signals"])} / {len(snap["short_signals"])} / {len(snap["neutral_signals"])}')

        # Show top signals
        all_signals = snap.get('long_signals', []) + snap.get('short_signals', [])
        for s in all_signals[:5]:
            print(f'      {s["instId"]}: {s["signal"]} (spread={s["spread_bps"]}bps, binance_source={s.get("binance_price_source","?")})')

    for gap_key, gap_msg in strat_a.get('data_gaps', {}).items():
        print(f'  [GAP] {gap_key}: {gap_msg}')

    # ── Strategy B: Funding ───────────────────────────────────────────────────
    print()
    print('=== Strategy B: Funding Rate Regime ===')
    strat_b = strategy_b_funding_regime(okx_funding)
    fs = strat_b.get('funding_summary', {})
    print(f'  Days analyzed: {fs.get("n_days", 0)}')
    print(f'  Date range: {fs.get("date_range", {}).get("start")} -> {fs.get("date_range", {}).get("end")}')
    print(f'  Mean daily rate: {fs.get("mean_daily_rate")}')
    print(f'  Days >0.05%: {fs.get("pct_days_above_0_05pct", "N/A")}')
    print(f'  Days <-0.01%: {fs.get("pct_days_below_neg_0_01pct", "N/A")}')
    print(f'  Overheat signals: {strat_b.get("summary", {}).get("overheat_signal_days", 0)}')
    print(f'  Oversold signals: {strat_b.get("summary", {}).get("oversold_signal_days", 0)}')

    signals_b = strat_b.get('overlay_signals', [])
    if signals_b:
        print(f'  Sample regime signals:')
        for s in signals_b[:10]:
            print(f'    {s["date"]}: rate={s["rate"]}, {s["action"]}')

    for gap_key, gap_msg in strat_b.get('data_gaps', {}).items():
        print(f'  [GAP] {gap_key}: {gap_msg}')

    # ── Strategy C: OI ────────────────────────────────────────────────────────
    print()
    print('=== Strategy C: OI Divergence ===')
    strat_c = strategy_c_oi_divergence(okx_oi, okx_candles_btc)
    print(f'  OI snapshots: {len(strat_c.get("oi_snapshots", []))}')
    for oi in strat_c.get('oi_snapshots', []):
        print(f'    @ {oi["time"]}: oi={oi["oi_btc"]:.2f} BTC (${oi["oi_usd"]:,.0f})')
    pc = strat_c.get('btc_price_context', {})
    if pc:
        pd = pc.get('price_7d_before_oi', {})
        if pd:
            print(f'  BTC 7d before OI: change={pd.get("change_pct")}, vol={pd.get("volatility_1h")}')
        pa = pc.get('price_1d_after_oi', {})
        if pa:
            print(f'  BTC 1d after OI: change={pa.get("change_pct")}')

    for gap_key, gap_msg in strat_c.get('data_gaps', {}).items():
        print(f'  [GAP] {gap_key}: {gap_msg}')

    # ── Bonus: Orderbook liquidity ────────────────────────────────────────────
    print()
    print('=== Bonus: Orderbook Liquidity Analysis ===')
    ob_analysis = analyze_orderbook_liquidity(okx_orderbook)
    if ob_analysis.get('status') != 'no_data':
        for sym, info in ob_analysis.items():
            if sym == 'status':
                continue
            sp = info.get('spread_bps', {})
            imb = info.get('top_imbalance', {})
            print(f'  {sym}: spread_bps={sp.get("mean")} (range {sp.get("min")}-{sp.get("max")}), '
                  f'imbalance={imb.get("mean")} (range {imb.get("min")}-{imb.get("max")})')
    else:
        print('  No orderbook data available.')

    # ── Assemble final report ─────────────────────────────────────────────────
    report = {
        'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'data_inventory': {
            'okx': {
                'ticker_snapshots': len(okx_tickers),
                'ticker_usdt_pairs': len([k for snap in okx_tickers.values() for k in snap['items'] if k.endswith('USDT') and k.count('-') == 1]) // max(len(okx_tickers), 1) if okx_tickers else 0,
                'funding_8h_entries': len(okx_funding),
                'funding_date_range': {
                    'start': min(e['fundingTime_iso'] for e in okx_funding)[:10] if okx_funding else None,
                    'end': max(e['fundingTime_iso'] for e in okx_funding)[:10] if okx_funding else None,
                },
                'oi_snapshots': len(okx_oi),
                'orderbook_coins': list(okx_orderbook.keys()),
                'orderbook_snapshots': {s: len(v) for s, v in okx_orderbook.items()},
                'btc_1h_candles': len(okx_candles_btc),
                'btc_1h_date_range': {
                    'start': okx_candles_btc[0]['time'] if okx_candles_btc else None,
                    'end': okx_candles_btc[-1]['time'] if okx_candles_btc else None,
                },
            },
            'binance': {
                'spot_1h_symbols': len(binance_1h),
                'spot_daily_symbols': len(binance_daily),
                'latest_1h_timestamp': latest_bin.isoformat() if latest_bin else None,
                'latest_daily_end': strat_a.get('binance_latest_date'),
            },
            'note': (
                'CRITICAL: Binance data ends 2026-04-30. OKX data starts 2026-05-05. '
                'Zero chronological overlap for same-day cross-exchange comparisons.'
            ),
        },
        'strategy_a_okx_binance_spread': strat_a,
        'strategy_b_funding_regime': strat_b,
        'strategy_c_oi_divergence': strat_c,
        'bonus_orderbook_liquidity': ob_analysis,
        'recommendations': [
            '1. Collect OKX ticker snapshots daily at a consistent time to build a usable time series.',
            '2. Increase OKX BTC OI collection to at least daily frequency. Current: 1 snapshot.',
            '3. Cross-exchange spread (Strategy A) is infeasible until Binance and OKX data windows overlap.',
            '4. Funding regime (Strategy B) is the most feasible: 34 daily OKX funding data points available. Supplement with Binance funding history (2020-) for WFO.',
            '5. Orderbook spread snapshots (BTC/ETH/SOL, May 7-10) are useful for live execution analysis but insufficient for historical backtesting.',
            '6. For proper WFO: collect all data types daily for 210+ days, or extend Binance data coverage to current date.',
        ],
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(report, f, indent=2, default=str)
    print(f'\nReport saved to {OUT}')
    print('Done.')


if __name__ == '__main__':
    main()
