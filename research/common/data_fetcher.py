"""Shared data fetcher for OpenAlice research pipelines.

Primary source:
- Gate.io perpetual swap via ccxt

Fallback:
- CryptoCompare OHLCV only

This module is the research truth source for:
- OHLCV / funding ingestion
- factor computation
- regime proxy partitioning
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd

try:
    import ccxt
except ImportError as exc:
    raise ImportError("ccxt is required: pip install ccxt") from exc

CACHE_DIR = Path(__file__).resolve().parent.parent / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

FUNDING_RATE_WINDOW = 30
VOLUME_WINDOW = 24
REALIZED_VOL_WINDOW = 24
VOL_OF_VOL_WINDOW = 24
CONSECUTIVE_HIGH_VOL_LOOKBACK = 24
CRYPTOCOMPARE_LIMIT = 2000

DEFAULT_SWAP_EXCHANGE = "gate"
DEFAULT_SWAP_SYMBOL = "BTC/USDT:USDT"


def _cache_key(exchange: str, symbol: str, timeframe: str, start: str, end: str, market_type: str) -> str:
    safe = symbol.replace("/", "_").replace(":", "_")
    return f"{exchange}_{market_type}_{safe}_{timeframe}_{start}_{end}.parquet"


def _clamp(value: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, value))


def _safe_zscore(value: float, mean: float, std: float) -> float:
    if not np.isfinite(std) or std <= 1e-12:
        return 0.0
    return (value - mean) / std


def _normalize_symbol(symbol: str, market_type: str) -> str:
    if market_type == "swap":
        if ":" in symbol:
            return symbol
        if symbol.upper() == "BTC/USDT":
            return "BTC/USDT:USDT"
    return symbol


def _build_exchange(exchange_id: str, market_type: str):
    exchange_cls = getattr(ccxt, exchange_id, None)
    if exchange_cls is None:
        raise ValueError(f"Unknown exchange: {exchange_id}")
    return exchange_cls(
        {
            "enableRateLimit": True,
            "options": {
                "defaultType": market_type,
            },
        }
    )


def _fetch_cryptocompare_ohlcv(
    symbol: str,
    timeframe: str,
    start_date: str,
    end_date: str,
) -> pd.DataFrame:
    if timeframe != "1h":
      raise RuntimeError("CryptoCompare fallback only supports 1h timeframe.")
    base, quote = symbol.split("/")[0], "USDT"
    start_ts = int(pd.Timestamp(f"{start_date}T00:00:00Z").timestamp())
    current_to_ts = int(pd.Timestamp(f"{end_date}T23:59:59Z").timestamp())
    frames: list[pd.DataFrame] = []

    while current_to_ts >= start_ts:
        params = urlencode(
            {
                "fsym": base,
                "tsym": quote,
                "limit": CRYPTOCOMPARE_LIMIT,
                "toTs": current_to_ts,
            }
        )
        request = Request(
            f"https://min-api.cryptocompare.com/data/v2/histohour?{params}",
            headers={"User-Agent": "OpenAliceResearch/1.0"},
        )
        with urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
        rows = payload.get("Data", {}).get("Data", [])
        if not rows:
            break
        frame = pd.DataFrame(rows)
        frame["time"] = pd.to_datetime(frame["time"], unit="s", utc=True)
        frame = frame.rename(columns={"volumefrom": "volume"})
        frames.append(frame[["time", "open", "high", "low", "close", "volume"]])
        earliest_ts = int(frame["time"].min().timestamp())
        if earliest_ts <= start_ts or len(rows) < CRYPTOCOMPARE_LIMIT:
            break
        current_to_ts = earliest_ts - 1

    if not frames:
        raise RuntimeError("CryptoCompare fallback returned no OHLCV rows.")

    df = pd.concat(frames, ignore_index=True)
    df = df.drop_duplicates(subset=["time"]).sort_values("time")
    df = df.loc[
        (df["time"] >= pd.Timestamp(f"{start_date}T00:00:00Z"))
        & (df["time"] <= pd.Timestamp(f"{end_date}T23:59:59Z"))
    ]
    return df.set_index("time")


def fetch_ohlcv(
    symbol: str = DEFAULT_SWAP_SYMBOL,
    timeframe: str = "1h",
    start_date: str = "2024-01-01",
    end_date: str = "2025-12-31",
    exchange_id: str = DEFAULT_SWAP_EXCHANGE,
    market_type: str = "swap",
    use_cache: bool = True,
    allow_cryptocompare_fallback: bool = True,
) -> pd.DataFrame:
    cache_path = CACHE_DIR / _cache_key(exchange_id, symbol, timeframe, start_date, end_date, market_type)
    if use_cache and cache_path.exists():
        df = pd.read_parquet(cache_path)
        expected_start = pd.Timestamp(f"{start_date}T00:00:00Z")
        expected_end = pd.Timestamp(f"{end_date}T23:59:59Z")
        if not df.empty and df.index.min() <= expected_start and df.index.max() >= expected_end.floor("1h"):
            df.attrs["ohlcv_source"] = "cache"
            df.attrs["requested_start"] = start_date
            df.attrs["requested_end"] = end_date
            print(f"[cache] loaded {len(df)} candles from {cache_path.name}")
            return df
        print(
            f"[cache] ignoring incomplete OHLCV cache {cache_path.name} "
            f"({df.index.min()} -> {df.index.max()})"
        )

    normalized_symbol = _normalize_symbol(symbol, market_type)
    since = int(pd.Timestamp(f"{start_date}T00:00:00Z").timestamp() * 1000)
    end_ms = int(pd.Timestamp(f"{end_date}T23:59:59Z").timestamp() * 1000)

    try:
        ex = _build_exchange(exchange_id, market_type)
        source = f"ccxt:{exchange_id}"
        all_candles: list[list] = []
        while since < end_ms:
            candles = ex.fetch_ohlcv(normalized_symbol, timeframe, since=since, limit=1000)
            if not candles:
                break
            all_candles.extend(candles)
            since = candles[-1][0] + 1
            time.sleep(ex.rateLimit / 1000)
        df = pd.DataFrame(all_candles, columns=["time", "open", "high", "low", "close", "volume"])
        df["time"] = pd.to_datetime(df["time"], unit="ms", utc=True)
        df = df.drop_duplicates(subset=["time"]).sort_values("time").reset_index(drop=True)
        df = df.set_index("time")
    except Exception as exc:
        if not allow_cryptocompare_fallback:
            raise
        spot_symbol = symbol.split(":")[0]
        print(f"[fallback] ccxt swap OHLCV failed ({exc}); trying CryptoCompare for {spot_symbol}")
        source = "cryptocompare"
        df = _fetch_cryptocompare_ohlcv(spot_symbol, timeframe, start_date, end_date)
        df = df.loc[(df.index >= f"{start_date}T00:00:00Z") & (df.index <= f"{end_date}T23:59:59Z")]

    df.attrs["ohlcv_source"] = source
    df.attrs["requested_start"] = start_date
    df.attrs["requested_end"] = end_date

    if use_cache:
        df.to_parquet(cache_path)
        print(f"[cache] saved {len(df)} candles to {cache_path.name}")
    return df


def fetch_funding_rate(
    symbol: str = DEFAULT_SWAP_SYMBOL,
    start_date: str = "2024-01-01",
    end_date: str = "2025-12-31",
    exchange_id: str = DEFAULT_SWAP_EXCHANGE,
    market_type: str = "swap",
    use_cache: bool = True,
) -> pd.DataFrame:
    cache_path = CACHE_DIR / f"funding_{exchange_id}_{market_type}_{symbol.replace('/', '_').replace(':', '_')}_{start_date}_{end_date}.parquet"
    if use_cache and cache_path.exists():
        df = pd.read_parquet(cache_path)
        df.attrs["funding_source"] = "cache"
        df.attrs["requested_start"] = start_date
        df.attrs["requested_end"] = end_date
        print(f"[cache] loaded {len(df)} funding rates from {cache_path.name}")
        return df

    ex = _build_exchange(exchange_id, market_type)
    normalized_symbol = _normalize_symbol(symbol, market_type)
    since = int(pd.Timestamp(f"{start_date}T00:00:00Z").timestamp() * 1000)
    end_ms = int(pd.Timestamp(f"{end_date}T23:59:59Z").timestamp() * 1000)

    all_rates: list[dict] = []
    while since < end_ms:
        rates = ex.fetch_funding_rate_history(normalized_symbol, since=since, limit=1000)
        if not rates:
            break
        all_rates.extend(rates)
        since = int(rates[-1]["timestamp"]) + 1
        time.sleep(ex.rateLimit / 1000)

    df = pd.DataFrame(all_rates)
    if df.empty:
        raise RuntimeError(
            f"Funding history is empty for {exchange_id}:{normalized_symbol}. Research pipeline cannot continue."
        )

    df["funding_time"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
    df["funding_rate"] = df["fundingRate"].astype(float)
    df = df[["funding_time", "funding_rate"]].drop_duplicates(subset=["funding_time"])
    df = df.sort_values("funding_time").reset_index(drop=True)
    df.attrs["funding_source"] = f"ccxt:{exchange_id}"
    df.attrs["requested_start"] = start_date
    df.attrs["requested_end"] = end_date

    if use_cache:
        df.to_parquet(cache_path)
        print(f"[cache] saved {len(df)} funding rates to {cache_path.name}")
    return df


def merge_ohlcv_funding(ohlcv: pd.DataFrame, funding: pd.DataFrame) -> pd.DataFrame:
    df = ohlcv.copy()
    funding_indexed = funding.set_index("funding_time")
    df["funding_rate"] = funding_indexed["funding_rate"].reindex(
        df.index, method="ffill"
    ).fillna(0)
    return df


def compute_derived_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()

    df["return_1h_pct"] = df["close"].pct_change(1) * 100
    df["return_6h_pct"] = df["close"].pct_change(6) * 100
    df["return_24h_pct"] = df["close"].pct_change(24) * 100
    df["return_7d_pct"] = df["close"].pct_change(168) * 100

    log_returns = np.log(df["close"] / df["close"].shift(1))
    df["realized_vol_pct"] = (
        log_returns.rolling(REALIZED_VOL_WINDOW).std() * np.sqrt(24 * 365) * 100
    )
    df["previous_realized_vol_pct"] = df["realized_vol_pct"].shift(24)
    df["vol_of_vol_pct"] = df["realized_vol_pct"].rolling(VOL_OF_VOL_WINDOW).std()

    df["avg_volume"] = df["volume"].rolling(VOLUME_WINDOW).mean()
    df["volume_ratio"] = df["volume"] / df["avg_volume"].clip(lower=1e-12)
    df["volume_change_rate"] = df["volume_ratio"] - 1

    df["funding_rate_mean"] = df["funding_rate"].rolling(FUNDING_RATE_WINDOW).mean()
    df["funding_rate_std"] = df["funding_rate"].rolling(FUNDING_RATE_WINDOW).std()
    df["funding_rate_zscore"] = (
        (df["funding_rate"] - df["funding_rate_mean"]) /
        df["funding_rate_std"].clip(lower=1e-12)
    ).fillna(0)

    return df


def compute_funding_rate_factor(current_rate_pct: float, rolling_mean_pct: float, rolling_std_pct: float) -> tuple[float, float]:
    z = _safe_zscore(current_rate_pct, rolling_mean_pct, rolling_std_pct)
    return _clamp(-z / 3, -1, 1), _clamp(abs(z) / 3, 0, 1)


def compute_basis_factor(futures_price: float, spot_price: float, rolling_mean_pct: float | None = None, rolling_std_pct: float | None = None) -> tuple[float, float]:
    basis_pct = (futures_price / spot_price - 1) * 100
    z = _safe_zscore(basis_pct, rolling_mean_pct, rolling_std_pct) if rolling_mean_pct is not None and rolling_std_pct is not None else basis_pct / 5
    return _clamp(-z / 3, -1, 1), _clamp(abs(z) / 3, 0, 1)


def compute_volume_surge_factor(current_volume: float, average_volume: float, price_return_pct: float) -> tuple[float, float]:
    surge_ratio = current_volume / max(average_volume, 1e-12)
    surge_strength = _clamp((surge_ratio - 1) / 2, 0, 1)
    return_strength = _clamp(abs(price_return_pct) / 5, 0, 1)
    direction = 1 if price_return_pct >= 0 else -1
    return _clamp(direction * max(surge_strength, return_strength), -1, 1), _clamp((surge_strength + return_strength) / 2, 0, 1)


def compute_momentum_composite(return_1h: float, return_6h: float, return_24h: float, return_7d: float, realized_vol_pct: float | None = None) -> tuple[float, float]:
    weighted = return_1h * 0.15 + return_6h * 0.20 + return_24h * 0.30 + return_7d * 0.35
    normalized = _clamp(weighted / 8, -1, 1)
    vol_penalty = _clamp(1 - (realized_vol_pct or 0) / 20, 0.2, 1) if realized_vol_pct is not None else 1.0
    return normalized, _clamp(abs(normalized) * vol_penalty, 0, 1)


def compute_mean_reversion_factor(momentum_value: float, momentum_confidence: float) -> tuple[float, float]:
    return -momentum_value, momentum_confidence


def compute_volatility_regime_factor(
    realized_vol_pct: float,
    previous_realized_vol_pct: float,
    vol_of_vol_pct: float,
    consecutive_high_vol: float,
    weights: tuple[float, float, float] = (1 / 3, 1 / 3, 1 / 3),
) -> tuple[float, float, dict]:
    vol_expansion = _clamp(
        (realized_vol_pct / max(previous_realized_vol_pct, 1e-6) - 1) / 2,
        -1,
        1,
    )
    vol_clustering = _clamp(consecutive_high_vol / 12, 0, 1)
    vol_of_vol_score = _clamp(vol_of_vol_pct / 5, 0, 1)
    stress_score = (
        weights[0] * max(vol_expansion, 0) +
        weights[1] * vol_clustering +
        weights[2] * vol_of_vol_score
    )
    value = _clamp(-stress_score, -1, 1)
    confidence = _clamp((abs(vol_expansion) + vol_clustering + vol_of_vol_score) / 3, 0, 1)
    return value, confidence, {
        "vol_expansion": vol_expansion,
        "vol_clustering": vol_clustering,
        "vol_of_vol_score": vol_of_vol_score,
    }


def compute_liquidation_pressure_factor(
    funding_rate_zscore: float,
    volume_surge_strength: float,
    vol_expansion_score: float,
    price_return_pct: float,
    open_interest_pressure: float = 0.0,
    weights: tuple[float, float, float] = (1 / 3, 1 / 3, 1 / 3),
) -> tuple[float, float, dict]:
    funding_pressure = _clamp(abs(funding_rate_zscore) / 3, 0, 1) * (-1 if funding_rate_zscore >= 0 else 1)
    cascade_pressure = _clamp(volume_surge_strength * vol_expansion_score, 0, 1) * (-1 if price_return_pct >= 0 else 1)
    oi_pressure = _clamp(open_interest_pressure, -1, 1)
    value = _clamp(
        weights[0] * funding_pressure +
        weights[1] * cascade_pressure +
        weights[2] * oi_pressure,
        -1,
        1,
    )
    confidence = _clamp((abs(funding_pressure) + abs(cascade_pressure) + abs(oi_pressure)) / 3, 0, 1)
    return value, confidence, {
        "funding_pressure": funding_pressure,
        "cascade_pressure": cascade_pressure,
        "oi_pressure": oi_pressure,
    }


def compute_cross_timeframe_divergence_factor(return_1h: float, return_6h: float, return_24h: float, return_7d: float) -> tuple[float, float]:
    short_term = return_1h * 0.5 + return_6h * 0.5
    long_term = return_24h * 0.4 + return_7d * 0.6
    baseline_sign = np.sign(long_term if long_term != 0 else short_term) or 1
    divergence = baseline_sign * (short_term - long_term)
    same_direction = np.sign(short_term) == np.sign(long_term) or short_term == 0 or long_term == 0
    value = _clamp(divergence / 10, -1, 1)
    confidence = _clamp(abs(short_term - long_term) / 5 + (0 if same_direction else 0.2), 0, 1)
    return value, confidence


def _compute_consecutive_high_vol(realized_vol: pd.Series) -> pd.Series:
    rolling_median = realized_vol.rolling(CONSECUTIVE_HIGH_VOL_LOOKBACK).median()
    output = []
    streak = 0
    for current, median in zip(realized_vol.fillna(0), rolling_median.fillna(np.inf)):
        if current > median:
            streak += 1
        else:
            streak = 0
        output.append(streak)
    return pd.Series(output, index=realized_vol.index)


def _compute_regime_proxy_states(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    return_mean = df["return_1h_pct"].rolling(48).mean()
    return_std = df["return_1h_pct"].rolling(48).std().clip(lower=1e-12)
    vol_mean = df["realized_vol_pct"].rolling(48).mean()
    vol_std = df["realized_vol_pct"].rolling(48).std().clip(lower=1e-12)
    volume_mean = df["volume_change_rate"].rolling(48).mean()
    volume_std = df["volume_change_rate"].rolling(48).std().clip(lower=1e-12)

    df["return_1h_zscore"] = ((df["return_1h_pct"] - return_mean) / return_std).fillna(0)
    df["realized_vol_zscore"] = ((df["realized_vol_pct"] - vol_mean) / vol_std).fillna(0)
    df["volume_change_zscore"] = ((df["volume_change_rate"] - volume_mean) / volume_std).fillna(0)

    states: list[str] = []
    state_ids: list[int] = []
    for _, row in df.iterrows():
        if row["realized_vol_zscore"] >= 1 or row["volume_change_zscore"] >= 1:
            state = ("stress", 3)
        elif row["return_1h_zscore"] >= 0.4 and row["realized_vol_zscore"] <= 0.5:
            state = ("bull", 0)
        elif row["return_1h_zscore"] <= -0.4:
            state = ("bear", 1)
        elif abs(row["return_1h_zscore"]) <= 0.25 and row["realized_vol_zscore"] <= 0.2:
            state = ("calm", 2)
        else:
            state = ("bull", 0) if row["return_1h_zscore"] >= 0 else ("bear", 1)
        states.append(state[0])
        state_ids.append(state[1])
    df["regime_state"] = states
    df["regime_state_id"] = state_ids
    return df


def compute_all_factors(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()

    fr_val, fr_conf = [], []
    for _, row in df.iterrows():
        value, confidence = compute_funding_rate_factor(
            row.get("funding_rate", 0) * 100,
            row.get("funding_rate_mean", 0) * 100,
            row.get("funding_rate_std", 0) * 100,
        )
        fr_val.append(value)
        fr_conf.append(confidence)
    df["factor_funding_rate"] = fr_val
    df["conf_funding_rate"] = fr_conf

    df["basis_pct"] = df["funding_rate"] * 100 * 3
    df["basis_mean"] = df["basis_pct"].rolling(FUNDING_RATE_WINDOW).mean()
    df["basis_std"] = df["basis_pct"].rolling(FUNDING_RATE_WINDOW).std()
    bs_val, bs_conf = [], []
    for _, row in df.iterrows():
        value, confidence = compute_basis_factor(
            1.0 + row.get("basis_pct", 0) / 100,
            1.0,
            row.get("basis_mean", 0),
            row.get("basis_std", 1),
        )
        bs_val.append(value)
        bs_conf.append(confidence)
    df["factor_basis"] = bs_val
    df["conf_basis"] = bs_conf

    vs_val, vs_conf = [], []
    volume_surge_strength = []
    for _, row in df.iterrows():
        value, confidence = compute_volume_surge_factor(
            row.get("volume", 0),
            row.get("avg_volume", 0),
            row.get("return_1h_pct", 0),
        )
        vs_val.append(value)
        vs_conf.append(confidence)
        volume_surge_strength.append(_clamp((row.get("volume_ratio", 1) - 1) / 2, 0, 1))
    df["factor_volume_surge"] = vs_val
    df["conf_volume_surge"] = vs_conf
    df["volume_surge_strength"] = volume_surge_strength

    mom_val, mom_conf = [], []
    for _, row in df.iterrows():
        value, confidence = compute_momentum_composite(
            row.get("return_1h_pct", 0) or 0,
            row.get("return_6h_pct", 0) or 0,
            row.get("return_24h_pct", 0) or 0,
            row.get("return_7d_pct", 0) or 0,
            row.get("realized_vol_pct", None),
        )
        mom_val.append(value)
        mom_conf.append(confidence)
    df["factor_momentum"] = mom_val
    df["conf_momentum"] = mom_conf

    mr_val, mr_conf = [], []
    for momentum_value, momentum_confidence in zip(df["factor_momentum"], df["conf_momentum"]):
        value, confidence = compute_mean_reversion_factor(momentum_value, momentum_confidence)
        mr_val.append(value)
        mr_conf.append(confidence)
    df["factor_mean_reversion"] = mr_val
    df["conf_mean_reversion"] = mr_conf

    df["consecutive_high_vol"] = _compute_consecutive_high_vol(df["realized_vol_pct"])
    vr_val, vr_conf = [], []
    for _, row in df.iterrows():
        value, confidence, _ = compute_volatility_regime_factor(
            row.get("realized_vol_pct", 0) or 0,
            row.get("previous_realized_vol_pct", row.get("realized_vol_pct", 0)) or 0,
            row.get("vol_of_vol_pct", 0) or 0,
            row.get("consecutive_high_vol", 0) or 0,
        )
        vr_val.append(value)
        vr_conf.append(confidence)
    df["factor_volatility_regime"] = vr_val
    df["conf_volatility_regime"] = vr_conf

    vol_expansion_score = (
        (df["realized_vol_pct"] / df["previous_realized_vol_pct"].clip(lower=1e-6) - 1) / 2
    ).clip(lower=0, upper=1).fillna(0)
    lp_val, lp_conf = [], []
    for _, row in df.iterrows():
        value, confidence, _ = compute_liquidation_pressure_factor(
            row.get("funding_rate_zscore", 0) or 0,
            row.get("volume_surge_strength", 0) or 0,
            row.get("vol_expansion_score", 0) or 0,
            row.get("return_1h_pct", 0) or 0,
        )
        lp_val.append(value)
        lp_conf.append(confidence)
    df["vol_expansion_score"] = vol_expansion_score
    df["factor_liquidation_pressure"] = lp_val
    df["conf_liquidation_pressure"] = lp_conf

    ctd_val, ctd_conf = [], []
    for _, row in df.iterrows():
        value, confidence = compute_cross_timeframe_divergence_factor(
            row.get("return_1h_pct", 0) or 0,
            row.get("return_6h_pct", 0) or 0,
            row.get("return_24h_pct", 0) or 0,
            row.get("return_7d_pct", 0) or 0,
        )
        ctd_val.append(value)
        ctd_conf.append(confidence)
    df["factor_cross_timeframe_divergence"] = ctd_val
    df["conf_cross_timeframe_divergence"] = ctd_conf

    df["rsi_proxy"] = df.apply(
        lambda r: _clamp(50 + (r.get("return_24h_pct", 0) + r.get("return_7d_pct", 0) * 0.25) * 2, 0, 100),
        axis=1,
    )
    df["macd_hist_proxy"] = df["return_24h_pct"] - df["return_7d_pct"] / 7
    df["bb_position_proxy"] = df.apply(
        lambda r: _clamp(0.5 + r.get("return_24h_pct", 0) / (max(r.get("realized_vol_pct", 1), 1e-6) * 4), 0, 1),
        axis=1,
    )
    df["atr_pct_proxy"] = df["realized_vol_pct"].fillna(0) / np.sqrt(24 * 365)

    df = _compute_regime_proxy_states(df)
    return df


def dataset_quality_report(df: pd.DataFrame) -> dict:
    factor_cols = [column for column in df.columns if column.startswith("factor_")]
    return {
        "row_count": int(len(df)),
        "ohlcv_source": df.attrs.get("ohlcv_source"),
        "funding_source": df.attrs.get("funding_source"),
        "requested_start": df.attrs.get("requested_start"),
        "requested_end": df.attrs.get("requested_end"),
        "raw_start": df.attrs.get("raw_start"),
        "raw_end": df.attrs.get("raw_end"),
        "dataset_start": df.index.min().isoformat() if not df.empty else None,
        "dataset_end": df.index.max().isoformat() if not df.empty else None,
        "coverage_ok": bool(df.attrs.get("coverage_ok", False)),
        "funding_non_zero_ratio": float((df["funding_rate"].abs() > 1e-12).mean()) if "funding_rate" in df else 0.0,
        "basis_non_zero_ratio": float((df["factor_basis"].abs() > 1e-12).mean()) if "factor_basis" in df else 0.0,
        "missing_ratio": {
            column: float(df[column].isna().mean())
            for column in factor_cols + ["funding_rate", "close"]
            if column in df.columns
        },
        "factor_distribution": {
            column: {
                "mean": float(df[column].mean()),
                "std": float(df[column].std(ddof=0)),
                "min": float(df[column].min()),
                "max": float(df[column].max()),
            }
            for column in factor_cols
        },
    }


def prepare_research_dataset(
    symbol: str = DEFAULT_SWAP_SYMBOL,
    timeframe: str = "1h",
    start_date: str = "2024-01-01",
    end_date: str = "2025-12-31",
    exchange_id: str = DEFAULT_SWAP_EXCHANGE,
) -> pd.DataFrame:
    print(f"Fetching {symbol} {timeframe} from {exchange_id} swap ({start_date} to {end_date})...")
    ohlcv = fetch_ohlcv(symbol, timeframe, start_date, end_date, exchange_id, market_type="swap")
    print(f"  OHLCV: {len(ohlcv)} candles")

    funding = fetch_funding_rate(symbol, start_date, end_date, exchange_id, market_type="swap")
    print(f"  Funding: {len(funding)} records")

    df = merge_ohlcv_funding(ohlcv, funding)
    df = compute_derived_features(df)
    df = compute_all_factors(df)

    warmup = max(168, FUNDING_RATE_WINDOW, VOLUME_WINDOW, REALIZED_VOL_WINDOW, VOL_OF_VOL_WINDOW)
    df = df.iloc[warmup:].copy()
    requested_start_ts = pd.Timestamp(f"{start_date}T00:00:00Z")
    requested_end_ts = pd.Timestamp(f"{end_date}T23:59:59Z")
    raw_start = ohlcv.index.min().isoformat() if not ohlcv.empty else None
    raw_end = ohlcv.index.max().isoformat() if not ohlcv.empty else None
    coverage_ok = (
        not ohlcv.empty
        and ohlcv.index.min() <= requested_start_ts
        and ohlcv.index.max() >= requested_end_ts.floor("1h")
    )
    df.attrs["ohlcv_source"] = ohlcv.attrs.get("ohlcv_source")
    df.attrs["funding_source"] = funding.attrs.get("funding_source")
    df.attrs["requested_start"] = start_date
    df.attrs["requested_end"] = end_date
    df.attrs["raw_start"] = raw_start
    df.attrs["raw_end"] = raw_end
    df.attrs["coverage_ok"] = coverage_ok
    print(f"  Final dataset: {len(df)} rows, {len(df.columns)} columns")
    return df


def save_dataset(df: pd.DataFrame, name: str) -> Path:
    csv_path = CACHE_DIR / f"{name}.csv"
    parquet_path = CACHE_DIR / f"{name}.parquet"
    df.to_csv(csv_path)
    df.to_parquet(parquet_path)
    print(f"  Saved: {csv_path.name} ({len(df)} rows)")
    return csv_path


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Fetch and prepare research dataset")
    parser.add_argument("--symbol", default=DEFAULT_SWAP_SYMBOL)
    parser.add_argument("--timeframe", default="1h")
    parser.add_argument("--start", default="2024-01-01")
    parser.add_argument("--end", default="2025-12-31")
    parser.add_argument("--exchange", default=DEFAULT_SWAP_EXCHANGE)
    parser.add_argument("--output", default="research_dataset")
    args = parser.parse_args()

    df = prepare_research_dataset(args.symbol, args.timeframe, args.start, args.end, args.exchange)
    save_dataset(df, args.output)
    print(json.dumps(dataset_quality_report(df), indent=2))
