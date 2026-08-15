import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadOkxMarketDataConfig, resolveOkxWarehouseRoot } from '../src/domain/market-data/okx-market-data-config.js'
import type { OkxDepthUniverseManifest, OkxInstrumentRecord } from '../src/domain/market-data/okx-warehouse-types.js'
import { atomicWriteJson, buildCollectionRunId } from './lib/okx_warehouse.js'
import { isUsdtQuotedPublicInstrument, readInstrumentMaster } from './lib/okx_collector_common.js'

interface Ranked {
  instrumentId: string
  quoteTurnover24h: number
  spreadBps: number
  turnoverPercentile: number
  inverseSpreadPercentile: number
  score: number
}

export async function selectOkxDepthUniverse(argv = process.argv.slice(2)): Promise<OkxDepthUniverseManifest> {
  const raw = parseRawArgs(argv)
  const config = await loadOkxMarketDataConfig(raw.get('configPath'))
  const root = resolveOkxWarehouseRoot(config)
  const master = await readInstrumentMaster(root)
  const tickers = await readTickerSnapshot(root)
  const fixed = [...config.universe.fixedDeepInstruments]
  const ranked = rankEligibleSwaps(master, tickers, new Set(fixed), config.universe.maxSpreadBps)
  const previous = await readPrevious(root)
  const selected = applyHysteresis({
    ranked, previous: previous?.dynamicInstruments ?? [], count: config.universe.dynamicDepthCount,
    maxChanges: config.universe.maxDailyDepthChanges,
    challengerImprovementPct: config.universe.challengerImprovementPct,
  })
  const generatedAt = new Date().toISOString()
  const manifestId = buildCollectionRunId('okx-depth-universe', generatedAt)
  const manifest: OkxDepthUniverseManifest = {
    schemaVersion: 'okx_depth_universe.v1', manifestId, generatedAt, effectiveAt: generatedAt,
    fixedDeepInstruments: fixed, dynamicInstruments: selected,
    previousDynamicInstruments: previous?.dynamicInstruments ?? [],
    added: selected.filter(id => !(previous?.dynamicInstruments ?? []).includes(id)),
    removed: (previous?.dynamicInstruments ?? []).filter(id => !selected.includes(id)),
    maxDailyChanges: config.universe.maxDailyDepthChanges,
    challengerImprovementPct: config.universe.challengerImprovementPct,
    mode: config.stream.fullDepthMode === 'continuous' ? 'continuous_books'
      : config.stream.fullDepthMode === 'bounded_capture_window' ? 'bounded_capture_window'
        : 'blocked_storage_budget',
    rankings: ranked,
  }
  await atomicWriteJson(join(root, 'state', 'depth-universe.latest.json'), manifest)
  await atomicWriteJson(join(root, 'manifests', 'universe', `${manifestId}.json`), manifest)
  await atomicWriteJson(join(root, 'state', 'top-minute-universe.latest.json'), {
    schemaVersion: 'okx_top_minute_universe.v1', manifestId, generatedAt,
    instruments: selectTopMinute(master, tickers, config.universe.topMinuteCandleCount),
  })
  await atomicWriteJson(resolve(config.dataRoot, 'runtime', 'okx_warehouse', 'okx_depth_universe.latest.json'), manifest)
  return manifest
}

export function rankEligibleSwaps(
  master: OkxInstrumentRecord[],
  tickers: Map<string, { quoteVolume24h: number | null; spreadBps: number | null }>,
  fixed: Set<string>,
  maxSpreadBps: number,
): Ranked[] {
  const eligible = master
    .filter(item => item.instrumentType === 'SWAP' && item.state === 'live' && item.settleCurrency === 'USDT' && !fixed.has(item.instrumentId))
    .map(item => ({ instrumentId: item.instrumentId, ticker: tickers.get(item.instrumentId) }))
    .filter((item): item is { instrumentId: string; ticker: { quoteVolume24h: number; spreadBps: number } } =>
      item.ticker != null && (item.ticker.quoteVolume24h ?? 0) > 0 && (item.ticker.spreadBps ?? Infinity) <= maxSpreadBps && (item.ticker.spreadBps ?? 0) >= 0)
  const turnovers = eligible.map(item => item.ticker.quoteVolume24h).sort((a, b) => a - b)
  const inverseSpreads = eligible.map(item => -item.ticker.spreadBps).sort((a, b) => a - b)
  return eligible.map(item => {
    const turnoverPercentile = percentile(turnovers, item.ticker.quoteVolume24h)
    const inverseSpreadPercentile = percentile(inverseSpreads, -item.ticker.spreadBps)
    return {
      instrumentId: item.instrumentId,
      quoteTurnover24h: item.ticker.quoteVolume24h,
      spreadBps: item.ticker.spreadBps,
      turnoverPercentile,
      inverseSpreadPercentile,
      score: 0.7 * turnoverPercentile + 0.3 * inverseSpreadPercentile,
    }
  }).sort((left, right) => right.score - left.score || left.instrumentId.localeCompare(right.instrumentId))
}

export function applyHysteresis(input: { ranked: Ranked[]; previous: string[]; count: number; maxChanges: number; challengerImprovementPct: number }): string[] {
  const score = new Map(input.ranked.map(item => [item.instrumentId, item.score]))
  const selected = input.previous.filter(id => score.has(id)).slice(0, input.count)
  for (const candidate of input.ranked) {
    if (selected.includes(candidate.instrumentId)) continue
    if (selected.length < input.count) { selected.push(candidate.instrumentId); continue }
    const lowest = selected.map(id => ({ id, score: score.get(id) ?? -Infinity })).sort((a, b) => a.score - b.score)[0]
    const changes = selected.filter(id => !input.previous.includes(id)).length
    if (changes >= input.maxChanges) break
    const improvement = lowest.score <= 0 ? Infinity : ((candidate.score - lowest.score) / lowest.score) * 100
    if (improvement >= input.challengerImprovementPct) selected[selected.indexOf(lowest.id)] = candidate.instrumentId
  }
  return selected.sort((left, right) => (score.get(right) ?? 0) - (score.get(left) ?? 0) || left.localeCompare(right))
}

async function readTickerSnapshot(root: string): Promise<Map<string, { quoteVolume24h: number | null; spreadBps: number | null }>> {
  try {
    const parsed = JSON.parse(await readFile(join(root, 'state', 'ticker-snapshot.latest.json'), 'utf-8')) as { tickers?: Array<{ instrumentId?: string; payload?: { quoteVolume24h?: number | null; spreadBps?: number | null } }> }
    return new Map((parsed.tickers ?? []).filter(item => item.instrumentId).map(item => [item.instrumentId!, { quoteVolume24h: item.payload?.quoteVolume24h ?? null, spreadBps: item.payload?.spreadBps ?? null }]))
  } catch { return new Map() }
}

async function readPrevious(root: string): Promise<OkxDepthUniverseManifest | null> {
  try { return JSON.parse(await readFile(join(root, 'state', 'depth-universe.latest.json'), 'utf-8')) as OkxDepthUniverseManifest } catch { return null }
}

export function selectTopMinute(master: OkxInstrumentRecord[], tickers: Map<string, { quoteVolume24h: number | null }>, count: number): string[] {
  return master.filter(item => item.state === 'live' && (item.instrumentType === 'SPOT' || item.instrumentType === 'SWAP') && isUsdtQuotedPublicInstrument(item))
    .map(item => ({ id: item.instrumentId, turnover: tickers.get(item.instrumentId)?.quoteVolume24h ?? 0 }))
    .filter(item => item.turnover > 0).sort((a, b) => b.turnover - a.turnover || a.id.localeCompare(b.id)).slice(0, count).map(item => item.id)
}

function percentile(sorted: number[], value: number): number { if (sorted.length <= 1) return 1; const index = sorted.findLastIndex(item => item <= value); return Math.max(0, index) / (sorted.length - 1) }
function parseRawArgs(argv: string[]): Map<string, string> { const out = new Map<string, string>(); for (let i = 0; i < argv.length; i += 1) { const token = argv[i]; if (!token?.startsWith('--')) continue; const next = argv[i + 1]; if (!next || next.startsWith('--')) out.set(token.slice(2), 'true'); else { out.set(token.slice(2), next); i += 1 } } return out }

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) selectOkxDepthUniverse().then(value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)).catch(error => { console.error(error); process.exitCode = 1 })
