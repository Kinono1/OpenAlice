from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SELECTIVE_PATH = REPO_ROOT / "scripts" / "selective_inference.py"
COMPARE_PATH = REPO_ROOT / "scripts" / "stage_c_selective_compare.py"


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


selective_module = load_module(SELECTIVE_PATH, "selective_inference_module")
compare_module = load_module(COMPARE_PATH, "stage_c_selective_compare_module")


class TestSelectiveInference(unittest.TestCase):
    def test_ebh_prototype_flags_small_p_values(self) -> None:
        candidates = [
            selective_module.CandidateStat(index=0, strategy_id="A", strategy_name="alpha", p_value=1e-6),
            selective_module.CandidateStat(index=1, strategy_id="B", strategy_name="beta", p_value=0.2),
            selective_module.CandidateStat(index=2, strategy_id="C", strategy_name="gamma", p_value=0.7),
        ]
        payload = selective_module.run_ebh(candidates, alpha=0.1)
        self.assertEqual(payload["method"], "e_bh_prototype")
        self.assertGreaterEqual(payload["rejectCount"], 1)
        self.assertTrue(payload["champion"]["passed"])
        self.assertLess(payload["champion"]["effectiveQ"], 0.1)

    def test_compare_doc_summary_marks_keep_workstream_b_when_improved(self) -> None:
        payload = {
            "generatedAt": "2026-03-11T00:00:00Z",
            "assets": [
                {
                    "asset": "BTC",
                    "bh": {"fdrQ": 1.0},
                    "selectiveInference": {"championEffectiveQ": 0.4, "championPassed": False},
                    "deltaSelectiveVsBh": {"effectiveQMinusBhFdrQ": -0.6},
                },
                {
                    "asset": "ETH",
                    "bh": {"fdrQ": 1.0},
                    "selectiveInference": {"championEffectiveQ": 1.0, "championPassed": False},
                    "deltaSelectiveVsBh": {"effectiveQMinusBhFdrQ": 0.0},
                },
            ],
            "summary": {
                "completedAssets": 2,
                "assetsWhereSelectiveImproved": 1,
                "assetsWhereSelectivePassed": 0,
                "keepWorkstreamB": True,
            },
        }
        with tempfile.TemporaryDirectory(prefix="openalice-selective-doc-") as tmp:
            doc_path = Path(tmp) / "selective.md"
            compare_module.write_doc(doc_path, payload)
            text = doc_path.read_text(encoding="utf-8")
            self.assertIn("keep_workstream_b: `yes`", text)
            self.assertIn("Selective-inference shows at least some method-level value", text)


if __name__ == "__main__":
    unittest.main()
