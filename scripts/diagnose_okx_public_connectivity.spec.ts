import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildOkxPublicConnectivityDiagnosis,
  parseOkxPublicConnectivityArgs,
  runOkxPublicConnectivityDiagnosis,
  type OkxPublicConnectivityAttempt,
} from './diagnose_okx_public_connectivity.js'

describe('diagnose_okx_public_connectivity', () => {
  it('parses defaults without requiring credentials', () => {
    expect(parseOkxPublicConnectivityArgs([])).toMatchObject({
      outputPath: 'data/runtime/okx_public_connectivity_diagnosis.latest.json',
      timeoutMs: 8000,
      json: false,
    })
    expect(parseOkxPublicConnectivityArgs([
      '--outputPath',
      'null',
      '--timeoutMs',
      '12000',
      '--json',
      'true',
    ])).toEqual({
      outputPath: null,
      timeoutMs: 12000,
      json: true,
    })
  })

  it('blocks when every public host fails and never authorizes execution', () => {
    const report = buildOkxPublicConnectivityDiagnosis({
      generatedAt: '2026-05-06T09:30:00.000Z',
      timeoutMs: 8000,
      proxyUrl: 'http://127.0.0.1:7890',
      hosts: ['https://www.okx.com', 'https://aws.okx.com'],
      attempts: [
        attempt('https://www.okx.com', false, 'tls'),
        attempt('https://aws.okx.com', false, 'dns'),
      ],
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-06T09:30:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'blocked',
      publicDataFetchable: false,
      proxy: {
        configured: true,
        hostname: '127.0.0.1',
        port: '7890',
        hasUsername: false,
        hasPassword: false,
      },
      blockers: expect.arrayContaining([
        'okx_public_connectivity_all_hosts_failed',
        'okx_public_host_failed:www.okx.com:tls',
        'okx_public_host_failed:aws.okx.com:dns',
      ]),
    })
  })

  it('writes diagnostic artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-public-'))
    await mkdir(root, { recursive: true })
    const outputPath = join(root, 'okx_public_connectivity_diagnosis.latest.json')
    const report = await runOkxPublicConnectivityDiagnosis({
      outputPath,
      timeoutMs: 8000,
      json: false,
    }, async baseUrl => ({
      ...attempt(baseUrl, baseUrl.includes('aws.okx.com'), null),
      httpStatus: baseUrl.includes('aws.okx.com') ? 200 : null,
      okxCode: baseUrl.includes('aws.okx.com') ? '0' : null,
    }))

    expect(report.status).toBe('available')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      publicDataFetchable: true,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'okx_public_connectivity_diagnosis',
      businessStatus: 'pass',
    })
  })
})

function attempt(baseUrl: string, ok: boolean, errorClass: string | null): OkxPublicConnectivityAttempt {
  return {
    baseUrl,
    hostname: new URL(baseUrl).hostname,
    ok,
    httpStatus: ok ? 200 : null,
    okxCode: ok ? '0' : null,
    latencyMs: 10,
    serverTime: ok ? '2026-05-06T09:30:00.000Z' : null,
    errorClass,
    errorMessage: errorClass,
  }
}
