import { describe, it, expect, beforeEach } from 'vitest'
import {
  createTrustedContext,
  runWithContext,
  getContextId,
  getContextRef,
  resolveContext,
  removeContext,
  getContextStoreSize,
  _resetContextStoreForTest,
} from './trusted-context.js'

describe('TrustedRequestContext', () => {
  beforeEach(() => {
    _resetContextStoreForTest()
  })

  it('creates a context with all required fields', () => {
    const ctx = createTrustedContext({
      channel: 'web',
      sessionId: 'sess-1',
      actor: 'web-default',
    })
    expect(ctx.contextId).toBeTruthy()
    expect(ctx.requestId).toBeTruthy()
    expect(ctx.channel).toBe('web')
    expect(ctx.sessionId).toBe('sess-1')
    expect(ctx.actor).toBe('web-default')
    expect(ctx.timestamp).toBeGreaterThan(0)
  })

  it('context is frozen (immutable)', () => {
    const ctx = createTrustedContext({
      channel: 'web',
      sessionId: 'sess-1',
      actor: 'web-default',
    })
    expect(() => { (ctx as any).channel = 'hacked' }).toThrow()
  })

  it('getContextId returns undefined outside runWithContext', () => {
    expect(getContextId()).toBeUndefined()
  })

  it('getContextId returns contextId inside runWithContext', () => {
    const ctx = createTrustedContext({
      channel: 'telegram',
      sessionId: 'sess-2',
      actor: 'user-123',
    })
    runWithContext(ctx, () => {
      expect(getContextId()).toBe(ctx.contextId)
    })
  })

  it('getContextRef returns ContextRef inside runWithContext', () => {
    const ctx = createTrustedContext({
      channel: 'web',
      sessionId: 'sess-3',
      actor: 'web-default',
    })
    runWithContext(ctx, () => {
      const ref = getContextRef()
      expect(ref).toBeDefined()
      expect(ref!.contextId).toBe(ctx.contextId)
      // ref should NOT have channel, actor, etc.
      expect((ref as any).channel).toBeUndefined()
      expect((ref as any).actor).toBeUndefined()
    })
  })

  it('resolveContext returns full context from contextId', () => {
    const ctx = createTrustedContext({
      channel: 'mcp-ask',
      sessionId: 'sess-4',
      actor: 'external-agent',
      ip: '127.0.0.1',
    })
    const resolved = resolveContext(ctx.contextId)
    expect(resolved).toBe(ctx) // same frozen object
    expect(resolved?.ip).toBe('127.0.0.1')
  })

  it('resolveContext returns undefined for unknown contextId', () => {
    expect(resolveContext('nonexistent')).toBeUndefined()
  })

  it('removeContext cleans up', () => {
    const ctx = createTrustedContext({
      channel: 'web',
      sessionId: 'sess-5',
      actor: 'web-default',
    })
    expect(getContextStoreSize()).toBe(1)
    expect(removeContext(ctx.contextId)).toBe(true)
    expect(getContextStoreSize()).toBe(0)
    expect(resolveContext(ctx.contextId)).toBeUndefined()
  })
})
