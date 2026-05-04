import { describe, expect, it } from 'vitest'
import { buildMcpToolRegistration } from './mcp.js'

describe('buildMcpToolRegistration', () => {
  it('falls back to the tool name when description is missing', () => {
    const tool = {
      inputSchema: {
        shape: {
          symbol: { type: 'string' },
        },
      },
    }

    expect(buildMcpToolRegistration('fetchPrice', tool)).toEqual({
      description: 'fetchPrice',
      inputSchema: {
        symbol: { type: 'string' },
      },
    })
  })

  it('preserves an explicit description', () => {
    const tool = {
      description: 'Fetch the current price',
      inputSchema: {},
    }

    expect(buildMcpToolRegistration('fetchPrice', tool)).toEqual({
      description: 'Fetch the current price',
      inputSchema: {},
    })
  })
})
