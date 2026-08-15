import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic_write.js'

export interface ReplayGateVerdict {
  passed: boolean
  checked_at: string
  replay: EvidenceCheck
  drift: EvidenceCheck
  paper: EvidenceCheck
  shortfall: EvidenceCheck
  blockers: string[]
  details?: string
}

export interface EvidenceCheck {
  present: boolean
  path: string | null
  details: string | null
  status: 'ok' | 'missing' | 'stale' | 'failed'
}

const DATA_DIR = 'data'
const REPLAY_EVIDENCE_DIR = join(DATA_DIR, 'replay')
const DRIFT_EVIDENCE_PATH = join(DATA_DIR, 'runtime', 'signal_health.latest.json')
const PAPER_EVIDENCE_PATH = join(DATA_DIR, 'runtime', 'paper_decision.latest.json')
const SHORTFALL_EVIDENCE_PATH = join(DATA_DIR, 'runtime', 'implementation_shortfall.latest.json')
const RELEASE_GATE_STATUS_PATH = join(DATA_DIR, 'runtime', 'release_gate_status.json')

function checkReplayEvidence(baseDir: string): EvidenceCheck {
  const replayDir = join(baseDir, REPLAY_EVIDENCE_DIR)
  if (!existsSync(replayDir)) {
    return {
      present: false,
      path: replayDir,
      details: 'Replay evidence directory not found',
      status: 'missing',
    }
  }

  let jsonFiles: string[]
  try {
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    jsonFiles = readdirSync(replayDir).filter((f) => f.endsWith('.json'))
  } catch {
    return {
      present: false,
      path: replayDir,
      details: 'Failed to read replay directory',
      status: 'missing',
    }
  }

  if (jsonFiles.length === 0) {
    return {
      present: false,
      path: replayDir,
      details: 'No JSON files found in replay directory',
      status: 'missing',
    }
  }

  const costAdjustedFiles = jsonFiles.filter(
    (f) => f.toLowerCase().includes('replay') || f.toLowerCase().includes('cost'),
  )

  if (costAdjustedFiles.length > 0) {
    return {
      present: true,
      path: join(replayDir, costAdjustedFiles[0]),
      details: `Found ${costAdjustedFiles.length} cost-adjusted replay file(s)`,
      status: 'ok',
    }
  }

  return {
    present: true,
    path: join(replayDir, jsonFiles[0]),
    details: `Found ${jsonFiles.length} replay file(s) but no cost-adjusted evidence`,
    status: 'stale',
  }
}

interface SignalHealthEntry {
  status?: string
  healthy?: boolean
  symbol?: string
}

function checkDriftEvidence(baseDir: string): EvidenceCheck {
  const filePath = join(baseDir, DRIFT_EVIDENCE_PATH)
  if (!existsSync(filePath)) {
    return {
      present: false,
      path: filePath,
      details: 'Signal health file not found',
      status: 'missing',
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return {
      present: false,
      path: filePath,
      details: 'Failed to parse signal health file',
      status: 'failed',
    }
  }

  if (Array.isArray(parsed)) {
    const healthySignals = parsed.filter((s: SignalHealthEntry) => {
      if (s.status === 'healthy' || s.status === 'ok' || s.healthy === true) return true
      return false
    })
    if (healthySignals.length > 0) {
      return {
        present: true,
        path: filePath,
        details: `${healthySignals.length} of ${parsed.length} signals healthy`,
        status: 'ok',
      }
    }
    const blockedSignals = parsed.filter(
      (s: SignalHealthEntry) => s.status === 'blocked' || s.status === 'decayed',
    )
    return {
      present: true,
      path: filePath,
      details: `No healthy signals: ${blockedSignals.length} blocked/decayed of ${parsed.length}`,
      status: 'failed',
    }
  }

  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>
    const status = record.status
    const healthyCount = record.healthy !== undefined ? Number(record.healthy) : undefined
    const totalCount = record.total !== undefined ? Number(record.total) : undefined

    if (status === 'healthy' || status === 'ok') {
      return {
        present: true,
        path: filePath,
        details: totalCount !== undefined
          ? `Signal health status: ${String(status)} (${String(healthyCount ?? '?')}/${String(totalCount)})`
          : `Signal health status: ${String(status)}`,
        status: 'ok',
      }
    }
    if (status === 'blocked' || status === 'decayed' || status === 'degraded') {
      return {
        present: true,
        path: filePath,
        details: `Signal health status: ${String(status)}`,
        status: 'failed',
      }
    }
  }

  return {
    present: true,
    path: filePath,
    details: 'Signal health file has unrecognized format',
    status: 'stale',
  }
}

function checkPaperEvidence(baseDir: string): EvidenceCheck {
  const filePath = join(baseDir, PAPER_EVIDENCE_PATH)
  if (!existsSync(filePath)) {
    return {
      present: false,
      path: filePath,
      details: 'Paper decision file not found',
      status: 'missing',
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
  } catch {
    return {
      present: false,
      path: filePath,
      details: 'Failed to parse paper decision file',
      status: 'failed',
    }
  }

  const executedTrades = parsed.executedTrades
  const proposedOrders = parsed.proposedOrders

  const tradeCount = Array.isArray(executedTrades) ? executedTrades.length : 0
  const orderCount = Array.isArray(proposedOrders) ? proposedOrders.length : 0

  if (tradeCount > 0) {
    return {
      present: true,
      path: filePath,
      details: `${tradeCount} executed trades found`,
      status: 'ok',
    }
  }

  if (orderCount > 0) {
    return {
      present: true,
      path: filePath,
      details: `No executed trades, but ${orderCount} proposed orders exist`,
      status: 'stale',
    }
  }

  return {
    present: true,
    path: filePath,
    details: 'Paper decision file exists but no trades or orders recorded',
    status: 'stale',
  }
}

interface ShortfallReport {
  matched_fills?: number
  matchedFills?: number
  total_shortfall?: number
  totalShortfall?: number
}

function checkShortfallEvidence(baseDir: string): EvidenceCheck {
  const filePath = join(baseDir, SHORTFALL_EVIDENCE_PATH)
  if (!existsSync(filePath)) {
    return {
      present: false,
      path: filePath,
      details: 'Implementation shortfall file not found',
      status: 'missing',
    }
  }

  let parsed: ShortfallReport
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as ShortfallReport
  } catch {
    return {
      present: false,
      path: filePath,
      details: 'Failed to parse implementation shortfall file',
      status: 'failed',
    }
  }

  const matchedFills = parsed.matched_fills ?? parsed.matchedFills ?? 0

  if (matchedFills > 0) {
    return {
      present: true,
      path: filePath,
      details: `${matchedFills} matched fills recorded`,
      status: 'ok',
    }
  }

  return {
    present: true,
    path: filePath,
    details: 'Implementation shortfall file exists but matched_fills is 0',
    status: 'stale',
  }
}

export function evaluateReplayGate(baseDir?: string): ReplayGateVerdict {
  const dir = baseDir ?? process.cwd()
  const now = new Date().toISOString()

  const replay = checkReplayEvidence(dir)
  const drift = checkDriftEvidence(dir)
  const paper = checkPaperEvidence(dir)
  const shortfall = checkShortfallEvidence(dir)

  const blockers: string[] = []

  if (replay.status !== 'ok') {
    blockers.push(`replay:${replay.status}:${replay.details ?? 'no details'}`)
  }
  if (drift.status !== 'ok') {
    blockers.push(`drift:${drift.status}:${drift.details ?? 'no details'}`)
  }
  if (paper.status !== 'ok') {
    blockers.push(`paper:${paper.status}:${paper.details ?? 'no details'}`)
  }
  if (shortfall.status !== 'ok') {
    blockers.push(`shortfall:${shortfall.status}:${shortfall.details ?? 'no details'}`)
  }

  const passed = blockers.length === 0

  return {
    passed,
    checked_at: now,
    replay,
    drift,
    paper,
    shortfall,
    blockers,
  }
}

export function evaluateReplayGateForRelease(baseDir?: string): ReplayGateVerdict {
  const dir = baseDir ?? process.cwd()
  const verdict = evaluateReplayGate(dir)

  const releaseGatePath = join(dir, RELEASE_GATE_STATUS_PATH)
  if (!existsSync(releaseGatePath)) {
    if (verdict.passed) {
      verdict.blockers.push('release_gate_status:missing:release gate status file not found')
      verdict.passed = false
    }
    return verdict
  }

  try {
    const releaseGate = JSON.parse(readFileSync(releaseGatePath, 'utf-8')) as Record<string, unknown>
    const allowPaper = releaseGate.allowPaperTrading === true
    const allowLive = releaseGate.allowLiveTrading === true

    if (allowPaper || allowLive) {
      const mode = allowLive ? 'live' : 'paper'
      verdict.details = `Release gate already allows ${mode} trading; replay gate check is informational`
    }
  } catch {
    if (verdict.passed) {
      verdict.blockers.push('release_gate_status:parse_error:failed to parse release gate status')
      verdict.passed = false
    }
  }

  return verdict
}

export function writeReplayGateVerdict(verdict: ReplayGateVerdict): void {
  const outputPath = join(DATA_DIR, 'runtime', 'replay_gate.latest.json')
  writeJsonAtomic(outputPath, verdict)
}
