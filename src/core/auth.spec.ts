import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createRequireAuth, createRequireTrade } from "./auth.js";

function withBearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function withCookie(token: string) {
  return { Cookie: `alice_token=${encodeURIComponent(token)}` };
}

describe("auth middleware token resolution", () => {
  const originalAuthToken = process.env.AUTH_TOKEN;
  const originalTradeToken = process.env.TRADE_TOKEN;

  beforeEach(() => {
    delete process.env.AUTH_TOKEN;
    delete process.env.TRADE_TOKEN;
  });

  afterEach(() => {
    if (originalAuthToken === undefined) {
      delete process.env.AUTH_TOKEN;
    } else {
      process.env.AUTH_TOKEN = originalAuthToken;
    }
    if (originalTradeToken === undefined) {
      delete process.env.TRADE_TOKEN;
    } else {
      process.env.TRADE_TOKEN = originalTradeToken;
    }
  });

  it("allows trade endpoints with AUTH_TOKEN when TRADE_TOKEN is unset", async () => {
    process.env.AUTH_TOKEN = "auth-only";

    const app = new Hono();
    app.use("/trade/*", createRequireTrade());
    app.get("/trade/ping", c => c.json({ ok: true }));

    const okRes = await app.request("/trade/ping", {
      headers: withBearer("auth-only"),
    });
    expect(okRes.status).toBe(200);

    const unauthorized = await app.request("/trade/ping");
    expect(unauthorized.status).toBe(401);
  });

  it("requires TRADE_TOKEN for trade endpoints when both tokens are set", async () => {
    process.env.AUTH_TOKEN = "read-token";
    process.env.TRADE_TOKEN = "trade-token";

    const app = new Hono();
    app.use("/trade/*", createRequireTrade());
    app.get("/trade/ping", c => c.json({ ok: true }));

    const readTokenRes = await app.request("/trade/ping", {
      headers: withBearer("read-token"),
    });
    expect(readTokenRes.status).toBe(401);

    const tradeTokenRes = await app.request("/trade/ping", {
      headers: withBearer("trade-token"),
    });
    expect(tradeTokenRes.status).toBe(200);
  });

  it("allows read endpoints with TRADE_TOKEN when AUTH_TOKEN is unset", async () => {
    process.env.TRADE_TOKEN = "trade-only";

    const app = new Hono();
    app.use("/read/*", createRequireAuth());
    app.get("/read/ping", c => c.json({ ok: true }));

    const res = await app.request("/read/ping", {
      headers: withBearer("trade-only"),
    });
    expect(res.status).toBe(200);
  });

  it("allows read endpoints with query token for SSE/media clients", async () => {
    process.env.AUTH_TOKEN = "read-token";

    const app = new Hono();
    app.use("/read/*", createRequireAuth());
    app.get("/read/ping", c => c.json({ ok: true }));

    const res = await app.request("/read/ping?token=read-token");
    expect(res.status).toBe(200);
  });

  it("allows read endpoints with auth cookie for browser resources", async () => {
    process.env.AUTH_TOKEN = "cookie-token";

    const app = new Hono();
    app.use("/read/*", createRequireAuth());
    app.get("/read/ping", c => c.json({ ok: true }));

    const res = await app.request("/read/ping", {
      headers: withCookie("cookie-token"),
    });
    expect(res.status).toBe(200);
  });
});
