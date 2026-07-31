import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildEthCarryPitAuditReport,
  parseEthCarryPitAuditArgs,
  runEthCarryPitAudit,
} from './build_eth_carry_pit_audit.js'

describe('build_eth_carry_pit_audit', () => {
  it('parses defaults and keeps package script wired', () => {
    expect(parseEthCarryPitAuditArgs([
      '--output',
      'null',
      '--json',
      'true',
      '--maxPairSkewMs',
      '600000',
    ])).toEqual({
      pitFeaturePath: 'data/research/eth_carry_pit_features.latest.json',
      outputPath: null,
      maxPairSkewMs: 600000,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:eth-carry:pit-audit']).toContain('build_eth_carry_pit_audit.ts')
  })

  it('passes a PIT feature row with explicit availableAt and bounded skew', () => {
    const report = buildEthCarryPitAuditReport({
      generatedAt: '2026-05-06T10:00:00.000Z',
      pitFeaturePath: '/repo/eth_carry_pit_features.latest.json',
      maxPairSkewMs: 600000,
      pitFeatureDataset: {
        carryFeatureRows: [
          {
            featureId: 'feat-1',
            decisionAvailableAt: '2026-05-02T21:17:48.086Z',
            decisionAvailableAtMs: Date.parse('2026-05-02T21:17:48.086Z'),
            pairSkewMs: 2,
            requiredFields: {
              explicitAvailableAt: true,
              fundingRateCashflow: true,
              basisSpread: true,
            },
            blockers: [],
          },
        ],
      },
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: 'pass',
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      counts: {
        carryFeatureRows: 1,
        passingRows: 1,
        failingRows: 0,
      },
      blockers: [],
      rows: [{
        featureId: 'feat-1',
        decisionAvailableAtConsistent: true,
        pairSkewWithinThreshold: true,
        explicitAvailableAt: true,
        fundingRateCashflow: true,
        basisSpread: true,
        blockers: [],
      }],
    })
  })

  it('blocks inconsistent or incomplete PIT feature rows', () => {
    const report = buildEthCarryPitAuditReport({
      generatedAt: '2026-05-06T10:00:00.000Z',
      pitFeaturePath: '/repo/eth_carry_pit_features.latest.json',
      maxPairSkewMs: 600000,
      pitFeatureDataset: {
        carryFeatureRows: [
          {
            featureId: 'feat-bad',
            decisionAvailableAt: '2026-05-02T21:17:48.086Z',
            decisionAvailableAtMs: Date.parse('2026-05-02T21:17:49.086Z'),
            pairSkewMs: 700000,
            requiredFields: {
              explicitAvailableAt: false,
              fundingRateCashflow: true,
              basisSpread: false,
            },
            blockers: ['pair_skew_ms:700000>600000'],
          },
        ],
      },
    })

    expect(report.status).toBe('blocked')
    expect(report.blockers).toEqual(expect.arrayContaining([
      'feat-bad:decision_available_at_inconsistent',
      'feat-bad:pair_skew_ms_exceeds_threshold:700000>600000',
      'feat-bad:explicit_available_at_missing',
      'feat-bad:basis_spread_missing',
      'feat-bad:carry_feature:pair_skew_ms:700000>600000',
    ]))
  })

  it('writes artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-pit-audit-'))
    const pitFeaturePath = join(root, 'eth_carry_pit_features.latest.json')
    const outputPath = join(root, 'eth_carry_pit_audit.latest.json')
    await mkdir(root, { recursive: true })
    await writeFile(pitFeaturePath, JSON.stringify({
      carryFeatureRows: [
        {
          featureId: 'feat-1',
          decisionAvailableAt: '2026-05-02T21:17:48.086Z',
          decisionAvailableAtMs: Date.parse('2026-05-02T21:17:48.086Z'),
          pairSkewMs: 2,
          requiredFields: {
            explicitAvailableAt: true,
            fundingRateCashflow: true,
            basisSpread: true,
          },
          blockers: [],
        },
      ],
    }), 'utf-8')

    const report = await runEthCarryPitAudit({
      pitFeaturePath,
      outputPath,
      maxPairSkewMs: 600000,
      json: false,
    })

    expect(report.status).toBe('pass')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      status: 'pass',
      researchOnly: true,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'eth_carry_pit_audit',
      businessStatus: 'pass',
      recordsIn: 1,
      recordsOut: 1,
    })
  })
})
