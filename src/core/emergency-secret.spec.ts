import { describe, expect, it } from "vitest";
import { resolveEmergencySecret } from "./emergency-secret.js";

describe("resolveEmergencySecret", () => {
  it("prefers ALICE_EMERGENCY_SECRET when both are set", () => {
    const secret = resolveEmergencySecret({
      ALICE_EMERGENCY_SECRET: "alice-secret",
      EMERGENCY_SECRET: "legacy-secret",
    });

    expect(secret).toBe("alice-secret");
  });

  it("falls back to EMERGENCY_SECRET when ALICE_EMERGENCY_SECRET is absent", () => {
    const secret = resolveEmergencySecret({
      EMERGENCY_SECRET: "legacy-secret",
    });

    expect(secret).toBe("legacy-secret");
  });

  it("returns undefined when neither secret is configured", () => {
    const secret = resolveEmergencySecret({});
    expect(secret).toBeUndefined();
  });
});
