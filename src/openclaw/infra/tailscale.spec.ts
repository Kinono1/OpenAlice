import { afterEach, describe, expect, it } from "vitest";
import {
  ALLOW_TAILSCALE_FUNNEL_ENV,
  assertTailscaleFunnelAllowed,
  validateTailscaleFunnelPort,
} from "./tailscale.js";

describe("Tailscale Funnel exposure guard", () => {
  afterEach(() => {
    delete process.env[ALLOW_TAILSCALE_FUNNEL_ENV];
  });

  it("rejects invalid ports before invoking tailscale", () => {
    expect(() => validateTailscaleFunnelPort(0)).toThrow(/Invalid Tailscale Funnel port/);
    expect(() => validateTailscaleFunnelPort(65536)).toThrow(/Invalid Tailscale Funnel port/);
    expect(() => validateTailscaleFunnelPort(3000.5)).toThrow(/Invalid Tailscale Funnel port/);
    expect(() => validateTailscaleFunnelPort(3000)).not.toThrow();
  });

  it("requires explicit opt-in before exposing a local port", () => {
    expect(() => assertTailscaleFunnelAllowed(3000)).toThrow(
      /without explicit opt-in/,
    );

    process.env[ALLOW_TAILSCALE_FUNNEL_ENV] = "1";

    expect(() => assertTailscaleFunnelAllowed(3000)).not.toThrow();
  });
});
