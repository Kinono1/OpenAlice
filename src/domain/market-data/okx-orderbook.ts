export interface OkxBookLevel { price: string; size: string; liquidatedOrders: string; orderCount: string }
export interface OkxBookUpdate { action: 'snapshot' | 'update'; asks: string[][]; bids: string[][]; checksum?: number; seqId?: number; prevSeqId?: number; ts?: string }

export interface OkxBookApplyResult {
  status: 'ready' | 'gap' | 'checksum_mismatch' | 'waiting_snapshot'
  sequenceId: number | null
  checksum: number | null
  expectedChecksum: number | null
}

export class OkxOrderBook {
  private readonly asks = new Map<string, OkxBookLevel>()
  private readonly bids = new Map<string, OkxBookLevel>()
  private lastSeqId: number | null = null
  private ready = false

  reset(): void {
    this.asks.clear()
    this.bids.clear()
    this.lastSeqId = null
    this.ready = false
  }

  apply(update: OkxBookUpdate): OkxBookApplyResult {
    if (update.action === 'snapshot') {
      this.reset()
      applyLevels(this.asks, update.asks)
      applyLevels(this.bids, update.bids)
      this.lastSeqId = finiteInt(update.seqId)
      this.ready = true
    } else {
      if (!this.ready) return { status: 'waiting_snapshot', sequenceId: this.lastSeqId, checksum: update.checksum ?? null, expectedChecksum: null }
      const previous = finiteInt(update.prevSeqId)
      if (previous != null && this.lastSeqId != null && previous !== this.lastSeqId) {
        this.reset()
        return { status: 'gap', sequenceId: finiteInt(update.seqId), checksum: update.checksum ?? null, expectedChecksum: null }
      }
      applyLevels(this.asks, update.asks)
      applyLevels(this.bids, update.bids)
      this.lastSeqId = finiteInt(update.seqId) ?? this.lastSeqId
    }
    const expectedChecksum = this.checksum()
    if (typeof update.checksum === 'number' && update.checksum !== expectedChecksum) {
      const sequenceId = this.lastSeqId
      this.reset()
      return { status: 'checksum_mismatch', sequenceId, checksum: update.checksum, expectedChecksum }
    }
    return { status: 'ready', sequenceId: this.lastSeqId, checksum: update.checksum ?? null, expectedChecksum }
  }

  snapshot(depth = 50): { asks: OkxBookLevel[]; bids: OkxBookLevel[]; sequenceId: number | null; checksum: number } {
    return {
      asks: sortLevels(this.asks, 'asc').slice(0, depth),
      bids: sortLevels(this.bids, 'desc').slice(0, depth),
      sequenceId: this.lastSeqId,
      checksum: this.checksum(),
    }
  }

  private checksum(): number {
    const asks = sortLevels(this.asks, 'asc').slice(0, 25)
    const bids = sortLevels(this.bids, 'desc').slice(0, 25)
    const values: string[] = []
    const count = Math.max(asks.length, bids.length)
    for (let index = 0; index < count; index += 1) {
      const bid = bids[index]
      const ask = asks[index]
      if (bid) values.push(bid.price, bid.size)
      if (ask) values.push(ask.price, ask.size)
    }
    return crc32Signed(values.join(':'))
  }
}

function applyLevels(target: Map<string, OkxBookLevel>, rows: string[][]): void {
  for (const row of rows) {
    const [price, size, liquidatedOrders = '0', orderCount = '0'] = row
    if (!price) continue
    if (!size || Number(size) === 0) target.delete(price)
    else target.set(price, { price, size, liquidatedOrders, orderCount })
  }
}

function sortLevels(map: Map<string, OkxBookLevel>, direction: 'asc' | 'desc'): OkxBookLevel[] {
  return [...map.values()].sort((left, right) => direction === 'asc' ? Number(left.price) - Number(right.price) : Number(right.price) - Number(left.price))
}

function finiteInt(value: unknown): number | null { const number = Number(value); return Number.isInteger(number) ? number : null }

export function crc32Signed(input: string): number {
  let crc = -1
  for (let index = 0; index < input.length; index += 1) {
    crc ^= input.charCodeAt(index)
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ -1) | 0
}
