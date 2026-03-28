#!/usr/bin/env python3
from __future__ import annotations

import io
import json
import math
import subprocess
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import pandas as pd


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def iso_from_ms(value: int) -> str:
    return datetime.fromtimestamp(value / 1000.0, tz=timezone.utc).isoformat()


def normalize_timestamp_ms(raw: int | str | float | None) -> int | None:
    if raw is None:
        return None
    try:
        ts = int(raw)
    except Exception:
        return None
    if ts <= 0:
        return None
    if ts < 100_000_000_000:
        ts *= 1000
    while ts > 9_999_999_999_999:
        ts //= 1000
    return ts


def read_text_from_zst(path: Path) -> str:
    proc = subprocess.run(
        ["zstd", "-q", "-d", "-c", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return proc.stdout


def read_csv_any(path: Path, **kwargs) -> pd.DataFrame:
    if "low_memory" not in kwargs:
        kwargs["low_memory"] = False
    if path.suffix == ".zst":
        content = read_text_from_zst(path)
        return pd.read_csv(io.StringIO(content), **kwargs)
    return pd.read_csv(path, **kwargs)


def write_csv_zst(df: pd.DataFrame, path: Path) -> None:
    ensure_parent(path)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", suffix=".csv", delete=False
    ) as tmp:
        df.to_csv(tmp.name, index=False)
        tmp_path = Path(tmp.name)
    try:
        subprocess.run(
            ["zstd", "-q", "-f", str(tmp_path), "-o", str(path)],
            check=True,
        )
    finally:
        tmp_path.unlink(missing_ok=True)


def write_json(path: Path, payload: object) -> None:
    ensure_parent(path)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def safe_div(num: pd.Series, den: pd.Series) -> pd.Series:
    out = num.astype(float) / den.astype(float)
    out = out.where(den.astype(float) != 0)
    return out.replace([math.inf, -math.inf], pd.NA)


def rolling_zscore(series: pd.Series, window: int) -> pd.Series:
    mean = series.rolling(window, min_periods=window).mean()
    std = series.rolling(window, min_periods=window).std(ddof=0)
    z = (series - mean) / std
    return z.where(std != 0)


def detect_okx_market(symbol: str) -> str:
    return "swap" if symbol.endswith("-SWAP") else "spot"


def okx_base_quote(symbol: str) -> tuple[str, str]:
    parts = symbol.split("-")
    if len(parts) >= 3 and parts[-1].upper() == "SWAP":
        return parts[0].upper(), parts[1].upper()
    if len(parts) >= 2:
        return parts[0].upper(), parts[1].upper()
    raise ValueError(f"Cannot parse OKX symbol: {symbol}")


def list_symbol_dirs(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return sorted([path for path in root.iterdir() if path.is_dir()])


def read_first_zip_member_lines(path: Path) -> tuple[str, list[str]]:
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        if not names:
            raise ValueError(f"Zip archive has no members: {path}")
        member = names[0]
        with zf.open(member, "r") as raw:
            lines = raw.read().decode("utf-8", errors="ignore").splitlines()
    return member, lines


def parse_bool(text: str | None, default: bool = False) -> bool:
    if text is None:
        return default
    lowered = str(text).strip().lower()
    if lowered in {"1", "true", "yes", "y", "on"}:
        return True
    if lowered in {"0", "false", "no", "n", "off"}:
        return False
    return default


def parse_csv_list(raw: str | None) -> list[str]:
    if not raw:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for token in raw.split(","):
        value = token.strip()
        if not value or value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out
