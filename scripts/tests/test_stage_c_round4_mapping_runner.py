from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "stage_c_round4_mapping_runner.py"


def load_module():
    spec = importlib.util.spec_from_file_location("stage_c_round4_mapping_runner", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class TestStageCRound4MappingRunner(unittest.TestCase):
    def test_decide_round4_promotes_unique_best_mapping(self) -> None:
        module = load_module()
        mapping_results = [
            {
                "mapping": "no_trade",
                "variant": "vol_as_no_trade_filter",
                "score": {"score": 1, "killLike": False, "promotable": False},
            },
            {
                "mapping": "breakout",
                "variant": "vol_as_breakout_enable_flag",
                "score": {"score": 5, "killLike": False, "promotable": True},
            },
            {
                "mapping": "trend",
                "variant": "vol_as_trend_enable_flag",
                "score": {"score": 2, "killLike": False, "promotable": True},
            },
        ]
        decision = module.decide_round4(mapping_results)
        self.assertEqual(decision["decision"], "promote_mapping")
        self.assertEqual(decision["selectedMapping"], "breakout")

    def test_decide_round4_kills_all_when_everything_is_dead(self) -> None:
        module = load_module()
        mapping_results = [
            {
                "mapping": "no_trade",
                "variant": "vol_as_no_trade_filter",
                "score": {"score": 0, "killLike": True, "promotable": False},
            },
            {
                "mapping": "breakout",
                "variant": "vol_as_breakout_enable_flag",
                "score": {"score": 0, "killLike": True, "promotable": False},
            },
            {
                "mapping": "trend",
                "variant": "vol_as_trend_enable_flag",
                "score": {"score": 0, "killLike": True, "promotable": False},
            },
        ]
        decision = module.decide_round4(mapping_results)
        self.assertEqual(decision["decision"], "kill_all_mappings")
        self.assertIsNone(decision["selectedMapping"])

    def test_render_decision_memo_includes_mapping_sections(self) -> None:
        module = load_module()
        summary = {
            "generatedAt": "2026-03-13T00:00:00Z",
            "decision": {
                "decision": "promote_mapping",
                "selectedMapping": "trend",
                "reason": "trend won",
            },
            "mappings": [
                {
                    "variant": "vol_as_trend_enable_flag",
                    "score": {"score": 6},
                    "smoke": {"summary": {"assetsWithFdrImprovementVsFrozenBaseline": 1, "assetsWithPboImprovementVsFrozenBaseline": 1, "assetsWithDsrImprovementVsFrozenBaseline": 0}},
                    "eval": {"delta": {"fdrQ": -0.1, "meanPbo": -0.02, "meanDsrProbability": 0.01}},
                }
            ],
        }
        memo = module.render_decision_memo(summary)
        self.assertIn("Stage-C Round 4 Mapping Decision", memo)
        self.assertIn("vol_as_trend_enable_flag", memo)
        self.assertIn("promote_mapping", memo)


if __name__ == "__main__":
    unittest.main()
