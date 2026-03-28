/**
 * Lightweight OpenClaw config barrel + JSON/JSON5-backed config IO.
 *
 * This repo does not vend the full upstream config pipeline, but callers in
 * `openclaw/browser` and `openclaw/gateway` still need real persistence.
 * Keep this file small, but make read/write behavior match operator
 * expectations: edits must survive process restarts and hot reloads.
 */

export {
  resolveGatewayPort,
  resolveConfigPath,
  STATE_DIR,
  resolveStateDir,
  resolveOAuthDir,
} from "./paths.js";

export {
  deriveDefaultBrowserCdpPortRange,
  deriveDefaultBrowserControlPort,
  DEFAULT_BROWSER_CONTROL_PORT,
} from "./port-defaults.js";

export type { OpenClawConfig } from "./types.js";
export type { BrowserConfig, BrowserProfileConfig } from "./types.browser.js";
export type {
  GatewayAuthConfig,
  GatewayAuthMode,
  GatewayAuthRateLimitConfig,
  GatewayBindMode,
  GatewayTailscaleConfig,
  GatewayTailscaleMode,
  GatewayTlsConfig,
  GatewayTrustedProxyConfig,
} from "./types.gateway.js";

import json5 from "json5";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveConfigPath, resolveStateDir } from "./paths.js";
import type { OpenClawConfig } from "./types.js";

type LoadConfigOptions = {
  fresh?: boolean;
  env?: NodeJS.ProcessEnv;
};

type CacheEntry = {
  configPath: string;
  mtimeMs: number | null;
  config: OpenClawConfig;
};

let cachedConfig: CacheEntry | null = null;

function standaloneConfig(): OpenClawConfig {
  return {
    gateway: { nodes: { browser: { mode: "off" } } },
  } as OpenClawConfig;
}

function resolveActiveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveConfigPath(env, resolveStateDir(env));
}

function readConfigMtimeMs(configPath: string): number | null {
  try {
    return existsSync(configPath) ? statSync(configPath).mtimeMs : null;
  } catch {
    return null;
  }
}

function readConfigFile(configPath: string): OpenClawConfig {
  if (!existsSync(configPath)) {
    return standaloneConfig();
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = json5.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as OpenClawConfig;
    }
  } catch {
    // Fall through to standalone mode.
  }

  return standaloneConfig();
}

function updateCache(configPath: string, config: OpenClawConfig): OpenClawConfig {
  cachedConfig = {
    configPath,
    mtimeMs: readConfigMtimeMs(configPath),
    config,
  };
  return config;
}

function canUseCachedConfig(configPath: string): boolean {
  if (!cachedConfig) {
    return false;
  }
  if (cachedConfig.configPath !== configPath) {
    return false;
  }
  return cachedConfig.mtimeMs === readConfigMtimeMs(configPath);
}

export function clearConfigCache(): void {
  cachedConfig = null;
}

export function loadConfig(options: LoadConfigOptions = {}): OpenClawConfig {
  const configPath = resolveActiveConfigPath(options.env ?? process.env);
  if (!options.fresh && canUseCachedConfig(configPath)) {
    return cachedConfig!.config;
  }
  return updateCache(configPath, readConfigFile(configPath));
}

export async function writeConfigFile(
  config: OpenClawConfig,
  options: LoadConfigOptions = {},
): Promise<void> {
  const configPath = resolveActiveConfigPath(options.env ?? process.env);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  updateCache(configPath, config);
}

export function createConfigIO(options: LoadConfigOptions = {}) {
  const loadFresh = () => loadConfig({ ...options, fresh: true });
  return {
    load: loadFresh,
    loadConfig: loadFresh,
    save: (config: OpenClawConfig) => writeConfigFile(config, options),
  };
}
