import { mkdir, copyFile, readdir, rename, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

interface CliArgs {
  artifactDir?: string
  outputDir?: string
  bundleName?: string
  buildGateCheckpoints: boolean
  buildDecisionPacket: boolean
  publishRuntimeTargets: boolean
  strategyResearchDir?: string
  runtimeDir?: string
  runtimePublishBackupDir?: string
  rollbackManifest?: string
  dryRun: boolean
}

interface ArtifactPaths {
  prefix: string
  summary: string
  validationReport: string
  releaseGateStatus: string
  validationRuns: string
  experimentVerdict: string
  championRegistry: string
  paperPortfolioTarget: string
}

interface RuntimePublishPaths {
  validationRuns: string
  experimentVerdict: string
  releaseGateStatus: string
  championRegistry: string
  paperPortfolioTarget: string
}

interface RuntimePublishState extends RuntimePublishManifest {
  runtimeStatePath: string
}

interface RuntimePublishManifestEntry {
  name: keyof RuntimePublishPaths
  sourcePath: string
  targetPath: string
  backupPath: string | null
  existedBefore: boolean
}

interface RuntimePublishManifest {
  version: 1
  generatedAt: string
  mode: 'publish'
  status: 'pending' | 'complete'
  bundleDir: string
  backupDir: string
  runtimeStatePath?: string | null
  targets: RuntimePublishManifestEntry[]
}

const DECISION_PACKET_TEMPLATE =
  'docs/research/templates/go_no_go_evidence_pack.template.json'
const RUNTIME_PUBLISH_STATE_FILENAME = 'runtime_publish_state.json'

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.rollbackManifest) {
    const restored = await rollbackRuntimeTargetsFromManifest(resolve(args.rollbackManifest))
    console.log(restored)
    return
  }
  const artifactDir = args.artifactDir
    ? resolve(args.artifactDir)
    : await resolveLatestEthCarryArtifactDir()
  const artifactPaths = await buildArtifactPaths(artifactDir)
  await assertArtifactsExist(artifactPaths)

  const outputDir = args.outputDir
    ? resolve(args.outputDir)
    : resolve(
        `data/runtime/eth_carry_bundle/${args.bundleName ?? artifactDir.split('/').at(-1) ?? 'latest'}`,
      )

  const bundle = buildBundlePaths(outputDir)
  const runtimePublishTargets = args.publishRuntimeTargets
    ? buildRuntimePublishPaths(
        args.strategyResearchDir ? resolve(args.strategyResearchDir) : resolve('data/research/strategy'),
        args.runtimeDir ? resolve(args.runtimeDir) : resolve('data/runtime'),
      )
    : null
  const runtimePublishStatePath = args.publishRuntimeTargets
    ? buildRuntimePublishStatePath(args.runtimeDir ? resolve(args.runtimeDir) : resolve('data/runtime'))
    : null
  const runtimePublishBackupDir = args.publishRuntimeTargets
    ? resolve(args.runtimePublishBackupDir ?? join(outputDir, 'runtime_publish_backup'))
    : null
  const runtimePublishManifestPath = args.publishRuntimeTargets
    ? join(outputDir, 'runtime_publish_manifest.json')
    : null

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          artifactDir,
          outputDir,
          artifactPaths,
          bundle,
          runtimePublishTargets,
          runtimePublishStatePath,
          runtimePublishBackupDir,
          runtimePublishManifestPath,
          buildGateCheckpoints: args.buildGateCheckpoints,
          buildDecisionPacket: args.buildDecisionPacket,
        },
        null,
        2,
      ),
    )
    return
  }

  await mkdir(outputDir, { recursive: true })
  await Promise.all([
    copyArtifact(artifactPaths.summary, bundle.summary),
    copyArtifact(artifactPaths.validationReport, bundle.validationReport),
    copyArtifact(artifactPaths.releaseGateStatus, bundle.releaseGateStatus),
    copyArtifact(artifactPaths.validationRuns, bundle.validationRuns),
    copyArtifact(artifactPaths.experimentVerdict, bundle.experimentVerdict),
    copyArtifact(artifactPaths.championRegistry, bundle.championRegistry),
    copyArtifact(artifactPaths.paperPortfolioTarget, bundle.paperPortfolioTarget),
  ])

  if (args.buildGateCheckpoints) {
    await execFileAsync('python3', [
      'scripts/build_gate_checkpoints.py',
      '--output-dir', bundle.gateCheckpointsDir,
      '--experiment-verdict', bundle.experimentVerdict,
      '--release-gate-status', bundle.releaseGateStatus,
    ], { cwd: process.cwd() })
  }

  if (args.buildDecisionPacket) {
    await execFileAsync('python3', [
      'scripts/build_decision_packet.py',
      '--template', DECISION_PACKET_TEMPLATE,
      '--output-dir', bundle.decisionPacketDir,
      '--champion-registry-snapshot', bundle.championRegistry,
      '--release-gate-status', bundle.releaseGateStatus,
      '--experiment-verdict', bundle.experimentVerdict,
      '--gate-checkpoints-dir', bundle.gateCheckpointsDir,
    ], { cwd: process.cwd() })
  }

  if (runtimePublishTargets) {
    await publishRuntimeTargetsAtomically({
      bundleDir: outputDir,
      backupDir: runtimePublishBackupDir!,
      manifestPath: runtimePublishManifestPath!,
      runtimeStatePath: runtimePublishStatePath!,
      sources: {
        validationRuns: bundle.validationRuns,
        experimentVerdict: bundle.experimentVerdict,
        releaseGateStatus: bundle.releaseGateStatus,
        championRegistry: bundle.championRegistry,
        paperPortfolioTarget: bundle.paperPortfolioTarget,
      },
      targets: runtimePublishTargets,
    })
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    family: 'eth_carry',
    sourceArtifactDir: artifactDir,
    outputDir,
    files: {
      summary: bundle.summary,
      validationReport: bundle.validationReport,
      releaseGateStatus: bundle.releaseGateStatus,
      validationRuns: bundle.validationRuns,
      experimentVerdict: bundle.experimentVerdict,
      championRegistry: bundle.championRegistry,
      paperPortfolioTarget: bundle.paperPortfolioTarget,
      gateCheckpointsDir: args.buildGateCheckpoints ? bundle.gateCheckpointsDir : null,
      decisionPacketDir: args.buildDecisionPacket ? bundle.decisionPacketDir : null,
    },
    publishedRuntimeTargets: runtimePublishTargets,
    runtimePublishBackupDir,
    runtimePublishManifestPath,
  }
  await writeFile(join(outputDir, 'bundle_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')

  console.log(outputDir)
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    artifactDir: raw.get('artifactDir') ?? undefined,
    outputDir: raw.get('outputDir') ?? undefined,
    bundleName: raw.get('bundleName') ?? undefined,
    buildGateCheckpoints: parseBoolArg(raw.get('buildGateCheckpoints'), true),
    buildDecisionPacket: parseBoolArg(raw.get('buildDecisionPacket'), true),
    publishRuntimeTargets: parseBoolArg(raw.get('publishRuntimeTargets'), false),
    strategyResearchDir: raw.get('strategyResearchDir') ?? undefined,
    runtimeDir: raw.get('runtimeDir') ?? undefined,
    runtimePublishBackupDir: raw.get('runtimePublishBackupDir') ?? undefined,
    rollbackManifest: raw.get('rollbackManifest') ?? undefined,
    dryRun: parseBoolArg(raw.get('dryRun'), true),
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

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

async function resolveLatestEthCarryArtifactDir(): Promise<string> {
  const root = resolve('data/research/standalone_eth_carry')
  const entries = await readdir(root, { withFileTypes: true })
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const latest = dirs.at(-1)
  if (!latest) {
    throw new Error(`No ETH carry artifact directories found under ${root}.`)
  }
  return resolve(root, latest)
}

async function buildArtifactPaths(artifactDir: string): Promise<ArtifactPaths> {
  const entries = await readdir(artifactDir)
  const summaryName = entries.find((name) => name.endsWith('_summary.json'))
  if (!summaryName) {
    throw new Error(`No *_summary.json found under ${artifactDir}`)
  }
  const prefix = summaryName.slice(0, -'_summary.json'.length)
  return {
    prefix,
    summary: join(artifactDir, `${prefix}_summary.json`),
    validationReport: join(artifactDir, `${prefix}.validation.json`),
    releaseGateStatus: join(artifactDir, `${prefix}.release_gate_status.json`),
    validationRuns: join(artifactDir, `${prefix}.strategy_validation_runs.json`),
    experimentVerdict: join(artifactDir, `${prefix}.experiment_verdict.v2.json`),
    championRegistry: join(artifactDir, `${prefix}.paper_champion_registry.json`),
    paperPortfolioTarget: join(artifactDir, `${prefix}.paper_portfolio_target.json`),
  }
}

function buildBundlePaths(outputDir: string) {
  return {
    summary: join(outputDir, 'eth_carry_summary.json'),
    validationReport: join(outputDir, 'eth_carry.validation.json'),
    releaseGateStatus: join(outputDir, 'release_gate_status.json'),
    validationRuns: join(outputDir, 'strategy_validation_runs.json'),
    experimentVerdict: join(outputDir, 'experiment_verdict.v2.json'),
    championRegistry: join(outputDir, 'paper_champion_registry.json'),
    paperPortfolioTarget: join(outputDir, 'paper_portfolio_target.json'),
    gateCheckpointsDir: join(outputDir, 'gates'),
    decisionPacketDir: join(outputDir, 'decision_packet'),
  }
}

function buildRuntimePublishPaths(
  strategyResearchDir: string,
  runtimeDir: string,
): RuntimePublishPaths {
  return {
    validationRuns: join(strategyResearchDir, 'strategy_validation_runs.json'),
    experimentVerdict: join(strategyResearchDir, 'experiment_verdict.v2.json'),
    releaseGateStatus: join(runtimeDir, 'release_gate_status.json'),
    championRegistry: join(runtimeDir, 'paper_champion_registry.json'),
    paperPortfolioTarget: join(runtimeDir, 'paper_portfolio_target.json'),
  }
}

function buildRuntimePublishStatePath(runtimeDir: string): string {
  return join(runtimeDir, RUNTIME_PUBLISH_STATE_FILENAME)
}

async function assertArtifactsExist(paths: ArtifactPaths): Promise<void> {
  for (const [key, path] of Object.entries(paths)) {
    if (key === 'prefix') continue
    if (!existsSync(path)) {
      throw new Error(`Required ETH carry artifact missing: ${path}`)
    }
  }
}

async function copyArtifact(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
}

async function publishRuntimeTargetsAtomically(input: {
  bundleDir: string
  backupDir: string
  manifestPath: string
  runtimeStatePath: string
  sources: RuntimePublishPaths
  targets: RuntimePublishPaths
}): Promise<RuntimePublishManifest> {
  await mkdir(input.backupDir, { recursive: true })
  const targetNames: Array<keyof RuntimePublishPaths> = [
    'validationRuns',
    'experimentVerdict',
    'releaseGateStatus',
    'championRegistry',
    'paperPortfolioTarget',
  ]
  const manifest: RuntimePublishManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: 'publish',
    status: 'pending',
    bundleDir: input.bundleDir,
    backupDir: input.backupDir,
    runtimeStatePath: input.runtimeStatePath,
    targets: [],
  }
  await writeRuntimePublishManifest(input.manifestPath, manifest)
  await writeRuntimePublishManifest(input.runtimeStatePath, manifest)

  for (const name of targetNames) {
    const sourcePath = input.sources[name]
    const targetPath = input.targets[name]
    const existedBefore = existsSync(targetPath)
    const backupPath = existedBefore
      ? join(input.backupDir, `${name}${extensionForPath(targetPath)}`)
      : null

    if (backupPath) {
      await copyArtifact(targetPath, backupPath)
    }

    await atomicReplaceFile(sourcePath, targetPath)
    manifest.targets.push({
      name,
      sourcePath,
      targetPath,
      backupPath,
      existedBefore,
    })
    await writeRuntimePublishManifest(input.manifestPath, manifest)
    await writeRuntimePublishManifest(input.runtimeStatePath, manifest)
  }

  manifest.status = 'complete'
  await writeRuntimePublishManifest(input.manifestPath, manifest)
  await writeRuntimePublishManifest(input.runtimeStatePath, manifest)
  return manifest
}

async function rollbackRuntimeTargetsFromManifest(manifestPath: string): Promise<string> {
  const raw = JSON.parse(await readFile(manifestPath, 'utf-8')) as Partial<RuntimePublishManifest>
  if (
    raw.version !== 1 ||
    raw.mode !== 'publish' ||
    typeof raw.bundleDir !== 'string' ||
    typeof raw.backupDir !== 'string' ||
    !Array.isArray(raw.targets)
  ) {
    throw new Error(`Invalid runtime publish manifest: ${manifestPath}`)
  }

  for (const entry of raw.targets as RuntimePublishManifestEntry[]) {
    if (entry.existedBefore) {
      if (!entry.backupPath || !existsSync(entry.backupPath)) {
        throw new Error(`Missing backup for rollback target ${entry.name}: ${entry.targetPath}`)
      }
      await atomicReplaceFile(entry.backupPath, entry.targetPath)
      continue
    }
    if (existsSync(entry.targetPath)) {
      await rm(entry.targetPath)
    }
  }

  if (typeof raw.runtimeStatePath === 'string' && raw.runtimeStatePath.length > 0) {
    await writeRuntimePublishManifest(raw.runtimeStatePath, {
      ...raw,
      version: 1,
      generatedAt: raw.generatedAt ?? new Date().toISOString(),
      mode: 'publish',
      status: 'complete',
      bundleDir: raw.bundleDir,
      backupDir: raw.backupDir,
      runtimeStatePath: raw.runtimeStatePath,
      targets: raw.targets as RuntimePublishManifestEntry[],
    } as RuntimePublishManifest)
  }

  return manifestPath
}

async function atomicReplaceFile(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  const tempPath = join(
    dirname(targetPath),
    `.${targetPath.split('/').at(-1) ?? 'artifact'}.tmp-${Date.now()}`,
  )
  await copyFile(sourcePath, tempPath)
  await rename(tempPath, targetPath)
}

async function writeRuntimePublishManifest(
  path: string,
  manifest: RuntimePublishManifest,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = join(
    dirname(path),
    `.${path.split('/').at(-1) ?? 'runtime_publish_state'}.tmp-${Date.now()}`,
  )
  await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  await rename(tempPath, path)
}

function extensionForPath(path: string): string {
  const index = path.lastIndexOf('.')
  return index >= 0 ? path.slice(index) : ''
}

export {
  buildArtifactPaths,
  buildBundlePaths,
  buildRuntimePublishPaths,
  buildRuntimePublishStatePath,
  parseArgs,
  publishRuntimeTargetsAtomically,
  rollbackRuntimeTargetsFromManifest,
  resolveLatestEthCarryArtifactDir,
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
