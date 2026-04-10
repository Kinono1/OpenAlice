/**
 * Snapshot store — chunked JSONL persistence with index.
 *
 * Storage layout:
 *   data/trading/{accountId}/snapshots/
 *   ├── index.json
 *   ├── chunk-0001.jsonl
 *   ├── chunk-0002.jsonl
 *   └── ...
 *
 * Each chunk holds up to CHUNK_SIZE snapshots (one JSON line each).
 * The index tracks chunk metadata for efficient time-range queries.
 *
 * Writes are serialized via a Promise chain to prevent concurrent
 * appends from corrupting the index.
 */

import { readFile, writeFile, appendFile, rename, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { UTASnapshot, SnapshotIndex } from './types.js'

const CHUNK_SIZE = 50
const DEFAULT_BASE_DIR = 'data/trading'

export interface SnapshotStoreOptions {
  baseDir?: string
}

export interface SnapshotStore {
  append(snapshot: UTASnapshot): Promise<void>
  readRange(opts?: { startTime?: string; endTime?: string; limit?: number }): Promise<UTASnapshot[]>
}

export function createSnapshotStore(accountId: string, options?: SnapshotStoreOptions): SnapshotStore {
  const dir = resolve(options?.baseDir ?? DEFAULT_BASE_DIR, accountId, 'snapshots')
  const indexPath = resolve(dir, 'index.json')

  // Serialize writes to prevent concurrent append from corrupting the index
  let writeChain = Promise.resolve()

  async function readIndex(): Promise<SnapshotIndex> {
    try {
      const raw = await readFile(indexPath, 'utf-8')
      return JSON.parse(raw) as SnapshotIndex
    } catch {
      return { version: 1, chunks: [] }
    }
  }

  async function saveIndex(index: SnapshotIndex): Promise<void> {
    await mkdir(dir, { recursive: true })
    const tmp = `${indexPath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(index, null, 2), 'utf-8')
    await rename(tmp, indexPath)
  }

  function chunkName(n: number): string {
    return `chunk-${String(n).padStart(4, '0')}.jsonl`
  }

  async function doAppend(snapshot: UTASnapshot): Promise<void> {
    const index = await readIndex()
    const last = index.chunks[index.chunks.length - 1]

    let chunkFile: string
    if (!last || last.count >= CHUNK_SIZE) {
      const nextNum = index.chunks.length + 1
      chunkFile = chunkName(nextNum)
      index.chunks.push({
        file: chunkFile,
        count: 1,
        startTime: snapshot.timestamp,
        endTime: snapshot.timestamp,
      })
    } else {
      chunkFile = last.file
      last.count += 1
      last.endTime = snapshot.timestamp
    }

    await mkdir(dir, { recursive: true })
    await appendFile(resolve(dir, chunkFile), JSON.stringify(snapshot) + '\n', 'utf-8')
    await saveIndex(index)
  }

  return {
    append(snapshot) {
      const p = writeChain.then(() => doAppend(snapshot))
      // Always advance chain even on error, so next write isn't blocked
      writeChain = p.catch(() => {})
      return p
    },

    async readRange(opts) {
      const index = await readIndex()
      const { startTime, endTime, limit } = opts ?? {}
      const results: UTASnapshot[] = []

      // Walk chunks in reverse (newest first)
      for (let i = index.chunks.length - 1; i >= 0; i--) {
        const chunk = index.chunks[i]

        // Skip chunks outside time range
        if (startTime && chunk.endTime < startTime) continue
        if (endTime && chunk.startTime > endTime) continue

        const raw = await readFile(resolve(dir, chunk.file), 'utf-8')
        const lines = raw.trim().split('\n').filter(Boolean)

        // Parse in reverse (newest first within chunk)
        for (let j = lines.length - 1; j >= 0; j--) {
          const snap = JSON.parse(lines[j]) as UTASnapshot
          if (startTime && snap.timestamp < startTime) continue
          if (endTime && snap.timestamp > endTime) continue
          results.push(snap)
          if (limit && results.length >= limit) return results
        }
      }

      return results
    },
  }
}
