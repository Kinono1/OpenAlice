import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { createCronEngine, parseDuration, nextCronFire, computeNextRun } from './engine.js'
import { createEventLog, type EventLog, type EventLogEntry } from '../../core/event-log.js'
import type { CronEngine, CronFirePayload } from './engine.js'

function tempPath(ext: string): string {
  return join(tmpdir(), `cron-test-${randomUUID()}.${ext}`)
}

describe('cron engine', () => {
  let eventLog: EventLog
  let engine: CronEngine
  let storePath: string
  let logPath: string
  let clock: number

  beforeEach(async () => {
    logPath = tempPath('jsonl')
    storePath = tempPath('json')
    eventLog = await createEventLog({ logPath })
    clock = Date.now()
    engine = createCronEngine({
      eventLog,
      storePath,
      now: () => clock,
    })
  })

  afterEach(async () => {
    engine.stop()
    await eventLog._resetForTest()
    try { await unlink(storePath) } catch { /* ok */ }
  })

  it('fails closed for research when a registry job lacks an explicit role allowlist', async () => {
    const previousRole = process.env.OPENALICE_RUNTIME_ROLE
    const definitionPath = tempPath('definitions.json')
    try {
      process.env.OPENALICE_RUNTIME_ROLE = 'research'
      await writeFile(definitionPath, JSON.stringify({
        schemaVersion: 'cron_definition_registry.v1',
        jobs: [{
          id: 'missing-role', name: 'missing-role', enabled: true, kind: 'script',
          schedule: { kind: 'every', every: '1h' }, payload: '',
          entrypoint: 'scripts/cron_dirty_worktree_audit.sh', args: [], cwd: '.',
        }],
      }))
      const researchEngine = createCronEngine({
        eventLog,
        storePath,
        definitionPath,
        now: () => clock,
      })
      await expect(researchEngine.start()).rejects.toThrow('cron_runtime_role_allowlist_missing:missing-role')
      researchEngine.stop()
    } finally {
      if (previousRole === undefined) delete process.env.OPENALICE_RUNTIME_ROLE
      else process.env.OPENALICE_RUNTIME_ROLE = previousRole
      await unlink(definitionPath).catch(() => undefined)
    }
  })

  it('fails closed for persisted dynamic jobs that bypass the static registry', async () => {
    const previousRole = process.env.OPENALICE_RUNTIME_ROLE
    const definitionPath = tempPath('definitions.json')
    const dynamicDefinitionPath = tempPath('dynamic-definitions.json')
    try {
      process.env.OPENALICE_RUNTIME_ROLE = 'research'
      await writeFile(definitionPath, JSON.stringify({
        schemaVersion: 'cron_definition_registry.v1',
        jobs: [{
          id: 'allowed-static', name: 'allowed-static', enabled: false, kind: 'script',
          schedule: { kind: 'every', every: '1h' }, payload: '',
          entrypoint: 'scripts/cron_dirty_worktree_audit.sh', args: [], cwd: '.',
          allowedRuntimeRoles: ['primary', 'research'],
        }],
      }))
      await writeFile(dynamicDefinitionPath, JSON.stringify({
        schemaVersion: 'cron_dynamic_definitions.v1',
        definitions: [{
          id: 'dynamic-missing-role', name: 'dynamic-missing-role', enabled: false,
          kind: 'agent', schedule: { kind: 'every', every: '1h' }, payload: 'research',
        }],
      }))
      const researchEngine = createCronEngine({
        eventLog,
        storePath,
        definitionPath,
        dynamicDefinitionPath,
        now: () => clock,
      })
      await expect(researchEngine.start()).rejects.toThrow(
        'cron_runtime_role_allowlist_missing:dynamic-missing-role',
      )
      researchEngine.stop()
    } finally {
      if (previousRole === undefined) delete process.env.OPENALICE_RUNTIME_ROLE
      else process.env.OPENALICE_RUNTIME_ROLE = previousRole
      await unlink(definitionPath).catch(() => undefined)
      await unlink(dynamicDefinitionPath).catch(() => undefined)
    }
  })

  it('excludes primary-only autonomous jobs while retaining research-safe jobs', async () => {
    const previousRole = process.env.OPENALICE_RUNTIME_ROLE
    const definitionPath = tempPath('definitions.json')
    try {
      process.env.OPENALICE_RUNTIME_ROLE = 'research'
      await writeFile(definitionPath, JSON.stringify({
        schemaVersion: 'cron_definition_registry.v1',
        jobs: [
          {
            id: 'primary-heartbeat', name: '__heartbeat__', enabled: true, kind: 'agent',
            schedule: { kind: 'every', every: '15m' }, payload: 'autonomous',
            allowedRuntimeRoles: ['primary'],
          },
          {
            id: 'research-audit', name: 'dirty_worktree_audit_daily', enabled: false, kind: 'script',
            schedule: { kind: 'every', every: '1h' }, payload: '',
            entrypoint: 'scripts/cron_dirty_worktree_audit.sh', args: [], cwd: '.',
            allowedRuntimeRoles: ['primary', 'research'],
          },
        ],
      }))
      const researchEngine = createCronEngine({
        eventLog,
        storePath,
        definitionPath,
        now: () => clock,
      })
      await researchEngine.start()
      expect(researchEngine.list().map((job) => job.id)).toEqual(['research-audit'])
      researchEngine.stop()
    } finally {
      if (previousRole === undefined) delete process.env.OPENALICE_RUNTIME_ROLE
      else process.env.OPENALICE_RUNTIME_ROLE = previousRole
      await unlink(definitionPath).catch(() => undefined)
    }
  })

  it('fails closed when a sensitive paper/order job is incorrectly opted into research', async () => {
    const previousRole = process.env.OPENALICE_RUNTIME_ROLE
    const definitionPath = tempPath('definitions.json')
    try {
      process.env.OPENALICE_RUNTIME_ROLE = 'research'
      await writeFile(definitionPath, JSON.stringify({
        schemaVersion: 'cron_definition_registry.v1',
        jobs: [{
          id: 'bad-paper-job', name: 'paper_policy_shadow_settle_5m', enabled: true, kind: 'script',
          schedule: { kind: 'every', every: '5m' }, payload: '',
          entrypoint: 'scripts/cron_paper_policy_shadow_settle.sh', args: [], cwd: '.',
          allowedRuntimeRoles: ['primary', 'research'],
        }],
      }))
      const researchEngine = createCronEngine({
        eventLog,
        storePath,
        definitionPath,
        now: () => clock,
      })
      await expect(researchEngine.start()).rejects.toThrow('cron_research_sensitive_job_forbidden:bad-paper-job')
      researchEngine.stop()
    } finally {
      if (previousRole === undefined) delete process.env.OPENALICE_RUNTIME_ROLE
      else process.env.OPENALICE_RUNTIME_ROLE = previousRole
      await unlink(definitionPath).catch(() => undefined)
    }
  })

  it('fails closed when a non-sensitive agent job is incorrectly opted into research', async () => {
    const previousRole = process.env.OPENALICE_RUNTIME_ROLE
    const definitionPath = tempPath('definitions.json')
    try {
      process.env.OPENALICE_RUNTIME_ROLE = 'research'
      await writeFile(definitionPath, JSON.stringify({
        schemaVersion: 'cron_definition_registry.v1',
        jobs: [{
          id: 'bad-agent-job', name: 'routine_status_note', enabled: true, kind: 'agent',
          schedule: { kind: 'every', every: '1h' }, payload: 'summarize status',
          allowedRuntimeRoles: ['primary', 'research'],
        }],
      }))
      const researchEngine = createCronEngine({
        eventLog,
        storePath,
        definitionPath,
        now: () => clock,
      })
      await expect(researchEngine.start()).rejects.toThrow('cron_research_agent_job_forbidden:bad-agent-job')
      researchEngine.stop()
    } finally {
      if (previousRole === undefined) delete process.env.OPENALICE_RUNTIME_ROLE
      else process.env.OPENALICE_RUNTIME_ROLE = previousRole
      await unlink(definitionPath).catch(() => undefined)
    }
  })

  // ==================== Job CRUD ====================

  describe('CRUD', () => {
    it('should add a job and list it', async () => {
      const id = await engine.add({
        name: 'test',
        schedule: { kind: 'every', every: '1h' },
        payload: 'hello',
      })

      expect(id).toHaveLength(8)
      const jobs = engine.list()
      expect(jobs).toHaveLength(1)
      expect(jobs[0]).toMatchObject({
        id,
        name: 'test',
        enabled: true,
        payload: 'hello',
        schedule: { kind: 'every', every: '1h' },
      })
    })

    it('should add a script job and emit script metadata on fire', async () => {
      const fired: EventLogEntry[] = []
      eventLog.subscribeType('cron.fire', (e) => fired.push(e))

      const id = await engine.add({
        name: 'script-job',
        kind: 'script',
        schedule: { kind: 'every', every: '1h' },
        payload: '',
        script: {
          path: '/repo/OpenAlice/scripts/cron_eth_carry_refresh_pipeline.sh',
          cwd: '/repo/OpenAlice',
          notificationPath: '/repo/OpenAlice/data/runtime/eth_carry_status/eth_carry_actionability_notification.json',
        },
      })

      await engine.runNow(id)

      expect(fired).toHaveLength(1)
      const p = fired[0].payload as CronFirePayload
      expect(p).toMatchObject({
        jobId: id,
        jobName: 'script-job',
        kind: 'script',
        payload: '',
        script: {
          path: '/repo/OpenAlice/scripts/cron_eth_carry_refresh_pipeline.sh',
          cwd: '/repo/OpenAlice',
        },
        notificationState: {
          previousConsecutiveErrors: 0,
          previousErrorFingerprint: null,
          circuitOpenAfter: 0,
        },
      })
    })

    it('should get a job by id', async () => {
      const id = await engine.add({
        name: 'get-test',
        schedule: { kind: 'every', every: '30m' },
        payload: 'x',
      })

      const job = engine.get(id)
      expect(job).toBeDefined()
      expect(job!.name).toBe('get-test')
    })

    it('should update a job', async () => {
      const id = await engine.add({
        name: 'before',
        schedule: { kind: 'every', every: '1h' },
        payload: 'old',
      })

      await engine.update(id, { name: 'after', payload: 'new' })

      const job = engine.get(id)
      expect(job!.name).toBe('after')
      expect(job!.payload).toBe('new')
    })

    it('should update schedule and recompute nextRunAtMs', async () => {
      const id = await engine.add({
        name: 'sched',
        schedule: { kind: 'every', every: '1h' },
        payload: 'x',
      })

      const before = engine.get(id)!.state.nextRunAtMs

      await engine.update(id, { schedule: { kind: 'every', every: '2h' } })

      const after = engine.get(id)!.state.nextRunAtMs
      expect(after).not.toBe(before)
    })

    it('should recompute nextRunAtMs when enabling a disabled recurring job', async () => {
      const id = await engine.add({
        name: 'enable-later',
        schedule: { kind: 'cron', cron: '*/5 * * * *' },
        payload: 'x',
        enabled: false,
      })
      expect(engine.get(id)!.state.nextRunAtMs).toBeNull()

      await engine.update(id, { enabled: true })

      expect(engine.get(id)!.enabled).toBe(true)
      expect(engine.get(id)!.state.nextRunAtMs).toBeGreaterThan(clock)
    })

    it('should clear nextRunAtMs when disabling a recurring job', async () => {
      const id = await engine.add({
        name: 'disable-now',
        schedule: { kind: 'every', every: '1h' },
        payload: 'x',
      })
      expect(engine.get(id)!.state.nextRunAtMs).not.toBeNull()

      await engine.update(id, { enabled: false })

      expect(engine.get(id)!.enabled).toBe(false)
      expect(engine.get(id)!.state.nextRunAtMs).toBeNull()
    })

    it('should remove a job', async () => {
      const id = await engine.add({
        name: 'rm',
        schedule: { kind: 'every', every: '1h' },
        payload: 'x',
      })

      await engine.remove(id)
      expect(engine.list()).toHaveLength(0)
    })

    it('should throw on update of nonexistent job', async () => {
      await expect(engine.update('nope', { name: 'x' })).rejects.toThrow('not found')
    })

    it('should throw on remove of nonexistent job', async () => {
      await expect(engine.remove('nope')).rejects.toThrow('not found')
    })

    it('should add disabled job', async () => {
      const id = await engine.add({
        name: 'off',
        schedule: { kind: 'every', every: '1h' },
        payload: 'x',
        enabled: false,
      })

      expect(engine.get(id)!.enabled).toBe(false)
    })
  })

  // ==================== runNow ====================

  describe('runNow', () => {
    it('should fire a cron.fire event immediately', async () => {
      const fired: EventLogEntry[] = []
      eventLog.subscribeType('cron.fire', (e) => fired.push(e))

      const id = await engine.add({
        name: 'manual',
        schedule: { kind: 'every', every: '1h' },
        payload: 'run me now',
      })

      await engine.runNow(id)

      expect(fired).toHaveLength(1)
      const p = fired[0].payload as CronFirePayload
      expect(p.jobId).toBe(id)
      expect(p.payload).toBe('run me now')
    })

    it('marks a fired job as pending until the listener reports completion', async () => {
      const id = await engine.add({
        name: 'state-check',
        schedule: { kind: 'every', every: '1h' },
        payload: 'x',
      })

      await engine.runNow(id)

      const job = engine.get(id)!
      expect(job.state.lastRunAtMs).toBe(clock)
      expect(job.state.lastStatus).toBe('fired')
      expect(job.state.consecutiveErrors).toBe(0)
    })

    it('marks a fired job ok after cron.done', async () => {
      const id = await engine.add({
        name: 'done-check',
        schedule: { kind: 'every', every: '1h' },
        payload: 'x',
      })

      await engine.runNow(id)
      await eventLog.append('cron.done', {
        jobId: id,
        jobName: 'done-check',
        reply: 'ok',
        durationMs: 5,
        delivered: false,
      })

      const job = engine.get(id)!
      expect(job.state.lastStatus).toBe('ok')
      expect(job.state.consecutiveErrors).toBe(0)
    })

    it('keeps a fixed-schedule job on its normal schedule after cron.error', async () => {
      const id = await engine.add({
        name: 'error-check',
        schedule: { kind: 'every', every: '1h' },
        payload: 'x',
      })

      await engine.runNow(id)
      await eventLog.append('cron.error', {
        jobId: id,
        jobName: 'error-check',
        error: 'script failed',
        durationMs: 5,
      })

      const job = engine.get(id)!
      expect(job.state.lastStatus).toBe('error')
      expect(job.state.consecutiveErrors).toBe(1)
      expect(job.state.nextRunAtMs).toBeGreaterThanOrEqual(clock + 60 * 60 * 1000)
      expect(job.state.nextRunAtMs).toBeLessThan(clock + 60 * 60 * 1000 + 1_000)
      expect(job.state.lastErrorClass).toBe('execution_error')
    })

    it('uses bounded backoff and opens a circuit after the configured failure count', async () => {
      const id = await engine.add({
        name: 'network-check',
        schedule: { kind: 'cron', cron: '7 */8 * * *', timezone: 'UTC' },
        payload: 'x',
        retryPolicy: { mode: 'bounded-backoff', maxAttempts: 2, circuitOpenAfter: 3 },
      })

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await engine.runNow(id)
        await eventLog.append('cron.error', {
          jobId: id,
          jobName: 'network-check',
          error: 'fetch timed out',
          errorClass: 'transient_network',
          errorFingerprint: 'timeout-fingerprint',
          permanent: false,
          durationMs: 5,
        })
      }

      const job = engine.get(id)!
      expect(job.state.lastStatus).toBe('blocked')
      expect(job.state.consecutiveErrors).toBe(3)
      expect(job.state.circuitOpenedAtMs).toBeGreaterThanOrEqual(clock)
      expect(job.state.circuitOpenedAtMs).toBeLessThan(clock + 1_000)
      expect(job.state.nextRunAtMs).toBeNull()
      expect(job.state.lastErrorFingerprint).toBe('timeout-fingerprint')
    })

    it('does not back off permanent failures between normal cron runs', async () => {
      const id = await engine.add({
        name: 'permanent-check',
        schedule: { kind: 'cron', cron: '7 */8 * * *', timezone: 'UTC' },
        payload: 'x',
        retryPolicy: { mode: 'bounded-backoff', maxAttempts: 2, circuitOpenAfter: 3 },
      })

      await engine.runNow(id)
      await eventLog.append('cron.error', {
        jobId: id,
        jobName: 'permanent-check',
        error: 'HTTP 451',
        errorClass: 'remote_permanent',
        permanent: true,
        durationMs: 5,
      })

      const job = engine.get(id)!
      expect(job.state.lastStatus).toBe('error')
      expect(job.state.nextRunAtMs).toBe(nextCronFire('7 */8 * * *', clock, 'UTC'))
    })

    it('treats cron.dropped as an execution error', async () => {
      const id = await engine.add({
        name: 'drop-check',
        schedule: { kind: 'every', every: '1h' },
        payload: 'x',
      })

      await engine.runNow(id)
      await eventLog.append('cron.dropped', {
        jobId: id,
        jobName: 'drop-check',
        reason: 'listener_already_processing',
        droppedWhileProcessing: true,
      })

      const job = engine.get(id)!
      expect(job.state.lastStatus).toBe('error')
      expect(job.state.consecutiveErrors).toBe(1)
    })

    it('should throw on runNow of nonexistent job', async () => {
      await expect(engine.runNow('nope')).rejects.toThrow('not found')
    })
  })

  // ==================== persistence ====================

  describe('persistence', () => {
    it('should recover jobs after restart', async () => {
      await engine.add({
        name: 'persist-me',
        schedule: { kind: 'every', every: '2h' },
        payload: 'hello',
      })

      engine.stop()

      // New engine from same store
      const engine2 = createCronEngine({
        eventLog,
        storePath,
        now: () => clock,
      })
      await engine2.start()

      const jobs = engine2.list()
      expect(jobs).toHaveLength(1)
      expect(jobs[0].name).toBe('persist-me')

      engine2.stop()
    })

    it('marks a pre-restart fired job as interrupted and keeps its next schedule', async () => {
      const id = await engine.add({
        name: 'script-interrupted-by-restart',
        kind: 'script',
        schedule: { kind: 'every', every: '1h' },
        payload: '',
        script: { path: '/repo/OpenAlice/scripts/cron_okx_warehouse_task.sh', args: ['fast'] },
      })
      const persisted = JSON.parse(await readFile(storePath, 'utf-8')) as { jobs: any[] }
      const persistedJob = persisted.jobs.find((job) => job.id === id)
      persistedJob.state.lastRunAtMs = clock - 1_000
      persistedJob.state.lastStatus = 'fired'
      persistedJob.state.lastSuccessAtMs = clock - 60_000
      persistedJob.state.nextRunAtMs = clock + 30_000
      await writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf-8')

      const engine2 = createCronEngine({ eventLog, storePath, now: () => clock })
      await engine2.start()

      expect(engine2.get(id)?.state).toMatchObject({
        lastStatus: 'blocked',
        lastErrorClass: 'interrupted_restart',
        lastSuccessAtMs: clock - 60_000,
        nextRunAtMs: clock + 30_000,
        consecutiveErrors: 0,
      })
      engine2.stop()
    })

    it('preserves externally installed script jobs when the running engine saves its in-memory store', async () => {
      await engine.add({
        name: 'managed-by-engine',
        schedule: { kind: 'every', every: '1h' },
        payload: 'hello',
      })
      const before = JSON.parse(await readFile(storePath, 'utf-8')) as { jobs: any[] }
      before.jobs.push({
        id: 'external1',
        name: 'external_derivatives_data_collect_8h',
        enabled: true,
        kind: 'script',
        schedule: { kind: 'cron', cron: '7 */8 * * *', timezone: 'UTC' },
        payload: '',
        script: {
          path: '/repo/OpenAlice/scripts/cron_external_derivatives_data_collect.sh',
        },
        state: {
          nextRunAtMs: Date.UTC(2026, 4, 2, 0, 7, 0),
          lastRunAtMs: null,
          lastStatus: null,
          consecutiveErrors: 0,
        },
        createdAt: Date.UTC(2026, 4, 2, 0, 0, 0),
      })
      await writeFile(storePath, `${JSON.stringify(before, null, 2)}\n`, 'utf-8')

      await engine.add({
        name: 'second-managed-job',
        schedule: { kind: 'every', every: '2h' },
        payload: 'world',
      })

      const after = JSON.parse(await readFile(storePath, 'utf-8')) as { jobs: any[] }
      expect(after.jobs.map(job => job.name)).toEqual(expect.arrayContaining([
        'managed-by-engine',
        'second-managed-job',
        'external_derivatives_data_collect_8h',
      ]))
      expect(engine.list().some(job => job.name === 'external_derivatives_data_collect_8h')).toBe(true)
    })

    it('reconciles declarative definitions while preserving legacy circuit history', async () => {
      const definitionPath = tempPath('definitions.json')
      const dynamicDefinitionPath = tempPath('dynamic-definitions.json')
      const managedStorePath = tempPath('managed-state.json')
      const circuitOpenedAtMs = clock - 60_000
      await writeFile(definitionPath, `${JSON.stringify({
        schemaVersion: 'cron_definition_registry.v1',
        schedulerOwner: 'openalice_cron_engine',
        jobs: [{
          id: 'managed1',
          name: 'managed-script',
          enabled: true,
          initialState: 'scheduled',
          kind: 'script',
          schedule: { kind: 'every', every: '2h' },
          payload: 'definition-payload',
          entrypoint: 'scripts/cron_openalice_task.sh',
          args: ['scheduler-health'],
          cwd: '.',
          notificationArtifact: 'data/runtime/scheduler_health.latest.json',
          retryPolicy: {
            mode: 'bounded-backoff',
            maxAttempts: 2,
            circuitOpenAfter: 3,
          },
        }],
      }, null, 2)}\n`, 'utf-8')
      await writeFile(managedStorePath, `${JSON.stringify({
        jobs: [{
          id: 'managed1',
          name: 'legacy-name',
          enabled: true,
          kind: 'script',
          schedule: { kind: 'every', every: '1h' },
          payload: 'legacy-payload',
          script: { path: '/legacy/path.sh' },
          retryPolicy: {
            mode: 'bounded-backoff',
            maxAttempts: 2,
            circuitOpenAfter: 3,
          },
          state: {
            nextRunAtMs: null,
            lastRunAtMs: clock - 120_000,
            lastSuccessAtMs: clock - 3_600_000,
            lastStatus: 'blocked',
            consecutiveErrors: 3,
            circuitOpenedAtMs,
            lastErrorClass: 'transient_network',
            lastErrorFingerprint: 'stable-fingerprint',
          },
          createdAt: clock - 7_200_000,
        }],
      }, null, 2)}\n`, 'utf-8')

      const managed = createCronEngine({
        eventLog,
        storePath: managedStorePath,
        definitionPath,
        dynamicDefinitionPath,
        now: () => clock,
      })
      await managed.start()

      expect(managed.get('managed1')).toMatchObject({
        name: 'managed-script',
        payload: 'definition-payload',
        schedule: { kind: 'every', every: '2h' },
        state: {
          lastStatus: 'blocked',
          consecutiveErrors: 3,
          circuitOpenedAtMs,
          lastErrorClass: 'transient_network',
          lastErrorFingerprint: 'stable-fingerprint',
        },
      })
      await expect(
        managed.update('managed1', { enabled: true }),
      ).rejects.toThrow('operator receipt')

      const stateDocument = JSON.parse(
        await readFile(managedStorePath, 'utf-8'),
      ) as { schemaVersion: string; jobs: Record<string, unknown>[] }
      expect(stateDocument.schemaVersion).toBe('cron_runtime_state.v1')
      expect(stateDocument.jobs[0]).toEqual(expect.objectContaining({
        id: 'managed1',
        enabled: true,
        state: expect.any(Object),
        createdAt: clock - 7_200_000,
      }))
      expect(stateDocument.jobs[0]).not.toHaveProperty('name')
      expect(stateDocument.jobs[0]).not.toHaveProperty('schedule')
      expect(stateDocument.jobs[0]).not.toHaveProperty('script')

      managed.stop()
      await Promise.all([
        unlink(definitionPath),
        unlink(dynamicDefinitionPath),
        unlink(managedStorePath),
      ])
    })

    it('persists dynamic agent definitions separately from runtime state', async () => {
      const definitionPath = tempPath('definitions.json')
      const dynamicDefinitionPath = tempPath('dynamic-definitions.json')
      const managedStorePath = tempPath('managed-state.json')
      await writeFile(definitionPath, `${JSON.stringify({
        schemaVersion: 'cron_definition_registry.v1',
        schedulerOwner: 'openalice_cron_engine',
        jobs: [],
      }, null, 2)}\n`, 'utf-8')

      const managed = createCronEngine({
        eventLog,
        storePath: managedStorePath,
        definitionPath,
        dynamicDefinitionPath,
        now: () => clock,
      })
      await managed.start()
      const id = await managed.add({
        name: 'dynamic-reminder',
        schedule: { kind: 'every', every: '3h' },
        payload: 'remember',
      })
      managed.stop()

      const managedAfterRestart = createCronEngine({
        eventLog,
        storePath: managedStorePath,
        definitionPath,
        dynamicDefinitionPath,
        now: () => clock,
      })
      await managedAfterRestart.start()
      expect(managedAfterRestart.get(id)).toMatchObject({
        name: 'dynamic-reminder',
        payload: 'remember',
      })
      const stateDocument = JSON.parse(
        await readFile(managedStorePath, 'utf-8'),
      ) as { jobs: Record<string, unknown>[] }
      const definitionDocument = JSON.parse(
        await readFile(dynamicDefinitionPath, 'utf-8'),
      ) as { schemaVersion: string; definitions: Record<string, unknown>[] }
      expect(stateDocument.jobs[0]).not.toHaveProperty('payload')
      expect(definitionDocument).toMatchObject({
        schemaVersion: 'cron_dynamic_definitions.v1',
        definitions: [expect.objectContaining({ id, payload: 'remember' })],
      })

      managedAfterRestart.stop()
      await Promise.all([
        unlink(definitionPath),
        unlink(dynamicDefinitionPath),
        unlink(managedStorePath),
      ])
    })

    it('binds managed script fires to the canonical pipeline registry context', async () => {
      const definitionPath = tempPath('definitions.json')
      const pipelineRegistryPath = tempPath('pipeline-registry.json')
      const dynamicDefinitionPath = tempPath('dynamic-definitions.json')
      const managedStorePath = tempPath('managed-state.json')
      await writeFile(definitionPath, `${JSON.stringify({
        schemaVersion: 'cron_definition_registry.v1',
        schedulerOwner: 'openalice_cron_engine',
        jobs: [{
          id: 'managed1',
          name: 'managed-script',
          enabled: true,
          initialState: 'scheduled',
          kind: 'script',
          schedule: { kind: 'every', every: '2h' },
          payload: '',
          entrypoint: 'scripts/cron_openalice_task.sh',
          args: ['scheduler-health'],
          cwd: '.',
          notificationArtifact: 'data/runtime/scheduler_health.latest.json',
        }],
      }, null, 2)}\n`, 'utf-8')
      await writeFile(pipelineRegistryPath, `${JSON.stringify({
        schemaVersion: 'pipeline_registry.v1',
        entries: [{
          id: 'pipeline.scripts_cron_openalice_task_sh',
          owner: 'runtime-operations',
          entrypoint: 'scripts/cron_openalice_task.sh',
          safetyLevel: 'artifact_write',
          networkPolicy: 'denied',
          timeoutSeconds: 300,
          lock: { policy: 'required', key: 'pipeline:cron-openalice' },
          inputs: [],
          outputs: ['data/runtime/scheduler_health.latest.json'],
        }],
      }, null, 2)}\n`, 'utf-8')

      const managed = createCronEngine({
        eventLog,
        storePath: managedStorePath,
        definitionPath,
        pipelineRegistryPath,
        dynamicDefinitionPath,
        now: () => clock,
      })
      await managed.start()
      await managed.runNow('managed1')

      const fire = eventLog.recent({ type: 'cron.fire' }).at(-1)
      expect(fire?.payload).toMatchObject({
        pipelineContext: {
          schemaVersion: 'pipeline_run_context.v1',
          registryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          registryEntryId: 'pipeline.scripts_cron_openalice_task_sh',
          owner: 'runtime-operations',
          timeoutSeconds: 300,
          lock: { policy: 'required', key: 'pipeline:cron-openalice' },
          outputs: ['data/runtime/scheduler_health.latest.json'],
        },
      })

      managed.stop()
      await Promise.all([
        unlink(definitionPath),
        unlink(dynamicDefinitionPath),
        unlink(managedStorePath),
        unlink(pipelineRegistryPath),
      ])
    })
  })

  // ==================== one-shot (at) ====================

  describe('one-shot (at)', () => {
    it('should disable after execution', async () => {
      const future = new Date(clock + 1000).toISOString()
      const id = await engine.add({
        name: 'once',
        schedule: { kind: 'at', at: future },
        payload: 'one-time',
      })

      await engine.runNow(id)

      const job = engine.get(id)!
      expect(job.enabled).toBe(false)
      expect(job.state.nextRunAtMs).toBeNull()
    })

    it('should compute null nextRun for past timestamps', async () => {
      const past = new Date(clock - 10000).toISOString()
      const id = await engine.add({
        name: 'expired',
        schedule: { kind: 'at', at: past },
        payload: 'x',
      })

      expect(engine.get(id)!.state.nextRunAtMs).toBeNull()
    })
  })
})

// ==================== Pure helpers ====================

describe('parseDuration', () => {
  it('should parse hours', () => {
    expect(parseDuration('2h')).toBe(2 * 3600_000)
  })

  it('should parse minutes', () => {
    expect(parseDuration('30m')).toBe(30 * 60_000)
  })

  it('should parse seconds', () => {
    expect(parseDuration('45s')).toBe(45_000)
  })

  it('should parse combined', () => {
    expect(parseDuration('1h30m')).toBe(90 * 60_000)
  })

  it('should return null for empty', () => {
    expect(parseDuration('')).toBeNull()
  })

  it('should return null for garbage', () => {
    expect(parseDuration('abc')).toBeNull()
  })
})

describe('nextCronFire', () => {
  it('should find next fire for simple expression', () => {
    // Every hour at minute 0
    const base = new Date('2025-06-01T10:00:00Z').getTime()
    const next = nextCronFire('0 * * * *', base)
    expect(next).toBe(new Date('2025-06-01T11:00:00Z').getTime())
  })

  it('should find next weekday fire', () => {
    // "0 9 * * 1" = Monday at 9:00 local time
    // Use local dates to avoid timezone mismatch
    const base = new Date('2025-06-01T00:00:00').getTime() // Sunday local
    const next = nextCronFire('0 9 * * 1', base)
    expect(next).toBe(new Date('2025-06-02T09:00:00').getTime()) // Monday 9am local
  })

  it('should return null for invalid expression', () => {
    expect(nextCronFire('bad expr', Date.now())).toBeNull()
  })

  it('should handle step syntax', () => {
    // Every 15 minutes
    const base = new Date('2025-06-01T10:00:00Z').getTime()
    const next = nextCronFire('*/15 * * * *', base)
    expect(next).toBe(new Date('2025-06-01T10:15:00Z').getTime())
  })

  it('should evaluate UTC cron schedules without local timezone drift', () => {
    const base = new Date('2026-03-08T07:59:30Z').getTime()
    const next = nextCronFire('0 8 * * *', base, 'UTC')
    expect(next).toBe(new Date('2026-03-08T08:00:00Z').getTime())
  })

  it('should reject out-of-range cron fields', () => {
    const base = new Date('2025-06-01T10:00:00Z').getTime()

    expect(nextCronFire('60 * * * *', base)).toBeNull()
    expect(nextCronFire('0 24 * * *', base)).toBeNull()
    expect(nextCronFire('0 9 0 * *', base)).toBeNull()
    expect(nextCronFire('0 9 * 13 *', base)).toBeNull()
    expect(nextCronFire('0 9 * * 8', base)).toBeNull()
  })

  it('should reject huge or reversed cron ranges before expanding them', () => {
    const base = new Date('2025-06-01T10:00:00Z').getTime()

    expect(nextCronFire('0-999999999999999999999 * * * *', base)).toBeNull()
    expect(nextCronFire('30-10 * * * *', base)).toBeNull()
    expect(nextCronFire('*/999999999999999999999 * * * *', base)).toBeNull()
  })
})

describe('computeNextRun', () => {
  it('should compute for every', () => {
    const base = 1000000
    expect(computeNextRun({ kind: 'every', every: '1h' }, base)).toBe(base + 3600_000)
  })

  it('should compute for at (future)', () => {
    const future = new Date(Date.now() + 60000).toISOString()
    const result = computeNextRun({ kind: 'at', at: future }, Date.now())
    expect(result).toBeGreaterThan(Date.now())
  })

  it('should return null for at (past)', () => {
    const past = new Date(Date.now() - 60000).toISOString()
    expect(computeNextRun({ kind: 'at', at: past }, Date.now())).toBeNull()
  })

  it('should pass UTC cron timezone through computeNextRun', () => {
    const base = new Date('2026-03-08T07:59:30Z').getTime()
    expect(computeNextRun({ kind: 'cron', cron: '0 8 * * *', timezone: 'UTC' }, base))
      .toBe(new Date('2026-03-08T08:00:00Z').getTime())
  })
})
