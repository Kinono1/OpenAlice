/**
 * Decision Ticket — requires explicit approval before trade execution.
 * Each ticket is bound to a single symbol and has a TTL.
 */

import { randomUUID } from 'node:crypto'

export interface DecisionTicketConfig {
  /** Whether tickets are required (default: true) */
  required: boolean
  /** Ticket TTL in ms (default: 600_000 = 10min) */
  ttlMs: number
}

export const DEFAULT_TICKET_CONFIG: DecisionTicketConfig = {
  required: true,
  ttlMs: 600_000,
}

export interface DecisionTicket {
  readonly ticketId: string
  readonly symbol: string
  readonly action: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly contextId?: string
  consumed: boolean
  consumedAt?: number
}

export interface TicketValidationResult {
  valid: boolean
  reason?: string
}

export class DecisionTicketStore {
  private tickets = new Map<string, DecisionTicket>()
  private config: DecisionTicketConfig
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(config?: Partial<DecisionTicketConfig>) {
    this.config = { ...DEFAULT_TICKET_CONFIG, ...config }
    this.cleanupTimer = setInterval(() => {
      const removed = this.cleanup()
      if (removed > 0) {
        console.warn(`[decision-ticket] Periodic cleanup removed ${removed} expired tickets (remaining: ${this.tickets.size})`)
      }
    }, 5 * 60 * 1000)
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  issue(params: { symbol: string; action: string; contextId?: string }): DecisionTicket {
    const now = Date.now()
    const ticket: DecisionTicket = {
      ticketId: randomUUID(),
      symbol: params.symbol,
      action: params.action,
      createdAt: now,
      expiresAt: now + this.config.ttlMs,
      contextId: params.contextId,
      consumed: false,
    }
    this.tickets.set(ticket.ticketId, ticket)
    return ticket
  }

  validate(ticketId: string, symbol: string, action: string): TicketValidationResult {
    if (!this.config.required) {
      return { valid: true, reason: 'tickets-not-required' }
    }

    const ticket = this.tickets.get(ticketId)
    if (!ticket) {
      return { valid: false, reason: `ticket ${ticketId} not found` }
    }
    if (ticket.consumed) {
      return { valid: false, reason: `ticket ${ticketId} already consumed at ${ticket.consumedAt}` }
    }
    if (Date.now() > ticket.expiresAt) {
      this.tickets.delete(ticketId)
      return { valid: false, reason: `ticket ${ticketId} expired` }
    }
    if (ticket.symbol !== symbol) {
      return { valid: false, reason: `ticket symbol mismatch: expected ${ticket.symbol}, got ${symbol}` }
    }
    if (ticket.action !== action) {
      return { valid: false, reason: `ticket action mismatch: expected ${ticket.action}, got ${action}` }
    }

    ticket.consumed = true
    ticket.consumedAt = Date.now()
    return { valid: true }
  }

  isRequired(): boolean {
    return this.config.required
  }

  cleanup(): number {
    const now = Date.now()
    let removed = 0
    for (const [id, ticket] of this.tickets) {
      if (now > ticket.expiresAt || ticket.consumed) {
        this.tickets.delete(id)
        removed++
      }
    }
    return removed
  }

  get(ticketId: string): DecisionTicket | undefined {
    return this.tickets.get(ticketId)
  }

  _resetForTest(): void {
    this.tickets.clear()
  }
}

