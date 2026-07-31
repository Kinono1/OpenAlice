import { createEventLog, type EventLog } from '../core/event-log.js'
import { createToolCallLog, type ToolCallLog } from '../core/tool-call-log.js'
import type { RuntimePaths } from '../runtime/runtime-paths.js'

export interface ObservabilityAssembly {
  eventLog: EventLog
  toolCallLog: ToolCallLog
}

export async function assembleObservability(
  runtime: RuntimePaths,
): Promise<ObservabilityAssembly> {
  const [eventLog, toolCallLog] = await Promise.all([
    createEventLog({ logPath: runtime.eventLogFile }),
    createToolCallLog({ logPath: runtime.toolCallLogFile }),
  ])
  return { eventLog, toolCallLog }
}
