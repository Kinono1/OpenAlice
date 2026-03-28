export const EXECUTION_COST_REPORT_SCHEMA_VERSION =
  "execution_cost_report.v1";

export type ExecutionCostLayer = "research" | "paper" | "live";

export interface ExecutionCostObservation {
  layer: ExecutionCostLayer;
  orderCount: number;
  fillCount: number;
  notionalUsd: number;
  feesUsd: number;
  slippageUsd: number;
  fundingUsd?: number;
  latencyMs?: number[];
}

export interface ExecutionCostLayerMetrics {
  layer: ExecutionCostLayer;
  orderCount: number;
  fillCount: number;
  fillRate: number;
  notionalUsd: number;
  feesUsd: number;
  slippageUsd: number;
  fundingUsd: number;
  totalCostUsd: number;
  feeBps: number | null;
  slippageBps: number | null;
  fundingBps: number | null;
  totalCostBps: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
}

export interface ExecutionCostComparison {
  fromLayer: ExecutionCostLayer;
  toLayer: ExecutionCostLayer;
  totalCostBpsDelta: number | null;
  fillRateDelta: number;
  latencyP95MsDelta: number | null;
}

export interface ExecutionCostReportArtifact {
  schemaVersion: typeof EXECUTION_COST_REPORT_SCHEMA_VERSION;
  generatedAt: string;
  layers: ExecutionCostLayerMetrics[];
  comparisons: ExecutionCostComparison[];
  warnings: string[];
}

export interface ExecutionCostReportInput {
  observations: ExecutionCostObservation[];
  generatedAt?: string;
}

export function buildExecutionCostReport(
  input: ExecutionCostReportInput,
): ExecutionCostReportArtifact {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const layers = input.observations.map(toLayerMetrics);
  const byLayer = new Map(layers.map((item) => [item.layer, item]));
  const comparisons: ExecutionCostComparison[] = [];

  pushComparison(byLayer, comparisons, "research", "paper");
  pushComparison(byLayer, comparisons, "paper", "live");
  pushComparison(byLayer, comparisons, "research", "live");

  const warnings: string[] = [];
  for (const layer of layers) {
    if (layer.orderCount > 0 && layer.fillRate < 0.8) {
      warnings.push(`low_fill_rate:${layer.layer}`);
    }
    if (layer.totalCostBps != null && layer.totalCostBps > 25) {
      warnings.push(`high_cost_drag:${layer.layer}`);
    }
  }

  return {
    schemaVersion: EXECUTION_COST_REPORT_SCHEMA_VERSION,
    generatedAt,
    layers,
    comparisons,
    warnings: [...new Set(warnings)],
  };
}

function toLayerMetrics(
  observation: ExecutionCostObservation,
): ExecutionCostLayerMetrics {
  const notionalUsd = roundMetric(Math.max(0, observation.notionalUsd));
  const feesUsd = roundMetric(Math.max(0, observation.feesUsd));
  const slippageUsd = roundMetric(Math.max(0, observation.slippageUsd));
  const fundingUsd = roundMetric(Math.max(0, observation.fundingUsd ?? 0));
  const totalCostUsd = roundMetric(feesUsd + slippageUsd + fundingUsd);
  const fillRate =
    observation.orderCount > 0
      ? roundMetric(observation.fillCount / observation.orderCount)
      : 0;

  return {
    layer: observation.layer,
    orderCount: Math.max(0, Math.trunc(observation.orderCount)),
    fillCount: Math.max(0, Math.trunc(observation.fillCount)),
    fillRate,
    notionalUsd,
    feesUsd,
    slippageUsd,
    fundingUsd,
    totalCostUsd,
    feeBps: toBps(feesUsd, notionalUsd),
    slippageBps: toBps(slippageUsd, notionalUsd),
    fundingBps: toBps(fundingUsd, notionalUsd),
    totalCostBps: toBps(totalCostUsd, notionalUsd),
    latencyP50Ms: percentile(observation.latencyMs ?? [], 0.5),
    latencyP95Ms: percentile(observation.latencyMs ?? [], 0.95),
  };
}

function pushComparison(
  byLayer: Map<ExecutionCostLayer, ExecutionCostLayerMetrics>,
  comparisons: ExecutionCostComparison[],
  fromLayer: ExecutionCostLayer,
  toLayer: ExecutionCostLayer,
): void {
  const from = byLayer.get(fromLayer);
  const to = byLayer.get(toLayer);
  if (!from || !to) {
    return;
  }

  comparisons.push({
    fromLayer,
    toLayer,
    totalCostBpsDelta:
      from.totalCostBps == null || to.totalCostBps == null
        ? null
        : roundMetric(to.totalCostBps - from.totalCostBps),
    fillRateDelta: roundMetric(to.fillRate - from.fillRate),
    latencyP95MsDelta:
      from.latencyP95Ms == null || to.latencyP95Ms == null
        ? null
        : roundMetric(to.latencyP95Ms - from.latencyP95Ms),
  });
}

function toBps(costUsd: number, notionalUsd: number): number | null {
  if (!(notionalUsd > 0)) {
    return null;
  }
  return roundMetric((costUsd / notionalUsd) * 10_000);
}

function percentile(values: number[], q: number): number | null {
  const clean = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (clean.length === 0) {
    return null;
  }

  const pos = (clean.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) {
    return roundMetric(clean[lower]);
  }
  const weight = pos - lower;
  return roundMetric(clean[lower] * (1 - weight) + clean[upper] * weight);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}
