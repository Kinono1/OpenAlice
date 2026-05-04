import { describe, expect, it } from 'vitest'
import { safePathComponent } from './path-safety.js'

describe('safePathComponent', () => {
  it('accepts common ASCII path components', () => {
    expect(safePathComponent('BTC-USDT')).toBe('BTC-USDT')
    expect(safePathComponent('ETH_USD')).toBe('ETH_USD')
    expect(safePathComponent('BRK.B')).toBe('BRK.B')
    expect(safePathComponent('abc123._-XYZ')).toBe('abc123._-XYZ')
  })

  it('allows caret only when explicitly enabled', () => {
    expect(safePathComponent('^GSPC', { kind: 'symbol', allowCaret: true })).toBe('^GSPC')
    expect(() => safePathComponent('^GSPC', { kind: 'symbol' })).toThrow(/symbol path component/)
  })

  it('rejects traversal and separator inputs', () => {
    expect(() => safePathComponent('../x')).toThrow(/path component/)
    expect(() => safePathComponent('a/b')).toThrow(/path separators/)
    expect(() => safePathComponent('a\\b')).toThrow(/path separators/)
    expect(() => safePathComponent('a%2fb')).toThrow(/path component/)
  })

  it('rejects empty and all-dot inputs', () => {
    expect(() => safePathComponent('')).toThrow(/must not be empty/)
    expect(() => safePathComponent('.')).toThrow(/only of dots/)
    expect(() => safePathComponent('..')).toThrow(/only of dots/)
    expect(() => safePathComponent('...')).toThrow(/only of dots/)
  })

  it('rejects leading and trailing whitespace without trimming', () => {
    expect(() => safePathComponent(' BTC-USDT')).toThrow(/whitespace/)
    expect(() => safePathComponent('BTC-USDT ')).toThrow(/whitespace/)
    expect(() => safePathComponent(' BTC-USDT ')).toThrow(/whitespace/)
  })

  it('rejects control characters and non-ASCII characters', () => {
    expect(() => safePathComponent('BTC\nUSDT')).toThrow(/control characters/)
    expect(() => safePathComponent('BTC\u0000USDT')).toThrow(/control characters/)
    expect(() => safePathComponent('比特币')).toThrow(/ASCII/)
    expect(() => safePathComponent('BTC USDT')).toThrow(/ASCII/)
  })

  it('rejects Windows reserved device names even with extensions', () => {
    for (const value of [
      'CON',
      'CON.txt',
      'PRN',
      'AUX',
      'NUL',
      'NUL.json',
      'COM1',
      'COM9.log',
      'LPT1',
      'LPT9.csv',
    ]) {
      expect(() => safePathComponent(value, { kind: 'artifact' })).toThrow(
        /artifact path component/,
      )
    }
  })

  it('enforces default and explicit max lengths', () => {
    expect(safePathComponent('a'.repeat(128))).toBe('a'.repeat(128))
    expect(() => safePathComponent('a'.repeat(129))).toThrow(/maximum length 128/)
    expect(safePathComponent('a'.repeat(64), { maxLength: 64 })).toBe('a'.repeat(64))
    expect(() => safePathComponent('a'.repeat(65), { maxLength: 64 })).toThrow(
      /maximum length 64/,
    )
  })

  it('rejects invalid maxLength options', () => {
    expect(() => safePathComponent('BTC-USDT', { maxLength: 0 })).toThrow(/maxLength/)
    expect(() => safePathComponent('BTC-USDT', { maxLength: 1.5 })).toThrow(/maxLength/)
  })
})
