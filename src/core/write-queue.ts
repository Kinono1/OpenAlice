/**
 * Write Queue — durable append-only file writer with fdatasync.
 * Ensures every write is flushed to disk before returning.
 * Provides observable flush counters for test verification.
 */

import { open, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { FileHandle } from 'node:fs/promises'

// ==================== Flush Stats (test-observable) ====================

export const flushStats = {
  intentFsyncs: 0,
  fillFsyncs: 0,
  eventFlushes: 0,
  sessionFlushes: 0,
}

export function resetFlushStats(): void {
  flushStats.intentFsyncs = 0
  flushStats.fillFsyncs = 0
  flushStats.eventFlushes = 0
  flushStats.sessionFlushes = 0
}

// ==================== DurableWriter ====================

export type FlushCategory = 'intent' | 'fill' | 'event' | 'session'

/**
 * A durable file writer that appends JSONL lines and calls fdatasync after each write.
 */
export class DurableWriter {
  private fd: FileHandle | null = null
  private filePath: string
  private category: FlushCategory

  constructor(filePath: string, category: FlushCategory) {
    this.filePath = filePath
    this.category = category
  }

  /** Open the file for appending. Must be called before write(). */
  async open(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    this.fd = await open(this.filePath, 'a')
  }

  /** Append a JSON object as a line, then fdatasync. */
  async write(data: unknown): Promise<void> {
    if (!this.fd) throw new Error(`DurableWriter not opened: ${this.filePath}`)
    const line = JSON.stringify(data) + '\n'
    await this.fd.write(line)
    await this.fd.datasync()
    this.incrementFlushStat()
  }

  /** Append raw string, then fdatasync. */
  async writeRaw(line: string): Promise<void> {
    if (!this.fd) throw new Error(`DurableWriter not opened: ${this.filePath}`)
    const data = line.endsWith('\n') ? line : line + '\n'
    await this.fd.write(data)
    await this.fd.datasync()
    this.incrementFlushStat()
  }

  /** Sync without writing (flush pending OS buffers). */
  async sync(): Promise<void> {
    if (this.fd) {
      await this.fd.datasync()
    }
  }

  /** Close the file handle. Syncs before closing. */
  async close(): Promise<void> {
    if (this.fd) {
      await this.fd.datasync()
      await this.fd.close()
      this.fd = null
    }
  }

  /** Check if the writer is open. */
  isOpen(): boolean {
    return this.fd !== null
  }

  private incrementFlushStat(): void {
    switch (this.category) {
      case 'intent':
        flushStats.intentFsyncs++
        break
      case 'fill':
        flushStats.fillFsyncs++
        break
      case 'event':
        flushStats.eventFlushes++
        break
      case 'session':
        flushStats.sessionFlushes++
        break
    }
  }
}
