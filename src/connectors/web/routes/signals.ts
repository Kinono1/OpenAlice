import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { EngineContext } from "../../../core/types.js";
import { isAuthEnabled } from "../../../core/auth.js";
import { runSidecarSignalPaperIntake } from "../../../runtime/sidecar_signal.js";

export function createSignalRoutes(opts: {
  ctx: EngineContext;
  requireTrade: MiddlewareHandler;
}) {
  const app = new Hono();

  app.use("/intake", opts.requireTrade);

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      mode: "paper_only",
      service: "sidecar_signal_intake",
    });
  });

  app.get("/readiness", (c) => {
    const cryptoEngineConnected = !!opts.ctx.getCryptoEngine?.();
    const authEnforced = opts.ctx.config.auth.enforceAuth;
    const authConfigured = isAuthEnabled();
    const devBypass = process.env.DEV_AUTH_BYPASS === "true";
    const authReady = !authEnforced || authConfigured || devBypass;
    const reasons: string[] = [];
    if (!cryptoEngineConnected) {
      reasons.push("crypto_engine_unavailable");
    }
    if (!authReady) {
      reasons.push("auth_tokens_missing");
    }

    const ready = cryptoEngineConnected && authReady;

    return c.json({
      ready,
      cryptoEngineConnected,
      supportedSymbols: opts.ctx.config.engine.pairs,
      authEnforced,
      authConfigured,
      mode: "paper_only",
      reasons,
    }, ready ? 200 : 503);
  });

  app.post("/intake", async (c) => {
    const engine = opts.ctx.getCryptoEngine?.();
    if (!engine) {
      return c.json(
        {
          error: "Crypto engine not connected",
          ready: false,
          mode: "paper_only",
        },
        503,
      );
    }

    const payload = await c.req.json();
    const result = await runSidecarSignalPaperIntake({
      signal: payload,
      engine,
      eventLog: opts.ctx.eventLog,
      supportedSymbols: opts.ctx.config.engine.pairs,
    });

    return c.json(result, result.accepted ? 200 : 400);
  });

  return app;
}
