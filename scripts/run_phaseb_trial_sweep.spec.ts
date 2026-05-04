import { existsSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeCheckpointStore } from '../src/runtime/runtime_checkpoint.js'
import type { ExecutionJournalEntry } from './lib/execution_journal.js'
import { parseArgs, runPhaseBTrialSweep } from './run_phaseb_trial_sweep.js'

const cwdStack: string[] = []
const tempRoots: string[] = []

afterEach(() => {
  while (cwdStack.length > 0) {
    process.chdir(cwdStack.pop()!)
  }
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe('run_phaseb_trial_sweep checkpoint integration', () => {
  it('parses resume, fresh, run id, and checkpoint root flags', () => {
    expect(parseArgs([
      '--search-json',
      'search.json',
      '--base-manifest',
      'manifest.json',
      '--sweep-id',
      'sweep_001',
      '--symbol',
      'BTC-USDT',
      '--resume',
      '--run-id',
      'sweep_run_001',
      '--checkpoint-root',
      'tmp/checkpoints',
    ])).toMatchObject({
      searchJson: 'search.json',
      baseManifest: 'manifest.json',
      sweepId: 'sweep_001',
      symbol: 'BTC-USDT',
      resume: true,
      fresh: false,
      runId: 'sweep_run_001',
      checkpointRoot: 'tmp/checkpoints',
    })

    expect(() => parseArgs([
      '--search-json',
      'search.json',
      '--base-manifest',
      'manifest.json',
      '--sweep-id',
      'sweep_001',
      '--symbol',
      'BTC-USDT',
      '--resume',
      '--fresh',
    ])).toThrow(/mutually exclusive/)
  })

  it('resumes after a completed trial and clears checkpoint after success', async () => {
    const root = await tempRoot()
    enterCwd(root)

    const searchPath = join(root, 'search.json')
    const manifestPath = join(root, 'base-manifest.json')
    const summaryOutput = join(root, 'out', 'phaseb-sweep.json')
    const markdownOutput = join(root, 'out', 'phaseb-sweep.md')
    const checkpointRoot = join(root, 'checkpoints')
    await writeSearchPayload(searchPath)
    await writeBaseManifest(manifestPath)

    const firstCalls: string[] = []
    await expect(runPhaseBTrialSweep({
      searchJson: searchPath,
      baseManifest: manifestPath,
      sweepId: 'sweep_resume',
      symbol: 'BTC-USDT',
      summaryOutput,
      markdownOutput,
      resume: false,
      fresh: true,
      runId: 'sweep_run_001',
      checkpointRoot,
    }, {
      appendExecutionJournal: noOpJournal,
      now: fixedNow,
      execNodeQuiet: async (args) => {
        const tag = getArg(args, '--tag')
        firstCalls.push(tag)
        if (tag.endsWith('.trial_002')) {
          throw new Error('injected failure after first trial')
        }
        await writeRouteOutputs(tag)
      },
    })).rejects.toThrow(/injected failure/)

    expect(firstCalls).toEqual(['sweep_resume.trial_001', 'sweep_resume.trial_002'])
    const checkpointStore = new RuntimeCheckpointStore({
      rootDir: checkpointRoot,
      namespace: 'phaseb_trial_sweep',
    })
    const checkpoint = checkpointStore.load<{
      completedTrials: number[]
      results: Array<{ trial: number }>
    }>('sweep_run_001')
    expect(checkpoint.ok).toBe(true)
    if (checkpoint.ok) {
      expect(checkpoint.checkpoint.step).toBe('trial_completed')
      expect(checkpoint.checkpoint.state.completedTrials).toEqual([1])
      expect(checkpoint.checkpoint.state.results.map((item) => item.trial)).toEqual([1])
    }

    const secondCalls: string[] = []
    const result = await runPhaseBTrialSweep({
      searchJson: searchPath,
      baseManifest: manifestPath,
      sweepId: 'sweep_resume',
      symbol: 'BTC-USDT',
      summaryOutput,
      markdownOutput,
      resume: true,
      fresh: false,
      runId: 'sweep_run_001',
      checkpointRoot,
    }, {
      appendExecutionJournal: noOpJournal,
      now: fixedNow,
      execNodeQuiet: async (args) => {
        const tag = getArg(args, '--tag')
        secondCalls.push(tag)
        await writeRouteOutputs(tag)
      },
    })

    expect(secondCalls).toEqual(['sweep_resume.trial_002'])
    expect(result.recommendedTrial).toBe(1)
    expect(existsSync(checkpointStore.pathFor('sweep_run_001'))).toBe(false)

    const summary = JSON.parse(await readFile(summaryOutput, 'utf-8')) as {
      recommendedTrial: number
      trialCount: number
      trials: Array<{ trial: number }>
    }
    expect(summary.recommendedTrial).toBe(1)
    expect(summary.trialCount).toBe(2)
    expect(summary.trials.map((trial) => trial.trial)).toEqual([1, 2])
    expect(await readFile(markdownOutput, 'utf-8')).toContain('# Phase-B Trial Sweep sweep_resume')
  })

  it('requires an explicit resume or fresh choice when a checkpoint exists', async () => {
    const root = await tempRoot()
    enterCwd(root)

    const searchPath = join(root, 'search.json')
    const manifestPath = join(root, 'base-manifest.json')
    const checkpointRoot = join(root, 'checkpoints')
    await writeSearchPayload(searchPath, [{ trial: 1, template: ['trend'], candidates: [{ strategyId: 't1' }] }])
    await writeBaseManifest(manifestPath)

    await expect(runPhaseBTrialSweep({
      searchJson: searchPath,
      baseManifest: manifestPath,
      sweepId: 'sweep_requires_mode',
      symbol: 'BTC-USDT',
      resume: false,
      fresh: true,
      runId: 'sweep_run_002',
      checkpointRoot,
    }, {
      appendExecutionJournal: noOpJournal,
      now: fixedNow,
      execNodeQuiet: async (args) => {
        await writeRouteOutputs(getArg(args, '--tag'))
        throw new Error('leave checkpoint behind')
      },
    })).rejects.toThrow(/leave checkpoint/)

    await expect(runPhaseBTrialSweep({
      searchJson: searchPath,
      baseManifest: manifestPath,
      sweepId: 'sweep_requires_mode',
      symbol: 'BTC-USDT',
      resume: false,
      fresh: false,
      runId: 'sweep_run_002',
      checkpointRoot,
    }, {
      appendExecutionJournal: noOpJournal,
      now: fixedNow,
      execNodeQuiet: async () => {
        throw new Error('should not run')
      },
    })).rejects.toThrow(/Use --resume to continue or --fresh to discard it/)
  })

  it('rejects resume when the search payload hash differs', async () => {
    const root = await tempRoot()
    enterCwd(root)

    const searchPath = join(root, 'search.json')
    const manifestPath = join(root, 'base-manifest.json')
    const checkpointRoot = join(root, 'checkpoints')
    await writeSearchPayload(searchPath)
    await writeBaseManifest(manifestPath)

    await expect(runPhaseBTrialSweep({
      searchJson: searchPath,
      baseManifest: manifestPath,
      sweepId: 'sweep_search_hash',
      symbol: 'BTC-USDT',
      resume: false,
      fresh: true,
      runId: 'sweep_run_003',
      checkpointRoot,
    }, {
      appendExecutionJournal: noOpJournal,
      now: fixedNow,
      execNodeQuiet: async (args) => {
        const tag = getArg(args, '--tag')
        if (tag.endsWith('.trial_002')) {
          throw new Error('leave partial checkpoint')
        }
        await writeRouteOutputs(tag)
      },
    })).rejects.toThrow(/leave partial checkpoint/)

    await writeSearchPayload(searchPath, [
      { trial: 1, template: ['trend'], candidates: [{ strategyId: 't1' }] },
      { trial: 2, template: ['breakout'], candidates: [{ strategyId: 't2' }] },
      { trial: 3, template: ['carry'], candidates: [{ strategyId: 't3' }] },
    ])

    await expect(runPhaseBTrialSweep({
      searchJson: searchPath,
      baseManifest: manifestPath,
      sweepId: 'sweep_search_hash',
      symbol: 'BTC-USDT',
      resume: true,
      fresh: false,
      runId: 'sweep_run_003',
      checkpointRoot,
    }, {
      appendExecutionJournal: noOpJournal,
      now: fixedNow,
      execNodeQuiet: async () => {
        throw new Error('should not run')
      },
    })).rejects.toThrow(/searchJsonHash/)
  })

  it('rejects resume when the base manifest hash differs', async () => {
    const root = await tempRoot()
    enterCwd(root)

    const searchPath = join(root, 'search.json')
    const manifestPath = join(root, 'base-manifest.json')
    const checkpointRoot = join(root, 'checkpoints')
    await writeSearchPayload(searchPath)
    await writeBaseManifest(manifestPath)

    await expect(runPhaseBTrialSweep({
      searchJson: searchPath,
      baseManifest: manifestPath,
      sweepId: 'sweep_manifest_hash',
      symbol: 'BTC-USDT',
      resume: false,
      fresh: true,
      runId: 'sweep_run_004',
      checkpointRoot,
    }, {
      appendExecutionJournal: noOpJournal,
      now: fixedNow,
      execNodeQuiet: async (args) => {
        const tag = getArg(args, '--tag')
        if (tag.endsWith('.trial_002')) {
          throw new Error('leave partial checkpoint')
        }
        await writeRouteOutputs(tag)
      },
    })).rejects.toThrow(/leave partial checkpoint/)

    await writeBaseManifest(manifestPath, { multipleTestingUnit: 'family' })

    await expect(runPhaseBTrialSweep({
      searchJson: searchPath,
      baseManifest: manifestPath,
      sweepId: 'sweep_manifest_hash',
      symbol: 'BTC-USDT',
      resume: true,
      fresh: false,
      runId: 'sweep_run_004',
      checkpointRoot,
    }, {
      appendExecutionJournal: noOpJournal,
      now: fixedNow,
      execNodeQuiet: async () => {
        throw new Error('should not run')
      },
    })).rejects.toThrow(/baseManifestHash/)
  })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oa-phaseb-sweep-'))
  tempRoots.push(root)
  return root
}

function enterCwd(path: string): void {
  cwdStack.push(process.cwd())
  process.chdir(path)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

async function writeSearchPayload(
  path: string,
  allTrials = [
    { trial: 1, template: ['trend'], candidates: [{ strategyId: 't1' }] },
    { trial: 2, template: ['breakout'], candidates: [{ strategyId: 't2' }] },
  ],
): Promise<void> {
  await writeJson(path, {
    run_id: 'search_fixture',
    allTrials,
  })
}

async function writeBaseManifest(
  path: string,
  overrides: { multipleTestingUnit?: 'candidate' | 'family' } = {},
): Promise<void> {
  await writeJson(path, {
    significance: { multipleTestingUnit: overrides.multipleTestingUnit ?? 'candidate' },
    thresholds: {
      meanPboMax: 0.2,
      meanDsrProbabilityMin: 0.65,
      fdrQMax: 0.1,
    },
    dataset: {
      inputCsv: 'fixtures/btc.csv',
      lookbackBars: 100,
    },
    candidates: [{ strategyId: 'base' }],
  })
}

async function writeRouteOutputs(tag: string): Promise<void> {
  await mkdir('data/research/strategy', { recursive: true })
  const isTrialOne = tag.endsWith('.trial_001')
  await writeJson(`data/research/strategy/experiment_verdict.${tag}.json`, {
    result: isTrialOne ? 'GO' : 'NO_GO',
    reasonCodes: isTrialOne ? [] : ['stress_blocked'],
    thresholds: {
      meanPboMax: 0.2,
      meanDsrProbabilityMin: 0.65,
      fdrQMax: 0.1,
    },
    aggregateMetrics: {
      meanPbo: isTrialOne ? 0.1 : 0.3,
      meanDsrProbability: isTrialOne ? 0.8 : 0.5,
      fdrQ: isTrialOne ? 0.05 : 0.2,
    },
  })
  await writeJson(`data/research/strategy/strategy_validation_runs.${tag}.json`, {
    aggregateMetrics: {
      meanPbo: isTrialOne ? 0.1 : 0.3,
      meanDsrProbability: isTrialOne ? 0.8 : 0.5,
      fdrQ: isTrialOne ? 0.05 : 0.2,
    },
    symbols: [
      {
        candidates: [
          {
            backtestMetrics: { sharpe: isTrialOne ? 1.5 : 0.4 },
            releaseGate: {
              checks: [
                { name: 'wfo', metrics: { failedWindowRatio: isTrialOne ? 0.1 : 0.7 } },
              ],
            },
          },
        ],
      },
    ],
  })
}

function getArg(args: string[], key: string): string {
  const index = args.indexOf(key)
  if (index < 0 || !args[index + 1]) {
    throw new Error(`missing ${key}`)
  }
  return args[index + 1]!
}

function fixedNow(): Date {
  return new Date('2026-05-04T00:00:00.000Z')
}

async function noOpJournal(entry: ExecutionJournalEntry) {
  return {
    journalPath: '/dev/null',
    entry,
  }
}
