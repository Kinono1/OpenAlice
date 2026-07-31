import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  okxSimulatedTradingHeaderForMode,
  parseOkxPrivateAuthDiagnosisArgs,
  runOkxPrivateAuthDiagnosis,
} from './diagnose_okx_private_auth.js'

describe('diagnose_okx_private_auth', () => {
  it('parses redacted diagnosis defaults', () => {
    expect(parseOkxPrivateAuthDiagnosisArgs([
      '--output',
      'null',
      '--symbol',
      'ETH/USDT:USDT',
      '--json',
      'true',
    ])).toMatchObject({
      outputPath: null,
      exchange: 'okx',
      marketType: 'swap',
      symbol: 'ETH/USDT:USDT',
      apiKeyEnv: 'EXCHANGE_API_KEY',
      secretEnv: 'EXCHANGE_API_SECRET',
      passwordEnv: 'EXCHANGE_PASSWORD',
      json: true,
    })
  })

  it('writes redacted auth diagnosis without leaking credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-auth-diagnosis-'))
    const envPath = join(root, '.env')
    const outputPath = join(root, 'runtime', 'okx_private_auth_diagnosis.latest.json')
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(envPath, [
      'EXCHANGE_API_KEY=abc123456789abc123456789SECRETKEY',
      'EXCHANGE_API_SECRET=secret123456789secret123456789SECRET',
      'EXCHANGE_PASSWORD=passphrase123456789passphrase',
    ].join('\n'), 'utf-8')
    await chmod(envPath, 0o600)

    const report = await runOkxPrivateAuthDiagnosis({
      outputPath,
      envPath,
      exchange: 'okx',
      marketType: 'swap',
      symbol: 'BTC/USDT:USDT',
      timeoutMs: 100,
      proxyUrl: null,
      okxHosts: [],
      apiKeyEnv: 'EXCHANGE_API_KEY',
      secretEnv: 'EXCHANGE_API_SECRET',
      passwordEnv: 'EXCHANGE_PASSWORD',
      json: true,
    })

    expect(report).toMatchObject({
      diagnosticOnly: true,
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      credentialPresence: {
        apiKey: true,
        secret: true,
        password: true,
      },
      status: 'blocked',
    })
    expect(report.credentialFingerprints.apiKey).toMatch(/^sha256:[a-f0-9]{12}:len/)
    expect(report.credentialFingerprints.secret).toMatch(/^sha256:[a-f0-9]{12}:len/)
    expect(report.credentialFingerprints.password).toMatch(/^sha256:[a-f0-9]{12}:len/)
    expect(report.envFileDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'selected_env_file',
        selectedForDiagnosis: true,
        exists: true,
        readable: true,
        restricted: true,
        credentialPresence: {
          apiKey: true,
          secret: true,
          password: true,
        },
        credentialFingerprints: {
          apiKey: expect.stringMatching(/^sha256:[a-f0-9]{12}:len/),
          secret: expect.stringMatching(/^sha256:[a-f0-9]{12}:len/),
          password: expect.stringMatching(/^sha256:[a-f0-9]{12}:len/),
        },
      }),
    ]))
    expect(report.networkDiagnostics.source).toEqual(expect.any(String))
    expect(['available', 'unavailable']).toContain(report.networkDiagnostics.status)
    if (report.networkDiagnostics.status === 'available') {
      expect(report.networkDiagnostics.publicEgressIp).toEqual(expect.any(String))
    }
    expect(report.blockers).toContain('okx_auth_not_recognized_any_mode')
    expect(report.probes.map(probe => probe.mode)).toEqual(['production', 'demoTrading', 'sandbox'])
    expect(report.probes[0].directRestStatus).toEqual(expect.any(String))
    expect('directRestHost' in report.probes[0]).toBe(true)
    expect('directRestCode' in report.probes[0]).toBe(true)
    expect('directRestErrorClass' in report.probes[0]).toBe(true)
    expect(report.probes[0].directRestAttempts).toEqual(expect.any(Array))
    expect(report.regionalDomainDiagnostic).toMatchObject({
      officialSource: expect.stringContaining('api-faq'),
      hostsTried: expect.any(Array),
      hostsReturning50119: expect.any(Array),
      interpretation: expect.any(String),
      nextCheck: expect.any(String),
    })
    expect(report.envSyncDiagnostic).toMatchObject({
      selectedEnvPath: envPath,
      launchdEnvPath: expect.stringContaining('.config/openalice/openalice.env'),
      status: expect.stringMatching(/^(in_sync|mismatch)$/),
      mismatchedFields: expect.any(Array),
      action: expect.any(String),
    })
    expect(report.accountSideChecklist.map(item => item.id)).toEqual([
      'credential_tuple_present',
      'passphrase_is_api_passphrase',
      'environment_mode_matches_key',
      'account_region_domain_matches_key',
      'main_or_sub_account_matches_key',
      'ip_allowlist_matches_current_egress',
      'permissions_are_read_only_private',
      'fresh_key_recommended_after_50119',
    ])
    expect(report.accountSideChecklist.find(item => item.id === 'credential_tuple_present')).toMatchObject({
      status: 'passed_local_check',
      evidence: expect.arrayContaining([
        'apiKeyPresent:true',
        'secretPresent:true',
        'passphrasePresent:true',
      ]),
    })
    expect(report.accountSideChecklist.find(item => item.id === 'passphrase_is_api_passphrase')).toMatchObject({
      status: 'needs_user_check',
    })
    expect(report.accountSideChecklist.find(item => item.id === 'ip_allowlist_matches_current_egress')?.evidence).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^proxyConfigured:(true|false)$/),
        expect.stringMatching(/^publicEgressIp:/),
        expect.stringMatching(/^egressIpStatus:/),
      ]),
    )
    expect(report.accountSideChecklist.find(item => item.id === 'account_region_domain_matches_key')?.evidence).toEqual(
      expect.arrayContaining([
        'officialRegionalDomains:app.okx.com->us.okx.com,my.okx.com->eea.okx.com,global->www.okx.com',
      ]),
    )

    const raw = await readFile(outputPath, 'utf-8')
    expect(raw).not.toContain('abc123456789abc123456789SECRETKEY')
    expect(raw).not.toContain('secret123456789secret123456789SECRET')
    expect(raw).not.toContain('passphrase123456789passphrase')
    expect(raw).toContain('envFileDiagnostics')
    expect(raw).toContain('networkDiagnostics')
    expect(raw).toContain('regionalDomainDiagnostic')
    expect(raw).toContain('envSyncDiagnostic')
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(manifest).toMatchObject({
      job: 'okx_private_auth_diagnosis',
      businessStatus: 'fail',
      recordsIn: 3,
      recordsOut: 0,
    })
  })

  it('refuses to read a group/other-accessible env file for private auth diagnosis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-auth-env-perms-'))
    const envPath = join(root, '.env')
    const outputPath = join(root, 'runtime', 'okx_private_auth_diagnosis.latest.json')
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(envPath, [
      'EXCHANGE_API_KEY=abc123456789abc123456789SECRETKEY',
      'EXCHANGE_API_SECRET=secret123456789secret123456789SECRET',
      'EXCHANGE_PASSWORD=passphrase123456789passphrase',
    ].join('\n'), 'utf-8')
    await chmod(envPath, 0o644)

    await expect(runOkxPrivateAuthDiagnosis({
      outputPath,
      envPath,
      exchange: 'okx',
      marketType: 'swap',
      symbol: 'BTC/USDT:USDT',
      timeoutMs: 100,
      proxyUrl: null,
      okxHosts: [],
      apiKeyEnv: 'EXCHANGE_API_KEY',
      secretEnv: 'EXCHANGE_API_SECRET',
      passwordEnv: 'EXCHANGE_PASSWORD',
      json: true,
    })).rejects.toThrow('must not be group/other-accessible')
  })

  it('reports selected env mismatch with launchd default env without leaking values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-auth-env-diagnostics-'))
    const envPath = join(root, '.env')
    const outputPath = join(root, 'runtime', 'okx_private_auth_diagnosis.latest.json')
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(envPath, [
      'EXCHANGE_API_KEY=abc123456789abc123456789SECRETKEY',
      'EXCHANGE_API_SECRET=secret123456789secret123456789SECRET',
      'EXCHANGE_PASSWORD=passphrase123456789passphrase',
    ].join('\n'), 'utf-8')
    await chmod(envPath, 0o600)

    const report = await runOkxPrivateAuthDiagnosis({
      outputPath,
      envPath,
      exchange: 'okx',
      marketType: 'swap',
      symbol: 'BTC/USDT:USDT',
      timeoutMs: 100,
      proxyUrl: null,
      okxHosts: [],
      apiKeyEnv: 'EXCHANGE_API_KEY',
      secretEnv: 'EXCHANGE_API_SECRET',
      passwordEnv: 'EXCHANGE_PASSWORD',
      json: true,
    })

    const selected = report.envFileDiagnostics.find(item => item.label === 'selected_env_file')
    expect(selected).toMatchObject({
      selectedForDiagnosis: true,
      credentialPresence: {
        apiKey: true,
        secret: true,
        password: true,
      },
      blockers: [],
    })
    const launchd = report.envFileDiagnostics.find(item => item.label === 'launchd_default_env_file')
    expect(launchd).toBeTruthy()
    if (launchd?.exists) {
      expect(launchd.path).toContain('.config/openalice/openalice.env')
      expect(launchd.credentialFingerprints.apiKey).not.toBe('abc123456789abc123456789SECRETKEY')
      expect(launchd.blockers.every(blocker => !blocker.includes('abc123'))).toBe(true)
    }
    expect(report.envSyncDiagnostic).toMatchObject({
      selectedEnvPath: envPath,
      launchdEnvPath: expect.stringContaining('.config/openalice/openalice.env'),
    })
    if (report.envSyncDiagnostic.status === 'mismatch') {
      expect(report.envSyncDiagnostic.mismatchedFields.length).toBeGreaterThan(0)
      expect(report.envSyncDiagnostic.action).toContain('OPENALICE_ENV_FILE')
      expect(report.nextActions).toEqual(expect.arrayContaining([report.envSyncDiagnostic.action]))
    }

    const raw = await readFile(outputPath, 'utf-8')
    expect(raw).not.toContain('abc123456789abc123456789SECRETKEY')
    expect(raw).not.toContain('secret123456789secret123456789SECRET')
    expect(raw).not.toContain('passphrase123456789passphrase')
  })

  it('sets the OKX simulated-trading header only for non-production direct probes', () => {
    expect(okxSimulatedTradingHeaderForMode('production')).toEqual({})
    expect(okxSimulatedTradingHeaderForMode('demoTrading')).toEqual({ 'x-simulated-trading': '1' })
    expect(okxSimulatedTradingHeaderForMode('sandbox')).toEqual({ 'x-simulated-trading': '1' })
  })
})
