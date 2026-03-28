import { z } from "zod";

const STRICT_UTC_ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const isoUtcSchema = z
  .string()
  .regex(STRICT_UTC_ISO_8601, "must be a strict ISO-8601 UTC timestamp");

const timeWindowSchema = z
  .object({
    start: isoUtcSchema,
    end: isoUtcSchema,
  })
  .strict();

const leakageAuditSchema = z
  .object({
    passed: z.boolean(),
    reasonCodes: z.array(z.string()).default([]),
  })
  .strict();

export const featureSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal("feature_snapshot.v1"),
    snapshotId: z.string().min(1),
    generatedAt: isoUtcSchema,
    sourceSnapshotId: z.string().min(1),
    featurePipelineVersion: z.string().min(1),
    symbolUniverse: z.array(z.string().min(1)).min(1),
    timeframe: z.string().min(1),
    asOfPolicy: z.string().min(1),
    featureColumns: z.array(z.string().min(1)).min(1),
    rowCount: z.number().int().min(0),
    window: timeWindowSchema,
  })
  .strict();

export const labelSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal("label_snapshot.v1"),
    snapshotId: z.string().min(1),
    generatedAt: isoUtcSchema,
    labelId: z.string().min(1),
    targetType: z.enum(["direction", "return", "volatility", "persistence"]),
    horizonBars: z.number().int().positive(),
    barrierPct: z.number().positive().optional(),
    applicableRegimes: z.array(z.string().min(1)).default([]),
    rowCount: z.number().int().min(0),
    window: timeWindowSchema,
  })
  .strict();

export const datasetManifestV1Schema = z
  .object({
    schemaVersion: z.literal("dataset_manifest.v1"),
    datasetId: z.string().min(1),
    generatedAt: isoUtcSchema,
    featureSnapshotId: z.string().min(1),
    labelSnapshotId: z.string().min(1),
    splitPolicyId: z.string().min(1),
    symbolUniverse: z.array(z.string().min(1)).min(1),
    timeframe: z.string().min(1),
    sampleRowCount: z.number().int().min(0),
    droppedRowCount: z.number().int().min(0),
    window: timeWindowSchema,
    leakageAudit: leakageAuditSchema,
  })
  .strict();

export const trainingRunManifestV1Schema = z
  .object({
    schemaVersion: z.literal("training_run_manifest.v1"),
    runId: z.string().min(1),
    generatedAt: isoUtcSchema,
    datasetId: z.string().min(1),
    modelId: z.string().min(1),
    codeCommitHash: z.string().min(1),
    status: z.enum(["created", "completed", "failed"]),
    artifactPath: z.string().min(1).optional(),
    metrics: z.record(z.string(), z.number()).default({}),
  })
  .strict();

export const modelSignalV1Schema = z
  .object({
    schemaVersion: z.literal("model_signal.v1"),
    generatedAt: isoUtcSchema,
    symbol: z.string().min(1),
    modelId: z.string().min(1),
    datasetId: z.string().min(1).optional(),
    direction: z.enum(["buy", "sell", "hold"]),
    confidence: z.number().min(0).max(1),
    expectedReturnPct: z.number().optional(),
    applicableRegimes: z.array(z.string().min(1)).default([]),
    invalidationReasons: z.array(z.string()).default([]),
  })
  .strict();

export type FeatureSnapshotV1 = z.infer<typeof featureSnapshotV1Schema>;
export type LabelSnapshotV1 = z.infer<typeof labelSnapshotV1Schema>;
export type DatasetManifestV1 = z.infer<typeof datasetManifestV1Schema>;
export type TrainingRunManifestV1 = z.infer<typeof trainingRunManifestV1Schema>;
export type ModelSignalV1 = z.infer<typeof modelSignalV1Schema>;

export function validateFeatureSnapshotV1(
  value: unknown,
): FeatureSnapshotV1 {
  return featureSnapshotV1Schema.parse(value);
}

export function validateLabelSnapshotV1(value: unknown): LabelSnapshotV1 {
  return labelSnapshotV1Schema.parse(value);
}

export function validateDatasetManifestV1(value: unknown): DatasetManifestV1 {
  return datasetManifestV1Schema.parse(value);
}

export function validateTrainingRunManifestV1(
  value: unknown,
): TrainingRunManifestV1 {
  return trainingRunManifestV1Schema.parse(value);
}

export function validateModelSignalV1(value: unknown): ModelSignalV1 {
  return modelSignalV1Schema.parse(value);
}

export function buildFeatureSnapshotV1(
  input: Omit<FeatureSnapshotV1, "schemaVersion">,
): FeatureSnapshotV1 {
  return validateFeatureSnapshotV1({
    schemaVersion: "feature_snapshot.v1",
    ...input,
  });
}

export function buildLabelSnapshotV1(
  input: Omit<LabelSnapshotV1, "schemaVersion">,
): LabelSnapshotV1 {
  return validateLabelSnapshotV1({
    schemaVersion: "label_snapshot.v1",
    ...input,
  });
}

export function buildDatasetManifestV1(
  input: Omit<DatasetManifestV1, "schemaVersion">,
): DatasetManifestV1 {
  return validateDatasetManifestV1({
    schemaVersion: "dataset_manifest.v1",
    ...input,
  });
}

export function buildTrainingRunManifestV1(
  input: Omit<TrainingRunManifestV1, "schemaVersion">,
): TrainingRunManifestV1 {
  return validateTrainingRunManifestV1({
    schemaVersion: "training_run_manifest.v1",
    ...input,
  });
}

export function buildModelSignalV1(
  input: Omit<ModelSignalV1, "schemaVersion">,
): ModelSignalV1 {
  return validateModelSignalV1({
    schemaVersion: "model_signal.v1",
    ...input,
  });
}

export function buildModelSignalArtifact(
  input: Omit<ModelSignalV1, "schemaVersion">,
): ModelSignalV1 {
  return buildModelSignalV1(input);
}
