#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


VALID_MARKETS = ("spot", "swap")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a strict OKX core symbol set from catalog metadata."
    )
    parser.add_argument(
        "--catalog",
        default="data/market/okx_historical/catalog/usdt_all.v1.json",
        help="Path to OKX catalog JSON.",
    )
    parser.add_argument(
        "--bases",
        required=True,
        help="Comma-separated base assets, e.g. BTC,ETH,SOL.",
    )
    parser.add_argument(
        "--quote",
        default="USDT",
        help="Quote asset (default: USDT).",
    )
    parser.add_argument(
        "--markets",
        default="spot,swap",
        help="Comma-separated market list in output order (spot,swap).",
    )
    parser.add_argument(
        "--require-live",
        default="true",
        choices=("true", "false"),
        help="Require matched instruments to be live.",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Output text path (one instId per line).",
    )
    parser.add_argument(
        "--metadata-output",
        default="",
        help="Optional metadata JSON output path.",
    )
    return parser.parse_args()


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_csv_list(raw: str) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for token in raw.split(","):
        value = token.strip()
        if not value:
            continue
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def parse_bases(raw: str) -> list[str]:
    bases = [token.upper() for token in parse_csv_list(raw)]
    if not bases:
        raise ValueError("--bases must include at least one asset.")
    return bases


def parse_markets(raw: str) -> list[str]:
    markets = [token.lower() for token in parse_csv_list(raw)]
    if not markets:
        raise ValueError("--markets must include at least one market.")
    invalid = [value for value in markets if value not in VALID_MARKETS]
    if invalid:
        raise ValueError(f"Unsupported markets: {', '.join(invalid)}")
    return markets


def parse_bool(raw: str) -> bool:
    return str(raw).strip().lower() == "true"


def normalize_inst_type(raw: Any) -> str:
    text = str(raw or "").strip().upper()
    if text == "SWAP":
        return "swap"
    return "spot"


def parse_list_time_ms(raw: Any) -> int | None:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text or not text.isdigit():
        return None
    value = int(text)
    return value if value > 0 else None


def iso_from_ms(value: int | None) -> str | None:
    if value is None:
        return None
    return datetime.fromtimestamp(value / 1000.0, tz=timezone.utc).isoformat()


def load_catalog(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    items = payload.get("items", [])
    return items if isinstance(items, list) else []


def expected_inst_id(base: str, quote: str, market: str) -> str:
    if market == "swap":
        return f"{base}-{quote}-SWAP"
    return f"{base}-{quote}"


def main() -> None:
    args = parse_args()
    root = repo_root()
    catalog_path = Path(args.catalog)
    if not catalog_path.is_absolute():
        catalog_path = (root / catalog_path).resolve()
    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = (root / output_path).resolve()

    metadata_output_path: Path | None = None
    if args.metadata_output:
        metadata_output_path = Path(args.metadata_output)
        if not metadata_output_path.is_absolute():
            metadata_output_path = (root / metadata_output_path).resolve()

    quote = str(args.quote).strip().upper()
    bases = parse_bases(args.bases)
    markets = parse_markets(args.markets)
    require_live = parse_bool(args.require_live)

    catalog = load_catalog(catalog_path)
    by_inst_id: dict[str, dict[str, Any]] = {}
    for row in catalog:
        inst_id = str(row.get("instId", "")).strip()
        if inst_id:
            by_inst_id[inst_id] = row

    selected_ids: list[str] = []
    selected_meta: list[dict[str, Any]] = []
    errors: list[str] = []

    for base in bases:
        for market in markets:
            inst_id = expected_inst_id(base, quote, market)
            row = by_inst_id.get(inst_id)
            if row is None:
                errors.append(f"Missing instrument for base={base} market={market}: {inst_id}")
                continue

            state = str(row.get("state", "")).strip().lower() or "unknown"
            if require_live and state != "live":
                errors.append(
                    f"Instrument is not live for base={base} market={market}: {inst_id} state={state}"
                )
                continue

            inst_type = normalize_inst_type(row.get("instType"))
            if inst_type != market:
                errors.append(
                    f"Instrument type mismatch for {inst_id}: expected={market} actual={inst_type}"
                )
                continue

            list_time_ms = parse_list_time_ms(row.get("listTime"))
            selected_ids.append(inst_id)
            selected_meta.append(
                {
                    "base": base,
                    "quote": quote,
                    "market": market,
                    "instId": inst_id,
                    "instType": str(row.get("instType", "")).strip().upper(),
                    "state": state,
                    "listTime": str(row.get("listTime", "")).strip() or None,
                    "listTimeMs": list_time_ms,
                    "listTimeIso": iso_from_ms(list_time_ms),
                }
            )

    if errors:
        raise SystemExit("\n".join(errors))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(selected_ids) + "\n", encoding="utf-8")

    if metadata_output_path is not None:
        metadata_output_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schemaVersion": "okx_core_symbol_set.v1",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "catalogPath": str(catalog_path),
            "params": {
                "bases": bases,
                "quote": quote,
                "markets": markets,
                "requireLive": require_live,
            },
            "totals": {
                "bases": len(bases),
                "instIds": len(selected_ids),
            },
            "items": selected_meta,
        }
        metadata_output_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )


if __name__ == "__main__":
    main()
