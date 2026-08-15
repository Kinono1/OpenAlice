/**
 * Paper-to-Runtime Config Feedback — v1 (proposal-only).
 *
 * Analyzes paper trade results and IC monitor snapshots to generate
 * factor weight adjustment proposals. Proposals are written to disk
 * as pending artifacts that require human review and explicit approval
 * to take effect.
 *
 * v1 scope: only generates proposals. DOES NOT apply any changes to
 * strategy config. applyConfigProposal() is a stub that throws.
 *
 * v2 (future): add applyConfigProposal() with:
 *   readStrategyConfig() → deep clone → white-list path apply
 *   → schema parse → writeConfigSection('strategy', fullConfig)
 */

import fs from 'node:fs'
import path from 'node:path'
import type { IcMonitorSnapshot } from '../domain/strategy/factors/index.js'

// ── Proposal Types ────────────────────────────────────────────────────

export type ConfigProposalType = 'factor_weight_adjust' | 'position_sizing_change'
export type ConfigProposalStatus = 'pending' | 'approved' | 'applied' | 'rejected'

export interface ConfigProposal {
  /** Unique identifier (UUID or timestamp-based). */
  id: string
  proposalType: ConfigProposalType
  /** Human-readable description of the proposed change. */
  description: string
  /** Config path in dot notation (e.g. 'factors.momentumComposite.weight'). */
  configPath: string
  /** Factor signal name (hyphen-case, e.g. 'momentum-composite'). */
  signalName: string
  /** Current value from the strategy config. */
  currentValue: number
  /** Proposed new value. */
  proposedValue: number
  /** Evidence references (paper trade IDs, evidence ledger IDs). */
  evidence: string[]
  /** Confidence score 0–1. */
  confidence: number
  status: ConfigProposalStatus
  createdAt: string
}

// ── Factor Signal ↔ Config Path Mapping ───────────────────────────────

/**
 * Maps kebab-case factor signal names (used in FactorSignal.name)
 * to the camelCase config path suffix (used in strategy.json).
 */
export const FACTOR_SIGNAL_TO_CONFIG: Record<string, string> = {
  'momentum-composite': 'momentumComposite',
  'mean-reversion': 'meanReversion',
  'volume-surge': 'volumeSurge',
  'liquidation-pressure': 'liquidationPressure',
  'funding-rate': 'fundingRate',
  basis: 'basis',
  'carry-spread': 'carrySpread',
  'volatility-regime': 'volatilityRegime',
  'liquidation-aftermath': 'liquidationAftermath',
  'cross-timeframe-divergence': 'crossTimeframeDivergence',
  'order-book-imbalance': 'orderBookImbalance',
  'stablecoin-flow': 'stablecoinFlow',
}

// ── Config Proposal Path ───────────────────────────────────────────────

function proposalPath(): string {
  return process.env.OPENALICE_DATA_DIR
    ? path.join(process.env.OPENALICE_DATA_DIR, 'runtime', 'config_proposals.latest.json')
    : path.join('data', 'runtime', 'config_proposals.latest.json')
}

// ── Analysis Heuristics ───────────────────────────────────────────────

export interface FactorIcMetrics {
  /** Factor signal name (hyphen-case). */
  factorName: string
  /** Current weight in strategy config. */
  currentWeight: number
  /** Information Coefficient Sharpe, if available. */
  icSharpe: number | null
  /** Whether IC has decayed to a warning level. */
  icDecayed: boolean
}

export interface AnalysisInput {
  factorMetrics: FactorIcMetrics[]
}

export interface AnalysisResult {
  proposals: ConfigProposal[]
  skipped: Array<{ reason: string }>
}

/**
 * Analyze factor metrics and generate config proposals.
 *
 * Heuristics (v1):
 * 1. IC decayed → propose reduce weight by 20%
 * 2. No factor attribution available → skip, record insufficient_factor_attribution
 */
export function analyzePaperResultsForConfigProposals(input: AnalysisInput): AnalysisResult {
  const proposals: ConfigProposal[] = []
  const skipped: Array<{ reason: string }> = []

  for (const factor of input.factorMetrics) {
    const configKey = FACTOR_SIGNAL_TO_CONFIG[factor.factorName]

    if (!configKey) {
      skipped.push({
        reason: `unknown factor "${factor.factorName}": no config key mapping`,
      })
      continue
    }

    // Heuristic #1: IC decayed → reduce weight
    if (factor.icDecayed && factor.icSharpe !== null && factor.icSharpe < 0) {
      const newWeight = roundTo2(factor.currentWeight * 0.8)
      if (newWeight >= 0.01) {
        proposals.push({
          id: `proposal_${Date.now()}_${factor.factorName}_ic_decay`,
          proposalType: 'factor_weight_adjust',
          description: `Reduce ${factor.factorName} weight from ${factor.currentWeight} to ${newWeight} due to IC decay (IC Sharpe: ${factor.icSharpe.toFixed(3)})`,
          configPath: `factors.${configKey}.weight`,
          signalName: factor.factorName,
          currentValue: factor.currentWeight,
          proposedValue: newWeight,
          evidence: ['ic-monitor: decay detection'],
          confidence: clamp01(Math.abs(Math.min(factor.icSharpe, 0))),
          status: 'pending',
          createdAt: new Date().toISOString(),
        })
      }
    }

    // Heuristic #3 (future): IC stable and high → propose increase weight
    // Heuristic #2 (future): PnL attribution — only if factor-level attribution exists
    //   Currently paper_evidence_ledger.jsonl does not have structured factor attribution.
    //   When it does, add: if factor_pnl < 0 AND icDecayed → stronger reduction signal
  }

  if (proposals.length === 0 && input.factorMetrics.length > 0) {
    skipped.push({
      reason: 'insufficient_factor_attribution: no structured factor-level PnL attribution available in paper results',
    })
  }

  return { proposals, skipped }
}

// ── Persistence ───────────────────────────────────────────────────────

/** Read pending config proposals from disk. Returns empty array if no file. */
export function readConfigProposals(): ConfigProposal[] {
  try {
    const raw = fs.readFileSync(proposalPath(), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return []
  }
}

/** Write config proposals to disk (overwrites). */
export function writeConfigProposals(proposals: ConfigProposal[]): void {
  const outputPath = proposalPath()
  const dir = path.dirname(outputPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = outputPath + '.tmp.' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(proposals, null, 2), 'utf-8')
  fs.renameSync(tmp, outputPath)
}

// ── Apply (stub for v1) ───────────────────────────────────────────────

/**
 * Apply a config proposal to strategy.json.
 *
 * v1: NOT IMPLEMENTED. This throws to prevent accidental use before the
 * full readStrategyConfig → deep clone → white-list apply → schema parse
 * → writeConfigSection cycle is implemented.
 *
 * v2 implementation sketch:
 *   const current = await readStrategyConfig()
 *   const cloned = structuredClone(current)
 *   // traverse configPath on cloned and set proposedValue
 *   // strategySchema.parse(cloned)  ← Zod validation
 *   // writeConfigSection('strategy', cloned)
 */
export function applyConfigProposal(_proposalId: string): void {
  throw new Error(
    'applyConfigProposal is not implemented in v1. ' +
    'This function requires: readStrategyConfig → deep clone → ' +
    'white-list path apply → Zod schema parse → writeConfigSection. ' +
    'Use readConfigProposals() to review pending proposals manually.',
  )
}

// ── Utilities ─────────────────────────────────────────────────────────

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}
