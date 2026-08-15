import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportOkxFundingHistory } from './export_okx_funding_history.ts'

describe('export_okx_funding_history', () => {
  it('exports only requested OKX swap funding rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-funding-'))
    const input = join(root, 'normalized.jsonl')
    const output = join(root, 'eth.json')
    await writeFile(input, [
      JSON.stringify({ exchange: 'okx', market: 'swap', endpointId: 'fundingRate', symbol: 'ETHUSDT', eventTimeMs: 1, fields: { fundingRate: 0.1, fundingTime: 1 } }),
      JSON.stringify({ exchange: 'okx', market: 'swap', endpointId: 'fundingRate', symbol: 'BTCUSDT', eventTimeMs: 1, fields: { fundingRate: 0.2, fundingTime: 1 } }),
    ].join('\n'))
    await expect(exportOkxFundingHistory({ normalizedPath: input, symbol: 'ETHUSDT', outputPath: output })).resolves.toMatchObject({ rows: 1 })
    expect(JSON.parse(await readFile(output, 'utf-8'))).toEqual([{ symbol: 'ETH/USDT:USDT', fundingRate: 0.1, timestamp: 1 }])
  })
})
