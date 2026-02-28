import type { KlineStore } from '../extension/analysis-kit/index.js'
import type { NewsStore } from '../extension/analysis-kit/index.js'
import type { ICryptoTradingEngine } from '../extension/crypto-trading/index.js'
import type { CronEngine } from '../task/cron/engine.js'
import type { Heartbeat } from '../task/heartbeat/index.js'
import type { Config } from './config.js'
import type { Engine } from './engine.js'
import type { EventLog } from './event-log.js'
import type { DecisionTicketStore } from '../extension/crypto-trading/decision-ticket.js'
import type { IntentLedger } from '../extension/crypto-trading/intent-ledger.js'
import type { KillSwitch } from '../extension/crypto-trading/kill-switch.js'
import type { PnLTracker } from '../extension/crypto-trading/pnl-tracker.js'

export type { Config }

export interface Plugin {
  name: string
  start(ctx: EngineContext): Promise<void>
  stop(): Promise<void>
}

export interface EngineContext {
  config: Config
  klineStore: KlineStore
  newsStore: NewsStore
  cryptoEngine: ICryptoTradingEngine | null
  engine: Engine
  eventLog: EventLog
  heartbeat: Heartbeat
  cronEngine: CronEngine
  /** Whether the system is shutting down (middleware returns 503). */
  stopped: boolean
  /** Decision ticket store for trade approval. */
  ticketStore?: DecisionTicketStore
  /** Intent ledger for trade audit trail. */
  intentLedger?: IntentLedger
  /** Per-symbol kill switch. */
  killSwitch?: KillSwitch
  /** Dual-track PnL tracker (AvgCost authoritative, FIFO audit). */
  pnlTracker?: PnLTracker
}

/** A media attachment collected from tool results (e.g. browser screenshots). */
export interface MediaAttachment {
  type: 'image'
  /** Absolute path to the file on disk. */
  path: string
}
