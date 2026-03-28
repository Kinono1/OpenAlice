import { describe, expect, it } from "vitest";
import {
  buildDatasetManifestV1,
  buildFeatureSnapshotV1,
  buildLabelSnapshotV1,
  buildModelSignalV1,
  buildTrainingRunManifestV1,
} from "./ml_artifact_contracts";

const WINDOW = {
  start: "2026-03-01T00:00:00.000Z",
  end: "2026-03-28T00:00:00.000Z",
};

describe("ml artifact contracts", () => {
  it("builds a feature snapshot", () => {
    const snapshot = buildFeatureSnapshotV1({
      snapshotId: "feat-1",
      generatedAt: "2026-03-28T01:00:00.000Z",
      sourceSnapshotId: "bars-1",
      featurePipelineVersion: "core7.v1",
      symbolUniverse: ["BTC/USD"],
      timeframe: "1h",
      asOfPolicy: "point_in_time",
      featureColumns: ["mom_4", "vol_24"],
      rowCount: 100,
      window: WINDOW,
    });

    expect(snapshot.schemaVersion).toBe("feature_snapshot.v1");
  });

  it("builds a label snapshot and dataset manifest", () => {
    const labels = buildLabelSnapshotV1({
      snapshotId: "label-1",
      generatedAt: "2026-03-28T01:00:00.000Z",
      labelId: "dir_h4",
      targetType: "direction",
      horizonBars: 4,
      applicableRegimes: ["trend_up"],
      rowCount: 100,
      window: WINDOW,
    });
    const dataset = buildDatasetManifestV1({
      datasetId: "dataset-1",
      generatedAt: "2026-03-28T01:00:00.000Z",
      featureSnapshotId: "feat-1",
      labelSnapshotId: labels.snapshotId,
      splitPolicyId: "purged_wfo_v1",
      symbolUniverse: ["BTC/USD"],
      timeframe: "1h",
      sampleRowCount: 95,
      droppedRowCount: 5,
      window: WINDOW,
      leakageAudit: {
        passed: true,
        reasonCodes: [],
      },
    });

    expect(dataset.schemaVersion).toBe("dataset_manifest.v1");
  });

  it("builds a training run manifest and model signal", () => {
    const run = buildTrainingRunManifestV1({
      runId: "run-1",
      generatedAt: "2026-03-28T01:00:00.000Z",
      datasetId: "dataset-1",
      modelId: "xgb_v1",
      codeCommitHash: "abc123",
      status: "completed",
      metrics: { expectancyBps: 12.5 },
    });
    const signal = buildModelSignalV1({
      generatedAt: "2026-03-28T01:00:00.000Z",
      symbol: "BTC/USD",
      modelId: "xgb_v1",
      datasetId: "dataset-1",
      direction: "buy",
      confidence: 0.76,
      expectedReturnPct: 0.42,
      applicableRegimes: ["trend_up"],
      invalidationReasons: [],
    });

    expect(run.schemaVersion).toBe("training_run_manifest.v1");
    expect(signal.schemaVersion).toBe("model_signal.v1");
  });
});
