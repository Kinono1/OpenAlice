import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { createMcpAuthMiddleware } from "./mcp-auth-policy.js";

function createGuardedApp() {
  const requireAuth = createMiddleware(async (c) => {
    return c.json({ guard: "read" });
  });
  const requireTrade = createMiddleware(async (c) => {
    return c.json({ guard: "write" });
  });

  const app = new Hono();
  app.use("/mcp", createMcpAuthMiddleware(requireAuth, requireTrade));
  app.post("/mcp", (c) => c.json({ guard: "handler" }));
  return app;
}

describe("mcp auth policy", () => {
  it("treats notifications/initialized as read even without JSON-RPC id", async () => {
    const app = createGuardedApp();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ guard: "read" });
  });

  it("routes read methods with id to read auth", async () => {
    const app = createGuardedApp();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/list",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ guard: "read" });
  });

  it("routes tools/call to write auth", async () => {
    const app = createGuardedApp();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "2",
        method: "tools/call",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ guard: "write" });
  });

  it("treats unknown notifications as write", async () => {
    const app = createGuardedApp();

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/custom",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ guard: "write" });
  });
});
