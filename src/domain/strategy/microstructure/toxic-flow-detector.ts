import type { OFIResult, VPINResult, ToxicFlowAlert } from './types.js'

export interface ToxicFlowConfig {
  /** OFI normalized threshold for warning (default -0.6 = heavy sell pressure) */
  ofiWarningThreshold?: number
  /** OFI normalized threshold for critical */
  ofiCriticalThreshold?: number
  /** VPIN threshold for warning (default 0.65) */
  vpinWarningThreshold?: number
  /** VPIN threshold for critical (default 0.80) */
  vpinCriticalThreshold?: number
  /** Require both OFI and VPIN to trigger (default true = AND logic) */
  requireBoth?: boolean
}

const DEFAULT: Required<ToxicFlowConfig> = {
  ofiWarningThreshold: -0.60,
  ofiCriticalThreshold: -0.80,
  vpinWarningThreshold: 0.65,
  vpinCriticalThreshold: 0.80,
  requireBoth: true,
}

/**
 * Detect toxic order flow / pre-crisis conditions.
 *
 * Triggers when:
 *   - Multi-level OFI is deeply negative (massive bid withdrawal / ask pressure)
 *   - AND VPIN is elevated (high probability of informed trading)
 *
 * On critical alert: caller should invoke cancel-only mode and widen maker spreads.
 */
export function detectToxicFlow(
  ofi: OFIResult,
  vpin: VPINResult | null,
  config: ToxicFlowConfig = {},
): ToxicFlowAlert {
  const cfg = { ...DEFAULT, ...config }
  const timestamp = ofi.timestamp

  const ofiNeg = ofi.normalizedOfi < cfg.ofiCriticalThreshold
  const ofiWarn = ofi.normalizedOfi < cfg.ofiWarningThreshold
  const vpinCrit = vpin !== null && vpin.vpin >= cfg.vpinCriticalThreshold
  const vpinWarn = vpin !== null && vpin.vpin >= cfg.vpinWarningThreshold

  const reasons: string[] = []
  if (ofiWarn) reasons.push(`OFI=${ofi.normalizedOfi.toFixed(3)}`)
  if (vpin && vpinWarn) reasons.push(`VPIN=${vpin.vpin.toFixed(3)}`)

  const criticalCondition = cfg.requireBoth
    ? ofiNeg && vpinCrit
    : ofiNeg || vpinCrit

  const warningCondition = cfg.requireBoth
    ? ofiWarn && vpinWarn
    : ofiWarn || vpinWarn

  if (criticalCondition) {
    return {
      isAlert: true,
      severity: 'critical',
      ofi: ofi.normalizedOfi,
      vpin: vpin?.vpin ?? 0,
      reason: `toxic_flow_critical: ${reasons.join(', ')}`,
      timestamp,
    }
  }

  if (warningCondition) {
    return {
      isAlert: true,
      severity: 'warning',
      ofi: ofi.normalizedOfi,
      vpin: vpin?.vpin ?? 0,
      reason: `toxic_flow_warning: ${reasons.join(', ')}`,
      timestamp,
    }
  }

  return {
    isAlert: false,
    severity: 'none',
    ofi: ofi.normalizedOfi,
    vpin: vpin?.vpin ?? 0,
    reason: 'no_toxic_flow',
    timestamp,
  }
}
