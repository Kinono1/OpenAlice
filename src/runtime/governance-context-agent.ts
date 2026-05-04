/**
 * Governance Context Agent — LLM-powered macro orchestration.
 *
 * Runs offline / low-frequency (e.g. every 15 min or on regime shift).
 * Reads system diagnostics, factor IC decay, and macro context.
 * Outputs a Zod-validated JSON override injected into the ensemble as FactorWeightConditioning.
 *
 * The LLM is NEVER allowed to place orders. It only adjusts multipliers and thresholds
 * within pre-defined bounds. All outputs are validated before use.
 */

import { z } from 'zod'
import { createModelFromConfig, type ModelOverride } from '../ai-providers/vercel-ai-sdk/model-factory.js'
import type { FactorWeightConditioning } from '../domain/strategy/factors/types.js'
import { generateZodJsonObject } from './llm_json_generation.js'

// ── Output schema ──────────────────────────────────────────────────────────────

const GovernanceOverrideSchema = z.object({
  macroRegime: z.enum(['normal', 'vol-stress', 'bear-trend', 'risk-on', 'event-driven']),
  action: z.enum(['no_change', 'override_thresholds', 'reduce_exposure', 'increase_caution']),
  parameters: z.object({
    tripleBarrierMode: z.enum(['normal', 'wide', 'tight']).optional(),
    momentumWeightMultiplier: z.number().min(0).max(2).optional(),
    meanReversionWeightMultiplier: z.number().min(0).max(2).optional(),
    fundingWeightMultiplier: z.number().min(0).max(2).optional(),
    maxGrossExposurePct: z.number().min(0).max(100).optional(),
    volatilityTargetMultiplier: z.number().min(0.1).max(1.5).optional(),
  }),
  reasoning: z.string().max(500),
  confidenceScore: z.number().min(0).max(1),
})

export type GovernanceOverride = z.infer<typeof GovernanceOverrideSchema>

// ── Input types ────────────────────────────────────────────────────────────────

export interface GovernanceContextInput {
  /** Current regime label from HMM classifier */
  currentRegime: string
  /** Rolling IC values per factor (last 20 bars) */
  factorICByName: Record<string, number[]>
  /** Data quality state */
  dataQualityState: 'good' | 'degraded' | 'bad' | 'unknown'
  /** Recent drawdown (fraction, e.g. 0.05 = 5%) */
  recentDrawdown: number
  /** VPIN if available */
  vpin?: number
  /** Upcoming macro events in next 24h */
  upcomingMacroEvents?: string[]
  /** Any system alerts */
  systemAlerts?: string[]
}

// ── Prompt builder ─────────────────────────────────────────────────────────────

function buildPrompt(ctx: GovernanceContextInput): string {
  const icSummary = Object.entries(ctx.factorICByName)
    .map(([name, ics]) => {
      const recent = ics.slice(-5)
      const mean = recent.reduce((s, v) => s + v, 0) / (recent.length || 1)
      return `${name}: IC_mean=${mean.toFixed(3)}`
    })
    .join(', ')

  const events = ctx.upcomingMacroEvents?.join('; ') ?? 'none'
  const alerts = ctx.systemAlerts?.join('; ') ?? 'none'

  return `You are a quantitative risk governance advisor for a crypto systematic trading system.
Your role is to assess macro conditions and recommend parameter adjustments ONLY.
You CANNOT place orders. You CANNOT override risk limits. You can only adjust multipliers within [0, 2] and thresholds.

Current system state:
- HMM regime: ${ctx.currentRegime}
- Data quality: ${ctx.dataQualityState}
- Recent drawdown: ${(ctx.recentDrawdown * 100).toFixed(1)}%
- VPIN: ${ctx.vpin !== undefined ? ctx.vpin.toFixed(3) : 'unavailable'}
- Factor IC summary (last 5 bars): ${icSummary}
- Upcoming macro events (24h): ${events}
- System alerts: ${alerts}

Based on this context, output a governance override recommendation.
If conditions are normal, use action="no_change" with empty parameters.
Be conservative: only recommend changes when there is clear evidence of elevated risk.`
}

// ── Main function ──────────────────────────────────────────────────────────────

export interface GovernanceAgentResult {
  override: GovernanceOverride
  /** Translated into FactorWeightConditioning for direct injection into ensemble */
  conditioning: FactorWeightConditioning
}

/**
 * Run the governance context agent.
 * Returns null if the model call fails (caller should use last known override).
 */
export async function runGovernanceContextAgent(
  ctx: GovernanceContextInput,
  modelOverride?: ModelOverride,
): Promise<GovernanceAgentResult | null> {
  try {
    const { model, providerName } = await createModelFromConfig(modelOverride)
    const object = await generateZodJsonObject({
      model,
      schema: GovernanceOverrideSchema,
      prompt: buildPrompt(ctx),
      temperature: 0.1,
      modelOverride,
      providerName,
      jsonInstruction: `{
  "macroRegime": "normal" | "vol-stress" | "bear-trend" | "risk-on" | "event-driven",
  "action": "no_change" | "override_thresholds" | "reduce_exposure" | "increase_caution",
  "parameters": {
    "tripleBarrierMode"?: "normal" | "wide" | "tight",
    "momentumWeightMultiplier"?: number,
    "meanReversionWeightMultiplier"?: number,
    "fundingWeightMultiplier"?: number,
    "maxGrossExposurePct"?: number,
    "volatilityTargetMultiplier"?: number
  },
  "reasoning": string,
  "confidenceScore": number
}`,
    })

    const conditioning = overrideToConditioning(object)
    return { override: object, conditioning }
  } catch {
    return null
  }
}

/** Translate GovernanceOverride into FactorWeightConditioning for ensemble injection. */
function overrideToConditioning(override: GovernanceOverride): FactorWeightConditioning {
  if (override.action === 'no_change') {
    return { multiplierBySignal: {}, reasons: ['governance_no_change'] }
  }

  const m = override.parameters
  const multiplierBySignal: Record<string, number> = {}
  const reasons: string[] = [`governance_action:${override.action}`, `macro_regime:${override.macroRegime}`]

  if (m.momentumWeightMultiplier !== undefined) {
    multiplierBySignal['momentum-composite'] = m.momentumWeightMultiplier
    reasons.push(`momentum_mult=${m.momentumWeightMultiplier}`)
  }
  if (m.meanReversionWeightMultiplier !== undefined) {
    multiplierBySignal['mean-reversion'] = m.meanReversionWeightMultiplier
    reasons.push(`mean_rev_mult=${m.meanReversionWeightMultiplier}`)
  }
  if (m.fundingWeightMultiplier !== undefined) {
    multiplierBySignal['funding-rate'] = m.fundingWeightMultiplier
    multiplierBySignal['carry-spread'] = m.fundingWeightMultiplier
    reasons.push(`funding_mult=${m.fundingWeightMultiplier}`)
  }

  reasons.push(`reasoning:${override.reasoning.slice(0, 100)}`)

  return { multiplierBySignal, reasons }
}
