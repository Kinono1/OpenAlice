import { describe, expect, it, vi } from 'vitest'
import type { SSEClient } from './routes/chat.js'
import { broadcastSseClients } from './web-plugin.js'

describe('web-plugin', () => {
  it('removes stale SSE clients when broadcast send throws', () => {
    const clients = new Map<string, SSEClient>([
      [
        'healthy',
        {
          id: 'healthy',
          send: vi.fn(),
        },
      ],
      [
        'stale',
        {
          id: 'stale',
          send: () => {
            throw new Error('socket closed')
          },
        },
      ],
    ])

    const deliveredCount = broadcastSseClients(clients, '{"type":"message"}')

    expect(deliveredCount).toBe(1)
    expect(clients.has('healthy')).toBe(true)
    expect(clients.has('stale')).toBe(false)
  })
})
