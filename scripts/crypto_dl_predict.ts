#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from '../src/runtime/atomic_write.js'
import { computeCurrentSlotId } from '../src/runtime/sidecar_signal.js'

const AI_SCIENTIST_ARTIFACT_ROOT = '/Volumes/shield/cryptoData/ai-scientist-crypto-dl-runs'
const CRYPTO_DL_TEMPLATE_ROOT = '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl'
const SIDECAR_OUTPUT_PATH = 'data/runtime/sidecar_signal_intake.latest.json'
const STATUS_OUTPUT_PATH = 'data/runtime/crypto_dl_sidecar_status.latest.json'

function staleOutSidecarSignal(): void {
  try {
    if (existsSync(SIDECAR_OUTPUT_PATH)) {
      unlinkSync(SIDECAR_OUTPUT_PATH)
      console.log(`[crypto_dl] Removed stale sidecar signal: ${SIDECAR_OUTPUT_PATH}`)
    }
  } catch {
    // Best-effort cleanup only
  }
}

interface PredictionRow {
  symbol: string
  prediction: number
  directionProbability: number | null
  datetime: string
  targetTimestamp: number
}

interface SignalCandidate {
  symbol: string
  targetPositionBps: number
  confidenceBps: number
  thesis: string
  targetStartAt: string
  targetEndAt: string
}

function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (ch === ',' && !inQuotes) {
      result.push(current)
      current = ''
      continue
    }
    current += ch
  }
  result.push(current)
  return result
}

function findLatestRunDir(): string | null {
  const entries = readdirSync(AI_SCIENTIST_ARTIFACT_ROOT)
  const dirs = entries
    .filter(e => {
      try {
        return statSync(join(AI_SCIENTIST_ARTIFACT_ROOT, e)).isDirectory()
      } catch {
        return false
      }
    })
    .sort((a, b) => {
      return (
        statSync(join(AI_SCIENTIST_ARTIFACT_ROOT, b)).mtimeMs -
        statSync(join(AI_SCIENTIST_ARTIFACT_ROOT, a)).mtimeMs
      )
    })
  return dirs.length > 0 ? dirs[0] : null
}

function loadPredictions(filePath: string): PredictionRow[] {
  if (!existsSync(filePath)) return []
  const text = readFileSync(filePath, 'utf-8')
  const lines = text.split('\n').filter(l => l.trim().length > 0)
  if (lines.length < 2) return []

  const headers = parseCsvLine(lines[0])
  const symbolIdx = headers.indexOf('symbol')
  const predictionIdx = headers.indexOf('prediction')
  const directionProbIdx = headers.indexOf('direction_probability')
  const datetimeIdx = headers.indexOf('datetime')
  const targetTsIdx = headers.indexOf('target_timestamp')

  if (symbolIdx === -1 || predictionIdx === -1 || datetimeIdx === -1 || targetTsIdx === -1) {
    return []
  }

  const rows: PredictionRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i])
    const symbol = cols[symbolIdx]?.trim() ?? ''
    if (!symbol) continue

    const predRaw = cols[predictionIdx]?.trim() ?? ''
    const prediction = parseFloat(predRaw)
    if (!Number.isFinite(prediction)) continue

    const dpRaw =
      (directionProbIdx !== -1 ? cols[directionProbIdx]?.trim() : '') ?? ''
    const directionProbability = dpRaw.length > 0 ? parseFloat(dpRaw) : null

    const datetime = cols[datetimeIdx]?.trim() ?? ''

    const tsRaw = cols[targetTsIdx]?.trim() ?? ''
    const targetTimestamp = parseInt(tsRaw, 10)
    if (!Number.isFinite(targetTimestamp)) continue

    rows.push({ symbol, prediction, directionProbability, datetime, targetTimestamp })
  }
  return rows
}

function convertSymbol(raw: string): string {
  const s = raw.endsWith('_USDT') ? raw.slice(0, -5) : raw
  return s.replace(/_/g, '/')
}

function buildSignalCandidates(rows: PredictionRow[]): SignalCandidate[] {
  return rows.map(row => {
    const targetPositionBps = Math.round(row.prediction * 10000)
    const confidenceBps =
      row.directionProbability !== null && Number.isFinite(row.directionProbability)
        ? Math.min(Math.round(Math.abs(row.directionProbability) * 10000), 10000)
        : 0

    const predictionPct = (row.prediction * 100).toFixed(2)
    const thesis = `crypto_dl predicted return: ${predictionPct}%`
    const targetStartAt = new Date(row.targetTimestamp).toISOString()
    const targetEndAt = new Date(row.targetTimestamp + 86400000).toISOString()

    return {
      symbol: convertSymbol(row.symbol),
      targetPositionBps,
      confidenceBps,
      thesis,
      targetStartAt,
      targetEndAt,
    }
  })
}

function main(): void {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const now = new Date()
  const startedAt = now.toISOString()

  try {
    let predictions: PredictionRow[] = []
    let latestRunDir: string | null = null

    latestRunDir = findLatestRunDir()
    if (latestRunDir) {
      predictions = loadPredictions(
        join(AI_SCIENTIST_ARTIFACT_ROOT, latestRunDir, 'predictions.csv'),
      )
    }

    if (predictions.length === 0) {
      predictions = loadPredictions(
        join(CRYPTO_DL_TEMPLATE_ROOT, 'bt_final', 'predictions.csv'),
      )
    }

    if (predictions.length === 0) {
      predictions = loadPredictions(
        join(CRYPTO_DL_TEMPLATE_ROOT, 'train_da', 'predictions.csv'),
      )
    }

    if (predictions.length === 0) {
      const runSource = latestRunDir ?? 'template'
      const statusPayload = {
        status: 'blocked',
        slot_id: computeCurrentSlotId(now),
        run_id: `run_${Date.now()}`,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        ready: false,
        signals_count: 0,
        errorClass: 'NO_PREDICTIONS_FOUND',
        errorMessage:
          'No predictions.csv found in any expected location (artifact run dir, bt_final, train_da)',
      }
      if (dryRun) {
        console.log(JSON.stringify(statusPayload, null, 2))
      } else {
        writeJsonAtomic(STATUS_OUTPUT_PATH, statusPayload)
        staleOutSidecarSignal()
      }
      process.exit(1)
    }

    const candidates = buildSignalCandidates(predictions)
    const qualified = candidates.filter(
      c => Math.abs(c.targetPositionBps) >= 200 && c.confidenceBps >= 5000,
    )

    if (qualified.length === 0) {
      const statusPayload = {
        status: 'blocked',
        slot_id: computeCurrentSlotId(now),
        run_id: `run_${Date.now()}`,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        ready: false,
        signals_count: 0,
        errorClass: 'NO_QUALIFIED_SIGNALS',
        errorMessage: `No signals passed threshold: |target_position_bps| >= 200 and confidence_bps >= 5000 (total candidates: ${candidates.length})`,
      }
      if (dryRun) {
        console.log(JSON.stringify(statusPayload, null, 2))
      } else {
        writeJsonAtomic(STATUS_OUTPUT_PATH, statusPayload)
        staleOutSidecarSignal()
      }
      process.exit(1)
    }

    const signals = qualified.map(c => ({
      source: 'cryptotrade' as const,
      strategy_id: 'crypto_dl',
      symbol: c.symbol,
      as_of: now.toISOString(),
      target_position_bps: c.targetPositionBps,
      confidence_bps: c.confidenceBps,
      model_id: 'crypto_dl_v1',
      thesis: c.thesis,
      label_horizon_bars: 1,
      bar_interval_ms: 3600000,
      target_start_delay_bars: 1,
      target_start_at: c.targetStartAt,
      target_end_at: c.targetEndAt,
    }))

    const slotId = computeCurrentSlotId(now)
    const runId = `run_${Date.now()}`
    const modelCount = new Set(signals.map(s => s.model_id)).size

    const envelope = {
      schema_version: 1,
      slot_id: slotId,
      run_id: runId,
      generated_at: now.toISOString(),
      ttl_ms: 14400000,
      signals,
      producer: 'ai-scientist-crypto-dl',
      model_metadata: {
        model_count: modelCount,
        run_source: latestRunDir ?? 'template',
      },
    }

    const statusPayload = {
      status: 'ready',
      slot_id: slotId,
      run_id: runId,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      ready: true,
      signals_count: signals.length,
    }

    if (dryRun) {
      console.log(JSON.stringify({ envelope, status: statusPayload }, null, 2))
    } else {
      writeJsonAtomic(SIDECAR_OUTPUT_PATH, envelope)
      writeJsonAtomic(STATUS_OUTPUT_PATH, statusPayload)
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    const errorClass = err instanceof Error ? err.constructor.name : 'UnknownError'
    const statusPayload = {
      status: 'error',
      slot_id: computeCurrentSlotId(now),
      run_id: `run_${Date.now()}`,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      ready: false,
      signals_count: 0,
      errorClass,
      errorMessage,
    }
    if (dryRun) {
      console.log(JSON.stringify(statusPayload, null, 2))
    } else {
      writeJsonAtomic(STATUS_OUTPUT_PATH, statusPayload)
      staleOutSidecarSignal()
    }
    process.exit(1)
  }
}

main()
