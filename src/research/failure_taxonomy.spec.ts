import { describe, expect, it } from 'vitest'
import {
  FAILURE_CODES,
  FAILURE_TAXONOMY,
  deriveNextMutation,
  isFailureCode,
} from './failure_taxonomy.js'

describe('failure_taxonomy', () => {
  it('defines every failure code exactly once with machine-readable retry metadata', () => {
    expect(new Set(FAILURE_CODES).size).toBe(FAILURE_CODES.length)
    for (const code of FAILURE_CODES) {
      expect(FAILURE_TAXONOMY[code]).toMatchObject({
        code,
        promotionRelevance: expect.any(Boolean),
        retryPolicy: expect.any(String),
        defaultNextMutation: expect.any(String),
      })
    }
  })

  it('rejects free-form failure code strings', () => {
    expect(isFailureCode('FDR_FAILED')).toBe(true)
    expect(isFailureCode('whatever-human-wrote')).toBe(false)
  })

  it('derives next mutation from failure priority rather than human text', () => {
    expect(deriveNextMutation(['PIT_VIOLATION', 'FDR_FAILED'])).toBe('retry_after_new_hypothesis')
    expect(deriveNextMutation(['PIT_PROXY_ONLY'])).toBe('retry_after_pit_fix')
    expect(deriveNextMutation(['ACCOUNTING_BUG', 'COST_FRAGILE'])).toBe('retry_after_cost_model_fix')
    expect(deriveNextMutation(['FORECAST_NO_INCREMENTAL_EDGE'])).toBe('retry_with_new_model_or_feature_set')
    expect(deriveNextMutation([])).toBe('requires_human_review')
  })
})
