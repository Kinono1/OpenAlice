import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadManualOverride,
  normalizeManualOverride,
  canonicalizeManualOverride,
  signManualOverridePayload,
  verifyManualOverrideSignature,
  listSetHighRiskFields,
  DEFAULT_MANUAL_OVERRIDE,
  MANUAL_OVERRIDE_TTL_MAX_MS,
} from "./manual_override.js";
import type { SignedManualOverride } from "./manual_override.js";

/** Build a valid unsigned shell for testing. */
function buildValidUnsigned(
  overrides: Partial<SignedManualOverride> = {},
): SignedManualOverride {
  const now = new Date("2026-06-01T12:00:00.000Z");
  const expires = new Date(now.getTime() + 1800_000); // +30min
  return {
    pauseNewOpens: true,
    reason: "test override",
    issuedBy: "tester",
    issuedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    signature: "",
    ...overrides,
  } as SignedManualOverride;
}

const TEST_SECRET = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

describe("manual_override", () => {
  it("returns default config when override file is missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "manual-override-"));
    const file = join(tempDir, "missing.json");
    const value = await loadManualOverride({ filePath: file });
    expect(value).toEqual(DEFAULT_MANUAL_OVERRIDE);
  });

  it("normalizes typed fields from a loose payload", () => {
    const normalized = normalizeManualOverride({
      pauseNewOpens: 1,
      ignoreReleaseGate: 1,
      ignoreRegimeShift: 0,
      forceCapitalRampStage: " 25% ",
      forceVolatilityQuantile: 0.9,
      forceDailyLossPct: -4,
      forceCvarDailyLossPct: -2.8,
      forceConsecutiveLossDays: 2.7,
      forceConsecutiveLossPct: -3.2,
      note: " test ",
      updatedAt: "2026-02-22T00:00:00.000Z",
    });

    expect(normalized).toEqual({
      pauseNewOpens: true,
      ignoreReleaseGate: true,
      ignoreRegimeShift: false,
      forceCapitalRampStage: "25%",
      forceVolatilityQuantile: 0.9,
      forceDailyLossPct: -4,
      forceCvarDailyLossPct: -2.8,
      forceConsecutiveLossDays: 2,
      forceConsecutiveLossPct: -3.2,
      note: "test",
      updatedAt: "2026-02-22T00:00:00.000Z",
    });
  });

  it("returns default when file has no signature (old-format JSON rejected by schema)", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "manual-override-load-"));
    const file = join(tempDir, "manual_override.json");
    await writeFile(
      file,
      JSON.stringify({
        pauseNewOpens: true,
        ignoreReleaseGate: true,
        forceCapitalRampStage: "10%",
      }),
      "utf-8",
    );
    const loaded = await loadManualOverride({
      filePath: file,
      env: { ALICE_MANUAL_OVERRIDE_SECRET: TEST_SECRET },
      now: new Date("2026-06-01T12:00:00.000Z"),
    });
    // Schema requires reason/issuedBy/issuedAt/expiresAt/signature — missing → default
    expect(loaded).toEqual(DEFAULT_MANUAL_OVERRIDE);
  });

  it("loads valid signed override from disk", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "manual-override-load-valid-"));
    const file = join(tempDir, "manual_override.json");

    const unsigned = buildValidUnsigned();
    const signature = signManualOverridePayload(TEST_SECRET, unsigned);
    const signed = { ...unsigned, signature };

    await writeFile(file, JSON.stringify(signed), "utf-8");

    const loaded = await loadManualOverride({
      filePath: file,
      env: { ALICE_MANUAL_OVERRIDE_SECRET: TEST_SECRET },
      now: new Date("2026-06-01T12:00:00.000Z"),
    });
    expect(loaded.pauseNewOpens).toBe(true);
  });
});

describe("canonicalizeManualOverride", () => {
  it("excludes signature and sorts keys", () => {
    const input = buildValidUnsigned();
    const result = canonicalizeManualOverride(input);
    const parsed = JSON.parse(result);
    expect(parsed.signature).toBeUndefined();
    expect(Object.keys(parsed)).toEqual(Object.keys(parsed).sort());
  });

  it("deduplicates and sorts approvedBy", () => {
    const input = buildValidUnsigned({ approvedBy: ["z", "a", "z"] });
    const result = canonicalizeManualOverride(input);
    const parsed = JSON.parse(result);
    expect(parsed.approvedBy).toEqual(["a", "z"]);
  });

  it("re-emits dates as canonical ISO strings", () => {
    const input = buildValidUnsigned({
      issuedAt: "2026-06-01T12:00:00.000Z",
      expiresAt: "2026-06-01T12:30:00.000Z",
    });
    const result = canonicalizeManualOverride(input);
    const parsed = JSON.parse(result);
    expect(parsed.issuedAt).toBe("2026-06-01T12:00:00.000Z");
    expect(parsed.expiresAt).toBe("2026-06-01T12:30:00.000Z");
  });
});

describe("signManualOverridePayload / verifyManualOverrideSignature", () => {
  it("sign and verify roundtrip", () => {
    const input = buildValidUnsigned();
    const sig = signManualOverridePayload(TEST_SECRET, input);
    const signed = { ...input, signature: sig };
    expect(verifyManualOverrideSignature(TEST_SECRET, signed)).toBe(true);
  });

  it("rejects wrong secret", () => {
    const input = buildValidUnsigned();
    const sig = signManualOverridePayload(TEST_SECRET, input);
    const signed = { ...input, signature: sig };
    expect(
      verifyManualOverrideSignature("wrong-secret-that-is-long-enough-for-hmac", signed),
    ).toBe(false);
  });

  it("rejects empty signature", () => {
    const input = buildValidUnsigned();
    expect(verifyManualOverrideSignature(TEST_SECRET, input)).toBe(false);
  });

  it("rejects if signature is not valid hex", () => {
    const input = buildValidUnsigned({ signature: "zzz-not-hex" });
    expect(verifyManualOverrideSignature(TEST_SECRET, input)).toBe(false);
  });
});

describe("listSetHighRiskFields", () => {
  it("detects high-risk fields", () => {
    const input = buildValidUnsigned({
      forceDailyLossPct: 5,
      ignoreReleaseGate: true,
    });
    const fields = listSetHighRiskFields(input);
    expect(fields).toContain("forceDailyLossPct");
    expect(fields).toContain("ignoreReleaseGate");
  });

  it("ignores low-risk fields", () => {
    const input = buildValidUnsigned();
    const fields = listSetHighRiskFields(input);
    // pauseNewOpens is not in HIGH_RISK_FIELDS
    expect(fields).not.toContain("pauseNewOpens");
  });

  it("treats false boolean as not set", () => {
    const input = buildValidUnsigned({
      ignoreReleaseGate: false,
      ignoreRegimeShift: false,
    });
    const fields = listSetHighRiskFields(input);
    expect(fields).not.toContain("ignoreReleaseGate");
    expect(fields).not.toContain("ignoreRegimeShift");
  });
});

describe("loadManualOverride validation chain", () => {
  const NOW = new Date("2026-06-01T12:00:00.000Z");

  it("ENOENT → default, no event", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "mo-enoent-"));
    const value = await loadManualOverride({
      filePath: join(tempDir, "nonexistent.json"),
    });
    expect(value).toEqual(DEFAULT_MANUAL_OVERRIDE);
  });

  it("expired override → default", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "mo-expired-"));
    const file = join(tempDir, "mo.json");
    // expires 1h before NOW
    const unsigned = buildValidUnsigned({
      issuedAt: new Date(NOW.getTime() - 7200_000).toISOString(),
      expiresAt: new Date(NOW.getTime() - 3600_000).toISOString(),
    });
    const sig = signManualOverridePayload(TEST_SECRET, unsigned);
    await writeFile(file, JSON.stringify({ ...unsigned, signature: sig }), "utf-8");

    const loaded = await loadManualOverride({
      filePath: file,
      env: { ALICE_MANUAL_OVERRIDE_SECRET: TEST_SECRET },
      now: NOW,
    });
    expect(loaded).toEqual(DEFAULT_MANUAL_OVERRIDE);
  });

  it("TTL exceeded → default", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "mo-ttl-"));
    const file = join(tempDir, "mo.json");
    // TTL = 2h > 1h limit
    const unsigned = buildValidUnsigned({
      issuedAt: new Date(NOW.getTime()).toISOString(),
      expiresAt: new Date(NOW.getTime() + MANUAL_OVERRIDE_TTL_MAX_MS + 3600_000).toISOString(),
    });
    const sig = signManualOverridePayload(TEST_SECRET, unsigned);
    await writeFile(file, JSON.stringify({ ...unsigned, signature: sig }), "utf-8");

    const loaded = await loadManualOverride({
      filePath: file,
      env: { ALICE_MANUAL_OVERRIDE_SECRET: TEST_SECRET },
      now: NOW,
    });
    expect(loaded).toEqual(DEFAULT_MANUAL_OVERRIDE);
  });

  it("missing secret with valid override file → default", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "mo-nosecret-"));
    const file = join(tempDir, "mo.json");
    const unsigned = buildValidUnsigned();
    const sig = signManualOverridePayload(TEST_SECRET, unsigned);
    await writeFile(file, JSON.stringify({ ...unsigned, signature: sig }), "utf-8");

    const loaded = await loadManualOverride({
      filePath: file,
      // no ALICE_MANUAL_OVERRIDE_SECRET set
      env: {},
      now: NOW,
    });
    expect(loaded).toEqual(DEFAULT_MANUAL_OVERRIDE);
  });

  it("bad signature → default", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "mo-badsig-"));
    const file = join(tempDir, "mo.json");
    const unsigned = buildValidUnsigned();
    // Use a different secret to sign
    const sig = signManualOverridePayload("some-other-secret-that-is-long-enough-32b", unsigned);
    await writeFile(file, JSON.stringify({ ...unsigned, signature: sig }), "utf-8");

    const loaded = await loadManualOverride({
      filePath: file,
      env: { ALICE_MANUAL_OVERRIDE_SECRET: TEST_SECRET },
      now: NOW,
    });
    expect(loaded).toEqual(DEFAULT_MANUAL_OVERRIDE);
  });

  it("high-risk fields without approvedBy → default", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "mo-nomultisig-"));
    const file = join(tempDir, "mo.json");
    // forceDailyLossPct triggers HIGH_RISK
    const unsigned = buildValidUnsigned({
      forceDailyLossPct: 5,
    });
    const sig = signManualOverridePayload(TEST_SECRET, unsigned);
    await writeFile(file, JSON.stringify({ ...unsigned, signature: sig }), "utf-8");

    const loaded = await loadManualOverride({
      filePath: file,
      env: { ALICE_MANUAL_OVERRIDE_SECRET: TEST_SECRET },
      now: NOW,
    });
    expect(loaded).toEqual(DEFAULT_MANUAL_OVERRIDE);
  });

  it("high-risk fields with approvedBy.length=1 (deduped) → default", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "mo-dup-"));
    const file = join(tempDir, "mo.json");
    const unsigned = buildValidUnsigned({
      forceDailyLossPct: 5,
      approvedBy: ["alice", "alice"], // deduped to 1
    });
    const sig = signManualOverridePayload(TEST_SECRET, unsigned);
    await writeFile(file, JSON.stringify({ ...unsigned, signature: sig }), "utf-8");

    const loaded = await loadManualOverride({
      filePath: file,
      env: { ALICE_MANUAL_OVERRIDE_SECRET: TEST_SECRET },
      now: NOW,
    });
    expect(loaded).toEqual(DEFAULT_MANUAL_OVERRIDE);
  });

  it("all valid → returns override (low-risk fields only)", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "mo-valid-low-"));
    const file = join(tempDir, "mo.json");
    const unsigned = buildValidUnsigned({
      // no HIGH_RISK fields set
      pauseNewOpens: true,
    });
    const sig = signManualOverridePayload(TEST_SECRET, unsigned);
    await writeFile(file, JSON.stringify({ ...unsigned, signature: sig }), "utf-8");

    const loaded = await loadManualOverride({
      filePath: file,
      env: { ALICE_MANUAL_OVERRIDE_SECRET: TEST_SECRET },
      now: NOW,
    });
    expect(loaded.pauseNewOpens).toBe(true);
  });

  it("high-risk fields with approvedBy=2 → applied", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "mo-valid-high-"));
    const file = join(tempDir, "mo.json");
    const unsigned = buildValidUnsigned({
      forceDailyLossPct: 5,
      approvedBy: ["alice", "bob"],
    });
    const sig = signManualOverridePayload(TEST_SECRET, unsigned);
    await writeFile(file, JSON.stringify({ ...unsigned, signature: sig }), "utf-8");

    const loaded = await loadManualOverride({
      filePath: file,
      env: { ALICE_MANUAL_OVERRIDE_SECRET: TEST_SECRET },
      now: NOW,
    });
    expect(loaded.forceDailyLossPct).toBe(5);
    expect(loaded.pauseNewOpens).toBe(true);
  });
});