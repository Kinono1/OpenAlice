from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd


DEFAULT_SYMBOLS = [
    "BTC_USDT_USDT",
    "ETH_USDT_USDT",
    "SOL_USDT_USDT",
]


def export_one(symbol: str, start: str, end: str, cache_dir: Path, out_dir: Path) -> Path:
    parquet_path = cache_dir / f"gate_swap_{symbol}_1h_{start}_{end}.parquet"
    if not parquet_path.exists():
        raise FileNotFoundError(f"Missing Gate parquet cache: {parquet_path}")

    df = pd.read_parquet(parquet_path).copy()
    if df.index.name is None:
        df.index.name = "time"

    df = df.reset_index().rename(columns={"time": "timestamp"})
    if "timestamp" not in df.columns:
        raise RuntimeError(f"Expected timestamp column in {parquet_path}")

    if not {"open", "high", "low", "close", "volume"}.issubset(df.columns):
        raise RuntimeError(f"Missing OHLCV columns in {parquet_path}")

    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True).map(lambda ts: int(ts.timestamp()))
    output = df[["timestamp", "open", "high", "low", "close", "volume"]]
    out_dir.mkdir(parents=True, exist_ok=True)
    csv_path = out_dir / f"{symbol}_1h.csv"
    output.to_csv(csv_path, index=False)
    return csv_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Export Gate OHLCV parquet cache to validation CSV.")
    parser.add_argument("--symbols", nargs="+", default=DEFAULT_SYMBOLS)
    parser.add_argument("--start", default="2023-01-01")
    parser.add_argument("--end", default="2025-04-03")
    parser.add_argument("--cache-dir", default="research/cache")
    parser.add_argument("--out-dir", default="data/market/gate")
    args = parser.parse_args()

    cache_dir = Path(args.cache_dir)
    out_dir = Path(args.out_dir)

    for symbol in args.symbols:
        csv_path = export_one(symbol, args.start, args.end, cache_dir, out_dir)
        print(csv_path)


if __name__ == "__main__":
    main()
