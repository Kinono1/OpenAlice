import type { AssetLayer } from '../position-sizing/types.js'

export type TicketStatus =
  | 'candidate'
  | 'active'
  | 'replaced'
  | 'expired'
  | 'invalidated'
  | 'executed'
  | 'cancelled'

export interface ExecutionTicket {
  ticketId: string
  market: string
  venue: string
  instrument: string
  productType: 'SPOT' | 'SWAP'
  direction: 'BUY' | 'SELL'
  orderType: 'market' | 'limit'
  entryPrice: number
  size: number
  tp?: number
  sl?: number
  leverage?: number
  riskIfFilled: number
  generatedAt: number
  expiresAt?: number
  cancelIf?: string
  invalidateRule?: string
  priorityRank: number
  assetLayer: AssetLayer
  status: TicketStatus
  latestReferencePrice?: number
}

export interface TicketValidationResult {
  valid: boolean
  reasons: string[]
}
