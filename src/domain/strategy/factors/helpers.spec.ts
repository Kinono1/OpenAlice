import { describe, expect, it } from 'vitest'
import { safeDivide } from './helpers.js'

describe('safeDivide', () => {
  it('normal division works', () => {
    expect(safeDivide(4, 2, 0)).toBe(2)
    expect(safeDivide(1, 2, 999)).toBe(0.5)
    expect(safeDivide(0, 5, 0)).toBe(0)
  })

  it('zero denominator returns fallback', () => {
    expect(safeDivide(1, 0, 0)).toBe(0)
    expect(safeDivide(100, 0, 999)).toBe(999)
  })

  it('NaN numerator returns fallback', () => {
    expect(safeDivide(NaN, 1, 0)).toBe(0)
    expect(safeDivide(NaN, 1, -1)).toBe(-1)
  })

  it('NaN denominator returns fallback', () => {
    expect(safeDivide(1, NaN, 0)).toBe(0)
  })

  it('Infinity numerator returns fallback', () => {
    expect(safeDivide(Infinity, 1, 0)).toBe(0)
  })

  it('Infinity denominator returns fallback', () => {
    expect(safeDivide(1, Infinity, 0)).toBe(0)
    expect(safeDivide(1, -Infinity, 0)).toBe(0)
  })

  it('result is NaN (impossible normally) returns fallback', () => {
    expect(safeDivide(0, 0, 42)).toBe(42)
  })
})
