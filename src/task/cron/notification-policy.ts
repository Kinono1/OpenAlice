import { createHash } from 'node:crypto'

export type CronNotificationOutcome = 'success' | 'failure'

export interface CronNotificationPolicyInput {
  jobName: string
  outcome: CronNotificationOutcome
  requested: boolean
  text: string
  previousConsecutiveErrors?: number
  previousErrorFingerprint?: string | null
  circuitOpenAfter?: number
  error?: string
}

export interface CronNotificationPolicyDecision {
  shouldNotify: boolean
  text: string
  reason:
    | 'not_requested'
    | 'log_only'
    | 'requested'
    | 'critical'
    | 'first_failure'
    | 'error_changed'
    | 'circuit_opened'
    | 'duplicate_failure'
    | 'recovered'
  notificationClass: 'log_only' | 'routine' | 'critical' | 'failure_transition' | 'recovery'
  errorFingerprint: string | null
  failureCount: number
}

const LOG_ONLY_JOB_PATTERNS = [
  /^okx_(?:public|market_data|instrument_master|warehouse|ssd|depth)/,
  /^external_derivatives_data_/,
  /^market_intel_/,
  /^paper_(?:pnl|policy)_/,
  /^p1_trading_evidence_/,
  /^prospective_evidence_/,
  /^microstructure_stoploss_/,
  /^pro_policy_/,
  /^low_vol_research_/,
  /^runtime_fee_auth_/,
] as const

const CRITICAL_PATTERNS = [
  /\b(?:live|real)[ _-]?(?:trading|order|position|account)\b/i,
  /\b(?:unauthori[sz]ed|credential|secret|api key)\b/i,
  /\b(?:database corruption|data corruption|integrity failure)\b/i,
  /\b(?:disk|filesystem|storage).{0,32}(?:full|critical|read-only|corrupt)/i,
  /\b(?:kill switch|safety gate).{0,32}(?:disabled|bypassed|failed open)/i,
  /\b(?:fund transfer|withdrawal|liquidation|margin call)\b/i,
] as const

export function decideCronNotification(input: CronNotificationPolicyInput): CronNotificationPolicyDecision {
  const previousConsecutiveErrors = Math.max(0, input.previousConsecutiveErrors ?? 0)
  const failureCount = input.outcome === 'failure' ? previousConsecutiveErrors + 1 : 0
  const errorFingerprint = input.outcome === 'failure'
    ? fingerprintCronError(input.jobName, input.error ?? input.text)
    : null

  if (input.outcome === 'failure') {
    if (previousConsecutiveErrors === 0) {
      return decision(true, input.text, 'first_failure', 'failure_transition', errorFingerprint, failureCount)
    }
    if (input.previousErrorFingerprint && input.previousErrorFingerprint !== errorFingerprint) {
      return decision(true, input.text, 'error_changed', 'failure_transition', errorFingerprint, failureCount)
    }
    if ((input.circuitOpenAfter ?? 0) > 0 && failureCount === input.circuitOpenAfter) {
      const text = [
        `OpenAlice cron circuit opened after ${failureCount} consecutive failures.`,
        `jobName=${input.jobName}`,
        input.text,
      ].join(' ')
      return decision(true, text, 'circuit_opened', 'failure_transition', errorFingerprint, failureCount)
    }
    return decision(false, input.text, 'duplicate_failure', 'log_only', errorFingerprint, failureCount)
  }

  if (previousConsecutiveErrors > 0) {
    const text = [
      'OpenAlice cron job recovered.',
      `jobName=${input.jobName}`,
      `previousConsecutiveErrors=${previousConsecutiveErrors}`,
    ].join(' ')
    return decision(true, text, 'recovered', 'recovery', null, 0)
  }
  if (!input.requested || !input.text) {
    return decision(false, input.text, 'not_requested', 'log_only', null, 0)
  }
  if (isCriticalNotification(input.text)) {
    return decision(true, input.text, 'critical', 'critical', null, 0)
  }
  if (isLogOnlyJob(input.jobName)) {
    return decision(false, input.text, 'log_only', 'log_only', null, 0)
  }
  return decision(true, input.text, 'requested', 'routine', null, 0)
}

export function fingerprintCronError(jobName: string, error: string): string {
  const normalized = error
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?\b/gi, '<timestamp>')
    .replace(/\b\d{10,}\b/g, '<number>')
    .replace(/\s+/g, ' ')
    .trim()
  return createHash('sha256').update(`${jobName}\n${normalized}`).digest('hex').slice(0, 16)
}

export function isLogOnlyJob(jobName: string): boolean {
  // Explicit human follow-up reminders retain their existing delivery and
  // macOS fallback contract; routine SSD probes remain log-only.
  if (/^okx_ssd_.*_reminder_/.test(jobName)) return false
  return LOG_ONLY_JOB_PATTERNS.some((pattern) => pattern.test(jobName))
}

export function isCriticalNotification(text: string): boolean {
  return CRITICAL_PATTERNS.some((pattern) => pattern.test(text))
}

function decision(
  shouldNotify: boolean,
  text: string,
  reason: CronNotificationPolicyDecision['reason'],
  notificationClass: CronNotificationPolicyDecision['notificationClass'],
  errorFingerprint: string | null,
  failureCount: number,
): CronNotificationPolicyDecision {
  return { shouldNotify, text, reason, notificationClass, errorFingerprint, failureCount }
}
