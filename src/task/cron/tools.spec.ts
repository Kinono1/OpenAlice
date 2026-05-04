import { describe, expect, it, vi } from 'vitest'
import { createCronTools } from './tools.js'
import type { CronEngine, CronJob, CronJobCreate, CronJobPatch } from './engine.js'

function createMockCronEngine(): CronEngine & {
  add: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
} {
  const jobs: CronJob[] = []
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    add: vi.fn(async (params: CronJobCreate) => {
      jobs.push({
        id: 'job12345',
        name: params.name,
        enabled: params.enabled ?? true,
        kind: params.kind,
        schedule: params.schedule,
        payload: params.payload,
        script: params.script,
        state: {
          nextRunAtMs: null,
          lastRunAtMs: null,
          lastStatus: null,
          consecutiveErrors: 0,
        },
        createdAt: 0,
      })
      return 'job12345'
    }),
    update: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    list: vi.fn(() => jobs),
    runNow: vi.fn(async () => {}),
    get: vi.fn((id: string) => jobs.find((job) => job.id === id)),
  }
}

describe('cron AI tools', () => {
  it('creates agent cron jobs without script metadata', async () => {
    const engine = createMockCronEngine()
    const tools = createCronTools(engine)

    const result = await (tools.cronAdd as any).execute({
      name: 'check-market',
      payload: 'Check the market',
      schedule: { kind: 'every', every: '1h' },
      enabled: true,
    })

    expect(result).toEqual({ id: 'job12345' })
    expect(engine.add).toHaveBeenCalledWith({
      name: 'check-market',
      payload: 'Check the market',
      schedule: { kind: 'every', every: '1h' },
      enabled: true,
    })
    expect(engine.list()[0]?.kind).toBeUndefined()
    expect(engine.list()[0]?.script).toBeUndefined()
  })

  it('rejects attempts to create script cron jobs through AI-facing tools', async () => {
    const engine = createMockCronEngine()
    const tools = createCronTools(engine)

    const result = await (tools.cronAdd as any).execute({
      name: 'unsafe-script',
      payload: '',
      kind: 'script',
      script: {
        path: '/tmp/unsafe.sh',
      },
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      enabled: true,
    })

    expect(result).toEqual({
      error: 'cronAdd can only create agent cron jobs; script jobs must be installed by approved deterministic installers',
    })
    expect(engine.add).not.toHaveBeenCalled()
  })

  it('rejects attempts to update cron job kind or script metadata through AI-facing tools', async () => {
    const engine = createMockCronEngine()
    const tools = createCronTools(engine)

    const result = await (tools.cronUpdate as any).execute({
      id: 'job12345',
      kind: 'script',
      script: {
        path: '/tmp/unsafe.sh',
      },
    })

    expect(result).toEqual({
      error: 'cronUpdate cannot modify cron job kind or script metadata',
    })
    expect(engine.update).not.toHaveBeenCalled()
  })

  it('allows normal agent job updates', async () => {
    const engine = createMockCronEngine()
    const tools = createCronTools(engine)

    const result = await (tools.cronUpdate as any).execute({
      id: 'job12345',
      payload: 'New reminder',
      schedule: { kind: 'every', every: '2h' },
      enabled: false,
    })

    expect(result).toEqual({ ok: true })
    expect(engine.update).toHaveBeenCalledWith('job12345', {
      name: undefined,
      payload: 'New reminder',
      schedule: { kind: 'every', every: '2h' },
      enabled: false,
    })
  })
})
