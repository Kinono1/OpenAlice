import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolve } from 'node:path'
import { readFile, rm } from 'node:fs/promises'
import { DurableWriter, flushStats, resetFlushStats } from './write-queue.js'

const TEST_DIR = resolve('data/test-write-queue')
const TEST_FILE = resolve(TEST_DIR, 'test.jsonl')

describe('DurableWriter', () => {
  let writer: DurableWriter

  beforeEach(async () => {
    resetFlushStats()
    await rm(TEST_DIR, { recursive: true, force: true })
  })

  afterEach(async () => {
    if (writer?.isOpen()) await writer.close()
    await rm(TEST_DIR, { recursive: true, force: true })
  })

  it('writes JSON lines with fdatasync', async () => {
    writer = new DurableWriter(TEST_FILE, 'event')
    await writer.open()

    const prevCount = flushStats.eventFlushes
    await writer.write({ type: 'test', value: 1 })
    expect(flushStats.eventFlushes).toBe(prevCount + 1)

    await writer.write({ type: 'test', value: 2 })
    expect(flushStats.eventFlushes).toBe(prevCount + 2)

    await writer.close()

    const content = await readFile(TEST_FILE, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual({ type: 'test', value: 1 })
    expect(JSON.parse(lines[1])).toEqual({ type: 'test', value: 2 })
  })

  it('increments intent flush stats', async () => {
    writer = new DurableWriter(TEST_FILE, 'intent')
    await writer.open()

    expect(flushStats.intentFsyncs).toBe(0)
    await writer.write({ intent: true })
    expect(flushStats.intentFsyncs).toBe(1)
  })

  it('increments fill flush stats', async () => {
    writer = new DurableWriter(TEST_FILE, 'fill')
    await writer.open()

    expect(flushStats.fillFsyncs).toBe(0)
    await writer.write({ fill: true })
    expect(flushStats.fillFsyncs).toBe(1)
  })

  it('throws if not opened', async () => {
    writer = new DurableWriter(TEST_FILE, 'event')
    await expect(writer.write({ test: true })).rejects.toThrow('not opened')
  })

  it('creates parent directories', async () => {
    const deepPath = resolve(TEST_DIR, 'deep/nested/test.jsonl')
    writer = new DurableWriter(deepPath, 'session')
    await writer.open()
    await writer.write({ nested: true })
    expect(flushStats.sessionFlushes).toBe(1)
  })

  it('resetFlushStats clears all counters', async () => {
    writer = new DurableWriter(TEST_FILE, 'event')
    await writer.open()
    await writer.write({ test: true })
    expect(flushStats.eventFlushes).toBe(1)
    resetFlushStats()
    expect(flushStats.eventFlushes).toBe(0)
    expect(flushStats.intentFsyncs).toBe(0)
    expect(flushStats.fillFsyncs).toBe(0)
    expect(flushStats.sessionFlushes).toBe(0)
  })
})
