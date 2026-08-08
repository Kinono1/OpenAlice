import type { Config } from '../core/config.js'
import type { EventLog } from '../core/event-log.js'
import type { ConnectorCenter } from '../core/connector-center.js'
import type { AgentCenter } from '../core/agent-center.js'
import { SessionStore } from '../core/session.js'
import type { AccountManager, SnapshotService } from '../domain/trading/index.js'
import { createSnapshotScheduler } from '../domain/trading/index.js'
import { createCronListener, type CronEngine } from '../task/cron/index.js'
import { createHeartbeat, type Heartbeat } from '../task/heartbeat/index.js'
import { NewsCollector, type NewsCollectorStore } from '../domain/news/index.js'
import { OkxStreamSupervisor } from '../domain/market-data/okx-stream-supervisor.js'
import type { RuntimePaths } from '../runtime/runtime-paths.js'

export interface SchedulingAssembly {
  heartbeat: Heartbeat
  stop(): Promise<void>
}

export async function startScheduling(input: {
  config: Config
  runtime: RuntimePaths
  eventLog: EventLog
  connectorCenter: ConnectorCenter
  agentCenter: AgentCenter
  cronEngine: CronEngine
  accountManager: AccountManager
  snapshotService: SnapshotService
  newsStore: NewsCollectorStore
}): Promise<SchedulingAssembly> {
  const {
    config,
    runtime,
    eventLog,
    connectorCenter,
    agentCenter,
    cronEngine,
    snapshotService,
    newsStore,
  } = input

  const heartbeat = createHeartbeat({
    config: config.heartbeat,
    connectorCenter,
    cronEngine,
    eventLog,
    agentCenter,
  })
  const snapshotScheduler = createSnapshotScheduler({
    snapshotService,
    cronEngine,
    eventLog,
    config: config.snapshot,
  })
  const okxStreamSupervisor = new OkxStreamSupervisor()
  let cronListener: ReturnType<typeof createCronListener> | null = null
  let newsCollector: NewsCollector | null = null

  if (runtime.capabilities.ownsCron) {
    await cronEngine.start()
    const cronSession = new SessionStore('cron/default')
    await cronSession.restore()
    cronListener = createCronListener({
      connectorCenter,
      eventLog,
      agentCenter,
      session: cronSession,
    })
    cronListener.start()
    console.log('cron: engine + listener started')

    // Heartbeat and snapshot are autonomous agent/account jobs.  They are
    // deliberately primary-only even though research owns the ordinary Cron
    // engine for data, audit, and notification work.  Starting either one in
    // research would attempt to register a primary-only dynamic job and would
    // also create an implicit autonomous execution path.
    if (runtime.role === 'primary') {
      await snapshotScheduler.start()
      if (config.snapshot.enabled) {
        console.log(`snapshot: scheduler started (every ${config.snapshot.every})`)
      }
      await heartbeat.start()
      if (config.heartbeat.enabled) {
        console.log(`heartbeat: enabled (every ${config.heartbeat.every})`)
      }
    } else {
      console.log(`snapshot/heartbeat: disabled for runtime role ${runtime.role}`)
    }
  } else {
    console.log(`cron: disabled for runtime role ${runtime.role}`)
  }

  if (runtime.capabilities.writesSharedData) {
    try {
      await okxStreamSupervisor.start()
    } catch (error) {
      console.warn(
        `okx-stream: degraded startup: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (config.news.enabled && config.news.feeds.length > 0) {
      newsCollector = new NewsCollector({
        store: newsStore,
        feeds: config.news.feeds,
        intervalMs: config.news.intervalMinutes * 60 * 1000,
      })
      newsCollector.start()
      console.log(
        `news-collector: started (${config.news.feeds.length} feeds, every ${config.news.intervalMinutes}m)`,
      )
    }
  }

  return {
    heartbeat,
    async stop() {
      newsCollector?.stop()
      snapshotScheduler.stop()
      heartbeat.stop()
      cronListener?.stop()
      cronEngine.stop()
      await okxStreamSupervisor.stop()
    },
  }
}
