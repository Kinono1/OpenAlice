import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PnLTracker } from "../src/extension/crypto-trading/pnl-tracker.js";
import { loadConfig } from "../src/core/config.js";

async function main() {
  const config = await loadConfig();
  const persistencePath = resolve("data/crypto-trading/pnl-fills.jsonl");
  const tracker = await PnLTracker.create({
    reconciliationThresholdPct: config.reconciliation.thresholdPct,
    persistencePath,
  });

  const raw = await readFile(persistencePath, "utf-8");
  const entries = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const symbolsSeen = [...new Set(entries.map((entry) => entry?.fill?.symbol).filter(Boolean))];
  const orderIds = entries
    .map((entry) => entry?.fill?.orderId)
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  const targetSymbol = "WIF/USD";
  const avgCostPosition = tracker.getAvgCostPosition(targetSymbol);
  const fifoPosition = tracker.getFIFOPosition(targetSymbol);
  const reconcile = tracker.reconcile(targetSymbol);

  const payload = {
    schemaVersion: "pnl_restore_inspection.v1",
    generatedAt: new Date().toISOString(),
    persistencePath,
    allowedSymbols: config.crypto.allowedSymbols,
    symbolsSeenFromFillFile: symbolsSeen,
    symbolMismatchAgainstAllowedSymbols:
      symbolsSeen.some((symbol) => !config.crypto.allowedSymbols.includes(symbol)),
    restoredSymbolOutsideAllowedList:
      !config.crypto.allowedSymbols.includes(targetSymbol) &&
      symbolsSeen.includes(targetSymbol) &&
      (Math.abs(reconcile.avgCostRealizedPnL) > 0 || Math.abs(reconcile.fifoRealizedPnL) > 0),
    fillCount: entries.length,
    orderIds,
    avgCostPosition,
    fifoPosition,
    reconcile,
    restoredFlatPosition:
      avgCostPosition == null &&
      fifoPosition == null &&
      Math.abs(reconcile.avgCostRealizedPnL - reconcile.fifoRealizedPnL) < 1e-12,
  };

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
