import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildAiScientistSourceManifestReport,
  parseAiScientistSourceManifestArgs,
  runAiScientistSourceManifest,
} from './build_ai_scientist_openalice_candidate_source_manifest.js'

describe('build_ai_scientist_openalice_candidate_source_manifest', () => {
  it('parses defaults and keeps package script wired', () => {
    expect(parseAiScientistSourceManifestArgs([
      '--queuePath',
      '/tmp/queue.json',
      '--output',
      'null',
      '--json',
      'true',
    ])).toMatchObject({
      queuePath: '/tmp/queue.json',
      outputPath: null,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:ai-scientist:source-manifest']).toContain(
      'build_ai_scientist_openalice_candidate_source_manifest.ts',
    )
  })

  it('locks queued candidate source files with hashes without authorizing execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-source-manifest-'))
    const runDir = join(root, 'run_candidate')
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'walk_forward_evaluation.json'), '{"proof_status":"not_proven"}\n', 'utf-8')
    await writeFile(join(runDir, 'data_manifest.json'), '{"synthetic":false}\n', 'utf-8')

    const report = await buildAiScientistSourceManifestReport({
      queuePath: join(root, 'queue.latest.json'),
      queue: {
        generatedAt: '2026-05-06T12:10:00.000Z',
        queue: [{
          queueRank: 1,
          runId: 'run_candidate',
          runDir,
          family: 'event_reversal',
          candidateId: 'direction_gbdt_regime',
          sourceFiles: ['walk_forward_evaluation.json', 'data_manifest.json'],
        }],
      },
      generatedAt: '2026-05-06T12:11:00.000Z',
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-06T12:11:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'locked_research_only',
      queueGeneratedAt: '2026-05-06T12:10:00.000Z',
      counts: {
        queuedCandidates: 1,
        candidatesLocked: 1,
        candidatesWithMissingFiles: 0,
        sourceFilesExpected: 2,
        sourceFilesPresent: 2,
        sourceFilesMissing: 0,
      },
    })
    expect(report.candidates[0]).toMatchObject({
      status: 'locked',
      runId: 'run_candidate',
      candidateId: 'direction_gbdt_regime',
      fileCount: 2,
      presentFileCount: 2,
      missingFileCount: 0,
      blockers: [],
    })
    expect(report.candidates[0].candidateManifestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(report.candidates[0].files[0]).toMatchObject({
      relativePath: 'walk_forward_evaluation.json',
      exists: true,
      sha256: sha256Hex('{"proof_status":"not_proven"}\n'),
      blocker: null,
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'source_manifest_research_only',
      'openalice_second_validation_still_required',
    ]))
  })

  it('reports missing queued source files as blockers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-source-missing-'))
    const runDir = join(root, 'run_candidate')
    await mkdir(runDir, { recursive: true })

    const report = await buildAiScientistSourceManifestReport({
      queuePath: join(root, 'queue.latest.json'),
      queue: {
        queue: [{
          queueRank: 1,
          runId: 'run_candidate',
          runDir,
          family: 'event_reversal',
          candidateId: 'candidate_a',
          sourceFiles: ['missing.json'],
        }],
      },
      generatedAt: '2026-05-06T12:12:00.000Z',
    })

    expect(report).toMatchObject({
      status: 'blocked_missing_source_files',
      counts: {
        queuedCandidates: 1,
        candidatesLocked: 0,
        candidatesWithMissingFiles: 1,
        sourceFilesExpected: 1,
        sourceFilesPresent: 0,
        sourceFilesMissing: 1,
      },
    })
    expect(report.candidates[0]).toMatchObject({
      status: 'blocked_missing_source_files',
      candidateManifestHash: null,
      blockers: ['source_file_missing:missing.json'],
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'run_candidate:source_file_missing:missing.json',
    ]))
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-source-write-'))
    const runDir = join(root, 'run_candidate')
    const queuePath = join(root, 'queue.latest.json')
    const outputPath = join(root, 'source_manifest.latest.json')
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'walk_forward_evaluation.json'), '{}\n', 'utf-8')
    await writeFile(queuePath, JSON.stringify({
      queue: [{
        queueRank: 1,
        runId: 'run_candidate',
        runDir,
        family: 'event_reversal',
        candidateId: 'candidate_a',
        sourceFiles: ['walk_forward_evaluation.json'],
      }],
    }), 'utf-8')

    const report = await runAiScientistSourceManifest({
      queuePath,
      outputPath,
      json: false,
    })

    expect(report.status).toBe('locked_research_only')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'ai_scientist_openalice_candidate_source_manifest',
      businessStatus: 'warn',
      recordsIn: 1,
      recordsOut: 1,
    })
  })
})

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
