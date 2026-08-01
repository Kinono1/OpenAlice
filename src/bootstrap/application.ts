import type { Config } from '../core/config.js'
import { loadConfig } from '../core/config.js'
import { join } from 'node:path'
import type { EngineContext } from '../core/types.js'
import { ConnectorCenter } from '../core/connector-center.js'
import { ToolCenter } from '../core/tool-center.js'
import { createCronEngine } from '../task/cron/index.js'
import { NewsCollectorStore } from '../domain/news/index.js'
import { dispose as disposeTrustedContext } from '../core/trusted-context.js'
import {
  configureRuntimeEnvironment,
  resolveRuntimePaths,
  type RuntimePaths,
} from '../runtime/runtime-paths.js'
import { assembleObservability } from './observability.js'
import { assembleAgentCenter, assembleBrain } from './ai.js'
import { assembleMarketData } from './market-data.js'
import { assembleExecution } from './execution.js'
import { registerApplicationTools } from './tools.js'
import { startScheduling } from './scheduling.js'
import { assembleChannels } from './channels.js'

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

export async function startOpenAlice(): Promise<void> {
  const runtime = resolveRuntimePaths()
  configureRuntimeEnvironment(runtime)
  const config = applyRuntimeRole(await loadConfig(), runtime)
  const { eventLog, toolCallLog } = await assembleObservability(runtime)
  const toolCenter = new ToolCenter()
  const { brain, instructions } = await assembleBrain(runtime)
  const marketData = await assembleMarketData(config, runtime)
  const { accountManager, snapshotService } = await assembleExecution({
    config,
    runtime,
    eventLog,
    toolCenter,
    cryptoClient: marketData.cryptoClient,
  })
  const cronEngine = createCronEngine({
    eventLog,
    storePath: runtime.cronStateFile,
    definitionPath: join(runtime.repoRoot, 'ops', 'pipeline', 'cron_definitions.v1.json'),
    pipelineRegistryPath: join(runtime.repoRoot, 'ops', 'pipeline', 'pipeline_registry.v1.json'),
    dynamicDefinitionPath: runtime.cronDefinitionOverlayFile,
  })
  const newsStore = new NewsCollectorStore({
    logPath: runtime.newsLogFile,
    maxInMemory: config.news.maxInMemory,
    retentionDays: config.news.retentionDays,
  })
  await newsStore.init()

  registerApplicationTools({
    config,
    runtime,
    toolCenter,
    brain,
    accountManager,
    cronEngine,
    symbolIndex: marketData.symbolIndex,
    equityClient: marketData.equityClient,
    cryptoClient: marketData.cryptoClient,
    currencyClient: marketData.currencyClient,
    newsStore,
  })
  const agentCenter = assembleAgentCenter({
    config,
    toolCenter,
    instructions,
    toolCallLog,
  })
  const connectorCenter = new ConnectorCenter(eventLog)
  const scheduling = await startScheduling({
    config,
    runtime,
    eventLog,
    connectorCenter,
    agentCenter,
    cronEngine,
    accountManager,
    snapshotService,
    newsStore,
  })
  const channels = assembleChannels({ config, runtime, toolCenter })
  const context: EngineContext = {
    config,
    runtime,
    connectorCenter,
    agentCenter,
    eventLog,
    toolCallLog,
    heartbeat: scheduling.heartbeat,
    cronEngine,
    toolCenter,
    cryptoClient: marketData.cryptoClient,
    accountManager,
    snapshotService,
    reconnectConnectors: channels.reconnectConnectors,
  }
  await channels.start(context)
  console.log(`engine: started (role=${runtime.role})`)

  let stopped = false
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    stopped = true
    await scheduling.stop()
    await channels.stop()
    await newsStore.close()
    await toolCallLog.close()
    await eventLog.close()
    await accountManager.closeAll()
    disposeTrustedContext()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  while (!stopped) {
    await sleep(config.engine.interval)
  }
}

export function applyRuntimeRole(config: Config, runtime: RuntimePaths): Config {
  if (runtime.role === 'primary') return config
  return {
    ...config,
    agent: { ...config.agent, evolutionMode: false },
    snapshot: { ...config.snapshot, enabled: false },
    heartbeat: { ...config.heartbeat, enabled: false },
    news: { ...config.news, enabled: false },
    connectors: {
      ...config.connectors,
      web: {
        ...config.connectors.web,
        port: runtime.portOverrides.web ?? config.connectors.web.port,
      },
      mcp: {
        ...config.connectors.mcp,
        port: runtime.portOverrides.mcp ?? config.connectors.mcp.port,
      },
      mcpAsk: {
        ...config.connectors.mcpAsk,
        enabled: false,
        port: runtime.portOverrides.mcpAsk,
      },
      telegram: { ...config.connectors.telegram, enabled: false },
    },
    marketData: {
      ...config.marketData,
      apiServer: { ...config.marketData.apiServer, enabled: false },
    },
  }
}
