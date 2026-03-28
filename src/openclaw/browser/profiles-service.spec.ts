import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBrowserConfig } from "./config.js";
import { createBrowserProfilesService } from "./profiles-service.js";
import type { BrowserServerState } from "./server-context.types.js";
import { clearConfigCache, loadConfig, writeConfigFile } from "../config/config.js";

describe("browser profiles service persistence", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-profiles-spec-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;
    clearConfigCache();
    await writeConfigFile({ browser: {} } as any);
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

  it("creates and deletes a remote profile in persisted config", async () => {
    const cfg = loadConfig({ fresh: true });
    const state: BrowserServerState = {
      port: 18791,
      resolved: resolveBrowserConfig(cfg.browser, cfg),
      profiles: new Map(),
    };

    const ctx = {
      state: () => state,
      listProfiles: async () => [],
      forProfile: () => ({
        stopRunningBrowser: async () => ({ stopped: false }),
      }),
    } as any;

    const service = createBrowserProfilesService(ctx);
    const created = await service.createProfile({
      name: "remote-qa",
      cdpUrl: "http://remote.example:9222",
    });

    expect(created.ok).toBe(true);
    expect(created.profile).toBe("remote-qa");
    expect(created.isRemote).toBe(true);

    clearConfigCache();
    let persisted = loadConfig({ fresh: true });
    expect(persisted.browser.profiles["remote-qa"].cdpUrl).toBe("http://remote.example:9222");

    const deleted = await service.deleteProfile("remote-qa");
    expect(deleted.ok).toBe(true);

    clearConfigCache();
    persisted = loadConfig({ fresh: true });
    expect(persisted.browser.profiles["remote-qa"]).toBeUndefined();
  });
});
