import { createMiddleware } from "hono/factory";
import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

const AUTH_TOKEN = process.env.ALICE_AUTH_TOKEN;
const TRADE_TOKEN = process.env.ALICE_TRADE_TOKEN;
const tokensConfigured = !!(AUTH_TOKEN || TRADE_TOKEN);

let devWarned = false;

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self to keep constant time, then return false
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function extractToken(c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } }): string | undefined {
  const authHeader = c.req.header("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return undefined;
}

/**
 * Requires AUTH_TOKEN or TRADE_TOKEN.
 * In dev mode (no tokens configured), passes through with a one-time warning.
 */
export const requireAuth: MiddlewareHandler = createMiddleware(async (c, next) => {
  if (!tokensConfigured) {
    if (!devWarned) {
      devWarned = true;
      console.warn("[auth] ALICE_AUTH_TOKEN / ALICE_TRADE_TOKEN not set — running in dev mode (no auth)");
    }
    return next();
  }

  const token = extractToken(c);
  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const ok =
    (AUTH_TOKEN && safeEqual(token, AUTH_TOKEN)) ||
    (TRADE_TOKEN && safeEqual(token, TRADE_TOKEN));

  if (!ok) {
    return c.json({ error: "unauthorized" }, 401);
  }

  return next();
});

/**
 * Requires TRADE_TOKEN specifically.
 * In dev mode (no tokens configured), passes through with a one-time warning.
 */
export const requireTrade: MiddlewareHandler = createMiddleware(async (c, next) => {
  if (!tokensConfigured) {
    if (!devWarned) {
      devWarned = true;
      console.warn("[auth] ALICE_AUTH_TOKEN / ALICE_TRADE_TOKEN not set — running in dev mode (no auth)");
    }
    return next();
  }

  const token = extractToken(c);
  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }

  if (!TRADE_TOKEN || !safeEqual(token, TRADE_TOKEN)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  return next();
});
