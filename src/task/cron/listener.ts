/**
 * Cron Listener — subscribes to `cron.fire` events from the EventLog
 * and routes them through the AgentCenter for processing.
 *
 * Flow:
 *   eventLog 'cron.fire' → agentCenter.askWithSession(payload, session)
 *                         → parse structured reply (or fail-open to raw text)
 *                         → connectorCenter.notify(reply, when applicable)
 *                         → eventLog 'cron.done' / 'cron.error'
 *
 * The listener owns a dedicated SessionStore for cron conversations,
 * independent of user chat sessions (Telegram, Web, etc.).
 */

import type { EventLog, EventLogEntry } from '../../core/event-log.js'
import type { AgentCenter } from '../../core/agent-center.js'
import { SessionStore } from '../../core/session.js'
import type { ConnectorCenter } from '../../core/connector-center.js'
import type { CronFirePayload } from './engine.js'
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type CronResponseStatus = 'CRON_SKIP' | 'CRON_NOTIFY'

export interface ParsedCronResponse {
  status: CronResponseStatus
  reason: string
  content: string
  /** True when the raw response couldn't be parsed into the structured format. */
  unparsed: boolean
}

export interface CronScriptRunResult {
  stdout: string
  stderr: string
}

export type CronScriptRunner = (scriptPath: string, args: string[], opts: { cwd?: string }) => Promise<CronScriptRunResult>

interface CronNotification {
  shouldNotify: boolean
  text: string
  reason: string
}

const ALLOWLISTED_SCRIPT_PATHS = [
  resolve('scripts/cron_eth_carry_refresh_pipeline.sh'),
  resolve('scripts/cron_paper_policy_shadow_capture.sh'),
  resolve('scripts/cron_paper_policy_shadow_settle.sh'),
  resolve('scripts/cron_paper_pnl_diagnostics.sh'),
  resolve('scripts/cron_pro_policy_window.sh'),
  resolve('scripts/cron_microstructure_stoploss_replay.sh'),
  resolve('scripts/cron_dirty_worktree_audit.sh'),
  resolve('scripts/cron_scheduler_security_audit.sh'),
  resolve('scripts/cron_external_derivatives_data_collect.sh'),
  resolve('scripts/cron_p1_trading_evidence.sh'),
] as const

/**
 * Parse a structured cron response from the AI.
 *
 * Expected format:
 *   STATUS: CRON_SKIP | CRON_NOTIFY
 *   REASON: <brief explanation of your decision>   (optional)
 *   CONTENT: <message to deliver, only when STATUS is CRON_NOTIFY>
 *
 * If the response doesn't match the expected format, treats the entire
 * raw text as a message to deliver (fail-open: deliver rather than swallow).
 */
export function parseCronResponse(raw: string): ParsedCronResponse {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { status: 'CRON_SKIP', reason: 'empty response', content: '', unparsed: false }
  }

  const statusMatch = /^\s*STATUS:\s*(CRON_SKIP|CRON_NOTIFY)\s*$/im.exec(trimmed)
  if (!statusMatch) {
    return { status: 'CRON_NOTIFY', reason: 'unparsed response', content: trimmed, unparsed: true }
  }

  const status = statusMatch[1].toUpperCase() as CronResponseStatus
  const reasonMatch = /^\s*REASON:\s*(.+?)(?=\n\s*(?:STATUS|CONTENT):|\s*$)/ims.exec(trimmed)
  const reason = reasonMatch?.[1]?.trim() ?? ''
  const contentMatch = /^\s*CONTENT:\s*(.+)/ims.exec(trimmed)
  const content = contentMatch?.[1]?.trim() ?? ''

  return { status, reason, content, unparsed: false }
}
/** Internal jobs (prefixed with __) have dedicated handlers and should not be routed to the AI. */
function isInternalJob(name: string): boolean {
  return name.startsWith('__') && name.endsWith('__')
}

// ==================== Types ====================

export interface CronListenerOpts {
  connectorCenter: ConnectorCenter
  eventLog: EventLog
  agentCenter: AgentCenter
  /** Optional: inject a session for testing. Otherwise creates a dedicated cron session. */
  session?: SessionStore
  /** Optional: inject script execution for tests. */
  scriptRunner?: CronScriptRunner
}

export interface CronListener {
  start(): void
  stop(): void
}

// ==================== Factory ====================

export function createCronListener(opts: CronListenerOpts): CronListener {
  const { connectorCenter, eventLog, agentCenter } = opts
  const session = opts.session ?? new SessionStore('cron/default')
  const scriptRunner = opts.scriptRunner ?? defaultScriptRunner

  let unsubscribe: (() => void) | null = null
  let processing = false

  async function handleFire(entry: EventLogEntry): Promise<void> {
    const payload = entry.payload as CronFirePayload

    // Guard: internal jobs (__heartbeat__, __snapshot__, etc.) have dedicated handlers
    if (isInternalJob(payload.jobName)) return

    // Guard: skip if already processing (serial execution)
    if (processing) {
      console.warn(`cron-listener: skipping job ${payload.jobId} (already processing)`)
      await eventLog.append('cron.dropped', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        sourceFireSeq: entry.seq,
        reason: 'listener_already_processing',
        droppedWhileProcessing: true,
      })
      return
    }

    processing = true
    const startMs = Date.now()

    try {
      if ((payload.kind ?? 'agent') === 'script') {
        await handleScriptFire(payload, startMs, entry.seq)
        return
      }

      // Ask the AI engine with the cron payload
      const result = await agentCenter.askWithSession(payload.payload, session, {
        historyPreamble: 'The following is the recent cron session conversation. This is an automated cron job execution.',
      })

      const parsed = parseCronResponse(result.text)

      if (parsed.status === 'CRON_SKIP') {
        await eventLog.append('cron.done', {
          jobId: payload.jobId,
          jobName: payload.jobName,
          sourceFireSeq: entry.seq,
          reply: parsed.reason ? `STATUS: CRON_SKIP\nREASON: ${parsed.reason}` : 'STATUS: CRON_SKIP',
          durationMs: Date.now() - startMs,
          delivered: false,
          parsedStatus: parsed.status,
          parsedReason: parsed.reason,
          parsedUnparsed: parsed.unparsed,
        })
        return
      }

      const text = parsed.content || result.text
      let delivered = false

      // Send notification through the last-interacted connector
      try {
        const notifyResult = await connectorCenter.notify(text, {
          media: result.media,
          source: 'cron',
        })
        delivered = notifyResult.delivered
      } catch (sendErr) {
        console.warn(`cron-listener: send failed for job ${payload.jobId}:`, sendErr)
      }

      // Log success
      await eventLog.append('cron.done', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        sourceFireSeq: entry.seq,
        reply: text,
        durationMs: Date.now() - startMs,
        delivered,
        parsedStatus: parsed.status,
        parsedReason: parsed.reason,
        parsedUnparsed: parsed.unparsed,
      })
    } catch (err) {
      console.error(`cron-listener: error processing job ${payload.jobId}:`, err)

      // Log error
      await eventLog.append('cron.error', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        sourceFireSeq: entry.seq,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startMs,
      })
    } finally {
      processing = false
    }
  }

  async function handleScriptFire(payload: CronFirePayload, startMs: number, sourceFireSeq: number): Promise<void> {
    const script = payload.script
    if (!script?.path) {
      await eventLog.append('cron.error', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        sourceFireSeq,
        error: 'script cron job missing script.path',
        durationMs: Date.now() - startMs,
      })
      return
    }

    const scriptPath = resolve(script.path)
    if (!isAllowlistedCronScript(scriptPath)) {
      await eventLog.append('cron.error', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        sourceFireSeq,
        error: `unsupported script cron job: ${scriptPath}`,
        durationMs: Date.now() - startMs,
      })
      return
    }

    try {
      const result = await scriptRunner(scriptPath, script.args ?? [], { cwd: script.cwd })
      const notification = script.notificationPath
        ? await readCronNotification(script.notificationPath, { minMtimeMs: startMs })
        : null
      const notificationText = notification?.text ?? ''
      const delivered = await deliverScriptNotification(payload.jobId, notification)

      await eventLog.append('cron.done', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        sourceFireSeq,
        reply: notificationText || result.stdout.trim() || 'STATUS: CRON_SKIP',
        durationMs: Date.now() - startMs,
        delivered,
        scriptPath,
        scriptKind: 'allowlisted',
        notificationPath: script.notificationPath,
        parsedStatus: notification?.shouldNotify ? 'CRON_NOTIFY' : 'CRON_SKIP',
        parsedReason: notification?.reason ?? '',
        parsedUnparsed: false,
      })
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      const artifactNotification = script.notificationPath
        ? await readCronNotification(script.notificationPath, { minMtimeMs: startMs })
        : null
      const notification = artifactNotification ?? buildScriptFailureFallbackNotification({
        jobId: payload.jobId,
        jobName: payload.jobName,
        scriptPath,
        notificationPath: script.notificationPath,
        error: errorText,
      })
      const notificationText = notification?.text ?? ''
      const delivered = await deliverScriptNotification(payload.jobId, notification)
      await eventLog.append('cron.error', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        sourceFireSeq,
        error: errorText,
        durationMs: Date.now() - startMs,
        scriptPath,
        delivered,
        notificationPath: script.notificationPath,
        reply: notificationText,
        parsedStatus: notification?.shouldNotify ? 'CRON_NOTIFY' : 'CRON_SKIP',
        parsedReason: notification?.reason ?? '',
        parsedUnparsed: false,
      })
    }
  }

  async function deliverScriptNotification(
    jobId: string,
    notification: CronNotification | null,
  ): Promise<boolean> {
    const notificationText = notification?.text ?? ''
    if (!notification?.shouldNotify || !notificationText) {
      return false
    }
    try {
      const notifyResult = await connectorCenter.notify(notificationText, {
        source: 'cron',
      })
      return notifyResult.delivered
    } catch (sendErr) {
      console.warn(`cron-listener: send failed for script job ${jobId}:`, sendErr)
      return false
    }
  }

  return {
    start() {
      if (unsubscribe) return // already started
      const startupSeq = eventLog.lastSeq()
      unsubscribe = eventLog.subscribeType('cron.fire', (entry) => {
        // Fire-and-forget — errors are caught inside handleFire
        handleFire(entry).catch((err) => {
          console.error('cron-listener: unhandled error in handleFire:', err)
        })
      })
      replayUnmatchedStartupFires(startupSeq).catch((err) => {
        console.error('cron-listener: failed replaying unmatched startup fires:', err)
      })
    },

    stop() {
      unsubscribe?.()
      unsubscribe = null
    },
  }

  async function replayUnmatchedStartupFires(uptoSeq: number): Promise<void> {
    if (uptoSeq <= 0) return

    const fires = (await eventLog.read({ type: 'cron.fire' }))
      .filter((entry) => entry.seq <= uptoSeq)
    if (fires.length === 0) return

    const completions = [
      ...await eventLog.read({ type: 'cron.done' }),
      ...await eventLog.read({ type: 'cron.error' }),
      ...await eventLog.read({ type: 'cron.dropped' }),
    ].filter((entry) => entry.seq <= uptoSeq)

    for (let idx = 0; idx < fires.length; idx += 1) {
      const fire = fires[idx]
      const nextFire = findNextFireForSameJob(fire, fires.slice(idx + 1))
      if (hasCronCompletion(fire, completions, nextFire?.seq)) continue
      await handleFire(fire)
    }
  }
}

function findNextFireForSameJob(fire: EventLogEntry, laterFires: EventLogEntry[]): EventLogEntry | null {
  const firePayload = fire.payload as { jobId?: unknown }
  const fireJobId = typeof firePayload?.jobId === 'string' ? firePayload.jobId : null
  if (!fireJobId) return null
  return laterFires.find((candidate) => {
    const payload = candidate.payload as { jobId?: unknown }
    return payload.jobId === fireJobId
  }) ?? null
}

function hasCronCompletion(
  fire: EventLogEntry,
  completions: EventLogEntry[],
  nextSameJobFireSeq?: number,
): boolean {
  const firePayload = fire.payload as { jobId?: unknown }
  const fireJobId = typeof firePayload?.jobId === 'string' ? firePayload.jobId : null
  if (!fireJobId) return true

  return completions.some((completion) => {
    const payload = completion.payload as { jobId?: unknown; sourceFireSeq?: unknown; fireSeq?: unknown }
    if (payload.sourceFireSeq === fire.seq || payload.fireSeq === fire.seq) return true
    return payload.jobId === fireJobId &&
      completion.seq > fire.seq &&
      (nextSameJobFireSeq === undefined || completion.seq < nextSameJobFireSeq)
  })
}

function buildScriptFailureFallbackNotification(input: {
  jobId: string
  jobName: string
  scriptPath: string
  notificationPath?: string
  error: string
}): CronNotification {
  return {
    shouldNotify: true,
    reason: 'script cron failed before notification artifact was written',
    text: [
      'script cron failed before notification artifact was written',
      `jobId=${input.jobId}`,
      `jobName=${input.jobName}`,
      `scriptPath=${input.scriptPath}`,
      `notificationPath=${input.notificationPath ?? 'none'}`,
      `error=${input.error}`,
    ].join(' '),
  }
}

function isAllowlistedCronScript(scriptPath: string): boolean {
  return ALLOWLISTED_SCRIPT_PATHS.includes(resolve(scriptPath))
}

async function defaultScriptRunner(scriptPath: string, args: string[], opts: { cwd?: string }): Promise<CronScriptRunResult> {
  const result = await execFileAsync('/bin/bash', [scriptPath, ...args], {
    cwd: opts.cwd,
    maxBuffer: 10 * 1024 * 1024,
  })
  return { stdout: result.stdout, stderr: result.stderr }
}

async function readCronNotification(
  path: string,
  opts: { minMtimeMs?: number } = {},
): Promise<CronNotification | null> {
  try {
    const resolvedPath = resolve(path)
    if (opts.minMtimeMs != null) {
      const fileStat = await stat(resolvedPath)
      if (fileStat.mtimeMs < opts.minMtimeMs) return null
    }
    const raw = JSON.parse(await readFile(resolvedPath, 'utf-8')) as Record<string, unknown>
    const deliveryDecision = typeof raw.deliveryDecision === 'string' ? raw.deliveryDecision : ''
    const shouldNotify = raw.shouldNotify === true || deliveryDecision === 'notify'
    const text = typeof raw.fullText === 'string'
      ? raw.fullText
      : typeof raw.content === 'string'
        ? raw.content
        : typeof raw.headline === 'string'
          ? raw.headline
          : ''
    const reason = typeof raw.headline === 'string'
      ? raw.headline
      : deliveryDecision || (shouldNotify ? 'notification requested' : 'notification suppressed')
    return { shouldNotify, text, reason }
  } catch {
    return null
  }
}
