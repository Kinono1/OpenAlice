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
    // Batch: if ANY request is write or unclassifiable, require trade
    return body.some(item => needsWrite(item));
  }

  if (typeof body !== "object" || body === null) {
    return true; // Can't classify → treat as write
  }

  const obj = body as Record<string, unknown>;
  const method = obj.method;

  if (typeof method !== "string") {
    return true; // Missing or non-string method → write
  }

  if (READ_METHODS.has(method)) {
    return false;
  }

  // Notifications for unknown/write methods should be treated as write.
  if (!("id" in obj)) {
    return true;
  }

  if (WRITE_METHODS.has(method)) {
    return true;
  }

  // WRITE_METHODS or unknown methods → write
  return true;
}

/**
 * Creates a Hono middleware that inspects MCP JSON-RPC requests and applies
 * the appropriate auth level (read vs write).
 *
 * - GET/DELETE: requireAuth (read level)
 * - POST with JSON-RPC: requireAuth for read methods, requireTrade for write/unknown
 */
export function createMcpAuthMiddleware(
  requireAuth: MiddlewareHandler,
  requireTrade: MiddlewareHandler
): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    const method = c.req.method;

    // GET (SSE transport) and DELETE (session mgmt) just need read auth
    if (method === "GET" || method === "DELETE") {
      return requireAuth(c, next);
    }

    if (method !== "POST") {
      return next();
    }

    // POST: must be JSON
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.startsWith("application/json")) {
      return c.json({ error: "expected application/json" }, 400);
    }

    // Clone the request so Hono can re-read the body downstream
    let parsed: unknown;
    try {
      parsed = await c.req.raw.clone().json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    // Store parsed body for downstream handlers
    c.set("parsedJsonRpcBody", parsed);

    if (needsWrite(parsed)) {
      return requireTrade(c, next);
    }

    return requireAuth(c, next);
  });
}
