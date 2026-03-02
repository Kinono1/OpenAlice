import ccxt from "ccxt";
import { runMlEnsemblePredict } from "../src/extension/ml-ensemble-tools/index.js";

type Args = {
  symbol: string;
  hours: number;
  horizonBars: number;
  trainRatio: number;
};

function parseArgs(): Args {
  const raw = process.argv.slice(2).filter(token => token !== "--");
  const map = new Map<string, string>();
  for (let i = 0; i < raw.length; i += 1) {
    if (
      raw[i]?.startsWith("--") &&
      raw[i + 1] &&
      !raw[i + 1].startsWith("--")
    ) {
      map.set(raw[i].slice(2), raw[i + 1]);
      i += 1;
    }
  }
  return {
    symbol: map.get("symbol") ?? "BTC/USDT:USDT",
    hours: Number(map.get("hours") ?? 1600),
    horizonBars: Number(map.get("horizonBars") ?? 1),
    trainRatio: Number(map.get("trainRatio") ?? 0.8),
  };
}

async function fetchOkxHours(symbol: string, hours: number) {
  const exchange = new ccxt.okx({
    enableRateLimit: true,
    timeout: 30_000,
    options: { defaultType: "swap" },
  });

  const timeframe = "1h";
  const startMs = Date.now() - hours * 3600 * 1000;
  let since = startMs;
  const out: Array<[number, number, number, number, number, number]> = [];

  while (out.length < hours + 60) {
    const batch = (await exchange.fetchOHLCV(
      symbol,
      timeframe,
      since,
      300
    )) as Array<[number, number, number, number, number, number]>;
    if (!batch.length) break;
    out.push(...batch);
    const lastTs = batch[batch.length - 1][0];
    if (lastTs <= since) break;
    since = lastTs + 3600 * 1000;
    if (batch.length < 300) break;
  }

  await exchange.close();
  const dedup = new Map<
    number,
    [number, number, number, number, number, number]
  >();
  for (const row of out) dedup.set(row[0], row);
  return Array.from(dedup.values())
    .sort((a, b) => a[0] - b[0])
    .slice(-hours);
}

async function main() {
  const args = parseArgs();
  const rows = await fetchOkxHours(args.symbol, args.hours);
  const candles = rows.map(row => ({
    symbol: "BTC/USD",
    time: Math.floor(row[0] / 1000),
    open: row[1],
    high: row[2],
    low: row[3],
    close: row[4],
    volume: row[5],
  }));

  const result = await runMlEnsemblePredict({
    candles,
    horizonBars: args.horizonBars,
    trainRatio: args.trainRatio,
    includeModels: [
      "xgboost",
      "lightgbm",
      "catboost",
      "randomForest",
      "ridge",
      "pytorch",
    ],
    minConfidence: 0.55,
    minExpectedReturnPct: 0.03,
    seed: 42,
  });

  console.log(
    JSON.stringify(
      {
        symbol: args.symbol,
        bars: candles.length,
        modelsUsed: result.modelsUsed,
        droppedModels: result.droppedModels,
        metrics: result.metrics,
        prediction: result.prediction,
      },
      null,
      2
    )
  );
}

main().catch(err => {
  console.error("ml_ensemble_eval failed:", err);
  process.exit(1);
});
