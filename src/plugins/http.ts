import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Plugin, EngineContext } from "../core/types.js";
import { createRequireAuth, createRequireTrade } from "../core/auth.js";
import { resolveEmergencySecret } from "../core/emergency-secret.js";

export class HttpPlugin implements Plugin {
  name = "http";
  private server: ReturnType<typeof serve> | null = null;

  async start(ctx: EngineContext) {
    const app = new Hono();
    const requireAuth = createRequireAuth(ctx.config.auth.enforceAuth);
    const requireTrade = createRequireTrade(ctx.config.auth.enforceAuth);

    app.get("/health", c => c.json({ ok: true }));

    app.get("/status", requireAuth, async c => {
      const [account, positions, orders] = ctx.cryptoEngine
        ? await Promise.all([
            ctx.cryptoEngine.getAccount(),
            ctx.cryptoEngine.getPositions(),
            ctx.cryptoEngine.getOrders(),
          ])
        : [null, [], []];
      return c.json({
        playheadTime: ctx.klineStore.getPlayheadTime().toISOString(),
        account,
        positions,
        orders,
      });
    });

    // ==================== Emergency close ====================
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
          reason: "timestamp-expired",
          drift,
        });
        return c.json({ error: "timestamp outside ±60s window" }, 400);
      }

      // Verify HMAC signature
      const expectedSig = createHmac("sha256", emergencySecret)
        .update(String(timestamp) + symbol)
        .digest("hex");

      let sigValid = false;
      try {
        const sigBufA = Buffer.from(signature, "hex");
        const sigBufB = Buffer.from(expectedSig, "hex");
        sigValid =
          sigBufA.length === sigBufB.length &&
          timingSafeEqual(sigBufA, sigBufB);
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
        return c.json({ error: "crypto engine not available" }, 503);
      }

      const positions = await ctx.cryptoEngine.getPositions();
      const position = positions.find(p => p.symbol === symbol);
      if (!position) {
        await ctx.eventLog.append("emergency-close.no-position", { symbol });
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
      });

      return c.json({ success: result.success, result });
    });

    this.server = serve(
      { fetch: app.fetch, port: ctx.config.engine.port },
      info => {
        console.log(`http plugin listening on http://localhost:${info.port}`);
      }
    );
  }

  async stop() {
    this.server?.close();
  }
}
