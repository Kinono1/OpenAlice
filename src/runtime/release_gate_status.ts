import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ReleaseGateCheck, ReleaseGateResult } from '../backtest/release_gate.js'

export interface PersistedReleaseGateStatus {
  version: 1
  generatedAt: string
  allowPaperTrading: boolean
  allowLiveTrading: boolean
  failedChecks: ReleaseGateCheck['name'][]
  warningChecks: ReleaseGateCheck['name'][]
  sourceReportPath?: string
  expiresAt?: string
}

export async function loadReleaseGateStatus(
  filePath = 'data/runtime/release_gate_status.json',
): Promise<PersistedReleaseGateStatus | null> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    return normalizeReleaseGateStatus(JSON.parse(raw))
  } catch (err: unknown) {
    if (isEnoent(err)) {
      return null
    }
    throw err
  }
}

export async function writeReleaseGateStatus(
  gate: ReleaseGateResult,
  opts?: {
    filePath?: string
    sourceReportPath?: string
    expiresAt?: string
  },
): Promise<PersistedReleaseGateStatus> {
  const payload: PersistedReleaseGateStatus = {
    version: 1,
    generatedAt: new Date().toISOString(),
    allowPaperTrading: gate.allowPaperTrading,
    allowLiveTrading: gate.allowLiveTrading,
    failedChecks: gate.failedChecks,
    warningChecks: gate.warningChecks,
    sourceReportPath: opts?.sourceReportPath,
    expiresAt: opts?.expiresAt,
  }

  const filePath = opts?.filePath ?? 'data/runtime/release_gate_status.json'
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
  return payload
}

export type ReleaseGateMode = 'paper' | 'live'

export function isReleaseGateStatusBlocking(
  status: PersistedReleaseGateStatus | null,
  mode: ReleaseGateMode = 'live',
  now: Date = new Date(),
): { blocking: boolean; reason?: string } {
  if (!status) {
    return { blocking: true, reason: 'release_gate_status_missing' }
  }
  if (status.expiresAt) {
    const expiresAt = Date.parse(status.expiresAt)
    if (Number.isFinite(expiresAt) && now.getTime() > expiresAt) {
      return {
        blocking: true,
        reason: `release_gate_status_expired:${status.expiresAt}`,
      }
    }
  }
  const allowed = mode === 'paper'
    ? status.allowPaperTrading
    : status.allowLiveTrading
  if (!allowed) {
    return {
      blocking: true,
      reason: `${mode}_release_gate_failed:${status.failedChecks.join(',') || 'unknown'}`,
    }
  }
  return { blocking: false }
}

export function normalizeReleaseGateStatus(raw: unknown): PersistedReleaseGateStatus {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid release gate status payload.')
  }
  const value = raw as Partial<PersistedReleaseGateStatus>
  if (
    value.version !== 1 ||
    typeof value.generatedAt !== 'string' ||
    typeof value.allowPaperTrading !== 'boolean' ||
    typeof value.allowLiveTrading !== 'boolean' ||
    !Array.isArray(value.failedChecks) ||
    !Array.isArray(value.warningChecks)
  ) {
    throw new Error('Malformed release gate status.')
  }
  return {
    version: 1,
    generatedAt: value.generatedAt,
    allowPaperTrading: value.allowPaperTrading,
    allowLiveTrading: value.allowLiveTrading,
    failedChecks: value.failedChecks,
    warningChecks: value.warningChecks,
    sourceReportPath: value.sourceReportPath,
    expiresAt: value.expiresAt,
  }
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
