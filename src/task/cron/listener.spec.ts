import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { readFile, utimes, writeFile } from 'node:fs/promises'
import { createEventLog, type EventLog, type EventLogEntry } from '../../core/event-log.js'
import { createCronListener, parseCronResponse, type CronListener } from './listener.js'
import { SessionStore } from '../../core/session.js'
import type { CronFirePayload } from './engine.js'
import { ConnectorCenter } from '../../core/connector-center.js'
import { fingerprintCronError } from './notification-policy.js'

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
      agentCenter: mockEngine as any,
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

    it('should parse CRON_NOTIFY and deliver the CONTENT field', async () => {
      const delivered: string[] = []
      connectorCenter.register({
        channel: 'test',
        to: 'user1',
        capabilities: { push: true, media: false },
        send: async (payload) => { delivered.push(payload.text); return { delivered: true } },
      })

      mockEngine.setResponse([
        'STATUS: CRON_NOTIFY',
        'REASON: Notification artifact says to notify.',
        'CONTENT: ETH carry runtime is ready for review.',
      ].join('\n'))

      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Hello',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        expect(delivered).toHaveLength(1)
      })

      expect(delivered[0]).toBe('ETH carry runtime is ready for review.')
      await vi.waitFor(() => {
        const done = eventLog.recent({ type: 'cron.done' })
        expect(done).toHaveLength(1)
      })
      const done = eventLog.recent({ type: 'cron.done' })
      expect(done[0].payload).toMatchObject({
        reply: 'ETH carry runtime is ready for review.',
        delivered: true,
        parsedStatus: 'CRON_NOTIFY',
        parsedReason: 'Notification artifact says to notify.',
        parsedUnparsed: false,
      })
    })

    it('should skip delivery for CRON_SKIP responses', async () => {
      const notifySpy = vi.spyOn(connectorCenter, 'notify')
      mockEngine.setResponse([
        'STATUS: CRON_SKIP',
        'REASON: flat state, no operator message needed.',
      ].join('\n'))

      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Hello',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        const done = eventLog.recent({ type: 'cron.done' })
        expect(done).toHaveLength(1)
      })

      expect(notifySpy).not.toHaveBeenCalled()
      const done = eventLog.recent({ type: 'cron.done' })
      expect(done[0].payload).toMatchObject({
        delivered: false,
        parsedStatus: 'CRON_SKIP',
        parsedReason: 'flat state, no operator message needed.',
      })
    })

    it('should fail open and deliver unparsed responses', async () => {
      const delivered: string[] = []
      connectorCenter.register({
        channel: 'test',
        to: 'user1',
        capabilities: { push: true, media: false },
        send: async (payload) => { delivered.push(payload.text); return { delivered: true } },
      })

      mockEngine.setResponse('The script produced a plain-text operator note without structured fields.')

      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Hello',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        expect(delivered).toHaveLength(1)
      })

      expect(delivered[0]).toBe('The script produced a plain-text operator note without structured fields.')
      await vi.waitFor(() => {
        const done = eventLog.recent({ type: 'cron.done' })
        expect(done).toHaveLength(1)
      })
      const done = eventLog.recent({ type: 'cron.done' })
      expect(done[0].payload).toMatchObject({
        reply: 'The script produced a plain-text operator note without structured fields.',
        delivered: true,
        parsedStatus: 'CRON_NOTIFY',
        parsedReason: 'unparsed response',
        parsedUnparsed: true,
      })
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

  describe('script jobs', () => {
    it('executes allowlisted script jobs without routing to AI', async () => {
      const delivered: string[] = []
      connectorCenter.register({
        channel: 'test',
        to: 'user1',
        capabilities: { push: true, media: false },
        send: async (payload) => { delivered.push(payload.text); return { delivered: true } },
      })

      const notificationPath = tempPath('json')
      const scriptRunner = vi.fn(async () => {
        await writeFile(notificationPath, JSON.stringify({
          shouldNotify: true,
          deliveryDecision: 'notify',
          headline: 'ETH carry is actionable again.',
          fullText: 'ETH carry is actionable again.\nState: ready_to_trade',
        }), 'utf-8')
        return { stdout: 'script ok\n', stderr: '' }
      })

      listener.stop()
      listener = createCronListener({
        connectorCenter,
        eventLog,
        agentCenter: mockEngine as any,
        session,
        scriptRunner,
      })
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'script123',
        jobName: 'eth_carry_refresh_pipeline_daily',
        kind: 'script',
        payload: '',
        script: {
          path: resolve('scripts/cron_eth_carry_refresh_pipeline.sh'),
          notificationPath,
        },
        pipelineContext: {
          schemaVersion: 'pipeline_run_context.v1',
          registryHash: '1'.repeat(64),
          registryEntryId: 'pipeline.scripts_cron_eth_carry_refresh_pipeline_sh',
          entrypoint: 'scripts/cron_eth_carry_refresh_pipeline.sh',
          owner: 'runtime-operations',
          safetyLevel: 'artifact_write',
          networkPolicy: 'readonly_public',
          timeoutSeconds: 900,
          lock: { policy: 'required', key: 'pipeline:eth-carry' },
          inputs: [],
          outputs: [],
        },
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        expect(delivered).toHaveLength(1)
      })

      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
      expect(scriptRunner).toHaveBeenCalledWith(
        resolve('scripts/cron_eth_carry_refresh_pipeline.sh'),
        [],
        { cwd: undefined, timeoutMs: 900_000 },
      )
      expect(delivered[0]).toBe('ETH carry is actionable again.\nState: ready_to_trade')
      const done = eventLog.recent({ type: 'cron.done' })
      expect(done[0].payload).toMatchObject({
        jobId: 'script123',
        jobName: 'eth_carry_refresh_pipeline_daily',
        delivered: true,
        parsedStatus: 'CRON_NOTIFY',
        parsedReason: 'ETH carry is actionable again.',
        pipelineReceipt: {
          schemaVersion: 'pipeline_execution_receipt.v1',
          receiptId: expect.stringMatching(/^[a-f0-9]{64}$/),
          registryEntryId: 'pipeline.scripts_cron_eth_carry_refresh_pipeline_sh',
          owner: 'runtime-operations',
          artifactLineage: { status: 'complete' },
        },
      })
    })

    it('fails closed for unsupported script jobs', async () => {
      const runner = vi.fn(async () => ({ stdout: '', stderr: '' }))

      listener.stop()
      listener = createCronListener({
        connectorCenter,
        eventLog,
        agentCenter: mockEngine as any,
        session,
        scriptRunner: runner,
      })
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'script123',
        jobName: 'unsafe-script',
        kind: 'script',
        payload: '',
        script: {
          path: '/repo/OpenAlice/scripts/delete_everything.sh',
        },
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        const errors = eventLog.recent({ type: 'cron.error' })
        expect(errors).toHaveLength(1)
      })

      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
      expect(runner).not.toHaveBeenCalled()
      const errors = eventLog.recent({ type: 'cron.error' })
      expect(errors[0].payload).toMatchObject({
        jobId: 'script123',
        jobName: 'unsafe-script',
      })
      expect((errors[0].payload as any).error).toContain('unsupported script cron job')
    })

    it.each([
      'scripts/cron_paper_policy_shadow_capture.sh',
      'scripts/cron_paper_policy_shadow_settle.sh',
      'scripts/cron_paper_pnl_diagnostics.sh',
      'scripts/cron_pro_policy_window.sh',
      'scripts/cron_microstructure_stoploss_replay.sh',
      'scripts/cron_dirty_worktree_audit.sh',
      'scripts/cron_scheduler_security_audit.sh',
      'scripts/cron_external_derivatives_data_collect.sh',
      'scripts/cron_p1_trading_evidence.sh',
      'scripts/cron_openalice_task.sh',
    ])('runs allowlisted paper diagnostic script %s without routing to the AI', async (scriptPath) => {
      const runner = vi.fn(async () => ({ stdout: 'script ok\n', stderr: '' }))

      listener.stop()
      listener = createCronListener({
        connectorCenter,
        eventLog,
        agentCenter: mockEngine as any,
        session,
        scriptRunner: runner,
      })
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: `script-${scriptPath}`,
        jobName: scriptPath,
        kind: 'script',
        payload: '',
        script: {
          path: resolve(scriptPath),
        },
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        const done = eventLog.recent({ type: 'cron.done' })
        expect(done).toHaveLength(1)
      })

      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
      expect(runner).toHaveBeenCalledWith(resolve(scriptPath), [], { cwd: undefined })
      const done = eventLog.recent({ type: 'cron.done' })
      expect(done[0].payload).toMatchObject({
        delivered: false,
        parsedStatus: 'CRON_SKIP',
      })
    })

    it('passes explicit task args to the shared OpenAlice cron wrapper', async () => {
      const runner = vi.fn(async () => ({ stdout: 'script ok\n', stderr: '' }))

      listener.stop()
      listener = createCronListener({
        connectorCenter,
        eventLog,
        agentCenter: mockEngine as any,
        session,
        scriptRunner: runner,
      })
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'okx-public-1s',
        jobName: 'okx_public_1s_accumulate_5m',
        kind: 'script',
        payload: '',
        script: {
          path: resolve('scripts/cron_openalice_task.sh'),
          args: ['accumulate_1s_data'],
          cwd: '/repo/OpenAlice',
        },
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        const done = eventLog.recent({ type: 'cron.done' })
        expect(done).toHaveLength(1)
      })

      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
      expect(runner).toHaveBeenCalledWith(
        resolve('scripts/cron_openalice_task.sh'),
        ['accumulate_1s_data'],
        { cwd: '/repo/OpenAlice' },
      )
    })

    it('runs unrelated allowlisted script jobs concurrently', async () => {
      let releaseFast!: () => void
      let releaseHealth!: () => void
      const fastBlocked = new Promise<void>((resolveBlocked) => { releaseFast = resolveBlocked })
      const healthBlocked = new Promise<void>((resolveBlocked) => { releaseHealth = resolveBlocked })
      const runner = vi.fn(async (_scriptPath: string, args: string[]) => {
        if (args[0] === 'fast') await fastBlocked
        if (args[0] === 'health') await healthBlocked
        return { stdout: 'script ok\n', stderr: '' }
      })

      listener.stop()
      listener = createCronListener({
        connectorCenter,
        eventLog,
        agentCenter: mockEngine as any,
        session,
        scriptRunner: runner,
      })
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'okx-fast',
        jobName: 'okx_public_fast_refresh_1m',
        kind: 'script',
        payload: '',
        script: { path: resolve('scripts/cron_okx_warehouse_task.sh'), args: ['fast'] },
      } satisfies CronFirePayload)
      await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1))

      await eventLog.append('cron.fire', {
        jobId: 'okx-health',
        jobName: 'okx_market_data_health_5m',
        kind: 'script',
        payload: '',
        script: { path: resolve('scripts/cron_okx_warehouse_task.sh'), args: ['health'] },
      } satisfies CronFirePayload)

      // The health job must start before the still-blocked fast job completes.
      await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2))
      expect(eventLog.recent({ type: 'cron.done' })).toHaveLength(0)

      releaseFast()
      releaseHealth()
      await vi.waitFor(() => expect(eventLog.recent({ type: 'cron.done' })).toHaveLength(2))
    })

    it('does not notify when script notification artifact suppresses delivery', async () => {
      const notifySpy = vi.spyOn(connectorCenter, 'notify')
      const macosNotificationSender = vi.fn(async () => ({ attempted: true, delivered: true, reason: 'delivered' }))
      const notificationPath = tempPath('json')

      listener.stop()
      listener = createCronListener({
        connectorCenter,
        eventLog,
        agentCenter: mockEngine as any,
        session,
        macosNotificationSender,
        scriptRunner: async () => {
          await writeFile(notificationPath, JSON.stringify({
            shouldNotify: false,
            deliveryDecision: 'suppress',
            headline: 'ETH carry unchanged.',
            fullText: 'ETH carry unchanged.',
            macosFallback: true,
          }), 'utf-8')
          return { stdout: 'script ok\n', stderr: '' }
        },
      })
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'script123',
        jobName: 'eth_carry_refresh_pipeline_daily',
        kind: 'script',
        payload: '',
        script: {
          path: resolve('scripts/cron_eth_carry_refresh_pipeline.sh'),
          notificationPath,
        },
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        const done = eventLog.recent({ type: 'cron.done' })
        expect(done).toHaveLength(1)
      })

      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
      expect(notifySpy).not.toHaveBeenCalled()
      expect(macosNotificationSender).not.toHaveBeenCalled()
      const done = eventLog.recent({ type: 'cron.done' })
      expect(done[0].payload).toMatchObject({
        delivered: false,
        parsedStatus: 'CRON_SKIP',
        parsedReason: 'ETH carry unchanged.',
      })
    })

    it('keeps routine research notifications in the event log without pushing them', async () => {
      const notifySpy = vi.spyOn(connectorCenter, 'notify')
      const notificationPath = tempPath('json')
      listener.stop()
      listener = createCronListener({
        connectorCenter,
        eventLog,
        agentCenter: mockEngine as any,
        session,
        scriptRunner: async () => {
          await writeFile(notificationPath, JSON.stringify({
            shouldNotify: true,
            headline: 'P1 evidence updated.',
            fullText: 'gateStatus=insufficient_data accepted=951',
          }), 'utf-8')
          return { stdout: '', stderr: '' }
        },
      })
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'p1-log-only',
        jobName: 'p1_trading_evidence_hourly',
        kind: 'script',
        payload: '',
        script: { path: resolve('scripts/cron_p1_trading_evidence.sh'), notificationPath },
        notificationState: { previousConsecutiveErrors: 0, previousErrorFingerprint: null, circuitOpenAfter: 0 },
      } satisfies CronFirePayload)

      await vi.waitFor(() => expect(eventLog.recent({ type: 'cron.done' })).toHaveLength(1))
      expect(notifySpy).not.toHaveBeenCalled()
      expect(eventLog.recent({ type: 'cron.done' })[0].payload).toMatchObject({
        reply: 'gateStatus=insufficient_data accepted=951',
        delivered: false,
        deliveryReason: 'suppressed:log_only',
        notificationPolicyReason: 'log_only',
        notificationClass: 'log_only',
      })
    })

    it('suppresses repeated script failures but retains the complete cron.error record', async () => {
      const notifySpy = vi.spyOn(connectorCenter, 'notify')
      const notificationPath = tempPath('json')
      listener.stop()
      listener = createCronListener({
        connectorCenter,
        eventLog,
        agentCenter: mockEngine as any,
        session,
        scriptRunner: async () => {
          throw new Error('corepack: command not found')
        },
      })
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'ssd-repeat',
        jobName: 'okx_ssd_presence_archive_probe_15m',
        kind: 'script',
        payload: '',
        script: { path: resolve('scripts/cron_okx_warehouse_task.sh'), args: ['ssd_probe'], notificationPath },
        notificationState: {
          previousConsecutiveErrors: 8,
          previousErrorFingerprint: fingerprintCronError(
            'okx_ssd_presence_archive_probe_15m',
            'corepack: command not found',
          ),
          circuitOpenAfter: 0,
        },
      } satisfies CronFirePayload)

      await vi.waitFor(() => expect(eventLog.recent({ type: 'cron.error' })).toHaveLength(1))
      expect(notifySpy).not.toHaveBeenCalled()
      expect(eventLog.recent({ type: 'cron.error' })[0].payload).toMatchObject({
        error: 'corepack: command not found',
        delivered: false,
        deliveryReason: 'suppressed:duplicate_failure',
        notificationPolicyReason: 'duplicate_failure',
        failureCount: 9,
      })
    })

    it('pushes one recovery transition for a previously failing log-only job', async () => {
      const delivered: string[] = []
      connectorCenter.register({
        channel: 'telegram',
        to: 'user1',
        capabilities: { push: true, media: false },
        send: async (payload) => { delivered.push(payload.text); return { delivered: true } },
      })
      listener.stop()
      listener = createCronListener({
        connectorCenter,
        eventLog,
        agentCenter: mockEngine as any,
        session,
        scriptRunner: async () => ({ stdout: 'compact ok\n', stderr: '' }),
      })
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'warehouse-recovered',
        jobName: 'okx_warehouse_compact_hourly',
        kind: 'script',
        payload: '',
        script: { path: resolve('scripts/cron_okx_warehouse_task.sh'), args: ['compact'] },
        notificationState: {
          previousConsecutiveErrors: 12,
          previousErrorFingerprint: 'prior',
          circuitOpenAfter: 0,
        },
      } satisfies CronFirePayload)

      await vi.waitFor(() => expect(eventLog.recent({ type: 'cron.done' })).toHaveLength(1))
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toContain('OpenAlice cron job recovered.')
      expect(delivered[0]).toContain('previousConsecutiveErrors=12')
      expect(eventLog.recent({ type: 'cron.done' })[0].payload).toMatchObject({
        delivered: true,
        notificationPolicyReason: 'recovered',
        notificationClass: 'recovery',
      })
    })

    it('does not invoke macOS fallback when the primary connector delivers', async () => {
      connectorCenter.register({
        channel: 'telegram',
        to: 'user1',
        capabilities: { push: true, media: false },
        send: async () => ({ delivered: true }),
      })
      const macosNotificationSender = vi.fn(async () => ({ attempted: true, delivered: true, reason: 'delivered' }))
      const notificationPath = tempPath('json')
      listener.stop()
      listener = createCronListener({
        connectorCenter,
        eventLog,
        agentCenter: mockEngine as any,
        session,
        macosNotificationSender,
        scriptRunner: async () => {
          await writeFile(notificationPath, JSON.stringify({
            shouldNotify: true,
            fullText: 'Connect shield.',
            macosFallback: true,
          }), 'utf-8')
          return { stdout: '', stderr: '' }
        },
      })
      listener.start()
      await eventLog.append('cron.fire', {
        jobId: 'ssd-reminder-primary', jobName: 'okx_ssd_weekly_reminder_sunday', kind: 'script', payload: '',
        script: { path: resolve('scripts/cron_okx_warehouse_task.sh'), args: ['ssd_reminder_weekly'], notificationPath },
      } satisfies CronFirePayload)
      await vi.waitFor(() => expect(eventLog.recent({ type: 'cron.done' })).toHaveLength(1))
      expect(macosNotificationSender).not.toHaveBeenCalled()
      expect(eventLog.recent({ type: 'cron.done' })[0].payload).toMatchObject({
        delivered: true, primaryDelivered: true, fallbackDelivered: false, deliveryChannel: 'telegram',
      })
    })

    it('uses macOS fallback and records success when the primary connector cannot deliver', async () => {
      connectorCenter.register({
        channel: 'telegram',
        to: 'user1',
        capabilities: { push: true, media: false },
        send: async () => ({ delivered: false, reason: 'connector_not_ready' }),
      })
      const macosNotificationSender = vi.fn(async () => ({ attempted: true, delivered: true, reason: 'delivered' }))
      const notificationPath = tempPath('json')
      const receiptPath = tempPath('jsonl')
      listener.stop()
      listener = createCronListener({
        connectorCenter,
        eventLog,
        agentCenter: mockEngine as any,
        session,
        macosNotificationSender,
        scriptRunner: async () => {
          await writeFile(notificationPath, JSON.stringify({
            shouldNotify: true,
            fullText: 'Connect shield.',
            macosFallback: true,
            deliveryReceiptPath: receiptPath,
            receiptContext: { weekId: '2026-W29', messageType: 'connect_ssd' },
          }), 'utf-8')
          return { stdout: '', stderr: '' }
        },
      })
      listener.start()
      await eventLog.append('cron.fire', {
        jobId: 'ssd-reminder-fallback', jobName: 'okx_ssd_weekly_reminder_sunday', kind: 'script', payload: '',
        script: { path: resolve('scripts/cron_okx_warehouse_task.sh'), args: ['ssd_reminder_weekly'], notificationPath },
      } satisfies CronFirePayload)
      await vi.waitFor(() => expect(eventLog.recent({ type: 'cron.done' })).toHaveLength(1))
      expect(macosNotificationSender).toHaveBeenCalledWith('Connect shield.')
      expect(eventLog.recent({ type: 'cron.done' })[0].payload).toMatchObject({
        delivered: true, primaryDelivered: false, fallbackDelivered: true,
        deliveryReason: 'fallback_delivered', deliveryChannel: 'macos_notification_center',
      })
      await expect(readFile(receiptPath, 'utf-8')).resolves.toContain('"fallback":{"attempted":true,"delivered":true')
    })

    it('records structured failure when both primary and macOS fallback fail', async () => {
      const macosNotificationSender = vi.fn(async () => ({ attempted: true, delivered: false, reason: 'notification_center_unavailable' }))
      const notificationPath = tempPath('json')
      const receiptPath = tempPath('jsonl')
      listener.stop()
      listener = createCronListener({
        connectorCenter,
        eventLog,
        agentCenter: mockEngine as any,
        session,
        macosNotificationSender,
        scriptRunner: async () => {
          await writeFile(notificationPath, JSON.stringify({
            shouldNotify: true,
            fullText: 'Connect shield.',
            macosFallback: true,
            deliveryReceiptPath: receiptPath,
          }), 'utf-8')
          return { stdout: '', stderr: '' }
        },
      })
      listener.start()
      await eventLog.append('cron.fire', {
        jobId: 'ssd-reminder-both-fail', jobName: 'okx_ssd_weekly_reminder_sunday', kind: 'script', payload: '',
        script: { path: resolve('scripts/cron_okx_warehouse_task.sh'), args: ['ssd_reminder_weekly'], notificationPath },
      } satisfies CronFirePayload)
      await vi.waitFor(() => expect(eventLog.recent({ type: 'cron.done' })).toHaveLength(1))
      expect(eventLog.recent({ type: 'cron.done' })[0].payload).toMatchObject({
        delivered: false, primaryDelivered: false, fallbackDelivered: false,
        deliveryReason: 'no_push_connector;fallback=notification_center_unavailable',
      })
      const receipt = JSON.parse((await readFile(receiptPath, 'utf-8')).trim())
      expect(receipt).toMatchObject({
        delivered: false,
        primary: { delivered: false, reason: 'no_push_connector' },
        fallback: { attempted: true, delivered: false, reason: 'notification_center_unavailable' },
      })
    })

    it('delivers script notification artifacts even when the script exits non-zero', async () => {
      const delivered: string[] = []
      connectorCenter.register({
        channel: 'test',
        to: 'user1',
        capabilities: { push: true, media: false },
        send: async (payload) => { delivered.push(payload.text); return { delivered: true } },
      })

      const notificationPath = tempPath('json')

      listener.stop()
      listener = createCronListener({
        connectorCenter,
        eventLog,
        agentCenter: mockEngine as any,
        session,
        scriptRunner: async () => {
          await writeFile(notificationPath, JSON.stringify({
            shouldNotify: true,
            deliveryDecision: 'notify',
            headline: 'External derivatives collector failed.',
            content: 'runId=failed exitCode=1 errors=1 firstError=ETHUSDT/fundingRate:timeout',
          }), 'utf-8')
          throw new Error('script exited with code 1')
        },
      })
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'external-derivatives-fail',
        jobName: 'external_derivatives_data_collect_8h',
        kind: 'script',
        payload: '',
        script: {
          path: resolve('scripts/cron_external_derivatives_data_collect.sh'),
          notificationPath,
        },
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        expect(delivered).toHaveLength(1)
      })

      expect(delivered[0]).toBe('runId=failed exitCode=1 errors=1 firstError=ETHUSDT/fundingRate:timeout')
      const errors = eventLog.recent({ type: 'cron.error' })
      expect(errors[0].payload).toMatchObject({
        jobId: 'external-derivatives-fail',
        jobName: 'external_derivatives_data_collect_8h',
        delivered: true,
        parsedStatus: 'CRON_NOTIFY',
        parsedReason: 'External derivatives collector failed.',
        reply: 'runId=failed exitCode=1 errors=1 firstError=ETHUSDT/fundingRate:timeout',
      })
    })

    it('delivers a fallback notification when a script fails before writing its notification artifact', async () => {
      const delivered: string[] = []
      connectorCenter.register({
        channel: 'test',
        to: 'user1',
        capabilities: { push: true, media: false },
        send: async (payload) => { delivered.push(payload.text); return { delivered: true } },
      })

      const notificationPath = tempPath('json')
      listener.stop()
      listener = createCronListener({
        connectorCenter,
        eventLog,
        agentCenter: mockEngine as any,
        session,
        scriptRunner: async () => {
          throw new Error('script exited before notification')
        },
      })
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'external-derivatives-no-artifact',
        jobName: 'external_derivatives_data_collect_8h',
        kind: 'script',
        payload: '',
        script: {
          path: resolve('scripts/cron_external_derivatives_data_collect.sh'),
          notificationPath,
        },
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        expect(delivered).toHaveLength(1)
      })

      expect(delivered[0]).toContain('script cron failed before notification artifact was written')
      expect(delivered[0]).toContain('jobId=external-derivatives-no-artifact')
      expect(delivered[0]).toContain('jobName=external_derivatives_data_collect_8h')
      expect(delivered[0]).toContain('error=script exited before notification')
      const errors = eventLog.recent({ type: 'cron.error' })
      expect(errors[0].payload).toMatchObject({
        jobId: 'external-derivatives-no-artifact',
        jobName: 'external_derivatives_data_collect_8h',
        delivered: true,
        parsedStatus: 'CRON_NOTIFY',
        parsedReason: 'script cron failed before notification artifact was written',
      })
      expect((errors[0].payload as any).reply).toContain('notification artifact was written')
    })

    it('ignores stale notification artifacts from previous runs when script fails', async () => {
      const delivered: string[] = []
      connectorCenter.register({
        channel: 'test',
        to: 'user1',
        capabilities: { push: true, media: false },
        send: async (payload) => { delivered.push(payload.text); return { delivered: true } },
      })

      const notificationPath = tempPath('json')
      await writeFile(notificationPath, JSON.stringify({
        shouldNotify: true,
        deliveryDecision: 'notify',
        headline: 'Stale prior success',
        fullText: 'this stale text must not be delivered',
      }), 'utf-8')
      const staleDate = new Date(Date.now() - 60_000)
      await utimes(notificationPath, staleDate, staleDate)

      listener.stop()
      listener = createCronListener({
        connectorCenter,
        eventLog,
        agentCenter: mockEngine as any,
        session,
        scriptRunner: async () => {
          throw new Error('fresh script failure')
        },
      })
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'stale-artifact-fail',
        jobName: 'external_derivatives_data_collect_8h',
        kind: 'script',
        payload: '',
        script: {
          path: resolve('scripts/cron_external_derivatives_data_collect.sh'),
          notificationPath,
        },
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        expect(delivered).toHaveLength(1)
      })

      expect(delivered[0]).toContain('script cron failed before notification artifact was written')
      expect(delivered[0]).toContain('error=fresh script failure')
      expect(delivered[0]).not.toContain('stale text')
      const errors = eventLog.recent({ type: 'cron.error' })
      expect(errors[0].payload).toMatchObject({
        jobId: 'stale-artifact-fail',
        parsedReason: 'script cron failed before notification artifact was written',
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

    it('records a cron.dropped event when a second cron.fire arrives while processing', async () => {
      let release!: () => void
      const blocker = new Promise<void>(resolveBlocker => { release = resolveBlocker })
      mockEngine.askWithSession.mockImplementationOnce(async () => {
        await blocker
        return { text: 'STATUS: CRON_SKIP\nREASON: done', media: [] }
      })
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'first-job',
        jobName: 'first-job',
        payload: 'long job',
      } satisfies CronFirePayload)
      await vi.waitFor(() => {
        expect(mockEngine.askWithSession).toHaveBeenCalledTimes(1)
      })
      await eventLog.append('cron.fire', {
        jobId: 'second-job',
        jobName: 'second-job',
        payload: 'should be dropped',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        const dropped = eventLog.recent({ type: 'cron.dropped' })
        expect(dropped).toHaveLength(1)
      })
      const dropped = eventLog.recent({ type: 'cron.dropped' })
      expect(dropped[0].payload).toMatchObject({
        jobId: 'second-job',
        jobName: 'second-job',
        reason: 'listener_already_processing',
        droppedWhileProcessing: true,
      })

      release()
      await vi.waitFor(() => {
        const done = eventLog.recent({ type: 'cron.done' })
        expect(done).toHaveLength(1)
      })
    })

    it('does not drop allowlisted script jobs while an AI cron job is processing', async () => {
      let release!: () => void
      const blocker = new Promise<void>(resolveBlocker => { release = resolveBlocker })
      const runner = vi.fn(async () => ({ stdout: 'script ok\n', stderr: '' }))
      mockEngine.askWithSession.mockImplementationOnce(async () => {
        await blocker
        return { text: 'STATUS: CRON_SKIP\nREASON: done', media: [] }
      })

      listener.stop()
      listener = createCronListener({
        connectorCenter,
        eventLog,
        agentCenter: mockEngine as any,
        session,
        scriptRunner: runner,
      })
      listener.start()

      await eventLog.append('cron.fire', {
        jobId: 'long-ai-job',
        jobName: 'long-ai-job',
        payload: 'long job',
      } satisfies CronFirePayload)
      await vi.waitFor(() => {
        expect(mockEngine.askWithSession).toHaveBeenCalledTimes(1)
      })

      await eventLog.append('cron.fire', {
        jobId: 'okx-public-5m',
        jobName: 'okx_public_5m_accumulate_5m',
        kind: 'script',
        payload: '',
        script: {
          path: resolve('scripts/cron_openalice_task.sh'),
          args: ['accumulate_5m_data'],
        },
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        expect(runner).toHaveBeenCalledTimes(1)
      })
      expect(runner).toHaveBeenCalledWith(
        resolve('scripts/cron_openalice_task.sh'),
        ['accumulate_5m_data'],
        { cwd: undefined },
      )
      expect(eventLog.recent({ type: 'cron.dropped' })).toHaveLength(0)

      release()
      await vi.waitFor(() => {
        const done = eventLog.recent({ type: 'cron.done' })
        expect(done.map(entry => (entry.payload as any).jobId)).toEqual(
          expect.arrayContaining(['long-ai-job', 'okx-public-5m']),
        )
      })
    })
  })

  // ==================== Lifecycle ====================

  describe('lifecycle', () => {
    it('replays unmatched cron.fire events that existed before listener start', async () => {
      const fire = await eventLog.append('cron.fire', {
        jobId: 'pre-start-fire',
        jobName: 'pre-start-fire',
        payload: 'replay me',
      } satisfies CronFirePayload)

      listener.start()

      await vi.waitFor(() => {
        expect(mockEngine.askWithSession).toHaveBeenCalledTimes(1)
      })

      expect(mockEngine.askWithSession).toHaveBeenCalledWith(
        'replay me',
        session,
        expect.objectContaining({ historyPreamble: expect.any(String) }),
      )
      await vi.waitFor(() => {
        const done = eventLog.recent({ type: 'cron.done' })
        expect(done).toHaveLength(1)
      })
      const done = eventLog.recent({ type: 'cron.done' })
      expect(done[0].payload).toMatchObject({
        jobId: 'pre-start-fire',
        sourceFireSeq: fire.seq,
      })
    })

    it('does not replay startup cron.fire events that already have source-linked completion', async () => {
      const fire = await eventLog.append('cron.fire', {
        jobId: 'already-done-fire',
        jobName: 'already-done-fire',
        payload: 'do not replay',
      } satisfies CronFirePayload)
      await eventLog.append('cron.done', {
        jobId: 'already-done-fire',
        jobName: 'already-done-fire',
        sourceFireSeq: fire.seq,
        reply: 'ok',
        durationMs: 1,
        delivered: false,
      })

      listener.start()

      await new Promise((r) => setTimeout(r, 50))
      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
    })

    it('replays only the unmatched latest fire when legacy completion precedes another same-job fire', async () => {
      await eventLog.append('cron.fire', {
        jobId: 'legacy-job',
        jobName: 'legacy-job',
        payload: 'old fire',
      } satisfies CronFirePayload)
      await eventLog.append('cron.done', {
        jobId: 'legacy-job',
        jobName: 'legacy-job',
        reply: 'legacy completion without sourceFireSeq',
        durationMs: 1,
        delivered: false,
      })
      const latestFire = await eventLog.append('cron.fire', {
        jobId: 'legacy-job',
        jobName: 'legacy-job',
        payload: 'latest fire',
      } satisfies CronFirePayload)

      listener.start()

      await vi.waitFor(() => {
        expect(mockEngine.askWithSession).toHaveBeenCalledTimes(1)
      })

      expect(mockEngine.askWithSession).toHaveBeenCalledWith(
        'latest fire',
        session,
        expect.objectContaining({ historyPreamble: expect.any(String) }),
      )
      await vi.waitFor(() => {
        const done = eventLog.recent({ type: 'cron.done' })
        expect(done).toHaveLength(2)
      })
      const done = eventLog.recent({ type: 'cron.done' })
      expect(done[1].payload).toMatchObject({
        jobId: 'legacy-job',
        sourceFireSeq: latestFire.seq,
      })
    })

    it('does not replay an accumulated backlog of unmatched fires for the same job', async () => {
      await eventLog.append('cron.fire', {
        jobId: 'one-minute-job',
        jobName: 'one-minute-job',
        payload: 'stale tick 1',
      } satisfies CronFirePayload)
      await eventLog.append('cron.fire', {
        jobId: 'one-minute-job',
        jobName: 'one-minute-job',
        payload: 'stale tick 2',
      } satisfies CronFirePayload)
      const latestFire = await eventLog.append('cron.fire', {
        jobId: 'one-minute-job',
        jobName: 'one-minute-job',
        payload: 'latest tick',
      } satisfies CronFirePayload)

      listener.start()

      await vi.waitFor(() => expect(mockEngine.askWithSession).toHaveBeenCalledTimes(1))
      expect(mockEngine.askWithSession).toHaveBeenCalledWith(
        'latest tick',
        session,
        expect.objectContaining({ historyPreamble: expect.any(String) }),
      )
      await vi.waitFor(() => expect(eventLog.recent({ type: 'cron.done' })).toHaveLength(1))
      expect(eventLog.recent({ type: 'cron.done' })[0].payload).toMatchObject({
        jobId: 'one-minute-job',
        sourceFireSeq: latestFire.seq,
      })
    })

    it('does not replay periodic script fires after restart', async () => {
      const runner = vi.fn(async () => ({ stdout: 'script ok\n', stderr: '' }))
      listener.stop()
      listener = createCronListener({
        connectorCenter,
        eventLog,
        agentCenter: mockEngine as any,
        session,
        scriptRunner: runner,
      })
      await eventLog.append('cron.fire', {
        jobId: 'okx-fast-before-restart',
        jobName: 'okx_public_fast_refresh_1m',
        kind: 'script',
        payload: '',
        script: { path: resolve('scripts/cron_okx_warehouse_task.sh'), args: ['fast'] },
      } satisfies CronFirePayload)

      listener.start()

      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
      expect(runner).not.toHaveBeenCalled()
      expect(eventLog.recent({ type: 'cron.done' })).toHaveLength(0)
      expect(eventLog.recent({ type: 'cron.error' })).toHaveLength(0)
    })

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

describe('parseCronResponse', () => {
  it('should parse CRON_SKIP with reason', () => {
    const r = parseCronResponse('STATUS: CRON_SKIP\nREASON: no notification needed.')
    expect(r.status).toBe('CRON_SKIP')
    expect(r.reason).toBe('no notification needed.')
    expect(r.content).toBe('')
    expect(r.unparsed).toBe(false)
  })

  it('should parse CRON_NOTIFY with content', () => {
    const r = parseCronResponse([
      'STATUS: CRON_NOTIFY',
      'REASON: notification needed.',
      'CONTENT: send this to the user.',
    ].join('\n'))
    expect(r.status).toBe('CRON_NOTIFY')
    expect(r.reason).toBe('notification needed.')
    expect(r.content).toBe('send this to the user.')
    expect(r.unparsed).toBe(false)
  })

  it('should fail open on unstructured text', () => {
    const r = parseCronResponse('plain text note')
    expect(r.status).toBe('CRON_NOTIFY')
    expect(r.reason).toBe('unparsed response')
    expect(r.content).toBe('plain text note')
    expect(r.unparsed).toBe(true)
  })
})
