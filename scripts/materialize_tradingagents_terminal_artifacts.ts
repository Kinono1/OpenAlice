import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { appendExecutionJournal, sanitizeError } from './lib/execution_journal.js'
import type { FailureDiagnosisPayload } from './lib/tradingagents_failure_diagnosis.js'
import {
  buildTradingAgentsTerminalArtifacts,
  renderTradingAgentsSalvageRegistryMarkdown,
  renderTradingAgentsTerminalDecisionMarkdown,
  renderTradingAgentsTerminalPostmortemMarkdown,
} from './lib/tradingagents_terminal_artifacts.js'

interface CliArgs {
  diagnoses: string[]
  paradigmId: string
  analysisDir: string
  paradigmDir: string
  dateTag: string
  journalPath: string
}

export async function materializeTradingAgentsTerminalArtifacts(args: CliArgs): Promise<{
  terminalDecision: string
  statusJson: string
}> {
  const runId = `terminal_artifacts.${new Date().toISOString().replace(/[:.]/g, '')}`
  const resolvedDiagnosisInputs = args.diagnoses.map((path) => resolve(path))
  const outputPaths = buildOutputPaths(args.analysisDir, args.paradigmDir, args.dateTag)

  await appendExecutionJournal(
    {
      runId,
      batchId: args.paradigmId,
      stage: 'assessment',
      action: 'terminal_artifact_materialization',
      status: 'started',
      inputs: {
        diagnoses: resolvedDiagnosisInputs,
        analysisDir: resolve(args.analysisDir),
        paradigmDir: resolve(args.paradigmDir),
        dateTag: args.dateTag,
      },
      outputs: outputPaths,
      decision: 'started',
      codeRefs: ['scripts/materialize_tradingagents_terminal_artifacts.ts'],
    },
    args.journalPath,
  )

  try {
    const diagnoses = await Promise.all(
      args.diagnoses.map(async (path) =>
        JSON.parse(await readFile(resolve(path), 'utf-8')) as FailureDiagnosisPayload,
      ),
    )
    const artifacts = buildTradingAgentsTerminalArtifacts({
      paradigmId: args.paradigmId,
      diagnoses,
      diagnosisInputs: resolvedDiagnosisInputs,
      artifactPaths: {
        diagnosisInputs: resolvedDiagnosisInputs,
        analysisTerminalDecisionJson: outputPaths.analysisTerminalDecisionJson,
        analysisTerminalDecisionMarkdown: outputPaths.analysisTerminalDecisionMarkdown,
        analysisSalvageRegistryJson: outputPaths.analysisSalvageRegistryJson,
        analysisSalvageRegistryMarkdown: outputPaths.analysisSalvageRegistryMarkdown,
        analysisTerminalPostmortemJson: outputPaths.analysisTerminalPostmortemJson,
        analysisTerminalPostmortemMarkdown: outputPaths.analysisTerminalPostmortemMarkdown,
        latestTerminalDecisionJson: outputPaths.latestTerminalDecisionJson,
        latestSalvageRegistryJson: outputPaths.latestSalvageRegistryJson,
        latestTerminalPostmortemJson: outputPaths.latestTerminalPostmortemJson,
        latestTerminalStatusJson: outputPaths.latestTerminalStatusJson,
      },
    })

    await Promise.all([
      writeJson(outputPaths.analysisTerminalDecisionJson, artifacts.terminalDecision),
      writeText(
        outputPaths.analysisTerminalDecisionMarkdown,
        renderTradingAgentsTerminalDecisionMarkdown(artifacts.terminalDecision),
      ),
      writeJson(outputPaths.analysisSalvageRegistryJson, artifacts.salvageRegistry),
      writeText(
        outputPaths.analysisSalvageRegistryMarkdown,
        renderTradingAgentsSalvageRegistryMarkdown(artifacts.salvageRegistry),
      ),
      writeJson(outputPaths.analysisTerminalPostmortemJson, artifacts.terminalPostmortem),
      writeText(
        outputPaths.analysisTerminalPostmortemMarkdown,
        renderTradingAgentsTerminalPostmortemMarkdown(artifacts.terminalPostmortem),
      ),
      writeJson(outputPaths.latestTerminalDecisionJson, artifacts.terminalDecision),
      writeJson(outputPaths.latestSalvageRegistryJson, artifacts.salvageRegistry),
      writeJson(outputPaths.latestTerminalPostmortemJson, artifacts.terminalPostmortem),
      writeJson(outputPaths.latestTerminalStatusJson, artifacts.terminalStatus),
    ])

    await appendExecutionJournal(
      {
        runId,
        batchId: args.paradigmId,
        stage: 'assessment',
        action: 'terminal_artifact_materialization',
        status: 'completed',
        outputs: outputPaths,
        decision: artifacts.terminalDecision.terminalDecision,
        notes: [
          `decisionConfidence=${artifacts.terminalDecision.terminalDecisionConfidence}`,
          `evidenceCompleteness=${artifacts.terminalDecision.terminalEvidenceCompleteness}`,
        ],
        codeRefs: ['scripts/materialize_tradingagents_terminal_artifacts.ts'],
      },
      args.journalPath,
    )

    return {
      terminalDecision: artifacts.terminalDecision.terminalDecision,
      statusJson: outputPaths.latestTerminalStatusJson,
    }
  } catch (error) {
    await appendExecutionJournal(
      {
        runId,
        batchId: args.paradigmId,
        stage: 'assessment',
        action: 'terminal_artifact_materialization',
        status: 'failed',
        outputs: outputPaths,
        decision: 'failed',
        notes: [sanitizeError(error)],
        codeRefs: ['scripts/materialize_tradingagents_terminal_artifacts.ts'],
      },
      args.journalPath,
    )
    throw error
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const result = await materializeTradingAgentsTerminalArtifacts(args)
  console.log(
    [`terminalDecision=${result.terminalDecision}`, `statusJson=${result.statusJson}`].join(' | '),
  )
}

function buildOutputPaths(analysisDir: string, paradigmDir: string, dateTag: string) {
  const prefix = 'tradingagents_btc'
  const analysisRoot = resolve(analysisDir)
  const paradigmRoot = resolve(paradigmDir)
  return {
    analysisTerminalDecisionJson: `${analysisRoot}/${prefix}_terminal_decision_${dateTag}.json`,
    analysisTerminalDecisionMarkdown: `${analysisRoot}/${prefix}_terminal_decision_${dateTag}.md`,
    analysisSalvageRegistryJson: `${analysisRoot}/${prefix}_component_salvage_registry_${dateTag}.json`,
    analysisSalvageRegistryMarkdown: `${analysisRoot}/${prefix}_component_salvage_registry_${dateTag}.md`,
    analysisTerminalPostmortemJson: `${analysisRoot}/${prefix}_terminal_postmortem_${dateTag}.json`,
    analysisTerminalPostmortemMarkdown: `${analysisRoot}/${prefix}_terminal_postmortem_${dateTag}.md`,
    latestTerminalDecisionJson: `${paradigmRoot}/btc_terminal_decision.latest.json`,
    latestSalvageRegistryJson: `${paradigmRoot}/btc_component_salvage_registry.latest.json`,
    latestTerminalPostmortemJson: `${paradigmRoot}/btc_terminal_postmortem.latest.json`,
    latestTerminalStatusJson: `${paradigmRoot}/btc_terminal_status.latest.json`,
  }
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true })
  await writeFile(resolve(path), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true })
  await writeFile(resolve(path), `${content}\n`, 'utf-8')
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const diagnoses = argv.filter((token, index) => argv[index - 1] === '--diagnosis')
  if (diagnoses.length < 1) {
    throw new Error('At least one --diagnosis <path> is required.')
  }
  return {
    diagnoses,
    paradigmId: raw.get('paradigm-id') ?? 'tradingagents_research_sidecar_v2',
    analysisDir: raw.get('analysis-dir') ?? 'data/research/strategy/analysis',
    paradigmDir: raw.get('paradigm-dir') ?? 'data/research/strategy/paradigms/tradingagents',
    dateTag: raw.get('date-tag') ?? new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    journalPath: raw.get('journal-path') ?? 'data/research/strategy/execution_journal.jsonl',
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    index += 1
  }
  return out
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  })
}
