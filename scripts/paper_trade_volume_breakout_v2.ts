/**
 * Volume Breakout Paper Trader v2 — using PaperPositionExecutor.
 *
 * Flow:
 *   1. Load 5m candles for each symbol
 *   2. Evaluate volume breakout signals
 *   3. Build runtime gate (market intel + system fuse)
 *   4. For each profile: close positions → open positions → save account
 *
 * This is the executor-based version. Original stays for dual-run comparison.
 *
 * Usage: npx tsx scripts/paper_trade_volume_breakout_v2.ts
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateVolumeBreakout } from '../src/domain/strategy/volume-breakout.js'
import { PaperPositionExecutor } from '../src/runtime/paper_position_executor.js'
import {
  createVBCallbacks,
  vbProfileLane,
  VB_PROFILES,
  vbSignalToUnified,
  buildVBGateVerdict,
} from '../src/runtime/paper_vb_adapter.js'
import { defaultPaperUniverseSymbols, paperSymbolToCsvFile } from './lib/paper_universe.js'
import { readMarketIntelContext, isMarketIntelSymbolBanned } from '../src/runtime/market_intel_context.js'
import { readSystemFuse } from '../src/runtime/system_fuse.js'
import { readKillSwitch } from '../src/risk/kill-switch.js'
import { writeJsonAtomic } from '../src/runtime/atomic_write.js'

// ==================== Types ====================

interface Candle { timestamp: number; open: number; high: number; low: number; close: number; volume: number }

interface Account {
  equity: number
  initialEquity: number
  positions: unknown[]
  tradeHistory: unknown[]
}

// ==================== CLI ====================

function shouldDryRun(argv: string[]): boolean {
  const raw = parseArgs(argv)
  return parseBool(raw.get('dryRun'), false)
}

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const withoutPrefix = arg.slice(2)
    const eq = withoutPrefix.indexOf('=')
    if (eq >= 0) { out.set(withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1)); continue }
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { out.set(withoutPrefix, next); i++ }
    else { out.set(withoutPrefix, 'true') }
  }
  return out
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const n = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(n)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(n)) return false
  return fallback
}

// ==================== Data ====================

async function loadCandles(path: string): Promise<Candle[]> {
  const raw = await readFile(path, 'utf-8')
  const lines = raw.trim().split('\n')
  const h = lines[0].split(',')
  const ti = h.indexOf('timestamp'), oi = h.indexOf('open'), hi = h.indexOf('high'), li = h.indexOf('low'), ci = h.indexOf('close'), vi = h.indexOf('volume')
  return lines.slice(1).map(l => { const c = l.split(','); return { timestamp: Number(c[ti]), open: Number(c[oi]), high: Number(c[hi]), low: Number(c[li]), close: Number(c[ci]), volume: Number(c[vi]) } }).filter(c => c.timestamp > 0).sort((a, b) => a.timestamp - b.timestamp)
}

function accountPath(profileId: string): string {
  return join(import.meta.dirname ?? '.', '..', 'data', 'paper_trading', `account_vb_${profileId}.json`)
}

function loadAccount(profileId: string, initialEquity: number): Account {
  try {
    return JSON.parse(readFileSync(accountPath(profileId), 'utf-8'))
  } catch {
    return { equity: initialEquity, initialEquity, positions: [], tradeHistory: [] }
  }
}

async function saveAccount(profileId: string, account: Account) {
  const dir = join(import.meta.dirname ?? '.', '..', 'data', 'paper_trading')
  await mkdir(dir, { recursive: true })
  writeJsonAtomic(accountPath(profileId), account)
}

// ==================== Main ====================

async function main() {
const SYMBOLS = defaultPaperUniverseSymbols()
  const dataDir = join(import.meta.dirname ?? '.', '..', 'data', 'market', 'live_5m')
  const assets: Array<{ symbol: string; candles: Candle[] }> = []

  for (const symbol of SYMBOLS) {
    const fileName = paperSymbolToCsvFile(symbol, '5m')
    try {
      const candles = await loadCandles(join(dataDir, fileName))
      if (candles.length >= 26) assets.push({ symbol, candles })
    } catch { /* skip */ }
  }

  if (assets.length === 0) { console.log('No data. Run accumulate_5m_data first.'); return }

  const context = readMarketIntelContext()
  const fuse = readSystemFuse()

  // Evaluate signals
  const allSignals = assets
    .map(a => evaluateVolumeBreakout(a.symbol, a.candles))
    .map(s => vbSignalToUnified(s))
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => b.confidence - a.confidence)

  // Filter banned symbols
  const executableSignals = allSignals.filter(s => !isMarketIntelSymbolBanned(context, s.symbol))

  console.log(`\nSignals: ${allSignals.length} executable (after banned filter): ${executableSignals.length}`)

  // Build market data map for executor
  const marketData = new Map(assets.map(a => [a.symbol, a.candles]))

  // Build callbacks
  const callbacks = createVBCallbacks()
  const executor = new PaperPositionExecutor(dataDir, join(import.meta.dirname ?? '.', '..', 'data', 'runtime'), callbacks)

  const profileReports: Array<{
    id: string
    label: string
    leverage: number
    equity: number
    initialEquity: number
    openPositions: number
    totalTrades: number
    returnPct: number
    gate: { mode: string; reasons: string[] }
  }> = []

  for (const profile of VB_PROFILES) {
    const account = loadAccount(profile.id, 100_000)
    const gate = buildVBGateVerdict(profile, context, fuse)

    const now = new Date()
    const result = executor.executeCycle(
      account as unknown as { equity: number; initialEquity: number; positions: ExecutorPosition[]; tradeHistory: unknown[] },
      profile,
      executableSignals.filter(s => gate.allowNew),
      {
        gate,
        marketData,
        now,
        nowIso: now.toISOString(),
        nowMs: now.getTime(),
      },
    )

    await saveAccount(profile.id, account)

    const returnPct = ((account.equity / account.initialEquity - 1) * 100).toFixed(2)
    console.log(`\n${profile.label} (${profile.leverage}x): Closed ${result.closedTrades.length}, Opened ${result.openedPositionCount} | Equity: $${account.equity.toFixed(2)} (${returnPct}%)`)

    profileReports.push({
      id: profile.id,
      label: profile.label,
      leverage: profile.leverage,
      equity: account.equity,
      initialEquity: account.initialEquity,
      openPositions: (account.positions as unknown[]).length,
      totalTrades: account.tradeHistory.length,
      returnPct: Number(returnPct),
      gate: { mode: gate.mode, reasons: gate.reasons },
    })
  }

  // Save runtime report
  const reportDir = join(import.meta.dirname ?? '.', '..', 'data', 'runtime')
  await mkdir(reportDir, { recursive: true })
  writeJsonAtomic(join(reportDir, 'paper_volume_breakout_v2.latest.json'), {
    generatedAt: new Date().toISOString(),
    family: 'volume_breakout_v2',
    status: executableSignals.length > 0 ? 'signals' : 'no_signal',
    universeSize: assets.length,
    signalCount: allSignals.length,
    executableSignalCount: executableSignals.length,
    profiles: profileReports,
  })
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
