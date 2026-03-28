#!/usr/bin/env python3
"""Compile a ranked hypothesis backlog from research digest + G3/G4 breakdown."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple


DEFAULT_SCAN = "data/research/strategy-watch/latest_digest.json"
DEFAULT_BREAKDOWN = (
    "data/research/strategy/analysis/g3g4/latest_strategy_g3g4_breakdown.json"
)
DEFAULT_SHORTLIST = "data/research/fdr/frontier_shortlist.latest.v1.json"
DEFAULT_OUTPUT = "data/research/hypotheses/backlog.v1.json"
DEFAULT_MAX_ITEMS = 30


TAG_HINTS: Dict[str, Dict[str, str]] = {
    "regime_detection": {
        "actionHint": (
            "Strengthen regime segmentation (change-point/HMM) and compare against "
            "the current baseline."
        ),
        "expectedImpact": "Reduce regime-shift drawdowns and improve out-of-sample stability.",
        "targetMetric": "wfoFailureDensity",
        "testPlan": (
            "Run an A/B ablation with the current regime logic vs upgraded segmentation "
            "across identical seeds and windows."
        ),
    },
    "cost_execution": {
        "actionHint": (
            "Refine transaction-cost and slippage modeling, then retest under "
            "liquidity-stress windows."
        ),
        "expectedImpact": "Lower execution drift and improve net-of-cost robustness.",
        "targetMetric": "net_trim10_mean",
        "testPlan": (
            "Replay with tightened slippage/latency assumptions and verify robustness "
            "delta vs baseline."
        ),
    },
    "risk_control": {
        "actionHint": (
            "Increase tail-risk controls (CVaR/ES constraints and dynamic position caps)."
        ),
        "expectedImpact": "Reduce tail losses while preserving acceptable return efficiency.",
        "targetMetric": "fdrQ",
        "testPlan": (
            "Introduce risk-control toggles and compare drawdown/fdr/wfo trade-offs "
            "with the current protocol."
        ),
    },
    "online_learning": {
        "actionHint": "Shorten retrain cadence with warm-start updates under drift triggers.",
        "expectedImpact": "Improve adaptation under non-stationary market conditions.",
        "targetMetric": "wfoFailureDensity",
        "testPlan": "Evaluate fixed cadence vs drift-triggered retraining over identical periods.",
    },
    "feature_engineering": {
        "actionHint": "Add and ablate high-information feature groups before full rollout.",
        "expectedImpact": "Increase signal quality while controlling complexity and turnover.",
        "targetMetric": "robust_mean",
        "testPlan": (
            "Run feature-group ablations with strict cost parity and keep only positive "
            "contributors."
        ),
    },
    "rl_policy": {
        "actionHint": (
            "Layer a lightweight policy optimizer (contextual bandit/RL head) over "
            "existing signals."
        ),
        "expectedImpact": "Improve action timing and risk-adjusted execution quality.",
        "targetMetric": "robust_ci_lb95",
        "testPlan": "Compare supervised baseline vs policy-augmented variant under same controls.",
    },
    "uncertainty_calibration": {
        "actionHint": (
            "Calibrate confidence outputs (temperature/isotonic) and gate entries by "
            "calibrated uncertainty."
        ),
        "expectedImpact": "Reduce false-positive entries and improve robustness under shift.",
        "targetMetric": "fdrQ",
        "testPlan": (
            "Benchmark calibration methods and keep variants that improve confidence-error "
            "and downstream performance."
        ),
    },
    "macro_news": {
        "actionHint": (
            "Inject event/news features only in volatility-sensitive regimes with strict "
            "latency controls."
        ),
        "expectedImpact": "Capture event-driven edge without destabilizing baseline behavior.",
        "targetMetric": "lift_pos_mean",
        "testPlan": (
            "Run event-feature on/off experiments over volatile windows and inspect cost-aware uplift."
        ),
    },
    "general_alpha": {
        "actionHint": "Run a controlled incremental ablation against the current production baseline.",
        "expectedImpact": "Identify reproducible incremental gains before scale-up.",
        "targetMetric": "robust_mean",
        "testPlan": "Start with smoke seeds, then promote to full run only on positive deltas.",
    },
}


TAG_KEYWORDS: Dict[str, Sequence[str]] = {
    "regime_detection": ("regime", "change point", "hidden markov", "switching"),
    "cost_execution": (
        "transaction cost",
        "market impact",
        "slippage",
        "execution",
        "order book",
        "liquidity",
    ),
    "risk_control": ("cvar", "expected shortfall", "value at risk", "tail risk", "drawdown"),
    "online_learning": ("online learning", "continual", "streaming", "adaptive"),
    "feature_engineering": ("feature", "factor", "embedding", "representation"),
    "rl_policy": ("reinforcement learning", "policy", "bandit", "actor-critic"),
    "uncertainty_calibration": ("calibration", "uncertainty", "probabilistic", "quantile"),
    "macro_news": ("news", "sentiment", "event", "macro"),
}


TOP_VENUE_HINTS = (
    "neurips",
    "icml",
    "iclr",
    "kdd",
    "aaai",
    "journal of finance",
    "management science",
)
MID_VENUE_HINTS = (
    "ecml",
    "acl",
    "emnlp",
    "www",
    "quantitative finance",
    "journal of risk",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compile ranked hypotheses from strategy-watch digest entries."
    )
    parser.add_argument(
        "--scan",
        default=DEFAULT_SCAN,
        help="Path to strategy-watch digest JSON.",
    )
    parser.add_argument(
        "--breakdown",
        default=DEFAULT_BREAKDOWN,
        help="Path to latest strategy g3g4 breakdown JSON.",
    )
    parser.add_argument(
        "--shortlist",
        default=DEFAULT_SHORTLIST,
        help="Path to fdr frontier shortlist JSON (optional; missing file is tolerated).",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help="Output path for hypothesis backlog JSON.",
    )
    parser.add_argument(
        "--max-items",
        type=int,
        default=DEFAULT_MAX_ITEMS,
        help="Maximum number of hypotheses in output.",
    )
    parser.add_argument(
        "--min-method-family-diversity",
        type=int,
        default=2,
        help="Minimum distinct methodFamily values to preserve when shortlist data is available.",
    )
    argv = [arg for arg in sys.argv[1:] if arg != "--"]
    return parser.parse_args(argv)


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).isoformat()


def resolve_path(repo_root: Path, raw: str) -> Path:
    path = Path(raw).expanduser()
    return path if path.is_absolute() else (repo_root / path).resolve()


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def load_json(path: Path) -> Tuple[Optional[Any], Optional[str]]:
    if not path.exists():
        return None, f"missing file: {path}"
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except Exception as exc:
        return None, f"invalid json {path}: {exc}"


def to_float(raw: Any) -> Optional[float]:
    try:
        if raw is None:
            return None
        text = str(raw).strip()
        if not text:
            return None
        return float(text)
    except Exception:
        return None


def to_non_empty_string(raw: Any) -> str:
    if raw is None:
        return ""
    text = str(raw).strip()
    return text


def normalize_tags(raw: Any) -> List[str]:
    if not isinstance(raw, list):
        return []
    tags: List[str] = []
    for item in raw:
        tag = to_non_empty_string(item).lower()
        if tag:
            tags.append(tag)
    return tags


def infer_tag_from_keywords(text: str) -> str:
    lower = text.lower()
    for tag, keywords in TAG_KEYWORDS.items():
        if any(keyword in lower for keyword in keywords):
            return tag
    return "general_alpha"


def pick_primary_tag(paper: Dict[str, Any]) -> str:
    tags = normalize_tags(paper.get("tags"))
    for tag in tags:
        if tag in TAG_HINTS:
            return tag
    title = to_non_empty_string(paper.get("title"))
    summary = to_non_empty_string(paper.get("summary")) or to_non_empty_string(
        paper.get("summary_short")
    )
    return infer_tag_from_keywords(f"{title} {summary}")


def venue_tier_hint_score(paper: Dict[str, Any]) -> float:
    explicit_tier = (
        to_float(paper.get("venue_tier"))
        or to_float(paper.get("venueTier"))
        or to_float(paper.get("tier"))
    )
    if explicit_tier is not None:
        if explicit_tier <= 1:
            return 3.0
        if explicit_tier <= 2:
            return 2.0
        if explicit_tier <= 3:
            return 1.0
        return 0.5

    venue_text = " ".join(
        [
            to_non_empty_string(paper.get("venue")),
            to_non_empty_string(paper.get("journal")),
            to_non_empty_string(paper.get("conference")),
        ]
    ).lower()
    if not venue_text.strip():
        return 0.0
    if any(hint in venue_text for hint in TOP_VENUE_HINTS):
        return 3.0
    if any(hint in venue_text for hint in MID_VENUE_HINTS):
        return 1.8
    return 0.8


def extract_failure_modes(breakdown: Dict[str, Any]) -> Set[str]:
    modes: Set[str] = set()
    verdict = breakdown.get("verdict", {})
    if not isinstance(verdict, dict):
        verdict = {}
    failure_breakdown = breakdown.get("failure_breakdown", {})
    if not isinstance(failure_breakdown, dict):
        failure_breakdown = {}

    reason_codes: List[str] = []
    verdict_reasons = verdict.get("reasonCodes")
    if isinstance(verdict_reasons, list):
        reason_codes.extend(to_non_empty_string(code) for code in verdict_reasons)
    failure_reason_codes = failure_breakdown.get("failureReasonCodes")
    if isinstance(failure_reason_codes, dict):
        reason_codes.extend(to_non_empty_string(code) for code in failure_reason_codes)

    thresholds = verdict.get("thresholds", {})
    aggregate = verdict.get("aggregateMetrics", {})
    if not isinstance(thresholds, dict):
        thresholds = {}
    if not isinstance(aggregate, dict):
        aggregate = {}
    fdr_q = to_float(aggregate.get("fdrQ"))
    fdr_q_max = to_float(thresholds.get("fdrQMax"))

    if (
        any("FDR" in code.upper() for code in reason_codes)
        or (
            fdr_q is not None
            and fdr_q_max is not None
            and fdr_q > fdr_q_max
        )
    ):
        modes.add("fdr_high")

    release_checks = failure_breakdown.get("releaseGateFailedChecks", {})
    wfo_reasons = failure_breakdown.get("wfoGateReasons", {})
    wfo_failed = False
    if isinstance(release_checks, dict):
        wfo_failed = (to_float(release_checks.get("wfo")) or 0.0) > 0
    if not wfo_failed and isinstance(wfo_reasons, dict):
        wfo_failed = any((to_float(value) or 0.0) > 0 for value in wfo_reasons.values())
    if not wfo_failed:
        wfo_failed = any("WFO" in code.upper() for code in reason_codes)
    if wfo_failed:
        modes.add("wfo_fail")
    return modes


def failure_mode_match_score(primary_tag: str, text: str, modes: Set[str]) -> float:
    lower = text.lower()
    score = 0.0
    if "fdr_high" in modes:
        fdr_tag_match = primary_tag in {
            "risk_control",
            "uncertainty_calibration",
            "feature_engineering",
            "online_learning",
        }
        fdr_kw_match = any(
            token in lower
            for token in (
                "false discovery",
                "fdr",
                "multiple testing",
                "calibration",
                "overfitting",
                "risk",
            )
        )
        if fdr_tag_match or fdr_kw_match:
            score += 2.2

    if "wfo_fail" in modes:
        wfo_tag_match = primary_tag in {
            "cost_execution",
            "regime_detection",
            "risk_control",
            "online_learning",
        }
        wfo_kw_match = any(
            token in lower
            for token in (
                "walk-forward",
                "wfo",
                "slippage",
                "market impact",
                "regime",
                "execution",
                "degradation",
            )
        )
        if wfo_tag_match or wfo_kw_match:
            score += 2.2
    return score


def derive_action_hint(paper: Dict[str, Any], primary_tag: str) -> str:
    explicit = to_non_empty_string(paper.get("actionHint")) or to_non_empty_string(
        paper.get("action_hint")
    )
    if explicit:
        return explicit
    template = TAG_HINTS.get(primary_tag, TAG_HINTS["general_alpha"])
    derived = to_non_empty_string(template.get("actionHint"))
    if derived:
        return derived

    title = to_non_empty_string(paper.get("title"))
    summary = to_non_empty_string(paper.get("summary"))
    fallback_tag = infer_tag_from_keywords(f"{title} {summary}")
    fallback_template = TAG_HINTS.get(fallback_tag, TAG_HINTS["general_alpha"])
    fallback = to_non_empty_string(fallback_template.get("actionHint"))
    if fallback:
        return fallback
    return TAG_HINTS["general_alpha"]["actionHint"]


def derive_text_field(
    paper: Dict[str, Any],
    *keys: str,
    fallback: str,
) -> str:
    for key in keys:
        value = to_non_empty_string(paper.get(key))
        if value:
            return value
    return fallback


def extract_paper_id(paper: Dict[str, Any], index: int) -> str:
    paper_id = derive_text_field(
        paper,
        "paperId",
        "paper_id",
        "id",
        fallback=f"paper-{index + 1}",
    )
    return paper_id


def extract_source(paper: Dict[str, Any]) -> str:
    source = derive_text_field(
        paper,
        "source",
        "id_url",
        "pdf_url",
        "url",
        "source_query",
        fallback="strategy-watch:digest",
    )
    return source


def normalize_method_family(raw: Any) -> str:
    value = to_non_empty_string(raw).lower()
    return value


def method_family_to_tag(method_family: str) -> str:
    if method_family == "regime-aware-risk-control":
        return "regime_detection"
    if method_family in {
        "multiple-testing-control",
        "selective-inference",
        "backtest-overfit-control",
        "bayesian-fdr",
        "robust-baseline",
    }:
        return "risk_control"
    return "general_alpha"


def target_metric_for_method_family(method_family: str) -> str:
    if method_family == "regime-aware-risk-control":
        return "wfoFailureDensity"
    if method_family:
        return "fdrQ"
    return ""


def parse_shortlist_rows(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = payload.get("shortlist")
    if not isinstance(rows, list):
        return []
    out: List[Dict[str, Any]] = []
    for row in rows:
        if isinstance(row, dict):
            out.append(row)
    return out


def merge_rows_with_shortlist(
    base_rows: Sequence[Dict[str, Any]],
    shortlist_rows: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    by_paper_id: Dict[str, Dict[str, Any]] = {}
    ordered_ids: List[str] = []

    for idx, row in enumerate(base_rows):
        paper_id = extract_paper_id(row, idx)
        if not paper_id:
            continue
        if paper_id not in by_paper_id:
            ordered_ids.append(paper_id)
        by_paper_id[paper_id] = dict(row)

    for idx, shortlist_row in enumerate(shortlist_rows):
        paper_id = extract_paper_id(shortlist_row, idx)
        if not paper_id:
            continue
        method_family = normalize_method_family(shortlist_row.get("methodFamily"))
        experiment_template_id = to_non_empty_string(shortlist_row.get("experimentTemplateId"))
        action_hint = to_non_empty_string(shortlist_row.get("actionHint"))
        expected_impact_fdr = to_non_empty_string(shortlist_row.get("expectedImpactOnFdrQ"))
        method_id = to_non_empty_string(shortlist_row.get("methodId"))
        title = to_non_empty_string(shortlist_row.get("title"))
        fdr_mechanism = to_non_empty_string(shortlist_row.get("fdrMechanism"))
        assumptions = to_non_empty_string(shortlist_row.get("assumptions"))
        venue = to_non_empty_string(shortlist_row.get("venue"))
        citations = shortlist_row.get("citations", {})
        citation_count = to_float(citations.get("citationCount") if isinstance(citations, dict) else None)

        if paper_id in by_paper_id:
            merged = dict(by_paper_id[paper_id])
            if method_family:
                merged["methodFamily"] = method_family
            if experiment_template_id and not to_non_empty_string(merged.get("experimentTemplateId")):
                merged["experimentTemplateId"] = experiment_template_id
            if action_hint and not to_non_empty_string(merged.get("actionHint")):
                merged["actionHint"] = action_hint
            if expected_impact_fdr and not to_non_empty_string(merged.get("expectedImpact")):
                merged["expectedImpact"] = expected_impact_fdr
            if (
                not to_non_empty_string(merged.get("targetMetric"))
                and method_family
            ):
                merged["targetMetric"] = target_metric_for_method_family(method_family)
            merged["_shortlist_enriched"] = True
            by_paper_id[paper_id] = merged
            continue

        synthetic: Dict[str, Any] = {
            "paper_id": paper_id,
            "paperId": paper_id,
            "title": title or f"Frontier method {paper_id}",
            "summary": " ".join(part for part in [fdr_mechanism, assumptions] if part).strip(),
            "source": f"fdr-shortlist:{method_id or paper_id}",
            "venue": venue,
            "citation_count": citation_count or 0.0,
            "methodFamily": method_family,
            "experimentTemplateId": experiment_template_id,
            "actionHint": action_hint,
            "expectedImpact": expected_impact_fdr,
            "targetMetric": target_metric_for_method_family(method_family),
            "tags": [method_family_to_tag(method_family)],
            "_shortlist_enriched": True,
        }
        by_paper_id[paper_id] = synthetic
        ordered_ids.append(paper_id)

    return [by_paper_id[paper_id] for paper_id in ordered_ids]


def select_with_method_family_diversity(
    hypotheses: Sequence[Dict[str, Any]],
    *,
    max_items: int,
    min_diversity: int,
) -> List[Dict[str, Any]]:
    if max_items <= 0:
        return []
    if min_diversity <= 0:
        return list(hypotheses[:max_items])

    selected: List[Dict[str, Any]] = []
    selected_keys: Set[str] = set()
    seen_families: Set[str] = set()

    for row in hypotheses:
        family = normalize_method_family(row.get("methodFamily"))
        if not family or family in seen_families:
            continue
        key = f"{row.get('paperId', '')}:{family}"
        selected.append(row)
        selected_keys.add(key)
        seen_families.add(family)
        if len(selected) >= max_items or len(seen_families) >= min_diversity:
            break

    for row in hypotheses:
        family = normalize_method_family(row.get("methodFamily"))
        key = f"{row.get('paperId', '')}:{family}"
        if key in selected_keys:
            continue
        selected.append(row)
        selected_keys.add(key)
        if len(selected) >= max_items:
            break
    return selected[:max_items]


def compute_priority(
    paper: Dict[str, Any],
    *,
    primary_tag: str,
    failure_modes: Set[str],
) -> float:
    paper_score = (
        to_float(paper.get("score"))
        or to_float(paper.get("source_score"))
        or to_float(paper.get("relevance_score"))
        or 0.0
    )
    citation_count = (
        to_float(paper.get("citation_count"))
        or to_float(paper.get("citationCount"))
        or to_float(paper.get("citations"))
        or 0.0
    )
    citation_count = max(citation_count, 0.0)
    citation_component = math.log1p(citation_count) * 1.1

    venue_component = venue_tier_hint_score(paper)

    title = to_non_empty_string(paper.get("title"))
    summary = to_non_empty_string(paper.get("summary")) or to_non_empty_string(
        paper.get("summary_short")
    )
    failure_component = failure_mode_match_score(
        primary_tag=primary_tag,
        text=f"{title} {summary}",
        modes=failure_modes,
    )

    priority = (paper_score * 1.6) + citation_component + venue_component + failure_component
    return round(priority, 6)


def build_hypotheses(
    *,
    papers: Sequence[Any],
    failure_modes: Set[str],
    max_items: int,
    min_method_family_diversity: int,
) -> List[Dict[str, Any]]:
    hypotheses: List[Dict[str, Any]] = []
    for idx, row in enumerate(papers):
        if not isinstance(row, dict):
            continue
        primary_tag = pick_primary_tag(row)
        template = TAG_HINTS.get(primary_tag, TAG_HINTS["general_alpha"])
        paper_id = extract_paper_id(row, idx)
        title = derive_text_field(row, "title", fallback=f"Hypothesis from {paper_id}")
        action_hint = derive_action_hint(row, primary_tag)
        expected_impact = derive_text_field(
            row,
            "expectedImpact",
            "expected_impact",
            fallback=template["expectedImpact"],
        )
        target_metric = derive_text_field(
            row,
            "targetMetric",
            "target_metric",
            fallback=template["targetMetric"],
        )
        test_plan = derive_text_field(
            row,
            "testPlan",
            "test_plan",
            fallback=template["testPlan"],
        )
        method_family = derive_text_field(
            row,
            "methodFamily",
            "method_family",
            fallback="",
        ).lower()
        experiment_template_id = derive_text_field(
            row,
            "experimentTemplateId",
            "experiment_template_id",
            fallback="",
        )
        source = extract_source(row)
        shortlist_enriched = bool(row.get("_shortlist_enriched"))
        evidence_type = "digest"
        if shortlist_enriched:
            evidence_type = "shortlist" if source.startswith("fdr-shortlist:") else "digest+shortlist"

        hypothesis = {
            "id": "",
            "paperId": paper_id,
            "title": title,
            "source": source,
            "actionHint": action_hint,
            "expectedImpact": expected_impact,
            "targetMetric": target_metric,
            "testPlan": test_plan,
            "priority": compute_priority(
                row,
                primary_tag=primary_tag,
                failure_modes=failure_modes,
            ),
            "evidenceType": evidence_type,
        }
        if method_family:
            hypothesis["methodFamily"] = method_family
        if experiment_template_id:
            hypothesis["experimentTemplateId"] = experiment_template_id
        hypotheses.append(hypothesis)

    hypotheses.sort(
        key=lambda row: (
            float(row.get("priority", 0.0)),
            str(row.get("paperId", "")),
        ),
        reverse=True,
    )

    if max_items >= 0:
        hypotheses = select_with_method_family_diversity(
            hypotheses,
            max_items=max_items,
            min_diversity=max(int(min_method_family_diversity), 0),
        )
    for idx, row in enumerate(hypotheses, start=1):
        row["id"] = f"HYP-{idx:03d}"
    return hypotheses


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    scan_path = resolve_path(repo_root, args.scan)
    breakdown_path = resolve_path(repo_root, args.breakdown)
    shortlist_path = resolve_path(repo_root, args.shortlist)
    output_path = resolve_path(repo_root, args.output)
    max_items = max(int(args.max_items), 0)
    min_method_family_diversity = max(int(args.min_method_family_diversity), 0)
    warnings: List[str] = []

    digest_payload, digest_error = load_json(scan_path)
    if digest_error:
        print(digest_error, file=sys.stderr)
        return 2
    if not isinstance(digest_payload, dict):
        print(f"expected object json: {scan_path}", file=sys.stderr)
        return 2

    breakdown_payload, breakdown_error = load_json(breakdown_path)
    if breakdown_error:
        print(breakdown_error, file=sys.stderr)
        return 2
    if not isinstance(breakdown_payload, dict):
        print(f"expected object json: {breakdown_path}", file=sys.stderr)
        return 2

    shortlist_payload: Dict[str, Any] = {}
    shortlist_rows: List[Dict[str, Any]] = []
    shortlist_loaded = False
    if shortlist_path.exists():
        loaded_shortlist, shortlist_error = load_json(shortlist_path)
        if shortlist_error:
            warnings.append(shortlist_error)
        elif isinstance(loaded_shortlist, dict):
            shortlist_payload = loaded_shortlist
            shortlist_rows = parse_shortlist_rows(loaded_shortlist)
            shortlist_loaded = True
        else:
            warnings.append(f"expected object json: {shortlist_path}")
    else:
        warnings.append(f"shortlist file missing: {shortlist_path}")

    top_new = digest_payload.get("top_new", [])
    if not isinstance(top_new, list):
        top_new = []
    top_recent = digest_payload.get("top_recent", [])
    if not isinstance(top_recent, list):
        top_recent = []
    selected_rows = top_new if top_new else top_recent
    selected_rows = merge_rows_with_shortlist(
        [row for row in selected_rows if isinstance(row, dict)],
        shortlist_rows,
    )

    failure_modes = extract_failure_modes(breakdown_payload)
    hypotheses = build_hypotheses(
        papers=selected_rows,
        failure_modes=failure_modes,
        max_items=max_items,
        min_method_family_diversity=min_method_family_diversity,
    )
    method_families = sorted(
        {
            normalize_method_family(row.get("methodFamily"))
            for row in hypotheses
            if normalize_method_family(row.get("methodFamily"))
        }
    )

    payload = {
        "schemaVersion": "hypothesis_backlog.v1",
        "generatedAt": iso(now_utc()),
        "inputs": {
            "scan": str(scan_path),
            "breakdown": str(breakdown_path),
            "shortlist": str(shortlist_path),
        },
        "failureModes": sorted(failure_modes),
        "selectionPolicy": {
            "minMethodFamilyDiversityRequested": min_method_family_diversity,
            "observedMethodFamilyDiversity": len(method_families),
            "observedMethodFamilies": method_families,
            "shortlistLoaded": shortlist_loaded,
            "shortlistRows": len(shortlist_rows),
        },
        "warnings": warnings,
        "hypotheses": hypotheses,
    }
    write_json(output_path, payload)
    print(f"wrote {len(hypotheses)} hypotheses -> {output_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
