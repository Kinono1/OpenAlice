/**
 * MCP Ask no-op connector.
 *
 * MCP is a pull-based protocol — external clients call tools to interact
 * with Alice. There is no push channel, so send() always returns
 * delivered: false. Registered with ConnectorCenter so the system knows
 * this channel exists but cannot receive proactive notifications.
 */

import type { Connector, ConnectorCapabilities, SendPayload, SendResult } from '../types.js'

export class McpAskConnector implements Connector {
  readonly channel = 'mcp-ask'
  readonly to = 'default'
  readonly capabilities: ConnectorCapabilities = { push: false, media: false }

  async send(_payload: SendPayload): Promise<SendResult> {
    // MCP is pull-based; outbound send is a no-op.
    return { delivered: false }
  }
}
