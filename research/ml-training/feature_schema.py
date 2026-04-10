from __future__ import annotations

from typing import Mapping


CANONICAL_FEATURE_NAMES = [
    "funding-rate",
    "basis",
    "volume-surge",
    "momentum-composite",
    "mean-reversion",
    "volatility-regime",
    "liquidation-pressure",
    "cross-timeframe-divergence",
    "hmm-bull-prob",
    "hmm-bear-prob",
    "hmm-calm-prob",
    "hmm-stress-prob",
    "return-1h-pct",
    "return-6h-pct",
    "return-24h-pct",
    "return-7d-pct",
    "realized-vol-pct",
    "volume-ratio",
    "rsi-proxy",
    "macd-hist-proxy",
    "bb-position-proxy",
    "atr-pct-proxy",
    "ensemble-value",
    "ensemble-confidence",
    "regime-confidence",
    "governance-total-score",
]

FEATURE_ALIASES = {
    "funding-rate": ["funding-rate", "factor_funding_rate"],
    "basis": ["basis", "factor_basis"],
    "volume-surge": ["volume-surge", "factor_volume_surge"],
    "momentum-composite": ["momentum-composite", "factor_momentum"],
    "mean-reversion": ["mean-reversion", "factor_mean_reversion"],
    "volatility-regime": ["volatility-regime", "factor_volatility_regime"],
    "liquidation-pressure": ["liquidation-pressure", "factor_liquidation_pressure"],
    "cross-timeframe-divergence": ["cross-timeframe-divergence", "factor_cross_timeframe_divergence"],
    "hmm-bull-prob": ["hmm-bull-prob"],
    "hmm-bear-prob": ["hmm-bear-prob"],
    "hmm-calm-prob": ["hmm-calm-prob"],
    "hmm-stress-prob": ["hmm-stress-prob"],
    "return-1h-pct": ["return-1h-pct", "return_1h_pct"],
    "return-6h-pct": ["return-6h-pct", "return_6h_pct"],
    "return-24h-pct": ["return-24h-pct", "return_24h_pct"],
    "return-7d-pct": ["return-7d-pct", "return_7d_pct"],
    "realized-vol-pct": ["realized-vol-pct", "realized_vol_pct"],
    "volume-ratio": ["volume-ratio", "volume_ratio"],
    "rsi-proxy": ["rsi-proxy", "rsi_proxy"],
    "macd-hist-proxy": ["macd-hist-proxy", "macd_hist_proxy"],
    "bb-position-proxy": ["bb-position-proxy", "bb_position_proxy"],
    "atr-pct-proxy": ["atr-pct-proxy", "atr_pct_proxy"],
    "ensemble-value": ["ensemble-value", "ensemble_value"],
    "ensemble-confidence": ["ensemble-confidence", "ensemble_confidence"],
    "regime-confidence": ["regime-confidence", "regime_confidence"],
    "governance-total-score": ["governance-total-score", "governance_total_score"],
}


def _float_value(record: Mapping[str, object], key: str, default: float = 0.0) -> float:
    value = record.get(key, default)
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _decision_strength_weight(confidence: float) -> float:
    if confidence >= 0.85:
        return 1.0
    if confidence >= 0.65:
        return 0.8
    if confidence >= 0.45:
        return 0.6
    if confidence >= 0.25:
        return 0.3
    return 0.0


def _derive_ensemble_features(record: Mapping[str, object]) -> tuple[float, float]:
    factor_keys = [
        ("factor_funding_rate", "conf_funding_rate"),
        ("factor_basis", "conf_basis"),
        ("factor_volume_surge", "conf_volume_surge"),
        ("factor_momentum", "conf_momentum"),
        ("factor_mean_reversion", "conf_mean_reversion"),
        ("factor_volatility_regime", "conf_volatility_regime"),
        ("factor_liquidation_pressure", "conf_liquidation_pressure"),
        ("factor_cross_timeframe_divergence", "conf_cross_timeframe_divergence"),
    ]
    weighted_sum = 0.0
    total_weight = 0.0
    signals = []
    confidences = []

    for factor_key, confidence_key in factor_keys:
        factor_value = _float_value(record, factor_key, 0.0)
        confidence = _float_value(record, confidence_key, 0.0)
        weight = _decision_strength_weight(confidence)
        weighted_sum += factor_value * weight
        total_weight += weight
        signals.append(factor_value)
        confidences.append(confidence)

    aggregate_value = weighted_sum / total_weight if total_weight > 0 else 0.0
    if not confidences:
        return aggregate_value, 0.0

    positive_count = sum(1 for value in signals if value > 0.1)
    negative_count = sum(1 for value in signals if value < -0.1)
    consensus_score = (
        1.0
        if len(signals) <= 1
        else max(0.0, min(1.0, 1 - min(positive_count, negative_count) / len(signals)))
    )
    mean_confidence = sum(confidences) / len(confidences)
    aggregate_confidence = max(0.0, min(1.0, mean_confidence * consensus_score))
    return aggregate_value, aggregate_confidence


def canonical_feature_row(record: Mapping[str, object]) -> list[float]:
    ensemble_value, ensemble_confidence = _derive_ensemble_features(record)
    derived_defaults = {
        "hmm-bull-prob": 0.0,
        "hmm-bear-prob": 0.0,
        "hmm-calm-prob": 0.0,
        "hmm-stress-prob": 0.0,
        "ensemble-value": ensemble_value,
        "ensemble-confidence": ensemble_confidence,
        "regime-confidence": 0.0,
        "governance-total-score": ensemble_confidence * 100.0,
    }

    row: list[float] = []
    for feature_name in CANONICAL_FEATURE_NAMES:
        aliases = FEATURE_ALIASES[feature_name]
        resolved = None
        for alias in aliases:
            if alias in record:
                resolved = _float_value(record, alias, 0.0)
                break
        row.append(resolved if resolved is not None else derived_defaults.get(feature_name, 0.0))
    return row
