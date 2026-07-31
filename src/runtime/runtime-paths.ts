import { isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export type RuntimeRole = 'primary' | 'canary' | 'test'

export interface RuntimeCapabilities {
  ownsCron: boolean
  initializesAccounts: boolean
  orderSubmissionPathEnabled: boolean
  writesPromotion: boolean
  writesSharedData: boolean
}

export interface RuntimePorts {
  web?: number
  mcp?: number
  mcpAsk?: number
}

export interface RuntimePaths {
  role: RuntimeRole
  repoRoot: string
  dataDir: string
  sharedDataInputDir: string
  configDir: string
  marketInputDir: string
  stateDir: string
  artifactDir: string
  logDir: string
  releaseDir: string
  cronStateFile: string
  cronDefinitionOverlayFile: string
  eventLogFile: string
  toolCallLogFile: string
  sessionDir: string
  mediaDir: string
  newsLogFile: string
  capabilities: RuntimeCapabilities
  portOverrides: RuntimePorts
}

export interface RuntimePathOptions {
  env?: NodeJS.ProcessEnv
  repoRoot?: string
  osTmpDir?: string
}

const PRIMARY_CAPABILITIES: RuntimeCapabilities = {
  ownsCron: true,
  initializesAccounts: true,
  orderSubmissionPathEnabled: true,
  writesPromotion: true,
  writesSharedData: true,
}

const ISOLATED_CAPABILITIES: RuntimeCapabilities = {
  ownsCron: false,
  initializesAccounts: false,
  orderSubmissionPathEnabled: false,
  writesPromotion: false,
  writesSharedData: false,
}

export function resolveRuntimeRole(raw = process.env.OPENALICE_RUNTIME_ROLE): RuntimeRole {
  return parseRuntimeRole(raw)
}

function parseRuntimeRole(raw: string | undefined): RuntimeRole {
  const normalized = raw?.trim() || 'primary'
  if (normalized === 'primary' || normalized === 'canary' || normalized === 'test') {
    return normalized
  }
  throw new Error(`invalid OPENALICE_RUNTIME_ROLE: ${normalized}`)
}

export function resolveRuntimePaths(options: RuntimePathOptions = {}): RuntimePaths {
  const env = options.env ?? process.env
  const repoRoot = resolve(options.repoRoot ?? process.cwd())
  const role = parseRuntimeRole(env.OPENALICE_RUNTIME_ROLE)
  const primaryDataDir = resolveFrom(repoRoot, env.OPENALICE_DATA_DIR, 'data')
  const primaryConfigDir = resolveFrom(
    repoRoot,
    env.OPENALICE_CONFIG_DIR,
    join(primaryDataDir, 'config'),
  )
  const primaryMarketInputDir = resolveFrom(
    repoRoot,
    env.OPENALICE_MARKET_INPUT_DIR,
    join(primaryDataDir, 'market'),
  )
  const releaseDir = resolveFrom(repoRoot, env.OPENALICE_RELEASE_DIR, 'runtime/releases')

  if (role === 'primary') {
    const stateDir = resolveFrom(repoRoot, env.OPENALICE_STATE_DIR, primaryDataDir)
    const artifactDir = resolveFrom(
      repoRoot,
      env.OPENALICE_ARTIFACT_DIR,
      join(stateDir, 'runtime'),
    )
    const logDir = resolveFrom(repoRoot, env.OPENALICE_LOG_DIR, 'logs')
    return buildRuntimePaths({
      role,
      repoRoot,
      dataDir: stateDir,
      sharedDataInputDir: stateDir,
      configDir: primaryConfigDir,
      marketInputDir: primaryMarketInputDir,
      stateDir,
      artifactDir,
      logDir,
      releaseDir,
      capabilities: PRIMARY_CAPABILITIES,
      portOverrides: {},
    })
  }

  if (role === 'canary') {
    const canaryRoot = resolveFrom(
      repoRoot,
      env.OPENALICE_CANARY_ROOT,
      'runtime/canary/default',
    )
    assertDistinct(canaryRoot, primaryDataDir, 'canary root', 'primary data directory')
    return buildRuntimePaths({
      role,
      repoRoot,
      dataDir: join(canaryRoot, 'state'),
      sharedDataInputDir: primaryDataDir,
      configDir: primaryConfigDir,
      marketInputDir: primaryMarketInputDir,
      stateDir: join(canaryRoot, 'state'),
      artifactDir: join(canaryRoot, 'artifacts'),
      logDir: join(canaryRoot, 'logs'),
      releaseDir,
      capabilities: ISOLATED_CAPABILITIES,
      portOverrides: {
        web: parsePort(env.OPENALICE_CANARY_WEB_PORT, 3102),
        mcp: parsePort(env.OPENALICE_CANARY_MCP_PORT, 3101),
        mcpAsk: parseOptionalPort(env.OPENALICE_CANARY_MCP_ASK_PORT),
      },
    })
  }

  const testRootRaw = env.OPENALICE_TEST_ROOT?.trim()
  if (!testRootRaw) {
    throw new Error('OPENALICE_TEST_ROOT is required for RuntimeRole=test')
  }
  const testRoot = resolveFrom(repoRoot, testRootRaw)
  const osTmpDir = resolve(options.osTmpDir ?? tmpdir())
  if (!isWithin(osTmpDir, testRoot)) {
    throw new Error(`OPENALICE_TEST_ROOT must be inside the OS temporary directory: ${osTmpDir}`)
  }
  return buildRuntimePaths({
    role,
    repoRoot,
    dataDir: join(testRoot, 'data'),
    sharedDataInputDir: join(testRoot, 'data'),
    configDir: join(testRoot, 'config'),
    marketInputDir: join(testRoot, 'market'),
    stateDir: join(testRoot, 'state'),
    artifactDir: join(testRoot, 'artifacts'),
    logDir: join(testRoot, 'logs'),
    releaseDir: join(testRoot, 'releases'),
    capabilities: ISOLATED_CAPABILITIES,
    portOverrides: {
      web: parseOptionalPort(env.OPENALICE_TEST_WEB_PORT),
      mcp: parseOptionalPort(env.OPENALICE_TEST_MCP_PORT),
      mcpAsk: parseOptionalPort(env.OPENALICE_TEST_MCP_ASK_PORT),
    },
  })
}

export function configureRuntimeEnvironment(paths: RuntimePaths): void {
  process.env.OPENALICE_RUNTIME_ROLE = paths.role
  process.env.OPENALICE_DATA_DIR = paths.dataDir
  process.env.OPENALICE_SHARED_DATA_INPUT_DIR = paths.sharedDataInputDir
  process.env.OPENALICE_CONFIG_DIR = paths.configDir
  process.env.OPENALICE_MARKET_INPUT_DIR = paths.marketInputDir
  process.env.OPENALICE_STATE_DIR = paths.stateDir
  process.env.OPENALICE_ARTIFACT_DIR = paths.artifactDir
  process.env.OPENALICE_LOG_DIR = paths.logDir
  process.env.OPENALICE_RELEASE_DIR = paths.releaseDir
  if (paths.role !== 'primary') {
    process.env.OPENALICE_CONFIG_READ_ONLY = '1'
  }
}

export function resolveDataPath(...segments: string[]): string {
  const base = process.env.OPENALICE_DATA_DIR
    ? resolve(process.env.OPENALICE_DATA_DIR)
    : resolve('data')
  return join(base, ...segments)
}

export function isConfigReadOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENALICE_CONFIG_READ_ONLY === '1' || parseRuntimeRole(env.OPENALICE_RUNTIME_ROLE) !== 'primary'
}

function buildRuntimePaths(
  input: Omit<
    RuntimePaths,
    | 'cronStateFile'
    | 'cronDefinitionOverlayFile'
    | 'eventLogFile'
    | 'toolCallLogFile'
    | 'sessionDir'
    | 'mediaDir'
    | 'newsLogFile'
  >,
): RuntimePaths {
  return {
    ...input,
    cronStateFile: join(input.stateDir, 'cron', 'jobs.json'),
    cronDefinitionOverlayFile: join(input.stateDir, 'cron', 'definitions.local.v1.json'),
    eventLogFile: join(input.stateDir, 'event-log', 'events.sqlite'),
    toolCallLogFile: join(input.stateDir, 'tool-calls', 'tool-calls.jsonl'),
    sessionDir: join(input.stateDir, 'sessions'),
    mediaDir: join(input.stateDir, 'media'),
    newsLogFile: join(input.stateDir, 'news-collector', 'news.jsonl'),
  }
}

function resolveFrom(repoRoot: string, value?: string, fallback?: string): string {
  const candidate = value?.trim() || fallback
  if (!candidate) {
    throw new Error('runtime path is required')
  }
  return isAbsolute(candidate) ? resolve(candidate) : resolve(repoRoot, candidate)
}

function assertDistinct(a: string, b: string, aName: string, bName: string): void {
  if (resolve(a) === resolve(b)) {
    throw new Error(`${aName} must not equal ${bName}`)
  }
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function parsePort(raw: string | undefined, fallback: number): number {
  return parseOptionalPort(raw) ?? fallback
}

function parseOptionalPort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`invalid runtime port: ${raw}`)
  }
  return value
}
