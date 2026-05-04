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
  result?: 'GO' | 'NO_GO'
  reasonCodes?: string[]
  checks?: ReleaseGateCheck[]
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
    result?: 'GO' | 'NO_GO'
    reasonCodes?: string[]
    checks?: ReleaseGateCheck[]
  },
): Promise<PersistedReleaseGateStatus> {
  const payload: PersistedReleaseGateStatus = {
    version: 1,
    generatedAt: new Date().toISOString(),
    allowPaperTrading: gate.allowPaperTrading,
    allowLiveTrading: gate.allowLiveTrading,
    failedChecks: [...gate.failedChecks],
    warningChecks: [...gate.warningChecks],
    result: opts?.result,
    reasonCodes: opts?.reasonCodes ? [...opts.reasonCodes] : undefined,
    checks: cloneReleaseGateChecks(opts?.checks ?? gate.checks),
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

  const result = normalizeReleaseGateResult(value.result)
  const reasonCodes = normalizeOptionalStringArray(value.reasonCodes, 'reasonCodes')
  const checks = normalizeOptionalReleaseGateChecks(value.checks)

  return {
    version: 1,
    generatedAt: value.generatedAt,
    allowPaperTrading: value.allowPaperTrading,
    allowLiveTrading: value.allowLiveTrading,
    failedChecks: value.failedChecks,
    warningChecks: value.warningChecks,
    result,
    reasonCodes,
    checks,
    sourceReportPath: value.sourceReportPath,
    expiresAt: value.expiresAt,
  }
}

function cloneReleaseGateChecks(checks: ReleaseGateCheck[]): ReleaseGateCheck[] {
  return checks.map((check) => ({
    ...check,
    metrics: { ...check.metrics },
  }))
}

function normalizeReleaseGateResult(
  value: PersistedReleaseGateStatus['result'],
): PersistedReleaseGateStatus['result'] {
  if (value === undefined || value === 'GO' || value === 'NO_GO') {
    return value
  }
  throw new Error('Malformed release gate status.')
}

function normalizeOptionalStringArray(
  value: unknown,
  fieldName: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Malformed release gate status ${fieldName}.`)
  }
  return [...value]
}

function normalizeOptionalReleaseGateChecks(value: unknown): ReleaseGateCheck[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value)) {
    throw new Error('Malformed release gate status checks.')
  }

  return value.map((item) => normalizeReleaseGateCheck(item))
}

function normalizeReleaseGateCheck(raw: unknown): ReleaseGateCheck {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Malformed release gate status checks.')
  }

  const value = raw as Partial<ReleaseGateCheck>
  if (
    !isReleaseGateCheckName(value.name) ||
    !isReleaseGateCheckStatus(value.status) ||
    typeof value.summary !== 'string' ||
    !value.metrics ||
    typeof value.metrics !== 'object' ||
    Array.isArray(value.metrics)
  ) {
    throw new Error('Malformed release gate status checks.')
  }

  const metrics = Object.fromEntries(
    Object.entries(value.metrics).filter(([, metricValue]) =>
      metricValue === null ||
      typeof metricValue === 'string' ||
      typeof metricValue === 'number' ||
      typeof metricValue === 'boolean',
    ),
  )

  return {
    name: value.name,
    status: value.status,
    summary: value.summary,
    metrics,
  }
}

function isReleaseGateCheckName(value: unknown): value is ReleaseGateCheck['name'] {
  return (
    value === 'wfo' ||
    value === 'significance' ||
    value === 'risk_simulation' ||
    value === 'economics' ||
    value === 'execution_quality' ||
    value === 'ramp_up' ||
    value === 'regime_shift'
  )
}

function isReleaseGateCheckStatus(value: unknown): value is ReleaseGateCheck['status'] {
  return value === 'pass' || value === 'warn' || value === 'fail' || value === 'skipped'
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
