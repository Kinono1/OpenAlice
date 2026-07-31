#!/usr/bin/env python3
"""
Route-cost readiness report.

Reads the OKX fee snapshot, route cost budget, execution quality, and
route-cost-slippage readiness artifacts, then outputs a structured report
to stdout and data/runtime/route_cost_readiness_report.latest.json.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
DATA_RUNTIME = BASE / "data" / "runtime"
DATA_RESEARCH = BASE / "data" / "research"

PATHS = {
    "readiness": DATA_RUNTIME / "okx_route_cost_slippage_readiness.latest.json",
    "fee_snapshot": DATA_RUNTIME / "fee_snapshot.latest.json",
    "route_cost_budget": DATA_RUNTIME / "route_cost_budget.latest.json",
    "execution_quality": DATA_RUNTIME / "execution_quality.latest.json",
}


def load_json(path: Path) -> dict:
    if not path.exists():
        return {"error": f"NOT_FOUND: {path}"}
    with open(path) as f:
        return json.load(f)


def fmt_ts(ts_str):
    """Return a human-readable age string from an ISO timestamp."""
    if not ts_str:
        return "N/A"
    try:
        dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        age = now - dt
        days = age.days
        hours, rem = divmod(age.seconds, 3600)
        minutes = rem // 60
        parts = []
        if days:
            parts.append(f"{days}d")
        if hours:
            parts.append(f"{hours}h")
        parts.append(f"{minutes}m")
        return f"{' '.join(parts)} ago ({ts_str})"
    except Exception:
        return ts_str


def ratio_color(v):
    if v is None:
        return "N/A"
    return f"{v:.1%}"


def main():
    print("=" * 72)
    print("ROUTE-COST READINESS REPORT")
    print(f"Generated: {datetime.now(timezone.utc).isoformat()}")
    print("=" * 72)

    readiness = load_json(PATHS["readiness"])
    fee_snap = load_json(PATHS["fee_snapshot"])
    budget = load_json(PATHS["route_cost_budget"])
    exec_q = load_json(PATHS["execution_quality"])

    if "error" in readiness:
        print(f"\n[FATAL] readiness artifact missing: {readiness['error']}")
        sys.exit(1)

    # ── Section 1: Top-level status ──────────────────────────────────
    print("\n## STATUS")
    print(f"  Status:                {readiness.get('status', 'unknown')}")
    print(f"  Research-only:         {readiness.get('researchOnly', '?')}")
    print(f"  Diagnostic-only:       {readiness.get('diagnosticOnly', '?')}")
    print(f"  Promotion-eligible:    {readiness.get('promotionEligible', '?')}")
    print(f"  Paper-trading allowed: {readiness.get('paperTradingAllowed', '?')}")
    print(f"  Live-trading allowed:  {readiness.get('liveTradingAllowed', '?')}")

    # ── Section 2: Fee snapshot ──────────────────────────────────────
    print("\n## FEE SNAPSHOT")
    if "error" in fee_snap:
        print(f"  MISSING: {fee_snap['error']}")
    else:
        print(f"  Venue:                 {fee_snap.get('venue', '?')}")
        print(f"  Source:                {fee_snap.get('source', '?')}")
        print(f"  Maker fee:             {fee_snap.get('makerFeeBps', '?')} bps")
        print(f"  Taker fee:             {fee_snap.get('takerFeeBps', '?')} bps")
        print(f"  Runtime-verified:      {fee_snap.get('verifiedByRuntime', False)}")
        print(f"  Expires:               {fmt_ts(fee_snap.get('expiresAt', ''))}")

    # ── Section 3: Route cost budget ─────────────────────────────────
    print("\n## ROUTE COST BUDGET")
    if "error" in budget:
        print(f"  MISSING: {budget['error']}")
    else:
        routes = budget.get("routes", {})
        print(f"  Routes defined:        {len(routes)}")
        max_allowed = max(
            (r.get("maxAllowedCostBps", 0) for r in routes.values()), default=0
        )
        print(f"  Max allowed cost:      {max_allowed} bps")
        over = []
        ok = []
        for name, r in routes.items():
            total = r.get("totalExpectedCostBps", 0)
            allowed = r.get("maxAllowedCostBps", 0)
            overrun = total - allowed
            if overrun > 0:
                over.append((name, total, allowed, overrun))
            else:
                ok.append((name, total, allowed))
        if over:
            print(f"  Routes OVER budget:")
            for name, total, allowed, overrun in sorted(
                over, key=lambda x: -x[3]
            ):
                print(
                    f"    {name:30s}  {total:3d} bps vs allowed {allowed:3d} bps  (over by {overrun} bps)"
                )
        else:
            print(f"  All routes within budget.")
        if ok:
            print(f"  Routes within budget:")
            for name, total, allowed in ok:
                print(f"    {name:30s}  {total:3d} bps vs allowed {allowed:3d} bps")
        safe_route = readiness.get("routeCostBudget", {}).get(
            "selectedSafeResearchRoute", "none"
        )
        print(f"  Selected safe route:   {safe_route}")

    # ── Section 4: Execution quality ─────────────────────────────────
    print("\n## EXECUTION QUALITY")
    if "error" in exec_q:
        print(f"  MISSING: {exec_q['error']}")
    else:
        print(f"  Recent orders:          {exec_q.get('recentOrderCount', 0)}")
        print(f"  Slippage violations:     {exec_q.get('slippageViolationCount', 0)}")
        print(
            f"  Actual/sim cost ratio:  {exec_q.get('actualToSimulatedCostRatio', 'N/A')}"
        )
        print(f"  Missed-fill rate:        {ratio_color(exec_q.get('missedFillRate'))}")

        ev = exec_q.get("evidence", {})
        if ev:
            print(f"  Closed trades:           {ev.get('closedTrades', 0)}")
            print(
                f"  Trades w/ any predicted cost:          {ev.get('tradesWithAnyPredictedCost', 0)}"
            )
            print(
                f"  Trades w/ complete predicted evidence: {ev.get('tradesWithCompletePredictedOpenEvidence', 0)}"
            )
            print(
                f"  Trades w/ exchange-reconciled cost:    {ev.get('tradesWithExchangeReconciledCostEvidence', 0)}"
            )
            print(
                f"  Trades w/ paper fill telemetry:        {ev.get('tradesWithPaperFillTelemetry', 0)}"
            )

        ql = exec_q.get("quality", {})
        if ql:
            print(f"  Predicted-open-evidence coverage:       {ratio_color(ql.get('completePredictedOpenEvidenceCoveragePct', 0))}")
            print(f"  Fill-adjusted coverage:                  {ratio_color(ql.get('fillAdjustedCoveragePct', 0))}")
            print(f"  Exchange-reconciled coverage:            {ratio_color(ql.get('exchangeReconciledCoveragePct', 0))}")
            print(f"  Paper-fill telemetry coverage:           {ratio_color(ql.get('paperFillTelemetryCoveragePct', 0))}")

    # ── Section 5: Orderbook quality ────────────────────────────────
    print("\n## ORDERBOOK QUALITY")
    ob = readiness.get("orderbook", {})
    print(f"  Exists:                {ob.get('exists', False)}")
    print(f"  Status:                {ob.get('status', '?')}")
    print(f"  Rows built:            {ob.get('rowsBuilt', 0)}")
    print(f"  Max spread (bps):      {ob.get('maxSpreadBps', 'N/A'):.5f}")
    print(f"  Median spread (bps):   {ob.get('medianSpreadBps', 'N/A'):.5f}")
    print(f"  Min depth 5 (USD):     ${ob.get('minDepth5Usd', 0):,.2f}")
    syms = ob.get("qualityBySymbol", [])
    for s in syms:
        print(
            f"    {s['symbol']:10s}  spread={s.get('spreadBps', 0):.5f} bps  depth5=${s.get('depth5Usd', 0):>12,.2f}  status={s['status']}"
        )

    # ── Section 6: Paper cost evidence ──────────────────────────────
    print("\n## PAPER COST EVIDENCE")
    pce = readiness.get("paperCostEvidence", {})
    print(f"  Source:                {pce.get('source', '?')}")
    print(f"  Closed trades:         {pce.get('closedTrades', 0)}")
    print(
        f"  Trades w/ predicted cost:          {pce.get('tradesWithAnyPredictedCost', 0)}"
    )
    print(
        f"  Trades w/ complete predicted open: {pce.get('tradesWithCompletePredictedOpenEvidence', 0)}"
    )
    print(
        f"  Complete predicted open coverage:  {ratio_color(pce.get('completePredictedOpenEvidenceCoveragePct', 0))}  (threshold: >=95%)"
    )
    print(
        f"  Trades w/ realized cost:           {pce.get('tradesWithAnyRealizedCost', 0)}"
    )
    print(
        f"  Trades w/ fill-adjusted cost:      {pce.get('tradesWithFillAdjustedCost', 0)}"
    )
    print(
        f"  Trades w/ exchange-reconciled:     {pce.get('tradesWithExchangeReconciledCostEvidence', 0)}"
    )
    print(
        f"  Paper fill telemetry:              {pce.get('tradesWithPaperFillTelemetry', 0)}"
    )
    print(f"  Status:                {pce.get('status', '?')}")

    # ── Section 7: Paper future telemetry watchdog ──────────────────
    print("\n## PAPER FUTURE TELEMETRY WATCHDOG")
    pft = readiness.get("paperFutureTelemetry", {})
    print(f"  Status:                {pft.get('status', '?')}")
    print(
        f"  Monitoring since:      {fmt_ts(pft.get('monitoringStartedAt', ''))}"
    )
    print(f"  Future closed rows:    {pft.get('futureClosedRows', 0)}")
    print(
        f"  Rows w/ paper fill:    {pft.get('futureRowsWithPaperFillTelemetry', 0)}"
    )
    print(
        f"  Rows w/ predicted ev:  {pft.get('futureRowsWithCompletePredictedOpenEvidence', 0)}"
    )
    print(f"  Telemetry gap age:     {pft.get('telemetryGapMonitoringAgeMinutes', 0)} min")
    print(
        f"  Latest closed trade:   {fmt_ts(pft.get('telemetryGapLatestClosedAt', ''))}"
    )
    print(
        f"  Future rows after monitoring start: {pft.get('telemetryGapFutureClosedRowsAfterMonitoringStart', 0)}"
    )
    eb = pft.get("evidenceBlockers", [])
    if eb:
        print(f"  Evidence blockers ({len(eb)}):")
        for b in eb:
            print(f"    - {b}")

    # ── Section 8: Blockers ─────────────────────────────────────────
    print("\n## BLOCKERS")
    blockers = readiness.get("blockers", [])
    if not blockers:
        print("  None")
    else:
        for i, b in enumerate(blockers, 1):
            print(f"  {i:2d}. {b}")
        print(f"\n  Total: {len(blockers)} blocking issues")

    # ── Section 9: Summary / next actions ───────────────────────────
    print("\n## NEXT ACTIONS")
    for a in readiness.get("nextActions", []):
        print(f"  - {a}")

    print("\n## SAFETY NOTES")
    for n in readiness.get("safetyNotes", []):
        print(f"  - {n}")

    # ── Write structured JSON output ─────────────────────────────────
    report = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "status": readiness.get("status", "unknown"),
        "researchOnly": readiness.get("researchOnly", True),
        "diagnosticOnly": readiness.get("diagnosticOnly", True),
        "promotionEligible": readiness.get("promotionEligible", False),
        "paperTradingAllowed": readiness.get("paperTradingAllowed", False),
        "liveTradingAllowed": readiness.get("liveTradingAllowed", False),
        "blockerCount": len(blockers),
        "blockers": blockers,
        "feeSnapshot": {
            "venue": fee_snap.get("venue") if "error" not in fee_snap else None,
            "makerFeeBps": fee_snap.get("makerFeeBps") if "error" not in fee_snap else None,
            "takerFeeBps": fee_snap.get("takerFeeBps") if "error" not in fee_snap else None,
            "verifiedByRuntime": fee_snap.get("verifiedByRuntime") if "error" not in fee_snap else None,
        },
        "routeCostBudget": {
            "routeCount": len(budget.get("routes", {})) if "error" not in budget else 0,
            "maxAllowedCostBps": max_allowed if "error" not in budget else None,
            "routesOverBudget": [{"name": n, "totalExpectedCostBps": r["totalExpectedCostBps"], "maxAllowedCostBps": r["maxAllowedCostBps"], "overrunBps": r["totalExpectedCostBps"] - r["maxAllowedCostBps"]} for n, r in sorted(routes.items()) if r["totalExpectedCostBps"] > r["maxAllowedCostBps"]],
            "selectedSafeResearchRoute": safe_route,
        },
        "executionQuality": {
            "recentOrderCount": exec_q.get("recentOrderCount") if "error" not in exec_q else 0,
            "slippageViolationCount": exec_q.get("slippageViolationCount") if "error" not in exec_q else 0,
            "completePredictedOpenEvidenceCoveragePct": ql.get("completePredictedOpenEvidenceCoveragePct") if "error" not in exec_q else 0,
            "paperFillTelemetryCoveragePct": ql.get("paperFillTelemetryCoveragePct") if "error" not in exec_q else 0,
            "exchangeReconciledCoveragePct": ql.get("exchangeReconciledCoveragePct") if "error" not in exec_q else 0,
        },
        "paperCostEvidence": {
            "closedTrades": pce.get("closedTrades"),
            "predictedCostCoveragePct": pce.get("completePredictedOpenEvidenceCoveragePct"),
            "predictedCostCoverageThresholdPct": 95,
            "predictedCostCoverageMet": False,
            "hasExchangeReconciledCost": pce.get("tradesWithExchangeReconciledCostEvidence", 0) > 0,
            "hasPaperFillTelemetry": pce.get("tradesWithPaperFillTelemetry", 0) > 0,
        },
        "paperFutureTelemetry": {
            "status": pft.get("status"),
            "futureClosedRows": pft.get("futureClosedRows", 0),
            "telemetryGapMonitoringAgeMinutes": pft.get("telemetryGapMonitoringAgeMinutes", 0),
            "evidenceBlockers": eb,
        },
        "orderbookQuality": {
            "requiredSymbolsAllPass": ob.get("requiredOrderbookAllPass", False),
            "maxSpreadBps": ob.get("maxSpreadBps"),
            "minDepth5Usd": ob.get("minDepth5Usd"),
        },
        "readinessFlags": readiness.get("readiness", {}),
        "nextActions": readiness.get("nextActions", []),
    }

    out_path = DATA_RUNTIME / "route_cost_readiness_report.latest.json"
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2, default=str)
    print(f"\n[OK] Report written to {out_path}")


if __name__ == "__main__":
    main()
