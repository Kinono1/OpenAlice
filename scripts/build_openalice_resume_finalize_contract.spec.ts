import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildOpenAliceResumeFinalizeContractReport,
  parseOpenAliceResumeFinalizeContractArgs,
  runOpenAliceResumeFinalizeContract,
} from './build_openalice_resume_finalize_contract.js'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('build_openalice_resume_finalize_contract', () => {
  it('parses defaults without starting downloads', () => {
    expect(parseOpenAliceResumeFinalizeContractArgs([
      '--warehouseRoot',
      '/warehouse',
      '--repoDataRoot',
      '/repo/data',
      '--output',
      'null',
      '--json',
    ])).toEqual({
      warehouseRoot: '/warehouse',
      repoDataRoot: '/repo/data',
      outputPath: null,
      json: true,
    })
  })

  it('builds a source-agnostic research-only resume/finalize contract', () => {
    const report = buildOpenAliceResumeFinalizeContractReport({
      warehouseRoot: '/warehouse',
      repoDataRoot: '/repo/data',
      generatedAt: '2026-05-08T00:00:00.000Z',
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-08T00:00:00.000Z',
      contractVersion: 'openalice.resume_finalize_contract.v1',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      startsDownload: false,
      status: 'complete',
      summary: {
        sources: 6,
        completeSources: 6,
        blockedSources: 0,
        sourceAgnosticResumeContract: true,
      },
      blockers: [],
    })
    expect(report.summary.requiredNormalizedFields).toEqual(expect.arrayContaining([
      'eventTime',
      'observedAt_or_fetchedAt',
      'availableAt',
      'sourceEndpoint_or_sourceUrl',
      'quality_or_blockers',
    ]))
    expect(report.summary.requiredFinalizeChecks).toEqual(expect.arrayContaining([
      'no_part_files',
      'manifest_sidecar_present',
      'pit_fields_available_before_strategy_use',
      'research_only_outputs_do_not_authorize_execution',
    ]))
    expect(report.sources.map(source => source.source)).toEqual([
      'binance_data_vision',
      'binance_usdm_rest_retired_http_451',
      'okx_public_derivatives',
      'okx_public_market',
      'coinmetrics_community',
      'ai_scientist_crypto_dl',
    ])
    expect(report.sources.find(source => source.source === 'binance_data_vision')).toMatchObject({
      sourceClass: 'archive_download',
      lifecycle: 'offline_manual',
      automationAllowed: false,
      retryPolicy: {
        resumable: true,
        failedItemLedgerRequired: true,
      },
      partialFilePolicy: {
        partialSuffixes: ['.part', '.tmp'],
        finalizationRequiresNoPartFiles: true,
      },
      finalizeChecks: expect.arrayContaining([
        'no_part_files',
        'records_in_out_reconciled',
      ]),
      status: 'complete',
      blockers: [],
    })
    expect(report.sources.find(source => source.source === 'binance_usdm_rest_retired_http_451')).toMatchObject({
      sourceClass: 'historical_read_only',
      lifecycle: 'retired_http_451',
      automationAllowed: false,
      retryPolicy: {
        resumable: false,
        maxAttemptsField: null,
      },
      status: 'complete',
    })
    expect(report.sources.find(source => source.source === 'okx_public_derivatives')).toMatchObject({
      sourceClass: 'rest_append_log',
      lifecycle: 'active',
      automationAllowed: true,
      retryPolicy: {
        resumable: true,
        maxAttemptsField: 'maxRetries',
      },
      status: 'complete',
    })
    expect(report.sources.find(source => source.source === 'ai_scientist_crypto_dl')).toMatchObject({
      sourceClass: 'research_candidate_import',
      idempotencyKeys: ['runId', 'candidateId', 'codeSnapshotHash'],
      status: 'complete',
    })
  })

  it('writes artifact and evidence manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-resume-finalize-contract-'))
    const outputPath = join(root, 'data/runtime/openalice_resume_finalize_contract.latest.json')
    await mkdir(join(root, 'data/runtime'), { recursive: true })

    const report = await runOpenAliceResumeFinalizeContract({
      warehouseRoot: join(root, 'warehouse'),
      repoDataRoot: join(root, 'data'),
      outputPath,
      json: false,
    })

    expect(report.status).toBe('complete')
    const persistedRaw = await readFile(outputPath, 'utf-8')
    const persisted = JSON.parse(persistedRaw)
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      status: 'complete',
      researchOnly: true,
      executionAllowed: false,
      startsDownload: false,
    })
    expect(manifest).toMatchObject({
      job: 'openalice_resume_finalize_contract',
      artifactPath: outputPath,
      businessStatus: 'pass',
      recordsIn: 6,
      recordsOut: 6,
    })
    expect(manifest.artifactHash).toBe(sha256Hex(persistedRaw))
  })
})
