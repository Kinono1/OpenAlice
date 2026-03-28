import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createEventLog, type EventLog, type EventLogEntry } from '../../core/event-log.js'
import { createCronListener, type CronListener } from './listener.js'
import { SessionStore } from '../../core/session.js'
import type { CronFirePayload } from './engine.js'
import { ConnectorCenter } from '../../core/connector-center.js'

function tempPath(ext: string): string {
  return join(tmpdir(), `cron-listener-test-${randomUUID()}.${ext}`)
}

// ==================== Mock Engine ====================

function createMockEngine(response = 'AI reply') {
  const calls: Array<{ prompt: string; session: SessionStore }> = []
  let shouldFail = false

  return {
    calls,
    setResponse(text: string) { response = text },
    setShouldFail(val: boolean) { shouldFail = val },
    // Partial Engine mock — only askWithSession is needed
    askWithSession: vi.fn(async (prompt: string, session: SessionStore) => {
      calls.push({ prompt, session })
      if (shouldFail) throw new Error('engine error')
      return { text: response, media: [] }
    }),
    // Stubs for other Engine methods
    ask: vi.fn(),
  }
}

describe('cron listener', () => {
  let eventLog: EventLog
  let listener: CronListener
  let mockEngine: ReturnType<typeof createMockEngine>
  let session: SessionStore
  let logPath: string
  let connectorCenter: ConnectorCenter

  beforeEach(async () => {
    logPath = tempPath('jsonl')
    eventLog = await createEventLog({ logPath })
    mockEngine = createMockEngine()
    session = new SessionStore(`test/cron-${randomUUID()}`)
    connectorCenter = new ConnectorCenter()

    listener = createCronListener({
      connectorCenter,
      eventLog,
      engine: mockEngine as any,
      session,
    })
  })

  afterEach(async () => {
    listener.stop()
    await eventLog._resetForTest()
  })

  // ==================== Basic functionality ====================

  describe('event handling', () => {
    it('should call engine.askWithSession on cron.fire', async () => {
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Check the market',
      } satisfies CronFirePayload)

      // Wait for async handler
      await vi.waitFor(() => {
        expect(mockEngine.askWithSession).toHaveBeenCalledTimes(1)
      })

      expect(mockEngine.askWithSession).toHaveBeenCalledWith(
        'Check the market',
        session,
        expect.objectContaining({ historyPreamble: expect.any(String) }),
      )
    })

    it('should write cron.done event on success', async () => {
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Do something',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        const done = eventLog.recent({ type: 'cron.done' })
        expect(done).toHaveLength(1)
      })

      const done = eventLog.recent({ type: 'cron.done' })
      expect(done[0].payload).toMatchObject({
        jobId: 'abc12345',
        jobName: 'test-job',
        reply: 'AI reply',
      })
      expect((done[0].payload as any).durationMs).toBeGreaterThanOrEqual(0)
    })

    it('should not react to other event types', async () => {
      listener.start()

      await eventLog.append('some.other.event', { data: 'hello' })

      // Give it a moment
      await new Promise((r) => setTimeout(r, 50))

      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
    })
  })

  // ==================== Delivery ====================

  describe('delivery', () => {
    it('should deliver reply through connector registry', async () => {
      const delivered: string[] = []
      connectorCenter.register({
        channel: 'test',
        to: 'user1',
        capabilities: { push: true, media: false },
        send: async (payload) => { delivered.push(payload.text); return { delivered: true } },
      })

      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Hello',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        expect(delivered).toHaveLength(1)
      })

      expect(delivered[0]).toBe('AI reply')
    })

    it('should send one progress notification for a long-running job', async () => {
      vi.useFakeTimers()
      const delivered: string[] = []
      let resolveEngine: ((value: { text: string; media: [] }) => void) | null = null
      mockEngine.askWithSession = vi.fn(
        () =>
          new Promise((resolve) => {
            resolveEngine = resolve
          }),
      )
      connectorCenter.register({
        channel: 'test',
        to: 'user1',
        capabilities: { push: true, media: false },
        send: async (payload) => {
          delivered.push(payload.text)
          return { delivered: true }
        },
      })
      listener = createCronListener({
        connectorCenter,
        eventLog,
        engine: mockEngine as any,
        session,
        progressHeartbeatMs: 30_000,
      })
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'slow-job',
        payload: 'Long work',
      } satisfies CronFirePayload)

      await vi.runOnlyPendingTimersAsync()
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => {
        expect(delivered).toContain('Cron job "slow-job" is still running (30s elapsed).')
      })

      resolveEngine?.({ text: 'AI reply', media: [] })
      await vi.waitFor(() => {
        expect(delivered).toContain('AI reply')
      })
      vi.useRealTimers()
    })

    it('should handle delivery failure gracefully', async () => {
      connectorCenter.register({
        channel: 'test',
        to: 'user1',
        capabilities: { push: true, media: false },
        send: async () => { throw new Error('send failed') },
      })

      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Hello',
      } satisfies CronFirePayload)

      // Should still write cron.done (delivery failure is non-fatal)
      await vi.waitFor(() => {
        const done = eventLog.recent({ type: 'cron.done' })
        expect(done).toHaveLength(1)
      })
    })

    it('should handle no connectors gracefully', async () => {
      // No connectors registered
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Hello',
      } satisfies CronFirePayload)

      // Should still write cron.done
      await vi.waitFor(() => {
        const done = eventLog.recent({ type: 'cron.done' })
        expect(done).toHaveLength(1)
      })
    })
  })

  // ==================== Error handling ====================

  describe('error handling', () => {
    it('should write cron.error on engine failure', async () => {
      mockEngine.setShouldFail(true)
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Will fail',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        const errors = eventLog.recent({ type: 'cron.error' })
        expect(errors).toHaveLength(1)
      })

      const errors = eventLog.recent({ type: 'cron.error' })
      expect(errors[0].payload).toMatchObject({
        jobId: 'abc12345',
        jobName: 'test-job',
        error: 'engine error',
      })
      expect((errors[0].payload as any).durationMs).toBeGreaterThanOrEqual(0)
    })

    it('pauses a job after repeated listener failures', async () => {
      mockEngine.setShouldFail(true)
      const cronEngine = {
        update: vi.fn(async () => undefined),
      }
      listener = createCronListener({
        connectorCenter,
        eventLog,
        engine: mockEngine as any,
        session,
        cronEngine,
        failureThreshold: 2,
      })
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Will fail',
      } satisfies CronFirePayload)
      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'cron.error' })).toHaveLength(1)
      })

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Will fail again',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'cron.paused' })).toHaveLength(1)
      })

      const errors = eventLog.recent({ type: 'cron.error' })
      expect((errors[1].payload as any).consecutiveFailures).toBe(2)
      expect((errors[1].payload as any).nextAction).toBe('pause')
      expect(cronEngine.update).toHaveBeenCalledWith('abc12345', {
        enabled: false,
      })
    })
  })

  // ==================== Lifecycle ====================

  describe('lifecycle', () => {
    it('should stop receiving events after stop()', async () => {
      listener.start()
      listener.stop()

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Should not fire',
      } satisfies CronFirePayload)

      // Give it a moment
      await new Promise((r) => setTimeout(r, 50))

      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
    })

    it('should be idempotent (start twice, stop twice)', () => {
      listener.start()
      listener.start()
      listener.stop()
      listener.stop()
      // No error
    })
  })
})
