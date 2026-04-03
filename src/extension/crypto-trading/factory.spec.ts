import { afterEach, describe, expect, it, vi } from "vitest";
import { createCryptoTradingEngine } from "./factory.js";

const initMock = vi.fn();
const closeMock = vi.fn();

vi.mock("./providers/ccxt/index", () => {
  class MockCcxtTradingEngine {
    init = initMock;
    close = closeMock;
  }

  return {
    CcxtTradingEngine: MockCcxtTradingEngine,
  };
});

function buildConfig(overrides?: Partial<Record<string, unknown>>) {
  return {
    crypto: {
      provider: {
        type: "ccxt",
        exchange: "okx",
        apiKey: "api-key",
        apiSecret: "api-secret",
        password: undefined,
        sandbox: false,
        demoTrading: true,
        defaultMarketType: "swap",
        options: {},
        ...(overrides ?? {}),
      },
    },
  } as any;
}

describe("createCryptoTradingEngine", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    initMock.mockReset();
    closeMock.mockReset();
    for (const key of Object.keys(process.env)) {
      if (!(key in envBackup)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("fails fast when trading auth token is missing", async () => {
    delete process.env.AUTH_TOKEN;
    delete process.env.TRADE_TOKEN;
    delete process.env.DISABLE_TRADE_AUTH_TOKEN_ENFORCE;

    await expect(createCryptoTradingEngine(buildConfig())).rejects.toThrow(
      /Trading interface auth token missing/i,
    );
    expect(initMock).not.toHaveBeenCalled();
  });

  it("creates the engine when token is configured", async () => {
    process.env.TRADE_TOKEN = "token-123";
    initMock.mockResolvedValue(undefined);

    const result = await createCryptoTradingEngine(buildConfig());

    expect(initMock).toHaveBeenCalledTimes(1);
    expect(result?.engine).toBeDefined();
  });

  it("blocks real trading mode unless explicitly allowed", async () => {
    process.env.TRADE_TOKEN = "token-123";
    delete process.env.ALLOW_LIVE_TRADING;

    await expect(
      createCryptoTradingEngine(
        buildConfig({
          sandbox: false,
          demoTrading: false,
        }),
      ),
    ).rejects.toThrow(/Live trading is blocked by default/i);
    expect(initMock).not.toHaveBeenCalled();
  });
});
