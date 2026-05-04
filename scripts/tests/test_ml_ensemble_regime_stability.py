#!/usr/bin/env python3
"""Regression tests for regime kmeans numerical-stability guards.

Targets:
- detect_regime_labels should not raise on NaN/Inf/extreme/constant inputs.
- output label length must match input rows.
- stderr should not contain RuntimeWarning storms.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import sys
import unittest
from pathlib import Path

import numpy as np


def load_ml_module():
    script_path = (
        Path(__file__).resolve().parents[1] / "ml_ensemble_v1.py"
    )
    spec = importlib.util.spec_from_file_location("ml_ensemble_v1", script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to load module spec: {script_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class TestRegimeKMeansStability(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.mod = load_ml_module()

    def _run_case(self, features: np.ndarray, train_size: int) -> None:
        stderr_buf = io.StringIO()
        with contextlib.redirect_stderr(stderr_buf):
            labels, diagnostics = self.mod.detect_regime_labels(
                regime_method="kmeans",
                regime_count=3,
                seed=42,
                regime_features=features,
                train_size=train_size,
                labeling_mode="strict",
                kmeans_zclip=8.0,
                kmeans_scale_floor=1e-6,
                kmeans_min_cluster_balance=0.10,
                kmeans_balance_threshold_mode="static",
                diagnostics_level="extended",
                time_index_diagnostics={
                    "sampleTimeCount": int(features.shape[0]),
                    "timeIndexMissCount": 0,
                    "fallbackToLastIndexCount": 0,
                    "futureAlignmentRisk": 0.0,
                },
            )

        self.assertEqual(len(labels), int(features.shape[0]))
        self.assertIsInstance(diagnostics, dict)
        self.assertIn("numericWarningCount", diagnostics)
        self.assertGreaterEqual(int(diagnostics.get("numericWarningCount", 0)), 0)

        stderr_text = stderr_buf.getvalue()
        self.assertEqual(stderr_text.lower().count("runtimewarning"), 0)
        # A few fallback info lines are acceptable; warning storms are not.
        self.assertLessEqual(
            len([line for line in stderr_text.splitlines() if line.strip()]),
            8,
        )

    def test_nan_inf_extreme_input(self) -> None:
        rows = 180
        features = np.random.default_rng(7).normal(0.0, 1.0, size=(rows, 6))
        features[3, 0] = np.nan
        features[5, 1] = np.inf
        features[7, 2] = -np.inf
        features[10, 4] = 1e12
        features[11, 5] = -1e12
        self._run_case(features, train_size=120)

    def test_constant_columns_input(self) -> None:
        rows = 120
        features = np.full((rows, 6), 3.14159, dtype=float)
        self._run_case(features, train_size=80)

    def test_mixed_degenerate_input(self) -> None:
        rows = 140
        features = np.zeros((rows, 6), dtype=float)
        features[:, 0] = np.linspace(0.0, 1e-9, rows)
        features[:, 3] = np.linspace(10.0, 10.0 + 1e-8, rows)
        features[20:30, :] = np.nan
        self._run_case(features, train_size=90)


if __name__ == "__main__":
    unittest.main()
