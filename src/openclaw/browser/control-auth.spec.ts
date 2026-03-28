import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearConfigCache, loadConfig } from "../config/config.js";
import { ensureBrowserControlAuth } from "./control-auth.js";

describe("browser control auth persistence", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-browser-auth-spec-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;
    clearConfigCache();
  });

  afterEach(() => {
    clearConfigCache();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("persists an auto-generated token to config", async () => {
    const cfg = loadConfig({ fresh: true });
    const result = await ensureBrowserControlAuth({
      cfg,
      env: {
        ...process.env,
        NODE_ENV: "development",
        VITEST: "0",
      },
    });

    expect(result.generatedToken).toMatch(/^[a-f0-9]{48}$/);
    expect(result.auth.token).toBe(result.generatedToken);

    clearConfigCache();
    const persisted = loadConfig({ fresh: true });
    expect(persisted.gateway.auth.mode).toBe("token");
    expect(persisted.gateway.auth.token).toBe(result.generatedToken);
  });
});
