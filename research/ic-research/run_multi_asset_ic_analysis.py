"""Run the gate-based IC research pipeline across multiple crypto assets."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from common.data_fetcher import prepare_research_dataset

RUN_IC_ANALYSIS_PATH = Path(__file__).resolve().parent / "run_ic_analysis.py"
RUN_IC_ANALYSIS_SPEC = importlib.util.spec_from_file_location("openalice_run_ic_analysis", RUN_IC_ANALYSIS_PATH)
if RUN_IC_ANALYSIS_SPEC is None or RUN_IC_ANALYSIS_SPEC.loader is None:
    raise RuntimeError(f"Unable to load run_ic_analysis module from {RUN_IC_ANALYSIS_PATH}")
run_ic_analysis = importlib.util.module_from_spec(RUN_IC_ANALYSIS_SPEC)
RUN_IC_ANALYSIS_SPEC.loader.exec_module(run_ic_analysis)

OUTPUT_DIR = run_ic_analysis.OUTPUT_DIR
FACTOR_NAMES = run_ic_analysis.FACTOR_NAMES
build_output_name = run_ic_analysis.build_output_name
print_report = run_ic_analysis.print_report
run_research_pipeline = run_ic_analysis.run_research_pipeline
write_research_artifacts = run_ic_analysis.write_research_artifacts


DEFAULT_SYMBOLS = [
    "BTC/USDT:USDT",
    "ETH/USDT:USDT",
    "SOL/USDT:USDT",
]


def summarize_asset_report(symbol: str, report: dict) -> dict:
    rolling = report["gate2"]["rolling_wfo"]
    three_stage = report["gate2"]["three_stage_wfo"]
    return {
        "symbol": symbol,
        "gate0": {
            "coverage_ok": report["gate0"]["coverage_ok"],
            "row_count": report["gate0"]["row_count"],
            "dataset_start": report["gate0"]["dataset_start"],
            "dataset_end": report["gate0"]["dataset_end"],
            "ohlcv_source": report["gate0"]["ohlcv_source"],
            "funding_source": report["gate0"]["funding_source"],
        },
        "three_stage_robust_pass_windows": three_stage["robust_pass_windows"],
        "rolling_robust_pass_windows": rolling["robust_pass_windows"],
        "high_correlation_pairs": report["gate2"]["orthogonality"]["high_correlation_pairs"],
    }


def build_multi_asset_summary(asset_reports: dict[str, dict]) -> dict:
    by_factor = {factor: {"symbols": [], "rolling_robust_total": 0} for factor in FACTOR_NAMES}
    for symbol, report in asset_reports.items():
        rolling = report["gate2"]["rolling_wfo"]["robust_pass_windows"]
        for factor in FACTOR_NAMES:
            robust_count = rolling[factor]["count"]
            if robust_count > 0:
                by_factor[factor]["symbols"].append(symbol)
            by_factor[factor]["rolling_robust_total"] += robust_count
    return by_factor


def main() -> None:
    parser = argparse.ArgumentParser(description="Run IC factor research for multiple crypto assets.")
    parser.add_argument("--symbols", nargs="+", default=DEFAULT_SYMBOLS)
    parser.add_argument("--timeframe", default="1h")
    parser.add_argument("--start", default="2023-01-01")
    parser.add_argument("--end", default="2025-04-03")
    parser.add_argument("--exchange", default="gate")
    parser.add_argument("--print-single-asset-report", action="store_true")
    args = parser.parse_args()

    asset_reports: dict[str, dict] = {}
    asset_summaries: dict[str, dict] = {}

    for symbol in args.symbols:
        df = prepare_research_dataset(symbol, args.timeframe, args.start, args.end, args.exchange)
        report = run_research_pipeline(df)
        asset_reports[symbol] = report
        asset_summaries[symbol] = summarize_asset_report(symbol, report)
        write_research_artifacts(
            report=report,
            df=df,
            output_name=build_output_name(symbol, args.start, args.end),
        )
        if args.print_single_asset_report:
            print_report(report)

    multi_asset_report = {
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "exchange": args.exchange,
        "timeframe": args.timeframe,
        "start": args.start,
        "end": args.end,
        "symbols": args.symbols,
        "assetSummaries": asset_summaries,
        "factorCrossAssetSummary": build_multi_asset_summary(asset_reports),
    }
    output_name = f"ic_multi_asset_{args.start}_{args.end}"
    output_path = OUTPUT_DIR / f"{output_name}.json"
    output_path.write_text(json.dumps(multi_asset_report, indent=2, default=str), encoding="utf-8")
    print(json.dumps(multi_asset_report, indent=2))


if __name__ == "__main__":
    main()
