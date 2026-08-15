import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

// ==================== Types ====================

/** Runtime + compile-time brand to prevent forgery */
const TRUSTED_BRAND: unique symbol = Symbol('TRUSTED_BRAND')
// NOT exported — keeping the symbol module-private prevents tool-layer code
// from crafting objects that satisfy TrustedRequestContext at the type level.

export interface TrustedRequestContext {
  readonly [TRUSTED_BRAND]: true
  readonly contextId: string      // opaque UUID token
  readonly requestId: string      // per-request UUID
  readonly channel: string        // 'web' | 'telegram' | 'mcp-ask' | 'cron' | 'heartbeat'
  readonly sessionId: string      // session identifier
  readonly actor: string          // user identifier (telegram userId, 'web-default', etc.)
  readonly ip?: string            // client IP if available
  readonly timestamp: number      // Date.now() at creation
}

/** What tool-layer code can see — only the opaque contextId */
export interface ContextRef {
  readonly contextId: string
}

/** Metadata for operations — no raw actor/channel */
export interface OperationMeta {
  contextId: string
  decisionTicketId?: string
}

// ==================== Storage ====================

const als = new AsyncLocalStorage<TrustedRequestContext>()
const contextStore = new Map<string, TrustedRequestContext>()

/** Cleanup interval handle — allows disposal to prevent zombie timers under hot-reload. */
let _cleanupTimer: ReturnType<typeof setInterval> | null = null

// Periodic TTL cleanup for leaked contexts (those not removed via removeContext)
const CONTEXT_TTL_MS = 30 * 60 * 1000 // 30 minutes
_cleanupTimer = setInterval(() => {
  const now = Date.now()
  const staleKeys: string[] = []
  contextStore.forEach((ctx, id) => {
    if (now - ctx.timestamp > CONTEXT_TTL_MS) {
      staleKeys.push(id)
    }
  })
  for (const key of staleKeys) {
    contextStore.delete(key)
  }
  if (staleKeys.length > 0) {
    console.warn(`[trusted-context] TTL cleanup removed ${staleKeys.length} stale contexts (remaining: ${contextStore.size})`)
  }
}, 5 * 60 * 1000) // Every 5 minutes

/**
 * Dispose the module — clears the cleanup timer and all stored contexts.
 * Call during graceful shutdown to prevent zombie timers.
 */
export function dispose(): void {
  if (_cleanupTimer) {
    clearInterval(_cleanupTimer)
    _cleanupTimer = null
  }
  contextStore.clear()
}

// ==================== Creation (connector/engine layer only) ====================

export interface CreateContextParams {
  channel: string
  sessionId: string
  actor: string
  ip?: string
}

/**
 * Create a TrustedRequestContext. Only connector/engine layer should call this.
 * The brand property makes it impossible for tool code to construct this type
 * without calling this function.
 */
export function createTrustedContext(params: CreateContextParams): TrustedRequestContext {
  const ctx: TrustedRequestContext = Object.freeze({
    [TRUSTED_BRAND]: true as const,
    contextId: randomUUID(),
    requestId: randomUUID(),
    channel: params.channel,
    sessionId: params.sessionId,
    actor: params.actor,
    ip: params.ip,
    timestamp: Date.now(),
  })
  contextStore.set(ctx.contextId, ctx)
  return ctx
}

// ==================== ALS Run ====================

/**
 * Run a function within a trusted context. The context is available
 * via getContextId() inside the callback.
 */
export function runWithContext<T>(ctx: TrustedRequestContext, fn: () => T): T {
  return als.run(ctx, () => {
    try {
      return fn()
    } finally {
      removeContext(ctx.contextId)
    }
  })
}

/**
 * Async version for middleware use.
 */
export function runWithContextAsync<T>(ctx: TrustedRequestContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, async () => {
    try {
      return await fn()
    } finally {
      removeContext(ctx.contextId)
    }
  })
}

// ==================== Tool-layer access (safe) ====================

/**
 * Get the current context ID (opaque reference).
 * This is the ONLY thing tool-layer code should use.
 */
export function getContextId(): string | undefined {
  return als.getStore()?.contextId
}

/**
 * Get a safe ContextRef (just the contextId).
 */
export function getContextRef(): ContextRef | undefined {
  const id = getContextId()
  return id ? { contextId: id } : undefined
}

// ==================== Trusted-code access ====================

/**
 * Resolve a contextId back to the full TrustedRequestContext.
 * Only dispatcher/event-log/audit code should use this.
 */
export function resolveContext(contextId: string): TrustedRequestContext | undefined {
  return contextStore.get(contextId)
}

// ==================== Cleanup ====================

/**
 * Remove a context from the store (call after request completes).
 * Prevents memory leak from accumulating contexts.
 */
export function removeContext(contextId: string): boolean {
  return contextStore.delete(contextId)
}

/**
 * Get store size (for monitoring/tests).
 */
export function getContextStoreSize(): number {
  return contextStore.size
}

// ==================== Test helpers ====================

/** Clear all stored contexts. For tests only. */
export function _resetContextStoreForTest(): void {
  contextStore.clear()
}
