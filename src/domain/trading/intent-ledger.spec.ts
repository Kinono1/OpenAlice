import { appendFile, mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  IntentLedger,
  INTENT_LEDGER_CORRUPTION_ERROR,
  INTENT_LEDGER_VALIDATION_ERROR,
  intentFlushStats,
} from './intent-ledger.js'

describe('IntentLedger', () => {
  it('records intents and results durably', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'intent-ledger-'))
    const filePath = join(tempDir, 'ledger.jsonl')
    const ledger = new IntentLedger(filePath)

    await ledger.init()
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
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

  it('tolerates only a truncated final non-newline JSON fragment during recovery', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'intent-ledger-malformed-'))
    const filePath = join(tempDir, 'ledger.jsonl')
    const ledger = new IntentLedger(filePath)

    await ledger.init()
    await ledger.recordIntent({
      intentId: 'intent-2',
      ticketId: 'ticket-2',
      symbol: 'ETH/USD',
      action: 'placeOrder',
      side: 'sell',
      type: 'market',
      createdAt: Date.now(),
    })
    await appendFile(filePath, '{"type":"result","data":', 'utf-8')

    const entries = await ledger.readAll()
    expect(entries).toHaveLength(1)
    expect(entries[0].type).toBe('intent')
    await ledger.close()

    const tornStringPath = join(tempDir, 'torn-string.jsonl')
    await appendFile(tornStringPath, '{"type":"result","data":{"intentId":"torn', 'utf-8')
    await expect(new IntentLedger(tornStringPath).readAll()).resolves.toEqual([])
  })

  it('fails closed for a malformed complete JSONL line', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'intent-ledger-corrupt-complete-'))
    const filePath = join(tempDir, 'ledger.jsonl')
    const ledger = new IntentLedger(filePath)

    await appendFile(filePath, '{"type":"intent","data":\n', 'utf-8')

    await expect(ledger.readAll()).rejects.toThrow(INTENT_LEDGER_CORRUPTION_ERROR)
  })

  it('fails closed for malformed final non-newline content that is not a JSON prefix', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'intent-ledger-corrupt-tail-'))
    const filePath = join(tempDir, 'ledger.jsonl')
    const ledger = new IntentLedger(filePath)

    await appendFile(filePath, '{"type":!not-json', 'utf-8')

    await expect(ledger.readAll()).rejects.toThrow(INTENT_LEDGER_CORRUPTION_ERROR)
  })

  it('fails closed for a malformed JSONL line before a valid later line', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'intent-ledger-corrupt-middle-'))
    const filePath = join(tempDir, 'ledger.jsonl')
    const ledger = new IntentLedger(filePath)
    const validResult = JSON.stringify({
      type: 'result',
      data: { intentId: 'intent-3', status: 'success', completedAt: Date.now() },
    })

    await appendFile(filePath, `{"type":"intent","data":\n${validResult}\n`, 'utf-8')

    await expect(ledger.readAll()).rejects.toThrow(INTENT_LEDGER_CORRUPTION_ERROR)
  })

  it('rejects invalid records before appending them', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'intent-ledger-validation-'))
    const filePath = join(tempDir, 'ledger.jsonl')
    const ledger = new IntentLedger(filePath)
    await ledger.init()

    await expect(ledger.recordIntent({
      intentId: 'intent-invalid',
      ticketId: 'ticket-invalid',
      symbol: 'BTC/USD',
      action: 'placeOrder',
      side: 'buy',
      type: 'market',
      createdAt: Number.NaN,
    })).rejects.toThrow(INTENT_LEDGER_VALIDATION_ERROR)
    await expect(ledger.recordResult({
      intentId: 'intent-invalid',
      status: 'success',
      completedAt: Date.now(),
      brokerWriteRoute: 'sidecar',
      commandId: '',
    })).rejects.toThrow(INTENT_LEDGER_VALIDATION_ERROR)
    await expect(ledger.readAll()).resolves.toEqual([])

    await ledger.recordResult({
      intentId: 'intent-sidecar',
      status: 'unknown',
      completedAt: Date.now(),
      brokerWriteRoute: 'sidecar',
      brokerWriteOutcome: 'command_accepted',
      commandId: '1'.repeat(64),
      permitV2Id: '2'.repeat(64),
      acceptedSequence: '1',
      clientOrderId: 'client-1',
    })
    await expect(ledger.readAll()).resolves.toEqual([
      expect.objectContaining({
        type: 'result',
        data: expect.objectContaining({ commandId: '1'.repeat(64) }),
      }),
    ])

    await ledger.close()
  })
})
