import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";

const READ_METHODS = new Set([
  "initialize",
  "ping",
  "notifications/initialized",
  "resources/list",
  "resources/read",
  "resources/templates/list",
  "tools/list",
  "prompts/list",
  "prompts/get",
  "completion/complete",
]);

const WRITE_METHODS = new Set([
  "tools/call",
  "resources/subscribe",
  "resources/unsubscribe",
  "logging/setLevel",
]);

function needsWrite(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some(item => needsWrite(item));
  }

  if (typeof body !== "object" || body === null) {
    return true;
  }

  const obj = body as Record<string, unknown>;
  const method = obj.method;

  if (typeof method !== "string") {
    return true;
  }

  if (READ_METHODS.has(method)) {
    return false;
  }

  if (!("id" in obj)) {
    return true;
  }

  if (WRITE_METHODS.has(method)) {
    return true;
  }

  return true;
}

export function createMcpAuthMiddleware(
  requireAuth: MiddlewareHandler,
  requireTrade: MiddlewareHandler
): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    const method = c.req.method;

    if (method === "GET" || method === "DELETE") {
      return requireAuth(c, next);
    }

    if (method !== "POST") {
      return next();
    }

    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.startsWith("application/json")) {
      return c.json({ error: "expected application/json" }, 400);
    }

    let parsed: unknown;
    try {
      parsed = await c.req.raw.clone().json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    c.set("parsedJsonRpcBody", parsed);

    if (needsWrite(parsed)) {
      return requireTrade(c, next);
    }

    return requireAuth(c, next);
  });
}
