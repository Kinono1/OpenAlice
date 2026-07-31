import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Brain, type BrainExportState } from '../domain/brain/index.js'
import { AgentCenter } from '../core/agent-center.js'
import { GenerateRouter } from '../core/ai-provider-manager.js'
import { VercelAIProvider } from '../ai-providers/vercel-ai-sdk/vercel-provider.js'
import { AgentSdkProvider } from '../ai-providers/agent-sdk/agent-sdk-provider.js'
import type { Config } from '../core/config.js'
import type { ToolCenter } from '../core/tool-center.js'
import type { ToolCallLog } from '../core/tool-call-log.js'
import type { RuntimePaths } from '../runtime/runtime-paths.js'

export interface BrainAssembly {
  brain: Brain
  instructions: string
}

export async function assembleBrain(runtime: RuntimePaths): Promise<BrainAssembly> {
  const readBrainFile = join(runtime.sharedDataInputDir, 'brain', 'commit.json')
  const writeBrainFile = join(runtime.stateDir, 'brain', 'commit.json')
  const frontalLobeFile = join(runtime.stateDir, 'brain', 'frontal-lobe.md')
  const emotionLogFile = join(runtime.stateDir, 'brain', 'emotion-log.md')
  const readPersonaFile = join(runtime.sharedDataInputDir, 'brain', 'persona.md')
  const writePersonaFile = join(runtime.stateDir, 'brain', 'persona.md')
  const personaDefault = join(runtime.repoRoot, 'default', 'persona.default.md')

  const [brainExport, persona] = await Promise.all([
    readFile(readBrainFile, 'utf-8')
      .then((value) => JSON.parse(value) as BrainExportState)
      .catch(() => undefined),
    readWithDefault(
      readPersonaFile,
      writePersonaFile,
      personaDefault,
      runtime.capabilities.writesSharedData,
    ),
  ])

  const onCommit = async (state: BrainExportState) => {
    await mkdir(dirname(writeBrainFile), { recursive: true })
    await writeFile(writeBrainFile, JSON.stringify(state, null, 2))
    await writeFile(frontalLobeFile, state.state.frontalLobe)
    const latest = state.commits[state.commits.length - 1]
    if (latest?.type === 'emotion') {
      const previous = state.commits.length > 1
        ? state.commits[state.commits.length - 2]?.stateAfter.emotion ?? 'unknown'
        : 'unknown'
      await appendFile(
        emotionLogFile,
        `## ${latest.timestamp}\n**${previous} → ${latest.stateAfter.emotion}**\n${latest.message}\n\n`,
      )
    }
  }

  const brain = brainExport
    ? Brain.restore(brainExport, { onCommit })
    : new Brain({ onCommit })
  const instructions = [
    persona,
    '---',
    '## Current Brain State',
    '',
    `**Frontal Lobe:** ${brain.getFrontalLobe() || '(empty)'}`,
    '',
    `**Emotion:** ${brain.getEmotion().current}`,
  ].join('\n')
  return { brain, instructions }
}

export function assembleAgentCenter(input: {
  config: Config
  toolCenter: ToolCenter
  instructions: string
  toolCallLog: ToolCallLog
}): AgentCenter {
  const { config, toolCenter, instructions, toolCallLog } = input
  const vercelProvider = new VercelAIProvider(
    () => toolCenter.getVercelTools(),
    instructions,
    config.agent.maxSteps,
  )
  const agentSdkProvider = new AgentSdkProvider(
    () => toolCenter.getVercelTools(),
    instructions,
  )
  return new AgentCenter({
    router: new GenerateRouter(vercelProvider, agentSdkProvider),
    compaction: config.compaction,
    toolCallLog,
  })
}

async function readWithDefault(
  readTarget: string,
  writeTarget: string,
  defaultFile: string,
  seedAllowed: boolean,
): Promise<string> {
  try {
    return await readFile(readTarget, 'utf-8')
  } catch {
    // Continue to the versioned default.
  }
  try {
    const content = await readFile(defaultFile, 'utf-8')
    if (seedAllowed) {
      await mkdir(dirname(writeTarget), { recursive: true })
      await writeFile(writeTarget, content)
    }
    return content
  } catch {
    return ''
  }
}
