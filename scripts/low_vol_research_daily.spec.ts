import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseArgs, runLowVolResearchDaily } from './low_vol_research_daily.ts'

describe('low_vol_research_daily', () => {
  it('fails closed when canonical OKX coverage is insufficient', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-low-vol-'))
    const args = parseArgs(['--dataRoot', root, '--minSymbols1h', '2', '--minSymbols5m', '2', '--minBars1h', '3', '--minBars5m', '3'])
    const report = await runLowVolResearchDaily(args, new Date('2026-07-17T03:00:00.000Z'))
    expect(report.status).toBe('blocked_insufficient_data')
    expect(report.ranking).toEqual([])
    expect(report.paperDecision).toMatchObject({ action: 'blocked', candidates: [], executionRequested: false })
    const persisted = JSON.parse(await readFile(args.paperDecisionPath, 'utf-8'))
    expect(persisted).toMatchObject({ status: 'blocked_insufficient_data', signals: [], executionAllowed: false })
  })

  it('uses only local canonical OKX 1h/5m data and produces paper-only research artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-low-vol-'))
    const now = new Date('2026-07-17T03:00:00.000Z')
    for (const [dir, suffix, stepMs] of [['live_accumulated', '1h', 3_600_000], ['live_5m', '5m', 300_000]] as const) {
      await mkdir(join(root, 'market', dir), { recursive: true })
      for (const symbol of ['BTC', 'ETH']) {
        const rows = [0, 1, 2, 3].map(index => {
          const timestamp = now.getTime() - (3 - index) * stepMs
          const price = symbol === 'BTC' ? 100 + index : 50 + index * 0.25
          return `${timestamp},${new Date(timestamp).toISOString()},${price},${price},${price},${price},1,${symbol}_USDT_USDT,${suffix},okx`
        })
        await writeFile(join(root, 'market', dir, `${symbol}_USDT_USDT_${suffix}.csv`), [
          'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange',
          ...rows,
        ].join('\n'))
      }
    }
    const args = parseArgs(['--dataRoot', root, '--minSymbols1h', '2', '--minSymbols5m', '2', '--minBars1h', '3', '--minBars5m', '3'])
    const report = await runLowVolResearchDaily(args, now)
    expect(report).toMatchObject({
      status: 'complete',
      researchOnly: true,
      paperShadowOnly: true,
      externalDiskUsed: false,
      executionAllowed: false,
      productionConfigMutationAllowed: false,
    })
    expect(report.ranking).toHaveLength(2)
    expect(report.paperDecision.candidates).toHaveLength(2)
    expect(JSON.stringify(report)).not.toContain('/Volumes/shield')
  })

  it('rejects /Volumes as a runtime data root', async () => {
    const args = parseArgs(['--dataRoot', '/Volumes/shield/openalice-data'])
    await expect(runLowVolResearchDaily(args)).rejects.toThrow('/Volumes is offline-only')
  })
})
