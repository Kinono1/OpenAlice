import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildAiScientistSecondValidationReadinessReport,
  parseAiScientistSecondValidationReadinessArgs,
  runAiScientistSecondValidationReadiness,
} from './build_ai_scientist_openalice_second_validation_readiness.js'

describe('build_ai_scientist_openalice_second_validation_readiness', () => {
  it('parses defaults and keeps package script wired', () => {
    expect(parseAiScientistSecondValidationReadinessArgs([
      '--queuePath',
      '/tmp/queue.json',
      '--sourceManifestPath',
      '/tmp/source.json',
      '--output',
      'null',
      '--json',
      'true',
    ])).toMatchObject({
      queuePath: '/tmp/queue.json',
      sourceManifestPath: '/tmp/source.json',
      outputPath: null,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:ai-scientist:second-validation-readiness']).toContain(
      'build_ai_scientist_openalice_second_validation_readiness.ts',
    )
  })

  it('builds candidate gate readiness from queue and locked source manifest', () => {
    const report = buildAiScientistSecondValidationReadinessReport({
      queuePath: '/tmp/queue.json',
      sourceManifestPath: '/tmp/source.json',
      generatedAt: '2026-05-06T12:50:00.000Z',
      queue: {
        queue: [{
          queueRank: 1,
          runId: 'run_candidate',
          family: 'event_reversal',
          candidateId: 'direction_gbdt_regime',
          requiredValidationGates: [
            {
              id: 'locked_source_manifest',
              title: 'Locked source manifest and candidate provenance',
              currentStatus: 'candidate_supplied_unverified',
              blockers: ['openalice_locked_source_manifest_missing'],
              evidencePaths: ['/tmp/source.json'],
            },
            {
              id: 'wfo',
              title: 'OpenAlice walk-forward optimization validation',
              currentStatus: 'candidate_supplied_unverified',
              blockers: ['openalice_wfo_missing'],
              evidencePaths: ['/tmp/wfo.json'],
            },
            {
              id: 'fdr_by',
              title: 'FDR/BY multiple-testing control',
              currentStatus: 'missing',
              blockers: ['openalice_by_fdr_missing'],
              evidencePaths: [],
            },
          ],
        }],
      },
      sourceManifest: {
        status: 'locked_research_only',
        candidates: [{
          runId: 'run_candidate',
          status: 'locked',
          presentFileCount: 2,
          missingFileCount: 0,
        }],
      },
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-06T12:50:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked_openalice_validation_missing',
      counts: {
        queuedCandidates: 1,
        candidatesReadyForOpenAliceReproduction: 1,
        totalGates: 3,
        readyForReproductionGates: 1,
        candidateSuppliedUnverifiedGates: 1,
        missingOpenAliceEvidenceGates: 1,
      },
    })
    expect(report.candidates[0]).toMatchObject({
      runId: 'run_candidate',
      readyForOpenAliceReproduction: true,
      openAliceValidationComplete: false,
      missingOpenAliceGateCount: 2,
      nextGateId: 'wfo',
      gates: [
        expect.objectContaining({
          id: 'locked_source_manifest',
          status: 'ready_for_reproduction',
          blockers: [],
        }),
        expect.objectContaining({
          id: 'wfo',
          status: 'candidate_supplied_unverified',
          blockers: ['openalice_wfo_missing'],
        }),
        expect.objectContaining({
          id: 'fdr_by',
          status: 'missing_openalice_evidence',
          blockers: ['openalice_by_fdr_missing'],
        }),
      ],
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'run_candidate:openalice_wfo_missing',
      'run_candidate:openalice_by_fdr_missing',
      'openalice_second_validation_readiness_research_only',
      'openalice_validation_gates_not_complete',
    ]))
  })

  it('blocks reproduction when source manifest is missing or incomplete', () => {
    const report = buildAiScientistSecondValidationReadinessReport({
      queuePath: '/tmp/queue.json',
      sourceManifestPath: '/tmp/source.json',
      generatedAt: '2026-05-06T12:51:00.000Z',
      queue: {
        queue: [{
          queueRank: 1,
          runId: 'run_candidate',
          family: 'event_reversal',
          candidateId: 'candidate_a',
          requiredValidationGates: [{
            id: 'locked_source_manifest',
            title: 'Locked source manifest and candidate provenance',
            currentStatus: 'candidate_supplied_unverified',
            blockers: ['openalice_locked_source_manifest_missing'],
            evidencePaths: [],
          }],
        }],
      },
      sourceManifest: {
        candidates: [{
          runId: 'run_candidate',
          status: 'blocked_missing_source_files',
          presentFileCount: 0,
          missingFileCount: 1,
        }],
      },
    })

    expect(report.candidates[0]).toMatchObject({
      readyForOpenAliceReproduction: false,
      nextGateId: 'locked_source_manifest',
      blockers: expect.arrayContaining([
        'locked_source_manifest_not_ready',
        'openalice_second_validation_not_complete',
      ]),
    })
    expect(report.counts.candidatesReadyForOpenAliceReproduction).toBe(0)
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-readiness-'))
    const queuePath = join(root, 'queue.latest.json')
    const sourceManifestPath = join(root, 'source_manifest.latest.json')
    const outputPath = join(root, 'readiness.latest.json')
    await mkdir(root, { recursive: true })
    await writeFile(queuePath, JSON.stringify({
      queue: [{
        queueRank: 1,
        runId: 'run_candidate',
        family: 'event_reversal',
        candidateId: 'candidate_a',
        requiredValidationGates: [{
          id: 'locked_source_manifest',
          title: 'Locked source manifest and candidate provenance',
          currentStatus: 'candidate_supplied_unverified',
          blockers: [],
          evidencePaths: [],
        }],
      }],
    }), 'utf-8')
    await writeFile(sourceManifestPath, JSON.stringify({
      candidates: [{
        runId: 'run_candidate',
        status: 'locked',
        presentFileCount: 1,
        missingFileCount: 0,
      }],
    }), 'utf-8')

    const report = await runAiScientistSecondValidationReadiness({
      queuePath,
      sourceManifestPath,
      outputPath,
      json: false,
    })

    expect(report.status).toBe('blocked_openalice_validation_missing')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'ai_scientist_openalice_second_validation_readiness',
      businessStatus: 'fail',
      recordsIn: 1,
      recordsOut: 1,
    })
  })
})
