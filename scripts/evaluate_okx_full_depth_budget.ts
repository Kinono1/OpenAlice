import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { loadOkxMarketDataConfig, resolveOkxWarehouseRoot } from '../src/domain/market-data/okx-market-data-config.js'
import { atomicWriteJson, listRawSegmentManifests, readRawSegmentEvents } from './lib/okx_warehouse.js'

export interface FullDepthBudgetReport {
  schemaVersion: 'okx_full_depth_budget.v1'
  generatedAt: string
  researchOnly: true
  instrumentId: string
  observedBytes: number
  observedEvents: number
  observedHours: number
  projectedContinuous8DayGiB: number | null
  projectedWindowed8DayGiB: number | null
  threshold8DayGiB: 18
  requiredCanaryHours: 6
  status: 'blocked_insufficient_canary_duration' | 'continuous_allowed' | 'bounded_capture_window' | 'blocked_storage_budget'
  recommendedMode: 'canary_btc' | 'continuous' | 'bounded_capture_window' | 'disabled'
  configChanged: false
  blockers: string[]
}

export async function evaluateOkxFullDepthBudget(argv = process.argv.slice(2)): Promise<FullDepthBudgetReport> {
  const raw = parseRawArgs(argv)
  const config = await loadOkxMarketDataConfig(raw.get('configPath'))
  const warehouseRoot = resolveOkxWarehouseRoot(config)
  const instrumentId = raw.get('instrumentId') ?? 'BTC-USDT-SWAP'
  const manifests = (await listRawSegmentManifests(warehouseRoot)).filter(item =>
    item.manifest.dataset === 'orderbook_delta' && item.manifest.instrumentId === instrumentId)
  let minTime = Infinity
  let maxTime = -Infinity
  let observedEvents = 0
  let observedBytes = 0
  for (const item of manifests) {
    const events = await readRawSegmentEvents(warehouseRoot, item.manifest)
    const fullDepth = events.filter(event => event.channel === 'books' && event.sourceEndpoint.includes('/books'))
    if (fullDepth.length === 0) continue
    const fraction = fullDepth.length / Math.max(1, events.length)
    observedBytes += Math.ceil(item.manifest.bytes * fraction)
    observedEvents += fullDepth.length
    for (const event of fullDepth) {
      const timestamp = Date.parse(event.eventTime)
      if (Number.isFinite(timestamp)) { minTime = Math.min(minTime, timestamp); maxTime = Math.max(maxTime, timestamp) }
    }
  }
  const observedHours = observedEvents > 1 && Number.isFinite(minTime) && Number.isFinite(maxTime) ? Math.max(0, (maxTime - minTime) / 3_600_000) : 0
  const projectedContinuous8DayGiB = observedHours > 0 ? (observedBytes / observedHours) * (8 * 24) / 1024 ** 3 : null
  const projectedWindowed8DayGiB = projectedContinuous8DayGiB == null ? null : projectedContinuous8DayGiB / 6
  const decision = decideFullDepthBudget({ observedHours, projectedContinuous8DayGiB, projectedWindowed8DayGiB })
  const report: FullDepthBudgetReport = {
    schemaVersion: 'okx_full_depth_budget.v1', generatedAt: new Date().toISOString(), researchOnly: true,
    instrumentId, observedBytes, observedEvents, observedHours,
    projectedContinuous8DayGiB, projectedWindowed8DayGiB, threshold8DayGiB: 18,
    requiredCanaryHours: 6, ...decision, configChanged: false,
  }
  await atomicWriteJson(resolve(raw.get('outputPath') ?? join(config.dataRoot, 'runtime', 'okx_warehouse', 'okx_full_depth_budget.latest.json')), report)
  return report
}

export function decideFullDepthBudget(input: {
  observedHours: number
  projectedContinuous8DayGiB: number | null
  projectedWindowed8DayGiB: number | null
}): Pick<FullDepthBudgetReport, 'status' | 'recommendedMode' | 'blockers'> {
  if (input.observedHours < 6 || input.projectedContinuous8DayGiB == null) {
    return { status: 'blocked_insufficient_canary_duration', recommendedMode: 'canary_btc', blockers: [`full_depth_canary_hours:${input.observedHours.toFixed(2)}/6`] }
  }
  if (input.projectedContinuous8DayGiB <= 18) return { status: 'continuous_allowed', recommendedMode: 'continuous', blockers: [] }
  if (input.projectedWindowed8DayGiB != null && input.projectedWindowed8DayGiB <= 18) {
    return { status: 'bounded_capture_window', recommendedMode: 'bounded_capture_window', blockers: ['continuous_capture_exceeds_18_gib_8d'] }
  }
  return { status: 'blocked_storage_budget', recommendedMode: 'disabled', blockers: ['continuous_and_windowed_capture_exceed_18_gib_8d'] }
}

function parseRawArgs(argv: string[]): Map<string, string> { const out = new Map<string, string>(); for (let index = 0; index < argv.length; index += 1) { const token = argv[index]; if (!token?.startsWith('--')) continue; const next = argv[index + 1]; if (!next || next.startsWith('--')) out.set(token.slice(2), 'true'); else { out.set(token.slice(2), next); index += 1 } } return out }

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) evaluateOkxFullDepthBudget().then(report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)).catch(error => { console.error(error); process.exitCode = 1 })
