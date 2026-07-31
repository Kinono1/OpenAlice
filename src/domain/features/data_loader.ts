/**
 * Data loader helpers for Binance CSV data.
 *
 * Handles:
 * - PKZIP-compressed CSV files (Binance's native format)
 * - Gzip-compressed CSV files (alternative format)
 * - Lists available monthly files on disk
 *
 * Binance CSV columns (spot klines):
 *   Open time,Open,High,Low,Close,Volume,Close time,
 *   Quote asset volume,Number of trades,Taker buy base asset volume,
 *   Taker buy quote asset volume,Ignore
 */

import { createReadStream, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import { createInterface } from 'node:readline'
import { join, extname } from 'node:path'

// ─── Types ────────────────────────────────────────────────────────────────

export interface Bar {
  timestamp: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface FundingPoint {
  timestamp: string
  rate: number
}

// ─── ZIP Parsing (PKZIP format, no dependencies) ─────────────────────────

/** Minimal single-file PKZIP extractor. Handles deflated and stored entries. */
function extractFirstFileFromZip(zipBuffer: Buffer): Buffer {
  // Locate local file header signature: PK\x03\x04
  const SIG = 0x04034b50
  let offset = 0

  while (offset < zipBuffer.length - 30) {
    const sig = zipBuffer.readUInt32LE(offset)
    if (sig !== SIG) {
      offset++
      continue
    }

    const compressionMethod = zipBuffer.readUInt16LE(offset + 8)
    const compressedSize = zipBuffer.readUInt32LE(offset + 18)
    const uncompressedSize = zipBuffer.readUInt32LE(offset + 22)
    const fileNameLength = zipBuffer.readUInt16LE(offset + 26)
    const extraFieldLength = zipBuffer.readUInt16LE(offset + 28)
    const dataStart = offset + 30 + fileNameLength + extraFieldLength

    if (dataStart + compressedSize > zipBuffer.length) {
      offset++
      continue
    }

    const rawData = zipBuffer.subarray(dataStart, dataStart + compressedSize)

    if (compressionMethod === 0) {
      // Stored (no compression)
      return rawData
    }
    if (compressionMethod === 8) {
      // Deflated — use Node.js zlib
      const { inflateRawSync } = require('node:zlib')
      return inflateRawSync(rawData)
    }

    throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`)
  }

  throw new Error('No valid ZIP local file entry found')
}

/**
 * Detect if a file starts with a ZIP local file header.
 * PKZIP files start with PK\x03\x04.
 */
function isZipBuffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50
}

// ─── CSV Parsing ──────────────────────────────────────────────────────────

function parseKlineCsv(text: string): Bar[] {
  const results: Bar[] = []
  const lines = text.split(/\r?\n/)

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const cols = line.split(',')
    if (cols.length < 6) continue

    const openTimeMs = parseInt(cols[0], 10)
    const open = parseFloat(cols[1])
    const high = parseFloat(cols[2])
    const low = parseFloat(cols[3])
    const close = parseFloat(cols[4])
    const volume = parseFloat(cols[5])

    if (!isNaN(openTimeMs) && !isNaN(open) && !isNaN(high) && !isNaN(low) && !isNaN(close) && !isNaN(volume)) {
      results.push({
        timestamp: new Date(openTimeMs).toISOString(),
        open,
        high,
        low,
        close,
        volume,
      })
    }
  }

  return results
}

function parseFundingRateCsv(text: string): FundingPoint[] {
  const results: FundingPoint[] = []
  const lines = text.split(/\r?\n/)

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const cols = line.split(',')
    if (cols.length < 2) continue

    const tsMs = parseInt(cols[0], 10)
    const rate = parseFloat(cols[1])

    if (!isNaN(tsMs) && !isNaN(rate)) {
      results.push({
        timestamp: new Date(tsMs).toISOString(),
        rate,
      })
    }
  }

  return results
}

// ─── Streaming CSV parser (for gzip / plain CSV files) ───────────────────

async function readStreamToString(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase()
  const rawStream = createReadStream(filePath)

  let stream
  if (ext === '.gz') {
    stream = rawStream.pipe(createGunzip())
  } else {
    stream = rawStream
  }

  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  const lines: string[] = []
  for await (const line of reader) {
    lines.push(line)
  }
  return lines.join('\n')
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Load a Binance ZIP CSV file containing OHLCV kline data.
 *
 * @param zipPath    Absolute path to the ZIP file (e.g. "BTCUSDT-1m-2024-01.zip")
 * @param timeframe  Timeframe string (e.g. "1h", "1m"), currently used for metadata
 * @returns Sorted array of Bar objects (by timestamp ascending)
 */
export async function loadBinanceZipCsv(zipPath: string, _timeframe: string): Promise<Bar[]> {
  let buffer: Buffer
  let csvText: string

  try {
    buffer = readFileSync(zipPath)
  } catch (err) {
    throw new Error(`Failed to read file: ${zipPath} — ${(err as Error).message}`)
  }

  if (isZipBuffer(buffer)) {
    // PKZIP format
    const csvBuffer = extractFirstFileFromZip(buffer)
    csvText = csvBuffer.toString('utf-8')
  } else {
    // Plain CSV or gzip — use streaming
    csvText = await readStreamToString(zipPath)
  }

  const bars = parseKlineCsv(csvText)
  // Sort by timestamp ascending
  bars.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  return bars
}

/**
 * Load a Binance ZIP CSV file containing funding rate data.
 *
 * @param zipPath  Absolute path to the ZIP file
 * @returns Sorted array of FundingPoint objects
 */
export async function loadFundingRateZip(zipPath: string): Promise<FundingPoint[]> {
  let buffer: Buffer
  let csvText: string

  try {
    buffer = readFileSync(zipPath)
  } catch (err) {
    throw new Error(`Failed to read file: ${zipPath} — ${(err as Error).message}`)
  }

  if (isZipBuffer(buffer)) {
    const csvBuffer = extractFirstFileFromZip(buffer)
    csvText = csvBuffer.toString('utf-8')
  } else {
    csvText = await readStreamToString(zipPath)
  }

  const points = parseFundingRateCsv(csvText)
  points.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  return points
}

/**
 * List available monthly data files on disk for a given symbol and data type.
 *
 * @param symbol    Asset symbol (e.g. "BTCUSDT")
 * @param dataType  Type of data directory to scan
 * @returns Sorted list of matching file names
 */
export async function listAvailableMonths(
  symbol: string,
  dataType: 'spot-klines-1h' | 'funding-rate',
): Promise<string[]> {
  // Try a few common base directories
  const candidates = [
    join(process.cwd(), 'data', dataType),
    join(process.cwd(), 'data', 'market', dataType),
    '/Volumes/shield/cryptoData/binance-public',
  ]

  for (const dir of candidates) {
    try {
      const files = await readdir(dir)
      const matching = files
        .filter(f => f.startsWith(symbol) && f.endsWith('.zip'))
        .sort()
      if (matching.length > 0) return matching
    } catch {
      continue
    }
  }

  return []
}
