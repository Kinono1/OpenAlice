#!/usr/bin/env python3
"""Recurring strategy research watch for trading optimization.

Primary source: arXiv Atom API (q-fin + ML related categories).
Outputs:
- latest_digest.json / latest_digest.md
- latest_experiment_cards.json / latest_experiment_cards.md
- archive/<run_id>/*
- state file with dedupe memory
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

ARXIV_ENDPOINT = "https://export.arxiv.org/api/query"

DEFAULT_QUERIES_BALANCED = [
    "(cat:q-fin.PM OR cat:q-fin.TR OR cat:q-fin.ST) AND (all:trading OR all:portfolio OR all:market)",
    "(cat:q-fin.RM OR cat:q-fin.ST) AND (all:cvar OR all:drawdown OR all:risk)",
    '(cat:cs.LG OR cat:stat.ML) AND (all:"time series" OR all:forecast) AND (all:finance OR all:trading OR all:crypto)',
    '(cat:cs.AI OR cat:cs.LG) AND (all:"reinforcement learning" AND (all:trading OR all:execution))',
]

DEFAULT_QUERIES_CRYPTO = [
    "(cat:q-fin.TR OR cat:q-fin.ST) AND (all:crypto OR all:bitcoin OR all:ethereum) AND (all:trading OR all:market)",
    "(cat:q-fin.TR OR cat:q-fin.RM) AND (all:perpetual OR all:funding rate OR all:basis) AND (all:crypto OR all:bitcoin)",
    '(cat:q-fin.TR OR cat:cs.LG) AND (all:"order book" OR all:microstructure OR all:liquidity) AND (all:execution OR all:slippage)',
    '(cat:cs.LG OR cat:stat.ML) AND (all:"time series" OR all:forecast OR all:transformer) AND (all:crypto OR all:asset pricing)',
    '(cat:cs.AI OR cat:cs.LG OR cat:q-fin.TR) AND (all:"reinforcement learning" OR all:bandit) AND ((all:"market making" OR all:"order book" OR all:execution) AND (all:crypto OR all:financial OR all:trading))',
]

DEFAULT_QUERIES_CRYPTO_PLUS = [
    *DEFAULT_QUERIES_CRYPTO,
    "(cat:q-fin.TR OR cat:q-fin.ST) AND (all:options OR all:derivatives) AND (all:crypto OR all:bitcoin OR all:ethereum)",
    '(cat:q-fin.TR OR cat:q-fin.RM OR cat:cs.SI) AND (all:"on-chain" OR all:blockchain) AND (all:liquidity OR all:volatility OR all:returns)',
    '(cat:q-fin.TR OR cat:cs.LG) AND (all:"market microstructure" OR all:"limit order book") AND (all:crypto OR all:digital asset)',
]

TAG_RULES: Dict[str, List[str]] = {
    "regime_detection": [
        "regime",
        "hidden markov",
        "state space",
        "change point",
        "switching",
    ],
    "cost_execution": [
        "transaction cost",
        "market impact",
        "slippage",
        "execution",
        "order book",
    ],
    "risk_control": [
        "cvar",
        "value at risk",
        "drawdown",
        "tail risk",
        "risk management",
    ],
    "online_learning": [
        "online learning",
        "continual learning",
        "streaming",
        "adaptive",
    ],
    "feature_engineering": [
        "factor model",
        "feature selection",
        "representation",
        "embedding",
        "cross-sectional",
    ],
    "rl_policy": [
        "reinforcement learning",
        "actor-critic",
        "policy gradient",
        "bandit",
    ],
    "uncertainty_calibration": [
        "calibration",
        "uncertainty",
        "probabilistic",
        "quantile",
    ],
    "macro_news": [
        "news",
        "sentiment",
        "llm",
        "language model",
        "macro",
    ],
}

SCORE_RULES: Dict[str, float] = {
    "regime": 1.2,
    "change point": 1.3,
    "volatility": 1.0,
    "transaction cost": 1.4,
    "market impact": 1.4,
    "slippage": 1.2,
    "execution": 1.0,
    "cvar": 1.4,
    "drawdown": 1.2,
    "tail risk": 1.2,
    "risk": 0.6,
    "time series": 0.8,
    "forecast": 0.8,
    "online learning": 1.2,
    "continual learning": 1.2,
    "reinforcement learning": 1.2,
    "policy": 0.6,
    "portfolio": 0.8,
    "factor": 0.7,
    "calibration": 0.8,
    "uncertainty": 0.8,
    "news": 0.6,
    "sentiment": 0.6,
    "crypto": 1.0,
    "bitcoin": 0.9,
}

CATEGORY_BONUS: Dict[str, float] = {
    "q-fin.PM": 1.2,
    "q-fin.TR": 1.2,
    "q-fin.RM": 1.1,
    "q-fin.ST": 1.0,
    "cs.LG": 0.5,
    "stat.ML": 0.5,
}

TRADING_CONTEXT_KEYWORDS = [
    "trading",
    "trade",
    "market",
    "portfolio",
    "asset",
    "finance",
    "financial",
    "crypto",
    "bitcoin",
    "ethereum",
    "order book",
    "execution",
    "slippage",
    "liquidity",
    "price",
    "returns",
    "alpha",
    "factor",
    "risk",
]

FINANCE_ANCHOR_KEYWORDS = [
    "finance",
    "financial",
    "portfolio",
    "asset",
    "crypto",
    "bitcoin",
    "ethereum",
    "stock",
    "equity",
    "order book",
    "return",
    "returns",
    "price",
    "cvar",
    "value at risk",
    "drawdown",
    "tail risk",
    "risk",
]

HARD_FINANCE_ANCHOR_KEYWORDS = [
    "finance",
    "financial",
    "portfolio",
    "asset",
    "crypto",
    "bitcoin",
    "ethereum",
    "stock",
    "equity",
    "order book",
    "cvar",
    "value at risk",
    "drawdown",
    "tail risk",
]

CRYPTO_FOCUS_KEYWORDS = [
    "crypto",
    "cryptocurrency",
    "bitcoin",
    "ethereum",
    "blockchain",
    "digital asset",
    "on-chain",
    "defi",
    "perpetual",
    "funding rate",
    "stablecoin",
    "market making",
    "order book",
    "dex",
    "cex",
    "token",
]

NON_CRYPTO_MARKET_HINTS = [
    "s&p 500",
    "treasury",
    "bond market",
    "credit card",
    "mortgage",
    "housing market",
    "equity market",
]

OUT_OF_DOMAIN_KEYWORDS = [
    "transport",
    "transportation",
    "traffic",
    "agriculture",
    "crop",
    "healthcare",
    "medical",
    "robotics",
    "wireless",
    "edge computing",
    "smart grid",
    "power system",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Watch arXiv for strategy ideas and emit optimization experiment cards."
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root (default: parent of this script).",
    )
    parser.add_argument(
        "--query-profile",
        default="crypto",
        choices=["balanced", "crypto", "crypto_plus"],
        help=(
            "Preset query profile: balanced (general), "
            "crypto (crypto-first), or crypto_plus (broader crypto search)."
        ),
    )
    parser.add_argument(
        "--out-dir",
        default="data/research/strategy-watch",
        help="Output directory for digest/cards/state.",
    )
    parser.add_argument(
        "--state-file",
        default="data/research/strategy-watch/state.json",
        help="State file path for dedupe memory.",
    )
    parser.add_argument(
        "--lookback-days",
        type=int,
        default=30,
        help="Only keep papers updated within this many days.",
    )
    parser.add_argument(
        "--max-results",
        type=int,
        default=120,
        help="arXiv max results per query.",
    )
    parser.add_argument(
        "--timeout-sec",
        type=int,
        default=25,
        help="HTTP timeout per query.",
    )
    parser.add_argument(
        "--request-delay-sec",
        type=float,
        default=1.2,
        help="Delay between query requests to reduce rate-limit risk.",
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        default=3,
        help="Retry count per query when temporary fetch errors occur.",
    )
    parser.add_argument(
        "--retry-backoff-sec",
        type=float,
        default=2.0,
        help="Base backoff seconds for retries (exponential).",
    )
    parser.add_argument(
        "--min-score",
        type=float,
        default=2.2,
        help="Minimum relevance score to keep a paper.",
    )
    parser.add_argument(
        "--max-digest-items",
        type=int,
        default=20,
        help="Max papers written to digest lists.",
    )
    parser.add_argument(
        "--max-cards",
        type=int,
        default=8,
        help="Max experiment cards to generate from top new papers.",
    )
    parser.add_argument(
        "--max-cards-per-query",
        type=int,
        default=2,
        help=(
            "Per source_query quota before filling remainder globally "
            "(0 disables query quota)."
        ),
    )
    parser.add_argument(
        "--cards-source",
        default="new_or_recent",
        choices=["new_only", "new_or_recent", "recent_only"],
        help=(
            "Source set used to build experiment cards: "
            "new_only (only unseen papers), "
            "new_or_recent (fallback to recent scored papers when no new), "
            "recent_only (always from recent scored papers)."
        ),
    )
    parser.add_argument(
        "--query",
        action="append",
        default=[],
        help="Extra arXiv search query (repeatable).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Do not write files/state; print summary only.",
    )
    parser.add_argument(
        "--preserve-latest-on-empty",
        dest="preserve_latest_on_empty",
        action="store_true",
        default=True,
        help=(
            "When fetch fails/returns empty with errors, keep previous latest_* files "
            "and only write archive snapshot."
        ),
    )
    parser.add_argument(
        "--no-preserve-latest-on-empty",
        dest="preserve_latest_on_empty",
        action="store_false",
        help="Disable protection and always overwrite latest_* files.",
    )
    argv = sys.argv[1:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    return parser.parse_args(argv)


def resolve_path(root: Path, raw: str) -> Path:
    p = Path(raw)
    if p.is_absolute():
        return p
    return (root / p).resolve()


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(dt_obj: dt.datetime) -> str:
    return dt_obj.astimezone(dt.timezone.utc).isoformat()


def normalize_text(raw: str) -> str:
    return " ".join((raw or "").replace("\n", " ").split()).strip()


def truncate_text(raw: str, width: int = 360) -> str:
    s = normalize_text(raw)
    if len(s) <= width:
        return s
    return s[: width - 3].rstrip() + "..."


def parse_arxiv_time(raw: str) -> Optional[dt.datetime]:
    text = (raw or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(dt.timezone.utc)
    except Exception:
        return None


def fetch_arxiv_feed(query: str, max_results: int, timeout_sec: int) -> str:
    params = {
        "search_query": query,
        "start": "0",
        "max_results": str(max_results),
        "sortBy": "lastUpdatedDate",
        "sortOrder": "descending",
    }
    url = f"{ARXIV_ENDPOINT}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url=url, headers={"User-Agent": "openalice-strategy-watch/1.0"}
    )
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
        return resp.read().decode("utf-8", errors="replace")


def is_retryable_fetch_error(err: Exception) -> bool:
    code = int(getattr(err, "code", 0) or 0)
    if code in {429, 500, 502, 503, 504}:
        return True
    text = str(err).lower()
    return any(
        key in text
        for key in (
            "timed out",
            "timeout",
            "temporarily unavailable",
            "connection reset",
            "connection aborted",
            "429",
        )
    )


def parse_arxiv_feed(xml_text: str, source_query: str) -> List[Dict[str, Any]]:
    ns = {
        "a": "http://www.w3.org/2005/Atom",
        "arxiv": "http://arxiv.org/schemas/atom",
    }
    root = ET.fromstring(xml_text)
    out: List[Dict[str, Any]] = []
    for entry in root.findall("a:entry", ns):
        id_url = normalize_text(entry.findtext("a:id", default="", namespaces=ns))
        paper_id = id_url.rsplit("/", 1)[-1] if id_url else ""
        title = normalize_text(entry.findtext("a:title", default="", namespaces=ns))
        summary = normalize_text(entry.findtext("a:summary", default="", namespaces=ns))
        published_raw = normalize_text(
            entry.findtext("a:published", default="", namespaces=ns)
        )
        updated_raw = normalize_text(
            entry.findtext("a:updated", default="", namespaces=ns)
        )
        published_at = parse_arxiv_time(published_raw)
        updated_at = parse_arxiv_time(updated_raw)

        authors = [
            normalize_text(node.findtext("a:name", default="", namespaces=ns))
            for node in entry.findall("a:author", ns)
        ]
        categories = [
            node.attrib.get("term", "").strip()
            for node in entry.findall("a:category", ns)
            if node.attrib.get("term")
        ]
        primary_node = entry.find("arxiv:primary_category", ns)
        primary_category = (
            primary_node.attrib.get("term", "").strip()
            if primary_node is not None
            else ""
        )
        if primary_category and primary_category not in categories:
            categories.insert(0, primary_category)

        pdf_url = ""
        for link in entry.findall("a:link", ns):
            link_type = (link.attrib.get("type") or "").strip().lower()
            title_attr = (link.attrib.get("title") or "").strip().lower()
            href = (link.attrib.get("href") or "").strip()
            if not href:
                continue
            if title_attr == "pdf" or link_type == "application/pdf":
                pdf_url = href
                break

        out.append(
            {
                "paper_id": paper_id,
                "id_url": id_url,
                "title": title,
                "summary": summary,
                "published_at": iso(published_at) if published_at else "",
                "updated_at": iso(updated_at) if updated_at else "",
                "authors": authors,
                "categories": categories,
                "primary_category": primary_category,
                "pdf_url": pdf_url,
                "source_query": source_query,
            }
        )
    return out


def infer_tags(text: str, categories: Sequence[str]) -> List[str]:
    lower = text.lower()
    tags: List[str] = []
    for tag, keywords in TAG_RULES.items():
        if any(k in lower for k in keywords):
            tags.append(tag)

    cat_set = set(categories)
    if any(cat.startswith("q-fin") for cat in cat_set) and "risk_control" not in tags:
        tags.append("risk_control")
    if any(cat == "q-fin.ST" for cat in cat_set) and "regime_detection" not in tags:
        tags.append("regime_detection")
    if not tags:
        tags.append("general_alpha")
    return tags


def is_trading_context_relevant(
    title: str, summary: str, categories: Sequence[str]
) -> bool:
    cat_set = {str(x).strip() for x in categories if str(x).strip()}
    if any(cat.startswith("q-fin") for cat in cat_set):
        return True
    text = f"{title} {summary}".lower()
    hit_count = sum(1 for kw in TRADING_CONTEXT_KEYWORDS if kw in text)
    anchor_count = sum(1 for kw in FINANCE_ANCHOR_KEYWORDS if kw in text)
    hard_anchor_count = sum(1 for kw in HARD_FINANCE_ANCHOR_KEYWORDS if kw in text)
    out_domain_hits = sum(1 for kw in OUT_OF_DOMAIN_KEYWORDS if kw in text)
    if out_domain_hits >= 2 and hard_anchor_count < 2:
        return False
    if out_domain_hits >= 1 and hard_anchor_count < 2:
        return False
    # For non q-fin categories, require stronger contextual evidence + hard finance anchor.
    return hit_count >= 2 and hard_anchor_count >= 1


def score_paper(title: str, summary: str, categories: Sequence[str]) -> float:
    text = f"{title} {summary}".lower()
    score = 0.0
    for phrase, weight in SCORE_RULES.items():
        if phrase in text:
            score += weight
    for cat in categories:
        score += CATEGORY_BONUS.get(cat, 0.0)
    return round(score, 4)


def count_keyword_hits(text: str, keywords: Sequence[str]) -> int:
    lower = text.lower()
    return sum(1 for kw in keywords if kw in lower)


def dedupe_by_id(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    by_id: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        pid = row.get("paper_id", "").strip()
        if not pid:
            continue
        cur = by_id.get(pid)
        if cur is None:
            by_id[pid] = row
            continue
        if float(row.get("score", 0.0)) > float(cur.get("score", 0.0)):
            by_id[pid] = row
    return list(by_id.values())


def cap_by_query(
    rows: Sequence[Dict[str, Any]],
    max_per_query: int,
    max_total: int,
) -> List[Dict[str, Any]]:
    if max_total <= 0:
        return []
    if max_per_query <= 0:
        return list(rows[:max_total])

    out: List[Dict[str, Any]] = []
    used: Dict[str, int] = {}
    skipped: List[Dict[str, Any]] = []

    for row in rows:
        query = str(row.get("source_query", "")).strip()
        if query and used.get(query, 0) >= max_per_query:
            skipped.append(row)
            continue
        out.append(row)
        if query:
            used[query] = used.get(query, 0) + 1
        if len(out) >= max_total:
            return out

    for row in skipped:
        if len(out) >= max_total:
            break
        out.append(row)
    return out


def load_state(path: Path) -> Dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"seen_ids": [], "history": [], "last_run_at": ""}


def save_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def paper_sort_key(row: Dict[str, Any]) -> Tuple[float, str]:
    return (float(row.get("score", 0.0)), row.get("updated_at", ""))


def template_for_tag(tag: str) -> Dict[str, Any]:
    templates: Dict[str, Dict[str, Any]] = {
        "regime_detection": {
            "hypothesis": "更稳健的市场状态划分能显著提升 robust utility 且降低方差。",
            "intervention": "替换/增强 regime 识别（rule -> kmeans/HMM/change-point），并保留 H0 对照。",
            "kill_criteria": [
                "robust_ci_lb95 未高于基线 +0.002",
                "robust_std 高于基线允许上限",
            ],
        },
        "cost_execution": {
            "hypothesis": "更细粒度成本/滑点建模可减少回测乐观偏差并改善净收益稳定性。",
            "intervention": "分资产分流动性设置 slippage/latency 参数，加入冲击惩罚项。",
            "kill_criteria": [
                "net_trim10_mean 未改善且 turnover 上升 >15%",
                "error_ratio_mean > 0.2",
            ],
        },
        "risk_control": {
            "hypothesis": "尾部风险约束强化可改善回撤与极端情景鲁棒性。",
            "intervention": "引入 CVaR/ES 约束和动态仓位上限，比较风险收益权衡。",
            "kill_criteria": [
                "robust_mean 与 net_trim10_mean 同时劣化",
                "风险指标改善不足以覆盖收益损失",
            ],
        },
        "online_learning": {
            "hypothesis": "更频繁的小步再训练可提升分布漂移期表现。",
            "intervention": "缩短 retrain 周期并做 warm-start，设置漂移触发更新阈值。",
            "kill_criteria": [
                "更新频率提升但 robust_mean 无提升",
                "训练失败率或 error_ratio 上升",
            ],
        },
        "feature_engineering": {
            "hypothesis": "新增高信息特征可改善 lift 与成本后收益。",
            "intervention": "引入新特征组（结构、波动、跨市场）并做消融实验。",
            "kill_criteria": [
                "lift_pos_mean 无提升",
                "turnover 上升导致成本后净收益下降",
            ],
        },
        "rl_policy": {
            "hypothesis": "策略层动作优化可提升执行质量与风险回报。",
            "intervention": "在现有信号之上增加轻量 RL/上下文 bandit 决策层。",
            "kill_criteria": [
                "相对监督基线无统计显著提升",
                "训练不稳定导致方差显著增大",
            ],
        },
        "uncertainty_calibration": {
            "hypothesis": "更好的置信度校准能降低错误开仓并提升稳健收益。",
            "intervention": "对比 sigmoid/isotonic/温度缩放并按置信度分层开仓。",
            "kill_criteria": [
                "robust_ci_lb95 未提升",
                "coverage 或 calibration error 恶化",
            ],
        },
        "macro_news": {
            "hypothesis": "事件/情绪特征在高波动窗口可提升 regime-aware 选择效果。",
            "intervention": "构建新闻事件特征并仅在特定 regime 触发。",
            "kill_criteria": [
                "增量特征未提升 robust_mean",
                "error_ratio 或延迟成本显著恶化",
            ],
        },
        "general_alpha": {
            "hypothesis": "新方法在当前协议下可形成可验证增益。",
            "intervention": "先做小样本 seed 试验，再扩展到完整主榜/副榜。",
            "kill_criteria": [
                "小样本无正向信号",
                "计算成本显著上升但收益无改进",
            ],
        },
    }
    return templates.get(tag, templates["general_alpha"])


def build_experiment_cards(
    papers: Sequence[Dict[str, Any]],
    max_cards: int,
    experiment_id_hint: str,
) -> List[Dict[str, Any]]:
    cards: List[Dict[str, Any]] = []
    for idx, paper in enumerate(papers[:max_cards], start=1):
        tags = paper.get("tags", []) or ["general_alpha"]
        main_tag = tags[0]
        tmpl = template_for_tag(main_tag)
        cards.append(
            {
                "card_id": f"CARD-{idx:03d}",
                "source_paper_id": paper.get("paper_id", ""),
                "source_title": paper.get("title", ""),
                "source_updated_at": paper.get("updated_at", ""),
                "source_score": float(paper.get("score", 0.0) or 0.0),
                "source_tags": list(paper.get("tags", []) or []),
                "source_query": paper.get("source_query", ""),
                "source_categories": list(paper.get("categories", []) or []),
                "tag": main_tag,
                "hypothesis": tmpl["hypothesis"],
                "intervention": tmpl["intervention"],
                "controls": [
                    "保持现有 H0 主榜基线不变",
                    "固定 universe/seed/cost 参数确保可比性",
                ],
                "metrics": [
                    "robust_mean",
                    "robust_ci_lb95",
                    "robust_std",
                    "net_trim10_mean",
                    "error_ratio_mean",
                    "turnover_mean",
                ],
                "kill_criteria": tmpl["kill_criteria"],
                "week1_plan": [
                    "实现最小可运行改动（单变量）",
                    "跑 2~4 seeds 烟测并生成 aggregate",
                ],
                "week2_plan": [
                    "扩展到完整 seeds 并过 transfer gate",
                    "更新 decision.md 与上线前 shadow 计划",
                ],
                "suggested_commands": {
                    "smoke": (
                        "pnpm train:cvar-next-matrix -- "
                        f"--experiment-id {experiment_id_hint}-{idx:02d} "
                        "--execute --continue-on-error --max-runs 4"
                    ),
                    "full": (
                        "pnpm train:cvar-next-matrix -- "
                        f"--experiment-id {experiment_id_hint}-{idx:02d} "
                        "--execute --continue-on-error"
                    ),
                },
            }
        )
    return cards


def render_digest_markdown(payload: Dict[str, Any]) -> str:
    lines = [
        "# Strategy Research Digest",
        "",
        f"- generatedAt: `{payload.get('generated_at', '')}`",
        f"- lookbackDays: `{payload.get('lookback_days', '')}`",
        f"- queryCount: `{payload.get('query_count', '')}`",
        f"- fetchedPapers: `{payload.get('fetched_papers', '')}`",
        f"- filteredPapers: `{payload.get('filtered_papers', '')}`",
        f"- newPapers: `{payload.get('new_papers', '')}`",
        "",
        "## Top New Papers",
        "",
        "| paper_id | score | updated_at | tags | title |",
        "|---|---:|---|---|---|",
    ]
    for item in payload.get("top_new", []):
        lines.append(
            "| "
            f"{item.get('paper_id', '')} | "
            f"{item.get('score', 0):.3f} | "
            f"{item.get('updated_at', '')} | "
            f"{', '.join(item.get('tags', []))} | "
            f"{item.get('title', '').replace('|', '/')} |"
        )

    lines.extend(["", "## Notes", ""])
    for item in payload.get("top_new", [])[:8]:
        lines.append(f"### {item.get('paper_id', '')} - {item.get('title', '')}")
        lines.append("")
        lines.append(f"- score: `{item.get('score', 0):.3f}`")
        lines.append(f"- categories: `{', '.join(item.get('categories', []))}`")
        lines.append(f"- url: {item.get('id_url', '')}")
        if item.get("pdf_url"):
            lines.append(f"- pdf: {item.get('pdf_url', '')}")
        lines.append(f"- summary: {item.get('summary_short', '')}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def render_cards_markdown(cards: Sequence[Dict[str, Any]]) -> str:
    lines = ["# Strategy Experiment Cards", ""]
    for card in cards:
        lines.extend(
            [
                f"## {card.get('card_id', '')} - {card.get('tag', '')}",
                "",
                f"- sourcePaper: `{card.get('source_paper_id', '')}`",
                f"- sourceTitle: {card.get('source_title', '')}",
                f"- sourceQuery: `{card.get('source_query', '')}`",
                "",
                "### Hypothesis",
                "",
                card.get("hypothesis", ""),
                "",
                "### Intervention",
                "",
                card.get("intervention", ""),
                "",
                "### Controls",
            ]
        )
        for item in card.get("controls", []):
            lines.append(f"- {item}")
        lines.extend(["", "### Metrics"])
        for metric in card.get("metrics", []):
            lines.append(f"- `{metric}`")
        lines.extend(["", "### Kill Criteria"])
        for item in card.get("kill_criteria", []):
            lines.append(f"- {item}")
        lines.extend(["", "### Week 1"])
        for item in card.get("week1_plan", []):
            lines.append(f"- {item}")
        lines.extend(["", "### Week 2"])
        for item in card.get("week2_plan", []):
            lines.append(f"- {item}")
        lines.extend(["", "### Commands"])
        commands = card.get("suggested_commands", {})
        if isinstance(commands, dict):
            for key, value in commands.items():
                lines.append(f"- `{key}`: `{value}`")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    if args.repo_root:
        repo_root = resolve_path(repo_root, args.repo_root)
    out_dir = resolve_path(repo_root, args.out_dir)
    state_path = resolve_path(repo_root, args.state_file)

    if args.query_profile == "balanced":
        queries = list(DEFAULT_QUERIES_BALANCED)
    elif args.query_profile == "crypto_plus":
        queries = list(DEFAULT_QUERIES_CRYPTO_PLUS)
    else:
        queries = list(DEFAULT_QUERIES_CRYPTO)
    queries.extend([q.strip() for q in args.query if q and q.strip()])
    queries = list(dict.fromkeys(queries))

    fetched: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = []
    total_queries = len(queries)
    for idx, query in enumerate(queries):
        last_error: Optional[Exception] = None
        retries = max(int(args.max_retries), 0)
        for attempt in range(retries + 1):
            try:
                xml_text = fetch_arxiv_feed(
                    query=query,
                    max_results=args.max_results,
                    timeout_sec=args.timeout_sec,
                )
                rows = parse_arxiv_feed(xml_text, source_query=query)
                fetched.extend(rows)
                last_error = None
                break
            except Exception as err:
                last_error = err
                if attempt >= retries or not is_retryable_fetch_error(err):
                    break
                backoff = max(float(args.retry_backoff_sec), 0.0) * (2**attempt)
                if backoff > 0:
                    time.sleep(backoff)
        if last_error is not None:
            errors.append({"query": query, "error": str(last_error)})
        if idx < total_queries - 1:
            delay = max(float(args.request_delay_sec), 0.0)
            if delay > 0:
                time.sleep(delay)

    horizon = now_utc() - dt.timedelta(days=max(args.lookback_days, 1))
    scored: List[Dict[str, Any]] = []
    crypto_focus_profile = args.query_profile in {"crypto", "crypto_plus"}
    for row in fetched:
        updated = parse_arxiv_time(row.get("updated_at", ""))
        if updated is None:
            continue
        if updated < horizon:
            continue
        title = row.get("title", "")
        summary = row.get("summary", "")
        categories = row.get("categories", []) or []
        if not is_trading_context_relevant(
            title=title, summary=summary, categories=categories
        ):
            continue
        text = f"{title} {summary}"
        text_lower = text.lower()
        crypto_focus_hits = count_keyword_hits(text_lower, CRYPTO_FOCUS_KEYWORDS)
        has_qfin_cat = any(str(cat).startswith("q-fin") for cat in categories)

        # For crypto-oriented profiles, avoid non-finance/non-crypto generic papers.
        if crypto_focus_profile and crypto_focus_hits == 0 and not has_qfin_cat:
            continue

        score = score_paper(title=title, summary=summary, categories=categories)
        if crypto_focus_profile:
            score += min(crypto_focus_hits, 3) * 0.6
            if crypto_focus_hits == 0 and count_keyword_hits(
                text_lower, NON_CRYPTO_MARKET_HINTS
            ):
                score -= 0.8
            score = round(score, 4)
        tags = infer_tags(text=text, categories=categories)
        row = dict(row)
        row["score"] = score
        row["tags"] = tags
        row["summary_short"] = truncate_text(summary, width=420)
        if score >= args.min_score:
            scored.append(row)

    deduped = dedupe_by_id(scored)
    deduped.sort(key=paper_sort_key, reverse=True)

    state = load_state(state_path)
    seen_ids = set(state.get("seen_ids", []))
    new_rows = [row for row in deduped if row.get("paper_id", "") not in seen_ids]
    top_new = new_rows[: max(args.max_digest_items, 1)]

    run_id = now_utc().strftime("%Y%m%dT%H%M%SZ")
    experiment_hint = f"strategy-{run_id}"
    if args.cards_source == "new_only":
        card_candidates = list(new_rows)
    elif args.cards_source == "recent_only":
        card_candidates = list(deduped)
    else:
        card_candidates = list(new_rows) if new_rows else list(deduped)
    card_fallback_used = bool(
        args.cards_source == "new_or_recent" and not new_rows and bool(deduped)
    )

    cards = build_experiment_cards(
        papers=cap_by_query(
            rows=card_candidates,
            max_per_query=int(args.max_cards_per_query),
            max_total=max(args.max_cards, 0),
        ),
        max_cards=max(args.max_cards, 0),
        experiment_id_hint=experiment_hint,
    )

    digest_payload = {
        "generated_at": iso(now_utc()),
        "run_id": run_id,
        "query_count": len(queries),
        "query_profile": args.query_profile,
        "queries": queries,
        "lookback_days": args.lookback_days,
        "fetched_papers": len(fetched),
        "filtered_papers": len(deduped),
        "new_papers": len(new_rows),
        "cards_source_mode": args.cards_source,
        "cards_fallback_used": card_fallback_used,
        "card_candidate_count": len(card_candidates),
        "errors": errors,
        "top_new": top_new,
    }
    cards_payload = {
        "generated_at": iso(now_utc()),
        "run_id": run_id,
        "query_profile": args.query_profile,
        "max_cards_per_query": int(args.max_cards_per_query),
        "cards_source_mode": args.cards_source,
        "cards_fallback_used": card_fallback_used,
        "card_candidate_count": len(card_candidates),
        "card_count": len(cards),
        "cards": cards,
    }

    preserve_latest = bool(
        args.preserve_latest_on_empty
        and len(cards) == 0
        and len(errors) > 0
        and len(fetched) == 0
    )

    if not args.dry_run:
        archive_dir = out_dir / "archive" / run_id
        if not preserve_latest:
            save_json(out_dir / "latest_digest.json", digest_payload)
            save_json(out_dir / "latest_experiment_cards.json", cards_payload)
            (out_dir / "latest_digest.md").parent.mkdir(parents=True, exist_ok=True)
            (out_dir / "latest_digest.md").write_text(
                render_digest_markdown(digest_payload),
                encoding="utf-8",
            )
            (out_dir / "latest_experiment_cards.md").write_text(
                render_cards_markdown(cards),
                encoding="utf-8",
            )
        save_json(archive_dir / "digest.json", digest_payload)
        save_json(archive_dir / "experiment_cards.json", cards_payload)
        (archive_dir / "digest.md").write_text(
            render_digest_markdown(digest_payload),
            encoding="utf-8",
        )
        (archive_dir / "experiment_cards.md").write_text(
            render_cards_markdown(cards),
            encoding="utf-8",
        )

        merged_seen = list(
            dict.fromkeys(list(seen_ids) + [r.get("paper_id", "") for r in new_rows])
        )
        merged_seen = [x for x in merged_seen if x][-5000:]
        history = state.get("history", [])
        if not isinstance(history, list):
            history = []
        history.append(
            {
                "run_id": run_id,
                "run_at": iso(now_utc()),
                "query_count": len(queries),
                "fetched_papers": len(fetched),
                "filtered_papers": len(deduped),
                "new_papers": len(new_rows),
                "errors": len(errors),
            }
        )
        history = history[-200:]
        state_payload = {
            "last_run_at": iso(now_utc()),
            "seen_ids": merged_seen,
            "history": history,
            "queries": queries,
            "query_profile": args.query_profile,
            "lookback_days": args.lookback_days,
        }
        save_json(state_path, state_payload)

    print(
        json.dumps(
            {
                "runId": run_id,
                "outDir": str(out_dir),
                "stateFile": str(state_path),
                "queryCount": len(queries),
                "queryProfile": args.query_profile,
                "fetchedPapers": len(fetched),
                "filteredPapers": len(deduped),
                "newPapers": len(new_rows),
                "cardsSourceMode": args.cards_source,
                "cardsFallbackUsed": card_fallback_used,
                "cardCount": len(cards),
                "preservedLatest": preserve_latest,
                "errors": errors,
                "dryRun": bool(args.dry_run),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
