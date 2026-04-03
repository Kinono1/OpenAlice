import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function extractBearer(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7);
}

function extractCookieToken(
  cookieHeader: string | undefined,
  cookieName: string
): string | null {
  if (!cookieHeader) return null;
  const chunks = cookieHeader.split(";");
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    if (key !== cookieName) continue;
    const rawValue = trimmed.slice(eq + 1);
    if (!rawValue) return null;
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return null;
}

function extractToken(req: {
  header: (name: string) => string | undefined;
}): string | null {
  const headerToken =
    extractBearer(req.header("Authorization")) ??
    extractBearer(req.header("authorization"));
  if (headerToken) {
    return headerToken;
  }

  return (
    extractCookieToken(req.header("Cookie"), "alice_token") ??
    extractCookieToken(req.header("cookie"), "alice_token") ??
    extractCookieToken(req.header("Cookie"), "auth_token") ??
    extractCookieToken(req.header("cookie"), "auth_token")
  );
}

function resolveTokens() {
  const auth = process.env.AUTH_TOKEN || process.env.TRADE_TOKEN || "";
  const trade = process.env.TRADE_TOKEN || process.env.AUTH_TOKEN || "";
  return { auth, trade };
}

export function isAuthEnabled(): boolean {
  return !!(process.env.AUTH_TOKEN || process.env.TRADE_TOKEN);
}

function guardMiddleware(
  getExpected: () => string,
  enforceAuth = false
): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    const expected = getExpected();

    if (!expected) {
      if (enforceAuth) {
        return c.json({ error: "unauthorized" }, 401);
      }
      return next();
    }

    const token = extractToken(c.req);
    if (!token || !safeEqual(token, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    await next();
  });
}

export function createRequireAuth(enforceAuth = false): MiddlewareHandler {
  return guardMiddleware(() => resolveTokens().auth, enforceAuth);
}

export function createRequireTrade(enforceAuth = false): MiddlewareHandler {
  return guardMiddleware(() => resolveTokens().trade, enforceAuth);
}

export function createStoppedMiddleware(stoppedRef: {
  value: boolean;
}): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    if (stoppedRef.value) {
      return c.json({ error: "service stopping" }, 503);
    }
    await next();
  });
}
