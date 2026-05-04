import { describe, expect, it } from 'vitest'
import { combineNewsAndSocialRisk } from './social-signals.js'

describe('combineNewsAndSocialRisk', () => {
  it('amplifies normal news risk when social fear is strong', () => {
    const result = combineNewsAndSocialRisk('normal', false, {
      totalSources: 1,
      totalSignals: 10,
      dominantSentiment: 'fear',
      sentimentScore: -0.8,
      topSignals: ['fud_detected'],
      fudCount: 5,
      hypeCount: 0,
      whaleAlertCount: 2,
      influencerCount: 0,
    })

    expect(result).toMatchObject({
      riskRegime: 'elevated',
      hardVeto: false,
    })
  })

  it('keeps severe formal risk when social is unavailable', () => {
    const result = combineNewsAndSocialRisk('severe', true, {
      totalSources: 0,
      totalSignals: 0,
      dominantSentiment: 'neutral',
      sentimentScore: 0,
      topSignals: [],
      fudCount: 0,
      hypeCount: 0,
      whaleAlertCount: 0,
      influencerCount: 0,
    })

    expect(result).toMatchObject({
      riskRegime: 'elevated',
      hardVeto: false,
    })
  })
})
