import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { timingSafeEqual, createHmac } from "node:crypto";
import type { Plugin, EngineContext } from "../../core/types.js";
import {
  createRequireAuth,
  createRequireTrade,
  createStoppedMiddleware,
} from "../../core/auth.js";
import {
  createTrustedContext,
  runWithContextAsync,
  removeContext,
} from "../../core/trusted-context.js";
import { createMcpAuthMiddleware } from "../../core/mcp-auth-policy.js";
import { SessionStore, toTextHistory } from "../../core/session.js";
import { resolveEmergencySecret } from "../../core/emergency-secret.js";
import {
  registerConnector,
  touchInteraction,
} from "../../core/connector-registry.js";
import {
  loadConfig,
  writeConfigSection,
  type ConfigSection,
} from "../../core/config.js";
import {
  readAIConfig,
  writeAIConfig,
  type AIProvider,
} from "../../core/ai-config.js";

export interface WebConfig {
  port: number;
}

interface SSEClient {
  id: string;
  send: (data: string) => void;
}

export class WebPlugin implements Plugin {
  name = "web";
  private stoppedRef = { value: false };
  private server: ReturnType<typeof serve> | null = null;
  private session!: SessionStore;
  private ctx!: EngineContext;
  private sseClients = new Map<string, SSEClient>();
  private unregisterConnector?: () => void;
  /** Media path lookup: id → absolute file path. */
  private mediaMap = new Map<string, string>();

  constructor(private config: WebConfig) {}

  async start(ctx: EngineContext) {
    this.ctx = ctx;

    // Initialize session (mirrors Telegram's per-user pattern, single user for web)
    this.session = new SessionStore("web/default");
    await this.session.restore();

    const app = new Hono();
    app.use("/api/*", cors());

    // Auth middleware
    const requireAuth = createRequireAuth(ctx.config.auth.enforceAuth);
    const requireTrade = createRequireTrade(ctx.config.auth.enforceAuth);
    const stopped = createStoppedMiddleware(this.stoppedRef);

    // Apply stopped check to all API routes
    app.use("/api/*", stopped);

    // Read endpoints use requireAuth
    app.use("/api/chat/history", requireAuth);
    app.use("/api/chat/events", requireAuth);
    app.use("/api/config", requireAuth);
    app.use("/api/events", requireAuth);
    app.use("/api/events/*", requireAuth);
    app.use("/api/cron", requireAuth);
    app.use("/api/heartbeat", requireAuth);
    app.use("/api/media/*", requireAuth);

    // Write endpoints use requireTrade
    app.use("/api/chat", requireTrade);
    app.use("/api/ai-config", requireTrade);

    // ==================== Chat endpoint ====================
    app.post("/api/chat", async c => {
      const body = await c.req.json<{ message?: string }>();
      const message = body.message?.trim();
      if (!message) {
        return c.json({ error: "message is required" }, 400);
      }

      const trustedCtx = createTrustedContext({
        channel: "web",
        sessionId: this.session.id,
        actor: "web-default",
        ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip"),
      });

      try {
        const result = await runWithContextAsync(trustedCtx, async () => {
          touchInteraction("web", "default");

          // Log: message received
          const receivedEntry = await ctx.eventLog.append("message.received", {
            channel: "web",
            to: "default",
            prompt: message,
          });

          // Route through unified provider (Engine → ProviderRouter → Vercel or Claude Code)
          const askResult = await ctx.engine.askWithSession(
            message,
            this.session,
            {
              historyPreamble:
                "The following is the recent conversation from the Web UI. Use it as context if the user references earlier messages.",
            }
          );

          // Log: message sent
          await ctx.eventLog.append("message.sent", {
            channel: "web",
            to: "default",
            prompt: message,
            reply: askResult.text,
            durationMs: Date.now() - receivedEntry.ts,
          });

          // Map media files to serveable URLs
          const media = (askResult.media ?? []).map(m => {
            const id = randomUUID();
            this.mediaMap.set(id, m.path);
            return { type: "image" as const, url: `/api/media/${id}` };
          });

          // Evict old media entries (keep last 200)
          if (this.mediaMap.size > 200) {
            const keys = [...this.mediaMap.keys()];
            for (let i = 0; i < keys.length - 200; i++) {
              this.mediaMap.delete(keys[i]);
            }
          }

          return { text: askResult.text, media };
        });

        return c.json(result);
      } finally {
        removeContext(trustedCtx.contextId);
      }
    });

    // ==================== History endpoint ====================
    app.get("/api/chat/history", requireAuth, async c => {
      const limit = Number(c.req.query("limit")) || 100;

      const entries = await this.session.readActive();
      const history = toTextHistory(entries);
      const trimmed = history.slice(-limit);

      // Attach timestamps from the original entries (best-effort match)
      const entryTimestamps = entries
        .filter(e => e.type === "user" || e.type === "assistant")
        .map(e => e.timestamp);

      const messages = trimmed.map((h, i) => ({
        role: h.role,
        text: h.text,
        timestamp:
          entryTimestamps[entryTimestamps.length - trimmed.length + i] ?? null,
      }));

      return c.json({ messages });
    });

    // ==================== SSE endpoint ====================
    app.get("/api/chat/events", requireAuth, c => {
      return streamSSE(c, async stream => {
        const clientId = randomUUID();

        this.sseClients.set(clientId, {
          id: clientId,
          send: data => {
            stream.writeSSE({ data }).catch(() => {});
          },
        });

        // Keep alive with periodic pings
        const pingInterval = setInterval(() => {
          stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
        }, 30_000);

        stream.onAbort(() => {
          clearInterval(pingInterval);
          this.sseClients.delete(clientId);
        });

        // Keep stream open indefinitely
        await new Promise<void>(() => {});
      });
    });

    // ==================== Media endpoint ====================
    app.get("/api/media/:id", requireAuth, async c => {
      const id = c.req.param("id");
      const filePath = this.mediaMap.get(id);
      if (!filePath) return c.notFound();

      try {
        const buf = await readFile(filePath);
        const ext = filePath.split(".").pop()?.toLowerCase();
        const mime =
          ext === "png"
            ? "image/png"
            : ext === "jpg" || ext === "jpeg"
              ? "image/jpeg"
              : ext === "webp"
                ? "image/webp"
                : ext === "gif"
                  ? "image/gif"
                  : "application/octet-stream";
        return c.body(buf, { headers: { "Content-Type": mime } });
      } catch {
        return c.notFound();
      }
    });

    // ==================== Config endpoints ====================
    app.get("/api/config", requireAuth, async c => {
      try {
        const [config, aiConfig] = await Promise.all([
          loadConfig(),
          readAIConfig(),
        ]);
        return c.json({ ...config, aiProvider: aiConfig.provider });
      } catch (err) {
        return c.json({ error: String(err) }, 500);
      }
    });

    app.put("/api/config/ai-provider", requireTrade, async c => {
      try {
        const body = await c.req.json<{ provider?: string }>();
        const provider = body.provider;
        if (provider !== "claude-code" && provider !== "vercel-ai-sdk") {
          return c.json(
            {
              error:
                'Invalid provider. Must be "claude-code" or "vercel-ai-sdk".',
            },
            400
          );
        }
        await writeAIConfig(provider as AIProvider);
        return c.json({ provider });
      } catch (err) {
        return c.json({ error: String(err) }, 500);
      }
    });

    app.put("/api/config/:section", requireTrade, async c => {
      try {
        const section = c.req.param("section") as ConfigSection;
        const validSections: ConfigSection[] = [
          "engine",
          "model",
          "agent",
          "crypto",
          "securities",
          "compaction",
          "risk",
          "news",
          "aiProvider",
          "heartbeat",
          "auth",
          "decisionTicket",
          "killSwitch",
          "slippage",
          "reconciliation",
          "reviewGate",
          "shutdown",
        ];
        if (!validSections.includes(section)) {
          return c.json(
            {
              error: `Invalid section "${section}". Valid: ${validSections.join(", ")}`,
            },
            400
          );
        }
        const body = await c.req.json();
        const validated = await writeConfigSection(section, body);
        return c.json(validated);
      } catch (err) {
        if (err instanceof Error && err.name === "ZodError") {
          return c.json(
            { error: "Validation failed", details: JSON.parse(err.message) },
            400
          );
        }
        return c.json({ error: String(err) }, 500);
      }
    });

    // ==================== Event Log endpoints ====================
    app.get("/api/events/recent", requireAuth, c => {
      const afterSeq = Number(c.req.query("afterSeq")) || 0;
      const limit = Number(c.req.query("limit")) || 100;
      const type = c.req.query("type") || undefined;
      const entries = ctx.eventLog.recent({ afterSeq, limit, type });
      return c.json({ entries, lastSeq: ctx.eventLog.lastSeq() });
    });

    app.get("/api/events/stream", requireAuth, c => {
      return streamSSE(c, async stream => {
        const unsub = ctx.eventLog.subscribe(entry => {
          stream.writeSSE({ data: JSON.stringify(entry) }).catch(() => {});
        });

        const pingInterval = setInterval(() => {
          stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
        }, 30_000);

        stream.onAbort(() => {
          clearInterval(pingInterval);
          unsub();
        });

        await new Promise<void>(() => {});
      });
    });

    // ==================== Cron endpoints ====================
    app.get("/api/cron/jobs", requireAuth, c => {
      const jobs = ctx.cronEngine.list();
      return c.json({ jobs });
    });

    app.post("/api/cron/jobs", requireTrade, async c => {
      try {
        const body = await c.req.json<{
          name: string;
          payload: string;
          schedule: {
            kind: string;
            at?: string;
            every?: string;
            cron?: string;
          };
          enabled?: boolean;
        }>();
        if (!body.name || !body.payload || !body.schedule?.kind) {
          return c.json(
            { error: "name, payload, and schedule are required" },
            400
          );
        }
        const id = await ctx.cronEngine.add({
          name: body.name,
          payload: body.payload,
          schedule:
            body.schedule as import("../../task/cron/engine.js").CronSchedule,
          enabled: body.enabled,
        });
        return c.json({ id });
      } catch (err) {
        return c.json({ error: String(err) }, 500);
      }
    });

    app.put("/api/cron/jobs/:id", requireTrade, async c => {
      try {
        const id = c.req.param("id");
        const body = await c.req.json();
        await ctx.cronEngine.update(id, body);
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: String(err) }, 500);
      }
    });

    app.delete("/api/cron/jobs/:id", requireTrade, async c => {
      try {
        const id = c.req.param("id");
        await ctx.cronEngine.remove(id);
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: String(err) }, 500);
      }
    });

    app.post("/api/cron/jobs/:id/run", requireTrade, async c => {
      try {
        const id = c.req.param("id");
        await ctx.cronEngine.runNow(id);
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: String(err) }, 500);
      }
    });

    // ==================== Heartbeat endpoints ====================
    app.get("/api/heartbeat/status", requireAuth, c => {
      return c.json({
        enabled: ctx.heartbeat.isEnabled(),
      });
    });

    app.post("/api/heartbeat/trigger", requireTrade, async c => {
      try {
        // Find the __heartbeat__ cron job and runNow on it
        const jobs = ctx.cronEngine.list();
        const hbJob = jobs.find(j => j.name === "__heartbeat__");
        if (!hbJob) {
          return c.json(
            { error: "Heartbeat cron job not found. Is heartbeat enabled?" },
            404
          );
        }
        await ctx.cronEngine.runNow(hbJob.id);
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: String(err) }, 500);
      }
    });

    app.put("/api/heartbeat/enabled", requireTrade, async c => {
      try {
        const body = await c.req.json<{ enabled: boolean }>();
        await ctx.heartbeat.setEnabled(body.enabled);
        return c.json({ enabled: ctx.heartbeat.isEnabled() });
      } catch (err) {
        return c.json({ error: String(err) }, 500);
      }
    });

    // ==================== Emergency Close ====================
    app.post("/api/emergency-close", requireTrade, async c => {
      const emergencySecret = resolveEmergencySecret();
      if (!emergencySecret) {
        return c.json({ error: "emergency-close not configured" }, 503);
      }

      const body = await c.req.json<{
        symbol: string;
        timestamp: number;
        signature: string;
      }>();
      const { symbol, timestamp, signature } = body;

      if (!symbol || !timestamp || !signature) {
        return c.json(
          { error: "missing required fields: symbol, timestamp, signature" },
          400
        );
      }

      // Timestamp window check (±60s)
      const now = Date.now();
      const drift = Math.abs(now - timestamp);
      if (drift > 60_000) {
        await ctx.eventLog.append("emergency-close.rejected", {
          symbol,
          reason: "timestamp-out-of-window",
          drift,
        });
        return c.json({ error: "timestamp out of window" }, 400);
      }

      // HMAC signature verification
      const expectedSig = createHmac("sha256", emergencySecret)
        .update(`${timestamp}${symbol}`)
        .digest("hex");

      let sigValid = false;
      try {
        const sigBuf = Buffer.from(signature, "hex");
        const expectedBuf = Buffer.from(expectedSig, "hex");
        sigValid =
          sigBuf.length === expectedBuf.length &&
          timingSafeEqual(sigBuf, expectedBuf);
      } catch {
        sigValid = false;
      }

      if (!sigValid) {
        await ctx.eventLog.append("emergency-close.rejected", {
          symbol,
          reason: "invalid-signature",
        });
        return c.json({ error: "invalid signature" }, 403);
      }

      // Execute reduceOnly market close
      if (!ctx.cryptoEngine) {
        return c.json({ error: "no crypto engine available" }, 503);
      }

      const positions = await ctx.cryptoEngine.getPositions();
      const position = positions.find(p => p.symbol === symbol);
      if (!position) {
        return c.json({ error: `no open position for ${symbol}` }, 404);
      }

      const closeSide = position.side === "long" ? "sell" : "buy";
      const result = await ctx.cryptoEngine.placeOrder({
        symbol,
        side: closeSide,
        type: "market",
        size: position.size,
        reduceOnly: true,
      });

      await ctx.eventLog.append("emergency-close", {
        symbol,
        side: closeSide,
        size: position.size,
        result,
        timestamp: now,
      });

      return c.json({ ok: result.success, result });
    });

    // ==================== Serve UI (Vite build output) ====================
    // Serves the built frontend from dist/ui/ (produced by `pnpm build:ui`).
    // During development, use the Vite dev server (port 5173) instead — see README.
    const uiRoot = resolve("dist/ui");
    app.use("/*", serveStatic({ root: uiRoot }));

    // SPA fallback: serve index.html for non-API routes (client-side routing)
    app.get("*", serveStatic({ root: uiRoot, path: "index.html" }));

    // ==================== Connector registration ====================
    this.unregisterConnector = registerConnector({
      channel: "web",
      to: "default",
      deliver: async (text: string) => {
        const data = JSON.stringify({ type: "message", text });
        for (const client of this.sseClients.values()) {
          try {
            client.send(data);
          } catch {
            /* client disconnected */
          }
        }
      },
    });

    // ==================== Start server ====================
    this.server = serve({ fetch: app.fetch, port: this.config.port }, info => {
      console.log(`web plugin listening on http://localhost:${info.port}`);
    });
  }

  async stop() {
    this.stoppedRef.value = true;
    this.sseClients.clear();
    this.unregisterConnector?.();
    this.server?.close();
  }
}
