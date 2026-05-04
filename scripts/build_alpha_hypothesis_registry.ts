import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import type { EvidenceManifest } from '../src/runtime/evidence_manifest.js'

export interface AlphaHypothesisRegistryArgs {
  candidateRegistryPath: string
  outputPath: string | null
  json: boolean
}

export interface AlphaFalsificationRule {
  condition: string
  action: 'kill_candidate' | 'retire_family' | 'research_only'
}

export interface AlphaHypothesisEntry {
  policyId: string
  familyId: string
  strategyIds: string[]
  researchOnly: true
  promotionEligible: false
  policyMutationAllowed: false
  alphaHypothesis: string
  marketInefficiency: string
  whoPays: string
  expectedHoldingHorizon: string
  expectedFailureRegime: string[]
  requiredObservables: string[]
  falsificationRule: AlphaFalsificationRule
  killCriteria: string[]
  notes: string[]
}

export interface AlphaCandidateCoverageItem {
  candidateId: string
  strategyId: string
  status: string
  covered: boolean
  matchedPolicyIds: string[]
  missingReason: string | null
}

export interface AlphaHypothesisRegistryReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  promotionEligible: false
  policyMutationAllowed: false
  promotionAllowedByThisArtifact: false
  candidateRegistryPath: string
  candidateRegistryManifestPath: string | null
  candidateRegistryHash: string | null
  candidateRegistryManifest: {
    present: boolean
    artifactHash: string | null
    hashMatchesCandidateRegistry: boolean | null
    evidenceTrust: EvidenceManifest['evidenceTrust'] | null
    dqStatus: EvidenceManifest['dqStatus'] | null
    businessStatus: EvidenceManifest['businessStatus'] | null
  }
  entries: AlphaHypothesisEntry[]
  coverage: {
    candidateRegistryPresent: boolean
    candidateCount: number
    activeCandidates: number
    coveredActiveCandidates: number
    uncoveredActiveCandidates: number
    coverageStatus: 'pass' | 'blocked_missing_hypothesis' | 'candidate_registry_missing'
    uncoveredStrategyIds: string[]
    candidates: AlphaCandidateCoverageItem[]
  }
  governance: {
    requiredBeforeP1Review: boolean
    requiredBeforePromotion: boolean
    promotionBlockedByThisArtifact: boolean
    blockingReasons: string[]
    requiredActions: string[]
  }
  notes: string[]
}

interface CandidateRegistryLike {
  candidateCount?: number
  entries?: Array<{
    candidateId?: string
    strategyId?: string
    status?: string
  }>
}

const DEFAULT_CANDIDATE_REGISTRY_PATH = 'data/runtime/candidate_registry.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/runtime/alpha_hypothesis_registry.latest.json'

export function parseAlphaHypothesisRegistryArgs(argv: string[]): AlphaHypothesisRegistryArgs {
  const raw = parseRawArgs(argv)
  return {
    candidateRegistryPath: raw.get('candidateRegistryPath') ?? raw.get('candidateRegistry') ?? DEFAULT_CANDIDATE_REGISTRY_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runAlphaHypothesisRegistry(
  args: AlphaHypothesisRegistryArgs,
): Promise<AlphaHypothesisRegistryReport> {
  const startedAt = new Date()
  const candidateRegistryPath = resolve(args.candidateRegistryPath)
  const candidateRegistryRaw = existsSync(candidateRegistryPath)
    ? await readFile(candidateRegistryPath, 'utf-8')
    : null
  const candidateRegistry = candidateRegistryRaw
    ? JSON.parse(candidateRegistryRaw) as CandidateRegistryLike
    : null
  const candidateManifestPath = `${candidateRegistryPath}.manifest.json`
  const candidateManifest = readSourceManifest(candidateManifestPath)
  const report = buildAlphaHypothesisRegistryReport({
    candidateRegistry,
    candidateRegistryPath,
    candidateRegistryRaw,
    candidateRegistryManifestPath: existsSync(candidateManifestPath) ? candidateManifestPath : null,
    candidateRegistryManifest: candidateManifest,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'alpha_hypothesis_registry',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.coverage.coverageStatus === 'pass' ? 'pass' : 'warn',
      recordsIn: report.coverage.candidateCount,
      recordsOut: report.entries.length,
      errorClass: report.coverage.coverageStatus === 'pass' ? null : report.coverage.coverageStatus,
    })
  }

  return report
}

export function buildAlphaHypothesisRegistryReport(input: {
  candidateRegistry?: CandidateRegistryLike | null
  candidateRegistryPath: string
  candidateRegistryRaw?: string | null
  candidateRegistryManifestPath?: string | null
  candidateRegistryManifest?: EvidenceManifest | null
  generatedAt?: string
  entries?: AlphaHypothesisEntry[]
}): AlphaHypothesisRegistryReport {
  const entries = input.entries ?? defaultAlphaHypotheses()
  const candidateRegistryHash = input.candidateRegistryRaw == null ? null : sha256Hex(input.candidateRegistryRaw)
  const candidateManifest = input.candidateRegistryManifest ?? null
  const candidates = normalizeCandidateRegistryEntries(input.candidateRegistry)
  const coverageItems = candidates.map(candidate => buildCandidateCoverage(candidate, entries))
  const activeCoverageItems = coverageItems.filter(item => item.status === 'active')
  const uncoveredActive = activeCoverageItems.filter(item => !item.covered)
  const coverageStatus = input.candidateRegistry == null
    ? 'candidate_registry_missing'
    : uncoveredActive.length > 0
      ? 'blocked_missing_hypothesis'
      : 'pass'
  const blockingReasons = [
    ...(coverageStatus === 'candidate_registry_missing' ? ['candidate_registry_missing'] : []),
    ...uncoveredActive.map(item => `missing_alpha_hypothesis:${item.strategyId}`),
  ]

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    promotionEligible: false,
    policyMutationAllowed: false,
    promotionAllowedByThisArtifact: false,
    candidateRegistryPath: resolve(input.candidateRegistryPath),
    candidateRegistryManifestPath: input.candidateRegistryManifestPath ? resolve(input.candidateRegistryManifestPath) : null,
    candidateRegistryHash,
    candidateRegistryManifest: {
      present: candidateManifest != null,
      artifactHash: candidateManifest?.artifactHash ?? null,
      hashMatchesCandidateRegistry: candidateManifest?.artifactHash == null || candidateRegistryHash == null
        ? null
        : candidateManifest.artifactHash === candidateRegistryHash,
      evidenceTrust: candidateManifest?.evidenceTrust ?? null,
      dqStatus: candidateManifest?.dqStatus ?? null,
      businessStatus: candidateManifest?.businessStatus ?? null,
    },
    entries,
    coverage: {
      candidateRegistryPresent: input.candidateRegistry != null,
      candidateCount: candidates.length,
      activeCandidates: activeCoverageItems.length,
      coveredActiveCandidates: activeCoverageItems.filter(item => item.covered).length,
      uncoveredActiveCandidates: uncoveredActive.length,
      coverageStatus,
      uncoveredStrategyIds: [...new Set(uncoveredActive.map(item => item.strategyId))].sort(),
      candidates: coverageItems,
    },
    governance: {
      requiredBeforeP1Review: true,
      requiredBeforePromotion: true,
      promotionBlockedByThisArtifact: true,
      blockingReasons,
      requiredActions: coverageStatus === 'pass'
        ? ['Keep alpha hypotheses updated when adding a new strategy family or candidate strategyId.']
        : [
            'Register a concrete alpha hypothesis for every active candidate strategyId before P1 review.',
            'Each hypothesis must define whoPays, expectedFailureRegime, requiredObservables, falsificationRule, and killCriteria.',
          ],
    },
    notes: [
      'This registry is research-only. Passing coverage means hypotheses are documented, not that the strategy is profitable.',
      'No entry in this artifact can authorize live trading, leverage changes, policy mutation, or promotion.',
      'The registry is designed to prevent data-mined candidates without a falsifiable market-structure explanation from entering P1/P2 review.',
    ],
  }
}

export function defaultAlphaHypotheses(): AlphaHypothesisEntry[] {
  return [
    {
      policyId: 'volume_breakout_clean_continuation_v1',
      familyId: 'volume_breakout',
      strategyIds: [
        'volume_breakout',
        'volume_breakout_1x',
        'volume_breakout_3x',
        'volume_breakout_10x',
        'volume_breakout_100x',
        'paper_volume_breakout_5m',
      ],
      researchOnly: true,
      promotionEligible: false,
      policyMutationAllowed: false,
      alphaHypothesis: 'Abnormal volume plus clean range expansion can continue over short horizons when aggressive liquidity demand overwhelms passive supply.',
      marketInefficiency: 'Temporary order-flow imbalance after a high-quality breakout is not instantly repriced under fragmented crypto liquidity.',
      whoPays: 'Late breakout chasers, forced shorts, and impatient liquidity takers who cross the spread after the initial move.',
      expectedHoldingHorizon: '5m to 2h',
      expectedFailureRegime: ['chop', 'low_liquidity', 'wide_spread', 'news_fakeout', 'post_spike_mean_reversion'],
      requiredObservables: [
        'volumeRatio',
        'rangeBreakoutPct',
        'breakQuality',
        'closeDirectionAgreement',
        'spreadBps',
        'liquidityUsd',
        'routeCostBps',
        'markMatchPenaltyBps',
      ],
      falsificationRule: {
        condition: 'After fixed gates, accept group does not beat skip/shadow group after costs over two non-overlapping prospective windows.',
        action: 'kill_candidate',
      },
      killCriteria: [
        'accept_vs_skip_delta_after_cost<=0 for two prospective windows',
        'cost_sensitivity_2x_slippage_pf<=1',
        'single_symbol_loss_contribution>35%',
        'context_coverage<95%',
      ],
      notes: ['Do not use raw volumeRatio alone; break quality and liquidity/spread gates are part of the hypothesis.'],
    },
    {
      policyId: 'microstructure_impulse_inventory_v1',
      familyId: 'microstructure',
      strategyIds: ['microstructure', 'microstructure_10x', 'microstructure_25x', 'microstructure_100x'],
      researchOnly: true,
      promotionEligible: false,
      policyMutationAllowed: false,
      alphaHypothesis: 'Short-horizon impulse plus strong confidence can capture temporary inventory pressure before liquidity providers mean-revert the move.',
      marketInefficiency: 'Ultra-short order-book and trade-flow pressure can create transient price continuation, but only while spread and mark-match quality remain acceptable.',
      whoPays: 'Liquidity takers that demand immediacy during inventory imbalance and stale passive orders that get adversely selected.',
      expectedHoldingHorizon: '30s to 10m',
      expectedFailureRegime: ['latency_spike', 'wide_spread', 'thin_book', 'mark_match_divergence', 'stop_loss_cluster', 'chop'],
      requiredObservables: [
        'return30sPct',
        'return60sPct',
        'confidence',
        'spreadBps',
        'liquidityUsd',
        'markPrice',
        'matchPrice',
        'routeCostBps',
        'stopDistanceBps',
      ],
      falsificationRule: {
        condition: 'MFE/MAE and stop-loss attribution show entry quality is not better than shadow skip group after costs.',
        action: 'kill_candidate',
      },
      killCriteria: [
        'stop_loss_loss_share_pct>=40 and baseline_pf<1 for a sufficient cluster',
        'realized_cost_bias_bps>5 when exchange reconciliation becomes available',
        'mark_match_status invalid or stale_or_missing dominates accepted trades',
        '100x leverage requested outside replay/research',
      ],
      notes: ['100x is a research/replay stress lane only; this hypothesis does not justify production 100x.'],
    },
    {
      policyId: 'cross_sectional_post_cost_rank_spread_v1',
      familyId: 'cross_sectional',
      strategyIds: ['cross_sectional', 'cross_sectional_v2', 'paper_cross_sectional', 'cross_sectional_100x'],
      researchOnly: true,
      promotionEligible: false,
      policyMutationAllowed: false,
      alphaHypothesis: 'Cross-sectional ranks can monetize relative mispricing only when top-bottom spread survives route costs, slippage, and turnover.',
      marketInefficiency: 'Slow-moving relative value and short-term under/over-reaction across the crypto universe can persist after costs in liquid symbols.',
      whoPays: 'Overcrowded momentum/reversal participants and liquidity takers crossing spreads in names with weaker relative rank.',
      expectedHoldingHorizon: '1h to 5d',
      expectedFailureRegime: ['high_correlation_beta_shock', 'turnover_spike', 'fee_spread_expansion', 'thin_universe', 'rank_instability'],
      requiredObservables: [
        'rankSpreadPctAtOpen',
        'expectedGrossEdgePctAtOpen',
        'expectedNetEdgePctAtOpen',
        'routeCostBps',
        'grossToCostRatio',
        'universeLiquidity',
        'symbolRiskScore',
      ],
      falsificationRule: {
        condition: 'Top-ranked accepted group does not beat no-trade and skip/shadow group post-cost in locked OOS and prospective windows.',
        action: 'kill_candidate',
      },
      killCriteria: [
        'gross_to_cost_ratio<2',
        'net_expectancy_bps below selected route break-even',
        'rank_ic not positive across independent windows',
        'single_symbol_contribution>35%',
      ],
      notes: ['Optimizer score must be cost-aware; paper PnL is execution-consistency evidence, not winner selection evidence.'],
    },
    {
      policyId: 'eth_carry_basis_funding_v1',
      familyId: 'carry_basis',
      strategyIds: ['eth_carry', 'eth_carry_short_bias', 'carry', 'basis'],
      researchOnly: true,
      promotionEligible: false,
      policyMutationAllowed: false,
      alphaHypothesis: 'Funding and basis dislocations can be harvested only when carry exceeds fees, borrow/funding variance, and stress unwind losses.',
      marketInefficiency: 'Derivative funding and basis can lag positioning pressure, but the edge depends on persistent local data collection and cost-aware unwind modeling.',
      whoPays: 'Levered directional demand paying funding or basis premium during crowded positioning.',
      expectedHoldingHorizon: '8h to 30d',
      expectedFailureRegime: ['funding_regime_flip', 'basis_compression', 'liquidity_gap', 'exchange_risk', 'crowded_unwind'],
      requiredObservables: [
        'fundingTime',
        'fundingRate',
        'markPrice',
        'openInterest',
        'openInterestPeriod',
        'longShortRatio',
        'processingLatencyMs',
        'routeCostBps',
      ],
      falsificationRule: {
        condition: 'Prospective local funding/OI/long-short history does not show net carry above stressed unwind cost.',
        action: 'research_only',
      },
      killCriteria: [
        'local_history_days<30 for initial review',
        'funding_net_of_cost<=0 after stress',
        'open_interest_history_gap prevents PIT features',
        'processing_latency_missing for external collector rows',
      ],
      notes: ['This family cannot be judged from exchange endpoints that only retain recent history unless local collection is running.'],
    },
  ]
}

export function renderAlphaHypothesisRegistryMarkdown(report: AlphaHypothesisRegistryReport): string {
  const lines: string[] = []
  lines.push('# Alpha Hypothesis Registry')
  lines.push('')
  lines.push(`Generated: \`${report.generatedAt}\``)
  lines.push(`Research only: \`${report.researchOnly}\``)
  lines.push(`Promotion allowed by this artifact: \`${report.promotionAllowedByThisArtifact}\``)
  lines.push(`Coverage status: \`${report.coverage.coverageStatus}\``)
  lines.push(`Active candidate coverage: ${report.coverage.coveredActiveCandidates}/${report.coverage.activeCandidates}`)
  lines.push('')
  lines.push('## Entries')
  lines.push('')
  lines.push('| policyId | familyId | strategyIds | whoPays | falsificationAction |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const entry of report.entries) {
    lines.push(`| ${entry.policyId} | ${entry.familyId} | ${entry.strategyIds.join(', ')} | ${entry.whoPays} | ${entry.falsificationRule.action} |`)
  }
  lines.push('')
  lines.push('## Candidate Coverage')
  lines.push('')
  for (const candidate of report.coverage.candidates) {
    lines.push(`- ${candidate.candidateId}: ${candidate.strategyId} covered=${candidate.covered}`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

function normalizeCandidateRegistryEntries(candidateRegistry: CandidateRegistryLike | null | undefined): AlphaCandidateCoverageItem[] {
  if (!candidateRegistry || !Array.isArray(candidateRegistry.entries)) return []
  return candidateRegistry.entries.map((entry, index) => ({
    candidateId: stringOrFallback(entry.candidateId, `candidate_${index + 1}`),
    strategyId: stringOrFallback(entry.strategyId, 'unknown_strategy'),
    status: stringOrFallback(entry.status, 'unknown'),
    covered: false,
    matchedPolicyIds: [],
    missingReason: null,
  }))
}

function buildCandidateCoverage(
  candidate: AlphaCandidateCoverageItem,
  entries: AlphaHypothesisEntry[],
): AlphaCandidateCoverageItem {
  const matched = entries.filter(entry => entry.strategyIds.includes(candidate.strategyId))
  return {
    ...candidate,
    covered: matched.length > 0,
    matchedPolicyIds: matched.map(entry => entry.policyId),
    missingReason: matched.length > 0 ? null : `missing_alpha_hypothesis_for_strategy:${candidate.strategyId}`,
  }
}

function readSourceManifest(path: string): EvidenceManifest | null {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8')) as EvidenceManifest
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const withoutPrefix = arg.slice(2)
    const eq = withoutPrefix.indexOf('=')
    if (eq >= 0) {
      out.set(withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out.set(withoutPrefix, next)
      i += 1
    } else {
      out.set(withoutPrefix, 'true')
    }
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (value === undefined) return null
  const normalized = value.trim()
  if (normalized === '' || normalized.toLowerCase() === 'null') return null
  return normalized
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error(`Invalid boolean value: ${value}`)
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseAlphaHypothesisRegistryArgs(argv)
  const report = await runAlphaHypothesisRegistry(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderAlphaHypothesisRegistryMarkdown(report))
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
