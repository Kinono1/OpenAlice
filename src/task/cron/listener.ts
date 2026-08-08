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
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { decideCronNotification } from './notification-policy.js'
import { buildPipelineExecutionReceipt } from './pipeline-receipt.js'
import { resolveRuntimeRole } from '../../runtime/runtime-paths.js'

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

export type CronScriptRunner = (
  scriptPath: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number },
) => Promise<CronScriptRunResult>
export type MacosNotificationSender = (text: string) => Promise<{ attempted: boolean; delivered: boolean; reason: string }>

interface CronNotification {
  shouldNotify: boolean
  text: string
  reason: string
  macosFallback?: boolean
  deliveryReceiptPath?: string
  receiptContext?: Record<string, unknown>
}

const ALLOWLISTED_SCRIPT_RELATIVE_PATHS = [
  'scripts/cron_eth_carry_refresh_pipeline.sh',
  'scripts/cron_paper_policy_shadow_capture.sh',
  'scripts/cron_paper_policy_shadow_settle.sh',
  'scripts/cron_paper_pnl_diagnostics.sh',
  'scripts/cron_pro_policy_window.sh',
  'scripts/cron_microstructure_stoploss_replay.sh',
  'scripts/cron_dirty_worktree_audit.sh',
  'scripts/cron_scheduler_security_audit.sh',
  'scripts/cron_external_derivatives_data_collect.sh',
  'scripts/cron_low_vol_research.sh',
  'scripts/cron_gated_improvement_candidate.sh',
  'scripts/cron_p1_trading_evidence.sh',
  'scripts/cron_openalice_task.sh',
  'scripts/cron_okx_warehouse_task.sh',
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
  /** Optional: inject Notification Center delivery for tests. */
  macosNotificationSender?: MacosNotificationSender
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
  const macosNotificationSender = opts.macosNotificationSender ?? sendMacosNotification
  const runtimeRole = resolveRuntimeRole()

  let unsubscribe: (() => void) | null = null
  let agentProcessing = false

  async function handleFire(entry: EventLogEntry): Promise<void> {
    const payload = entry.payload as CronFirePayload

    // Guard: internal jobs (__heartbeat__, __snapshot__, etc.) have dedicated handlers
    if (isInternalJob(payload.jobName)) return

    // The engine rejects research agent definitions, but keep the listener
    // boundary fail-closed as well: a hand-written or replayed cron.fire event
    // must not be able to reach the autonomous LLM session path in research.
    if (runtimeRole === 'research' && (payload.kind ?? 'agent') !== 'script') {
      await eventLog.append('cron.error', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        sourceFireSeq: entry.seq,
        error: 'cron_research_agent_job_forbidden',
        errorClass: 'runtime_role_forbidden',
        permanent: true,
        durationMs: 0,
      })
      return
    }

    if ((payload.kind ?? 'agent') === 'script') {
      // Script jobs own independent wrapper/collector locks. Running unrelated
      // jobs concurrently prevents a long market-data collector from delaying
      // health, archive, paper, and evidence tasks behind one global queue.
      await handleScriptFire(payload, Date.now(), entry.seq)
      return
    }

    // Guard: keep AI-routed cron jobs serial, without blocking allowlisted script jobs.
    if (agentProcessing) {
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

    agentProcessing = true
    const startMs = Date.now()

    try {
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

      const errorText = err instanceof Error ? err.message : String(err)

      // Log error
      await eventLog.append('cron.error', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        sourceFireSeq: entry.seq,
        error: errorText,
        ...classifyCronError(errorText),
        durationMs: Date.now() - startMs,
      })
    } finally {
      agentProcessing = false
    }
  }

  async function handleScriptFire(payload: CronFirePayload, startMs: number, sourceFireSeq: number): Promise<void> {
    const script = payload.script
    if (!script?.path) {
      const endedMs = Date.now()
      await eventLog.append('cron.error', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        sourceFireSeq,
        error: 'script cron job missing script.path',
        errorClass: 'invalid_job_contract',
        permanent: true,
        durationMs: endedMs - startMs,
        ...await pipelineReceiptFields(
          payload,
          startMs,
          endedMs,
          sourceFireSeq,
          'fail',
          ['script_path_missing'],
        ),
      })
      return
    }

    const releaseRoot = resolve(process.env.OPENALICE_RELEASE_PATH ?? process.cwd())
    const scriptPath = isAbsolute(script.path) ? resolve(script.path) : resolve(releaseRoot, script.path)
    if (!isAllowlistedCronScript(scriptPath)) {
      const endedMs = Date.now()
      await eventLog.append('cron.error', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        sourceFireSeq,
        error: `unsupported script cron job: ${scriptPath}`,
        errorClass: 'invalid_job_contract',
        permanent: true,
        durationMs: endedMs - startMs,
        ...await pipelineReceiptFields(
          payload,
          startMs,
          endedMs,
          sourceFireSeq,
          'fail',
          ['script_not_allowlisted'],
        ),
      })
      return
    }

    try {
      const scriptCwd = script.cwd
        ? (isAbsolute(script.cwd) ? resolve(script.cwd) : resolve(releaseRoot, script.cwd))
        : undefined
      if (scriptCwd && process.env.OPENALICE_RELEASE_PATH?.trim()) {
        assertWithin(releaseRoot, scriptCwd)
      }
      const result = await scriptRunner(scriptPath, script.args ?? [], {
        cwd: scriptCwd,
        timeoutMs: payload.pipelineContext?.timeoutSeconds
          ? payload.pipelineContext.timeoutSeconds * 1000
          : undefined,
      })
      const notification = script.notificationPath
        ? await readCronNotification(resolveRuntimeArtifactPath(script.notificationPath, releaseRoot), { minMtimeMs: startMs })
        : null
      const notificationText = notification?.text ?? ''
      const policy = decideCronNotification({
        jobName: payload.jobName,
        outcome: 'success',
        requested: notification?.shouldNotify === true,
        text: notificationText,
        previousConsecutiveErrors: payload.notificationState?.previousConsecutiveErrors,
      })
      const delivery = await deliverScriptNotification(payload.jobId, notification, policy)
      const endedMs = Date.now()

      await eventLog.append('cron.done', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        sourceFireSeq,
        reply: notificationText || result.stdout.trim() || 'STATUS: CRON_SKIP',
        durationMs: endedMs - startMs,
        delivered: delivery.delivered,
        deliveryReason: delivery.reason,
        deliveryChannel: delivery.channel,
        primaryDelivered: delivery.primaryDelivered,
        fallbackDelivered: delivery.fallbackDelivered,
        notificationPolicyReason: policy.reason,
        notificationClass: policy.notificationClass,
        previousConsecutiveErrors: payload.notificationState?.previousConsecutiveErrors ?? 0,
        scriptPath,
        scriptKind: 'allowlisted',
        notificationPath: script.notificationPath,
        parsedStatus: notification?.shouldNotify ? 'CRON_NOTIFY' : 'CRON_SKIP',
        parsedReason: notification?.reason ?? '',
        parsedUnparsed: false,
        ...await pipelineReceiptFields(
          payload,
          startMs,
          endedMs,
          sourceFireSeq,
          'pass',
          [],
        ),
      })
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      const artifactNotification = script.notificationPath
        ? await readCronNotification(resolveRuntimeArtifactPath(script.notificationPath, releaseRoot), { minMtimeMs: startMs })
        : null
      const notification = artifactNotification ?? buildScriptFailureFallbackNotification({
        jobId: payload.jobId,
        jobName: payload.jobName,
        scriptPath,
        notificationPath: script.notificationPath,
        error: errorText,
      })
      const notificationText = notification?.text ?? ''
      const policy = decideCronNotification({
        jobName: payload.jobName,
        outcome: 'failure',
        requested: notification?.shouldNotify === true,
        text: notificationText,
        error: errorText,
        previousConsecutiveErrors: payload.notificationState?.previousConsecutiveErrors,
        previousErrorFingerprint: payload.notificationState?.previousErrorFingerprint,
        circuitOpenAfter: payload.notificationState?.circuitOpenAfter,
      })
      const delivery = await deliverScriptNotification(payload.jobId, notification, policy)
      const endedMs = Date.now()
      await eventLog.append('cron.error', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        sourceFireSeq,
        error: errorText,
        ...classifyCronError(errorText),
        durationMs: endedMs - startMs,
        scriptPath,
        delivered: delivery.delivered,
        deliveryReason: delivery.reason,
        deliveryChannel: delivery.channel,
        primaryDelivered: delivery.primaryDelivered,
        fallbackDelivered: delivery.fallbackDelivered,
        notificationPolicyReason: policy.reason,
        notificationClass: policy.notificationClass,
        errorFingerprint: policy.errorFingerprint,
        failureCount: policy.failureCount,
        notificationPath: script.notificationPath,
        reply: notificationText,
        parsedStatus: notification?.shouldNotify ? 'CRON_NOTIFY' : 'CRON_SKIP',
        parsedReason: notification?.reason ?? '',
        parsedUnparsed: false,
        ...await pipelineReceiptFields(
          payload,
          startMs,
          endedMs,
          sourceFireSeq,
          'fail',
          [classifyCronError(errorText).errorClass],
        ),
      })
    }
  }

  async function pipelineReceiptFields(
    payload: CronFirePayload,
    startedMs: number,
    endedMs: number,
    sourceFireSeq: number,
    status: 'pass' | 'fail',
    reasonCodes: string[],
  ): Promise<Record<string, unknown>> {
    if (!payload.pipelineContext) return {}
    try {
      return {
        pipelineReceipt: await buildPipelineExecutionReceipt({
          context: payload.pipelineContext,
          jobId: payload.jobId,
          jobName: payload.jobName,
          sourceFireSeq,
          startedAt: new Date(startedMs),
          endedAt: new Date(endedMs),
          status,
          reasonCodes,
        }),
      }
    } catch (error) {
      return {
        pipelineReceiptError: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async function deliverScriptNotification(
    jobId: string,
    notification: CronNotification | null,
    policy?: ReturnType<typeof decideCronNotification>,
  ): Promise<{ delivered: boolean; reason: string; channel: string | null; primaryDelivered: boolean; fallbackDelivered: boolean }> {
    const notificationText = policy?.text ?? notification?.text ?? ''
    const shouldNotify = policy?.shouldNotify ?? notification?.shouldNotify ?? false
    if (!shouldNotify || !notificationText) {
      return {
        delivered: false,
        reason: policy ? `suppressed:${policy.reason}` : 'suppressed',
        channel: null,
        primaryDelivered: false,
        fallbackDelivered: false,
      }
    }
    let primary = { delivered: false, reason: 'no_push_connector', channel: undefined as string | undefined }
    try {
      const notifyResult = await connectorCenter.notify(notificationText, {
        source: 'cron',
      })
      primary = { delivered: notifyResult.delivered, reason: notifyResult.reason ?? (notifyResult.delivered ? 'delivered' : 'connector_not_ready'), channel: notifyResult.channel }
    } catch (sendErr) {
      console.warn(`cron-listener: send failed for script job ${jobId}:`, sendErr)
      primary = { delivered: false, reason: /timeout/i.test(String(sendErr)) ? 'send_timeout' : 'remote_rejected', channel: undefined }
    }
    let fallback = { attempted: false, delivered: false, reason: 'not_requested' }
    if (!primary.delivered && notification?.macosFallback) {
      fallback = await macosNotificationSender(notificationText)
    }
    const delivered = primary.delivered || fallback.delivered
    const channel = primary.delivered ? (primary.channel ?? 'push_connector') : fallback.delivered ? 'macos_notification_center' : (primary.channel ?? null)
    const reason = primary.delivered ? primary.reason : fallback.delivered ? 'fallback_delivered' : `${primary.reason};fallback=${fallback.reason}`
    if (notification?.deliveryReceiptPath) {
      try {
        const receiptPath = resolveRuntimeArtifactPath(
          notification.deliveryReceiptPath,
          resolve(process.env.OPENALICE_RELEASE_PATH ?? process.cwd()),
        )
        await mkdir(dirname(receiptPath), { recursive: true })
        await appendFile(receiptPath, `${JSON.stringify({
          generatedAt: new Date().toISOString(),
          jobId,
          primary: { channel: primary.channel ?? null, delivered: primary.delivered, reason: primary.reason },
          fallback,
          delivered,
          reason,
          channel,
          ...(notification.receiptContext ?? {}),
        })}\n`, 'utf-8')
      } catch (receiptError) {
        console.warn(`cron-listener: delivery receipt write failed for ${jobId}:`, receiptError)
      }
    }
    return { delivered, reason, channel, primaryDelivered: primary.delivered, fallbackDelivered: fallback.delivered }
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

    // Startup recovery must stay bounded. EventLog.read() scans persistent SQLite
    // synchronously, and a multi-year/high-frequency event log can otherwise block
    // the main event loop before Web/MCP plugins have a chance to listen.
    // The in-memory ring is restored from the durable tail at EventLog startup and
    // is sufficient to recover only the most recent unmatched scheduler fires.
    const recent = eventLog.recent({ limit: 500 })
    const fires = recent
      .filter((entry) => entry.type === 'cron.fire')
      .filter((entry) => entry.seq <= uptoSeq)
    if (fires.length === 0) return

    const completions = recent.filter((entry) =>
      (entry.type === 'cron.done' || entry.type === 'cron.error' || entry.type === 'cron.dropped') &&
      entry.seq <= uptoSeq,
    )

    // Cron schedules are state-based, not an at-least-once backlog. Replaying
    // every unmatched historical tick after a restart can create a recovery
    // storm (especially for one-minute jobs). Keep only the newest fire for
    // each job; wrapper locks and normal next-schedule execution protect the
    // current interval without reconstructing missed historical runs.
    const latestFireByJobId = new Map<string, EventLogEntry>()
    for (const fire of fires) {
      const payload = fire.payload as { jobId?: unknown; jobName?: unknown; kind?: unknown }
      if (typeof payload?.jobId !== 'string') continue
      if (typeof payload.jobName === 'string' && isInternalJob(payload.jobName)) continue
      // Periodic script jobs deliberately resume at their next normal Cron
      // schedule. Their wrappers already own locks/checkpoints, and replaying a
      // pre-restart tick would violate next-schedule retry semantics.
      if (payload.kind === 'script') continue
      latestFireByJobId.set(payload.jobId, fire)
    }

    const latestFires = [...latestFireByJobId.values()].sort((a, b) => a.seq - b.seq)
    for (const fire of latestFires) {
      if (hasCronCompletion(fire, completions)) continue
      await handleFire(fire)
    }
  }
}

function classifyCronError(error: string): { errorClass: string; permanent: boolean } {
  if (/HTTP\s+(?:401|403|451)\b/i.test(error)) {
    return { errorClass: 'remote_permanent', permanent: true }
  }
  if (/HTTP\s+429\b/i.test(error)) {
    return { errorClass: 'rate_limited', permanent: false }
  }
  if (/HTTP\s+5\d\d\b/i.test(error)) {
    return { errorClass: 'remote_server_error', permanent: false }
  }
  if (/timeout|timed out|ECONNRESET|ENETUNREACH|EAI_AGAIN|fetch failed/i.test(error)) {
    return { errorClass: 'transient_network', permanent: false }
  }
  return { errorClass: 'script_error', permanent: false }
}

function hasCronCompletion(
  fire: EventLogEntry,
  completions: EventLogEntry[],
): boolean {
  const firePayload = fire.payload as { jobId?: unknown }
  const fireJobId = typeof firePayload?.jobId === 'string' ? firePayload.jobId : null
  if (!fireJobId) return true

  return completions.some((completion) => {
    const payload = completion.payload as { jobId?: unknown; sourceFireSeq?: unknown; fireSeq?: unknown }
    if (payload.sourceFireSeq === fire.seq || payload.fireSeq === fire.seq) return true
    return payload.jobId === fireJobId && completion.seq > fire.seq
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
  const releaseRoot = resolve(process.env.OPENALICE_RELEASE_PATH ?? process.cwd())
  const relativePath = relative(releaseRoot, resolve(scriptPath)).replaceAll('\\', '/')
  return ALLOWLISTED_SCRIPT_RELATIVE_PATHS.includes(relativePath as typeof ALLOWLISTED_SCRIPT_RELATIVE_PATHS[number])
}

function resolveRuntimeArtifactPath(path: string, releaseRoot: string): string {
  if (isAbsolute(path)) {
    const resolvedPath = resolve(path)
    if (!process.env.OPENALICE_RELEASE_PATH?.trim()) return resolvedPath
    const artifactRoot = process.env.OPENALICE_ARTIFACT_DIR?.trim()
    const dataRoot = process.env.OPENALICE_DATA_DIR?.trim()
    if (artifactRoot && isWithin(resolve(artifactRoot), resolvedPath)) return resolvedPath
    if (dataRoot && isWithin(resolve(dataRoot), resolvedPath)) return resolvedPath
    assertWithin(releaseRoot, resolvedPath)
    return resolvedPath
  }
  const artifactRoot = process.env.OPENALICE_ARTIFACT_DIR?.trim()
  const dataRoot = process.env.OPENALICE_DATA_DIR?.trim()
  if (artifactRoot && path.startsWith('data/runtime/')) {
    const resolvedPath = resolve(artifactRoot, path.slice('data/runtime/'.length))
    if (!isWithin(resolve(artifactRoot), resolvedPath)) throw new Error(`runtime_artifact_path_escape:${path}`)
    return resolvedPath
  }
  if (dataRoot && path.startsWith('data/')) {
    const resolvedPath = resolve(dataRoot, path.slice('data/'.length))
    if (!isWithin(resolve(dataRoot), resolvedPath)) throw new Error(`runtime_data_path_escape:${path}`)
    return resolvedPath
  }
  const resolvedPath = resolve(releaseRoot, path)
  if (process.env.OPENALICE_RELEASE_PATH?.trim()) assertWithin(releaseRoot, resolvedPath)
  return resolvedPath
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function assertWithin(parent: string, child: string): void {
  if (!isWithin(parent, child)) throw new Error(`release_path_escape:${child}`)
}

async function defaultScriptRunner(
  scriptPath: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number },
): Promise<CronScriptRunResult> {
  const result = await execFileAsync('/bin/bash', [scriptPath, ...args], {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
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
    return {
      shouldNotify,
      text,
      reason,
      macosFallback: raw.macosFallback === true,
      deliveryReceiptPath: typeof raw.deliveryReceiptPath === 'string' ? raw.deliveryReceiptPath : undefined,
      receiptContext: isRecord(raw.receiptContext) ? raw.receiptContext : undefined,
    }
  } catch {
    return null
  }
}

async function sendMacosNotification(text: string): Promise<{ attempted: boolean; delivered: boolean; reason: string }> {
  if (process.platform !== 'darwin') return { attempted: true, delivered: false, reason: 'unsupported_platform' }
  const safe = text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', ' ')
  try {
    await execFileAsync('/usr/bin/osascript', ['-e', `display notification "${safe}" with title "OpenAlice"`], { timeout: 5_000 })
    return { attempted: true, delivered: true, reason: 'delivered' }
  } catch (error) {
    return { attempted: true, delivered: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
