"""
Batch OFI feature generation for multiple symbols × multiple months.

Usage:
    /opt/miniconda3/bin/python3 scripts/train/run_batch_ofi.py \
        --symbols BTCUSDT,ETHUSDT,BNBUSDT \
        --start-month 2024-01 --end-month 2024-06
"""
import argparse, glob, json, os, sys, zipfile
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np

BASE = '/Volumes/shield/cryptoData/openalice-data/market/binance-public'

# spot aggTrades path template
SPOT_AGGS = f'{BASE}/spot-all-usdt-aggTrades/spot/aggTrades/{{sym}}'
# um aggTrades (futures) fallback
UM_AGGS = f'{BASE}/um-all-usdt-aggTrades/um/aggTrades/{{sym}}'


def process_agg_trades(zip_path: str) -> list[dict]:
    """Read aggTrades from ZIP, return list of {ts_min, price, qty, is_buyer_maker}."""
    rows = []
    try:
        with zipfile.ZipFile(zip_path) as z:
            names = z.namelist()
            if not names:
                return rows
            text = z.read(names[0]).decode('utf-8', errors='replace')
            for line in text.strip().split('\n'):
                if not line.strip():
                    continue
                cols = line.split(',')
                if len(cols) < 7:
                    continue
                try:
                    price = float(cols[1])
                    qty = float(cols[2])
                    ts_ms = int(cols[5])
                    is_buyer = cols[6].strip().lower() == 'true'
                    rows.append({
                        'ts_h': ts_ms // 3600000,  # hour-granularity timestamp
                        'price': price,
                        'qty': qty,
                        'usd_vol': price * qty,
                        'is_buyer': is_buyer,
                    })
                except (ValueError, IndexError):
                    continue
    except Exception as e:
        print(f'    Warning: {zip_path}: {e}', file=sys.stderr)
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--symbols', default='auto')
    parser.add_argument('--start-month', default='2024-01')
    parser.add_argument('--end-month', default='2024-06')
    parser.add_argument('--output', default='data/research/ofi_features.jsonl')
    args = parser.parse_args()

    # Auto-discover symbols that have aggTrades
    symbols = [s.strip() for s in args.symbols.split(',')] if args.symbols != 'auto' else []
    if args.symbols == 'auto':
        if os.path.isdir(SPOT_AGGS.replace('{sym}', '')):
            symbols = sorted(os.listdir(SPOT_AGGS.replace('{sym}', '')))[:30]

    print(f'Symbols: {len(symbols)}')

    # Parse month range
    ym_start = datetime.strptime(args.start_month, '%Y-%m')
    ym_end = datetime.strptime(args.end_month, '%Y-%m')

    total_output = 0
    with open(args.output, 'w') as out:
        for sym in symbols:
            spot_dir = SPOT_AGGS.replace('{sym}', sym)
            if not os.path.isdir(spot_dir):
                continue

            y, m_val = ym_start.year, ym_start.month
            while (y < ym_end.year or (y == ym_end.year and m_val <= ym_end.month)):
                month_str = f'{y}-{m_val:02d}'
                zip_path = os.path.join(spot_dir, f'{sym}-aggTrades-{month_str}.zip')
                if not os.path.exists(zip_path):
                    y_step, m_val = (m_val + 1, y) if m_val < 12 else (1, y + 1)
                    continue

                agg_rows = process_agg_trades(zip_path)
                if not agg_rows:
                    y_step, m_val = (m_val + 1, y) if m_val < 12 else (1, y + 1)
                    continue

                # Group by hour
                hourly = defaultdict(lambda: {'buy_vol': 0.0, 'sell_vol': 0.0, 'trades': 0, 'usd_vol': 0.0, 'prices': []})

                for r in agg_rows:
                    h = hourly[r['ts_h']]
                    if r['is_buyer']:
                        h['buy_vol'] += r['usd_vol']
                    else:
                        h['sell_vol'] += r['usd_vol']
                    h['trades'] += 1
                    h['usd_vol'] += r['usd_vol']
                    h['prices'].append(r['price'])

                for ts_h in sorted(hourly.keys()):
                    h = hourly[ts_h]
                    total_vol = h['buy_vol'] + h['sell_vol']
                    ofi = (h['buy_vol'] - h['sell_vol']) / total_vol if total_vol > 0 else 0.0
                    tick_ratio = h['buy_vol'] / total_vol if total_vol > 0 else 0.5
                    avg_size = h['usd_vol'] / h['trades'] if h['trades'] > 0 else 0
                    trades_per_sec = h['trades'] / 3600

                    ts_iso = datetime.fromtimestamp(ts_h * 3600, tz=timezone.utc).isoformat()
                    out.write(json.dumps({
                        'timestamp': ts_iso,
                        'symbol': sym,
                        'ofi': round(ofi, 6),
                        'tick_ratio': round(tick_ratio, 6),
                        'trades_per_second': round(trades_per_sec, 4),
                        'avg_trade_size_usd': round(avg_size, 2),
                    }) + '\n')
                    total_output += 1

                y_step, m_val = (m_val + 1, y) if m_val < 12 else (1, y + 1)

    print(f'Total OFI rows: {total_output} → {args.output}')


if __name__ == '__main__':
    main()
