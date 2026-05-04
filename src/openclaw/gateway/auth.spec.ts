import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeGatewayConnect, isLocalDirectRequest, resolveGatewayAuth } from "./auth.js";

function makeRequest(params: {
  remoteAddr: string;
  host?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  return {
    headers: {
      host: params.host ?? "localhost",
      ...params.headers,
    },
    socket: {
      remoteAddress: params.remoteAddr,
    },
  } as IncomingMessage;
}

describe("gateway auth proxy trust", () => {
  it("rejects spoofed loopback forwarding from untrusted remotes", () => {
    const req = makeRequest({
      remoteAddr: "198.51.100.10",
      headers: {
        "x-forwarded-for": "127.0.0.1",
      },
    });

    expect(isLocalDirectRequest(req, ["10.0.0.0/8"])).toBe(false);
  });

  it("accepts forwarded loopback identity from trusted proxies", () => {
    const req = makeRequest({
      remoteAddr: "10.0.0.5",
      headers: {
        "x-forwarded-for": "127.0.0.1",
      },
    });

    expect(isLocalDirectRequest(req, ["10.0.0.0/8"])).toBe(true);
  });

  it("rejects trusted-proxy auth from untrusted remotes", async () => {
    const auth = resolveGatewayAuth({
      authConfig: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
        },
      },
    });

    const result = await authorizeGatewayConnect({
      auth,
      req: makeRequest({
        remoteAddr: "198.51.100.10",
        headers: {
          "x-forwarded-user": "alice@example.com",
          "x-forwarded-proto": "https",
        },
      }),
      trustedProxies: ["10.0.0.0/8"],
    });

    expect(result).toMatchObject({ ok: false, reason: "trusted_proxy_untrusted_source" });
  });

  it("requires configured proxy headers before trusting forwarded user identity", async () => {
    const auth = resolveGatewayAuth({
      authConfig: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
        },
      },
    });

    const result = await authorizeGatewayConnect({
      auth,
      req: makeRequest({
        remoteAddr: "10.0.0.5",
        headers: {
          "x-forwarded-user": "alice@example.com",
          "x-forwarded-proto": "https",
        },
      }),
      trustedProxies: ["10.0.0.0/8"],
    });

    expect(result).toMatchObject({ ok: false, reason: "trusted_proxy_missing_header_x-forwarded-host" });
  });

  it("accepts allowed users from configured trusted proxies", async () => {
    const auth = resolveGatewayAuth({
      authConfig: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          allowUsers: ["alice@example.com"],
        },
      },
    });

    const result = await authorizeGatewayConnect({
      auth,
      req: makeRequest({
        remoteAddr: "10.0.0.5",
        headers: {
          "x-forwarded-user": "alice@example.com",
          "x-forwarded-proto": "https",
        },
      }),
      trustedProxies: ["10.0.0.0/8"],
    });

    expect(result).toMatchObject({
      ok: true,
      method: "trusted-proxy",
      user: "alice@example.com",
    });
  });

  it("rate limits failed auth by socket ip when forwarding headers are untrusted", async () => {
    const limiter = createAuthRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
      exemptLoopback: false,
    });

    try {
      const auth = resolveGatewayAuth({
        authConfig: {
          token: "expected-token",
          allowTailscale: false,
        },
      });

      const first = await authorizeGatewayConnect({
        auth,
        connectAuth: { token: "wrong-token" },
        req: makeRequest({
          remoteAddr: "198.51.100.10",
          headers: {
            "x-forwarded-for": "1.1.1.1",
          },
        }),
        trustedProxies: ["10.0.0.0/8"],
        rateLimiter: limiter,
      });

      const second = await authorizeGatewayConnect({
        auth,
        connectAuth: { token: "wrong-token" },
        req: makeRequest({
          remoteAddr: "198.51.100.10",
          headers: {
            "x-forwarded-for": "2.2.2.2",
          },
        }),
        trustedProxies: ["10.0.0.0/8"],
        rateLimiter: limiter,
      });

      expect(first).toMatchObject({ ok: false, reason: "token_mismatch" });
      expect(second).toMatchObject({ ok: false, reason: "rate_limited", rateLimited: true });
    } finally {
      limiter.dispose();
    }
  });

  it("uses forwarded client ip buckets when the proxy is trusted", async () => {
    const limiter = createAuthRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
      exemptLoopback: false,
    });

    try {
      const auth = resolveGatewayAuth({
        authConfig: {
          token: "expected-token",
          allowTailscale: false,
        },
      });

      const first = await authorizeGatewayConnect({
        auth,
        connectAuth: { token: "wrong-token" },
        req: makeRequest({
          remoteAddr: "10.0.0.5",
          headers: {
            "x-forwarded-for": "1.1.1.1",
          },
        }),
        trustedProxies: ["10.0.0.0/8"],
        rateLimiter: limiter,
      });

      const second = await authorizeGatewayConnect({
        auth,
        connectAuth: { token: "wrong-token" },
        req: makeRequest({
          remoteAddr: "10.0.0.5",
          headers: {
            "x-forwarded-for": "2.2.2.2",
          },
        }),
        trustedProxies: ["10.0.0.0/8"],
        rateLimiter: limiter,
      });

      const third = await authorizeGatewayConnect({
        auth,
        connectAuth: { token: "wrong-token" },
        req: makeRequest({
          remoteAddr: "10.0.0.5",
          headers: {
            "x-forwarded-for": "1.1.1.1",
          },
        }),
        trustedProxies: ["10.0.0.0/8"],
        rateLimiter: limiter,
      });

      expect(first).toMatchObject({ ok: false, reason: "token_mismatch" });
      expect(second).toMatchObject({ ok: false, reason: "token_mismatch" });
      expect(third).toMatchObject({ ok: false, reason: "rate_limited", rateLimited: true });
    } finally {
      limiter.dispose();
    }
  });
});
