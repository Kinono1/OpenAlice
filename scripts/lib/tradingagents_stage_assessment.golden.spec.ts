import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildTradingAgentsStageSnapshot } from './tradingagents_stage_assessment.js'

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), relativePath), 'utf-8')) as T
}

describe('TradingAgents stage assessment', () => {
  it('keeps the current tradingagents validation artifact at Stage A fail', () => {
    const validationRuns = readJson<Record<string, unknown>>(
      'data/research/strategy/strategy_validation_runs.btc_paradigm_tradingagents_v2_validation.json',
    )
    const routeMatrix = readJson<Record<string, unknown>>(
      'data/research/strategy/analysis/route_matrix_btc_paradigm_tradingagents_v2_validation_20260401.json',
    )
    const wfoSensitivity = readJson<Record<string, unknown>>(
      'data/research/strategy/analysis/wfo_sensitivity_btc_paradigm_tradingagents_v2_independent_guard_20260402.json',
    )

    const stageSnapshot = buildTradingAgentsStageSnapshot({
      validationRuns,
      routeMatrix,
      wfoSensitivity,
    })

    expect(stageSnapshot.currentStage).toBe('A')
    expect(stageSnapshot.currentStageStatus).toBe('fail')
  })
})
