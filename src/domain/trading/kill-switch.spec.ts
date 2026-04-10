import { describe, it, expect, beforeEach } from 'vitest'
import { KillSwitch } from './kill-switch.js'

describe('KillSwitch', () => {
  let ks: KillSwitch

  beforeEach(() => {
    ks = new KillSwitch()
  })

  it('allows when no kill switch active', () => {
    expect(ks.check('BTC/USD', false).blocked).toBe(false)
  })

  it('block_new_only blocks new positions', () => {
    ks.activate('BTC/USD', 'test', 'block_new_only')
    expect(ks.check('BTC/USD', false).blocked).toBe(true)
  })

  it('block_new_only allows reduceOnly', () => {
    ks.activate('BTC/USD', 'test', 'block_new_only')
    expect(ks.check('BTC/USD', true).blocked).toBe(false)
  })

  it('block_all blocks everything', () => {
    ks.activate('BTC/USD', 'test', 'block_all')
    expect(ks.check('BTC/USD', false).blocked).toBe(true)
    expect(ks.check('BTC/USD', true).blocked).toBe(true)
  })

  it('block_all allows emergency close', () => {
    ks.activate('BTC/USD', 'test', 'block_all')
    expect(ks.check('BTC/USD', false, true).blocked).toBe(false)
  })

  it('deactivate removes kill switch', () => {
    ks.activate('BTC/USD', 'test')
    ks.deactivate('BTC/USD')
    expect(ks.check('BTC/USD', false).blocked).toBe(false)
  })
})

