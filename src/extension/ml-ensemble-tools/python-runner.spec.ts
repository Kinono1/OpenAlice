import { existsSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import type { MarketData } from "../analysis-kit/data/interfaces";
import { runMlEnsemblePredict } from "./python-runner";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makePredictableCandles(count: number): MarketData[] {
  const out: MarketData[] = [];
  const rand = makeRng(42);
  let price = 100;
  for (let i = 0; i < count; i++) {
    const cyc = Math.sin(i / 8) + 0.35 * Math.sin(i / 23);
    const driftSignal = cyc >= 0 ? 1 : -1;
    const agreement = rand() < 0.74 ? 1 : -1;
    const ret = driftSignal * agreement * 0.0022 + (rand() - 0.5) * 0.0012;

    const open = price;
    const close = Math.max(1, price * (1 + ret));
    const high = Math.max(open, close) * (1 + 0.0008 + rand() * 0.0015);
    const low = Math.min(open, close) * (1 - 0.0008 - rand() * 0.0015);
    const volume = 1000 + Math.abs(driftSignal) * 200 + rand() * 300;

    out.push({
      symbol: "BTC/USD",
      time: 1_700_000_000 + i * 3600,
      open,
      high,
      low,
      close,
      volume,
    });
    price = close;
  }
  return out;
}

const hasLocalPython = existsSync(resolve(".venv/bin/python"));
const maybeIt = hasLocalPython ? it : it.skip;

describe("runMlEnsemblePredict", () => {
  maybeIt(
    "beats baseline direction accuracy on synthetic data",
    async () => {
      const candles = makePredictableCandles(800);
      const result = await runMlEnsemblePredict({
        candles,
        horizonBars: 1,
        trainRatio: 0.8,
        ensembleMode: "regime_moe",
        regimeCount: 3,
        regimeMethod: "rule",
        calibrationMethod: "sigmoid",
        includeModels: [
          "xgboost",
          "lightgbm",
          "catboost",
          "randomForest",
          "ridge",
          "pytorch",
        ],
        seed: 42,
      });

      expect(result.modelsUsed.length).toBeGreaterThanOrEqual(3);
      expect(result.metrics.directionAccuracy).toBeGreaterThan(
        result.metrics.baselineDirectionAccuracy
      );
      expect(result.metrics.directionAccuracy).toBeGreaterThan(0.52);
      expect(result.regimeSummary?.currentRegime).toBeDefined();
      expect(result.oofQuality?.coveragePerModel).toBeDefined();
      expect(result.selectionAudit?.lockedTestWindow?.size).toBeGreaterThan(0);
    },
    120_000
  );
});
