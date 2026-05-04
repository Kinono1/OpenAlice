import { describe, expect, it } from 'vitest'
import { percent, decimal, bps, pctToDecimal, decimalToPct, bpsToDecimal } from './units.js'

describe('units — branded types', () => {
  describe('percent', () => {
    it('constructs valid percent', () => {
      expect(percent(0.28) as number).toBe(0.28)
      expect(percent(100) as number).toBe(100)
    })

    it('rejects non-finite', () => {
      expect(() => percent(NaN)).toThrow()
      expect(() => percent(Infinity)).toThrow()
    })

    it('rejects out-of-range (likely decimal)', () => {
      expect(() => percent(20000)).toThrow(RangeError)
      expect(() => percent(-15000)).toThrow(RangeError)
    })
  })

  describe('decimal', () => {
    it('constructs valid decimal', () => {
      expect(decimal(0.0028) as number).toBe(0.0028)
      expect(decimal(1.0) as number).toBe(1.0)
    })

    it('rejects non-finite', () => {
      expect(() => decimal(NaN)).toThrow()
    })

    it('rejects out-of-range (likely percent)', () => {
      expect(() => decimal(150)).toThrow(RangeError)
      expect(() => decimal(-200)).toThrow(RangeError)
    })
  })

  describe('bps', () => {
    it('constructs valid bps', () => {
      expect(bps(28) as number).toBe(28)
      expect(bps(0) as number).toBe(0)
    })

    it('rejects non-finite', () => {
      expect(() => bps(NaN)).toThrow()
    })
  })

  describe('conversions', () => {
    it('pctToDecimal', () => {
      expect(pctToDecimal(percent(0.28)) as number).toBeCloseTo(0.0028)
    })

    it('decimalToPct', () => {
      expect(decimalToPct(decimal(0.0028)) as number).toBeCloseTo(0.28)
    })

    it('bpsToDecimal', () => {
      expect(bpsToDecimal(bps(8)) as number).toBeCloseTo(0.0008)
    })
  })
})
