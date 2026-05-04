import { describe, expect, it } from 'vitest'
import { generateTraceId } from './trace.js'

describe('generateTraceId', () => {
  it('emits the OpenAlice trace id format', () => {
    expect(generateTraceId()).toMatch(/^oa_\d{8}T\d{6}Z_[0-9a-f]{8}$/)
  })
})
