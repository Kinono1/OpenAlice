import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildArtifactPaths,
  buildBundlePaths,
  buildRuntimePublishPaths,
  buildRuntimePublishStatePath,
  parseArgs,
  publishRuntimeTargetsAtomically,
  rollbackRuntimeTargetsFromManifest,
} from './publish_eth_carry_runtime_bundle.ts'

describe('publish_eth_carry_runtime_bundle', () => {
  it('defaults the CLI to dry-run bundle inspection', () => {
    expect(parseArgs([])).toMatchObject({
      dryRun: true,
      publishRuntimeTargets: false,
    })
    expect(parseArgs(['--dryRun', 'false', '--publishRuntimeTargets', 'true'])).toMatchObject({
      dryRun: false,
      publishRuntimeTargets: true,
    })
  })

  it('builds expected source and bundle paths', async () => {
    const artifactDir = '/tmp/eth-carry/2026-04-13T04-23-51.210Z'
    await mkdir(artifactDir, { recursive: true })
    await writeFile(`${artifactDir}/eth_carry_short_bias_summary.json`, '{}\n', 'utf-8')
    expect(await buildArtifactPaths(artifactDir)).toEqual({
      prefix: 'eth_carry_short_bias',
      summary: `${artifactDir}/eth_carry_short_bias_summary.json`,
      validationReport: `${artifactDir}/eth_carry_short_bias.validation.json`,
      releaseGateStatus: `${artifactDir}/eth_carry_short_bias.release_gate_status.json`,
      validationRuns: `${artifactDir}/eth_carry_short_bias.strategy_validation_runs.json`,
      experimentVerdict: `${artifactDir}/eth_carry_short_bias.experiment_verdict.v2.json`,
      championRegistry: `${artifactDir}/eth_carry_short_bias.paper_champion_registry.json`,
      paperPortfolioTarget: `${artifactDir}/eth_carry_short_bias.paper_portfolio_target.json`,
    })

    expect(buildBundlePaths('/tmp/runtime-bundle')).toEqual({
      summary: '/tmp/runtime-bundle/eth_carry_summary.json',
      validationReport: '/tmp/runtime-bundle/eth_carry.validation.json',
      releaseGateStatus: '/tmp/runtime-bundle/release_gate_status.json',
      validationRuns: '/tmp/runtime-bundle/strategy_validation_runs.json',
      experimentVerdict: '/tmp/runtime-bundle/experiment_verdict.v2.json',
      championRegistry: '/tmp/runtime-bundle/paper_champion_registry.json',
      paperPortfolioTarget: '/tmp/runtime-bundle/paper_portfolio_target.json',
      gateCheckpointsDir: '/tmp/runtime-bundle/gates',
      decisionPacketDir: '/tmp/runtime-bundle/decision_packet',
    })

    expect(
      buildRuntimePublishPaths('/tmp/research/strategy', '/tmp/runtime'),
    ).toEqual({
      validationRuns: '/tmp/research/strategy/strategy_validation_runs.json',
      experimentVerdict: '/tmp/research/strategy/experiment_verdict.v2.json',
      releaseGateStatus: '/tmp/runtime/release_gate_status.json',
      championRegistry: '/tmp/runtime/paper_champion_registry.json',
      paperPortfolioTarget: '/tmp/runtime/paper_portfolio_target.json',
    })
    expect(buildRuntimePublishStatePath('/tmp/runtime')).toBe(
      '/tmp/runtime/runtime_publish_state.json',
    )
  })

  it('publishes runtime targets atomically and can roll them back from the manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eth-carry-publish-bundle-'))
    const sources = buildRuntimePublishPaths(join(dir, 'bundle/research/strategy'), join(dir, 'bundle/runtime'))
    const targets = buildRuntimePublishPaths(join(dir, 'live/research/strategy'), join(dir, 'live/runtime'))
    const manifestPath = join(dir, 'bundle/runtime_publish_manifest.json')
    const backupDir = join(dir, 'bundle/runtime_publish_backup')
    const runtimeStatePath = buildRuntimePublishStatePath(join(dir, 'live/runtime'))

    await mkdir(join(dir, 'bundle/research/strategy'), { recursive: true })
    await mkdir(join(dir, 'bundle/runtime'), { recursive: true })
    await mkdir(join(dir, 'live/research/strategy'), { recursive: true })
    await mkdir(join(dir, 'live/runtime'), { recursive: true })

    await writeFile(sources.validationRuns, 'new-validation\n', 'utf-8')
    await writeFile(sources.experimentVerdict, 'new-verdict\n', 'utf-8')
    await writeFile(sources.releaseGateStatus, 'new-gate\n', 'utf-8')
    await writeFile(sources.championRegistry, 'new-registry\n', 'utf-8')
    await writeFile(sources.paperPortfolioTarget, 'new-target\n', 'utf-8')

    await writeFile(targets.validationRuns, 'old-validation\n', 'utf-8')
    await writeFile(targets.experimentVerdict, 'old-verdict\n', 'utf-8')
    await writeFile(targets.releaseGateStatus, 'old-gate\n', 'utf-8')

    const manifest = await publishRuntimeTargetsAtomically({
      bundleDir: join(dir, 'bundle'),
      backupDir,
      manifestPath,
      runtimeStatePath,
      sources,
      targets,
    })

    expect(manifest.status).toBe('complete')
    expect(manifest.runtimeStatePath).toBe(runtimeStatePath)
    expect(manifest.targets).toHaveLength(5)
    const manifestOnDisk = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
      status: string
      runtimeStatePath?: string
      targets: Array<unknown>
    }
    expect(manifestOnDisk.status).toBe('complete')
    expect(manifestOnDisk.runtimeStatePath).toBe(runtimeStatePath)
    expect(manifestOnDisk.targets).toHaveLength(5)
    expect(await readFile(targets.validationRuns, 'utf-8')).toBe('new-validation\n')
    expect(await readFile(targets.paperPortfolioTarget, 'utf-8')).toBe('new-target\n')
    expect(JSON.parse(await readFile(runtimeStatePath, 'utf-8'))).toMatchObject({
      status: 'complete',
      targets: [
        expect.objectContaining({ name: 'validationRuns' }),
        expect.objectContaining({ name: 'experimentVerdict' }),
        expect.objectContaining({ name: 'releaseGateStatus' }),
        expect.objectContaining({ name: 'championRegistry' }),
        expect.objectContaining({ name: 'paperPortfolioTarget' }),
      ],
    })

    await rollbackRuntimeTargetsFromManifest(manifestPath)

    expect(await readFile(targets.validationRuns, 'utf-8')).toBe('old-validation\n')
    expect(await readFile(targets.experimentVerdict, 'utf-8')).toBe('old-verdict\n')
    expect(await readFile(targets.releaseGateStatus, 'utf-8')).toBe('old-gate\n')
    await expect(access(targets.championRegistry)).rejects.toThrow()
    await expect(access(targets.paperPortfolioTarget)).rejects.toThrow()
    expect(JSON.parse(await readFile(runtimeStatePath, 'utf-8'))).toMatchObject({
      status: 'complete',
    })
  })

  it('leaves the runtime guard pending when publish aborts mid-flight', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eth-carry-publish-bundle-pending-'))
    const sources = buildRuntimePublishPaths(join(dir, 'bundle/research/strategy'), join(dir, 'bundle/runtime'))
    const targets = buildRuntimePublishPaths(join(dir, 'live/research/strategy'), join(dir, 'live/runtime'))
    const manifestPath = join(dir, 'bundle/runtime_publish_manifest.json')
    const runtimeStatePath = buildRuntimePublishStatePath(join(dir, 'live/runtime'))

    await mkdir(join(dir, 'bundle/research/strategy'), { recursive: true })
    await mkdir(join(dir, 'bundle/runtime'), { recursive: true })
    await mkdir(join(dir, 'live/research/strategy'), { recursive: true })
    await mkdir(join(dir, 'live/runtime'), { recursive: true })

    await writeFile(sources.validationRuns, 'new-validation\n', 'utf-8')
    await writeFile(sources.experimentVerdict, 'new-verdict\n', 'utf-8')
    await writeFile(sources.releaseGateStatus, 'new-gate\n', 'utf-8')
    await writeFile(sources.championRegistry, 'new-registry\n', 'utf-8')

    await expect(
      publishRuntimeTargetsAtomically({
        bundleDir: join(dir, 'bundle'),
        backupDir: join(dir, 'bundle/runtime_publish_backup'),
        manifestPath,
        runtimeStatePath,
        sources,
        targets,
      }),
    ).rejects.toThrow()

    const state = JSON.parse(await readFile(runtimeStatePath, 'utf-8')) as {
      status: string
      targets: Array<{ name: string }>
    }
    expect(state.status).toBe('pending')
    expect(state.targets.length).toBeGreaterThan(0)
    expect(state.targets.length).toBeLessThan(5)
  })
})
