export const EDGE_DECAY_REPORT_SCHEMA_VERSION = "edge_decay_report.v1";

export type EdgeDecayLayer = "research" | "paper" | "live";
export type EdgeDecayVerdict = "stable" | "degraded" | "broken";

export interface EdgeDecayLayerObservation {
  layer: EdgeDecayLayer;
  sampleCount: number;
  rawExpectancyBps: number;
  netExpectancyBps: number;
  hitRate?: number;
  sharpe?: number;
}

export interface EdgeDecayThresholds {
  degradedNetDeltaBps: number;
  brokenNetDeltaBps: number;
  degradedHitRateDelta: number;
  brokenHitRateDelta: number;
}

export interface EdgeDecayTransition {
  fromLayer: EdgeDecayLayer;
  toLayer: EdgeDecayLayer;
  netExpectancyDeltaBps: number;
  rawExpectancyDeltaBps: number;
  hitRateDelta: number | null;
  verdict: EdgeDecayVerdict;
  reasons: string[];
}

export interface EdgeDecayReportArtifact {
  schemaVersion: typeof EDGE_DECAY_REPORT_SCHEMA_VERSION;
  generatedAt: string;
  thresholds: EdgeDecayThresholds;
  layers: EdgeDecayLayerObservation[];
  transitions: EdgeDecayTransition[];
  overallVerdict: EdgeDecayVerdict;
  reasons: string[];
}

export interface EdgeDecayReportInput {
  observations: EdgeDecayLayerObservation[];
  generatedAt?: string;
  thresholds?: Partial<EdgeDecayThresholds>;
}

const DEFAULT_THRESHOLDS: EdgeDecayThresholds = {
  degradedNetDeltaBps: -5,
  brokenNetDeltaBps: -15,
  degradedHitRateDelta: -0.03,
  brokenHitRateDelta: -0.08,
};

export function buildEdgeDecayReport(
  input: EdgeDecayReportInput,
): EdgeDecayReportArtifact {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const thresholds: EdgeDecayThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...input.thresholds,
  };
  const byLayer = new Map(input.observations.map((item) => [item.layer, item]));
  const transitions: EdgeDecayTransition[] = [];

  pushTransition(byLayer, transitions, thresholds, "research", "paper");
  pushTransition(byLayer, transitions, thresholds, "paper", "live");
  pushTransition(byLayer, transitions, thresholds, "research", "live");

  const verdict =
    transitions.some((item) => item.verdict === "broken")
      ? "broken"
      : transitions.some((item) => item.verdict === "degraded")
        ? "degraded"
        : "stable";

  return {
    schemaVersion: EDGE_DECAY_REPORT_SCHEMA_VERSION,
    generatedAt,
    thresholds,
    layers: [...input.observations],
    transitions,
    overallVerdict: verdict,
    reasons: [...new Set(transitions.flatMap((item) => item.reasons))],
  };
}

function pushTransition(
  byLayer: Map<EdgeDecayLayer, EdgeDecayLayerObservation>,
  transitions: EdgeDecayTransition[],
  thresholds: EdgeDecayThresholds,
  fromLayer: EdgeDecayLayer,
  toLayer: EdgeDecayLayer,
): void {
  const from = byLayer.get(fromLayer);
  const to = byLayer.get(toLayer);
  if (!from || !to) {
    return;
  }

  const netDelta = roundMetric(to.netExpectancyBps - from.netExpectancyBps);
  const rawDelta = roundMetric(to.rawExpectancyBps - from.rawExpectancyBps);
  const hitRateDelta =
    typeof from.hitRate === "number" && typeof to.hitRate === "number"
      ? roundMetric(to.hitRate - from.hitRate)
      : null;

  const reasons: string[] = [];
  if (netDelta <= thresholds.brokenNetDeltaBps) {
    reasons.push("net_expectancy_broken");
  } else if (netDelta <= thresholds.degradedNetDeltaBps) {
    reasons.push("net_expectancy_degraded");
  }

  if (hitRateDelta != null) {
    if (hitRateDelta <= thresholds.brokenHitRateDelta) {
      reasons.push("hit_rate_broken");
    } else if (hitRateDelta <= thresholds.degradedHitRateDelta) {
      reasons.push("hit_rate_degraded");
    }
  }

  const verdict: EdgeDecayVerdict = reasons.some((item) =>
    item.endsWith("_broken"),
  )
    ? "broken"
    : reasons.length > 0
      ? "degraded"
      : "stable";

  transitions.push({
    fromLayer,
    toLayer,
    netExpectancyDeltaBps: netDelta,
    rawExpectancyDeltaBps: rawDelta,
    hitRateDelta,
    verdict,
    reasons,
  });
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}
