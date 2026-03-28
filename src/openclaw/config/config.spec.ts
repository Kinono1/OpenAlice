import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearConfigCache,
  createConfigIO,
  loadConfig,
  resolveConfigPath,
  writeConfigFile,
} from "./config.js";

describe("openclaw config io", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-config-spec-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;
    delete process.env.OPENCLAW_CONFIG_PATH;
    clearConfigCache();
  });

  afterEach(() => {
    clearConfigCache();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    if (originalConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns standalone defaults when no config file exists", () => {
    const cfg = loadConfig({ fresh: true });
    expect(cfg.gateway?.nodes?.browser?.mode).toBe("off");
  });

  it("writes config to the resolved config path and reloads it", async () => {
    await writeConfigFile({
      browser: {
        defaultProfile: "qa",
      },
    } as any);

    const configPath = resolveConfigPath(process.env, tempDir);
    const raw = readFileSync(configPath, "utf-8");
    expect(JSON.parse(raw).browser.defaultProfile).toBe("qa");

    clearConfigCache();
    const reloaded = loadConfig({ fresh: true });
    expect(reloaded.browser.defaultProfile).toBe("qa");
  });

  it("supports fresh reloads after external file edits", async () => {
    await writeConfigFile({
      browser: {
        defaultProfile: "alpha",
      },
    } as any);

    expect(loadConfig().browser.defaultProfile).toBe("alpha");

    const configPath = resolveConfigPath(process.env, tempDir);
    writeFileSync(
      configPath,
      "{\n  // json5 comment is supported\n  browser: { defaultProfile: 'beta' }\n}\n",
      "utf-8",
    );
    const future = new Date(Date.now() + 2000);
    utimesSync(configPath, future, future);

    expect(createConfigIO().loadConfig().browser.defaultProfile).toBe("beta");
    expect(loadConfig().browser.defaultProfile).toBe("beta");
  });
});
