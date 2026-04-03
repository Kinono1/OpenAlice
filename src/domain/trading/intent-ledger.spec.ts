import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IntentLedger, intentFlushStats } from './intent-ledger.js'

describe('IntentLedger', () => {
  it('records intents and results durably', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'intent-ledger-'))
    const filePath = join(tempDir, 'ledger.jsonl')
    const ledger = new IntentLedger(filePath)

    await ledger.init()
    IntentLedger._resetFlushStats()

    await ledger.recordIntent({
      intentId: 'intent-1',
      ticketId: 'ticket-1',
      symbol: 'BTC/USD',
      action: 'placeOrder',
      side: 'buy',
      type: 'market',
      createdAt: Date.now(),
    })

    await ledger.recordResult({
      intentId: 'intent-1',
      status: 'success',
      orderId: 'order-1',
      completedAt: Date.now(),
    })

    const entries = await ledger.readAll()
    expect(entries).toHaveLength(2)
    expect(entries[0].type).toBe('intent')
    expect(entries[1].type).toBe('result')
    expect(intentFlushStats.intentFsyncs).toBe(1)
    expect(intentFlushStats.resultFsyncs).toBe(1)

    await ledger.close()
  })
})

