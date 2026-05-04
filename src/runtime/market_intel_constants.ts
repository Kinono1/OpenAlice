export const MARKET_INTEL_SCHEMA_VERSION = 1
export const POSITION_STATE_SCHEMA_VERSION = 1
export const SYSTEM_FUSE_SCHEMA_VERSION = 1
export const INFLIGHT_CALL_SCHEMA_VERSION = 1
export const PRO_RISK_POLICY_SCHEMA_VERSION = 1

export const MIN_FLASH_INTERVAL_MS = 45_000
export const FLASH_TIMEOUT_MS = 4_000
export const FLASH_MAX_RETRIES = 1
export const FLASH_MAX_FALLBACK_AGE_MS = 600_000
export const PRO_MAX_FALLBACK_AGE_MS = 14_400_000
export const COLD_START_ROUNDS = 3
export const MAX_CLOSE_TIMEOUT_MS = 300_000
export const MICROSTRUCTURE_MAX_1S_DATA_AGE_MS = 30_000
export const RECOMMENDATION_SUPPRESS_MS = 7 * 24 * 3_600_000
export const DEFAULT_RUNTIME_LOCK_STALE_MS = 5_000
export const SYSTEM_FUSE_HEARTBEAT_TIMEOUT_MS = 60_000

export const MARKET_INTEL_LANES = [
  'cross_sectional',
  'volume_breakout_1x',
  'volume_breakout_3x',
  'microstructure_10x',
  'microstructure_100x',
] as const

export type MarketIntelLane = typeof MARKET_INTEL_LANES[number]

export const DEFAULT_MARKET_INTEL_ALLOW_NEW_POSITIONS_BY_LANE: Record<MarketIntelLane, boolean> = {
  cross_sectional: true,
  volume_breakout_1x: true,
  volume_breakout_3x: true,
  microstructure_10x: false,
  microstructure_100x: false,
}

export const BLOCKED_MARKET_INTEL_ALLOW_NEW_POSITIONS_BY_LANE: Record<MarketIntelLane, boolean> = {
  cross_sectional: false,
  volume_breakout_1x: false,
  volume_breakout_3x: false,
  microstructure_10x: false,
  microstructure_100x: false,
}

export const DEFAULT_MARKET_INTEL_EXPOSURE_MULTIPLIER_BY_LANE: Record<MarketIntelLane, number> = {
  cross_sectional: 0.5,
  volume_breakout_1x: 0.75,
  volume_breakout_3x: 0.5,
  microstructure_10x: 0,
  microstructure_100x: 0,
}

export const ZERO_MARKET_INTEL_EXPOSURE_MULTIPLIER_BY_LANE: Record<MarketIntelLane, number> = {
  cross_sectional: 0,
  volume_breakout_1x: 0,
  volume_breakout_3x: 0,
  microstructure_10x: 0,
  microstructure_100x: 0,
}

export const RULE_THRESHOLD_FLOOR_BY_LANE = {
  volume_breakout_1x: 0.20,
  volume_breakout_3x: 0.25,
  microstructure_10x: 0.40,
  microstructure_100x: 0.55,
} as const

export const FLASH_CONFIDENCE_THRESHOLD_BY_LANE = {
  microstructure_10x: 0.70,
  microstructure_100x: 0.75,
} as const

export const DEFAULT_MARKET_INTEL_CONTEXT_PATH = 'data/runtime/market_intel_context.latest.json'
export const DEFAULT_SYSTEM_FUSE_PATH = 'data/runtime/system_fuse.latest.json'
export const DEFAULT_SYSTEM_FUSE_EVENTS_PATH = 'data/runtime/system_fuse.events.jsonl'
export const DEFAULT_INFLIGHT_CALL_PATH = 'data/runtime/inflight_call.json'
export const DEFAULT_PRO_RISK_POLICY_PATH = 'data/runtime/pro_risk_policy.latest.json'
export const DEFAULT_MICROSTRUCTURE_POSITION_STATE_PATH =
  'data/runtime/paper_microstructure_position_state.json'
export const DEFAULT_PAPER_TRADE_RESULT_PATH = 'data/paper_trading/paper_trade_result.jsonl'
export const DEFAULT_RECOMMENDATION_AUDIT_PATH = 'data/runtime/recommendation_audit.jsonl'
export const DEFAULT_OPENALICE_HEARTBEAT_PATH = '/tmp/openalice_heartbeat.json'
