import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import {
  buildLaunchdConfig,
  materializeStableLaunchWrapper,
  parseArgs,
  prepareLaunchdInstallationPlan,
  renderLaunchdPlist,
} from './install_openalice_launchd.ts'

describe('install_openalice_launchd', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('builds a launchd config rooted at the repo working directory', () => {
    const config = buildLaunchdConfig({
      label: 'ai.openalice.main',
      scriptPath: '/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice/scripts/launch_openalice_main.sh',
      logPath: '/tmp/openalice.log',
      errorLogPath: '/tmp/openalice.err.log',
    })

    expect(config.label).toBe('ai.openalice.main')
    expect(config.workingDirectory).toBe('/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice')
    expect(config.scriptPath).toContain('/scripts/launch_openalice_main.sh')
  })

  it('accepts an explicit immutable release working directory', () => {
    const config = buildLaunchdConfig({
      label: 'ai.openalice.main',
      scriptPath: '/repo/runtime/bin/launch_openalice_current.sh',
      workingDirectory: '/repo/runtime/releases/2222222222222222222222222222222222222222',
      logPath: '/tmp/openalice.log',
      errorLogPath: '/tmp/openalice.err.log',
    })

    expect(config.workingDirectory).toBe('/repo/runtime/releases/2222222222222222222222222222222222222222')
  })

  it('renders a plist that keeps the service alive and points to the wrapper script', () => {
    const plist = renderLaunchdPlist({
      label: 'ai.openalice.main',
      scriptPath: '/repo/OpenAlice/scripts/launch_openalice_main.sh',
      workingDirectory: '/repo/OpenAlice',
      logPath: '/repo/OpenAlice/logs/openalice_main.launchd.log',
      errorLogPath: '/repo/OpenAlice/logs/openalice_main.launchd.err.log',
      pathEnv: '/opt/homebrew/bin:/usr/bin:/bin',
      homeEnv: '/Users/kino',
      nodeExtraCaCerts: '/etc/ssl/cert.pem',
      nodeUseSystemCa: '1',
    })

    expect(plist).toContain('<string>ai.openalice.main</string>')
    expect(plist).toContain('<string>/opt/homebrew/bin/bash</string>')
    expect(plist).toContain('<string>/repo/OpenAlice/scripts/launch_openalice_main.sh</string>')
    expect(plist).toContain('<key>KeepAlive</key>')
    expect(plist).toContain('<true/>')
    expect(plist).toContain('<key>StandardOutPath</key>')
    expect(plist).toContain('<string>/repo/OpenAlice/logs/openalice_main.launchd.log</string>')
  })

  it('uses the system POSIX shell only for a V2 PAPER_LOCAL plist', () => {
    const legacy = renderLaunchdPlist(buildLaunchdConfig({
      label: 'ai.openalice.legacy',
      scriptPath: '/repo/runtime/bin/launch_openalice_current.sh',
      logPath: '/tmp/legacy.log',
      errorLogPath: '/tmp/legacy.err.log',
      launcherKind: 'legacy',
    }))
    const paperLocal = renderLaunchdPlist(buildLaunchdConfig({
      label: 'ai.openalice.paper-local',
      scriptPath: '/repo/runtime/bin/launch_nautilus_paper.sh',
      logPath: '/tmp/paper.log',
      errorLogPath: '/tmp/paper.err.log',
      launcherKind: 'paper_local',
    }))

    expect(legacy).toContain('<string>/opt/homebrew/bin/bash</string>')
    expect(paperLocal).toContain('<string>/bin/sh</string>')
    expect(paperLocal).not.toContain('<string>/opt/homebrew/bin/bash</string>')
  })

  it('requires an explicit matching kind for the PAPER_LOCAL wrapper', () => {
    const input = {
      label: 'ai.openalice.paper-local',
      scriptPath: '/repo/runtime/bin/launch_nautilus_paper.sh',
      logPath: '/tmp/paper.log',
      errorLogPath: '/tmp/paper.err.log',
    }

    expect(() => buildLaunchdConfig(input)).toThrow('paper_local_launcher_kind_required')
    expect(() => buildLaunchdConfig({ ...input, launcherKind: 'legacy' })).toThrow(
      'paper_local_launcher_kind_required',
    )
    expect(() => renderLaunchdPlist({
      ...input,
      workingDirectory: '/repo/runtime',
      pathEnv: '/usr/bin:/bin',
      homeEnv: '/Users/kino',
      launcherKind: 'legacy',
    })).toThrow('paper_local_launcher_kind_required')
  })

  it('rejects PAPER_LOCAL kind for a non-PAPER_LOCAL wrapper', () => {
    expect(() => buildLaunchdConfig({
      label: 'ai.openalice.legacy',
      scriptPath: '/repo/runtime/bin/launch_openalice_current.sh',
      logPath: '/tmp/legacy.log',
      errorLogPath: '/tmp/legacy.err.log',
      launcherKind: 'paper_local',
    })).toThrow('paper_local_stable_wrapper_required')
  })

  it('does not persist plaintext API keys in the launchd plist', () => {
    const plist = renderLaunchdPlist({
      label: 'ai.openalice.main',
      scriptPath: '/repo/OpenAlice/scripts/launch_openalice_main.sh',
      workingDirectory: '/repo/OpenAlice',
      logPath: '/repo/OpenAlice/logs/openalice_main.launchd.log',
      errorLogPath: '/repo/OpenAlice/logs/openalice_main.launchd.err.log',
      pathEnv: '/opt/homebrew/bin:/usr/bin:/bin',
      homeEnv: '/Users/kino',
      openaliceEnvFile: '/Users/kino/.config/openalice/openalice.env',
      openaliceLlmApiKeyEnv: 'DEEPSEEK_API_KEY',
    })

    expect(plist).toContain('<key>OPENALICE_ENV_FILE</key>')
    expect(plist).toContain('<string>/Users/kino/.config/openalice/openalice.env</string>')
    expect(plist).toContain('<key>OPENALICE_LLM_API_KEY_ENV</key>')
    expect(plist).toContain('<string>DEEPSEEK_API_KEY</string>')
    expect(plist).not.toContain('<key>DEEPSEEK_API_KEY</key>')
    expect(plist).not.toContain('sk-live-secret')
  })

  it('does not copy proxy credentials or provider secrets from process env into plist', () => {
    process.env.HTTP_PROXY = 'http://proxy-user:proxy-password@127.0.0.1:7892'
    process.env.HTTPS_PROXY = process.env.HTTP_PROXY
    process.env.DEEPSEEK_API_KEY = 'sk-live-secret'
    process.env.OKX_SECRET_KEY = 'okx-secret'
    process.env.TELEGRAM_BOT_TOKEN = 'telegram-secret'

    const config = buildLaunchdConfig({
      label: 'ai.openalice.main',
      scriptPath: '/repo/runtime/bin/launch_openalice_current.sh',
      logPath: '/tmp/openalice.log',
      errorLogPath: '/tmp/openalice.err.log',
    })
    const plist = renderLaunchdPlist(config)

    expect(plist).not.toContain('proxy-user')
    expect(plist).not.toContain('proxy-password')
    expect(plist).not.toContain('sk-live-secret')
    expect(plist).not.toContain('okx-secret')
    expect(plist).not.toContain('telegram-secret')
  })

  it('defaults launchd to env-file based secret loading', () => {
    delete process.env.OPENALICE_ENV_FILE
    delete process.env.OPENALICE_LLM_API_KEY_ENV
    process.env.HOME = '/Users/kino'

    const config = buildLaunchdConfig({
      label: 'ai.openalice.main',
      scriptPath: '/repo/OpenAlice/scripts/launch_openalice_main.sh',
      logPath: '/tmp/openalice.log',
      errorLogPath: '/tmp/openalice.err.log',
    })

    expect(config.openaliceEnvFile).toBe('/Users/kino/.config/openalice/openalice.env')
    expect(config.openaliceLlmApiKeyEnv).toBe('DEEPSEEK_API_KEY')

    const plist = renderLaunchdPlist(config)
    expect(plist).toContain('<key>OPENALICE_ENV_FILE</key>')
    expect(plist).toContain('<key>OPENALICE_LLM_API_KEY_ENV</key>')
    expect(plist).not.toContain('<key>DEEPSEEK_API_KEY</key>')
  })

  it('defaults the plist path to the selected launchd label', () => {
    const args = parseArgs(['--label', 'ai.openalice.paper-monitor'])

    expect(args.plistPath).toContain('/Library/LaunchAgents/ai.openalice.paper-monitor.plist')
    expect(args.dryRun).toBe(true)
    expect(args.launch).toBe(false)
    expect(args.scriptPath).toContain('/runtime/bin/launch_openalice_current.sh')
  })

  it('requires explicit flags before writing and launching the agent', () => {
    const args = parseArgs([
      '--label',
      'ai.openalice.paper-monitor',
      '--dryRun',
      'false',
      '--launch',
      'true',
    ])

    expect(args.dryRun).toBe(false)
    expect(args.launch).toBe(true)
  })

  it('persists research role and explicit data/release roots without secrets', () => {
    process.env.OPENALICE_RUNTIME_ROLE = 'research'
    process.env.OPENALICE_RELEASE_DIR = '/repo/OpenAlice/runtime/releases'
    process.env.OPENALICE_DATA_DIR = '/repo/OpenAlice/data'
    process.env.OPENALICE_SHARED_DATA_INPUT_DIR = '/repo/OpenAlice/data'
    process.env.OPENALICE_STATE_DIR = '/repo/OpenAlice/data'
    process.env.OPENALICE_ARTIFACT_DIR = '/repo/OpenAlice/data/runtime'
    process.env.OPENALICE_LOG_DIR = '/repo/OpenAlice/logs'
    process.env.OPENALICE_LEGACY_WIP_ROOT = '/repo/OpenAlice-legacy-wip'

    const config = buildLaunchdConfig({
      label: 'ai.openalice.main',
      scriptPath: '/repo/OpenAlice/runtime/bin/launch_openalice_current.sh',
      logPath: '/repo/OpenAlice/logs/openalice.log',
      errorLogPath: '/repo/OpenAlice/logs/openalice.err.log',
    })
    const plist = renderLaunchdPlist(config)
    expect(plist).toContain('<key>OPENALICE_RUNTIME_ROLE</key>')
    expect(plist).toContain('<string>research</string>')
    expect(plist).toContain('<key>OPENALICE_RELEASE_DIR</key>')
    expect(plist).toContain('<string>/repo/OpenAlice/runtime/releases</string>')
    expect(plist).toContain('<key>OPENALICE_LEGACY_WIP_ROOT</key>')
    expect(plist).not.toContain('TELEGRAM_BOT_TOKEN=')
  })

  it('persists only explicit non-secret PAPER_LOCAL runtime pins for the V2 wrapper', () => {
    process.env.PATH = '/malicious/bin:/usr/bin'
    process.env.HOME = '/Users/service-with-secrets'
    process.env.NODE_EXTRA_CA_CERTS = '/private/provider-ca.pem'
    process.env.OPENALICE_LLM_BASE_URL = 'https://credential-bearing-provider.invalid'
    process.env.OPENALICE_ENV_FILE = '/private/openalice.env'
    process.env.OPENALICE_RUNTIME_ROLE = 'research'
    process.env.OPENALICE_DATA_DIR = '/private/research-data'
    process.env.OPENALICE_RELEASE_DIR = '/repo/runtime/releases'
    process.env.OPENALICE_NODE = '/opt/openalice/node'
    process.env.OPENALICE_NODE_SHA256 = 'a'.repeat(64)
    process.env.OPENALICE_PAPER_LOCAL_MJS_SHA256 = 'b'.repeat(64)
    process.env.OPENALICE_NAUTILUS_PYTHON = '/opt/openalice/venv/bin/python'
    process.env.OPENALICE_RELEASE_PUBLISHER_UID = '502'
    process.env.OPENALICE_PAPER_LOCAL_SUPERVISOR_CONFIG = '/private/openalice/supervisor.json'

    const plist = renderLaunchdPlist(buildLaunchdConfig({
      label: 'ai.openalice.paper-local',
      scriptPath: '/repo/runtime/bin/launch_nautilus_paper.sh',
      logPath: '/tmp/openalice.log',
      errorLogPath: '/tmp/openalice.err.log',
      launcherKind: 'paper_local',
    }))

    for (const [key, value] of [
      ['OPENALICE_NODE', '/opt/openalice/node'],
      ['OPENALICE_NODE_SHA256', 'a'.repeat(64)],
      ['OPENALICE_PAPER_LOCAL_MJS_SHA256', 'b'.repeat(64)],
      ['OPENALICE_NAUTILUS_PYTHON', '/opt/openalice/venv/bin/python'],
      ['OPENALICE_RELEASE_PUBLISHER_UID', '502'],
      ['OPENALICE_PAPER_LOCAL_SUPERVISOR_CONFIG', '/private/openalice/supervisor.json'],
      ['OPENALICE_RELEASE_DIR', '/repo/runtime/releases'],
    ]) {
      expect(plist).toContain(`<key>${key}</key>`)
      expect(plist).toContain(`<string>${value}</string>`)
    }
    expect(plist).toContain('<key>PATH</key>\n    <string>/usr/bin:/bin</string>')
    expect(plist).toContain('<key>HOME</key>\n    <string>/var/empty</string>')
    for (const forbidden of [
      'NODE_EXTRA_CA_CERTS', 'OPENALICE_LLM_BASE_URL', 'OPENALICE_ENV_FILE',
      'OPENALICE_RUNTIME_ROLE', 'OPENALICE_DATA_DIR', 'credential-bearing-provider',
      '/private/openalice.env', '/private/research-data', '/malicious/bin',
    ]) expect(plist).not.toContain(forbidden)
  })

  it('parses an explicit working directory for a research release', () => {
    const args = parseArgs([
      '--scriptPath',
      '/repo/runtime/bin/launch_openalice_current.sh',
      '--workingDirectory',
      '/repo/runtime/releases/3333333333333333333333333333333333333333',
    ])

    expect(args.workingDirectory).toBe('/repo/runtime/releases/3333333333333333333333333333333333333333')
  })

  it('parses an explicit immutable release source for wrapper materialization', () => {
    const args = parseArgs([
      '--scriptPath',
      '/repo/runtime/bin/launch_openalice_current.sh',
      '--sourceReleasePath',
      '/repo/runtime/releases/3333333333333333333333333333333333333333',
    ])

    expect(args.sourceReleasePath).toBe('/repo/runtime/releases/3333333333333333333333333333333333333333')
  })

  it('materializes the stable wrapper from the explicit release source', async () => {
    const root = await mkdtemp('/tmp/openalice-launchd-source-')
    const source = `${root}/release`
    const target = `${root}/bin/launch_openalice_current.sh`
    await mkdir(`${source}/ops/release`, { recursive: true })
    await mkdir(`${source}/scripts`, { recursive: true })
    await mkdir(`${root}/bin`, { recursive: true })
    await writeFile(`${source}/ops/release/launch_current.sh`, 'release-wrapper\n')
    await writeFile(`${source}/ops/release/launch_current.mjs`, 'release-launcher\n')
    await writeFile(`${source}/scripts/openalice_env.sh`, 'release-env\n')
    await writeFile(`${source}/release_manifest.v1.json`, JSON.stringify({
      schemaVersion: 'release_manifest.v1',
    }))
    await materializeStableLaunchWrapper(target, source)
    expect(await readFile(target, 'utf8')).toBe('release-wrapper\n')
    expect(await readFile(`${root}/bin/launch_current.mjs`, 'utf8')).toBe('release-launcher\n')
    expect(await readFile(`${root}/bin/openalice_env.sh`, 'utf8')).toBe('release-env\n')
  })

  it('rejects direct V2 materialization before creating a wrapper pair', async () => {
    const root = await mkdtemp('/tmp/openalice-launchd-paper-local-')
    const source = `${root}/release`
    const target = `${root}/bin/launch_nautilus_paper.sh`
    await mkdir(`${source}/ops/release`, { recursive: true })
    await writeFile(`${source}/ops/release/launch_nautilus_paper.sh`, 'paper-wrapper\n')
    await writeFile(`${source}/ops/release/launch_nautilus_paper.mjs`, 'paper-launcher\n')
    await writeFile(`${source}/release_manifest.v2.json`, JSON.stringify({
      schemaVersion: 'release_manifest.v2',
    }))

    await expect(materializeStableLaunchWrapper(
      target,
      source,
    )).rejects.toThrow('paper_local_two_identity_deployment_required')
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(`${root}/bin/launch_nautilus_paper.mjs`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(`${root}/bin`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await expect(materializeStableLaunchWrapper(
      `${root}/other/launch_openalice_current.sh`,
      source,
    )).rejects.toThrow('paper_local_two_identity_deployment_required')
    await expect(readFile(`${root}/other`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('limits generic V2 installation to a no-side-effect plan preview', async () => {
    const root = await mkdtemp('/tmp/openalice-launchd-v2-plan-')
    const source = `${root}/release`
    const scriptPath = `${root}/bin/launch_nautilus_paper.sh`
    const plistPath = `${root}/plist/ai.openalice.paper-local.plist`
    await mkdir(source, { recursive: true })
    await writeFile(`${source}/release_manifest.v2.json`, JSON.stringify({
      schemaVersion: 'release_manifest.v2',
    }))

    const plan = await prepareLaunchdInstallationPlan({
      label: 'ai.openalice.paper-local',
      plistPath,
      scriptPath,
      workingDirectory: source,
      sourceReleasePath: source,
      logPath: `${root}/logs/main.log`,
      errorLogPath: `${root}/logs/main.err.log`,
      launch: true,
      dryRun: false,
    })

    expect(plan).toMatchObject({ status: 'plan_only', sourceKind: 'paper_local' })
    expect(plan.plist).toContain('<string>/bin/sh</string>')
    await expect(readFile(scriptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(plistPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects the real non-dry-run V2 CLI before any write or launchctl action', async () => {
    const root = await mkdtemp('/tmp/openalice-launchd-v2-cli-block-')
    const source = `${root}/release`
    const scriptPath = `${root}/bin/launch_nautilus_paper.sh`
    const plistPath = `${root}/plist/ai.openalice.paper-local.plist`
    const logPath = `${root}/logs/main.log`
    const errorLogPath = `${root}/logs/main.err.log`
    await mkdir(source, { recursive: true })
    await writeFile(`${source}/release_manifest.v2.json`, JSON.stringify({
      schemaVersion: 'release_manifest.v2',
    }))

    const result = await runInstallerCli([
      '--dryRun', 'false',
      '--launch', 'true',
      '--label', 'ai.openalice.paper-local',
      '--scriptPath', scriptPath,
      '--workingDirectory', source,
      '--sourceReleasePath', source,
      '--plistPath', plistPath,
      '--logPath', logPath,
      '--errorLogPath', errorLogPath,
    ])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('paper_local_two_identity_deployment_required')
    for (const path of [
      scriptPath,
      plistPath,
      logPath,
      errorLogPath,
      `${root}/research-current`,
      `${root}/current`,
    ]) {
      await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
})

function runInstallerCli(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('./node_modules/.bin/tsx', [
      'scripts/install_openalice_launchd.ts',
      ...args,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const stderr: Buffer[] = []
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.on('error', reject)
    child.on('close', (code) => resolvePromise({
      code,
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
  })
}
