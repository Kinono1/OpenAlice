/**
 * Minimal paper trading account I/O helpers.
 *
 * Extracted from shared patterns in:
 * - scripts/paper_trade_volume_breakout.ts  (loadAccount / saveAccount)
 * - scripts/paper_trade_microstructure_stress.ts  (loadAccount / saveAccount / normalizeAccount)
 * - scripts/paper_trade_cross_sectional.ts  (loadAccount / saveAccount)
 *
 * Each script retains its own Account type and only reuses the file I/O operations.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'

/**
 * Read and parse a JSON account file. Returns null if the file does not exist
 * or cannot be parsed.
 */
export function readAccount<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/**
 * Write an account object as atomic JSON (no temp file; uses writeJsonAtomic if available,
 * otherwise direct writeFile).
 */
export async function writeAccountAtomic<T>(filePath: string, account: T): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(account, null, 2)}\n`, 'utf-8')
}

/**
 * Ensure the directory for a file path exists.
 */
export async function ensureAccountDir(filePath: string): Promise<void> {
  const dir = filePath.split('/').slice(0, -1).join('/')
  if (dir) {
    await mkdir(dir, { recursive: true })
  }
}

/**
 * Create a minimal default account structure.
 * Override initialEquity for non-standard defaults.
 */
export function createDefaultAccount(initialEquity = 100_000): {
  equity: number
  initialEquity: number
  positions: unknown[]
  tradeHistory: unknown[]
} {
  return {
    equity: initialEquity,
    initialEquity,
    positions: [],
    tradeHistory: [],
  }
}
