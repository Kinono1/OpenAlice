import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
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

  it('keeps an unresolved sidecar command across TTL cleanup and blocks retry', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'idempotency-store-unresolved-'))
    const store = new TradeIdempotencyStore(join(tempDir, 'store.json'), 20)
    const now = Date.now()
    await store.reserve({ key: 'k-unresolved', nowMs: now })
    await store.markUnresolved({
      key: 'k-unresolved',
      error: 'broker_outcome_pending',
      commandId: '1'.repeat(64),
      permitV2Id: '2'.repeat(64),
      acceptedSequence: '1',
      clientOrderId: `OA${'A'.repeat(30)}`,
      nowMs: now + 1,
    })

    await expect(store.cleanup(now + 60_000)).resolves.toBe(0)
    await expect(store.get('k-unresolved')).resolves.toEqual(expect.objectContaining({
      status: 'unresolved',
      commandId: '1'.repeat(64),
    }))
    await expect(store.reserve({
      key: 'k-unresolved',
      allowRetryOnFailed: true,
      nowMs: now + 60_001,
    })).resolves.toEqual(expect.objectContaining({
      acquired: false,
      record: expect.objectContaining({ status: 'unresolved' }),
    }))
  })

  it('forbids generic finalization of unresolved sidecar state', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'idempotency-store-unresolved-finalize-'))
    const store = new TradeIdempotencyStore(join(tempDir, 'store.json'), 60_000)
    await store.reserve({ key: 'k-protected' })
    await store.markUnresolved({
      key: 'k-protected',
      error: 'broker_outcome_pending',
      commandId: '3'.repeat(64),
      acceptedSequence: '1',
    })

    await expect(store.finalize({
      key: 'k-protected',
      status: 'failed',
      error: 'forged_terminal',
    })).rejects.toThrow('idempotency_unresolved_requires_verified_sidecar_terminal')
    await expect(store.get('k-protected')).resolves.toEqual(expect.objectContaining({
      status: 'unresolved',
      error: 'broker_outcome_pending',
    }))
    await expect(store.reserve({
      key: 'k-protected',
      allowRetryOnFailed: true,
    })).resolves.toEqual(expect.objectContaining({ acquired: false }))
    expect('finalizeFromSidecarTerminal' in store).toBe(false)
  })

  it('makes a generic terminal record idempotent but immutable', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'idempotency-store-terminal-immutable-'))
    const store = new TradeIdempotencyStore(join(tempDir, 'store.json'), 60_000)
    await store.reserve({ key: 'k-native-terminal' })
    await store.finalize({
      key: 'k-native-terminal', status: 'succeeded', orderId: 'order-1',
    })
    await expect(store.finalize({
      key: 'k-native-terminal', status: 'succeeded', orderId: 'order-1',
    })).resolves.toBeUndefined()
    await expect(store.finalize({
      key: 'k-native-terminal', status: 'failed', error: 'overwrite',
    })).rejects.toThrow('idempotency_terminal_record_immutable')
    await expect(store.get('k-native-terminal')).resolves.toEqual(expect.objectContaining({
      status: 'succeeded', orderId: 'order-1',
    }))
  })

  it('reopens a securely-written crash-durable snapshot without losing unresolved state', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'idempotency-store-durable-'))
    const filePath = join(tempDir, 'store.json')
    const first = new TradeIdempotencyStore(filePath, 60_000)
    await first.reserve({ key: 'k-durable' })
    await first.markUnresolved({
      key: 'k-durable',
      error: 'broker_outcome_pending',
      commandId: '4'.repeat(64),
      acceptedSequence: '2',
    })

    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    const reopened = new TradeIdempotencyStore(filePath, 60_000)
    await expect(reopened.get('k-durable')).resolves.toEqual(expect.objectContaining({
      status: 'unresolved', commandId: '4'.repeat(64), acceptedSequence: '2',
    }))
  })

  it('fails closed on malformed or tampered persisted snapshots after reopen', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'idempotency-store-corruption-'))
    const filePath = join(tempDir, 'store.json')
    const store = new TradeIdempotencyStore(filePath, 60_000)
    await store.reserve({ key: 'k-tamper', nowMs: 100 })

    const valid = JSON.parse(await readFile(filePath, 'utf-8')) as {
      records: Record<string, Record<string, unknown>>
    }
    const cases: readonly [string, unknown][] = [
      ['invalid top-level shape', { records: {}, unexpected: true }],
      ['record key mismatch', {
        records: { 'k-tamper': { ...valid.records['k-tamper'], key: 'other-key' } },
      }],
      ['unknown record field', {
        records: { 'k-tamper': { ...valid.records['k-tamper'], verifiedBrokerTerminal: true } },
      }],
      ['unresolved terminal combination', {
        records: {
          'k-tamper': {
            ...valid.records['k-tamper'], status: 'unresolved', error: 'pending', orderId: 'forged',
          },
        },
      }],
      ['terminal sidecar identifiers', {
        records: {
          'k-tamper': {
            ...valid.records['k-tamper'], status: 'succeeded', commandId: 'a'.repeat(64),
          },
        },
      }],
      ['non-finite timestamp', JSON.stringify({
        records: { 'k-tamper': { ...valid.records['k-tamper'], createdAt: 100 } },
      }).replace('"createdAt":100', '"createdAt":1e999')],
      ['malformed JSON', '{'],
    ]

    for (const [_label, tampered] of cases) {
      await writeFile(filePath, typeof tampered === 'string' ? tampered : JSON.stringify(tampered), 'utf-8')
      const reopened = new TradeIdempotencyStore(filePath, 60_000)
      await expect(reopened.get('k-tamper')).rejects.toThrow('idempotency_snapshot_corruption')
    }
  })

  it('keeps a legacy generic terminal as generic and rejects a forged sidecar-terminal upgrade', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'idempotency-store-legacy-terminal-'))
    const filePath = join(tempDir, 'store.json')
    const now = Date.now()
    const legacy = {
      records: {
        'k-legacy': {
          key: 'k-legacy',
          status: 'succeeded',
          createdAt: now,
          updatedAt: now + 1,
          expiresAt: now + 60_000,
          orderId: 'legacy-order',
        },
      },
    }
    await writeFile(filePath, JSON.stringify(legacy), 'utf-8')

    const reopened = new TradeIdempotencyStore(filePath, 60_000)
    await expect(reopened.get('k-legacy')).resolves.toEqual(expect.objectContaining({
      status: 'succeeded', orderId: 'legacy-order',
    }))

    await writeFile(filePath, JSON.stringify({
      records: {
        'k-legacy': { ...legacy.records['k-legacy'], commandId: 'b'.repeat(64) },
      },
    }), 'utf-8')
    await expect(new TradeIdempotencyStore(filePath).get('k-legacy'))
      .rejects.toThrow('idempotency_snapshot_corruption')
  })
})
