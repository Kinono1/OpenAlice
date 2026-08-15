#!/usr/bin/env python3
"""
Quant framework benchmark gap audit.

Reads the quant framework benchmark report (benchmark report) and lists
the 10 identified capability gaps with detailed blocker analysis.
Outputs a structured report to data/research/quant_gaps_report.json.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent.parent
DATA_RESEARCH = BASE / "data" / "research"
BENCHMARK_PATH = DATA_RESEARCH / "quant_framework_benchmark_report.latest.json"
OUTPUT_PATH = DATA_RESEARCH / "quant_gaps_report.json"


def fmt_ratio(v):
    if v is None:
        return "N/A"
    return f"{v:.1%}"


def main():
    if not BENCHMARK_PATH.exists():
        print(f"[FATAL] Benchmark report not found: {BENCHMARK_PATH}")
        sys.exit(1)

    with open(BENCHMARK_PATH) as f:
        report = json.load(f)

    capabilities = report.get("capabilities", [])
    summary = report.get("summary", {})
    blockers = report.get("blockers", [])

    print("=" * 72)
    print("QUANT FRAMEWORK BENCHMARK -- CAPABILITY GAP AUDIT")
    print(f"Generated at:            {report.get('generatedAt', '?')}")
    print(f"Research-only:           {report.get('researchOnly', True)}")
    print(f"Diagnostic-only:         {report.get('diagnosticOnly', True)}")
    print(f"Status:                  {report.get('status', 'unknown')}")
    print(f"Frameworks compared:     {summary.get('frameworks', 0)}")
    print(f"Total capabilities:      {summary.get('capabilities', 0)}")
    print(f"Blocked capabilities:    {summary.get('blockedCapabilities', 0)}")
    print(f"Open/partial defects:    {summary.get('relatedOpenOrPartialDefects', 0)}")
    print(f"P0 open/partial defects: {summary.get('p0RelatedOpenOrPartialDefects', 0)}")
    print(f"Can promote:             {summary.get('canPromote', False)}")
    print(f"Data catalog:            {summary.get('dataCatalogStatus', '?')}")
    print(f"Reason-chain action:     {summary.get('reasonChainActionability', '?')}")
    print("=" * 72)

    print("\n## THE 10 CAPABILITY GAPS")
    print("")

    gap_list = []
    for i, cap in enumerate(capabilities, 1):
        cap_id = cap.get("capabilityId", "?")
        title = cap.get("title", "?")
        priority = cap.get("priority", "?")
        status = cap.get("status", "?")
        requirement = cap.get("openAliceRequirement", "")

        model_fw = cap.get("modelFrameworks", [])
        source_lessons = cap.get("sourceLessons", [])
        cap_blockers = cap.get("blockers", [])
        next_steps = cap.get("nextActions", [])
        ce = cap.get("currentEvidence", {})

        related_defects = ce.get("relatedDefectIds", [])
        open_defects = ce.get("openOrPartialDefectIds", [])

        entry = {
            "rank": i,
            "capabilityId": cap_id,
            "title": title,
            "priority": priority,
            "status": status,
            "modelFrameworks": model_fw,
            "sourceLessons": source_lessons,
            "openAliceRequirement": requirement,
            "blockerCount": len(cap_blockers),
            "blockers": cap_blockers,
            "relatedDefectCount": len(related_defects),
            "openOrPartialDefectCount": len(open_defects),
            "openOrPartialDefectIds": open_defects,
            "dataCatalogStatus": ce.get("dataCatalogStatus", "?"),
            "reasonChainActionability": ce.get("reasonChainActionability", "?"),
            "nextActions": next_steps,
        }
        gap_list.append(entry)

        # Print header
        p0_tag = " [P0]" if priority == "P0" else " [P1]"
        print(f"--- Gap {i}: {title}{p0_tag} ---")
        print(f"  ID:                    {cap_id}")
        print(f"  Priority:              {priority}")
        print(f"  Status:                {status}")
        print(f"  Model frameworks:      {', '.join(model_fw)}")
        print(f"  Source lessons:        {', '.join(source_lessons)}")
        print(f"  Requirement:           {requirement}")
        print(f"  Blocker count:         {len(cap_blockers)}")
        for b in cap_blockers:
            print(f"    - {b}")
        print(
            f"  Related defects:       {len(related_defects)} total, {len(open_defects)} open/partial"
        )
        if open_defects:
            joined = ", ".join(open_defects)
            print(f"    Open/partial IDs:     {joined}")
        print(f"  Data catalog:          {ce.get('dataCatalogStatus', '?')}")
        print(f"  Reason-chain:          {ce.get('reasonChainActionability', '?')}")
        if next_steps:
            print(f"  Next actions:")
            for ns in next_steps:
                print(f"    - {ns}")
        print("")

    # ── Cross-capability blocker summary ─────────────────────────────
    print("--- CROSS-CAPABILITY ANALYSIS ---")
    print("")

    # Defects that block multiple capabilities
    from collections import Counter

    defect_cap_map = {}
    for gap in gap_list:
        for d in gap.get("openOrPartialDefectIds", []):
            defect_cap_map.setdefault(d, []).append(gap["capabilityId"])

    multi_block_defects = {d: caps for d, caps in defect_cap_map.items() if len(caps) > 1}
    if multi_block_defects:
        print(f"Defects blocking 2+ capabilities ({len(multi_block_defects)} defects):")
        for d, caps in sorted(
            multi_block_defects.items(), key=lambda x: -len(x[1])
        ):
            print(f"  Defect {d:<10s}  blocks {len(caps)} capabilities: {', '.join(caps)}")
    else:
        print("No multi-capability blocking defects found.")

    # High-severity blockers (P0 with many open defects)
    p0_gaps = [g for g in gap_list if g["priority"] == "P0"]
    print(
        f"\nP0 gaps ({len(p0_gaps)}): {', '.join(g['capabilityId'] for g in p0_gaps)}"
    )
    for g in p0_gaps:
        print(
            f"  {g['capabilityId']:35s}  {g['openOrPartialDefectCount']} open defects / {g['blockerCount']} blockers"
        )

    print(
        f"\nP1 gaps ({len(gap_list) - len(p0_gaps)}): {', '.join(g['capabilityId'] for g in gap_list if g['priority'] == 'P1')}"
    )

    # ── Write structured output ──────────────────────────────────────
    out = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceBenchmarkGeneratedAt": report.get("generatedAt"),
        "sourceBenchmarkFrameworks": summary.get("frameworks", 0),
        "sourceBenchmarkCapabilities": summary.get("capabilities", 0),
        "summary": {
            "totalCapabilities": len(gap_list),
            "blockedCapabilities": len(gap_list),
            "p0Capabilities": len(p0_gaps),
            "p1Capabilities": len(gap_list) - len(p0_gaps),
            "totalOpenOrPartialDefects": summary.get("relatedOpenOrPartialDefects", 0),
            "p0OpenOrPartialDefects": summary.get("p0RelatedOpenOrPartialDefects", 0),
            "multiCapabilityDefects": len(multi_block_defects),
            "totalBlockersInCapabilities": sum(g["blockerCount"] for g in gap_list),
            "canPromote": summary.get("canPromote", False),
        },
        "frameworkSources": [
            {
                "frameworkId": fs["frameworkId"],
                "name": fs["name"],
                "roleModel": fs.get("roleModel", ""),
            }
            for fs in report.get("frameworkSources", [])
        ],
        "capabilityGaps": gap_list,
        "multiCapabilityDefects": {
            d: {"blockedCapabilities": caps, "blockedCapabilityCount": len(caps)}
            for d, caps in sorted(
                multi_block_defects.items(), key=lambda x: -len(x[1])
            )
        },
        "globalBlockers": [
            b for b in blockers if b.endswith("global_actionability_research_only_blocked")
        ],
        "nextActions": report.get("nextActions", []),
    }

    DATA_RESEARCH.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(out, f, indent=2, default=str)

    print(f"\n[OK] Gap report written to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
