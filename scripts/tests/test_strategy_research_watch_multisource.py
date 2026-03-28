#!/usr/bin/env python3
"""Tests for multi-source helpers in strategy_research_watch."""

from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "strategy_research_watch.py"

_SPEC = importlib.util.spec_from_file_location(
    "strategy_research_watch", str(SCRIPT_PATH)
)
if _SPEC is None or _SPEC.loader is None:  # pragma: no cover - defensive guard
    raise RuntimeError("Failed to load strategy_research_watch module spec.")
MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(MODULE)


class TestStrategyResearchWatchMultiSource(unittest.TestCase):
    def test_parse_sources_validates_and_falls_back(self) -> None:
        self.assertEqual(
            MODULE.parse_sources("arxiv,openalex,crossref"),
            ["arxiv", "openalex", "crossref"],
        )
        self.assertEqual(MODULE.parse_sources("openalex,foo,openalex"), ["openalex"])
        self.assertEqual(MODULE.parse_sources("foo,bar"), ["arxiv"])
        self.assertEqual(MODULE.parse_sources(""), ["arxiv"])

    def test_dedupe_prefers_doi_key_then_paper_id(self) -> None:
        rows = [
            {"paper_id": "arxiv-1", "doi": "10.1000/xyz", "score": 1.0},
            {"paper_id": "crossref-9", "doi": "https://doi.org/10.1000/xyz", "score": 3.0},
            {"paper_id": "crossref-9", "score": 2.0},
        ]
        deduped = MODULE.dedupe_by_id(rows)
        self.assertEqual(len(deduped), 1)
        self.assertEqual(deduped[0]["paper_id"], "crossref-9")
        self.assertAlmostEqual(deduped[0]["score"], 3.0)

    def test_dedupe_openalex_title_without_doi(self) -> None:
        rows = [
            {
                "paper_id": "W1",
                "source": "openalex",
                "title": "OrangeX Invitation Code 3rsatgs1 for 3000 USDT",
                "score": 0.5,
            },
            {
                "paper_id": "W2",
                "source": "openalex",
                "title": "OrangeX Invitation Code 3rsatgs1 for 3000 USDT",
                "score": 1.2,
            },
        ]
        deduped = MODULE.dedupe_by_id(rows)
        self.assertEqual(len(deduped), 1)
        self.assertEqual(deduped[0]["paper_id"], "W2")

    def test_venue_filter_keep_drop(self) -> None:
        filters = MODULE.parse_venue_filter("journal of finance, neurips")
        self.assertTrue(MODULE.venue_matches_filter("The Journal of Finance", filters))
        self.assertTrue(MODULE.venue_matches_filter("NeurIPS 2025", filters))
        self.assertFalse(MODULE.venue_matches_filter("Nature Methods", filters))
        self.assertTrue(MODULE.venue_matches_filter("", []))

    def test_simplify_query_strips_arxiv_tokens(self) -> None:
        query = (
            '(cat:q-fin.PM OR cat:q-fin.TR) AND '
            '(all:"time series" OR all:trading OR all:market)'
        )
        simplified = MODULE.simplify_query_for_text(query).lower()
        self.assertNotIn("cat:", simplified)
        self.assertNotIn("all:", simplified)
        self.assertNotIn(" and ", f" {simplified} ")
        self.assertNotIn(" or ", f" {simplified} ")
        self.assertIn("time series", simplified)
        self.assertIn("trading", simplified)
        self.assertIn("market", simplified)

    def test_normalize_http_url_rejects_null_like_values(self) -> None:
        self.assertEqual(MODULE.normalize_http_url("None"), "")
        self.assertEqual(MODULE.normalize_http_url("null"), "")
        self.assertEqual(MODULE.normalize_http_url(""), "")
        self.assertEqual(MODULE.normalize_http_url("ftp://example.test/a.pdf"), "")
        self.assertEqual(
            MODULE.normalize_http_url("https://example.test/a.pdf"),
            "https://example.test/a.pdf",
        )

    def test_normalize_openalex_work_id_segments(self) -> None:
        self.assertEqual(MODULE.normalize_openalex_work_id("W123"), "W123")
        self.assertEqual(MODULE.normalize_openalex_work_id("w123"), "W123")
        self.assertEqual(
            MODULE.normalize_openalex_work_id("https://openalex.org/W1656678770"),
            "W1656678770",
        )
        self.assertEqual(
            MODULE.normalize_openalex_work_id("https://openalex.org/works/w1656678770?x=1"),
            "W1656678770",
        )
        self.assertEqual(
            MODULE.normalize_openalex_work_id("https://openalex.org/W123/related"),
            "W123",
        )
        self.assertEqual(MODULE.normalize_openalex_work_id("10.1000/xyz"), "")

    def test_normalize_doi_regex_guard(self) -> None:
        self.assertEqual(MODULE.normalize_doi("10.1000/XYZ"), "10.1000/xyz")
        self.assertEqual(MODULE.normalize_doi("https://doi.org/10.1234/abc"), "10.1234/abc")
        self.assertEqual(MODULE.normalize_doi("10.anything"), "")
        self.assertEqual(MODULE.normalize_doi("https://openalex.org/W123"), "")

    def test_normalize_reference_id_prefers_openalex(self) -> None:
        self.assertEqual(
            MODULE.normalize_reference_id("https://openalex.org/w1656678770"),
            "W1656678770",
        )
        self.assertEqual(
            MODULE.normalize_reference_id("https://doi.org/10.1000/XYZ"),
            "10.1000/xyz",
        )

    def test_parse_openalex_feed_outputs_canonical_ids(self) -> None:
        payload = {
            "results": [
                {
                    "id": "https://openalex.org/works/W7131074398",
                    "display_name": "Sample OpenAlex Paper",
                    "abstract_inverted_index": {"Sample": [0], "abstract": [1]},
                    "publication_date": "2026-02-01",
                    "updated_date": "2026-02-03",
                    "referenced_works": [
                        "https://openalex.org/w1656678770",
                        "W987654321",
                        "https://doi.org/10.1000/XYZ",
                    ],
                }
            ]
        }
        rows = MODULE.parse_openalex_feed(
            json.dumps(payload), source_query="openalex test", citation_depth=1
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["paper_id"], "W7131074398")
        self.assertEqual(
            rows[0]["references"],
            ["W1656678770", "W987654321", "10.1000/xyz"],
        )

    def test_seen_id_aliases_cover_legacy_openalex_forms(self) -> None:
        aliases = set(MODULE.expand_seen_id_aliases("https://openalex.org/w1656678770"))
        self.assertIn("W1656678770", aliases)
        self.assertIn("pid:W1656678770", aliases)
        self.assertIn("https://openalex.org/w1656678770", aliases)
        self.assertEqual(
            MODULE.canonicalize_seen_id_token("pid:https://openalex.org/w1656678770"),
            "pid:W1656678770",
        )

    def test_parse_args_accepts_fdr_stats_profile(self) -> None:
        with patch.object(
            MODULE.sys, "argv", ["strategy_research_watch.py", "--query-profile", "fdr_stats"]
        ):
            args = MODULE.parse_args()
        self.assertEqual(args.query_profile, "fdr_stats")

    def test_fdr_stats_bundle_has_expected_terms(self) -> None:
        queries = MODULE.DEFAULT_QUERIES_FDR_STATS
        self.assertTrue(queries)

        joined = " ".join(queries).lower()
        expected_fragments = [
            "false discovery rate",
            "multiple testing",
            "adaptive procedures",
            "online fdr",
            "alpha-investing",
            "lord",
            "saffron",
            "adapt",
            "ihw",
            "storey q-value",
            "e-values",
        ]
        for fragment in expected_fragments:
            self.assertIn(fragment, joined)

        for query in queries:
            simplified = MODULE.simplify_query_for_text(query)
            self.assertTrue(
                simplified,
                msg=f"simplified query should not be empty: {query}",
            )

    def test_crypto_plus_bundle_includes_fdr_terms(self) -> None:
        queries = MODULE.DEFAULT_QUERIES_CRYPTO_PLUS
        joined = " ".join(queries).lower()
        self.assertIn("false discovery rate", joined)
        self.assertIn("multiple testing", joined)
        self.assertIn("online fdr", joined)

    def test_promotional_spam_filter(self) -> None:
        spam_title = "Ourbit Referral code KICKBACK Get 20% Off On Trading Fees"
        self.assertTrue(MODULE.is_promotional_spam(spam_title, "bonus today"))
        real_title = "Meta-Learning Reinforcement Learning for Crypto-Return Prediction"
        real_summary = "We evaluate out-of-sample performance with walk-forward validation."
        self.assertFalse(MODULE.is_promotional_spam(real_title, real_summary))

    def test_low_signal_research_artifact_filter(self) -> None:
        self.assertTrue(
            MODULE.is_low_signal_research_artifact(
                title="Replication package: BTC strategy",
                summary="Dataset and package for reproducibility.",
                venue="Zenodo",
                citation_count=0,
                references_count=0,
            )
        )
        self.assertFalse(
            MODULE.is_low_signal_research_artifact(
                title="Replication package: BTC strategy",
                summary="Dataset and package for reproducibility.",
                venue="Zenodo",
                citation_count=8,
                references_count=20,
            )
        )


if __name__ == "__main__":
    unittest.main()
