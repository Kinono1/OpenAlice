import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createHealthRoutes } from "./health.js";

function makeCtx(overrides: {
  enforceAuth?: boolean;
  hasExchange?: boolean;
} = {}) {
  return {
    config: {
      auth: { enforceAuth: overrides.enforceAuth ?? true },
    },
    connectorCenter: {
      hasConnectors: () => overrides.hasExchange ?? true,
    },
  } as any;
}

describe("createHealthRoutes", () => {
  const originalAuthToken = process.env.AUTH_TOKEN;
  const originalTradeToken = process.env.TRADE_TOKEN;
  const originalDevBypass = process.env.DEV_AUTH_BYPASS;

  afterEach(() => {
    if (originalAuthToken === undefined) delete process.env.AUTH_TOKEN;
    else process.env.AUTH_TOKEN = originalAuthToken;
    if (originalTradeToken === undefined) delete process.env.TRADE_TOKEN;
    else process.env.TRADE_TOKEN = originalTradeToken;
    if (originalDevBypass === undefined) delete process.env.DEV_AUTH_BYPASS;
    else process.env.DEV_AUTH_BYPASS = originalDevBypass;
  });

  it("reports not-ready when auth is enforced but tokens are missing", async () => {
    delete process.env.AUTH_TOKEN;
    delete process.env.TRADE_TOKEN;
    delete process.env.DEV_AUTH_BYPASS;

    const app = new Hono();
    app.route("/api", createHealthRoutes(makeCtx({ enforceAuth: true, hasExchange: true })));

    const res = await app.request("/api/readiness");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("not-ready");
    expect(body.checks.auth.ok).toBe(false);
  });

  it("reports ready when auth is enforced and tokens are configured", async () => {
    process.env.AUTH_TOKEN = "auth-token";
    delete process.env.TRADE_TOKEN;
    delete process.env.DEV_AUTH_BYPASS;

    const app = new Hono();
    app.route("/api", createHealthRoutes(makeCtx({ enforceAuth: true, hasExchange: true })));

    const res = await app.request("/api/readiness");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
    expect(body.checks.auth.ok).toBe(true);
    expect(body.checks.exchange.ok).toBe(true);
  });
});
