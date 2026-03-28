import { ProxyAgent } from "undici";

const PROXY_ENV_KEYS = [
  "OPENALICE_HTTP_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

function cleanProxyUrl(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isLocalAddress(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".local")
  );
}

function parseTargetUrl(input: RequestInfo | URL): URL | null {
  try {
    if (input instanceof URL) {
      return input;
    }
    if (typeof input === "string") {
      return new URL(input);
    }
    if (typeof Request !== "undefined" && input instanceof Request) {
      return new URL(input.url);
    }
  } catch {
    return null;
  }
  return null;
}

function shouldBypassProxy(input: RequestInfo | URL): boolean {
  const url = parseTargetUrl(input);
  if (!url) return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  return isLocalAddress(url.hostname);
}

let originalFetch: typeof fetch | null = null;
let installedProxyUrl: string | null = null;
let proxyAgent: ProxyAgent | null = null;

export function resolveOutboundProxyUrl(): string | null {
  for (const key of PROXY_ENV_KEYS) {
    const value = cleanProxyUrl(process.env[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

export function configureGlobalNetworkProxy(): string | null {
  const proxyUrl = resolveOutboundProxyUrl();
  if (!proxyUrl) {
    return null;
  }

  if (installedProxyUrl === proxyUrl && originalFetch) {
    return proxyUrl;
  }

  if (!originalFetch) {
    originalFetch = globalThis.fetch.bind(globalThis);
  }
  if (!proxyAgent || installedProxyUrl !== proxyUrl) {
    proxyAgent = new ProxyAgent(proxyUrl);
  }

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!originalFetch) {
      throw new Error("Global fetch proxy not initialized.");
    }
    if (shouldBypassProxy(input)) {
      return originalFetch(input, init);
    }
    const normalizedInit = init ? { ...init } : {};
    return originalFetch(input, {
      ...normalizedInit,
      dispatcher: proxyAgent!,
    } as RequestInit & { dispatcher: ProxyAgent });
  }) as typeof fetch;

  installedProxyUrl = proxyUrl;
  return proxyUrl;
}
