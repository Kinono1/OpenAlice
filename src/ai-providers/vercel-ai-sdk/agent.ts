import { ToolLoopAgent, stepCountIs } from 'ai'
import type { LanguageModel, Tool } from 'ai'
import type { SharedV3ProviderOptions } from '@ai-sdk/provider'

/**
 * Create a generic ToolLoopAgent with externally-provided tools.
 *
 * The caller decides what tools the agent has — Engine wires in
 * sandbox-analysis tools (market data, trading, cognition, etc.).
 */
export function createAgent(
  model: LanguageModel,
  tools: Record<string, Tool>,
  instructions: string,
  maxSteps = 20,
  providerOptions?: SharedV3ProviderOptions,
) {
  return new ToolLoopAgent({
    model,
    tools,
    instructions,
    stopWhen: stepCountIs(maxSteps),
    providerOptions,
  })
}

export type Agent = ReturnType<typeof createAgent>
