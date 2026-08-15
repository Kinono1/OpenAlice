import { describe, expect, it } from 'vitest'
import { OkxOrderBook } from './okx-orderbook.js'

describe('OkxOrderBook', () => {
  it('requires a snapshot before deltas', () => {
    const book = new OkxOrderBook()
    expect(book.apply({ action: 'update', asks: [], bids: [], seqId: 2, prevSeqId: 1 }).status).toBe('waiting_snapshot')
  })

  it('applies snapshot and delta while preserving sequence', () => {
    const book = new OkxOrderBook()
    expect(book.apply({ action: 'snapshot', asks: [['101', '1', '0', '1']], bids: [['99', '2', '0', '1']], seqId: 10 }).status).toBe('ready')
    expect(book.apply({ action: 'update', asks: [['101', '0', '0', '0'], ['102', '3', '0', '1']], bids: [['100', '4', '0', '1']], prevSeqId: 10, seqId: 11 }).status).toBe('ready')
    expect(book.snapshot()).toMatchObject({ sequenceId: 11, asks: [{ price: '102', size: '3' }], bids: [{ price: '100', size: '4' }, { price: '99', size: '2' }] })
  })

  it('fails closed and resets on sequence gap', () => {
    const book = new OkxOrderBook()
    book.apply({ action: 'snapshot', asks: [], bids: [], seqId: 10 })
    expect(book.apply({ action: 'update', asks: [], bids: [], prevSeqId: 9, seqId: 11 }).status).toBe('gap')
    expect(book.apply({ action: 'update', asks: [], bids: [], prevSeqId: 11, seqId: 12 }).status).toBe('waiting_snapshot')
  })

  it('fails closed on checksum mismatch', () => {
    const book = new OkxOrderBook()
    expect(book.apply({ action: 'snapshot', asks: [['101', '1', '0', '1']], bids: [['99', '1', '0', '1']], seqId: 1, checksum: 123 }).status).toBe('checksum_mismatch')
  })
})
