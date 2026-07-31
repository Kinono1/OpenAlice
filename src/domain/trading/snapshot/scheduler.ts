/**
 * Snapshot scheduler — periodic snapshots via cron engine.
 *
 * Registers a cron job (`__snapshot__`) and subscribes to `cron.fire` events.
 * When fired, captures snapshots for all accounts.
 *
 * Follows the same pattern as the heartbeat system.
 */

import type { EventLog, EventLogEntry } from '../../../core/event-log.js'
import type { CronEngine, CronFirePayload } from '../../../task/cron/engine.js'
import type { SnapshotService } from './service.js'

const SNAPSHOT_JOB_NAME = '__snapshot__'

export interface SnapshotConfig {
  enabled: boolean
  every: string
}

export interface SnapshotScheduler {
  start(): Promise<void>
  stop(): void
}

export function createSnapshotScheduler(deps: {
  snapshotService: SnapshotService
  cronEngine: CronEngine
  eventLog: EventLog
  config: SnapshotConfig
}): SnapshotScheduler {
  const { snapshotService, cronEngine, eventLog, config } = deps

  let unsubscribe: (() => void) | null = null
  let processing = false

  async function handleFire(entry: EventLogEntry): Promise<void> {
    const payload = entry.payload as CronFirePayload
    if (payload.jobName !== SNAPSHOT_JOB_NAME) return
    if (processing) {
      await eventLog.append('cron.done', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        sourceFireSeq: entry.seq,
        durationMs: 0,
        delivered: false,
        parsedStatus: 'CRON_SKIP',
        parsedReason: 'snapshot_already_processing',
      })
      return
    }

    processing = true
    const startMs = Date.now()
    try {
      await snapshotService.takeAllSnapshots('scheduled')
      await eventLog.append('cron.done', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        sourceFireSeq: entry.seq,
        durationMs: Date.now() - startMs,
        delivered: false,
        parsedStatus: 'CRON_SKIP',
        parsedReason: 'snapshot_complete',
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.warn('snapshot-scheduler: error:', error)
      await eventLog.append('cron.error', {
        jobId: payload.jobId,
        jobName: payload.jobName,
        sourceFireSeq: entry.seq,
        error,
        errorClass: 'snapshot_error',
        permanent: false,
        durationMs: Date.now() - startMs,
      })
    } finally {
      processing = false
    }
  }

  return {
    async start() {
      // Find or create the cron job
      const existing = cronEngine.list().find(j => j.name === SNAPSHOT_JOB_NAME)
      if (existing) {
        await cronEngine.update(existing.id, {
          schedule: { kind: 'every', every: config.every },
          enabled: config.enabled,
        })
      } else {
        await cronEngine.add({
          name: SNAPSHOT_JOB_NAME,
          schedule: { kind: 'every', every: config.every },
          payload: '',
          enabled: config.enabled,
        })
      }

      // Subscribe to cron.fire events
      if (!unsubscribe) {
        unsubscribe = eventLog.subscribeType('cron.fire', (entry) => {
          handleFire(entry).catch(err => {
            console.error('snapshot-scheduler: unhandled error:', err)
          })
        })
      }
    },

    stop() {
      unsubscribe?.()
      unsubscribe = null
    },
  }
}
