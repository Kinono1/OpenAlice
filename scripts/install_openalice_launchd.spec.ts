import { afterEach, describe, expect, it } from 'vitest'
import { buildLaunchdConfig, parseArgs, renderLaunchdPlist } from './install_openalice_launchd.ts'

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
})
