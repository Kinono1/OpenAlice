"""
Low-volatility LONG-ONLY strategy backtest.

Monthly rebalanced: buy bottom 25% by realized_vol_21d (lowest vol).
No shorting. Equal-weight. Benchmark: BTC buy-and-hold.

Output: data/research/low_vol_long_only_report.json
"""
import json, os, sys, zipfile
from datetime import datetime, timezone
import numpy as np

BASE = '/Volumes/shield/cryptoData/openalice-data/market/binance-public'
KLINES_DIR = f'{BASE}/spot-all-usdt-klines-1d/spot'
COST_BPS = 15  # per rebalance


def discover_symbols(max_symbols=50):
    results = []
    for d in os.listdir(KLINES_DIR):
        if any(s in d for s in ['UPUSDT', 'DOWNUSDT', 'BULLUSDT', 'BEARUSDT']):
            continue
        kline_path = os.path.join(KLINES_DIR, d, '1d')
        if not os.path.isdir(kline_path):
            continue
        files = sorted([f for f in os.listdir(kline_path) if f.endswith('.zip')])
        if len(files) >= 36:
            results.append({'symbol': d, 'months': len(files)})
    results.sort(key=lambda r: r['months'], reverse=True)
    return [r['symbol'] for r in results[:max_symbols]]


def load_daily_closes(symbol, start_year=2020, end_year=2024):
    kline_path = os.path.join(KLINES_DIR, symbol, '1d')
    if not os.path.isdir(kline_path):
        return {}
    closes = {}
    for year in range(start_year, end_year + 1):
        for month in range(1, 13):
            fname = f'{symbol}-1d-{year}-{month:02d}.zip'
            fpath = os.path.join(kline_path, fname)
            if not os.path.exists(fpath):
                continue
            try:
                with zipfile.ZipFile(fpath) as z:
                    names = z.namelist()
                    if not names:
                        continue
                    text = z.read(names[0]).decode('utf-8', errors='replace')
                    for line in text.strip().split('\n'):
                        cols = line.split(',')
                        if len(cols) >= 5:
                            try:
                                ts_ms = int(cols[0])
                                close = float(cols[4])
                                date_str = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime('%Y-%m-%d')
                                closes[date_str] = close
                            except (ValueError, IndexError):
                                continue
            except Exception:
                continue
    return closes


def main():
    print('Discovering symbols...')
    symbols = discover_symbols(50)
    print(f'  Found {len(symbols)} symbols')

    print('Loading daily closes...')
    all_closes = {}
    for sym in symbols:
        closes = load_daily_closes(sym)
        if closes:
            all_closes[sym] = closes
            print(f'  {sym}: {len(closes)} days')

    # Build price matrix
    all_dates = sorted(set(d for closes in all_closes.values() for d in closes))
    print(f'\nPrice matrix: {len(all_closes)} symbols × {len(all_dates)} days')

    # Compute daily returns
    returns = {}
    for sym, closes in all_closes.items():
        dates = sorted(closes.keys())
        sym_ret = {}
        for i in range(1, len(dates)):
            d, prev = dates[i], dates[i - 1]
            if closes[prev] > 0:
                sym_ret[d] = (closes[d] - closes[prev]) / closes[prev]
        returns[sym] = sym_ret

    # Rebalance every 21 days
    rebalance_days = 21
    long_pct = 0.25  # bottom 25% by vol

    monthly_returns = []
    portfolio_value = 1.0
    btc_value = 1.0
    btc_closes = all_closes.get('BTCUSDT', {})
    btc_dates = sorted(btc_closes.keys())

    rebalance_indices = list(range(0, len(all_dates), rebalance_days))
    print(f'\nRebalance windows: {len(rebalance_indices)}')

    for wi in range(len(rebalance_indices) - 1):
        start_idx = rebalance_indices[wi]
        end_idx = rebalance_indices[wi + 1]
        window_dates = all_dates[start_idx:end_idx]

        if len(window_dates) < 2:
            continue

        # Compute realized_vol_21d for each symbol at rebalance date
        rebal_date = all_dates[start_idx]
        vol_data = {}
        for sym in returns:
            # Get last 21 daily returns before rebal date
            sym_dates = sorted(d for d in returns[sym] if d <= rebal_date)
            if len(sym_dates) < 15:
                continue
            recent_returns = [returns[sym][d] for d in sym_dates[-21:]]
            vol = np.std(recent_returns, ddof=1)
            if vol > 0 and not np.isnan(vol):
                vol_data[sym] = vol

        if len(vol_data) < 4:
            continue

        # Rank by vol (ascending)
        ranked = sorted(vol_data.items(), key=lambda x: x[1])
        n_long = max(1, int(len(ranked) * long_pct))
        long_symbols = [sym for sym, _ in ranked[:n_long]]

        # Compute forward return over holding period
        long_returns = []
        for sym in long_symbols:
            if sym not in all_closes:
                continue
            close_start = all_closes[sym].get(window_dates[0])
            close_end = all_closes[sym].get(window_dates[-1])
            if close_start and close_end and close_start > 0:
                long_returns.append((close_end - close_start) / close_start)

        if not long_returns:
            continue

        gross_return = np.mean(long_returns)
        net_return = gross_return - COST_BPS / 10000 * 2  # one rebalance cost

        # BTC benchmark
        btc_start = btc_closes.get(window_dates[0])
        btc_end = btc_closes.get(window_dates[-1])
        btc_return = (btc_end - btc_start) / btc_start if btc_start and btc_end and btc_start > 0 else 0

        monthly_returns.append({
            'month': window_dates[0][:7],
            'gross': round(gross_return, 6),
            'net': round(net_return, 6),
            'btc': round(btc_return, 6),
            'n_long': len(long_symbols),
        })

        portfolio_value *= (1 + net_return)
        btc_value *= (1 + btc_return)

    # Performance metrics
    n_years = len(all_dates) / 365.25
    total_return = portfolio_value - 1
    btc_total_return = btc_value - 1

    net_annualized = (portfolio_value ** (1 / n_years) - 1) if n_years > 0 else 0
    btc_annualized = (btc_value ** (1 / n_years) - 1) if n_years > 0 else 0

    # Sharpe (annualized)
    monthly_nets = [m['net'] for m in monthly_returns]
    mean_m = np.mean(monthly_nets)
    std_m = np.std(monthly_nets, ddof=1)
    sharpe = (mean_m / std_m * np.sqrt(12)) if std_m > 0 else 0

    # Max drawdown
    cum = np.cumprod([1 + m['net'] for m in monthly_returns])
    peak = np.maximum.accumulate(cum)
    dd = (peak - cum) / peak
    max_dd = float(np.max(dd))

    # Win rate
    wins = sum(1 for m in monthly_returns if m['net'] > 0)
    win_rate = wins / len(monthly_returns) if monthly_returns else 0

    report = {
        'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'config': {
            'mode': 'long_only',
            'n_symbols': len(all_closes),
            'rebalance_days': rebalance_days,
            'long_pct': long_pct,
            'cost_bps': COST_BPS,
            'period': '2020-01 to 2024-06',
        },
        'performance': {
            'gross_annualized_return': round(net_annualized + COST_BPS * 2 / 10000, 4),
            'net_annualized_return': round(net_annualized, 4),
            'btc_buy_hold_return': round(btc_annualized, 4),
            'sharpe_ratio': round(sharpe, 4),
            'max_drawdown_pct': round(-max_dd, 4),
            'total_trades': len(monthly_returns),
            'win_rate': round(win_rate, 4),
            'vs_btc': 'outperform' if net_annualized > btc_annualized else 'underperform',
        },
        'monthly_returns': monthly_returns,
    }

    # Write report
    out_path = 'data/research/low_vol_long_only_report.json'
    os.makedirs(os.path.dirname(out_path) or '.', exist_ok=True)
    with open(out_path, 'w') as f:
        json.dump(report, f, indent=2)
    print(f'\nReport: {out_path}')

    # Summary
    p = report['performance']
    print(f'\n=== Long-Only Low Vol Strategy (2020-06 to 2024-06) ===')
    print(f'  Net annualized return: {p["net_annualized_return"]:.2%}')
    print(f'  BTC buy-and-hold:      {p["btc_buy_hold_return"]:.2%}')
    print(f'  vs BTC:                {p["vs_btc"]}')
    print(f'  Sharpe ratio:          {p["sharpe_ratio"]:.2f}')
    print(f'  Max drawdown:          {p["max_drawdown_pct"]:.2%}')
    print(f'  Win rate:              {p["win_rate"]:.2%}')
    print(f'  Rebalance windows:     {p["total_trades"]}')


if __name__ == '__main__':
    main()
