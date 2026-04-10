import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TradeIdempotencyStore } from './idempotency-store.js'

describe('TradeIdempotencyStore', () => {
  it('reserves key once and rejects duplicates until finalized/expired', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'idempotency-store-'))
    const filePath = join(tempDir, 'store.json')
    const store = new TradeIdempotencyStore(filePath, 60_000)

    const first = await store.reserve({
      key: 'k1',
      symbol: 'BTC/USD',
      ticketId: 't1',
    })
    const second = await store.reserve({
      key: 'k1',
      symbol: 'BTC/USD',
      ticketId: 't1',
    })

    expect(first.acquired).toBe(true)
    expect(second.acquired).toBe(false)
    expect(second.record.status).toBe('in_progress')

    await store.finalize({
      key: 'k1',
      status: 'succeeded',
      orderId: 'order-1',
    })
    const after = await store.get('k1')
    expect(after?.status).toBe('succeeded')
    expect(after?.orderId).toBe('order-1')
  })

  it('expires records and allows reserve again after ttl', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'idempotency-store-expire-'))
    const filePath = join(tempDir, 'store.json')
    const ttlMs = 20
    const store = new TradeIdempotencyStore(filePath, ttlMs)

    const now = Date.now()
    const first = await store.reserve({ key: 'k-expire', nowMs: now })
    expect(first.acquired).toBe(true)

    const removed = await store.cleanup(now + ttlMs + 5)
    expect(removed).toBe(1)

    const second = await store.reserve({
      key: 'k-expire',
      nowMs: now + ttlMs + 10,
    })
    expect(second.acquired).toBe(true)
  })

  it('allows controlled retry for previously failed key', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'idempotency-store-retry-'))
    const filePath = join(tempDir, 'store.json')
    const store = new TradeIdempotencyStore(filePath, 60_000)

    const first = await store.reserve({ key: 'k-retry' })
    expect(first.acquired).toBe(true)
    await store.finalize({
      key: 'k-retry',
      status: 'failed',
      error: 'exchange timeout',
    })

    const blocked = await store.reserve({ key: 'k-retry' })
    expect(blocked.acquired).toBe(false)

    const retried = await store.reserve({
      key: 'k-retry',
      allowRetryOnFailed: true,
    })
    expect(retried.acquired).toBe(true)
    expect(retried.retriedFromFailed).toBe(true)
    expect(retried.record.status).toBe('in_progress')
  })
})

