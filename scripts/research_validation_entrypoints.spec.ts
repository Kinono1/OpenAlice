import { describe, expect, it } from 'vitest'
import { parseArgs as parseCrossSectionalArgs } from './run_cross_sectional_validation.ts'
import { parseArgs as parseNewStrategiesArgs } from './run_new_strategies_validation.ts'
import { parseArgs as parseRiskDeepAnalysisArgs } from './run_risk_deep_analysis.ts'

describe('research validation CLI entrypoints', () => {
  it('default to dry-run before writing research artifacts', () => {
    expect(parseCrossSectionalArgs([]).dryRun).toBe(true)
    expect(parseNewStrategiesArgs([]).dryRun).toBe(true)
    expect(parseRiskDeepAnalysisArgs([]).dryRun).toBe(true)
  })

  it('require explicit opt-in before running artifact-producing validation', () => {
    expect(parseCrossSectionalArgs(['--dryRun', 'false']).dryRun).toBe(false)
    expect(parseNewStrategiesArgs(['--dryRun=false']).dryRun).toBe(false)
    expect(parseRiskDeepAnalysisArgs(['--dryRun', 'false']).dryRun).toBe(false)
  })
})
