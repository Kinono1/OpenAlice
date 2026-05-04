import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SqliteDurableStateStore, type KillSwitchStateStore } from '../../core/durable-state-store.js'
import { KillSwitch } from './kill-switch.js'

describe('KillSwitch', () => {
  let ks: KillSwitch
  const tempDirs: string[] = []

  beforeEach(() => {
    ks = new KillSwitch()
  })

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
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

  it('hydrates persisted kill-switch state after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-ks-'))
    tempDirs.push(dir)
    const store = new SqliteDurableStateStore(join(dir, 'state.sqlite'))

    const first = new KillSwitch({ stateStore: store })
    first.activate('ETH/USD', 'operator stop', 'block_all')

    const restarted = new KillSwitch({ stateStore: store })
    expect(restarted.get('ETH/USD')).toMatchObject({
      symbol: 'ETH/USD',
      policy: 'block_all',
      reason: 'operator stop',
    })
    expect(restarted.check('ETH/USD', true).blocked).toBe(true)

    store.close()
  })

  it('blocks new risk when persistence is degraded', () => {
    const failingStore: KillSwitchStateStore = {
      loadAll: () => [],
      upsert: () => {
        throw new Error('disk unavailable')
      },
      delete: () => {},
    }
    const persistent = new KillSwitch({ stateStore: failingStore })

    persistent.activate('BTC/USD', 'test')

    const newRisk = persistent.check('BTC/USD', false)
    const reduceOnly = persistent.check('BTC/USD', true)
    expect(newRisk.blocked).toBe(true)
    expect(newRisk.persistenceDegraded).toBe(true)
    expect(String(newRisk.reason)).toContain('disk unavailable')
    expect(reduceOnly.persistenceDegraded).toBeUndefined()
  })
})
