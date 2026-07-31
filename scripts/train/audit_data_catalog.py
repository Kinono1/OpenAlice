#!/usr/bin/env python3
"""
Data Catalog Gap Audit for OpenAlice.

Reads the runtime data catalog artifact, identifies all non-complete datasets
(missing, partial, in-progress, needs-retry, failed), classifies each gap by
blocker category, determines what needs to be downloaded or fixed, and outputs
a structured gaps report to data/research/data_catalog_gaps_report.json.

This is a read-only analysis script. No filesystem writes beyond the report.
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CATALOG_PATH = REPO_ROOT / "data" / "runtime" / "openalice_data_catalog.latest.json"
OUTPUT_PATH = REPO_ROOT / "data" / "research" / "data_catalog_gaps_report.json"
WAREHOUSE_ROOT = Path("/Volumes/shield/cryptoData/openalice-data")

# ---------------------------------------------------------------------------
# Blocker category classification
# ---------------------------------------------------------------------------
BLOCKER_CATEGORY_MAP = {
    "pit_or_normalized_gap": "Data not yet normalized to point-in-time (PIT) format with full field coverage. Prevents backtest and strategy evidence use.",
    "ai_scientist_validation_gate": "AI-Scientist outputs are candidates only; require OpenAlice second validation before promotion.",
    "manifest_or_trust_gap": "Manifest or evidence-trust audit incomplete/quarantined. Blocks promotion until resolved.",
    "download_gap": "Raw dataset files not yet downloaded from Binance Data Vision or other sources.",
    "derivatives_audit_gap": "Derivatives coverage and schema audit incomplete for funding, basis, order-book, and route-cost inputs.",
    "asset_metadata_gap": "Symbol mapping, contract address, or decimals metadata unresolved.",
    "other": "Uncategorized blockers (e.g., empty files in warehouse).",
}

# ---------------------------------------------------------------------------
# Download commands for missing datasets
# ---------------------------------------------------------------------------
DATASET_DOWNLOAD_INFO: dict[str, dict] = {
    "binance-public:spot:trades:usdt": {
        "market": "spot",
        "dataType": "trades",
        "quote": "usdt",
    },
    "binance-public:um:bookTicker:usdt": {
        "market": "um",
        "dataType": "bookTicker",
        "quote": "usdt",
    },
    "binance-public:um:trades:usdt": {
        "market": "um",
        "dataType": "trades",
        "quote": "usdt",
    },
}

DOWNLOADS_REQUIRED = [
    {
        "datasetId": ds_id,
        "market": info["market"],
        "dataType": info["dataType"],
        "quote": info["quote"],
        "downloadScript": f"scripts/run_fast_binance_data_vision_dataset.ts",
        "downloadCommand": (
            f"cd {REPO_ROOT} && "
            f"pnpm tsx scripts/run_fast_binance_data_vision_dataset.ts "
            f"--market {info['market']} "
            f"--dataType {info['dataType']} "
            f"--quote {info['quote']} "
            f"--startMonth 2017-08 "
            f"--discovery s3 "
            f"--outDir {WAREHOUSE_ROOT}/market/binance-public/"
        ),
        "missingCount": 1,
        "description": f"Binance public {info['market']} {info['dataType']} ({info['quote']} pairs) — entire dataset directory does not exist",
    }
    for ds_id, info in DATASET_DOWNLOAD_INFO.items()
]


def classify_blocker_category(blockers: list[str]) -> str:
    """Map a list of blocker strings to the highest-priority category."""
    for cat_keywords in [
        ("pit_or_normalized_gap", ["pit", "normalized_point_in_time", "normalized_warehouse_field_coverage"]),
        ("download_gap", ["binance_dataset_missing", "binance_public_incomplete"]),
        ("ai_scientist_validation_gate", ["ai_scientist"]),
        ("manifest_or_trust_gap", ["manifest", "trust"]),
        ("derivatives_audit_gap", ["derivatives_manifest_path_incomplete", "external_derivatives_requires"]),
        ("asset_metadata_gap", ["contract_address_unknown", "decimals_unknown"]),
    ]:
        category, keywords = cat_keywords
        for blk in blockers:
            for kw in keywords:
                if kw in blk:
                    return category
    return "other"


def format_bytes(n: int) -> str:
    """Human-readable byte size."""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} PB"


def audit_blocker_category(blockers_categories: list[dict]) -> dict:
    """Build a detailed breakdown of the blocker categories from the catalog."""
    category_detail = {}
    for cat in blockers_categories:
        category_detail[cat["category"]] = {
            "count": cat["count"],
            "sampleBlockers": cat["sampleBlockers"],
            "nextAction": cat.get("nextAction", ""),
            "blockedDatasetIds": [],
        }
    return category_detail


def inspect_dataset(d: dict) -> dict:
    """Analyze a single non-complete dataset and return a gap entry."""
    ds_id = d["datasetId"]
    status = d["status"]
    family = d["family"]
    layer = d["layer"]
    reason = d.get("reason", "")
    storage_path = d.get("storagePath", "")
    blockers = d.get("blockers", [])
    next_actions = d.get("nextActions", [])
    quality = d.get("quality", {})

    category = classify_blocker_category(blockers)

    # Determine what is needed to resolve
    resolution_actions = list(next_actions) if next_actions else []

    missing_files = quality.get("missingFiles")
    expected_files = quality.get("expectedFiles")
    file_gap = None
    if missing_files is not None and expected_files is not None and expected_files > 0:
        file_gap = f"{missing_files}/{expected_files} files missing"

    return {
        "datasetId": ds_id,
        "status": status,
        "family": family,
        "layer": layer,
        "reason": reason,
        "storagePath": storage_path,
        "blockerCategory": category,
        "blockerCategoryDescription": BLOCKER_CATEGORY_MAP.get(category, ""),
        "blockers": blockers,
        "resolutionActions": resolution_actions,
        "fileGap": file_gap,
        "quality": {
            "files": quality.get("files"),
            "bytes": quality.get("bytes"),
            "missingFiles": missing_files,
            "expectedFiles": expected_files,
            "complete": quality.get("complete"),
        },
    }


def audit() -> dict:
    """Main audit logic."""
    if not CATALOG_PATH.exists():
        print(f"ERROR: Catalog not found at {CATALOG_PATH}", file=sys.stderr)
        sys.exit(1)

    with open(CATALOG_PATH) as f:
        catalog = json.load(f)

    summary = catalog.get("summary", {})
    total = summary.get("datasets", 0)
    complete = summary.get("complete", 0)
    partial = summary.get("partial", 0)
    missing = summary.get("missing", 0)
    in_progress = summary.get("inProgress", 0)
    needs_retry = summary.get("needsRetry", 0)
    failed = summary.get("failed", 0)

    datasets = catalog.get("datasets", [])
    blockers_categories = catalog.get("blockerActionability", {}).get("categories", [])

    # Inspect non-complete datasets
    gaps = []
    for d in datasets:
        if d.get("status") != "complete":
            gaps.append(inspect_dataset(d))

    # Build category-to-dataset mapping
    category_detail = audit_blocker_category(blockers_categories)
    for gap in gaps:
        cat = gap["blockerCategory"]
        # Only store dataset IDs if the category is found in the catalog detail
        for cat_key in category_detail:
            if cat == cat_key or cat in cat_key or cat_key in cat:
                category_detail[cat_key].setdefault("blockedDatasetIds", []).append(gap["datasetId"])
                break

    # Count how many distinct datasets need each action type
    needs_normalize = sum(1 for g in gaps if g["blockerCategory"] == "pit_or_normalized_gap")
    needs_download = sum(1 for g in gaps if g["blockerCategory"] == "download_gap")
    needs_second_validation = sum(1 for g in gaps if g["blockerCategory"] == "ai_scientist_validation_gate")
    needs_trust_audit = sum(1 for g in gaps if g["blockerCategory"] == "manifest_or_trust_gap")
    needs_derivatives_audit = sum(1 for g in gaps if g["blockerCategory"] == "derivatives_audit_gap")
    needs_metadata_fill = sum(1 for g in gaps if g["blockerCategory"] == "asset_metadata_gap")

    # Compute completion stats
    binance_verified = summary.get("verifiedBinancePublicDatasets", 0)
    binance_planned = summary.get("plannedBinancePublicDatasets", 0)
    binance_remaining = binance_planned - binance_verified

    report = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "sourceCatalog": str(CATALOG_PATH),
        "catalogGeneratedAt": catalog.get("generatedAt", ""),
        "catalogStatus": catalog.get("status", ""),
        "warehouseRoot": str(WAREHOUSE_ROOT),
        "summary": {
            "totalDatasets": total,
            "complete": complete,
            "partial": partial,
            "missing": missing,
            "inProgress": in_progress,
            "needsRetry": needs_retry,
            "failed": failed,
            "completionPct": round(100 * complete / total, 1) if total > 0 else 0,
            "gapsTotal": total - complete,
            "gapsAnalyzed": len(gaps),
        },
        "workPrioritization": {
            "critical": {  # Missing datasets = can't proceed without downloading
                "label": "Download missing raw datasets from Binance Data Vision",
                "count": missing,
                "datasets": [g for g in gaps if g["status"] == "missing"],
                "downloadRequired": DOWNLOADS_REQUIRED,
            },
            "high": {  # Partial datasets blocking normalized flow
                "label": "Normalize raw data to PIT format and resolve field coverage",
                "count": needs_normalize,
                "datasets": [g for g in gaps if g["blockerCategory"] == "pit_or_normalized_gap"],
            },
            "medium": {  # Validation, audit, and trust gaps
                "label": "Run second validation, trust audit, derivatives audit, and metadata fill",
                "needsSecondValidation": needs_second_validation,
                "needsTrustAudit": needs_trust_audit,
                "needsDerivativesAudit": needs_derivatives_audit,
                "needsMetadataFill": needs_metadata_fill,
                "datasets": [
                    g for g in gaps
                    if g["blockerCategory"] in (
                        "ai_scientist_validation_gate",
                        "manifest_or_trust_gap",
                        "derivatives_audit_gap",
                        "asset_metadata_gap",
                        "other",
                    )
                ],
            },
            "binanceDownloadProgress": {
                "label": "Binance public dataset download progress",
                "verified": binance_verified,
                "planned": binance_planned,
                "remaining": binance_remaining,
                "needsDownload": needs_download,
            },
        },
        "gapDetails": gaps,
        "blockerCategoryBreakdown": category_detail,
    }

    return report


def main():
    print("=" * 72)
    print("  OpenAlice Data Catalog Gap Audit")
    print("=" * 72)
    print()

    # Check catalog exists
    if not CATALOG_PATH.exists():
        print(f"[FAIL] Catalog not found at {CATALOG_PATH}", file=sys.stderr)
        sys.exit(1)

    print(f"[OK]  Catalog: {CATALOG_PATH}")

    # Load and validate
    with open(CATALOG_PATH) as f:
        catalog = json.load(f)

    summary = catalog.get("summary", {})
    total = summary.get("datasets", 0)
    complete = summary.get("complete", 0)

    print(f"[OK]  Datasets: {total} total, {complete} complete")
    print()

    # Run audit
    report = audit()

    # Verify key counts
    gap_count = total - complete
    analyzed = len(report["gapDetails"])
    if analyzed != gap_count:
        print(f"[WARN] Gap mismatch: expected {gap_count}, analyzed {analyzed}", file=sys.stderr)

    print(f"[OK]  Gaps found: {gap_count}")
    print()

    # Print summary
    prio = report["workPrioritization"]
    print("--- Priority Breakdown ---")
    print()
    print(f"  CRITICAL — Download missing raw datasets ({prio['critical']['count']}):")
    for d in prio["critical"]["datasets"]:
        print(f"    - {d['datasetId']}")
        print(f"      Reason: {d['reason']}")
    print()

    print(f"  HIGH — Normalize to PIT format ({prio['high']['count']}):")
    for d in prio['high']['datasets']:
        print(f"    - {d['datasetId']} ({d['status']})")
        print(f"      Blocker: {d['blockerCategory']}")
        if d['fileGap']:
            print(f"      File gap: {d['fileGap']}")
    print()

    print(f"  MEDIUM — Validate/audit ({prio['medium']['needsSecondValidation']} second-val, "
          f"{prio['medium']['needsTrustAudit']} trust, "
          f"{prio['medium']['needsDerivativesAudit']} deriv, "
          f"{prio['medium']['needsMetadataFill']} metadata):")
    for d in prio['medium']['datasets']:
        print(f"    - {d['datasetId']} ({d['status']}) [{d['blockerCategory']}]")
        print(f"      Reason: {d['reason']}")
    print()

    print("--- Binance Download Progress ---")
    bdp = prio["binanceDownloadProgress"]
    print(f"  Verified: {bdp['verified']} / Planned: {bdp['planned']}")
    print(f"  Remaining: {bdp['remaining']}")
    if prio["critical"]["downloadRequired"]:
        print()
        print("--- Datasets Requiring Download ---")
        for dl in prio["critical"]["downloadRequired"]:
            print(f"  [{dl['datasetId']}]")
            print(f"    Market: {dl['market']}, DataType: {dl['dataType']}, Quote: {dl['quote']}")
            print(f"    Command: {dl['downloadCommand']}")
            print()

    # Write report
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2)

    # Quick report stats
    report_size_kb = os.path.getsize(OUTPUT_PATH) / 1024
    print(f"--- Report Written ---")
    print(f"  Path: {OUTPUT_PATH}")
    print(f"  Size: {report_size_kb:.1f} KB")
    print(f"  Generated: {report['generatedAt']}")
    print()

    # Final status
    if gap_count == 0:
        print("[PASS] Data catalog is fully complete. No gaps detected.")
    else:
        blocking_missing = sum(1 for g in report["gapDetails"] if g["status"] == "missing")
        print(f"[INFO] Data catalog has {gap_count} gaps ({blocking_missing} missing, "
              f"{gap_count - blocking_missing} partial).")
        print(f"       Completion: {report['summary']['completionPct']}% ({complete}/{total})")
        print(f"       See full report at {OUTPUT_PATH}")
    print()
    print("=" * 72)


if __name__ == "__main__":
    main()
