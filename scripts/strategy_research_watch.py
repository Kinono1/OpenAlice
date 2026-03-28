#!/usr/bin/env python3
"""Recurring strategy research watch for trading optimization.

Default source: arXiv Atom API (q-fin + ML related categories).
Optional sources: OpenAlex, Crossref.
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
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

ARXIV_ENDPOINT = "https://export.arxiv.org/api/query"
OPENALEX_ENDPOINT = "https://api.openalex.org/works"
CROSSREF_ENDPOINT = "https://api.crossref.org/works"
SUPPORTED_SOURCES = ("arxiv", "openalex", "crossref")
HTTP_USER_AGENT = "openalice-strategy-watch/1.0"
DOI_PATTERN = re.compile(r"^10\.\d{4,9}/\S+$")
OPENALEX_WORK_ID_PATTERN = re.compile(r"^[Ww]\d+$")

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
    '(cat:stat.ME OR cat:math.ST OR cat:stat.ML OR cat:q-fin.ST) AND (all:"false discovery rate" OR all:"fdr control" OR all:"multiple testing" OR all:"q-value") AND (all:finance OR all:market OR all:trading OR all:crypto)',
    '(cat:stat.ME OR cat:math.ST OR cat:cs.LG OR cat:q-fin.ST) AND (all:"online fdr" OR all:"alpha-investing" OR all:LORD OR all:SAFFRON OR all:AdaPT) AND (all:sequential OR all:online OR all:adaptive) AND (all:finance OR all:trading OR all:portfolio)',
]

DEFAULT_QUERIES_FDR_STATS = [
    '(cat:stat.ME OR cat:math.ST OR cat:stat.ML) AND (all:"false discovery rate" OR all:"fdr control" OR all:"multiple testing") AND (all:finance OR all:portfolio OR all:trading OR all:"asset pricing")',
    '(cat:stat.ME OR cat:math.ST OR cat:cs.LG) AND (all:"online fdr" OR all:"alpha-investing" OR all:LORD OR all:SAFFRON) AND (all:sequential OR all:streaming OR all:online) AND (all:finance OR all:market OR all:trading)',
    '(cat:stat.ME OR cat:math.ST OR cat:stat.ML) AND (all:AdaPT OR all:IHW OR all:"adaptive procedures" OR all:"adaptive multiple testing") AND (all:factor OR all:portfolio OR all:asset OR all:finance)',
    '(cat:stat.ME OR cat:math.ST OR cat:stat.ML) AND (all:"Storey q-value" OR all:"q-value" OR all:"local fdr") AND (all:signal OR all:factor OR all:returns OR all:finance)',
    '(cat:stat.ME OR cat:math.PR OR cat:stat.ML) AND (all:"e-values" OR all:"safe testing" OR all:"betting martingale") AND (all:"multiple testing" OR all:"sequential testing") AND (all:market OR all:trading OR all:portfolio)',
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
    "false discovery rate": 1.6,
    "fdr control": 1.5,
    "multiple testing": 1.4,
    "online fdr": 1.4,
    "q-value": 1.2,
    "alpha-investing": 1.3,
    "saffron": 1.2,
    "lord": 1.1,
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

PROMO_SPAM_PHRASES = [
    "referral code",
    "invitation code",
    "promo code",
    "coupon code",
    "off on trading fees",
    "sign up bonus",
    "exclusive bonus",
]

PROMO_SPAM_PATTERNS = [
    re.compile(r"\b(referral|invitation|promo|coupon)\s+code\b", flags=re.IGNORECASE),
    re.compile(r"\bget\s+\d{1,3}%\s+off\b", flags=re.IGNORECASE),
    re.compile(r"\boff\s+on\s+trading\s+fees?\b", flags=re.IGNORECASE),
    re.compile(r"\bbonus\b", flags=re.IGNORECASE),
]

LOW_SIGNAL_TITLE_PHRASES = [
    "replication package",
    "data package",
    "supplementary material",
    "supplementary dataset",
    "dataset release",
]

LOW_SIGNAL_VENUE_HINTS = [
    "zenodo",
    "figshare",
    "osf",
    "dryad",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Watch research sources for strategy ideas and emit optimization experiment cards."
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root (default: parent of this script).",
    )
    parser.add_argument(
        "--query-profile",
        default="crypto",
        choices=["balanced", "crypto", "crypto_plus", "fdr_stats"],
        help=(
            "Preset query profile: balanced (general), "
            "crypto (crypto-first), crypto_plus (broader crypto search), "
            "or fdr_stats (false discovery/multiple-testing methods)."
        ),
    )
    parser.add_argument(
        "--sources",
        default="arxiv",
        help=(
            "Comma-separated source list. Supported: "
            "arxiv,openalex,crossref (default: arxiv)."
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
        "--venue-filter",
        default="",
        help="Optional comma-separated venue substring filters.",
    )
    parser.add_argument(
        "--citation-depth",
        type=int,
        choices=[0, 1, 2],
        default=0,
        help="Citation expansion depth gate (currently metadata-only; 0/1/2).",
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
    argv = [arg for arg in sys.argv[1:] if arg != "--"]
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


def parse_sources(raw: str) -> List[str]:
    values = [x.strip().lower() for x in str(raw or "arxiv").split(",")]
    values = [x for x in values if x]
    out: List[str] = []
    for value in values:
        if value not in SUPPORTED_SOURCES:
            continue
        if value not in out:
            out.append(value)
    if not out:
        return ["arxiv"]
    return out


def parse_venue_filter(raw: str) -> List[str]:
    values = [normalize_text(x).lower() for x in str(raw or "").split(",")]
    return [x for x in values if x]


def simplify_query_for_text(raw: str) -> str:
    text = str(raw or "")
    # Remove arXiv category tokens, keep natural language terms.
    text = re.sub(r"\bcat:[^\s()]+", " ", text, flags=re.IGNORECASE)
    # Keep all: payload while stripping the operator itself.
    text = re.sub(r"\ball:", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(?:AND|OR|NOT)\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"[()\"']", " ", text)
    text = re.sub(r"[^0-9A-Za-z.\-_/+\s]", " ", text)
    return normalize_text(text)


def normalize_openalex_work_id(raw: Any) -> str:
    text = normalize_text(str(raw or ""))
    if not text:
        return ""
    if OPENALEX_WORK_ID_PATTERN.fullmatch(text):
        return text.upper()

    parse_target = text if "://" in text else f"https://{text}"
    parsed = urllib.parse.urlparse(parse_target)
    host = normalize_text(parsed.netloc).lower()
    if host.startswith("www."):
        host = host[4:]
    if host != "openalex.org":
        return ""

    for segment in [normalize_text(seg) for seg in parsed.path.split("/")]:
        if OPENALEX_WORK_ID_PATTERN.fullmatch(segment):
            return segment.upper()
    return ""


def normalize_doi(raw: Any) -> str:
    doi = normalize_text(str(raw or "")).lower()
    if not doi:
        return ""

    for prefix in (
        "https://doi.org/",
        "http://doi.org/",
        "https://dx.doi.org/",
        "http://dx.doi.org/",
        "doi:",
    ):
        if doi.startswith(prefix):
            doi = doi[len(prefix) :]
            break
    doi = doi.strip()
    if not DOI_PATTERN.fullmatch(doi):
        return ""
    return doi


def normalize_reference_id(raw: Any) -> str:
    value = normalize_text(str(raw or ""))
    if not value:
        return ""
    work_id = normalize_openalex_work_id(value)
    if work_id:
        return work_id
    doi = normalize_doi(value)
    if doi:
        return doi
    return value


def canonicalize_seen_id_token(raw: Any) -> str:
    value = normalize_text(str(raw or ""))
    if not value:
        return ""

    lowered = value.lower()
    if lowered.startswith("pid:"):
        canonical = canonicalize_seen_id_token(value[4:])
        return f"pid:{canonical}" if canonical else ""
    if lowered.startswith("doi:"):
        canonical = normalize_doi(value[4:])
        return f"doi:{canonical}" if canonical else ""

    work_id = normalize_openalex_work_id(value)
    if work_id:
        return work_id
    doi = normalize_doi(value)
    if doi:
        return doi
    return value


def expand_seen_id_aliases(raw: Any) -> List[str]:
    value = normalize_text(str(raw or ""))
    if not value:
        return []
    aliases: List[str] = [value]

    canonical = canonicalize_seen_id_token(value)
    if canonical:
        aliases.append(canonical)

    work_id = normalize_openalex_work_id(value)
    if work_id:
        aliases.extend(
            [
                work_id,
                work_id.lower(),
                f"pid:{work_id}",
                f"pid:{work_id.lower()}",
                f"https://openalex.org/{work_id}",
                f"https://openalex.org/{work_id.lower()}",
                f"https://openalex.org/works/{work_id}",
                f"https://openalex.org/works/{work_id.lower()}",
                f"pid:https://openalex.org/{work_id}",
                f"pid:https://openalex.org/{work_id.lower()}",
                f"pid:https://openalex.org/works/{work_id}",
                f"pid:https://openalex.org/works/{work_id.lower()}",
            ]
        )

    doi = normalize_doi(value)
    if doi:
        aliases.extend([doi, f"doi:{doi}"])

    if value.lower().startswith(("pid:", "doi:")):
        aliases.append(normalize_text(value.split(":", 1)[-1]))

    out = list(dict.fromkeys(x for x in aliases if x))
    return out


def normalize_http_url(raw: Any) -> str:
    text = normalize_text(str(raw or ""))
    if not text:
        return ""
    lowered = text.lower()
    if lowered in {"none", "null", "nan", "n/a", "na"}:
        return ""
    parsed = urllib.parse.urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return text


def parse_crossref_date_parts(parts: Any) -> Optional[str]:
    if not isinstance(parts, list) or not parts:
        return None
    first = parts[0]
    if not isinstance(first, list) or not first:
        return None
    vals = list(first) + [1, 1]
    try:
        year = int(vals[0])
        month = int(vals[1])
        day = int(vals[2])
        parsed = dt.datetime(year, month, day, tzinfo=dt.timezone.utc)
        return iso(parsed)
    except Exception:
        return None


def extract_openalex_abstract(raw: Any) -> str:
    if not isinstance(raw, dict) or not raw:
        return ""
    terms: List[Tuple[int, str]] = []
    for token, positions in raw.items():
        if not isinstance(token, str) or not isinstance(positions, list):
            continue
        for pos in positions:
            try:
                terms.append((int(pos), token))
            except Exception:
                continue
    if not terms:
        return ""
    terms.sort(key=lambda x: x[0])
    return normalize_text(" ".join(token for _, token in terms))


def venue_matches_filter(venue: str, filters: Sequence[str]) -> bool:
    if not filters:
        return True
    text = normalize_text(venue).lower()
    if not text:
        return False
    return any(item in text for item in filters)


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
        url=url, headers={"User-Agent": HTTP_USER_AGENT}
    )
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
        return resp.read().decode("utf-8", errors="replace")


def fetch_openalex_feed(query: str, max_results: int, timeout_sec: int) -> str:
    params = {
        "search": query,
        "per-page": str(max(1, min(int(max_results), 200))),
        "sort": "publication_date:desc",
    }
    url = f"{OPENALEX_ENDPOINT}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url=url, headers={"User-Agent": HTTP_USER_AGENT}
    )
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
        return resp.read().decode("utf-8", errors="replace")


def fetch_crossref_feed(query: str, max_results: int, timeout_sec: int) -> str:
    params = {
        "query.bibliographic": query,
        "rows": str(max(1, min(int(max_results), 200))),
        "sort": "published",
        "order": "desc",
    }
    url = f"{CROSSREF_ENDPOINT}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url=url, headers={"User-Agent": HTTP_USER_AGENT}
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
        doi = normalize_doi(entry.findtext("arxiv:doi", default="", namespaces=ns))
        venue = normalize_text(
            entry.findtext("arxiv:journal_ref", default="", namespaces=ns)
        )

        pdf_url = ""
        for link in entry.findall("a:link", ns):
            link_type = (link.attrib.get("type") or "").strip().lower()
            title_attr = (link.attrib.get("title") or "").strip().lower()
            href = normalize_http_url(link.attrib.get("href"))
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
                "source": "arxiv",
                "venue": venue,
                "citation_count": None,
                "doi": doi,
                "references": [],
                "references_count": 0,
            }
        )
    return out


def parse_openalex_feed(
    json_text: str, source_query: str, citation_depth: int = 0
) -> List[Dict[str, Any]]:
    payload = json.loads(json_text or "{}")
    items = payload.get("results", []) if isinstance(payload, dict) else []
    out: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        id_url = normalize_text(str(item.get("id", "")))
        paper_id = normalize_openalex_work_id(id_url)
        if not paper_id and id_url:
            tail = id_url.rsplit("/", 1)[-1]
            paper_id = normalize_openalex_work_id(tail) or tail
        title = normalize_text(str(item.get("display_name", "")))
        summary = extract_openalex_abstract(item.get("abstract_inverted_index"))
        publication_date = normalize_text(str(item.get("publication_date", "")))
        updated_date = normalize_text(str(item.get("updated_date", "")))
        published_at = parse_arxiv_time(publication_date)
        updated_at = parse_arxiv_time(updated_date) or published_at
        authors: List[str] = []
        for auth in item.get("authorships", []) or []:
            if not isinstance(auth, dict):
                continue
            author_obj = auth.get("author", {})
            if isinstance(author_obj, dict):
                name = normalize_text(str(author_obj.get("display_name", "")))
                if name:
                    authors.append(name)
        concepts = item.get("concepts", []) or []
        categories = [
            normalize_text(str(c.get("display_name", "")))
            for c in concepts
            if isinstance(c, dict) and c.get("display_name")
        ]
        primary_topic = item.get("primary_topic", {})
        primary_category = ""
        if isinstance(primary_topic, dict):
            primary_category = normalize_text(str(primary_topic.get("display_name", "")))
        if primary_category and primary_category not in categories:
            categories.insert(0, primary_category)
        best_loc = item.get("best_oa_location")
        primary_loc = item.get("primary_location")
        pdf_url = ""
        for loc in (best_loc, primary_loc):
            if not isinstance(loc, dict):
                continue
            candidate = normalize_http_url(loc.get("pdf_url", ""))
            if candidate:
                pdf_url = candidate
                break
        venue = ""
        for loc in (primary_loc, best_loc):
            if not isinstance(loc, dict):
                continue
            source_obj = loc.get("source", {})
            if isinstance(source_obj, dict):
                venue = normalize_text(str(source_obj.get("display_name", "")))
                if venue:
                    break
        citation_count_raw = item.get("cited_by_count")
        try:
            citation_count = int(citation_count_raw)
        except Exception:
            citation_count = None
        doi = normalize_doi((item.get("doi") or ""))
        referenced = item.get("referenced_works", []) or []
        references_all: List[str] = []
        for ref in referenced:
            ref_id = normalize_reference_id(ref)
            if ref_id:
                references_all.append(ref_id)
        if citation_depth > 0:
            references = references_all[:200]
        else:
            references = []

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
                "source": "openalex",
                "venue": venue,
                "citation_count": citation_count,
                "doi": doi,
                "references": references,
                "references_count": len(references_all),
            }
        )
    return out


def parse_crossref_feed(
    json_text: str, source_query: str, citation_depth: int = 0
) -> List[Dict[str, Any]]:
    payload = json.loads(json_text or "{}")
    message = payload.get("message", {}) if isinstance(payload, dict) else {}
    items = message.get("items", []) if isinstance(message, dict) else []
    out: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        doi = normalize_doi(item.get("DOI", ""))
        id_url = normalize_text(str(item.get("URL", "")))
        if not id_url and doi:
            id_url = f"https://doi.org/{doi}"
        paper_id = doi
        if not paper_id:
            paper_id = id_url.rsplit("/", 1)[-1] if id_url else ""
        raw_titles = item.get("title", [])
        if isinstance(raw_titles, list):
            title = normalize_text(str(raw_titles[0] if raw_titles else ""))
        else:
            title = normalize_text(str(raw_titles))
        summary = normalize_text(str(item.get("abstract", "")))
        if summary:
            summary = normalize_text(re.sub(r"<[^>]+>", " ", summary))
        issued = item.get("issued", {})
        published_print = item.get("published-print", {})
        published_online = item.get("published-online", {})
        created_obj = item.get("created", {})
        indexed_obj = item.get("indexed", {})
        deposited_obj = item.get("deposited", {})
        published_at = parse_crossref_date_parts(
            issued.get("date-parts") if isinstance(issued, dict) else None
        )
        if not published_at:
            published_at = parse_crossref_date_parts(
                published_print.get("date-parts")
                if isinstance(published_print, dict)
                else None
            )
        if not published_at:
            published_at = parse_crossref_date_parts(
                published_online.get("date-parts")
                if isinstance(published_online, dict)
                else None
            )
        created = normalize_text(
            str(created_obj.get("date-time", "") if isinstance(created_obj, dict) else "")
        )
        indexed = normalize_text(
            str(indexed_obj.get("date-time", "") if isinstance(indexed_obj, dict) else "")
        )
        deposited = normalize_text(
            str(
                deposited_obj.get("date-time", "")
                if isinstance(deposited_obj, dict)
                else ""
            )
        )
        updated_at = parse_arxiv_time(indexed) or parse_arxiv_time(deposited)
        published_dt = parse_arxiv_time(published_at or "")
        if updated_at is None:
            updated_at = parse_arxiv_time(created) or published_dt

        authors: List[str] = []
        for author in item.get("author", []) or []:
            if not isinstance(author, dict):
                continue
            given = normalize_text(str(author.get("given", "")))
            family = normalize_text(str(author.get("family", "")))
            full = normalize_text(f"{given} {family}")
            if not full:
                full = normalize_text(str(author.get("name", "")))
            if full:
                authors.append(full)

        raw_subjects = item.get("subject", []) or []
        categories = [
            normalize_text(str(x))
            for x in raw_subjects
            if normalize_text(str(x))
        ]
        primary_category = categories[0] if categories else ""

        venue = ""
        raw_container = item.get("container-title", [])
        if isinstance(raw_container, list) and raw_container:
            venue = normalize_text(str(raw_container[0]))
        elif isinstance(raw_container, str):
            venue = normalize_text(raw_container)

        citation_count_raw = item.get("is-referenced-by-count")
        try:
            citation_count = int(citation_count_raw)
        except Exception:
            citation_count = None

        pdf_url = ""
        for link in item.get("link", []) or []:
            if not isinstance(link, dict):
                continue
            content_type = normalize_text(str(link.get("content-type", ""))).lower()
            href = normalize_http_url(link.get("URL", ""))
            if not href:
                continue
            if "pdf" in content_type:
                pdf_url = href
                break

        raw_refs = item.get("reference", []) or []
        references_all: List[str] = []
        for ref in raw_refs:
            if not isinstance(ref, dict):
                continue
            ref_id = normalize_reference_id(ref.get("DOI", "")) or normalize_reference_id(
                ref.get("key", "")
            )
            if ref_id:
                references_all.append(ref_id)
        if citation_depth > 0:
            references = references_all[:200]
        else:
            references = []

        out.append(
            {
                "paper_id": paper_id,
                "id_url": id_url,
                "title": title,
                "summary": summary,
                "published_at": published_at or "",
                "updated_at": iso(updated_at) if updated_at else (published_at or ""),
                "authors": authors,
                "categories": categories,
                "primary_category": primary_category,
                "pdf_url": pdf_url,
                "source_query": source_query,
                "source": "crossref",
                "venue": venue,
                "citation_count": citation_count,
                "doi": doi,
                "references": references,
                "references_count": len(references_all),
            }
        )
    return out


def fetch_rows_for_source(
    source: str,
    source_query: str,
    max_results: int,
    timeout_sec: int,
    citation_depth: int,
) -> List[Dict[str, Any]]:
    source_name = str(source or "").strip().lower()
    if source_name == "arxiv":
        xml_text = fetch_arxiv_feed(
            query=source_query,
            max_results=max_results,
            timeout_sec=timeout_sec,
        )
        return parse_arxiv_feed(xml_text, source_query=source_query)

    text_query = simplify_query_for_text(source_query)
    if not text_query:
        text_query = normalize_text(source_query)
    if source_name == "openalex":
        json_text = fetch_openalex_feed(
            query=text_query,
            max_results=max_results,
            timeout_sec=timeout_sec,
        )
        return parse_openalex_feed(
            json_text,
            source_query=source_query,
            citation_depth=citation_depth,
        )
    if source_name == "crossref":
        json_text = fetch_crossref_feed(
            query=text_query,
            max_results=max_results,
            timeout_sec=timeout_sec,
        )
        return parse_crossref_feed(
            json_text,
            source_query=source_query,
            citation_depth=citation_depth,
        )
    raise ValueError(f"Unsupported source: {source}")


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


def is_promotional_spam(title: str, summary: str, venue: str = "") -> bool:
    text = f"{title} {summary} {venue}".lower()
    if not text.strip():
        return False
    phrase_hits = sum(1 for phrase in PROMO_SPAM_PHRASES if phrase in text)
    pattern_hits = sum(1 for pattern in PROMO_SPAM_PATTERNS if pattern.search(text))

    if "referral code" in text or "invitation code" in text or "promo code" in text:
        return True
    if re.search(r"\bget\s+\d{1,3}%\s+off\b", text) and (
        "trading fee" in text or "bonus" in text
    ):
        return True
    return phrase_hits >= 2 and pattern_hits >= 1


def is_low_signal_research_artifact(
    *,
    title: str,
    summary: str,
    venue: str,
    citation_count: int,
    references_count: int,
) -> bool:
    text = f"{title} {summary}".lower()
    venue_text = normalize_text(venue).lower()
    title_hit = any(phrase in text for phrase in LOW_SIGNAL_TITLE_PHRASES)
    venue_hit = any(hint in venue_text for hint in LOW_SIGNAL_VENUE_HINTS)
    if not (title_hit or venue_hit):
        return False
    # Keep artifacts that already have substantial citation/reference context.
    return citation_count <= 0 and references_count <= 0


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
    def row_score(item: Dict[str, Any]) -> float:
        try:
            return float(item.get("score", 0.0))
        except Exception:
            return 0.0

    canonical_rows: Dict[str, Dict[str, Any]] = {}
    key_to_canonical: Dict[str, str] = {}

    for row in rows:
        pid = normalize_text(str(row.get("paper_id", "")))
        doi = normalize_doi(row.get("doi", ""))
        aliases: List[str] = []
        if doi:
            aliases.append(f"doi:{doi}")
        if pid:
            aliases.append(f"pid:{pid}")
        source = source_name_from_row(row)
        if source == "openalex" and not doi:
            title_key = normalize_text(str(row.get("title", ""))).lower()
            if len(title_key) >= 20:
                aliases.append(f"title:{title_key}")
        if not aliases:
            continue

        canonical_key = ""
        for alias in aliases:
            mapped = key_to_canonical.get(alias, "")
            if mapped:
                canonical_key = mapped
                break
        if not canonical_key:
            canonical_key = aliases[0]

        existing = canonical_rows.get(canonical_key)
        if existing is None or row_score(row) > row_score(existing):
            canonical_rows[canonical_key] = row

        for alias in aliases:
            old_canonical = key_to_canonical.get(alias, "")
            if old_canonical and old_canonical != canonical_key:
                old_row = canonical_rows.get(old_canonical)
                keep_row = canonical_rows.get(canonical_key)
                if old_row is not None and (
                    keep_row is None or row_score(old_row) > row_score(keep_row)
                ):
                    canonical_rows[canonical_key] = old_row
                for k, v in list(key_to_canonical.items()):
                    if v == old_canonical:
                        key_to_canonical[k] = canonical_key
                canonical_rows.pop(old_canonical, None)
            key_to_canonical[alias] = canonical_key

    return list(canonical_rows.values())


def paper_identity_key(row: Dict[str, Any]) -> str:
    doi = normalize_doi(row.get("doi", ""))
    if doi:
        return f"doi:{doi}"
    pid = normalize_text(str(row.get("paper_id", "")))
    if pid:
        return f"pid:{pid}"
    return ""


def source_name_from_row(row: Dict[str, Any]) -> str:
    source = normalize_text(str(row.get("source", "arxiv"))).lower()
    return source if source in SUPPORTED_SOURCES else "arxiv"


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
                "source": paper.get("source", ""),
                "source_venue": paper.get("venue", ""),
                "source_citation_count": paper.get("citation_count"),
                "source_doi": paper.get("doi", ""),
                "source_references": list(paper.get("references", []) or []),
                "source_references_count": paper.get("references_count", 0),
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
        f"- schemaVersion: `{payload.get('schemaVersion', '')}`",
        f"- lookbackDays: `{payload.get('lookback_days', '')}`",
        f"- queryCount: `{payload.get('query_count', '')}`",
        f"- sources: `{', '.join(payload.get('sources', []) or [])}`",
        f"- fetchedPapers: `{payload.get('fetched_papers', '')}`",
        f"- filteredPapers: `{payload.get('filtered_papers', '')}`",
        f"- newPapers: `{payload.get('new_papers', '')}`",
        "",
        "## Top New Papers",
        "",
        "| paper_id | source | venue | citation_count | score | updated_at | tags | title |",
        "|---|---|---|---:|---:|---|---|---|",
    ]
    for item in payload.get("top_new", []):
        venue = str(item.get("venue", "") or "").replace("|", "/")
        citation_count = item.get("citation_count")
        citation_cell = "" if citation_count is None else str(citation_count)
        lines.append(
            "| "
            f"{item.get('paper_id', '')} | "
            f"{item.get('source', '')} | "
            f"{venue} | "
            f"{citation_cell} | "
            f"{item.get('score', 0):.3f} | "
            f"{item.get('updated_at', '')} | "
            f"{', '.join(item.get('tags', []))} | "
            f"{item.get('title', '').replace('|', '/')} |"
        )

    lines.extend(["", "## Notes", ""])
    for item in payload.get("top_new", [])[:8]:
        lines.append(f"### {item.get('paper_id', '')} - {item.get('title', '')}")
        lines.append("")
        if item.get("source"):
            lines.append(f"- source: `{item.get('source', '')}`")
        if item.get("venue"):
            lines.append(f"- venue: `{item.get('venue', '')}`")
        if item.get("citation_count") is not None:
            lines.append(f"- citation_count: `{item.get('citation_count')}`")
        if item.get("doi"):
            lines.append(f"- doi: `{item.get('doi', '')}`")
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
                f"- source: `{card.get('source', '')}`",
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
        if card.get("source_venue"):
            lines.append(f"- sourceVenue: `{card.get('source_venue', '')}`")
        if card.get("source_citation_count") is not None:
            lines.append(f"- sourceCitationCount: `{card.get('source_citation_count')}`")
        if card.get("source_doi"):
            lines.append(f"- sourceDoi: `{card.get('source_doi', '')}`")
        if card.get("source_references_count") is not None:
            lines.append(
                f"- sourceReferencesCount: `{card.get('source_references_count', 0)}`"
            )
        lines.append("")
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
    elif args.query_profile == "fdr_stats":
        queries = list(DEFAULT_QUERIES_FDR_STATS)
    else:
        queries = list(DEFAULT_QUERIES_CRYPTO)
    queries.extend([q.strip() for q in args.query if q and q.strip()])
    queries = list(dict.fromkeys(queries))
    sources = parse_sources(args.sources)
    venue_filters = parse_venue_filter(args.venue_filter)

    fetched: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = []
    fetch_jobs: List[Tuple[str, str]] = [
        (source, query) for query in queries for source in sources
    ]
    total_jobs = len(fetch_jobs)
    for idx, (source, query) in enumerate(fetch_jobs):
        last_error: Optional[Exception] = None
        retries = max(int(args.max_retries), 0)
        for attempt in range(retries + 1):
            try:
                rows = fetch_rows_for_source(
                    source=source,
                    source_query=query,
                    max_results=args.max_results,
                    timeout_sec=args.timeout_sec,
                    citation_depth=int(args.citation_depth),
                )
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
            errors.append({"source": source, "query": query, "error": str(last_error)})
        if idx < total_jobs - 1:
            delay = max(float(args.request_delay_sec), 0.0)
            if delay > 0:
                time.sleep(delay)

    horizon = now_utc() - dt.timedelta(days=max(args.lookback_days, 1))
    scored: List[Dict[str, Any]] = []
    crypto_focus_profile = args.query_profile in {"crypto", "crypto_plus"}
    for row in fetched:
        source_name = source_name_from_row(row)
        venue = normalize_text(str(row.get("venue", "")))
        if not venue_matches_filter(venue, venue_filters):
            continue
        updated = parse_arxiv_time(row.get("updated_at", ""))
        if updated is None:
            continue
        if updated < horizon:
            continue
        title = normalize_text(str(row.get("title", "")))
        summary = normalize_text(str(row.get("summary", "")))
        if is_promotional_spam(title=title, summary=summary, venue=venue):
            continue
        raw_citation_count = row.get("citation_count")
        try:
            citation_count = int(raw_citation_count)
        except Exception:
            citation_count = 0
        raw_ref_count = row.get("references_count")
        try:
            references_count = int(raw_ref_count)
        except Exception:
            references_count = 0
        if is_low_signal_research_artifact(
            title=title,
            summary=summary,
            venue=venue,
            citation_count=citation_count,
            references_count=references_count,
        ):
            continue
        categories = [normalize_text(str(x)) for x in (row.get("categories", []) or [])]
        categories = [x for x in categories if x]
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
        row["source"] = source_name
        row["venue"] = venue
        row["doi"] = normalize_doi(row.get("doi", ""))
        raw_refs = row.get("references", [])
        if isinstance(raw_refs, list):
            references = [normalize_reference_id(x) for x in raw_refs]
            references = [x for x in references if x]
        else:
            references = []
        if int(args.citation_depth) <= 0:
            references = []
        row["references"] = references
        raw_ref_count = row.get("references_count")
        try:
            references_count = int(raw_ref_count)
        except Exception:
            references_count = len(references)
        row["references_count"] = max(references_count, 0)
        try:
            row["citation_count"] = int(raw_citation_count)
        except Exception:
            row["citation_count"] = None
        row["score"] = score
        row["tags"] = tags
        row["summary_short"] = truncate_text(summary, width=420)
        if score >= args.min_score:
            scored.append(row)

    deduped = dedupe_by_id(scored)
    deduped.sort(key=paper_sort_key, reverse=True)

    state = load_state(state_path)
    raw_seen_values = [normalize_text(str(x)) for x in (state.get("seen_ids", []) or [])]
    raw_seen_values = [x for x in raw_seen_values if x]
    seen_values: List[str] = []
    seen_ids_lookup: set[str] = set()
    for token in raw_seen_values:
        canonical = canonicalize_seen_id_token(token)
        if canonical:
            seen_values.append(canonical)
        else:
            seen_values.append(token)
        seen_ids_lookup.update(expand_seen_id_aliases(token))
    seen_values = list(dict.fromkeys(x for x in seen_values if x))

    def is_seen_paper(row: Dict[str, Any]) -> bool:
        key = paper_identity_key(row)
        if not key:
            return False
        if key in seen_ids_lookup:
            return True
        if key.startswith("pid:") and key[4:] in seen_ids_lookup:
            return True
        if key.startswith("doi:") and key[4:] in seen_ids_lookup:
            return True
        return False

    new_rows = [row for row in deduped if not is_seen_paper(row)]
    top_new = new_rows[: max(args.max_digest_items, 1)]
    top_recent = deduped[: max(args.max_digest_items, 1)]

    source_stats: Dict[str, Dict[str, int]] = {
        source: {"fetched_papers": 0, "filtered_papers": 0, "new_papers": 0}
        for source in sources
    }
    for row in fetched:
        source = source_name_from_row(row)
        source_stats.setdefault(
            source, {"fetched_papers": 0, "filtered_papers": 0, "new_papers": 0}
        )
        source_stats[source]["fetched_papers"] += 1
    for row in deduped:
        source = source_name_from_row(row)
        source_stats.setdefault(
            source, {"fetched_papers": 0, "filtered_papers": 0, "new_papers": 0}
        )
        source_stats[source]["filtered_papers"] += 1
    for row in new_rows:
        source = source_name_from_row(row)
        source_stats.setdefault(
            source, {"fetched_papers": 0, "filtered_papers": 0, "new_papers": 0}
        )
        source_stats[source]["new_papers"] += 1

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
        "schemaVersion": "research_digest.v2",
        "generated_at": iso(now_utc()),
        "run_id": run_id,
        "query_count": len(queries),
        "query_profile": args.query_profile,
        "queries": queries,
        "sources": sources,
        "source_stats": source_stats,
        "venue_filter": list(venue_filters),
        "citation_depth": int(args.citation_depth),
        "lookback_days": args.lookback_days,
        "fetched_papers": len(fetched),
        "filtered_papers": len(deduped),
        "new_papers": len(new_rows),
        "cards_source_mode": args.cards_source,
        "cards_fallback_used": card_fallback_used,
        "card_candidate_count": len(card_candidates),
        "errors": errors,
        "top_new": top_new,
        "top_recent": top_recent,
    }
    cards_payload = {
        "generated_at": iso(now_utc()),
        "run_id": run_id,
        "query_profile": args.query_profile,
        "sources": sources,
        "source_stats": source_stats,
        "venue_filter": list(venue_filters),
        "citation_depth": int(args.citation_depth),
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

        seen_updates: List[str] = []
        for row in new_rows:
            key = paper_identity_key(row)
            if key:
                seen_updates.append(canonicalize_seen_id_token(key) or key)
            pid = canonicalize_seen_id_token(row.get("paper_id", ""))
            if pid:
                seen_updates.append(pid)
            doi = normalize_doi(row.get("doi", ""))
            if doi:
                seen_updates.append(doi)
        merged_seen = list(dict.fromkeys(seen_values + seen_updates))
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
                "sources": list(sources),
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
            "sources": sources,
            "venue_filter": list(venue_filters),
            "citation_depth": int(args.citation_depth),
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
                "sources": sources,
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
