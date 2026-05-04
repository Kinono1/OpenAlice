import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface PairMarketCandle {
  symbol: string
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export async function loadCsvCandles(
  path: string,
  symbol: string,
): Promise<PairMarketCandle[]> {
  const raw = await readFile(resolve(path), 'utf-8')
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length < 2) {
    throw new Error(`CSV has no rows: ${path}`)
  }

  const header = lines[0].split(',')
  const idx = {
    timestamp: header.indexOf('timestamp'),
    open: header.indexOf('open'),
    high: header.indexOf('high'),
    low: header.indexOf('low'),
    close: header.indexOf('close'),
    volume: header.indexOf('volume'),
  }
  for (const [name, value] of Object.entries(idx)) {
    if (value < 0) {
      throw new Error(`CSV missing required column "${name}": ${path}`)
    }
  }

  const out: PairMarketCandle[] = []
  for (const row of lines.slice(1)) {
    const cols = row.split(',')
    const rawTs = Number(cols[idx.timestamp])
    const open = Number(cols[idx.open])
    const high = Number(cols[idx.high])
    const low = Number(cols[idx.low])
    const close = Number(cols[idx.close])
    const volume = Number(cols[idx.volume])
    if ([rawTs, open, high, low, close, volume].every((value) => Number.isFinite(value))) {
      const tsSeconds = rawTs > 1e11 ? Math.floor(rawTs / 1000) : Math.floor(rawTs)
      out.push({
        symbol,
        time: tsSeconds,
        open,
        high,
        low,
        close,
        volume,
      })
    }
  }

  out.sort((left, right) => left.time - right.time)
  return out
}

export function alignPairCandles(
  leader: PairMarketCandle[],
  hedge: PairMarketCandle[],
): Array<{ leader: PairMarketCandle; hedge: PairMarketCandle }> {
  const hedgeByTime = new Map(hedge.map((candle) => [candle.time, candle]))
  return leader
    .map((leaderCandle) => {
      const hedgeCandle = hedgeByTime.get(leaderCandle.time)
      if (!hedgeCandle) return null
      return { leader: leaderCandle, hedge: hedgeCandle }
    })
    .filter((pair): pair is { leader: PairMarketCandle; hedge: PairMarketCandle } => pair != null)
}

export function buildRelativeValueCandles(input: {
  leader: PairMarketCandle[]
  hedge: PairMarketCandle[]
  symbol: string
}): PairMarketCandle[] {
  return alignPairCandles(input.leader, input.hedge)
    .map(({ leader, hedge }) => {
      if (
        hedge.open <= 0 ||
        hedge.high <= 0 ||
        hedge.low <= 0 ||
        hedge.close <= 0
      ) {
        return null
      }

      return {
        symbol: input.symbol,
        time: leader.time,
        open: leader.open / hedge.open,
        high: leader.high / hedge.low,
        low: leader.low / hedge.high,
        close: leader.close / hedge.close,
        volume: Math.max(leader.volume, 0),
      }
    })
    .filter((candle): candle is PairMarketCandle => candle != null)
}
