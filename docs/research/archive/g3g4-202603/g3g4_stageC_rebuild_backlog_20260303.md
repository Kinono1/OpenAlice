# G3/G4 Stage-C Rebuild Backlog (Sprint 0-1)

Date: `2026-03-03`

## Sprint 0 (Kickoff + Freeze)
1. Freeze old-framework baseline artifacts and label them read-only.
2. Finalize Stage-C charter and governance rules.
3. Define shared evaluation contract (artifact paths, schema checks, run IDs).
4. Set up weekly reporting template for A/B progress and metrics deltas.

## Sprint 1 (Workstream A: Signal Rebuild)
1. Define 3 candidate signal families with explicit hypotheses.
2. Implement candidate generator v2 for A-track.
3. Run first multi-asset smoke matrix on A-track candidates.
4. Record fdrQ/pbo/dsr deltas against frozen baseline.

## Sprint 1 (Workstream B: Method Rebuild)
1. Implement first selective-inference prototype path.
2. Add method switch integration in validation pipeline.
3. Benchmark against BH baseline on identical candidate pool.
4. Produce method-level failure analysis report.

## Shared Acceptance Gates
1. All outputs pass `research:contracts:validate`.
2. Every run has deterministic `runId` and archive path.
3. No production threshold changes are introduced in code or docs.
4. Every sprint ends with a go/no-go note for next sprint.
