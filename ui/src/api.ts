// API client — all fetch calls to the backend.
// In dev mode, Vite proxies /api to the backend.
// In production, same-origin.

export interface ChatMessage {
  role: "user" | "assistant" | "notification";
  text: string;
  timestamp?: number | null;
}

export interface ChatResponse {
  text: string;
  media: Array<{ type: "image"; url: string }>;
}

export interface AppConfig {
  aiProvider: string;
  engine: Record<string, unknown>;
  model: { provider: string; model: string };
  agent: { evolutionMode: boolean; claudeCode: Record<string, unknown> };
  compaction: { maxContextTokens: number; maxOutputTokens: number };
  heartbeat: { enabled: boolean; every: string; prompt: string };
  [key: string]: unknown;
}

// ==================== Event Log Types ====================

export interface EventLogEntry {
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
}

// ==================== Cron Types ====================

export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; every: string }
  | { kind: "cron"; cron: string };

export interface CronJobState {
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastStatus: "ok" | "error" | null;
  consecutiveErrors: number;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  payload: string;
  state: CronJobState;
  createdAt: number;
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const AUTH_TOKEN_STORAGE_KEY = "openalice.auth_token";
const AUTH_QUERY_KEYS = ["token", "auth_token", "authToken"] as const;

function persistAuthToken(raw: string): string | null {
  const token = raw.trim();
  if (!token) return null;
  if (typeof window === "undefined") return token;
  try {
    window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
  } catch {
    // localStorage may be unavailable in private mode; fall back to runtime token only.
  }
  let cookie = `alice_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
  if (window.location.protocol === "https:") {
    cookie += "; Secure";
  }
  document.cookie = cookie;
  return token;
}

function stripAuthTokenFromLocation(url: URL): void {
  if (typeof window === "undefined") return;
  let changed = false;
  for (const key of AUTH_QUERY_KEYS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return;
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(window.history.state ?? null, "", nextUrl);
}

function readAuthToken(): string | null {
  if (typeof window === "undefined") return null;

  const current = new URL(window.location.href);
  for (const key of AUTH_QUERY_KEYS) {
    const candidate = current.searchParams.get(key);
    if (!candidate) continue;
    const persisted = persistAuthToken(candidate);
    stripAuthTokenFromLocation(current);
    if (persisted) return persisted;
  }

  try {
    const stored = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    if (!stored) return null;
    return persistAuthToken(stored);
  } catch {
    return null;
  }
}

function authHeaders(extra?: HeadersInit): Headers {
  const merged = new Headers(extra ?? {});
  const token = readAuthToken();
  if (token) {
    merged.set("Authorization", `Bearer ${token}`);
  }
  return merged;
}

function withAuthQuery(rawUrl: string): string {
  const token = readAuthToken();
  if (!token || typeof window === "undefined") {
    return rawUrl;
  }
  const url = new URL(rawUrl, window.location.origin);
  if (!url.searchParams.has("token")) {
    url.searchParams.set("token", token);
  }
  if (url.origin === window.location.origin) {
    return `${url.pathname}${url.search}${url.hash}`;
  }
  return url.toString();
}

export const api = {
  chat: {
    async send(message: string): Promise<ChatResponse> {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: authHeaders(JSON_HEADERS),
        body: JSON.stringify({ message }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }
      const data = (await res.json()) as ChatResponse;
      return {
        ...data,
        media: Array.isArray(data.media)
          ? data.media.map(item => {
              if (item.type !== "image") return item;
              return { ...item, url: withAuthQuery(item.url) };
            })
          : [],
      };
    },

    async history(limit = 100): Promise<{ messages: ChatMessage[] }> {
      const res = await fetch(`/api/chat/history?limit=${limit}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to load history");
      return res.json();
    },

    connectSSE(
      onMessage: (data: { type: string; text: string }) => void
    ): EventSource {
      const es = new EventSource(withAuthQuery("/api/chat/events"));
      es.onmessage = event => {
        try {
          const data = JSON.parse(event.data);
          onMessage(data);
        } catch {
          /* ignore */
        }
      };
      return es;
    },
  },

  config: {
    async load(): Promise<AppConfig> {
      const res = await fetch("/api/config", {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to load config");
      return res.json();
    },

    async setProvider(provider: string): Promise<void> {
      const res = await fetch("/api/config/ai-provider", {
        method: "PUT",
        headers: authHeaders(JSON_HEADERS),
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) throw new Error("Failed to switch provider");
    },

    async updateSection(section: string, data: unknown): Promise<unknown> {
      const res = await fetch(`/api/config/${section}`, {
        method: "PUT",
        headers: authHeaders(JSON_HEADERS),
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Save failed" }));
        throw new Error(err.error || "Save failed");
      }
      return res.json();
    },
  },

  events: {
    async recent(
      opts: { afterSeq?: number; limit?: number; type?: string } = {}
    ): Promise<{ entries: EventLogEntry[]; lastSeq: number }> {
      const params = new URLSearchParams();
      if (opts.afterSeq) params.set("afterSeq", String(opts.afterSeq));
      if (opts.limit) params.set("limit", String(opts.limit));
      if (opts.type) params.set("type", opts.type);
      const qs = params.toString();
      const res = await fetch(`/api/events/recent${qs ? `?${qs}` : ""}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to load events");
      return res.json();
    },

    connectSSE(onEvent: (entry: EventLogEntry) => void): EventSource {
      const es = new EventSource(withAuthQuery("/api/events/stream"));
      es.onmessage = event => {
        try {
          const entry = JSON.parse(event.data);
          onEvent(entry);
        } catch {
          /* ignore */
        }
      };
      return es;
    },
  },

  cron: {
    async list(): Promise<{ jobs: CronJob[] }> {
      const res = await fetch("/api/cron/jobs", {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to load cron jobs");
      return res.json();
    },

    async add(params: {
      name: string;
      payload: string;
      schedule: CronSchedule;
      enabled?: boolean;
    }): Promise<{ id: string }> {
      const res = await fetch("/api/cron/jobs", {
        method: "POST",
        headers: authHeaders(JSON_HEADERS),
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Create failed" }));
        throw new Error(err.error || "Create failed");
      }
      return res.json();
    },

    async update(
      id: string,
      patch: Partial<{
        name: string;
        payload: string;
        schedule: CronSchedule;
        enabled: boolean;
      }>
    ): Promise<void> {
      const res = await fetch(`/api/cron/jobs/${id}`, {
        method: "PUT",
        headers: authHeaders(JSON_HEADERS),
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Update failed" }));
        throw new Error(err.error || "Update failed");
      }
    },

    async remove(id: string): Promise<void> {
      const res = await fetch(`/api/cron/jobs/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Delete failed" }));
        throw new Error(err.error || "Delete failed");
      }
    },

    async runNow(id: string): Promise<void> {
      const res = await fetch(`/api/cron/jobs/${id}/run`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Run failed" }));
        throw new Error(err.error || "Run failed");
      }
    },
  },

  heartbeat: {
    async status(): Promise<{ enabled: boolean }> {
      const res = await fetch("/api/heartbeat/status", {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to get heartbeat status");
      return res.json();
    },

    async trigger(): Promise<void> {
      const res = await fetch("/api/heartbeat/trigger", {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Trigger failed" }));
        throw new Error(err.error || "Trigger failed");
      }
    },

    async setEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
      const res = await fetch("/api/heartbeat/enabled", {
        method: "PUT",
        headers: authHeaders(JSON_HEADERS),
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Update failed" }));
        throw new Error(err.error || "Update failed");
      }
      return res.json();
    },
  },
};
