import { describe, expect, it } from "vitest";
import { buildTradeAttribution } from "./trade_attribution";

describe("trade_attribution", () => {
  it("computes residual attribution and dominant component", () => {
    const artifact = buildTradeAttribution({
      generatedAt: "2026-03-28T00:00:00.000Z",
      tradeId: "trade-1",
      symbol: "BTC/USD",
      realizedPnlUsd: 120,
      components: {
        signalUsd: 80,
        regimeRoutingUsd: 15,
        portfolioSizingUsd: 10,
        executionCostUsd: -8,
        donorOverlayUsd: 5,
      },
    });

    expect(artifact.schemaVersion).toBe("trade_attribution.v1");
    expect(artifact.components.residualUsd).toBe(18);
    expect(artifact.dominantComponent).toBe("signal");
  });
});
