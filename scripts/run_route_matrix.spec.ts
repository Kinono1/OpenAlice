import { existsSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeCheckpointStore } from '../src/runtime/runtime_checkpoint.js'
import type { ExecutionJournalEntry } from './lib/execution_journal.js'
import { parseArgs, runRouteMatrix } from './run_route_matrix.js'

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

describe('run_route_matrix checkpoint integration', () => {
  it('parses resume, fresh, run id, and checkpoint root flags', () => {
    expect(parseArgs([
      '--matrix-config',
      'matrix.json',
      '--resume',
      '--run-id',
      'route_run_001',
      '--checkpoint-root',
      'tmp/checkpoints',
    ])).toEqual({
      matrixConfig: 'matrix.json',
      resume: true,
      fresh: false,
      runId: 'route_run_001',
      checkpointRoot: 'tmp/checkpoints',
    })

    expect(() => parseArgs([
      '--matrix-config',
      'matrix.json',
      '--resume',
      '--fresh',
    ])).toThrow(/mutually exclusive/)
  })

  it('resumes after a completed profile and clears checkpoint after success', async () => {
    const root = await tempRoot()
    enterCwd(root)

    const manifestPath = join(root, 'base-manifest.json')
    const summaryOutput = join(root, 'out', 'route-matrix.json')
    const markdownOutput = join(root, 'out', 'route-matrix.md')
    const matrixConfigPath = join(root, 'matrix.json')
    const checkpointRoot = join(root, 'checkpoints')
    await writeJson(manifestPath, {
      significance: { multipleTestingUnit: 'candidate' },
      thresholds: {
        meanPboMax: 0.2,
        meanDsrProbabilityMin: 0.65,
        fdrQMax: 0.1,
      },
      candidates: [{ strategyId: 'base' }],
    })
    await writeJson(matrixConfigPath, {
      matrixId: 'matrix_resume',
      manifest: manifestPath,
      summaryOutput,
      markdownOutput,
      profiles: [
        { id: 'stable', fdrMethod: 'bh' },
        { id: 'stress', fdrMethod: 'by' },
      ],
    })

    const firstCalls: string[] = []
    await expect(runRouteMatrix({
      matrixConfig: matrixConfigPath,
      resume: false,
      fresh: true,
      runId: 'route_run_001',
      checkpointRoot,
    }, {
      appendExecutionJournal: noOpJournal,
      now: fixedNow,
      execNode: async (args) => {
        const tag = getArg(args, '--tag')
        firstCalls.push(tag)
        if (tag.endsWith('.stress')) {
          throw new Error('injected failure after first profile')
        }
        await writeRouteOutputs(tag)
      },
    })).rejects.toThrow(/injected failure/)

    expect(firstCalls).toEqual(['matrix_resume.stable', 'matrix_resume.stress'])
    const checkpointStore = new RuntimeCheckpointStore({
      rootDir: checkpointRoot,
      namespace: 'route_matrix',
    })
    const checkpoint = checkpointStore.load<{
      completedProfiles: string[]
      results: Array<{ profile: string }>
    }>('route_run_001')
    expect(checkpoint.ok).toBe(true)
    if (checkpoint.ok) {
      expect(checkpoint.checkpoint.step).toBe('profile_completed')
      expect(checkpoint.checkpoint.state.completedProfiles).toEqual(['stable'])
      expect(checkpoint.checkpoint.state.results.map((item) => item.profile)).toEqual(['stable'])
    }

    const secondCalls: string[] = []
    const result = await runRouteMatrix({
      matrixConfig: matrixConfigPath,
      resume: true,
      fresh: false,
      runId: 'route_run_001',
      checkpointRoot,
    }, {
      appendExecutionJournal: noOpJournal,
      now: fixedNow,
      execNode: async (args) => {
        const tag = getArg(args, '--tag')
        secondCalls.push(tag)
        await writeRouteOutputs(tag)
      },
    })

    expect(secondCalls).toEqual(['matrix_resume.stress'])
    expect(result.recommendedProfile).toBe('stable')
    expect(existsSync(checkpointStore.pathFor('route_run_001'))).toBe(false)

    const summary = JSON.parse(await readFile(summaryOutput, 'utf-8')) as {
      recommendedProfile: string
      profiles: Array<{ profile: string }>
      summary: { profileCount: number }
    }
    expect(summary.recommendedProfile).toBe('stable')
    expect(summary.summary.profileCount).toBe(2)
    expect(summary.profiles.map((profile) => profile.profile)).toEqual(['stable', 'stress'])
    expect(await readFile(markdownOutput, 'utf-8')).toContain('# Route Matrix matrix_resume')
  })

  it('requires an explicit resume or fresh choice when a checkpoint exists', async () => {
    const root = await tempRoot()
    enterCwd(root)

    const manifestPath = join(root, 'base-manifest.json')
    const matrixConfigPath = join(root, 'matrix.json')
    const checkpointRoot = join(root, 'checkpoints')
    await writeJson(manifestPath, {
      significance: { multipleTestingUnit: 'candidate' },
      candidates: [{ strategyId: 'base' }],
    })
    await writeJson(matrixConfigPath, {
      matrixId: 'matrix_requires_mode',
      manifest: manifestPath,
      profiles: [{ id: 'stable' }],
    })

    await expect(runRouteMatrix({
      matrixConfig: matrixConfigPath,
      resume: false,
      fresh: true,
      runId: 'route_run_002',
      checkpointRoot,
    }, {
      appendExecutionJournal: noOpJournal,
      now: fixedNow,
      execNode: async (args) => {
        await writeRouteOutputs(getArg(args, '--tag'))
        throw new Error('leave checkpoint behind')
      },
    })).rejects.toThrow(/leave checkpoint/)

    await expect(runRouteMatrix({
      matrixConfig: matrixConfigPath,
      resume: false,
      fresh: false,
      runId: 'route_run_002',
      checkpointRoot,
    }, {
      appendExecutionJournal: noOpJournal,
      now: fixedNow,
      execNode: async () => {
        throw new Error('should not run')
      },
    })).rejects.toThrow(/Use --resume to continue or --fresh to discard it/)
  })

  it('rejects resume when the checkpoint config hash differs', async () => {
    const root = await tempRoot()
    enterCwd(root)

    const manifestPath = join(root, 'base-manifest.json')
    const matrixConfigPath = join(root, 'matrix.json')
    const checkpointRoot = join(root, 'checkpoints')
    await writeJson(manifestPath, {
      significance: { multipleTestingUnit: 'candidate' },
      candidates: [{ strategyId: 'base' }],
    })
    await writeJson(matrixConfigPath, {
      matrixId: 'matrix_config_hash',
      manifest: manifestPath,
      profiles: [
        { id: 'stable' },
        { id: 'stress' },
      ],
    })

    await expect(runRouteMatrix({
      matrixConfig: matrixConfigPath,
      resume: false,
      fresh: true,
      runId: 'route_run_003',
      checkpointRoot,
    }, {
      appendExecutionJournal: noOpJournal,
      now: fixedNow,
      execNode: async (args) => {
        const tag = getArg(args, '--tag')
        if (tag.endsWith('.stress')) {
          throw new Error('leave partial checkpoint')
        }
        await writeRouteOutputs(tag)
      },
    })).rejects.toThrow(/leave partial checkpoint/)

    await writeJson(matrixConfigPath, {
      matrixId: 'matrix_config_hash',
      manifest: manifestPath,
      rankingObjective: 'changed objective',
      profiles: [
        { id: 'stable' },
        { id: 'stress' },
      ],
    })

    await expect(runRouteMatrix({
      matrixConfig: matrixConfigPath,
      resume: true,
      fresh: false,
      runId: 'route_run_003',
      checkpointRoot,
    }, {
      appendExecutionJournal: noOpJournal,
      now: fixedNow,
      execNode: async () => {
        throw new Error('should not run')
      },
    })).rejects.toThrow(/matrixConfigHash/)
  })

  it('rejects resume when the base manifest hash differs', async () => {
    const root = await tempRoot()
    enterCwd(root)

    const manifestPath = join(root, 'base-manifest.json')
    const matrixConfigPath = join(root, 'matrix.json')
    const checkpointRoot = join(root, 'checkpoints')
    await writeJson(manifestPath, {
      significance: { multipleTestingUnit: 'candidate' },
      candidates: [{ strategyId: 'base' }],
    })
    await writeJson(matrixConfigPath, {
      matrixId: 'matrix_manifest_hash',
      manifest: manifestPath,
      profiles: [
        { id: 'stable' },
        { id: 'stress' },
      ],
    })

    await expect(runRouteMatrix({
      matrixConfig: matrixConfigPath,
      resume: false,
      fresh: true,
      runId: 'route_run_004',
      checkpointRoot,
    }, {
      appendExecutionJournal: noOpJournal,
      now: fixedNow,
      execNode: async (args) => {
        const tag = getArg(args, '--tag')
        if (tag.endsWith('.stress')) {
          throw new Error('leave partial checkpoint')
        }
        await writeRouteOutputs(tag)
      },
    })).rejects.toThrow(/leave partial checkpoint/)

    await writeJson(manifestPath, {
      significance: { multipleTestingUnit: 'family' },
      candidates: [{ strategyId: 'base' }],
    })

    await expect(runRouteMatrix({
      matrixConfig: matrixConfigPath,
      resume: true,
      fresh: false,
      runId: 'route_run_004',
      checkpointRoot,
    }, {
      appendExecutionJournal: noOpJournal,
      now: fixedNow,
      execNode: async () => {
        throw new Error('should not run')
      },
    })).rejects.toThrow(/manifestHash/)
  })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oa-route-matrix-'))
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

async function writeRouteOutputs(tag: string): Promise<void> {
  await mkdir('data/research/strategy', { recursive: true })
  const isStable = tag.endsWith('.stable')
  await writeJson(`data/research/strategy/experiment_verdict.${tag}.json`, {
    result: isStable ? 'GO' : 'NO_GO',
    reasonCodes: isStable ? [] : ['stress_blocked'],
    thresholds: {
      meanPboMax: 0.2,
      meanDsrProbabilityMin: 0.65,
      fdrQMax: 0.1,
    },
    aggregateMetrics: {
      meanPbo: isStable ? 0.1 : 0.3,
      meanDsrProbability: isStable ? 0.8 : 0.5,
      fdrQ: isStable ? 0.05 : 0.2,
      fdrMethod: isStable ? 'bh' : 'by',
      wfoProfile: 'stable',
    },
  })
  await writeJson(`data/research/strategy/strategy_validation_runs.${tag}.json`, {
    aggregateMetrics: {
      meanPbo: isStable ? 0.1 : 0.3,
      meanDsrProbability: isStable ? 0.8 : 0.5,
      fdrQ: isStable ? 0.05 : 0.2,
    },
    symbols: [
      {
        candidates: [
          {
            backtestMetrics: { sharpe: isStable ? 1.5 : 0.4 },
            releaseGate: {
              checks: [
                { name: 'wfo', metrics: { failedWindowRatio: isStable ? 0.1 : 0.7 } },
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
