import { describe, expect, it } from "vitest";
import {
  extractRealizedPnlDetailsFromClosedTradesLedger,
  extractRealizedPnlDetailsFromBalancePayload,
  extractRealizedPnlFromBalancePayload,
} from "./ccxt-pnl.js";

describe("extractRealizedPnlFromBalancePayload", () => {
  it("prefers daily/top-level realized fields when present", () => {
    const realized = extractRealizedPnlFromBalancePayload({
      info: {
        totalRealizedPnl: "-123.45",
        positions: [{ realizedPnl: "-10" }, { realizedPnl: "-20" }],
      },
    });

    expect(realized).toBeCloseTo(-123.45);
  });

  it("aggregates same-depth realized fields when only per-position values exist", () => {
    const realized = extractRealizedPnlFromBalancePayload({
      info: {
        positions: [
          { realizedPnl: "-50" },
          { realizedPnl: "25" },
          { realizedPnl: "-10" },
        ],
      },
    });

    expect(realized).toBeCloseTo(-35);
  });

  it("returns 0 when no recognized realized field exists", () => {
    const realized = extractRealizedPnlFromBalancePayload({
      info: {
        totalUnrealizedProfit: "99.9",
      },
    });

    expect(realized).toBe(0);
  });

  it("marks result as found when a realized field exists with zero value", () => {
    const details = extractRealizedPnlDetailsFromBalancePayload({
      info: {
        totalRealizedPnl: "0",
      },
    });

    expect(details.realizedPnl).toBe(0);
    expect(details.found).toBe(true);
    expect(details.matchedKey).toBe("totalRealizedPnl");
  });

  it("extracts realized pnl from closed trades ledger", () => {
    const details = extractRealizedPnlDetailsFromClosedTradesLedger([
      {
        id: "1",
        info: { realizedPnl: "-10.5" },
      },
      {
        id: "2",
        pnl: "3.25",
      },
      {
        id: "3",
        info: { fee: "0.1" },
      },
    ]);

    expect(details.found).toBe(true);
    expect(details.matchedTradeCount).toBe(2);
    expect(details.realizedPnl).toBeCloseTo(-7.25);
  });

  it("returns not-found for empty/non-ledger trades", () => {
    const details = extractRealizedPnlDetailsFromClosedTradesLedger([
      { id: "1", info: { fee: "0.1" } },
    ]);

    expect(details.found).toBe(false);
    expect(details.matchedTradeCount).toBe(0);
    expect(details.realizedPnl).toBe(0);
  });
});
