import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DEFAULT_LLM_API_KEY_ENV = 'DEEPSEEK_API_KEY'

interface CliArgs {
  label: string
  plistPath: string
  scriptPath: string
  workingDirectory: string
  sourceReleasePath?: string
  logPath: string
  errorLogPath: string
  launch: boolean
  dryRun: boolean
}

interface LaunchdConfig {
  label: string
  scriptPath: string
  workingDirectory: string
  logPath: string
  errorLogPath: string
  pathEnv: string
  homeEnv: string
  nodeExtraCaCerts?: string
  nodeUseSystemCa?: string
  openaliceLlmProvider?: string
  openaliceLlmBaseUrl?: string
  openaliceDeepseekBaseUrl?: string
  openaliceLlmRegularModel?: string
  openaliceLlmAnalysisModel?: string
  openaliceDeepseekFlashModel?: string
  openaliceDeepseekProModel?: string
  openaliceEnvFile?: string
  openaliceLlmApiKeyEnv?: string
  openaliceSkipSecondLevel?: string
  openalicePaperMonitorSkipData?: string
  openalicePaperMonitorSkipPaper?: string
  openalicePaperMonitorSkipOptimize?: string
  openalicePaperMonitorSkipValidation?: string
  openalicePaperMonitorRequirePromotionV2?: string
  openaliceRuntimeRole?: string
  openaliceReleaseDir?: string
  openaliceDataDir?: string
  openaliceSharedDataInputDir?: string
  openaliceConfigDir?: string
  openaliceMarketInputDir?: string
  openaliceStateDir?: string
  openaliceArtifactDir?: string
  openaliceLogDir?: string
  openaliceLegacyWipRoot?: string
  openaliceResearchWebPort?: string
  openaliceResearchMcpPort?: string
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const config = buildLaunchdConfig({
    label: args.label,
    scriptPath: args.scriptPath,
    workingDirectory: args.workingDirectory,
    logPath: args.logPath,
    errorLogPath: args.errorLogPath,
  })
  const plist = renderLaunchdPlist(config)

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          plistPath: resolve(args.plistPath),
          config,
          plist,
        },
        null,
        2,
      ),
    )
    return
  }

  await mkdir(dirname(resolve(args.plistPath)), { recursive: true })
  await mkdir(dirname(resolve(args.logPath)), { recursive: true })
  await mkdir(dirname(resolve(args.errorLogPath)), { recursive: true })
  await materializeStableLaunchWrapper(args.scriptPath, args.sourceReleasePath)
  await writeFile(resolve(args.plistPath), plist, 'utf-8')

  if (args.launch) {
    await reloadLaunchAgent(args.label, resolve(args.plistPath))
  }

  console.log(resolve(args.plistPath))
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const home = process.env.HOME ?? '/Users/kino'
  const label = raw.get('label') ?? 'ai.openalice.main'
  const scriptPath = resolve(
    raw.get('scriptPath') ?? 'runtime/bin/launch_openalice_current.sh',
  )
  return {
    label,
    plistPath:
      raw.get('plistPath') ?? `${home}/Library/LaunchAgents/${label}.plist`,
    scriptPath,
    workingDirectory: resolve(
      raw.get('workingDirectory') ?? join(dirname(scriptPath), '..'),
    ),
    sourceReleasePath: raw.get('sourceReleasePath')
      ? resolve(raw.get('sourceReleasePath')!)
      : undefined,
    logPath: raw.get('logPath') ?? resolve('logs/openalice_main.launchd.log'),
    errorLogPath: raw.get('errorLogPath') ?? resolve('logs/openalice_main.launchd.err.log'),
    launch: parseBoolArg(raw.get('launch'), false),
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

function buildLaunchdConfig(input: {
  label: string
  scriptPath: string
  workingDirectory?: string
  logPath: string
  errorLogPath: string
}): LaunchdConfig {
  const scriptPath = resolve(input.scriptPath)
  const workingDirectory = resolve(input.workingDirectory ?? join(dirname(scriptPath), '..'))
  const homeEnv = process.env.HOME ?? '/Users/kino'
  return {
    label: input.label,
    scriptPath,
    workingDirectory,
    logPath: resolve(input.logPath),
    errorLogPath: resolve(input.errorLogPath),
    pathEnv: process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    homeEnv,
    nodeExtraCaCerts: process.env.NODE_EXTRA_CA_CERTS,
    nodeUseSystemCa: process.env.NODE_USE_SYSTEM_CA,
    openaliceLlmProvider: process.env.OPENALICE_LLM_PROVIDER,
    openaliceLlmBaseUrl: process.env.OPENALICE_LLM_BASE_URL,
    openaliceDeepseekBaseUrl: process.env.OPENALICE_DEEPSEEK_BASE_URL,
    openaliceLlmRegularModel: process.env.OPENALICE_LLM_REGULAR_MODEL,
    openaliceLlmAnalysisModel: process.env.OPENALICE_LLM_ANALYSIS_MODEL,
    openaliceDeepseekFlashModel: process.env.OPENALICE_DEEPSEEK_FLASH_MODEL,
    openaliceDeepseekProModel: process.env.OPENALICE_DEEPSEEK_PRO_MODEL,
    openaliceEnvFile: process.env.OPENALICE_ENV_FILE ?? `${homeEnv}/.config/openalice/openalice.env`,
    openaliceLlmApiKeyEnv: process.env.OPENALICE_LLM_API_KEY_ENV ?? DEFAULT_LLM_API_KEY_ENV,
    openaliceSkipSecondLevel: process.env.OPENALICE_SKIP_SECOND_LEVEL,
    openalicePaperMonitorSkipData: process.env.OPENALICE_PAPER_MONITOR_SKIP_DATA,
    openalicePaperMonitorSkipPaper: process.env.OPENALICE_PAPER_MONITOR_SKIP_PAPER,
    openalicePaperMonitorSkipOptimize: process.env.OPENALICE_PAPER_MONITOR_SKIP_OPTIMIZE,
    openalicePaperMonitorSkipValidation: process.env.OPENALICE_PAPER_MONITOR_SKIP_VALIDATION,
    openalicePaperMonitorRequirePromotionV2: process.env.OPENALICE_PAPER_MONITOR_REQUIRE_PROMOTION_V2,
    openaliceRuntimeRole: process.env.OPENALICE_RUNTIME_ROLE,
    openaliceReleaseDir: process.env.OPENALICE_RELEASE_DIR,
    openaliceDataDir: process.env.OPENALICE_DATA_DIR,
    openaliceSharedDataInputDir: process.env.OPENALICE_SHARED_DATA_INPUT_DIR,
    openaliceConfigDir: process.env.OPENALICE_CONFIG_DIR,
    openaliceMarketInputDir: process.env.OPENALICE_MARKET_INPUT_DIR,
    openaliceStateDir: process.env.OPENALICE_STATE_DIR,
    openaliceArtifactDir: process.env.OPENALICE_ARTIFACT_DIR,
    openaliceLogDir: process.env.OPENALICE_LOG_DIR,
    openaliceLegacyWipRoot: process.env.OPENALICE_LEGACY_WIP_ROOT,
    openaliceResearchWebPort: process.env.OPENALICE_RESEARCH_WEB_PORT,
    openaliceResearchMcpPort: process.env.OPENALICE_RESEARCH_MCP_PORT,
  }
}

function renderLaunchdPlist(config: LaunchdConfig): string {
  const envEntries = [
    ['PATH', config.pathEnv],
    ['HOME', config.homeEnv],
    ['NODE_EXTRA_CA_CERTS', config.nodeExtraCaCerts],
    ['NODE_USE_SYSTEM_CA', config.nodeUseSystemCa],
    ['OPENALICE_LLM_PROVIDER', config.openaliceLlmProvider],
    ['OPENALICE_LLM_BASE_URL', config.openaliceLlmBaseUrl],
    ['OPENALICE_DEEPSEEK_BASE_URL', config.openaliceDeepseekBaseUrl],
    ['OPENALICE_LLM_REGULAR_MODEL', config.openaliceLlmRegularModel],
    ['OPENALICE_LLM_ANALYSIS_MODEL', config.openaliceLlmAnalysisModel],
    ['OPENALICE_DEEPSEEK_FLASH_MODEL', config.openaliceDeepseekFlashModel],
    ['OPENALICE_DEEPSEEK_PRO_MODEL', config.openaliceDeepseekProModel],
    ['OPENALICE_ENV_FILE', config.openaliceEnvFile],
    ['OPENALICE_LLM_API_KEY_ENV', config.openaliceLlmApiKeyEnv],
    ['OPENALICE_SKIP_SECOND_LEVEL', config.openaliceSkipSecondLevel],
    ['OPENALICE_PAPER_MONITOR_SKIP_DATA', config.openalicePaperMonitorSkipData],
    ['OPENALICE_PAPER_MONITOR_SKIP_PAPER', config.openalicePaperMonitorSkipPaper],
    ['OPENALICE_PAPER_MONITOR_SKIP_OPTIMIZE', config.openalicePaperMonitorSkipOptimize],
    ['OPENALICE_PAPER_MONITOR_SKIP_VALIDATION', config.openalicePaperMonitorSkipValidation],
    ['OPENALICE_PAPER_MONITOR_REQUIRE_PROMOTION_V2', config.openalicePaperMonitorRequirePromotionV2],
    ['OPENALICE_RUNTIME_ROLE', config.openaliceRuntimeRole],
    ['OPENALICE_RELEASE_DIR', config.openaliceReleaseDir],
    ['OPENALICE_DATA_DIR', config.openaliceDataDir],
    ['OPENALICE_SHARED_DATA_INPUT_DIR', config.openaliceSharedDataInputDir],
    ['OPENALICE_CONFIG_DIR', config.openaliceConfigDir],
    ['OPENALICE_MARKET_INPUT_DIR', config.openaliceMarketInputDir],
    ['OPENALICE_STATE_DIR', config.openaliceStateDir],
    ['OPENALICE_ARTIFACT_DIR', config.openaliceArtifactDir],
    ['OPENALICE_LOG_DIR', config.openaliceLogDir],
    ['OPENALICE_LEGACY_WIP_ROOT', config.openaliceLegacyWipRoot],
    ['OPENALICE_RESEARCH_WEB_PORT', config.openaliceResearchWebPort],
    ['OPENALICE_RESEARCH_MCP_PORT', config.openaliceResearchMcpPort],
  ].filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)

  for (const [key, value] of envEntries) {
    assertSafeLaunchdValue(key, value)
  }

  const envBlock = envEntries
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(config.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/bash</string>
    <string>${escapeXml(config.scriptPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(config.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(config.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(config.errorLogPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envBlock}
  </dict>
</dict>
</plist>
`
}

async function materializeStableLaunchWrapper(
  scriptPath: string,
  sourceReleasePath?: string,
): Promise<void> {
  const target = resolve(scriptPath)
  // A research cutover may keep the stable wrapper outside the frozen legacy
  // worktree.  Materialize any explicitly named stable wrapper, but never
  // overwrite a legacy `scripts/launch_openalice_main.sh` entrypoint.
  if (basename(target) !== 'launch_openalice_current.sh') return
  const binDir = dirname(target)
  await mkdir(binDir, { recursive: true })
  const sourceRoot = resolve(sourceReleasePath ?? '.')
  const files = [
    [join(sourceRoot, 'ops/release/launch_current.sh'), target],
    [join(sourceRoot, 'ops/release/launch_current.mjs'), resolve(binDir, 'launch_current.mjs')],
    [join(sourceRoot, 'scripts/openalice_env.sh'), resolve(binDir, 'openalice_env.sh')],
  ] as const
  for (const [source, destination] of files) {
    await copyFile(source, destination)
    await chmod(destination, 0o555)
  }
}

function assertSafeLaunchdValue(key: string, value: string): void {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const parsed = new URL(value)
    if (parsed.username || parsed.password) {
      throw new Error(`credential-bearing URL forbidden in launchd: ${key}`)
    }
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

async function reloadLaunchAgent(label: string, plistPath: string): Promise<void> {
  const domainTarget = `gui/${process.getuid?.() ?? 501}/${label}`
  try {
    await execFileAsync('/bin/launchctl', ['bootout', domainTarget])
  } catch {
    // ignore missing agent
  }
  await execFileAsync('/bin/launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 501}`, plistPath])
  await execFileAsync('/bin/launchctl', ['kickstart', '-k', domainTarget])
}

export {
  buildLaunchdConfig,
  materializeStableLaunchWrapper,
  parseArgs,
  renderLaunchdPlist,
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
