import type { ExecutionTicket, TicketValidationResult } from './types.js'

function maxAllowedDrift(ticket: ExecutionTicket): number {
  return ticket.productType === 'SWAP' ? 0.01 : 0.015
}

export function validateExecutionTicket(
  ticket: ExecutionTicket,
  activeTickets: ExecutionTicket[] = [],
): TicketValidationResult {
  const reasons: string[] = []

  if (ticket.status === 'active' && typeof ticket.expiresAt !== 'number') {
    reasons.push('active ticket requires expiresAt')
  }

  if (ticket.productType === 'SWAP' && ticket.status === 'active' && typeof ticket.sl !== 'number') {
    reasons.push('active leveraged swap ticket requires stop-loss')
  }

  if (ticket.status === 'active' && !ticket.cancelIf) {
    reasons.push('active ticket requires cancelIf')
  }

  if (ticket.status === 'active' && !ticket.invalidateRule) {
    reasons.push('active ticket requires invalidateRule')
  }

  const duplicateActive = activeTickets.find((other) =>
    other.ticketId !== ticket.ticketId &&
    other.status === 'active' &&
    other.market === ticket.market &&
    other.instrument === ticket.instrument &&
    other.direction === ticket.direction,
  )
  if (duplicateActive) {
    reasons.push(`duplicate active ticket already exists: ${duplicateActive.ticketId}`)
  }

  if (
    ticket.status === 'active' &&
    typeof ticket.latestReferencePrice === 'number' &&
    ticket.entryPrice > 0
  ) {
    const drift = Math.abs(ticket.latestReferencePrice - ticket.entryPrice) / ticket.entryPrice
    if (drift > maxAllowedDrift(ticket)) {
      reasons.push(`price drift ${drift.toFixed(4)} exceeds ${maxAllowedDrift(ticket).toFixed(4)}`)
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
  }
}
