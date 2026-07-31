export type BlockReasonComponent =
  | 'kill_switch' | 'market_intel' | 'data_quality' | 'data_freshness'
  | 'sidecar_producer' | 'sidecar_envelope' | 'promotion_v2'
  | 'news_gate' | 'system_fuse' | 'replay_gate' | 'shortfall_gate'
  | 'config' | 'execution' | 'runtime_lock'

export type BlockSeverity = 'hard' | 'soft' | 'informational'

export interface TypedBlockReason {
  component: BlockReasonComponent
  severity: BlockSeverity
  code: string
  detail: string
}

const PREFIX_MAP: Record<string, { component: BlockReasonComponent; severity: BlockSeverity }> = {
  'kill_switch:':                 { component: 'kill_switch',     severity: 'hard' },
  'market_intel_risk_off':        { component: 'market_intel',    severity: 'hard' },
  'market_intel_severe_news':     { component: 'market_intel',    severity: 'hard' },
  'market_intel_context_stale':   { component: 'market_intel',    severity: 'hard' },
  'market_intel_cold_start:':     { component: 'market_intel',    severity: 'soft' },
  'market_intel_symbol_blocks:':  { component: 'market_intel',    severity: 'soft' },
  'sidecar_producer_blocked:':    { component: 'sidecar_producer', severity: 'soft' },
  'market_data_':                 { component: 'data_freshness',  severity: 'hard' },
  'data_quality_':                { component: 'data_quality',    severity: 'hard' },
  'system_fuse:':                 { component: 'system_fuse',     severity: 'hard' },
  'promotion_v2_':                { component: 'promotion_v2',    severity: 'hard' },
  'news_hard_veto':               { component: 'news_gate',       severity: 'hard' },
  'missing_best_config':          { component: 'config',          severity: 'hard' },
  'insufficient_live_universe:':  { component: 'execution',       severity: 'hard' },
  'insufficient_assets:':         { component: 'execution',       severity: 'hard' },
  'no_tradeable_signal':          { component: 'execution',       severity: 'soft' },
}

export function parseBlockReason(raw: string): TypedBlockReason {
  for (const [prefix, mapping] of Object.entries(PREFIX_MAP)) {
    if (raw.startsWith(prefix)) {
      return { ...mapping, code: prefix.replace(/:$/, ''), detail: raw.slice(prefix.length) }
    }
  }
  return { component: 'execution', severity: 'informational', code: 'unknown', detail: raw }
}

export function formatBlockReason(component: BlockReasonComponent, code: string, detail?: string): string {
  return detail ? `${component}:${code}:${detail}` : `${component}:${code}`
}
