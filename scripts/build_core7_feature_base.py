#!/usr/bin/env python3
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from core7_pipeline_utils import (
    okx_base_quote,
    read_csv_any,
    rolling_zscore,
    safe_div,
    write_csv_zst,
    write_json,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build per-instId core7 feature tables from normalized OKX and Binance minute data."
    )
    parser.add_argument(
        "--okx-root",
        default="data/market/okx_1m_core7_norm",
        help="Root of normalized OKX outputs.",
    )
    parser.add_argument(
        "--binance-root",
        default="data/market/binance_1m_core7_norm",
        help="Root of normalized Binance outputs.",
    )
    parser.add_argument(
        "--output-root",
        default="data/market/core7_feature_base_1m",
        help="Root for output feature tables.",
    )
    parser.add_argument(
        "--symbols",
        default="",
        help="Optional comma-separated OKX instId allowlist.",
    )
    parser.add_argument(
        "--ret-windows",
        default="1,3,5",
        help="Comma-separated return windows.",
    )
    parser.add_argument(
        "--rv-windows",
        default="5,15,60",
        help="Comma-separated realized-vol windows.",
    )
    parser.add_argument(
        "--sma-windows",
        default="5,20",
        help="Comma-separated moving-average windows.",
    )
    parser.add_argument(
        "--volume-z-window",
        type=int,
        default=20,
        help="Rolling window for volume z-score.",
    )
    parser.add_argument(
        "--label-horizons",
        default="1,5,15",
        help="Comma-separated forward label horizons.",
    )
    parser.add_argument(
        "--summary-output",
        default="",
        help="Optional summary JSON path.",
    )
    return parser.parse_args()


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_int_list(raw: str) -> list[int]:
    out: list[int] = []
    seen: set[int] = set()
    for token in raw.split(","):
        value = token.strip()
        if not value:
            continue
        number = int(value)
        if number <= 0 or number in seen:
            continue
        seen.add(number)
        out.append(number)
    return out


def read_okx_frame(path: Path) -> pd.DataFrame:
    df = read_csv_any(path)
    df = df.sort_values("timestamp_ms", kind="stable").reset_index(drop=True)
    return df


def read_binance_frame(path: Path | None) -> pd.DataFrame | None:
    if path is None or not path.exists():
        return None
    df = read_csv_any(path)
    df = df.sort_values("timestamp_ms", kind="stable").reset_index(drop=True)
    return df


def log_return(series: pd.Series) -> pd.Series:
    return np.log(series / series.shift(1))


def realized_vol(log_ret: pd.Series, window: int) -> pd.Series:
    return (log_ret.pow(2).rolling(window, min_periods=window).sum()).pow(0.5)


def ratio_or_nan(num: pd.Series, den: pd.Series) -> pd.Series:
    return safe_div(num.astype(float), den.astype(float))


def add_okx_features(df: pd.DataFrame, ret_windows: list[int], rv_windows: list[int], sma_windows: list[int], volume_z_window: int) -> pd.DataFrame:
    out = df.copy()
    out["okx_ret_1m"] = out["okx_close"].pct_change(1)
    for window in ret_windows:
        out[f"okx_ret_{window}m"] = out["okx_close"].pct_change(window)
    out["okx_log_ret_1m"] = log_return(out["okx_close"])
    out["okx_range_pct"] = ratio_or_nan(out["okx_high"] - out["okx_low"], out["okx_close"])
    out["okx_body_pct"] = ratio_or_nan(out["okx_close"] - out["okx_open"], out["okx_open"])
    out["okx_upper_wick_pct"] = ratio_or_nan(
        out["okx_high"] - np.maximum(out["okx_open"], out["okx_close"]),
        out["okx_close"],
    )
    out["okx_lower_wick_pct"] = ratio_or_nan(
        np.minimum(out["okx_open"], out["okx_close"]) - out["okx_low"],
        out["okx_close"],
    )
    for window in rv_windows:
        out[f"okx_rv_{window}m"] = realized_vol(out["okx_log_ret_1m"], window)
    out["okx_volume_ma_5"] = out["okx_volume"].rolling(5, min_periods=5).mean()
    out["okx_volume_ma_20"] = out["okx_volume"].rolling(20, min_periods=20).mean()
    out["okx_volume_z20"] = rolling_zscore(out["okx_volume"], volume_z_window)
    if len(sma_windows) >= 2:
        short_window, long_window = sma_windows[0], sma_windows[1]
        sma_short = out["okx_close"].rolling(short_window, min_periods=short_window).mean()
        sma_long = out["okx_close"].rolling(long_window, min_periods=long_window).mean()
        out[f"okx_close_vs_sma_{short_window}"] = ratio_or_nan(out["okx_close"], sma_short) - 1.0
        out[f"okx_close_vs_sma_{long_window}"] = ratio_or_nan(out["okx_close"], sma_long) - 1.0
        out[f"okx_sma_{short_window}_vs_{long_window}"] = ratio_or_nan(sma_short, sma_long) - 1.0
    if 5 in rv_windows and 60 in rv_windows:
        out["okx_short_long_vol_ratio"] = ratio_or_nan(out["okx_rv_5m"], out["okx_rv_60m"])
    return out


def add_binance_features(df: pd.DataFrame, prefix: str, ret_windows: list[int], volume_z_window: int) -> pd.DataFrame:
    out = df.copy()
    out[f"{prefix}_ret_1m"] = out[f"{prefix}_close"].pct_change(1, fill_method=None)
    for window in ret_windows:
        out[f"{prefix}_ret_{window}m"] = out[f"{prefix}_close"].pct_change(window, fill_method=None)
    out[f"{prefix}_quote_volume_z20"] = rolling_zscore(out[f"{prefix}_quote_volume"], volume_z_window)
    out[f"{prefix}_trade_count_z20"] = rolling_zscore(out[f"{prefix}_trade_count"], volume_z_window)
    out[f"{prefix}_avg_trade_size"] = ratio_or_nan(out[f"{prefix}_quote_volume"], out[f"{prefix}_trade_count"])
    out[f"{prefix}_taker_buy_ratio"] = ratio_or_nan(out[f"{prefix}_taker_buy_base"], out[f"{prefix}_volume"])
    out[f"{prefix}_taker_buy_quote_ratio"] = ratio_or_nan(out[f"{prefix}_taker_buy_quote"], out[f"{prefix}_quote_volume"])
    out[f"{prefix}_ret_1m_lag1"] = out[f"{prefix}_ret_1m"].shift(1)
    out[f"{prefix}_ret_1m_lag2"] = out[f"{prefix}_ret_1m"].shift(2)
    return out


def load_okx_symbol_file(okx_root: Path, market: str, symbol: str) -> Path | None:
    path = okx_root / market / symbol / "1m" / "data.csv.zst"
    if path.exists():
        return path
    csv_path = okx_root / market / symbol / "1m" / "data.csv"
    return csv_path if csv_path.exists() else None


def load_binance_symbol_file(binance_root: Path, market: str, symbol: str) -> Path | None:
    path = binance_root / market / symbol / "1m" / "data.csv.zst"
    if path.exists():
        return path
    csv_path = binance_root / market / symbol / "1m" / "data.csv"
    return csv_path if csv_path.exists() else None


def build_anchor_table(
    *,
    okx_root: Path,
    binance_root: Path,
    output_root: Path,
    anchor_symbol: str,
    anchor_market: str,
    ret_windows: list[int],
    rv_windows: list[int],
    sma_windows: list[int],
    volume_z_window: int,
    label_horizons: list[int],
) -> dict[str, object]:
    okx_anchor_path = load_okx_symbol_file(okx_root, anchor_market, anchor_symbol)
    if okx_anchor_path is None:
        raise FileNotFoundError(f"Missing normalized OKX anchor file for {anchor_symbol}")
    okx_anchor = read_okx_frame(okx_anchor_path)
    okx_anchor = okx_anchor.rename(
        columns={
            "open": "okx_open",
            "high": "okx_high",
            "low": "okx_low",
            "close": "okx_close",
            "volume": "okx_volume",
            "symbol": "okx_inst_id",
            "market": "okx_market",
        }
    )
    base, quote = okx_base_quote(anchor_symbol)
    okx_anchor["base"] = base
    okx_anchor["quote"] = quote
    okx_anchor["has_okx_bar"] = 1

    binance_symbol = f"{base}{quote}"
    okx_spot_symbol = f"{base}-{quote}"
    okx_swap_symbol = f"{base}-{quote}-SWAP"

    okx_pair_path = None
    if anchor_market == "spot":
        okx_pair_path = load_okx_symbol_file(okx_root, "swap", okx_swap_symbol)
    else:
        okx_pair_path = load_okx_symbol_file(okx_root, "spot", okx_spot_symbol)
    okx_pair = read_okx_frame(okx_pair_path) if okx_pair_path else None
    if okx_pair is not None:
        okx_pair = okx_pair.rename(
            columns={
                "close": "okx_pair_close",
                "volume": "okx_pair_volume",
                "symbol": "okx_pair_symbol",
                "market": "okx_pair_market",
            }
        )[["timestamp_ms", "okx_pair_close", "okx_pair_volume", "okx_pair_symbol", "okx_pair_market"]]

    binance_spot_path = load_binance_symbol_file(binance_root, "spot", binance_symbol)
    binance_um_path = load_binance_symbol_file(binance_root, "um", binance_symbol)
    binance_spot = read_binance_frame(binance_spot_path)
    binance_um = read_binance_frame(binance_um_path)

    if binance_spot is not None:
        binance_spot = binance_spot.rename(
            columns={
                "close": "binance_spot_close",
                "volume": "binance_spot_volume",
                "quote_volume": "binance_spot_quote_volume",
                "trades_count": "binance_spot_trade_count",
                "taker_buy_base": "binance_spot_taker_buy_base",
                "taker_buy_quote": "binance_spot_taker_buy_quote",
            }
        )[
            [
                "timestamp_ms",
                "binance_spot_close",
                "binance_spot_volume",
                "binance_spot_quote_volume",
                "binance_spot_trade_count",
                "binance_spot_taker_buy_base",
                "binance_spot_taker_buy_quote",
            ]
        ]

    if binance_um is not None:
        binance_um = binance_um.rename(
            columns={
                "close": "binance_um_close",
                "volume": "binance_um_volume",
                "quote_volume": "binance_um_quote_volume",
                "trades_count": "binance_um_trade_count",
                "taker_buy_base": "binance_um_taker_buy_base",
                "taker_buy_quote": "binance_um_taker_buy_quote",
            }
        )[
            [
                "timestamp_ms",
                "binance_um_close",
                "binance_um_volume",
                "binance_um_quote_volume",
                "binance_um_trade_count",
                "binance_um_taker_buy_base",
                "binance_um_taker_buy_quote",
            ]
        ]

    table = okx_anchor.copy()
    if okx_pair is not None:
        table = table.merge(okx_pair, on="timestamp_ms", how="left")
    if binance_spot is not None:
        table = table.merge(binance_spot, on="timestamp_ms", how="left")
    if binance_um is not None:
        table = table.merge(binance_um, on="timestamp_ms", how="left")

    table["has_binance_spot_bar"] = table["binance_spot_close"].notna().astype(int) if "binance_spot_close" in table else 0
    table["has_binance_um_bar"] = table["binance_um_close"].notna().astype(int) if "binance_um_close" in table else 0
    table["has_okx_pair_bar"] = table["okx_pair_close"].notna().astype(int) if "okx_pair_close" in table else 0

    if anchor_market == "spot":
        table["okx_spot_close"] = table["okx_close"]
        table["okx_swap_close"] = table.get("okx_pair_close")
        table["okx_spot_volume"] = table["okx_volume"]
        table["okx_swap_volume"] = table.get("okx_pair_volume")
    else:
        table["okx_swap_close"] = table["okx_close"]
        table["okx_spot_close"] = table.get("okx_pair_close")
        table["okx_swap_volume"] = table["okx_volume"]
        table["okx_spot_volume"] = table.get("okx_pair_volume")

    table = add_okx_features(table, ret_windows, rv_windows, sma_windows, volume_z_window)
    if binance_spot is not None:
        table = add_binance_features(table, "binance_spot", ret_windows, volume_z_window)
        table["spread_spot_close"] = table["binance_spot_close"] - table["okx_close"]
        table["spread_spot_pct"] = ratio_or_nan(
            table["binance_spot_close"] - table["okx_close"], table["okx_close"]
        )
        table["spot_volume_ratio"] = ratio_or_nan(table["binance_spot_volume"], table["okx_volume"])
    else:
        table["spread_spot_close"] = pd.NA
        table["spread_spot_pct"] = pd.NA
        table["spot_volume_ratio"] = pd.NA
    if binance_um is not None:
        table = add_binance_features(table, "binance_um", ret_windows, volume_z_window)
        table["spread_um_close"] = table["binance_um_close"] - table["okx_close"]
        table["spread_um_pct"] = ratio_or_nan(
            table["binance_um_close"] - table["okx_close"], table["okx_close"]
        )
        table["um_volume_ratio"] = ratio_or_nan(table["binance_um_volume"], table["okx_volume"])
    else:
        table["spread_um_close"] = pd.NA
        table["spread_um_pct"] = pd.NA
        table["um_volume_ratio"] = pd.NA

    if "binance_um_close" in table and "binance_spot_close" in table:
        table["binance_basis_pct"] = ratio_or_nan(
            table["binance_um_close"] - table["binance_spot_close"],
            table["binance_spot_close"],
        )
        table["binance_basis_pct_z20"] = rolling_zscore(table["binance_basis_pct"], volume_z_window)
    else:
        table["binance_basis_pct"] = pd.NA
        table["binance_basis_pct_z20"] = pd.NA

    if "okx_swap_close" in table and "okx_spot_close" in table:
        table["okx_basis_pct"] = ratio_or_nan(
            table["okx_swap_close"] - table["okx_spot_close"],
            table["okx_spot_close"],
        )
    else:
        table["okx_basis_pct"] = pd.NA

    if "spread_spot_pct" in table:
        table["spread_spot_pct_z20"] = rolling_zscore(table["spread_spot_pct"], volume_z_window)
    if "spread_um_pct" in table:
        table["spread_um_pct_z20"] = rolling_zscore(table["spread_um_pct"], volume_z_window)

    ts = pd.to_datetime(table["timestamp_ms"], unit="ms", utc=True)
    table["minute_of_hour"] = ts.dt.minute.astype("int64")
    table["hour_of_day"] = ts.dt.hour.astype("int64")
    table["day_of_week"] = ts.dt.dayofweek.astype("int64")
    minute_of_day = ts.dt.hour * 60 + ts.dt.minute
    table["minute_of_day_sin"] = np.sin(2 * np.pi * minute_of_day / 1440.0)
    table["minute_of_day_cos"] = np.cos(2 * np.pi * minute_of_day / 1440.0)

    for horizon in label_horizons:
        table[f"label_ret_fwd_{horizon}m"] = table["okx_close"].shift(-horizon) / table["okx_close"] - 1.0
        table[f"label_dir_fwd_{horizon}m"] = (table[f"label_ret_fwd_{horizon}m"] > 0).astype("float").where(
            table[f"label_ret_fwd_{horizon}m"].notna()
        )
    log_ret = log_return(table["okx_close"])
    for horizon in [h for h in label_horizons if h in {5, 15}]:
        future_sq = log_ret.pow(2).shift(-1).rolling(horizon, min_periods=horizon).sum()
        table[f"label_rv_fwd_{horizon}m"] = future_sq.pow(0.5)

    warmup = max(max(rv_windows, default=1), max(sma_windows, default=1), volume_z_window, max(ret_windows, default=1), 24)
    max_label_horizon = max(label_horizons)
    if len(table) > warmup + max_label_horizon:
        table = table.iloc[warmup : len(table) - max_label_horizon].copy()

    output_path = output_root / f"okx_inst_id={anchor_symbol}" / "data.csv.zst"
    write_csv_zst(table, output_path)

    return {
        "okxInstId": anchor_symbol,
        "market": anchor_market,
        "rows": int(len(table)),
        "output": str(output_path),
        "hasBinanceSpot": bool(binance_spot_path and binance_spot_path.exists()),
        "hasBinanceUm": bool(binance_um_path and binance_um_path.exists()),
        "labelHorizons": label_horizons,
    }


def main() -> None:
    args = parse_args()
    root = Path(__file__).resolve().parents[1]
    okx_root = Path(args.okx_root)
    if not okx_root.is_absolute():
        okx_root = (root / okx_root).resolve()
    binance_root = Path(args.binance_root)
    if not binance_root.is_absolute():
        binance_root = (root / binance_root).resolve()
    output_root = Path(args.output_root)
    if not output_root.is_absolute():
        output_root = (root / output_root).resolve()
    summary_output = (
        Path(args.summary_output).resolve()
        if args.summary_output
        else (output_root / "reports" / "build_core7_feature_base.summary.json")
    )

    ret_windows = parse_int_list(args.ret_windows)
    rv_windows = parse_int_list(args.rv_windows)
    sma_windows = parse_int_list(args.sma_windows)
    label_horizons = parse_int_list(args.label_horizons)
    allowed = set(filter(None, [item.strip() for item in args.symbols.split(",")])) if args.symbols else None

    items: list[dict[str, object]] = []
    for market in ("spot", "swap"):
        market_root = okx_root / market
        if not market_root.exists():
            continue
        for symbol_dir in sorted([path for path in market_root.iterdir() if path.is_dir()]):
            symbol = symbol_dir.name
            if allowed and symbol not in allowed:
                continue
            item = build_anchor_table(
                okx_root=okx_root,
                binance_root=binance_root,
                output_root=output_root,
                anchor_symbol=symbol,
                anchor_market=market,
                ret_windows=ret_windows,
                rv_windows=rv_windows,
                sma_windows=sma_windows,
                volume_z_window=args.volume_z_window,
                label_horizons=label_horizons,
            )
            items.append(item)

    payload = {
        "schemaVersion": "core7_feature_base.summary.v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "okxRoot": str(okx_root),
        "binanceRoot": str(binance_root),
        "outputRoot": str(output_root),
        "totals": {
            "tables": len(items),
            "rows": int(sum(int(item["rows"]) for item in items)),
        },
        "items": items,
    }
    write_json(summary_output, payload)
    print(f"feature tables={len(items)} rows={payload['totals']['rows']}")
    print(f"summary={summary_output}")


if __name__ == "__main__":
    main()
