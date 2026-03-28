export interface TradeAttributionInput {
  tradeId: string;
  symbol: string;
  generatedAt?: string;
  realizedPnlUsd: number;
  components: {
    signalUsd?: number;
    regimeRoutingUsd?: number;
    portfolioSizingUsd?: number;
    executionCostUsd?: number;
    donorOverlayUsd?: number;
  };
}

export interface TradeAttributionArtifact {
  schemaVersion: "trade_attribution.v1";
  generatedAt: string;
  tradeId: string;
  symbol: string;
  realizedPnlUsd: number;
  components: {
    signalUsd: number;
    regimeRoutingUsd: number;
    portfolioSizingUsd: number;
    executionCostUsd: number;
    donorOverlayUsd: number;
    residualUsd: number;
  };
  dominantComponent:
    | "signal"
    | "regimeRouting"
    | "portfolioSizing"
    | "executionCost"
    | "donorOverlay"
    | "residual";
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function dominantComponent(
  components: TradeAttributionArtifact["components"],
): TradeAttributionArtifact["dominantComponent"] {
  const entries: Array<[TradeAttributionArtifact["dominantComponent"], number]> = [
    ["signal", Math.abs(components.signalUsd)],
    ["regimeRouting", Math.abs(components.regimeRoutingUsd)],
    ["portfolioSizing", Math.abs(components.portfolioSizingUsd)],
    ["executionCost", Math.abs(components.executionCostUsd)],
    ["donorOverlay", Math.abs(components.donorOverlayUsd)],
    ["residual", Math.abs(components.residualUsd)],
  ];
  entries.sort((left, right) => right[1] - left[1]);
  return entries[0]?.[0] ?? "residual";
}

export function buildTradeAttribution(
  input: TradeAttributionInput,
): TradeAttributionArtifact {
  const components = {
    signalUsd: round(input.components.signalUsd ?? 0),
    regimeRoutingUsd: round(input.components.regimeRoutingUsd ?? 0),
    portfolioSizingUsd: round(input.components.portfolioSizingUsd ?? 0),
    executionCostUsd: round(input.components.executionCostUsd ?? 0),
    donorOverlayUsd: round(input.components.donorOverlayUsd ?? 0),
  };
  const explained =
    components.signalUsd +
    components.regimeRoutingUsd +
    components.portfolioSizingUsd +
    components.executionCostUsd +
    components.donorOverlayUsd;
  const residualUsd = round(input.realizedPnlUsd - explained);
  const full = {
    ...components,
    residualUsd,
  };

  return {
    schemaVersion: "trade_attribution.v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    tradeId: input.tradeId,
    symbol: input.symbol,
    realizedPnlUsd: round(input.realizedPnlUsd),
    components: full,
    dominantComponent: dominantComponent(full),
  };
}
