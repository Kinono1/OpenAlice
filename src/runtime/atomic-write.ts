import { writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Atomic JSON write: tmp + fsync via writeFileSync + rename.
 * Prevents partial writes from corrupting runtime files.
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  const json = JSON.stringify(data, null, 2)
  writeFileSync(tmp, json, { encoding: 'utf-8', flush: true })
  renameSync(tmp, path)
}
