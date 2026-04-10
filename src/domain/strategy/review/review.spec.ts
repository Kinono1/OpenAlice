import { describe, expect, it } from 'vitest'
import { summarizeReviewRecords } from './index.js'

describe('strategy review loop', () => {
  it('promotes strategies with repeated positive labels', () => {
    const summary = summarizeReviewRecords([
      { ticketId: '1', strategyId: 's1', label: 'alpha-valid' },
      { ticketId: '2', strategyId: 's1', label: 'timing-bad' },
      { ticketId: '3', strategyId: 's1', label: 'alpha-valid' },
    ])

    expect(summary.promotedCandidates).toEqual(['s1'])
  })

  it('creates hard restrictions from repeated negative labels', () => {
    const summary = summarizeReviewRecords([
      { ticketId: '1', label: 'sentiment-trap' },
      { ticketId: '2', label: 'sentiment-trap' },
      { ticketId: '3', label: 'regime-miss' },
      { ticketId: '4', label: 'regime-miss' },
    ])

    expect(summary.hardRestrictions).toEqual(['sentiment-trap', 'regime-miss'])
  })
})
