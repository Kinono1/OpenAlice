#!/usr/bin/env python3
"""Tests for build_citation_network script."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "build_citation_network.py"


class TestBuildCitationNetwork(unittest.TestCase):
    def write_json(self, path: Path, payload: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def run_builder(
        self,
        *,
        digest_path: Path,
        output_path: Path,
        include_external_refs: bool = False,
    ) -> dict[str, Any]:
        cmd = [
            sys.executable,
            str(SCRIPT_PATH),
            "--digest",
            str(digest_path),
            "--output",
            str(output_path),
        ]
        if include_external_refs:
            cmd.append("--include-external-refs")

        run = subprocess.run(
            cmd,
            cwd=str(REPO_ROOT),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(run.returncode, 0, msg=run.stderr)
        self.assertTrue(output_path.exists(), msg=run.stdout)
        return json.loads(output_path.read_text(encoding="utf-8"))

    def test_internal_refs_create_edges(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-citation-network-") as tmp:
            root = Path(tmp)
            digest_path = root / "digest.json"
            output_path = root / "citation_network.json"
            self.write_json(
                digest_path,
                {
                    "top_new": [
                        {
                            "paper_id": "P1",
                            "title": "Paper 1",
                            "source": "arxiv",
                            "citation_count": 10,
                            "references": ["P2", "P3", "MISSING-1"],
                        },
                        {
                            "paper_id": "P2",
                            "title": "Paper 2",
                            "source": "nature",
                            "citation_count": 8,
                            "references": ["P3"],
                        },
                        {
                            "paper_id": "P3",
                            "title": "Paper 3",
                            "source": "neurips",
                            "citation_count": 5,
                            "references": [],
                        },
                    ]
                },
            )

            payload = self.run_builder(
                digest_path=digest_path,
                output_path=output_path,
                include_external_refs=False,
            )

            self.assertEqual(payload["schemaVersion"], "citation_network.v1")
            self.assertEqual(payload["sourceDigest"], str(digest_path))

            node_ids = [node["paperId"] for node in payload["nodes"]]
            self.assertEqual(node_ids, ["P1", "P2", "P3"])
            self.assertTrue(all(node["isExternal"] is False for node in payload["nodes"]))

            edge_triplets = {
                (edge["source"], edge["target"], edge["type"])
                for edge in payload["edges"]
            }
            self.assertEqual(
                edge_triplets,
                {
                    ("P1", "P2", "cites"),
                    ("P1", "P3", "cites"),
                    ("P2", "P3", "cites"),
                },
            )

    def test_external_refs_only_included_with_flag(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-citation-network-") as tmp:
            root = Path(tmp)
            digest_path = root / "digest.json"
            output_without_flag = root / "citation_network_without_external.json"
            output_with_flag = root / "citation_network_with_external.json"
            self.write_json(
                digest_path,
                {
                    "top_new": [
                        {
                            "paper_id": "P1",
                            "title": "Paper 1",
                            "source": "arxiv",
                            "citation_count": 10,
                            "references": ["P2", "EXT-1"],
                        },
                        {
                            "paper_id": "P2",
                            "title": "Paper 2",
                            "source": "nature",
                            "citation_count": 8,
                            "references": [],
                        },
                    ]
                },
            )

            without_external = self.run_builder(
                digest_path=digest_path,
                output_path=output_without_flag,
                include_external_refs=False,
            )
            with_external = self.run_builder(
                digest_path=digest_path,
                output_path=output_with_flag,
                include_external_refs=True,
            )

            node_ids_without = {node["paperId"] for node in without_external["nodes"]}
            edge_pairs_without = {
                (edge["source"], edge["target"]) for edge in without_external["edges"]
            }
            self.assertNotIn("EXT-1", node_ids_without)
            self.assertNotIn(("P1", "EXT-1"), edge_pairs_without)

            node_ids_with = {node["paperId"] for node in with_external["nodes"]}
            edge_pairs_with = {
                (edge["source"], edge["target"]) for edge in with_external["edges"]
            }
            self.assertIn("EXT-1", node_ids_with)
            self.assertIn(("P1", "EXT-1"), edge_pairs_with)

            external_node = next(
                node for node in with_external["nodes"] if node["paperId"] == "EXT-1"
            )
            self.assertTrue(external_node["isExternal"])
            self.assertEqual(external_node["title"], "External reference EXT-1")

    def test_stats_computed_and_stable(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-citation-network-") as tmp:
            root = Path(tmp)
            digest_path = root / "digest.json"
            output_path = root / "citation_network_stats.json"
            self.write_json(
                digest_path,
                {
                    "top_new": [
                        {
                            "paper_id": "P1",
                            "title": "Paper 1",
                            "source": "arxiv",
                            "citation_count": 10,
                            "references": ["P2", "P3", "EXT-1", "P2"],
                        },
                        {
                            "paper_id": "P2",
                            "title": "Paper 2",
                            "source": "nature",
                            "citation_count": 8,
                            "references": ["P3", "EXT-1"],
                        },
                        {
                            "paper_id": "P3",
                            "title": "Paper 3",
                            "source": "neurips",
                            "citation_count": 5,
                            "references": ["EXT-1"],
                        },
                    ]
                },
            )

            payload = self.run_builder(
                digest_path=digest_path,
                output_path=output_path,
                include_external_refs=True,
            )

            stats = payload["stats"]
            self.assertEqual(stats["nodeCount"], 4)
            self.assertEqual(stats["edgeCount"], 6)
            self.assertAlmostEqual(stats["density"], 0.5, places=12)
            self.assertAlmostEqual(stats["avgOutDegree"], 1.5, places=12)
            self.assertEqual(
                stats["topInDegree"],
                [
                    {"paperId": "EXT-1", "inDegree": 3},
                    {"paperId": "P3", "inDegree": 2},
                    {"paperId": "P2", "inDegree": 1},
                ],
            )

    def test_falls_back_to_top_recent_when_top_new_empty(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-citation-network-") as tmp:
            root = Path(tmp)
            digest_path = root / "digest.json"
            output_path = root / "citation_network_recent.json"
            self.write_json(
                digest_path,
                {
                    "top_new": [],
                    "top_recent": [
                        {
                            "paper_id": "R1",
                            "title": "Recent 1",
                            "source": "openalex",
                            "citation_count": 3,
                            "references": ["R2"],
                        },
                        {
                            "paper_id": "R2",
                            "title": "Recent 2",
                            "source": "openalex",
                            "citation_count": 1,
                            "references": [],
                        },
                    ],
                },
            )

            payload = self.run_builder(
                digest_path=digest_path,
                output_path=output_path,
                include_external_refs=False,
            )
            node_ids = [node["paperId"] for node in payload["nodes"]]
            self.assertEqual(node_ids, ["R1", "R2"])
            self.assertEqual(len(payload["edges"]), 1)
            self.assertEqual(payload["edges"][0]["source"], "R1")
            self.assertEqual(payload["edges"][0]["target"], "R2")

    def test_merges_top_recent_and_top_new_when_both_present(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-citation-network-") as tmp:
            root = Path(tmp)
            digest_path = root / "digest.json"
            output_path = root / "citation_network_merged.json"
            self.write_json(
                digest_path,
                {
                    "top_recent": [
                        {
                            "paper_id": "R1",
                            "title": "Recent 1",
                            "source": "openalex",
                            "citation_count": 3,
                            "references": ["R2"],
                        },
                        {
                            "paper_id": "R2",
                            "title": "Recent 2",
                            "source": "openalex",
                            "citation_count": 1,
                            "references": [],
                        },
                    ],
                    "top_new": [
                        {
                            "paper_id": "N1",
                            "title": "New 1",
                            "source": "crossref",
                            "citation_count": 5,
                            "references": ["R1"],
                        },
                        {
                            "paper_id": "R1",
                            "title": "Recent 1 duplicate",
                            "source": "openalex",
                            "citation_count": 99,
                            "references": [],
                        },
                    ],
                },
            )

            payload = self.run_builder(
                digest_path=digest_path,
                output_path=output_path,
                include_external_refs=False,
            )
            node_ids = [node["paperId"] for node in payload["nodes"]]
            self.assertEqual(node_ids, ["R1", "R2", "N1"])
            edge_pairs = {(row["source"], row["target"]) for row in payload["edges"]}
            self.assertIn(("R1", "R2"), edge_pairs)
            self.assertIn(("N1", "R1"), edge_pairs)

    def test_openalex_url_reference_maps_to_internal_edge(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-citation-network-") as tmp:
            root = Path(tmp)
            digest_path = root / "digest.json"
            output_path = root / "citation_network_openalex_ref.json"
            self.write_json(
                digest_path,
                {
                    "top_new": [
                        {
                            "paper_id": "W1",
                            "title": "OpenAlex A",
                            "source": "openalex",
                            "citation_count": 2,
                            "references": ["https://openalex.org/W2"],
                        },
                        {
                            "paper_id": "W2",
                            "title": "OpenAlex B",
                            "source": "openalex",
                            "citation_count": 1,
                            "references": [],
                        },
                    ]
                },
            )

            payload = self.run_builder(
                digest_path=digest_path,
                output_path=output_path,
                include_external_refs=False,
            )
            edge_pairs = {(row["source"], row["target"]) for row in payload["edges"]}
            self.assertIn(("W1", "W2"), edge_pairs)

    def test_openalex_url_paper_id_is_canonicalized(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-citation-network-") as tmp:
            root = Path(tmp)
            digest_path = root / "digest.json"
            output_path = root / "citation_network_openalex_paperid.json"
            self.write_json(
                digest_path,
                {
                    "top_new": [
                        {
                            "paper_id": "W1",
                            "title": "OpenAlex A",
                            "source": "openalex",
                            "citation_count": 2,
                            "references": ["https://openalex.org/works/w2"],
                        },
                        {
                            "paper_id": "https://openalex.org/works/w2",
                            "title": "OpenAlex B",
                            "source": "openalex",
                            "citation_count": 1,
                            "references": [],
                        },
                    ]
                },
            )

            payload = self.run_builder(
                digest_path=digest_path,
                output_path=output_path,
                include_external_refs=False,
            )
            node_ids = [node["paperId"] for node in payload["nodes"]]
            self.assertIn("W2", node_ids)
            self.assertNotIn("https://openalex.org/works/w2", node_ids)
            edge_pairs = {(row["source"], row["target"]) for row in payload["edges"]}
            self.assertIn(("W1", "W2"), edge_pairs)


if __name__ == "__main__":
    unittest.main()
