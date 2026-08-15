import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'
import { buildOkxMarketEvent } from '../src/domain/market-data/okx-warehouse-mappers.js'
import { loadOkxMarketDataConfig, resolveOkxWarehouseRoot } from '../src/domain/market-data/okx-market-data-config.js'
import { OkxOrderBook, type OkxBookUpdate } from '../src/domain/market-data/okx-orderbook.js'
import type { OkxDepthUniverseManifest, OkxMarketEvent } from '../src/domain/market-data/okx-warehouse-types.js'
import { appendOkxMarketEvents, atomicWriteJson, buildCollectionRunId, buildStoragePressureStatus, payloadHash } from './lib/okx_warehouse.js'

type StreamKind = 'public' | 'business'

interface StreamHealth {
  schemaVersion: 'okx_stream_health.v1'
  generatedAt: string
  status: 'starting' | 'ready' | 'degraded_stream_unavailable' | 'degraded_storage_pressure' | 'stopped'
  enabled: boolean
  publicConnected: boolean
  businessConnected: boolean
  acknowledgedSubscriptions: number
  expectedSubscriptions: number
  reconnectAttempts: number
  lastEventAt: string | null
  sequenceGaps: number
  checksumMismatches: number
  duplicateTrades: number
  errors: string[]
  privateLoginSent: false
}

export class OkxStreamWorker {
  private readonly configPath?: string
  private stopping = false
  private publicWs: WebSocket | null = null
  private businessWs: WebSocket | null = null
  private flushTimer: NodeJS.Timeout | null = null
  private healthTimer: NodeJS.Timeout | null = null
  private pending: OkxMarketEvent[] = []
  private readonly tradeIds = new Map<string, Set<string>>()
  private readonly books = new Map<string, OkxOrderBook>()
  private health: StreamHealth = {
    schemaVersion: 'okx_stream_health.v1', generatedAt: new Date().toISOString(), status: 'starting', enabled: true,
    publicConnected: false, businessConnected: false, acknowledgedSubscriptions: 0, expectedSubscriptions: 0,
    reconnectAttempts: 0, lastEventAt: null, sequenceGaps: 0, checksumMismatches: 0,
    duplicateTrades: 0, errors: [], privateLoginSent: false,
  }

  constructor(configPath?: string) { this.configPath = configPath }

  async start(): Promise<void> {
    const config = await loadOkxMarketDataConfig(this.configPath)
    if (!config.stream.enabled) throw new Error('OKX public stream is disabled by config')
    const universe = await readUniverse(resolveOkxWarehouseRoot(config), config.universe.fixedDeepInstruments)
    const all = [...new Set([...universe.fixedDeepInstruments, ...universe.dynamicInstruments])]
    const publicArgs = [
      ...all.map(instId => ({ channel: 'books5', instId })),
      { channel: 'liquidation-orders', instType: 'SWAP' },
      { channel: 'liquidation-orders', instType: 'FUTURES' },
    ]
    if (config.stream.fullDepthEnabled) {
      const full = config.stream.fullDepthMode === 'canary_btc' ? ['BTC-USDT-SWAP'] : universe.fixedDeepInstruments
      publicArgs.push(...full.map(instId => ({ channel: 'books', instId })))
    }
    const businessArgs = all.map(instId => ({ channel: 'trades-all', instId }))
    this.health.expectedSubscriptions = publicArgs.length + businessArgs.length
    this.flushTimer = setInterval(() => { this.flush().catch(error => this.recordError(error)) }, 1_000)
    this.healthTimer = setInterval(() => { this.persistHealth().catch(() => {}) }, 10_000)
    await Promise.all([
      this.connect('public', config.stream.publicUrl, publicArgs),
      this.connect('business', config.stream.businessUrl, businessArgs),
    ])
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.publicWs?.close()
    this.businessWs?.close()
    await this.flush()
    this.health.status = 'stopped'
    await this.persistHealth()
  }

  private async connect(kind: StreamKind, url: string, args: Array<Record<string, string>>): Promise<void> {
    if (this.stopping) return
    const socket = new WebSocket(url, { handshakeTimeout: 15_000 })
    if (kind === 'public') this.publicWs = socket
    else this.businessWs = socket
    socket.on('open', () => {
      if (kind === 'public') this.health.publicConnected = true
      else this.health.businessConnected = true
      socket.send(JSON.stringify({ op: 'subscribe', args }))
      this.updateReadyState()
    })
    socket.on('message', raw => { this.handleMessage(kind, raw.toString()).catch(error => this.recordError(error)) })
    socket.on('pong', () => {})
    socket.on('error', error => this.recordError(error))
    socket.on('close', () => {
      if (kind === 'public') this.health.publicConnected = false
      else this.health.businessConnected = false
      if (this.stopping) return
      this.health.status = 'degraded_stream_unavailable'
      this.health.reconnectAttempts += 1
      const delay = reconnectDelay(this.health.reconnectAttempts)
      setTimeout(() => { this.connect(kind, url, args).catch(error => this.recordError(error)) }, delay + Math.floor(Math.random() * Math.max(250, delay * 0.2)))
    })
    const pingTimer = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.ping() }, 20_000)
    socket.once('close', () => clearInterval(pingTimer))
  }

  private async handleMessage(kind: StreamKind, raw: string): Promise<void> {
    const message = JSON.parse(raw) as Record<string, unknown>
    if (message.event === 'subscribe') {
      this.health.acknowledgedSubscriptions += 1
      this.updateReadyState()
      return
    }
    if (message.event === 'error') throw new Error(`OKX subscription rejected: ${JSON.stringify(message)}`)
    const arg = isRecord(message.arg) ? message.arg : {}
    const channel = String(arg.channel ?? '')
    const instId = String(arg.instId ?? '')
    const action = message.action === 'snapshot' ? 'snapshot' : 'update'
    const data = Array.isArray(message.data) ? message.data.filter(isRecord) : []
    const availableAt = new Date().toISOString()
    const runId = buildCollectionRunId(`okx-stream-${kind}`, availableAt)
    if (channel === 'trades-all') this.handleTrades(instId, data, availableAt, runId)
    else if (channel === 'books' || channel === 'books5') this.handleBooks(instId, channel, action, data, availableAt, runId)
    else if (channel === 'liquidation-orders') this.handleLiquidations(data, availableAt, runId)
    this.health.lastEventAt = availableAt
  }

  private handleTrades(instId: string, rows: Record<string, unknown>[], availableAt: string, runId: string): void {
    const seen = this.tradeIds.get(instId) ?? new Set<string>()
    for (const row of rows) {
      const tradeId = String(row.tradeId ?? '')
      if (!tradeId) continue
      if (seen.has(tradeId)) { this.health.duplicateTrades += 1; continue }
      seen.add(tradeId)
      if (seen.size > 20_000) seen.delete(seen.values().next().value as string)
      const eventTime = epochIso(row.ts) ?? availableAt
      this.pending.push(buildOkxMarketEvent({
        dataset: 'trade', instrumentType: 'SWAP', instrumentId: instId, channel: 'trades-all',
        sourceTransport: 'websocket', sourceEndpoint: 'okx-business-ws/trades-all', eventTime,
        availableAt, sequenceId: tradeId, collectionRunId: runId,
        dedupKey: `okx|trade|${instId}|${tradeId}`, payload: row,
      }))
    }
    this.tradeIds.set(instId, seen)
  }

  private handleBooks(instId: string, channel: string, action: 'snapshot' | 'update', rows: Record<string, unknown>[], availableAt: string, runId: string): void {
    for (const row of rows) {
      const update: OkxBookUpdate = {
        action,
        asks: Array.isArray(row.asks) ? row.asks as string[][] : [],
        bids: Array.isArray(row.bids) ? row.bids as string[][] : [],
        checksum: finiteNumber(row.checksum), seqId: finiteNumber(row.seqId), prevSeqId: finiteNumber(row.prevSeqId), ts: String(row.ts ?? ''),
      }
      if (channel === 'books') {
        const book = this.books.get(instId) ?? new OkxOrderBook()
        const applied = book.apply(update)
        this.books.set(instId, book)
        if (applied.status === 'gap' || applied.status === 'checksum_mismatch') {
          if (applied.status === 'gap') this.health.sequenceGaps += 1
          else this.health.checksumMismatches += 1
          this.pending.push(buildOkxMarketEvent({
            dataset: 'orderbook_delta', instrumentType: 'SWAP', instrumentId: instId,
            channel: 'orderbook_gap', sourceTransport: 'derived', sourceEndpoint: 'okx-public-ws/books',
            eventTime: epochIso(row.ts) ?? availableAt, availableAt, sequenceId: String(row.seqId ?? ''),
            checksum: row.checksum == null ? null : String(row.checksum), collectionRunId: runId,
            dedupKey: `okx|orderbook-gap|${instId}|${row.seqId ?? availableAt}|${applied.status}`,
            payload: { status: applied.status, unavailable: true, ...applied },
          }))
          this.resubscribeBook(instId)
          continue
        }
      }
      this.pending.push(buildOkxMarketEvent({
        dataset: channel === 'books' ? (action === 'snapshot' ? 'orderbook_snapshot' : 'orderbook_delta') : 'orderbook_snapshot',
        instrumentType: 'SWAP', instrumentId: instId, channel, sourceTransport: 'websocket',
        sourceEndpoint: `okx-public-ws/${channel}`, eventTime: epochIso(row.ts) ?? availableAt,
        availableAt, sequenceId: row.seqId == null ? null : String(row.seqId),
        checksum: row.checksum == null ? null : String(row.checksum), collectionRunId: runId,
        dedupKey: `okx|${channel}|${instId}|${row.seqId ?? row.ts ?? payloadHash(row)}`,
        payload: { action, ...row },
      }))
    }
  }

  private handleLiquidations(rows: Record<string, unknown>[], availableAt: string, runId: string): void {
    for (const row of rows) {
      const instId = String(row.instId ?? row.instFamily ?? 'unknown')
      const eventTime = epochIso(row.ts) ?? availableAt
      const details = Array.isArray(row.details) ? row.details : [row]
      for (const detail of details.filter(isRecord)) {
        const side = String(detail.side ?? 'unknown')
        const price = String(detail.bkPx ?? detail.price ?? '')
        const size = String(detail.sz ?? detail.size ?? '')
        this.pending.push(buildOkxMarketEvent({
          dataset: 'liquidation', instrumentType: String(row.instType) === 'FUTURES' ? 'FUTURES' : 'SWAP',
          instrumentId: instId, channel: 'liquidation-orders', sourceTransport: 'websocket',
          sourceEndpoint: 'okx-public-ws/liquidation-orders', eventTime, availableAt, collectionRunId: runId,
          dedupKey: `okx|liquidation|${instId}|${eventTime}|${side}|${price}|${size}|${payloadHash(detail)}`,
          payload: { ...row, detail },
        }))
      }
    }
  }

  private resubscribeBook(instId: string): void {
    if (this.publicWs?.readyState !== WebSocket.OPEN) return
    this.publicWs.send(JSON.stringify({ op: 'unsubscribe', args: [{ channel: 'books', instId }] }))
    setTimeout(() => this.publicWs?.readyState === WebSocket.OPEN && this.publicWs.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'books', instId }] })), 250)
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return
    const config = await loadOkxMarketDataConfig(this.configPath)
    const root = resolveOkxWarehouseRoot(config)
    const pressure = await buildStoragePressureStatus({ warehouseRoot: root })
    if (!pressure.highFrequencyAllowed) {
      this.health.status = 'degraded_storage_pressure'
      this.pending = this.pending.filter(event => event.dataset === 'liquidation')
      if (this.pending.length === 0) return
    }
    const rows = this.pending.splice(0, this.pending.length)
    await appendOkxMarketEvents(root, rows)
  }

  private updateReadyState(): void {
    if (this.health.publicConnected && this.health.businessConnected && this.health.acknowledgedSubscriptions >= this.health.expectedSubscriptions) {
      this.health.status = 'ready'
      this.health.reconnectAttempts = 0
    }
  }

  private recordError(error: unknown): void {
    this.health.errors.push(error instanceof Error ? error.message : String(error))
    this.health.errors = this.health.errors.slice(-20)
    if (this.health.reconnectAttempts >= 10) this.health.status = 'degraded_stream_unavailable'
  }

  private async persistHealth(): Promise<void> {
    const config = await loadOkxMarketDataConfig(this.configPath)
    this.health.generatedAt = new Date().toISOString()
    await atomicWriteJson(join(resolveOkxWarehouseRoot(config), 'state', 'stream-health.latest.json'), this.health)
    await atomicWriteJson(resolve(config.dataRoot, 'runtime', 'okx_warehouse', 'okx_stream_health.latest.json'), this.health)
  }
}

async function readUniverse(root: string, fixed: string[]): Promise<OkxDepthUniverseManifest> {
  try { return JSON.parse(await readFile(join(root, 'state', 'depth-universe.latest.json'), 'utf-8')) as OkxDepthUniverseManifest }
  catch { return { schemaVersion: 'okx_depth_universe.v1', manifestId: 'fallback-fixed', generatedAt: new Date().toISOString(), effectiveAt: new Date().toISOString(), fixedDeepInstruments: [...fixed], dynamicInstruments: [], previousDynamicInstruments: [], added: [], removed: [], maxDailyChanges: 3, challengerImprovementPct: 10, mode: 'blocked_storage_budget', rankings: [] } }
}

function reconnectDelay(attempt: number): number { return [1_000, 2_000, 5_000, 10_000, 30_000, 60_000][Math.min(Math.max(0, attempt - 1), 5)] }
function epochIso(value: unknown): string | null { const numeric = Number(value); return Number.isFinite(numeric) && numeric > 0 ? new Date(numeric).toISOString() : null }
function finiteNumber(value: unknown): number | undefined { const numeric = Number(value); return Number.isFinite(numeric) ? numeric : undefined }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

const worker = new OkxStreamWorker()
let stopping = false
async function stop(): Promise<void> { if (stopping) return; stopping = true; await worker.stop(); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
worker.start().catch(error => { console.error(error); process.exitCode = 1 })
