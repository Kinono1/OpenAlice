#!/usr/bin/env tsx
/**
 * OA intake for CurrencyPurchases bridge signals.
 *
 * Reads CP's openalice_signals.json, validates, gates, and logs traces.
 *
 * CP signals are never executable from this intake. Observation-mode signals
 * are logged, and ticket-mode intent remains explicitly blocked until a
 * separate release-gated paper execution pipeline is implemented.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BRIDGE_PATH = '/Users/kino/Files/HFish/CurrencyPurchases/runtime/bridge/openalice_signals.json'
const OA_ROOT = '/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice'
const TRACE_PATH = join(OA_ROOT, 'data', 'runtime', 'cp_signal_trace.ndjson')
const EXECUTED_PATH = join(OA_ROOT, 'data', 'runtime', 'bridge_executed_ids.json')
const EXECUTED_HISTORY_DAYS = 7

const CRYPTO_SYMBOLS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'BNB-USDT', 'XRP-USDT']

export interface BridgePayload {
  generated_at: string
  source: string
  mode: 'ticket' | 'observation'
  cp_cycle_id: string
  cp_truth_status: string
  signals: CPExtSignal[]
}

export interface CPExtSignal {
  signal_id: string
  source: string
  strategy_id: string
  symbol: string
  as_of: string
  ttl_ms: number
  target_position_pct: number
  confidence: number
  thesis: string
  risk_note: string
  trace: Record<string, unknown>
}

export interface ExecutedEntry {
  signal_id: string
  executedAt: number
}

export interface LocalGateResult {
  status: 'pass' | 'reject'
  meta: Record<string, unknown>
}

function main(): void {
  if (!existsSync(BRIDGE_PATH)) {
    console.log('cp_intake: bridge file not found, skipping')
    return
  }

  // HALT check
  const haltPath = '/Users/kino/Files/HFish/CurrencyPurchases/runtime/HALT'
  if (existsSync(haltPath)) {
    console.log('cp_intake: HALT file detected, emergency stop active')
    writeTrace({ signal_id: 'HALT', step: 'halt', status: 'halted', meta: {} })
    return
  }

  const bridgeAge = Date.now() - statMtime(BRIDGE_PATH)
  if (bridgeAge > 3_600_000) {
    console.log(`cp_intake: bridge file stale (${Math.round(bridgeAge / 60000)}min), alerting`)
    writeTrace({ signal_id: 'BRIDGE', step: 'stale', status: 'alert', meta: { ageMs: bridgeAge } })
    // Still process; don't skip signals due to file mtime.
  }

  let payload: BridgePayload
  try {
    payload = JSON.parse(readFileSync(BRIDGE_PATH, 'utf-8'))
  } catch {
    console.error('cp_intake: failed to parse bridge JSON')
    return
  }

  console.log(`cp_intake: mode=${payload.mode} signals=${payload.signals.length} cycle=${payload.cp_cycle_id}`)

  const executed = loadExecuted()
  const activeIds = new Set(payload.signals.map(s => s.signal_id))
  let intakeCount = 0

  for (const signal of payload.signals) {
    // Local gates.
    const gateResult = evaluateLocalGates(signal, payload, executed, activeIds)
    writeTrace({ signal_id: signal.signal_id, step: 'local_gate', ...gateResult })
    if (gateResult.status !== 'pass') continue

    // Observation mode: log only.
    if (signal.target_position_pct === 0.0) {
      writeTrace({
        signal_id: signal.signal_id,
        step: 'observation',
        status: 'logged',
        meta: { thesis: signal.thesis.slice(0, 120) },
      })
      intakeCount++
      continue
    }

    // Ticket-mode intent: explicitly blocked.
    // Execution must be wired through a separate release-gated paper plan.
    writeTrace({
      signal_id: signal.signal_id,
      step: 'ticket_intent',
      status: 'blocked',
      decision: 'hold',
      pct: signal.target_position_pct,
      reason: 'cp_ticket_mode_execution_pipeline_pending',
      meta: {
        paperExecutionAllowed: false,
        liveExecutionAllowed: false,
        executionSuppressed: true,
      },
    })
    intakeCount++
  }

  // Cleanup executed IDs.
  const pruned = executed.filter(e =>
    activeIds.has(e.signal_id) || (Date.now() - e.executedAt < EXECUTED_HISTORY_DAYS * 86400_000)
  )
  saveExecuted(pruned)

  console.log(`cp_intake: ${intakeCount} signals processed, ${executed.length} total executed IDs`)
}


export function evaluateLocalGates(
  signal: CPExtSignal,
  payload: Pick<BridgePayload, 'mode'>,
  executed: ExecutedEntry[],
  activeIds: Set<string>,
  nowMs = Date.now(),
): LocalGateResult {
  if (typeof signal.signal_id !== 'string' || signal.signal_id.trim() === '') {
    return { status: 'reject', meta: { reason: 'missing_signal_id' } }
  }

  const targetPositionPct = finiteNumber(signal.target_position_pct)
  if (targetPositionPct == null) {
    return { status: 'reject', meta: { reason: 'invalid_target_position_pct', targetPositionPct: signal.target_position_pct } }
  }

  if (payload.mode === 'observation' && targetPositionPct !== 0) {
    return {
      status: 'reject',
      meta: {
        reason: 'mode_target_mismatch:observation_nonzero_target',
        mode: payload.mode,
        targetPositionPct,
        paperExecutionAllowed: false,
      },
    }
  }

  // Symbol whitelist
  if (!CRYPTO_SYMBOLS.includes(signal.symbol)) {
    return { status: 'reject', meta: { reason: 'symbol_not_whitelisted', symbol: signal.symbol } }
  }

  // TTL check (signal-level, NOT file mtime)
  const asOfMs = Date.parse(signal.as_of)
  if (!Number.isFinite(asOfMs)) {
    return { status: 'reject', meta: { reason: 'invalid_as_of', asOf: signal.as_of } }
  }
  const ttlMs = finiteNumber(signal.ttl_ms)
  if (ttlMs == null) {
    return { status: 'reject', meta: { reason: 'invalid_ttl_ms', ttlMs: signal.ttl_ms } }
  }
  if (ttlMs <= 0 || ttlMs > 24 * 60 * 60 * 1000) {
    return { status: 'reject', meta: { reason: 'ttl_ms_out_of_bounds', ttlMs } }
  }
  const signalAge = nowMs - asOfMs
  if (signalAge < 0) {
    return { status: 'reject', meta: { reason: 'as_of_in_future', ageMs: signalAge } }
  }
  if (signalAge > ttlMs) {
    return { status: 'reject', meta: { reason: 'ttl_expired', ageMs: signalAge, ttlMs } }
  }

  // Confidence gate
  const confidence = finiteNumber(signal.confidence)
  if (confidence == null) {
    return { status: 'reject', meta: { reason: 'invalid_confidence', confidence: signal.confidence } }
  }
  if (confidence < 0.5) {
    return { status: 'reject', meta: { reason: 'low_confidence', confidence } }
  }

  // Dedup: already executed + still in active set
  if (executed.some(e => e.signal_id === signal.signal_id)) {
    return { status: 'reject', meta: { reason: 'already_executed' } }
  }

  return {
    status: 'pass',
    meta: {
      confidence,
      ageMs: signalAge,
      targetPositionPct,
      mode: payload.mode,
      executionSuppressed: targetPositionPct !== 0,
      paperExecutionAllowed: false,
    },
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}


// Persistence helpers.

function loadExecuted(): ExecutedEntry[] {
  try {
    if (existsSync(EXECUTED_PATH)) {
      return JSON.parse(readFileSync(EXECUTED_PATH, 'utf-8'))
    }
  } catch { /* corrupt file: start fresh */ }
  return []
}

function saveExecuted(entries: ExecutedEntry[]): void {
  mkdirSync(join(OA_ROOT, 'data', 'runtime'), { recursive: true })
  const tmp = EXECUTED_PATH + '.tmp'
  writeFileSync(tmp, JSON.stringify(entries))
  renameSync(tmp, EXECUTED_PATH)
}

function writeTrace(entry: Record<string, unknown>): void {
  mkdirSync(join(OA_ROOT, 'data', 'runtime'), { recursive: true })
  const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() })
  writeFileSync(TRACE_PATH, line + '\n', { flag: 'a' })
}

function statMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
