from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass
class AlphaPoolWindow:
    start: str
    end: str


@dataclass
class AlphaPoolEntry:
    alpha_id: str
    expression: str
    source: str
    feature_names: list[str]
    train_window: AlphaPoolWindow
    test_window: AlphaPoolWindow
    oos_ic: float
    cost_adjusted_sharpe: float
    turnover: float
    regime_summary: dict
    accepted_for_runtime: bool


def build_alpha_pool_artifact(
    *,
    symbol: str,
    entries: list[AlphaPoolEntry],
    generated_at: str,
) -> dict:
    return {
        "generatedAt": generated_at,
        "artifactVersion": "v1",
        "symbol": symbol,
        "entries": [
            {
                "alphaId": entry.alpha_id,
                "expression": entry.expression,
                "source": entry.source,
                "featureNames": entry.feature_names,
                "trainWindow": asdict(entry.train_window),
                "testWindow": asdict(entry.test_window),
                "oosIc": entry.oos_ic,
                "costAdjustedSharpe": entry.cost_adjusted_sharpe,
                "turnover": entry.turnover,
                "regimeSummary": entry.regime_summary,
                "acceptedForRuntime": entry.accepted_for_runtime,
            }
            for entry in entries
        ],
    }


def save_alpha_pool_artifact(path: Path, artifact: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(artifact, indent=2), encoding="utf-8")
