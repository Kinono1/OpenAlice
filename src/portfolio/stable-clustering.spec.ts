import { describe, expect, it } from 'vitest'
import { buildStableCorrelationClusters } from './stable-clustering.js'

describe('stable correlation clustering', () => {
  it('keeps only consensus-stable correlation communities', () => {
    const result = buildStableCorrelationClusters({
      windows: [
        {
          symbols: ['BTC', 'ETH', 'SOL'],
          correlation: [
            [1, 0.9, 0.2],
            [0.9, 1, 0.3],
            [0.2, 0.3, 1],
          ],
        },
        {
          symbols: ['BTC', 'ETH', 'SOL'],
          correlation: [
            [1, 0.86, 0.8],
            [0.86, 1, 0.1],
            [0.8, 0.1, 1],
          ],
        },
        {
          symbols: ['BTC', 'ETH', 'SOL'],
          correlation: [
            [1, 0.88, 0.2],
            [0.88, 1, 0.2],
            [0.2, 0.2, 1],
          ],
        },
      ],
      edgeCorrelationThreshold: 0.75,
      consensusThreshold: 0.67,
      representativeScores: { BTC: 0.7, ETH: 0.8, SOL: 0.9 },
    })

    expect(result.coAssignmentFrequency['BTC|ETH']).toBe(1)
    expect(result.coAssignmentFrequency['BTC|SOL']).toBeCloseTo(1 / 3)
    expect(result.clusters).toEqual([
      { clusterId: 1, symbols: ['BTC', 'ETH'], representative: 'ETH' },
      { clusterId: 2, symbols: ['SOL'], representative: 'SOL' },
    ])
  })
})
