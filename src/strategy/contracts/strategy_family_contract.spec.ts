import { describe, expect, it } from 'vitest'
import {
  OPENALICE_STRATEGY_FAMILY_CONTRACTS,
  getStrategyFamilyContract,
  validateStrategyFamilyContract,
} from './strategy_family_contract.js'

describe('strategy_family_contract', () => {
  it('keeps all built-in strategy family contracts valid and fail-closed', () => {
    for (const contract of Object.values(OPENALICE_STRATEGY_FAMILY_CONTRACTS)) {
      expect(validateStrategyFamilyContract(contract), contract.familyId).toEqual({
        passed: true,
        blockingReasons: [],
      })
      expect(contract.maxLeverage).toBeLessThanOrEqual(1)
      for (const feature of contract.requiredFeatures) {
        expect(feature.availableTimePolicy).toBe('available_time <= decision_time')
      }
    }
  })

  it('pins Kronos to diagnostic research-only status', () => {
    expect(getStrategyFamilyContract('kronos_forecast_shadow')).toMatchObject({
      role: 'diagnostic',
      promotionEligibility: 'research_only',
      maxTurnover: 0,
      failureModes: ['FORECAST_NO_INCREMENTAL_EDGE', 'FEATURE_AVAILABILITY_MISSING'],
    })
  })

  it('rejects diagnostic strategy families that try to become promotion eligible', () => {
    const kronos = getStrategyFamilyContract('kronos_forecast_shadow')
    if (!kronos) throw new Error('missing kronos contract')

    expect(validateStrategyFamilyContract({
      ...kronos,
      promotionEligibility: 'paper_candidate',
    })).toMatchObject({
      passed: false,
      blockingReasons: expect.arrayContaining([
        'strategy_family_contract_diagnostic_promotion_ineligible_required',
      ]),
    })
  })

  it('rejects contracts with non-PIT feature availability policy', () => {
    const base = getStrategyFamilyContract('low_turnover_cross_sectional_reversal')
    if (!base) throw new Error('missing cross-sectional contract')

    expect(validateStrategyFamilyContract({
      ...base,
      requiredFeatures: [{
        ...base.requiredFeatures[0],
        availableTimePolicy: 'event_time <= decision_time' as never,
      }, {
        ...base.requiredFeatures[1],
      }],
    })).toMatchObject({
      passed: false,
      blockingReasons: expect.arrayContaining([
        `strategy_family_contract_non_pit_feature:${base.requiredFeatures[0].featureId}`,
      ]),
    })
  })
})
