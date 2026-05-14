import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildStepPlan,
  evaluateAccountSafety,
  executePaperShadowLoopPlan,
  parseArgs,
  writeSummaryAndPaperEvidence,
} from './run_paper_shadow_loop.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('run_paper_shadow_loop safety guard', () => {
  it('defaults to status/data refresh only with paper execution skipped', () => {
    const args = parseArgs([])
    const plan = buildStepPlan(args)

    expect(args.skipPaper).toBe(true)
    expect(args.requirePromotionV2).toBe(true)
    expect(plan.find(step => step.id === 'paper_cross_sectional')).toMatchObject({
      skipped: true,
      skipReason: 'skipPaper=true',
    })
    expect(plan.find(step => step.id === 'promotion_v2_publish')).toMatchObject({
      skipped: true,
      skipReason: 'skipPaper=true',
    })
    expect(plan.find(step => step.id === 'paper_volume_breakout_5m')).toMatchObject({
      skipped: true,
      skipReason: 'requirePromotionV2=true and paper:volume-breakout is not v2-gated',
    })
    expect(plan.find(step => step.id === 'paper_microstructure_stress_1s')).toMatchObject({
      skipped: true,
      skipReason: 'requirePromotionV2=true and paper:microstructure-stress is not v2-gated',
    })
  })

  it('allows an empty account file as local-paper only', () => {
    const result = evaluateAccountSafety([])

    expect(result.activeAccountCount).toBe(0)
    expect(result.unsafeAccounts).toEqual([])
    expect(result.warnings).toContain(
      'no active private broker account configured; running public-data and local-paper loop only',
    )
  })

  it('allows only ccxt sandbox or demo accounts', () => {
    const result = evaluateAccountSafety([
      {
        id: 'bybit-demo',
        type: 'ccxt',
        brokerConfig: { exchange: 'bybit', demoTrading: true },
        cryptoExecution: { mode: 'paper_only' },
      },
      {
        id: 'okx-sandbox',
        type: 'ccxt',
        brokerConfig: { exchange: 'okx', sandbox: true },
      },
    ])

    expect(result.activeAccountCount).toBe(2)
    expect(result.safeAccountCount).toBe(2)
    expect(result.unsafeAccounts).toEqual([])
  })

  it('blocks active ccxt accounts that are neither sandbox nor demo', () => {
    const result = evaluateAccountSafety([
      {
        id: 'bybit-main',
        type: 'ccxt',
        brokerConfig: { exchange: 'bybit', sandbox: false, demoTrading: false },
      },
    ])

    expect(result.unsafeAccounts).toEqual([
      {
        id: 'bybit-main',
        type: 'ccxt',
        reason: 'ccxt account must set brokerConfig.sandbox=true or brokerConfig.demoTrading=true',
      },
    ])
  })

  it('ignores disabled live accounts and blocks non-paper execution modes', () => {
    const result = evaluateAccountSafety([
      {
        id: 'disabled-live',
        type: 'ccxt',
        enabled: false,
        brokerConfig: { exchange: 'bybit' },
      },
      {
        id: 'bad-mode',
        type: 'ccxt',
        brokerConfig: { exchange: 'bybit', demoTrading: true },
        cryptoExecution: { mode: 'live' },
      },
    ])

    expect(result.activeAccountCount).toBe(1)
    expect(result.unsafeAccounts).toEqual([
      {
        id: 'bad-mode',
        type: 'ccxt',
        reason: 'cryptoExecution.mode must remain paper_only, got live',
      },
    ])
  })

  it('passes live-only data mode to the paper trading step', () => {
    const args = parseArgs(['--paperDataMode', 'live_only'])
    const paperStep = buildStepPlan(args).find((step) => step.id === 'paper_cross_sectional')

    expect(args.paperDataMode).toBe('live_only')
    expect(paperStep?.args).toEqual([
      'pnpm',
      'paper:cross-sectional',
      '--',
      '--dataMode',
      'live_only',
      '--requirePromotionV2',
      'true',
    ])
  })

  it('can require promotion v2 before cross-sectional paper order generation', () => {
    const args = parseArgs(['--paperDataMode', 'live_only', '--requirePromotionV2', 'true'])
    const plan = buildStepPlan(args)
    const paperStep = plan.find((step) => step.id === 'paper_cross_sectional')
    const volumeBreakout = plan.find((step) => step.id === 'paper_volume_breakout_5m')
    const microstructure = plan.find((step) => step.id === 'paper_microstructure_stress_1s')

    expect(args.requirePromotionV2).toBe(true)
    expect(paperStep?.args).toEqual([
      'pnpm',
      'paper:cross-sectional',
      '--',
      '--dataMode',
      'live_only',
      '--requirePromotionV2',
      'true',
    ])
    expect(volumeBreakout).toMatchObject({
      skipped: true,
      skipReason: 'requirePromotionV2=true and paper:volume-breakout is not v2-gated',
    })
    expect(microstructure).toMatchObject({
      skipped: true,
      skipReason: 'requirePromotionV2=true and paper:microstructure-stress is not v2-gated',
    })
  })

  it('can skip second-level 1s data and pass that to cross-sectional paper trading', () => {
    const args = parseArgs(['--paperDataMode', 'live_only', '--skipSecondLevel', 'true'])
    const plan = buildStepPlan(args)
    const oneSecondData = plan.find((step) => step.id === 'accumulate_1s_data')
    const microstructure = plan.find((step) => step.id === 'paper_microstructure_stress_1s')
    const paperStep = plan.find((step) => step.id === 'paper_cross_sectional')

    expect(args.skipSecondLevel).toBe(true)
    expect(oneSecondData).toMatchObject({ skipped: true, skipReason: 'skipSecondLevel=true' })
    expect(microstructure).toMatchObject({
      skipped: true,
      skipReason: 'requirePromotionV2=true and paper:microstructure-stress is not v2-gated',
    })
    expect(paperStep?.args).toEqual([
      'pnpm',
      'paper:cross-sectional',
      '--',
      '--dataMode',
      'live_only',
      '--requirePromotionV2',
      'true',
      '--skipSecondLevel',
      'true',
    ])
  })

  it('publishes promotion v2 artifacts after the cross-sectional paper step when paper is explicitly enabled', () => {
    const plan = buildStepPlan(parseArgs(['--skipPaper', 'false']))
    const ids = plan.map((step) => step.id)
    const paperIndex = ids.indexOf('paper_cross_sectional')
    const promotionIndex = ids.indexOf('promotion_v2_publish')
    const step = plan[promotionIndex]

    expect(paperIndex).toBeGreaterThanOrEqual(0)
    expect(promotionIndex).toBeGreaterThan(paperIndex)
    expect(step.args).toEqual(['pnpm', 'promotion:v2:publish'])
  })

  it('seals current-run paper evidence before promotion v2 publish executes when paper is explicitly enabled', async () => {
    const args = parseArgs([
      '--paperDataMode',
      'live_only',
      '--skipPaper',
      'false',
      '--dryRun',
      'false',
      '--summaryPath',
      '/tmp/openalice-shadow-loop-test-summary.json',
      '--paperEvidenceRoot',
      '/tmp/openalice-shadow-loop-test-evidence',
    ])
    const events: string[] = []
    const result = await executePaperShadowLoopPlan({
      args,
      safety: {
        activeAccountCount: 0,
        safeAccountCount: 0,
        unsafeAccounts: [],
        warnings: [],
      },
      plan: buildStepPlan(args),
      runStepFn: async (step) => {
        events.push(`step:${step.id}`)
        return {
          id: step.id,
          command: step.command,
          status: 'passed',
          durationMs: 1,
        }
      },
      writeEvidenceFn: async (_args, summary) => {
        events.push(`evidence:${summary.steps.map((step) => step.id).join(',')}`)
        return {
          reportPath: '/tmp/report.json',
          ledgerPath: '/tmp/evidence_ledger.jsonl',
          latestPointerPath: '/tmp/latest_pointer.json',
          ledgerEntry: {
            schemaVersion: 'paper_evidence_ledger.v4_1',
            reportId: `report-${events.length}`,
            generatedAt: summary.generatedAt,
            path: '/tmp/report.json',
            sourceRunId: `report-${events.length}`,
            paperDataMode: 'live_only',
            freshnessStatus: 'fresh',
            sourceSummaryHash: 'sha256:summary',
          },
          latestPointer: {
            schemaVersion: 'paper_evidence_latest_pointer.v4_1',
            latestReportId: `report-${events.length}`,
            path: '/tmp/report.json',
            updatedAt: summary.generatedAt,
          },
        }
      },
    })

    const publishIndex = events.indexOf('step:promotion_v2_publish')
    const prePublishEvidenceIndex = events.findIndex((event) =>
      event.startsWith('evidence:') && event.includes('paper_cross_sectional'),
    )

    expect(prePublishEvidenceIndex).toBeGreaterThanOrEqual(0)
    expect(publishIndex).toBeGreaterThan(prePublishEvidenceIndex)
    expect(events.at(-1)).toMatch(/^evidence:/)
    expect(result.summary.steps.at(-1)?.id).toBe('promotion_v2_publish')
  })

  it('refreshes hourly, minute, and second-level public data unless skipData is set', () => {
    const plan = buildStepPlan(parseArgs([]))
    const skipPlan = buildStepPlan(parseArgs(['--skipData', 'true']))

    expect(plan.slice(0, 4).map(step => [step.id, step.args])).toEqual([
      ['accumulate_live_data', ['pnpm', 'data:accumulate']],
      ['accumulate_5m_data', ['pnpm', 'data:accumulate-5m']],
      ['accumulate_1m_data', ['pnpm', 'data:accumulate-1m']],
      ['accumulate_1s_data', ['pnpm', 'data:accumulate-1s']],
    ])
    expect(skipPlan.slice(0, 4).map(step => [step.id, step.skipped, step.skipReason])).toEqual([
      ['accumulate_live_data', true, 'skipData=true'],
      ['accumulate_5m_data', true, 'skipData=true'],
      ['accumulate_1m_data', true, 'skipData=true'],
      ['accumulate_1s_data', true, 'skipData=true'],
    ])
  })

  it('blocks the 5m volume-breakout paper trader by default and only allows explicit ungated mode', () => {
    const plan = buildStepPlan(parseArgs([]))
    const explicitUngatedPlan = buildStepPlan(parseArgs([
      '--skipPaper',
      'false',
      '--requirePromotionV2',
      'false',
    ]))
    const skipPlan = buildStepPlan(parseArgs(['--skipPaper', 'true']))
    const step = plan.find(item => item.id === 'paper_volume_breakout_5m')
    const explicitUngated = explicitUngatedPlan.find(item => item.id === 'paper_volume_breakout_5m')
    const skipped = skipPlan.find(item => item.id === 'paper_volume_breakout_5m')

    expect(step?.skipped).toBe(true)
    expect(step?.skipReason).toBe('requirePromotionV2=true and paper:volume-breakout is not v2-gated')
    expect(explicitUngated?.args).toEqual(['pnpm', 'paper:volume-breakout', '--', '--allowUngatedPaperLane', 'true'])
    expect(explicitUngated?.skipped).toBeFalsy()
    expect(skipped?.skipped).toBe(true)
    expect(skipped?.skipReason).toBe('requirePromotionV2=true and paper:volume-breakout is not v2-gated')
  })

  it('blocks the 1s high-leverage microstructure paper trader by default and only allows explicit ungated mode', () => {
    const plan = buildStepPlan(parseArgs([]))
    const explicitUngatedPlan = buildStepPlan(parseArgs([
      '--skipPaper',
      'false',
      '--requirePromotionV2',
      'false',
    ]))
    const skipPlan = buildStepPlan(parseArgs(['--skipPaper', 'true']))
    const step = plan.find(item => item.id === 'paper_microstructure_stress_1s')
    const explicitUngated = explicitUngatedPlan.find(item => item.id === 'paper_microstructure_stress_1s')
    const skipped = skipPlan.find(item => item.id === 'paper_microstructure_stress_1s')

    expect(step?.skipped).toBe(true)
    expect(step?.skipReason).toBe('requirePromotionV2=true and paper:microstructure-stress is not v2-gated')
    expect(explicitUngated?.args).toEqual([
      'pnpm',
      'paper:microstructure-stress',
      '--',
      '--allowUngatedPaperLane',
      'true',
    ])
    expect(explicitUngated?.skipped).toBeFalsy()
    expect(skipped?.skipped).toBe(true)
    expect(skipped?.skipReason).toBe('requirePromotionV2=true and paper:microstructure-stress is not v2-gated')
  })

  it('parses paper evidence ledger options', () => {
    const args = parseArgs([
      '--paperEvidenceRoot',
      '/tmp/openalice-paper-evidence',
      '--paperEvidenceMaxAgeSeconds',
      '1200',
    ])

    expect(args.paperEvidenceRoot).toBe('/tmp/openalice-paper-evidence')
    expect(args.paperEvidenceMaxAgeSeconds).toBe(1200)
  })

  it('writes legacy summary plus v4.1 immutable paper evidence artifacts', async () => {
    const root = tempRoot('openalice-shadow-loop-')
    const summaryPath = join(root, 'data/runtime/paper_shadow_loop.latest.json')
    const evidenceRoot = join(root, 'runtime/paper')

    const result = await writeSummaryAndPaperEvidence(
      {
        summaryPath,
        paperEvidenceRoot: evidenceRoot,
        paperEvidenceMaxAgeSeconds: 900,
      },
      {
        generatedAt: '2026-05-02T00:00:00.000Z',
        dryRun: true,
        paperDataMode: 'live_only',
        safety: {
          activeAccountCount: 0,
          safeAccountCount: 0,
          unsafeAccounts: [],
          warnings: [],
        },
        steps: [],
        status: 'passed',
        notes: ['test summary'],
      },
    )

    const summary = JSON.parse(readFileSync(summaryPath, 'utf-8')) as Record<string, unknown>
    const report = JSON.parse(readFileSync(result.reportPath, 'utf-8')) as Record<string, unknown>
    const pointer = JSON.parse(readFileSync(result.latestPointerPath, 'utf-8')) as Record<string, unknown>
    const ledgerLines = readFileSync(result.ledgerPath, 'utf-8').trim().split('\n')

    expect(summary).toMatchObject({
      generatedAt: '2026-05-02T00:00:00.000Z',
      paperDataMode: 'live_only',
      status: 'passed',
    })
    expect(report).toMatchObject({
      schema_version: 'paper_evidence_report.v4_1',
      report_id: result.ledgerEntry.reportId,
      paper_data_mode: 'live_only',
      source_summary_path: summaryPath,
    })
    expect(pointer).toMatchObject({
      schema_version: 'paper_evidence_latest_pointer.v4_1',
      latest_report_id: result.ledgerEntry.reportId,
      path: result.reportPath,
    })
    expect(ledgerLines).toHaveLength(1)
  })
})

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}
