import { describe, expect, it } from "vitest";
import {
  assertSafeTradingMode,
  assertTradingInterfaceAuthToken,
} from "./trading-guard.js";

describe("trading-guard", () => {
  it("accepts trade token", () => {
    expect(() =>
      assertTradingInterfaceAuthToken({ TRADE_TOKEN: "token-123" }),
    ).not.toThrow();
  });

  it("accepts auth token", () => {
    expect(() =>
      assertTradingInterfaceAuthToken({ AUTH_TOKEN: "token-123" }),
    ).not.toThrow();
  });

  it("rejects missing tokens by default", () => {
    expect(() => assertTradingInterfaceAuthToken({})).toThrow(
      /TRADE_TOKEN or AUTH_TOKEN/i,
    );
  });

  it("can disable token enforcement explicitly", () => {
    expect(() =>
      assertTradingInterfaceAuthToken({
        DISABLE_TRADE_AUTH_TOKEN_ENFORCE: "true",
      }),
    ).not.toThrow();
  });

  it("allows sandbox mode", () => {
    expect(() =>
      assertSafeTradingMode({ sandbox: true, demoTrading: false }, {}),
    ).not.toThrow();
  });

  it("allows demo mode", () => {
    expect(() =>
      assertSafeTradingMode({ sandbox: false, demoTrading: true }, {}),
    ).not.toThrow();
  });

  it("blocks live mode by default", () => {
    expect(() =>
      assertSafeTradingMode({ sandbox: false, demoTrading: false }, {}),
    ).toThrow(/Live trading is blocked by default/i);
  });

  it("allows live mode with explicit override", () => {
    expect(() =>
      assertSafeTradingMode(
        { sandbox: false, demoTrading: false },
        { ALLOW_LIVE_TRADING: "true" },
      ),
    ).not.toThrow();
  });
});

