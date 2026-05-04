import { describe, expect, it } from 'vitest'
import { hashConfig, stableJsonStringify } from './config-hash.js'

describe('config hash', () => {
  it('creates stable hashes independent of object key order', () => {
    const left = {
      model: { threshold: 0.7, features: ['volume', 'spread'] },
      universe: ['BTC-USDT', 'ETH-USDT'],
    }
    const right = {
      universe: ['BTC-USDT', 'ETH-USDT'],
      model: { features: ['volume', 'spread'], threshold: 0.7 },
    }

    expect(stableJsonStringify(left)).toBe(stableJsonStringify(right))
    expect(hashConfig(left)).toBe(hashConfig(right))
  })

  it('includes nested config values in the hash input', () => {
    const base = { costModel: { slippageBps: 4, feeBps: 6 } }
    const changed = { costModel: { slippageBps: 5, feeBps: 6 } }

    expect(hashConfig(base)).not.toBe(hashConfig(changed))
  })
})
