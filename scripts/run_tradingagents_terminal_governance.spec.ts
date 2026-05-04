import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runTradingAgentsTerminalGovernance } from './run_tradingagents_terminal_governance.js'

const GOLDEN_FIXTURES = [
  'data/research/strategy/strategy_validation_runs.btc_paradigm_tradingagents_v2_validation.json',
  'data/research/strategy/analysis/route_matrix_btc_paradigm_tradingagents_v2_validation_20260401.json',
  'data/research/strategy/analysis/wfo_sensitivity_btc_paradigm_tradingagents_v2_independent_guard_20260402.json',
]

describe('runTradingAgentsTerminalGovernance', () => {
  it.skipIf(GOLDEN_FIXTURES.some((path) => !existsSync(resolve(process.cwd(), path))))(
    'produces stage assessment, diagnoses, and latest status files',
    async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-terminal-governance-'))
    const result = await runTradingAgentsTerminalGovernance({
      validationRuns:
        'data/research/strategy/strategy_validation_runs.btc_paradigm_tradingagents_v2_validation.json',
      routeMatrix:
        'data/research/strategy/analysis/route_matrix_btc_paradigm_tradingagents_v2_validation_20260401.json',
      wfoSensitivity:
        'data/research/strategy/analysis/wfo_sensitivity_btc_paradigm_tradingagents_v2_independent_guard_20260402.json',
      paradigmId: 'tradingagents_research_sidecar_v2',
      analysisDir: join(root, 'analysis'),
      paradigmDir: join(root, 'paradigm'),
      dateTag: '20260403',
      journalPath: join(root, 'execution_journal.jsonl'),
      stageAssessmentOutput: join(root, 'analysis', 'stage_assessment.json'),
      poolProfiles: ['baseline_guard_v1', 'baseline_independent_guard_v1'],
    })

    expect(result.diagnosisPaths).toHaveLength(2)
    const status = JSON.parse(await readFile(result.statusJson, 'utf-8')) as Record<string, unknown>
    expect(status.schemaVersion).toBe('tradingagents_terminal_status.v1')
    expect(status.terminalDecision).toBeTruthy()
    },
  )
})
