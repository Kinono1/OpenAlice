#!/usr/bin/env python3
"""Synthesize an FDR-method frontier shortlist from research artifacts."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Sequence, Tuple


SCHEMA_VERSION = "fdr_frontier_shortlist.v1"
DEFAULT_DIGEST = "data/research/strategy-watch/latest_digest.json"
DEFAULT_CITATION_NETWORK = (
    "data/research/literature/citations/latest_citation_network.v1.json"
)
DEFAULT_PDF_EXTRACT_REPORT = (
    "data/research/literature/pdf_extract/latest_pdf_extract_report.v1.json"
)
DEFAULT_HYPOTHESES = "data/research/hypotheses/backlog.v1.json"
DEFAULT_OUTPUT = "data/research/fdr/frontier_shortlist.latest.v1.json"
DEFAULT_MARKDOWN_DIR = "docs/research"
DEFAULT_TOP_K = 12

SLUG_PATTERN = re.compile(r"[^a-z0-9]+")
YEAR_PATTERN = re.compile(r"(19|20)\d{2}")

FDR_SIGNAL_TERMS: Tuple[Tuple[str, int], ...] = (
    ("false discovery rate", 8),
    ("multiple testing", 8),
    ("multiple-testing", 8),
    ("multiple_testing", 8),
    ("family-wise error", 6),
    ("family wise error", 6),
    ("fwer", 6),
    ("fdrq", 8),
    ("fdr", 6),
    ("q-value", 6),
    ("q value", 6),
    ("benjamini", 7),
    ("hochberg", 6),
    ("holm", 5),
    ("bonferroni", 5),
    ("storey", 4),
    ("knockoff", 7),
    ("e-value", 6),
    ("e value", 6),
    ("deflated sharpe", 5),
    ("white reality check", 5),
    ("reality check", 4),
    ("data snooping", 4),
    ("post-selection", 3),
)

WFO_SIGNAL_TERMS: Tuple[str, ...] = (
    "walk-forward",
    "walk forward",
    "wfo",
    "regime",
    "rolling",
    "window",
    "stability",
    "shift",
    "change-point",
    "hmm",
)

FAMILY_META: Dict[str, Dict[str, str]] = {
    "multiple-testing-control": {
        "fdrMechanism": (
            "Apply BH-style q-value thresholding on candidate pools across trials."
        ),
        "assumptions": (
            "Comparable p-values across candidate strategies and controlled selection depth."
        ),
        "integrationCost": "low",
        "riskLevel": "low",
        "experimentTemplateId": "tpl_fdr_bh_gate_v1",
        "defaultActionHint": (
            "Add BH/q-value control after candidate ranking and compare fdrQ against baseline."
        ),
    },
    "selective-inference": {
        "fdrMechanism": (
            "Use e-values or knockoff-style selective inference to control discoveries."
        ),
        "assumptions": (
            "Model assumptions for selective tests hold under repeated strategy selection."
        ),
        "integrationCost": "high",
        "riskLevel": "high",
        "experimentTemplateId": "tpl_evalue_knockoff_v1",
        "defaultActionHint": (
            "Prototype selective-inference gate in replay and verify calibration drift."
        ),
    },
    "regime-aware-risk-control": {
        "fdrMechanism": (
            "Partition by market regime before multiple-testing correction."
        ),
        "assumptions": (
            "Regime segmentation is stable enough to avoid leakage across folds."
        ),
        "integrationCost": "medium",
        "riskLevel": "medium",
        "experimentTemplateId": "tpl_regime_fdr_split_v1",
        "defaultActionHint": (
            "Run regime-aware split first, then apply FDR control per regime bucket."
        ),
    },
    "backtest-overfit-control": {
        "fdrMechanism": (
            "Estimate null through bootstrap/reality-check style overfit controls."
        ),
        "assumptions": (
            "Resampled null distribution remains representative across replay windows."
        ),
        "integrationCost": "medium",
        "riskLevel": "medium",
        "experimentTemplateId": "tpl_deflated_sharpe_wrc_v1",
        "defaultActionHint": (
            "Add bootstrap null and deflated-sharpe checks before promotion decisions."
        ),
    },
    "bayesian-fdr": {
        "fdrMechanism": (
            "Use empirical-Bayes style posterior discovery probabilities."
        ),
        "assumptions": (
            "Prior and likelihood calibration are robust under non-stationary returns."
        ),
        "integrationCost": "medium",
        "riskLevel": "medium",
        "experimentTemplateId": "tpl_empirical_bayes_fdr_v1",
        "defaultActionHint": (
            "Track posterior discovery probabilities and compare with frequentist q-values."
        ),
    },
    "robust-baseline": {
        "fdrMechanism": (
            "Use baseline FDR gate with conservative thresholds under replay stress."
        ),
        "assumptions": (
            "Conservative thresholds reduce false positives without collapsing recall."
        ),
        "integrationCost": "low",
        "riskLevel": "low",
        "experimentTemplateId": "tpl_fdr_baseline_sanity_v1",
        "defaultActionHint": (
            "Apply conservative FDR baseline gate and monitor fdrQ and WFO density."
        ),
    },
}


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate deterministic FDR frontier shortlist from research artifacts.",
    )
    parser.add_argument("--digest", default=DEFAULT_DIGEST, help="Strategy digest JSON path.")
    parser.add_argument(
        "--citation-network",
        default=DEFAULT_CITATION_NETWORK,
        help="Citation network JSON path.",
    )
    parser.add_argument(
        "--pdf-extract-report",
        default=DEFAULT_PDF_EXTRACT_REPORT,
        help="PDF extract report JSON path.",
    )
    parser.add_argument(
        "--hypotheses",
        default=DEFAULT_HYPOTHESES,
        help="Hypothesis backlog JSON path.",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help="Output JSON path for shortlist payload.",
    )
    parser.add_argument(
        "--markdown",
        default="",
        help="Output markdown path (default: docs/research/fdr_frontier_shortlist_YYYYMMDD.md).",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=DEFAULT_TOP_K,
        help="Maximum shortlist items to keep (default: 12).",
    )
    parsed_argv: Sequence[str] | None = argv
    if parsed_argv is None:
        parsed_argv = sys.argv[1:]
    if parsed_argv and parsed_argv[0] == "--":
        parsed_argv = parsed_argv[1:]
    return parser.parse_args(parsed_argv)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_iso() -> str:
    return utc_now().isoformat(timespec="seconds").replace("+00:00", "Z")


def utc_day() -> str:
    return utc_now().strftime("%Y%m%d")


def resolve_path(root: Path, raw_path: str) -> Path:
    candidate = Path(raw_path).expanduser()
    if candidate.is_absolute():
        return candidate
    return (root / candidate).resolve()


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def write_markdown(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def safe_read_json_object(path: Path) -> Tuple[Dict[str, Any], str | None]:
    if not path.exists():
        return {}, f"missing input: {path}"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return {}, f"invalid json: {path}: {exc}"
    if not isinstance(payload, dict):
        return {}, f"json root is not object: {path}"
    return payload, None


def normalize_text(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def normalize_paper_id(value: Any) -> str:
    if isinstance(value, str):
        return normalize_text(value)
    if isinstance(value, (int, float)):
        return normalize_text(str(value))
    return ""


def normalize_str_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    items: List[str] = []
    seen: set[str] = set()
    for raw_item in value:
        text = normalize_text(raw_item)
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        items.append(text)
    items.sort(key=lambda item: item.lower())
    return items


def to_int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return default
        try:
            return int(float(raw))
        except ValueError:
            return default
    return default


def to_float(value: Any, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return default
        try:
            return float(raw)
        except ValueError:
            return default
    return default


def extract_year(value: Any) -> int:
    if isinstance(value, int):
        return value if 1900 <= value <= 2100 else 0
    if isinstance(value, float):
        year = int(value)
        return year if 1900 <= year <= 2100 else 0
    text = normalize_text(value)
    if not text:
        return 0
    match = YEAR_PATTERN.search(text)
    if not match:
        return 0
    year = to_int(match.group(0), 0)
    return year if 1900 <= year <= 2100 else 0


def slugify(value: str) -> str:
    lowered = normalize_text(value).lower()
    slug = SLUG_PATTERN.sub("-", lowered).strip("-")
    return slug or "na"


def score_term_hits(text: str, field_weight: int) -> Tuple[int, int]:
    lowered = text.lower()
    score = 0
    hits = 0
    for term, base_weight in FDR_SIGNAL_TERMS:
        if term in lowered:
            score += base_weight * max(field_weight, 1)
            hits += 1
    return score, hits


def score_wfo_hits(text: str) -> int:
    lowered = text.lower()
    return sum(1 for term in WFO_SIGNAL_TERMS if term in lowered)


def classify_method_family(text: str) -> str:
    lowered = text.lower()
    if any(term in lowered for term in ("knockoff", "e-value", "e value", "selective")):
        return "selective-inference"
    if any(
        term in lowered
        for term in (
            "deflated sharpe",
            "reality check",
            "bootstrap",
            "data snooping",
            "pbo",
        )
    ):
        return "backtest-overfit-control"
    if any(term in lowered for term in ("regime", "change-point", "hmm", "walk-forward", "wfo")):
        return "regime-aware-risk-control"
    if any(term in lowered for term in ("bayes", "posterior", "empirical bayes")):
        return "bayesian-fdr"
    if any(
        term in lowered
        for term in (
            "false discovery rate",
            "multiple testing",
            "multiple-testing",
            "multiple_testing",
            "fdr",
            "q-value",
            "benjamini",
            "hochberg",
            "holm",
            "bonferroni",
        )
    ):
        return "multiple-testing-control"
    return "robust-baseline"


def estimate_fdr_impact(total_fdr_hits: int, text: str) -> str:
    lowered = text.lower()
    if total_fdr_hits >= 8:
        return "high_reduction_expected"
    if total_fdr_hits >= 4:
        return "medium_reduction_expected"
    if "risk control" in lowered or "uncertainty" in lowered:
        return "low_to_medium_reduction_expected"
    return "uncertain"


def estimate_wfo_impact(wfo_hits: int, text: str) -> str:
    lowered = text.lower()
    if wfo_hits >= 4:
        return "high_stability_gain_expected"
    if wfo_hits >= 2:
        return "medium_stability_gain_expected"
    if "regime" in lowered or "rolling" in lowered:
        return "low_to_medium_stability_gain_expected"
    return "uncertain"


def collect_digest_papers(payload: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    raw_rows = payload.get("top_new")
    rows = raw_rows if isinstance(raw_rows, list) else []
    if not rows:
        recent_rows = payload.get("top_recent")
        rows = recent_rows if isinstance(recent_rows, list) else []

    papers_by_id: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        paper_id = normalize_paper_id(row.get("paper_id") or row.get("paperId") or row.get("id"))
        if not paper_id:
            continue
        item = papers_by_id.get(paper_id)
        title = normalize_text(row.get("title")) or paper_id
        summary = normalize_text(row.get("summary") or row.get("summary_short"))
        tags = normalize_str_list(row.get("tags")) + normalize_str_list(row.get("categories"))
        tags = sorted({tag for tag in tags}, key=lambda tag: tag.lower())
        venue = normalize_text(row.get("venue") or row.get("source")) or "unknown"
        published_year = extract_year(
            row.get("year") or row.get("published_at") or row.get("updated_at")
        )
        references_count = to_int(row.get("references_count"), 0)
        references = row.get("references")
        if isinstance(references, list):
            references_count = max(references_count, len(references))

        if item is None:
            papers_by_id[paper_id] = {
                "paperId": paper_id,
                "title": title,
                "summary": summary,
                "tags": tags,
                "venue": venue,
                "year": published_year,
                "referencesCount": max(references_count, 0),
            }
            continue

        if item.get("title") in ("", paper_id) and title:
            item["title"] = title
        if not item.get("summary") and summary:
            item["summary"] = summary
        if item.get("venue") in ("", "unknown") and venue:
            item["venue"] = venue
        if to_int(item.get("year"), 0) <= 0 and published_year > 0:
            item["year"] = published_year
        item["referencesCount"] = max(
            to_int(item.get("referencesCount"), 0),
            max(references_count, 0),
        )
        merged_tags = set(normalize_str_list(item.get("tags")))
        merged_tags.update(tags)
        item["tags"] = sorted(merged_tags, key=lambda tag: tag.lower())

    return papers_by_id


def collect_hypotheses(
    payload: Dict[str, Any],
) -> Tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]]]:
    rows = payload.get("hypotheses")
    hypotheses = rows if isinstance(rows, list) else []
    by_paper_id: Dict[str, Dict[str, Any]] = {}
    orphans: List[Dict[str, Any]] = []
    for row in hypotheses:
        if not isinstance(row, dict):
            continue
        item = {
            "id": normalize_text(row.get("id")),
            "paperId": normalize_paper_id(row.get("paperId") or row.get("paper_id")),
            "title": normalize_text(row.get("title")),
            "actionHint": normalize_text(row.get("actionHint")),
            "expectedImpact": normalize_text(row.get("expectedImpact")),
            "targetMetric": normalize_text(row.get("targetMetric")),
            "testPlan": normalize_text(row.get("testPlan")),
            "priority": to_float(row.get("priority"), 0.0),
        }
        paper_id = item["paperId"]
        if not paper_id:
            orphans.append(item)
            continue

        existing = by_paper_id.get(paper_id)
        if existing is None:
            by_paper_id[paper_id] = item
            continue

        current_priority = to_float(existing.get("priority"), 0.0)
        new_priority = to_float(item.get("priority"), 0.0)
        if new_priority > current_priority:
            by_paper_id[paper_id] = item
            continue
        if new_priority == current_priority and item["id"] and item["id"] < str(existing.get("id", "")):
            by_paper_id[paper_id] = item

    orphans.sort(
        key=lambda row: (
            -to_float(row.get("priority"), 0.0),
            normalize_text(row.get("id")),
            normalize_text(row.get("title")),
        )
    )
    return by_paper_id, orphans


def collect_citation_metrics(payload: Dict[str, Any]) -> Dict[str, Dict[str, int]]:
    citation_count: Dict[str, int] = {}
    in_degree: Dict[str, int] = defaultdict(int)
    out_degree: Dict[str, int] = defaultdict(int)

    nodes = payload.get("nodes")
    if isinstance(nodes, list):
        for node in nodes:
            if not isinstance(node, dict):
                continue
            paper_id = normalize_paper_id(node.get("paperId") or node.get("paper_id"))
            if not paper_id:
                continue
            count = to_int(node.get("citationCount"), -1)
            if count >= 0:
                citation_count[paper_id] = max(citation_count.get(paper_id, 0), count)

    edges = payload.get("edges")
    if isinstance(edges, list):
        for edge in edges:
            if not isinstance(edge, dict):
                continue
            source_id = normalize_paper_id(edge.get("source"))
            target_id = normalize_paper_id(edge.get("target"))
            if not source_id or not target_id or source_id == target_id:
                continue
            out_degree[source_id] += 1
            in_degree[target_id] += 1

    all_ids = set(citation_count) | set(in_degree) | set(out_degree)
    metrics: Dict[str, Dict[str, int]] = {}
    for paper_id in all_ids:
        metrics[paper_id] = {
            "citationCount": max(citation_count.get(paper_id, 0), 0),
            "inDegree": max(in_degree.get(paper_id, 0), 0),
            "outDegree": max(out_degree.get(paper_id, 0), 0),
        }
    return metrics


def collect_pdf_metrics(payload: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    rows = payload.get("papers")
    papers = rows if isinstance(rows, list) else []
    metrics: Dict[str, Dict[str, Any]] = {}
    for row in papers:
        if not isinstance(row, dict):
            continue
        paper_id = normalize_paper_id(row.get("paperId") or row.get("paper_id"))
        if not paper_id:
            continue
        status = normalize_text(row.get("status")).lower() or "unknown"
        text_chars = max(to_int(row.get("textChars"), 0), 0)
        current = metrics.get(paper_id)
        if current is None:
            metrics[paper_id] = {
                "status": status,
                "textChars": text_chars,
            }
            continue
        if text_chars > to_int(current.get("textChars"), 0):
            current["textChars"] = text_chars
        if status == "success":
            current["status"] = "success"
    return metrics


def fallback_item(current_year: int) -> Dict[str, Any]:
    return {
        "methodId": "m-robust-baseline-fallback-fdr",
        "paperId": "fallback-fdr-baseline",
        "title": "Fallback baseline: conservative FDR gate for strategy selection",
        "venue": "internal-synthesis",
        "year": current_year,
        "methodFamily": "robust-baseline",
        "fdrMechanism": (
            "Use conservative q-value thresholds on replay candidates before promotion."
        ),
        "assumptions": (
            "Comparable trial statistics and consistent replay protocol across candidates."
        ),
        "expectedImpactOnFdrQ": "medium_reduction_expected",
        "expectedImpactOnWfo": "low_to_medium_stability_gain_expected",
        "integrationCost": "low",
        "riskLevel": "low",
        "actionHint": (
            "Run baseline FDR gate on current candidate pool and compare against ungated selection."
        ),
        "experimentTemplateId": "tpl_fdr_baseline_sanity_v1",
        "citations": {"citationCount": 0, "inDegree": 0, "outDegree": 0},
    }


def build_shortlist(
    *,
    digest_payload: Dict[str, Any],
    citation_payload: Dict[str, Any],
    pdf_payload: Dict[str, Any],
    hypothesis_payload: Dict[str, Any],
    top_k: int,
) -> List[Dict[str, Any]]:
    digest_papers = collect_digest_papers(digest_payload)
    hypothesis_by_paper, hypothesis_orphans = collect_hypotheses(hypothesis_payload)
    citation_metrics = collect_citation_metrics(citation_payload)
    pdf_metrics = collect_pdf_metrics(pdf_payload)

    candidate_rows: List[Dict[str, Any]] = []
    all_paper_ids = set(digest_papers) | set(hypothesis_by_paper)
    for paper_id in sorted(all_paper_ids):
        digest_row = digest_papers.get(paper_id, {})
        hypothesis_row = hypothesis_by_paper.get(paper_id, {})
        citations = citation_metrics.get(
            paper_id,
            {"citationCount": 0, "inDegree": 0, "outDegree": 0},
        )
        pdf_row = pdf_metrics.get(paper_id, {"status": "unknown", "textChars": 0})

        title = normalize_text(digest_row.get("title")) or normalize_text(hypothesis_row.get("title")) or paper_id
        summary = normalize_text(digest_row.get("summary"))
        tags = normalize_str_list(digest_row.get("tags"))
        action_hint = normalize_text(hypothesis_row.get("actionHint"))
        expected_impact = normalize_text(hypothesis_row.get("expectedImpact"))
        target_metric = normalize_text(hypothesis_row.get("targetMetric"))
        test_plan = normalize_text(hypothesis_row.get("testPlan"))
        venue = normalize_text(digest_row.get("venue")) or "unknown"
        year = to_int(digest_row.get("year"), 0)
        if year <= 0:
            year = extract_year(hypothesis_row.get("title"))

        combined_text = " ".join(
            [
                title,
                summary,
                " ".join(tags),
                action_hint,
                expected_impact,
                target_metric,
                test_plan,
            ]
        ).strip()

        title_score, title_hits = score_term_hits(title, field_weight=4)
        summary_score, summary_hits = score_term_hits(summary, field_weight=3)
        tags_score, tags_hits = score_term_hits(" ".join(tags), field_weight=3)
        action_score, action_hits = score_term_hits(action_hint, field_weight=3)
        impact_score, impact_hits = score_term_hits(expected_impact, field_weight=2)
        metric_score, metric_hits = score_term_hits(target_metric, field_weight=3)
        total_fdr_hits = (
            title_hits
            + summary_hits
            + tags_hits
            + action_hits
            + impact_hits
            + metric_hits
        )
        signal_score = (
            title_score
            + summary_score
            + tags_score
            + action_score
            + impact_score
            + metric_score
        )
        wfo_hits = score_wfo_hits(combined_text)
        priority = max(to_float(hypothesis_row.get("priority"), 0.0), 0.0)
        priority_score = min(int(round(priority * 10)), 500)

        citation_count = max(to_int(citations.get("citationCount"), 0), 0)
        in_degree = max(to_int(citations.get("inDegree"), 0), 0)
        out_degree = max(to_int(citations.get("outDegree"), 0), 0)
        references_count = max(to_int(digest_row.get("referencesCount"), 0), 0)
        text_chars = max(to_int(pdf_row.get("textChars"), 0), 0)
        pdf_success = normalize_text(pdf_row.get("status")).lower() == "success"

        total_score = 0
        total_score += signal_score * 10
        total_score += priority_score
        total_score += min(citation_count, 200) * 2
        total_score += min(in_degree, 100) * 5
        total_score += min(out_degree, 100) * 2
        total_score += min(references_count, 50)
        if pdf_success:
            total_score += 40
        total_score += min(text_chars // 10000, 20)

        family = classify_method_family(combined_text)
        meta = FAMILY_META[family]
        method_id = f"m-{slugify(family)}-{slugify(paper_id)}"
        action_hint_final = action_hint or meta["defaultActionHint"]

        candidate_rows.append(
            {
                "methodId": method_id,
                "paperId": paper_id,
                "title": title,
                "venue": venue,
                "year": year,
                "methodFamily": family,
                "fdrMechanism": meta["fdrMechanism"],
                "assumptions": meta["assumptions"],
                "expectedImpactOnFdrQ": estimate_fdr_impact(total_fdr_hits, combined_text),
                "expectedImpactOnWfo": estimate_wfo_impact(wfo_hits, combined_text),
                "integrationCost": meta["integrationCost"],
                "riskLevel": meta["riskLevel"],
                "actionHint": action_hint_final,
                "experimentTemplateId": meta["experimentTemplateId"],
                "citations": {
                    "citationCount": citation_count,
                    "inDegree": in_degree,
                    "outDegree": out_degree,
                },
                "_score": total_score,
                "_fdrHits": total_fdr_hits,
                "_priority": priority,
            }
        )

    for orphan in hypothesis_orphans:
        orphan_id = normalize_text(orphan.get("id"))
        paper_id = f"hypothesis-{slugify(orphan_id or orphan.get('title', 'candidate'))}"
        title = normalize_text(orphan.get("title")) or paper_id
        action_hint = normalize_text(orphan.get("actionHint"))
        expected_impact = normalize_text(orphan.get("expectedImpact"))
        target_metric = normalize_text(orphan.get("targetMetric"))
        combined_text = " ".join([title, action_hint, expected_impact, target_metric]).strip()

        title_score, title_hits = score_term_hits(title, field_weight=4)
        action_score, action_hits = score_term_hits(action_hint, field_weight=3)
        impact_score, impact_hits = score_term_hits(expected_impact, field_weight=2)
        metric_score, metric_hits = score_term_hits(target_metric, field_weight=3)
        total_fdr_hits = title_hits + action_hits + impact_hits + metric_hits
        signal_score = title_score + action_score + impact_score + metric_score
        priority = max(to_float(orphan.get("priority"), 0.0), 0.0)
        total_score = signal_score * 10 + min(int(round(priority * 10)), 500)

        family = classify_method_family(combined_text)
        meta = FAMILY_META[family]
        candidate_rows.append(
            {
                "methodId": f"m-{slugify(family)}-{slugify(paper_id)}",
                "paperId": paper_id,
                "title": title,
                "venue": "hypothesis-only",
                "year": 0,
                "methodFamily": family,
                "fdrMechanism": meta["fdrMechanism"],
                "assumptions": meta["assumptions"],
                "expectedImpactOnFdrQ": estimate_fdr_impact(total_fdr_hits, combined_text),
                "expectedImpactOnWfo": estimate_wfo_impact(
                    score_wfo_hits(combined_text),
                    combined_text,
                ),
                "integrationCost": meta["integrationCost"],
                "riskLevel": meta["riskLevel"],
                "actionHint": action_hint or meta["defaultActionHint"],
                "experimentTemplateId": meta["experimentTemplateId"],
                "citations": {"citationCount": 0, "inDegree": 0, "outDegree": 0},
                "_score": total_score,
                "_fdrHits": total_fdr_hits,
                "_priority": priority,
            }
        )

    candidate_rows.sort(
        key=lambda row: (
            -to_int(row.get("_score"), 0),
            -to_int(row.get("_fdrHits"), 0),
            -to_float(row.get("_priority"), 0.0),
            -to_int((row.get("citations") or {}).get("inDegree"), 0),
            -to_int((row.get("citations") or {}).get("citationCount"), 0),
            normalize_text(row.get("paperId")),
            normalize_text(row.get("methodId")),
        )
    )

    shortlist: List[Dict[str, Any]] = []
    seen_method_ids: set[str] = set()
    max_items = max(top_k, 1)
    for row in candidate_rows:
        method_id = normalize_text(row.get("methodId"))
        if not method_id or method_id in seen_method_ids:
            continue
        seen_method_ids.add(method_id)
        shortlist.append(
            {
                "methodId": method_id,
                "paperId": normalize_text(row.get("paperId")) or "unknown-paper",
                "title": normalize_text(row.get("title")) or "Untitled method candidate",
                "venue": normalize_text(row.get("venue")) or "unknown",
                "year": max(to_int(row.get("year"), 0), 0),
                "methodFamily": normalize_text(row.get("methodFamily")) or "robust-baseline",
                "fdrMechanism": normalize_text(row.get("fdrMechanism")),
                "assumptions": normalize_text(row.get("assumptions")),
                "expectedImpactOnFdrQ": normalize_text(row.get("expectedImpactOnFdrQ")),
                "expectedImpactOnWfo": normalize_text(row.get("expectedImpactOnWfo")),
                "integrationCost": normalize_text(row.get("integrationCost")) or "medium",
                "riskLevel": normalize_text(row.get("riskLevel")) or "medium",
                "actionHint": normalize_text(row.get("actionHint")),
                "experimentTemplateId": normalize_text(row.get("experimentTemplateId")),
                "citations": {
                    "citationCount": max(
                        to_int((row.get("citations") or {}).get("citationCount"), 0),
                        0,
                    ),
                    "inDegree": max(
                        to_int((row.get("citations") or {}).get("inDegree"), 0),
                        0,
                    ),
                    "outDegree": max(
                        to_int((row.get("citations") or {}).get("outDegree"), 0),
                        0,
                    ),
                },
            }
        )
        if len(shortlist) >= max_items:
            break

    if shortlist:
        return shortlist

    return [fallback_item(current_year=utc_now().year)]


def render_markdown(
    *,
    generated_at: str,
    generated_day: str,
    inputs: Dict[str, str],
    warnings: List[str],
    shortlist: List[Dict[str, Any]],
) -> str:
    date_text = (
        f"{generated_day[0:4]}-{generated_day[4:6]}-{generated_day[6:8]}"
        if len(generated_day) == 8
        else generated_day
    )
    lines: List[str] = [
        f"# FDR Frontier Shortlist ({date_text})",
        "",
        f"- Generated at: `{generated_at}`",
        f"- Items: `{len(shortlist)}`",
        f"- Digest: `{inputs.get('digest', '')}`",
        f"- Citation network: `{inputs.get('citationNetwork', '')}`",
        f"- PDF extract report: `{inputs.get('pdfExtractReport', '')}`",
        f"- Hypotheses: `{inputs.get('hypotheses', '')}`",
    ]
    if warnings:
        lines.append(f"- Warnings: `{len(warnings)}`")
    lines.extend(
        [
            "",
            "| Rank | methodId | paperId | year | methodFamily | FDR impact | WFO impact | Cost | Risk | Citations |",
            "| --- | --- | --- | ---: | --- | --- | --- | --- | --- | ---: |",
        ]
    )
    for index, row in enumerate(shortlist, start=1):
        citations = to_int((row.get("citations") or {}).get("citationCount"), 0)
        lines.append(
            "| {rank} | `{method}` | `{paper}` | {year} | {family} | {fdr} | {wfo} | {cost} | {risk} | {cit} |".format(
                rank=index,
                method=normalize_text(row.get("methodId")),
                paper=normalize_text(row.get("paperId")),
                year=to_int(row.get("year"), 0),
                family=normalize_text(row.get("methodFamily")),
                fdr=normalize_text(row.get("expectedImpactOnFdrQ")),
                wfo=normalize_text(row.get("expectedImpactOnWfo")),
                cost=normalize_text(row.get("integrationCost")),
                risk=normalize_text(row.get("riskLevel")),
                cit=citations,
            )
        )

    lines.extend(["", "## Action Hints", ""])
    for index, row in enumerate(shortlist, start=1):
        lines.append(
            f"{index}. `{normalize_text(row.get('methodId'))}`: {normalize_text(row.get('actionHint'))}"
        )
    if warnings:
        lines.extend(["", "## Warnings", ""])
        for warning in warnings:
            lines.append(f"- {warning}")
    lines.append("")
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    repo_root = Path(__file__).resolve().parents[1]
    day_token = utc_day()

    digest_path = resolve_path(repo_root, args.digest)
    citation_path = resolve_path(repo_root, args.citation_network)
    pdf_extract_path = resolve_path(repo_root, args.pdf_extract_report)
    hypotheses_path = resolve_path(repo_root, args.hypotheses)
    output_path = resolve_path(repo_root, args.output)

    if normalize_text(args.markdown):
        markdown_path = resolve_path(repo_root, args.markdown)
    else:
        markdown_path = resolve_path(
            repo_root,
            f"{DEFAULT_MARKDOWN_DIR}/fdr_frontier_shortlist_{day_token}.md",
        )

    warnings: List[str] = []

    digest_payload, digest_warning = safe_read_json_object(digest_path)
    if digest_warning:
        warnings.append(digest_warning)
    citation_payload, citation_warning = safe_read_json_object(citation_path)
    if citation_warning:
        warnings.append(citation_warning)
    pdf_payload, pdf_warning = safe_read_json_object(pdf_extract_path)
    if pdf_warning:
        warnings.append(pdf_warning)
    hypothesis_payload, hypothesis_warning = safe_read_json_object(hypotheses_path)
    if hypothesis_warning:
        warnings.append(hypothesis_warning)

    shortlist = build_shortlist(
        digest_payload=digest_payload,
        citation_payload=citation_payload,
        pdf_payload=pdf_payload,
        hypothesis_payload=hypothesis_payload,
        top_k=max(to_int(args.top_k, DEFAULT_TOP_K), 1),
    )

    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": utc_iso(),
        "generatedDate": day_token,
        "inputs": {
            "digest": str(digest_path),
            "citationNetwork": str(citation_path),
            "pdfExtractReport": str(pdf_extract_path),
            "hypotheses": str(hypotheses_path),
        },
        "stats": {
            "shortlistCount": len(shortlist),
            "warningCount": len(warnings),
        },
        "warnings": warnings,
        "shortlist": shortlist,
    }

    markdown = render_markdown(
        generated_at=payload["generatedAt"],
        generated_day=payload["generatedDate"],
        inputs=payload["inputs"],
        warnings=warnings,
        shortlist=shortlist,
    )

    write_json(output_path, payload)
    write_markdown(markdown_path, markdown)

    print(
        json.dumps(
            {
                "schemaVersion": SCHEMA_VERSION,
                "shortlistCount": len(shortlist),
                "output": str(output_path),
                "markdown": str(markdown_path),
                "warnings": len(warnings),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
