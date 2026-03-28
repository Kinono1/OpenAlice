#!/usr/bin/env python3
"""Contract validation coverage for research artifact schemas."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "validate_research_contracts.py"


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def run_validator(*inputs: Path, output: Path) -> subprocess.CompletedProcess[str]:
    cmd = [
        sys.executable,
        str(SCRIPT_PATH),
        "--inputs",
        *(str(path) for path in inputs),
        "--output",
        str(output),
    ]
    return subprocess.run(
        cmd,
        cwd=str(REPO_ROOT),
        text=True,
        capture_output=True,
        check=False,
    )


class TestSchemaContracts(unittest.TestCase):
    def test_new_artifacts_validate_successfully(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-schema-contracts-pass-") as tmp:
            root = Path(tmp)
            local_report_path = root / "local_param_search_report.v1.json"
            best_triplet_path = root / "best_trend_triplet.v1.json"
            frontier_shortlist_path = root / "fdr_frontier_shortlist.v1.json"
            out_path = root / "contract_report.json"

            trial_summary = {
                "trialId": 1,
                "trialLabel": "known_best_anchor",
                "anchorType": "known_best",
                "exitCode": 0,
                "fdrQ": 0.33,
                "meanPbo": 0.14,
                "meanDsrProbability": 0.70,
                "params": [
                    {"trendFastPeriod": 24, "trendSlowPeriod": 72, "allowShort": True},
                    {"trendFastPeriod": 21, "trendSlowPeriod": 70, "allowShort": True},
                    {"trendFastPeriod": 34, "trendSlowPeriod": 89, "allowShort": True},
                ],
            }

            write_json(
                local_report_path,
                {
                    "schemaVersion": "local_param_search_report.v1",
                    "generatedAt": "2026-03-03T00:00:00Z",
                    "repoRoot": str(REPO_ROOT),
                    "mode": "local",
                    "target": "fdr",
                    "constraint": "none",
                    "wfoProfile": "shift",
                    "plan": "A",
                    "focusRange": None,
                    "aggressive": False,
                    "seed": 20260303,
                    "fdrMethod": "bh",
                    "fdrStoreyLambda": None,
                    "trialsRequested": 3,
                    "trialCount": 3,
                    "baselineFdrQ": 0.3697723252360454,
                    "thresholdBreakTarget": 0.3497723252360454,
                    "fdrMax": 0.1,
                    "pboMax": 0.2,
                    "fdrWeight": 0.5,
                    "pboWeight": 0.5,
                    "pboThresholdTarget": 0.2,
                    "bestFdrQ": 0.33,
                    "bestMeanPbo": 0.14,
                    "improvementAbs": 0.03977232523604542,
                    "improvementPct": 10.757380021307808,
                    "thresholdBreak": True,
                    "pboThresholdBreak": True,
                    "feasibleCount": 1,
                    "bestTrialConstraintSatisfied": True,
                    "bestTrial": trial_summary,
                    "top10": [trial_summary],
                    "trials": [trial_summary],
                },
            )

            best_triplet_candidates = [
                {
                    "strategyId": "LPS_T001_C1",
                    "strategyName": "known_best_trend_24_72_ls",
                    "strategy": "trend",
                    "params": {"trendFastPeriod": 24, "trendSlowPeriod": 72, "allowShort": True},
                },
                {
                    "strategyId": "LPS_T001_C2",
                    "strategyName": "known_best_trend_21_70_ls",
                    "strategy": "trend",
                    "params": {"trendFastPeriod": 21, "trendSlowPeriod": 70, "allowShort": True},
                },
                {
                    "strategyId": "LPS_T001_C3",
                    "strategyName": "known_best_trend_34_89_ls",
                    "strategy": "trend",
                    "params": {"trendFastPeriod": 34, "trendSlowPeriod": 89, "allowShort": True},
                },
            ]

            write_json(
                best_triplet_path,
                {
                    "schemaVersion": "best_trend_triplet.v1",
                    "generatedAt": "2026-03-03T00:00:01Z",
                    "sourceReport": str(local_report_path),
                    "trialId": 1,
                    "trialLabel": "known_best_anchor",
                    "anchorType": "known_best",
                    "candidateCount": 3,
                    "metrics": {
                        "fdrQ": 0.33,
                        "meanPbo": 0.14,
                        "meanDsrProbability": 0.70,
                        "exitCode": 0,
                    },
                    "params": [row["params"] for row in best_triplet_candidates],
                    "candidates": best_triplet_candidates,
                    "searchSummary": {
                        "mode": "local",
                        "wfoProfile": "shift",
                        "seed": 20260303,
                        "bestFdrQ": 0.33,
                        "improvementAbs": 0.03977232523604542,
                        "improvementPct": 10.757380021307808,
                        "thresholdBreak": True,
                    },
                },
            )

            write_json(
                frontier_shortlist_path,
                {
                    "schemaVersion": "fdr_frontier_shortlist.v1",
                    "generatedAt": "2026-03-03T00:00:02Z",
                    "generatedDate": "20260303",
                    "inputs": {
                        "digest": "data/research/strategy-watch/latest_digest.json",
                        "citationNetwork": "data/research/literature/citations/latest_citation_network.v1.json",
                        "pdfExtractReport": "data/research/literature/pdf_extract/latest_pdf_extract_report.v1.json",
                        "hypotheses": "data/research/hypotheses/backlog.v1.json",
                    },
                    "stats": {"shortlistCount": 1, "warningCount": 0},
                    "warnings": [],
                    "shortlist": [
                        {
                            "methodId": "m-multiple-testing-control-p-fdr-001",
                            "paperId": "P-FDR-001",
                            "title": "False Discovery Rate Control via Multiple Testing",
                            "venue": "NeurIPS",
                            "year": 2025,
                            "methodFamily": "multiple-testing-control",
                            "fdrMechanism": "Apply BH-style q-value thresholding on candidate pools across trials.",
                            "assumptions": "Comparable p-values across candidate strategies and controlled selection depth.",
                            "expectedImpactOnFdrQ": "high",
                            "expectedImpactOnWfo": "medium",
                            "integrationCost": "low",
                            "riskLevel": "low",
                            "actionHint": "Add BH/q-value control after candidate ranking and compare fdrQ against baseline.",
                            "experimentTemplateId": "tpl_fdr_bh_gate_v1",
                            "citations": {
                                "citationCount": 12,
                                "inDegree": 2,
                                "outDegree": 1,
                            },
                        }
                    ],
                },
            )

            run = run_validator(
                local_report_path,
                best_triplet_path,
                frontier_shortlist_path,
                output=out_path,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr or run.stdout)
            report = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertTrue(bool(report.get("passed")))

            statuses = {
                item.get("schemaVersion"): item.get("passed")
                for item in report.get("files", [])
                if isinstance(item, dict)
            }
            self.assertTrue(statuses.get("local_param_search_report.v1"))
            self.assertTrue(statuses.get("best_trend_triplet.v1"))
            self.assertTrue(statuses.get("fdr_frontier_shortlist.v1"))

    def test_provisional_baseline_contract_validates(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="openalice-schema-contracts-provisional-"
        ) as tmp:
            root = Path(tmp)
            provisional_baseline_path = root / "provisional_baseline.v1.json"
            out_path = root / "contract_report.json"

            write_json(
                provisional_baseline_path,
                {
                    "schemaVersion": "provisional_baseline.v1",
                    "generatedAt": "2026-03-03T00:00:04Z",
                    "status": "provisional_best",
                    "summary": {
                        "fdrQ": 0.117,
                        "meanPbo": 0.186,
                        "meanDsrProbability": 0.69,
                        "passesProductionThresholds": False,
                    },
                    "thresholds": {
                        "fdrQMax": 0.1,
                        "meanPboMax": 0.2,
                    },
                    "source": {
                        "type": "experiment_verdict",
                        "path": "decision_packet/experiment_verdict.v2.json",
                        "runId": "A-20260303T010000Z",
                    },
                    "notes": [
                        "Tracks best-known compromise while hard FDR gate remains unmet."
                    ],
                },
            )

            run = run_validator(provisional_baseline_path, output=out_path)
            self.assertEqual(run.returncode, 0, msg=run.stderr or run.stdout)
            report = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertTrue(bool(report.get("passed")))

            files = report.get("files", [])
            self.assertEqual(len(files), 1)
            self.assertEqual(files[0].get("schemaVersion"), "provisional_baseline.v1")
            self.assertTrue(bool(files[0].get("passed")))

    def test_stagea_gate_result_contract_validates(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-schema-contracts-stagea-") as tmp:
            root = Path(tmp)
            stagea_path = root / "stagea_gate_result.v1.json"
            out_path = root / "contract_report.json"

            write_json(
                stagea_path,
                {
                    "schemaVersion": "stagea_gate_result.v1",
                    "generatedAt": "2026-03-03T00:00:05Z",
                    "source": {
                        "matrixReport": "data/research/strategy/analysis/g3g4/latest_multi_asset_matrix.v1.json",
                        "matrixRunId": "MA3-20260303T010000Z",
                    },
                    "thresholds": {
                        "btcBaselineFdrQ": 0.355,
                        "absFdrQMax": 0.25,
                        "meanPboMax": 0.2,
                        "meanDsrProbabilityMin": 0.5,
                    },
                    "summary": {
                        "completedAssets": 3,
                        "minCompletedAssets": 2,
                        "conditionACount": 2,
                        "conditionAMinAssets": 2,
                        "conditionBCount": 0,
                        "conditionBMinAssets": 1,
                        "fdrQMedian": 0.33,
                        "fdrQDispersionRatio": 0.2,
                        "heterogeneityFlag": False,
                    },
                    "assets": [
                        {
                            "asset": "BTC",
                            "status": "completed",
                            "fdrQ": 0.34,
                            "meanPbo": 0.18,
                            "meanDsrProbability": 0.62,
                            "eligible": True,
                            "conditionA": True,
                            "conditionB": False,
                        }
                    ],
                    "decision": {
                        "passed": True,
                        "hasMinCompletedAssets": True,
                        "conditionAPassed": True,
                        "conditionBPassed": False,
                        "nextStage": "continue_current_framework",
                    },
                },
            )

            run = run_validator(stagea_path, output=out_path)
            self.assertEqual(run.returncode, 0, msg=run.stderr or run.stdout)
            report = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertTrue(bool(report.get("passed")))

            files = report.get("files", [])
            self.assertEqual(len(files), 1)
            self.assertEqual(files[0].get("schemaVersion"), "stagea_gate_result.v1")
            self.assertTrue(bool(files[0].get("passed")))

    def test_quant_governance_artifact_contracts_validate(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="openalice-schema-contracts-governance-"
        ) as tmp:
            root = Path(tmp)
            quant_policy_path = root / "quant_policy_pack.v1.json"
            advisor_packet_path = root / "advisor_committee_packet.v1.json"
            hiring_scorecard_path = root / "quant_hiring_scorecard.v1.json"
            paper_board_path = root / "paper_board.v1.json"
            out_path = root / "contract_report.json"

            write_json(
                quant_policy_path,
                {
                    "schemaVersion": "quant_policy_pack.v1",
                    "generatedAt": "2026-03-03T00:00:06Z",
                    "policyMode": "rebuild_mode",
                    "inputs": {
                        "stageAResult": "data/research/strategy/analysis/g3g4/stagea_gate_result.v1.json",
                        "stageBPacket": "data/research/strategy/analysis/g3g4/stageb_governance_packet.v1.json",
                        "precontinueDecision": "data/research/strategy/analysis/g3g4/precontinue_decision.v1.json",
                    },
                    "principles": ["tradability first"],
                    "productionPolicy": {
                        "thresholdFreeze": {"enabled": True},
                        "exceptionPolicy": {"allowed": False},
                    },
                    "governanceCadence": {
                        "internalReview": "weekly",
                        "advisorReview": "monthly",
                        "decisionSLAHours": 24,
                    },
                    "gatePolicy": {"recommendedRoute": "stageC_rebuild"},
                    "escalationRules": [
                        {
                            "ruleId": "ESCALATE_STAGEA_FAIL",
                            "description": "Require governance sign-off.",
                        }
                    ],
                },
            )

            write_json(
                advisor_packet_path,
                {
                    "schemaVersion": "advisor_committee_packet.v1",
                    "generatedAt": "2026-03-03T00:00:07Z",
                    "meetingObjective": "Prioritize top methods",
                    "inputs": {
                        "shortlist": "data/research/fdr/frontier_shortlist.latest.v1.json",
                        "backlog": "data/research/hypotheses/backlog.v1.json",
                        "stageBPacket": "data/research/strategy/analysis/g3g4/stageb_governance_packet.v1.json",
                        "matrixReport": "data/research/strategy/analysis/g3g4/latest_multi_asset_matrix.v1.json",
                    },
                    "context": {"stageBRecommendedOption": "launch_strategy_rebuild"},
                    "agendaMethods": [
                        {"methodId": "m1", "paperId": "P1", "actionHint": "run trial"}
                    ],
                    "questionsForAdvisors": ["which 2 methods first?"],
                    "actionOwners": [
                        {
                            "owner": "advisor_committee",
                            "role": "external",
                            "task": "review top methods",
                        }
                    ],
                },
            )

            write_json(
                hiring_scorecard_path,
                {
                    "schemaVersion": "quant_hiring_scorecard.v1",
                    "generatedAt": "2026-03-03T00:00:08Z",
                    "roleId": "execution_stats_hybrid_quant",
                    "context": {
                        "stageBPacketPath": "data/research/strategy/analysis/g3g4/stageb_governance_packet.v1.json",
                        "stageBRecommendedOption": "launch_strategy_rebuild",
                        "hiringRationale": "Need stronger execution + statistics capability.",
                    },
                    "dimensions": [
                        {
                            "name": "statistical_inference",
                            "weight": 0.4,
                            "minPassScore": 3,
                            "description": "FDR/PBO-aware experiment design",
                        }
                    ],
                    "scoringScale": {
                        "type": "integer_1_to_5",
                        "description": "1 low, 5 high",
                    },
                    "hardRejectRules": ["Cannot explain tradability constraints."],
                    "decisionRule": {
                        "minWeightedScore": 3.6,
                        "requireNoHardReject": True,
                        "approvalRequiredFrom": ["risk_owner"],
                    },
                    "interviewStages": [
                        {
                            "stage": "technical_case",
                            "owner": "quant_research_owner",
                            "focus": "execution + inference tradeoff",
                        }
                    ],
                },
            )

            write_json(
                paper_board_path,
                {
                    "schemaVersion": "paper_board.v1",
                    "generatedAt": "2026-03-03T00:00:09Z",
                    "inputs": {
                        "digest": "data/research/strategy-watch/latest_digest.json",
                        "shortlist": "data/research/fdr/frontier_shortlist.latest.v1.json",
                        "backlog": "data/research/hypotheses/backlog.v1.json",
                        "topK": 20,
                    },
                    "summary": {
                        "itemCount": 1,
                        "bucketCounts": {"statistical_control": 1},
                    },
                    "items": [
                        {
                            "paperId": "P1",
                            "title": "Adaptive FDR",
                            "source": "hypothesis_backlog",
                            "methodFamily": "multiple-testing-control",
                            "priority": 0.9,
                            "actionHint": "test adaptive BH",
                            "problemBucket": "statistical_control",
                        }
                    ],
                },
            )

            run = run_validator(
                quant_policy_path,
                advisor_packet_path,
                hiring_scorecard_path,
                paper_board_path,
                output=out_path,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr or run.stdout)
            report = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertTrue(bool(report.get("passed")))

            statuses = {
                item.get("schemaVersion"): item.get("passed")
                for item in report.get("files", [])
                if isinstance(item, dict)
            }
            self.assertTrue(statuses.get("quant_policy_pack.v1"))
            self.assertTrue(statuses.get("advisor_committee_packet.v1"))
            self.assertTrue(statuses.get("quant_hiring_scorecard.v1"))
            self.assertTrue(statuses.get("paper_board.v1"))

    def test_best_triplet_missing_required_field_fails(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-schema-contracts-fail-") as tmp:
            root = Path(tmp)
            best_triplet_path = root / "best_trend_triplet.v1.json"
            out_path = root / "contract_report.json"

            write_json(
                best_triplet_path,
                {
                    "schemaVersion": "best_trend_triplet.v1",
                    "generatedAt": "2026-03-03T00:00:01Z",
                    "sourceReport": "data/research/strategy/local_param_search_report.v1.json",
                    "trialId": 1,
                    "trialLabel": "known_best_anchor",
                    "anchorType": "known_best",
                    "candidateCount": 3,
                    "metrics": {"fdrQ": 0.33},
                    "params": [],
                    "searchSummary": {"mode": "local"},
                },
            )

            run = run_validator(best_triplet_path, output=out_path)
            self.assertEqual(run.returncode, 2, msg=run.stderr or run.stdout)
            report = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertFalse(bool(report.get("passed")))

            files = report.get("files", [])
            self.assertEqual(len(files), 1)
            self.assertEqual(files[0].get("schemaVersion"), "best_trend_triplet.v1")
            self.assertFalse(bool(files[0].get("passed")))
            self.assertIn("missing required field: candidates", files[0].get("errors", []))

    def test_unknown_schema_version_remains_unsupported(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-schema-contracts-compat-") as tmp:
            root = Path(tmp)
            unknown_path = root / "unknown.v1.json"
            out_path = root / "contract_report.json"

            write_json(
                unknown_path,
                {
                    "schemaVersion": "unknown_contract.v1",
                    "generatedAt": "2026-03-03T00:00:03Z",
                },
            )

            run = run_validator(unknown_path, output=out_path)
            self.assertEqual(run.returncode, 2, msg=run.stderr or run.stdout)
            report = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertFalse(bool(report.get("passed")))

            files = report.get("files", [])
            self.assertEqual(len(files), 1)
            errors = files[0].get("errors", [])
            self.assertIn("unsupported schemaVersion: unknown_contract.v1", errors)


if __name__ == "__main__":
    unittest.main()
