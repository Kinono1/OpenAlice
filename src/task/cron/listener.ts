/**
 * Cron Listener — subscribes to `cron.fire` events from the EventLog
 * and routes them through the AI Engine for processing.
 *
 * Flow:
 *   eventLog 'cron.fire' → engine.askWithSession(payload, session)
 *                         → connectorCenter.notify(reply)
 *                         → eventLog 'cron.done' / 'cron.error'
 *
 * The listener owns a dedicated SessionStore for cron conversations,
 * independent of user chat sessions (Telegram, Web, etc.).
 */

import type { EventLog, EventLogEntry } from '../../core/event-log.js'
import type { Engine } from '../../core/engine.js'
import { SessionStore } from '../../core/session.js'
import type { ConnectorCenter } from '../../core/connector-center.js'
import type { CronEngine, CronFirePayload } from './engine.js'
import { HEARTBEAT_JOB_NAME } from '../heartbeat/heartbeat.js'

// ==================== Types ====================

export interface CronListenerOpts {
  connectorCenter: ConnectorCenter
  eventLog: EventLog
  engine: Engine
  /** Optional: inject a session for testing. Otherwise creates a dedicated cron session. */
  session?: SessionStore
  /** Optional: send one progress notification if a job is still running after this interval. */
  progressHeartbeatMs?: number
  /** Optional: pause jobs after repeated listener failures. */
  cronEngine?: Pick<CronEngine, 'update'>
  failureThreshold?: number
}

export interface CronListener {
  start(): void
  stop(): void
}

// ==================== Factory ====================

export function createCronListener(opts: CronListenerOpts): CronListener {
  const { connectorCenter, eventLog, engine } = opts
  const session = opts.session ?? new SessionStore('cron/default')
  const progressHeartbeatMs = Math.max(0, opts.progressHeartbeatMs ?? 30_000)
  const failureThreshold = Math.max(1, opts.failureThreshold ?? 3)

  let unsubscribe: (() => void) | null = null
  let processing = false
  const consecutiveFailures = new Map<string, number>()

  async function handleFire(entry: EventLogEntry): Promise<void> {
    const payload = entry.payload as CronFirePayload

    // Guard: heartbeat events are handled by the heartbeat listener
    if (payload.jobName === HEARTBEAT_JOB_NAME) return

    // Guard: skip if already processing (serial execution)
    if (processing) {
      console.warn(`cron-listener: skipping job ${payload.jobId} (already processing)`)
      return
    }

    processing = true
    const startMs = Date.now()
    let progressTimer: ReturnType<typeof setTimeout> | null = null

    try {
      if (progressHeartbeatMs > 0) {
        progressTimer = setTimeout(() => {
          void connectorCenter.notify(
            `Cron job "${payload.jobName}" is still running (${Math.max(1, Math.round((Date.now() - startMs) / 1000))}s elapsed).`,
            {
              source: 'cron',
            },
          ).catch((sendErr) => {
            console.warn(`cron-listener: progress send failed for job ${payload.jobId}:`, sendErr)
          })
        }, progressHeartbeatMs)
      }

      // Ask the AI engine with the cron payload
      const result = await engine.askWithSession(payload.payload, session, {
        historyPreamble: 'The following is the recent cron session conversation. This is an automated cron job execution.',
      })

      // Send notification through the last-interacted connector
      try {
        await connectorCenter.notify(result.text, {
          media: result.media,
          source: 'cron',
        })
      } catch (sendErr) {
        console.warn(`cron-listener: send failed for job ${payload.jobId}:`, sendErr)
      }

      // Log success
      await eventLog.append('cron.done', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        reply: result.text,
        durationMs: Date.now() - startMs,
      })
      consecutiveFailures.delete(payload.jobId)
    } catch (err) {
      console.error(`cron-listener: error processing job ${payload.jobId}:`, err)
      const nextFailures = (consecutiveFailures.get(payload.jobId) ?? 0) + 1
      consecutiveFailures.set(payload.jobId, nextFailures)
      const shouldPause = nextFailures >= failureThreshold

      // Log error
      await eventLog.append('cron.error', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startMs,
        consecutiveFailures: nextFailures,
        pauseThreshold: failureThreshold,
        nextAction: shouldPause ? 'pause' : 'retry',
      })

      if (shouldPause && opts.cronEngine) {
        try {
          await opts.cronEngine.update(payload.jobId, { enabled: false })
          await eventLog.append('cron.paused', {
            jobId: payload.jobId,
            jobName: payload.jobName,
            reason: 'listener_consecutive_failures',
            consecutiveFailures: nextFailures,
          })
        } catch (pauseErr) {
          console.error(`cron-listener: failed to pause job ${payload.jobId}:`, pauseErr)
        }
      }
    } finally {
      if (progressTimer) {
        clearTimeout(progressTimer)
      }
      processing = false
    }
  }

  return {
    start() {
      if (unsubscribe) return // already started
      unsubscribe = eventLog.subscribeType('cron.fire', (entry) => {
        // Fire-and-forget — errors are caught inside handleFire
        handleFire(entry).catch((err) => {
          console.error('cron-listener: unhandled error in handleFire:', err)
        })
      })
    },

    stop() {
      unsubscribe?.()
      unsubscribe = null
      consecutiveFailures.clear()
    },
  }
}
