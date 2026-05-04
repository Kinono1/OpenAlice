import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureRuntimeProofArtifacts,
  loadRuntimeProofTracking,
} from "./live_proof_status.js";

describe("live_proof_status", () => {
  it("returns not_started when no target file exists", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "live-proof-status-"));
    const result = await loadRuntimeProofTracking({
      targetPath: join(tempDir, "missing-target.json"),
      snapshotsPath: join(tempDir, "missing-snapshots.json"),
      tradesPath: join(tempDir, "missing-trades.json"),
    });

    expect(result.status).toBe("not_started");
    expect(result.blockingReasons).toContain("proof_target_missing");
  });

  it("returns not_started when target exists but snapshots are missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "live-proof-status-"));
    const targetPath = join(tempDir, "target.json");
    await writeFile(
      targetPath,
      JSON.stringify({ requiredDays: 90, maxDrawdownPct: 10 }),
      "utf-8",
    );

    const result = await loadRuntimeProofTracking({
      targetPath,
      snapshotsPath: join(tempDir, "missing-snapshots.json"),
      tradesPath: join(tempDir, "missing-trades.json"),
    });

    expect(result.status).toBe("not_started");
    expect(result.targetDays).toBe(90);
    expect(result.blockingReasons).toContain("proof_snapshots_missing");
  });

  it("evaluates proof status from snapshots and trades", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "live-proof-status-"));
    const targetPath = join(tempDir, "target.json");
    const snapshotsPath = join(tempDir, "snapshots.json");
    const tradesPath = join(tempDir, "trades.json");

    await Promise.all([
      writeFile(
        targetPath,
        JSON.stringify({ requiredDays: 3, maxDrawdownPct: 10 }),
        "utf-8",
      ),
      writeFile(
        snapshotsPath,
        JSON.stringify([
          { date: "2026-03-01", equityUsd: 1000 },
          { date: "2026-03-02", equityUsd: 1030 },
          { date: "2026-03-03", equityUsd: 1050 },
        ]),
        "utf-8",
      ),
      writeFile(
        tradesPath,
        JSON.stringify([
          { closedAt: "2026-03-02T10:00:00Z", realizedPnlUsd: 20, feesUsd: 2 },
          { closedAt: "2026-03-03T10:00:00Z", realizedPnlUsd: 15, feesUsd: 1 },
        ]),
        "utf-8",
      ),
    ]);

    const result = await loadRuntimeProofTracking({
      targetPath,
      snapshotsPath,
      tradesPath,
    });

    expect(result.status).toBe("passed");
    expect(result.elapsedDays).toBe(3);
    expect(result.netPnlPositive).toBe(true);
    expect(result.maxDrawdownPct).toBe(0);
    expect(result.source).toBe("live_proof_status:evaluated");
  });

  it("creates default proof artifacts when missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "live-proof-status-"));
    const targetPath = join(tempDir, "target.json");
    const snapshotsPath = join(tempDir, "snapshots.json");
    const tradesPath = join(tempDir, "trades.json");

    const paths = await ensureRuntimeProofArtifacts({
      targetPath,
      snapshotsPath,
      tradesPath,
    });

    expect(paths).toEqual({
      targetPath,
      snapshotsPath,
      tradesPath,
    });

    const result = await loadRuntimeProofTracking(paths);
    expect(result.status).toBe("not_started");
    expect(result.blockingReasons).toContain("proof_snapshots_missing");
  });
});
