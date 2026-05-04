import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readGitEvidenceSnapshot,
  writeEvidenceManifestForArtifact,
  type EvidenceManifest,
} from './evidence_manifest.js';
import {
  buildPromotionReadinessV2,
  evaluateBenchmarkGate,
  evaluateCandidateRegistryPolicy,
  evaluateExecutionCounterfactual,
  evaluateFeeSnapshot,
  evaluatePaperEvidenceDataOrigins,
  evaluateQuarantineForOrders,
  evaluateRuntimePathAuditForTinyCap,
  evaluateUniverseAttributionGate,
  hashJson,
  validateEvidenceHashes,
  validateSchemaMeta,
  type BenchmarkComparison,
  type CandidateRegistry,
  type EvidenceItem,
  type ExecutionCounterfactual,
  type FailureAttribution,
  type FeeSnapshot,
  type GateResult,
  type PromotionReadinessV2,
  type QuarantineRecord,
  type RouteName,
  type RouteCostBudget,
  type RuntimePathAudit,
  type StatisticalTestPolicy,
  type UniverseAttribution,
} from './promotion_v2.js';

export interface PromotionV2ExecutionQualityArtifact {
  generatedAt: string;
  recentOrderCount: number;
  slippageViolationCount: number;
  actualToSimulatedCostRatio: number;
  missedFillRate: number;
  decayCircuitBreakerTriggered: boolean;
  counterfactuals?: ExecutionCounterfactual[];
}

export interface PromotionV2RuntimeArtifacts {
  strategyPromotion: PromotionReadinessV2;
  evidenceLedger: EvidenceItem[];
  candidateRegistry: CandidateRegistry;
  graveyard: CandidateRegistry;
  feeSnapshot: FeeSnapshot;
  routeCostBudget: RouteCostBudget;
  benchmarkComparison: BenchmarkComparison[];
  universeAttribution: UniverseAttribution;
  runtimePathAudit: RuntimePathAudit;
  quarantine: QuarantineRecord | null;
  executionQuality: PromotionV2ExecutionQualityArtifact;
  failureAttribution: FailureAttribution[];
}

export const promotionV2ArtifactFileNames = {
  strategyPromotion: 'strategy_promotion.latest.json',
  evidenceLedger: 'evidence_ledger.latest.json',
  candidateRegistry: 'candidate_registry.latest.json',
  graveyard: 'graveyard.latest.json',
  feeSnapshot: 'fee_snapshot.latest.json',
  routeCostBudget: 'route_cost_budget.latest.json',
  benchmarkComparison: 'benchmark_comparison.latest.json',
  universeAttribution: 'universe_attribution.latest.json',
  runtimePathAudit: 'runtime_path_audit.latest.json',
  quarantine: 'quarantine.latest.json',
  executionQuality: 'execution_quality.latest.json',
  failureAttribution: 'failure_attribution.latest.json',
} as const satisfies Record<keyof PromotionV2RuntimeArtifacts, string>;

export type PromotionV2ArtifactKey = keyof PromotionV2RuntimeArtifacts;

export const DEFAULT_PROMOTION_V2_RUNTIME_DIR = 'data/runtime';
export const DEFAULT_PROMOTION_READINESS_V2_PATH = join(
  DEFAULT_PROMOTION_V2_RUNTIME_DIR,
  promotionV2ArtifactFileNames.strategyPromotion,
);

export type PromotionReadinessV2LoadResult =
  | {
      kind: 'loaded';
      path: string;
      readiness: PromotionReadinessV2;
    }
  | {
      kind: 'missing';
      path: string;
      error: string;
      readiness?: undefined;
    }
  | {
      kind: 'invalid';
      path: string;
      error: string;
      readiness?: undefined;
    };

export interface PromotionV2RuntimeArtifactValidationOptions {
  now?: Date;
  evidenceArtifactsByPath?: Readonly<Record<string, string | Buffer>>;
  requireEvidenceArtifacts?: boolean;
  statisticalPolicy?: StatisticalTestPolicy;
}

export interface PromotionV2RuntimeArtifactValidation {
  valid: boolean;
  hardBlocks: string[];
  recomputedReadiness: PromotionReadinessV2;
}

export type PromotionReadinessV2ValidatedLoadResult =
  | {
      kind: 'loaded';
      path: string;
      readiness: PromotionReadinessV2;
      validation: PromotionV2RuntimeArtifactValidation;
    }
  | {
      kind: 'missing';
      path: string;
      error: string;
      readiness?: undefined;
      validation?: undefined;
    }
  | {
      kind: 'invalid';
      path: string;
      error: string;
      readiness?: PromotionReadinessV2;
      validation?: PromotionV2RuntimeArtifactValidation;
    };

export async function writePromotionV2RuntimeArtifacts(
  baseDir: string,
  artifacts: PromotionV2RuntimeArtifacts,
): Promise<Record<PromotionV2ArtifactKey, string>> {
  await mkdir(baseDir, { recursive: true });
  const written = {} as Record<PromotionV2ArtifactKey, string>;
  const startedAt = new Date();
  const gitSnapshot = readGitEvidenceSnapshot();

  for (const key of Object.keys(promotionV2ArtifactFileNames) as PromotionV2ArtifactKey[]) {
    const path = join(baseDir, promotionV2ArtifactFileNames[key]);
    await writeFile(path, `${JSON.stringify(artifacts[key], null, 2)}\n`, 'utf-8');
    written[key] = path;
    await writeEvidenceManifestForArtifact({
      job: `promotion_v2_runtime_${key}`,
      artifactPath: path,
      manifestPath: `${path}.manifest.json`,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: promotionV2ArtifactBusinessStatus(key, artifacts[key]),
      recordsIn: promotionV2ArtifactRecordsIn(key, artifacts[key]),
      recordsOut: promotionV2ArtifactRecordsOut(artifacts[key]),
      gitSnapshot,
    });
  }

  return written;
}

function promotionV2ArtifactBusinessStatus(
  key: PromotionV2ArtifactKey,
  value: PromotionV2RuntimeArtifacts[PromotionV2ArtifactKey],
): EvidenceManifest['businessStatus'] {
  if (key === 'strategyPromotion') {
    const verdict = (value as PromotionReadinessV2).finalVerdict;
    return verdict === 'paper_allowed' || verdict === 'tiny_cap_candidate' ? 'pass' : 'warn';
  }
  if (key === 'quarantine') return value === null ? 'pass' : 'warn';
  if (key === 'failureAttribution') return Array.isArray(value) && value.length > 0 ? 'warn' : 'pass';
  if (key === 'evidenceLedger') return Array.isArray(value) && value.length === 0 ? 'warn' : 'pass';
  return 'pass';
}

function promotionV2ArtifactRecordsIn(
  key: PromotionV2ArtifactKey,
  value: PromotionV2RuntimeArtifacts[PromotionV2ArtifactKey],
): number | null {
  if (key === 'strategyPromotion') {
    return (value as PromotionReadinessV2).evidence.supportingEvidenceIds.length;
  }
  return promotionV2ArtifactRecordsOut(value);
}

function promotionV2ArtifactRecordsOut(
  value: PromotionV2RuntimeArtifacts[PromotionV2ArtifactKey],
): number | null {
  if (Array.isArray(value)) return value.length;
  if (value === null) return 0;
  return 1;
}

export async function loadPromotionV2RuntimeArtifacts(
  baseDir = DEFAULT_PROMOTION_V2_RUNTIME_DIR,
): Promise<PromotionV2RuntimeArtifacts> {
  const load = async <T>(key: PromotionV2ArtifactKey): Promise<T> => {
    const raw = await readFile(join(baseDir, promotionV2ArtifactFileNames[key]), 'utf-8');
    return JSON.parse(raw) as T;
  };

  return {
    strategyPromotion: await load<PromotionReadinessV2>('strategyPromotion'),
    evidenceLedger: await load<EvidenceItem[]>('evidenceLedger'),
    candidateRegistry: await load<CandidateRegistry>('candidateRegistry'),
    graveyard: await load<CandidateRegistry>('graveyard'),
    feeSnapshot: await load<FeeSnapshot>('feeSnapshot'),
    routeCostBudget: await load<RouteCostBudget>('routeCostBudget'),
    benchmarkComparison: await load<BenchmarkComparison[]>('benchmarkComparison'),
    universeAttribution: await load<UniverseAttribution>('universeAttribution'),
    runtimePathAudit: await load<RuntimePathAudit>('runtimePathAudit'),
    quarantine: await load<QuarantineRecord | null>('quarantine'),
    executionQuality: await load<PromotionV2ExecutionQualityArtifact>('executionQuality'),
    failureAttribution: await load<FailureAttribution[]>('failureAttribution'),
  };
}

export function validatePromotionV2RuntimeArtifacts(
  artifacts: PromotionV2RuntimeArtifacts,
  options: PromotionV2RuntimeArtifactValidationOptions = {},
): PromotionV2RuntimeArtifactValidation {
  const now = options.now ?? new Date(artifacts.strategyPromotion.generatedAt);
  const hardBlocks: string[] = [];
  const researchBlocks: string[] = [];
  const monetizationBlocks: string[] = [];
  const paperBlocks: string[] = [];
  const liveBlocks: string[] = [];

  const readiness = artifacts.strategyPromotion;
  const mode = resolvePromotionMode(readiness.finalVerdict);
  const evidenceIds = new Set(artifacts.evidenceLedger.map((item) => item.id));
  const supportingEvidence = artifacts.evidenceLedger.filter((item) =>
    readiness.evidence.supportingEvidenceIds.includes(item.id),
  );

  researchBlocks.push(...validateSchemaMeta(readiness.schemaMeta));
  researchBlocks.push(...validateSchemaMeta(artifacts.candidateRegistry.schemaMeta));
  researchBlocks.push(...validateSchemaMeta(artifacts.graveyard.schemaMeta));
  researchBlocks.push(...validateSchemaMeta(artifacts.routeCostBudget.schemaMeta));

  for (const id of readiness.evidence.supportingEvidenceIds) {
    if (!evidenceIds.has(id)) {
      researchBlocks.push(`supporting_evidence_missing_from_ledger:${id}`);
    }
  }
  for (const id of readiness.evidence.blockingEvidenceIds) {
    if (!evidenceIds.has(id)) {
      researchBlocks.push(`blocking_evidence_missing_from_ledger:${id}`);
    }
  }

  const hashValidation = validateEvidenceHashes(
    artifacts.evidenceLedger,
    options.evidenceArtifactsByPath ?? {},
    { requireArtifacts: options.requireEvidenceArtifacts ?? true },
  );
  if (!hashValidation.valid) {
    researchBlocks.push(...hashValidation.reasons);
  }

  researchBlocks.push(...evaluateCandidateRegistrySelfConsistency(artifacts.candidateRegistry));
  researchBlocks.push(...evaluateCandidateRegistrySelfConsistency(artifacts.graveyard));
  if (options.statisticalPolicy) {
    researchBlocks.push(
      ...evaluateCandidateRegistryPolicy(artifacts.candidateRegistry, options.statisticalPolicy).hardBlocks,
    );
  }

  monetizationBlocks.push(...evaluateFeeSnapshot(artifacts.feeSnapshot, mode, now).hardBlocks);
  if (hashJson(artifacts.feeSnapshot) !== hashJson(artifacts.routeCostBudget.feeSnapshot)) {
    monetizationBlocks.push('route_cost_budget_fee_snapshot_mismatch');
  }
  monetizationBlocks.push(...evaluateBenchmarkGate(artifacts.benchmarkComparison).hardBlocks);
  monetizationBlocks.push(...evaluateUniverseAttributionGate(artifacts.universeAttribution).hardBlocks);
  monetizationBlocks.push(
    ...evaluateRouteEconomicsFromReadiness(readiness, artifacts.routeCostBudget),
  );

  if (mode !== 'research') {
    paperBlocks.push(
      ...evaluatePaperEvidenceDataOrigins(
        artifacts.evidenceLedger,
        readiness.evidence.supportingEvidenceIds,
      ),
    );
    if (supportingEvidence.length === 0) {
      paperBlocks.push('supporting_evidence_empty');
    }
  }
  paperBlocks.push(...evaluateExecutionQualityArtifact(artifacts.executionQuality));
  paperBlocks.push(...evaluateExecutionQualityParity(readiness, artifacts.executionQuality));

  if (mode === 'live') {
    liveBlocks.push(...evaluateRuntimePathAuditForTinyCap(artifacts.runtimePathAudit));
  }
  liveBlocks.push(...evaluateQuarantineForOrders(artifacts.quarantine ?? undefined));
  liveBlocks.push(...evaluateFailureAttributionReferences(artifacts));

  const recomputedReadiness = buildPromotionReadinessV2({
    schemaMeta: readiness.schemaMeta,
    strategyId: readiness.strategyId,
    experimentId: readiness.experimentId,
    generatedAt: readiness.generatedAt,
    globalReleaseGate: readiness.globalReleaseGate,
    researchGate: appendGateBlocks(readiness.researchGate, researchBlocks),
    monetizationGate: appendGateBlocks(readiness.monetizationGate, monetizationBlocks),
    paperGate: appendGateBlocks(readiness.paperGate, paperBlocks),
    liveGate: appendGateBlocks(readiness.liveGate, liveBlocks),
    monetization: readiness.monetization,
    execution: readiness.execution,
    dataFreshness: readiness.dataFreshness,
    evidence: readiness.evidence,
    quarantine: artifacts.quarantine ?? undefined,
    now,
  });

  hardBlocks.push(
    ...researchBlocks.map((block) => `research:${block}`),
    ...monetizationBlocks.map((block) => `monetization:${block}`),
    ...paperBlocks.map((block) => `paper:${block}`),
    ...liveBlocks.map((block) => `live:${block}`),
  );

  if (recomputedReadiness.finalVerdict !== readiness.finalVerdict) {
    hardBlocks.push(
      `strategy_promotion_verdict_mismatch:${readiness.finalVerdict}->${recomputedReadiness.finalVerdict}`,
    );
  }

  return {
    valid: hardBlocks.length === 0,
    hardBlocks: unique(hardBlocks),
    recomputedReadiness,
  };
}

export async function loadPromotionReadinessV2(path: string): Promise<PromotionReadinessV2> {
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as PromotionReadinessV2;
}

export async function tryLoadPromotionReadinessV2(
  path = DEFAULT_PROMOTION_READINESS_V2_PATH,
): Promise<PromotionReadinessV2LoadResult> {
  try {
    return {
      kind: 'loaded',
      path,
      readiness: await loadPromotionReadinessV2(path),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return {
        kind: 'missing',
        path,
        error: error.message,
      };
    }
    return {
      kind: 'invalid',
      path,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function tryLoadValidatedPromotionReadinessV2(
  baseDir = DEFAULT_PROMOTION_V2_RUNTIME_DIR,
  options: PromotionV2RuntimeArtifactValidationOptions = {},
): Promise<PromotionReadinessV2ValidatedLoadResult> {
  const path = join(baseDir, promotionV2ArtifactFileNames.strategyPromotion);
  try {
    const artifacts = await loadPromotionV2RuntimeArtifacts(baseDir);
    const evidenceArtifactsByPath =
      options.evidenceArtifactsByPath ?? await loadEvidenceArtifactContents(artifacts.evidenceLedger);
    const validation = validatePromotionV2RuntimeArtifacts(artifacts, {
      ...options,
      evidenceArtifactsByPath,
    });

    if (!validation.valid) {
      return {
        kind: 'invalid',
        path,
        error: validation.hardBlocks.join('; '),
        readiness: validation.recomputedReadiness,
        validation,
      };
    }

    return {
      kind: 'loaded',
      path,
      readiness: validation.recomputedReadiness,
      validation,
    };
  } catch (error) {
    if (isEnoent(error)) {
      return {
        kind: 'missing',
        path,
        error: error.message,
      };
    }
    return {
      kind: 'invalid',
      path,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function appendGateBlocks(gate: GateResult, hardBlocks: string[]): GateResult {
  const mergedHardBlocks = unique([...gate.hardBlocks, ...hardBlocks]);
  return {
    ...gate,
    status: mergedHardBlocks.length === 0 ? gate.status : 'fail',
    hardBlocks: mergedHardBlocks,
  };
}

async function loadEvidenceArtifactContents(
  evidence: EvidenceItem[],
): Promise<Record<string, Buffer>> {
  const entries = await Promise.all(
    evidence.map(async (item): Promise<readonly [string, Buffer] | null> => {
      try {
        return [item.artifactPath, await readFile(item.artifactPath)] as const;
      } catch {
        return null;
      }
    }),
  );

  return Object.fromEntries(
    entries.filter((entry): entry is readonly [string, Buffer] => entry !== null),
  );
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function resolvePromotionMode(verdict: PromotionReadinessV2['finalVerdict']): 'research' | 'paper' | 'live' {
  if (verdict === 'tiny_cap_candidate') return 'live';
  if (verdict === 'paper_allowed' || verdict === 'paper_blocked' || verdict === 'live_blocked') return 'paper';
  return 'research';
}

function evaluateCandidateRegistrySelfConsistency(registry: CandidateRegistry): string[] {
  const hardBlocks: string[] = [];
  const actualCandidateCount = registry.entries.length;
  const graveyardCount = registry.entries.filter((entry) => entry.status === 'graveyard').length;

  if (registry.candidateCount !== actualCandidateCount) {
    hardBlocks.push(`candidate_registry_count_mismatch:${registry.registryId}`);
  }
  if (registry.graveyardCandidateCount !== graveyardCount) {
    hardBlocks.push(`graveyard_count_mismatch:${registry.registryId}`);
  }

  return hardBlocks;
}

function evaluateRouteEconomicsFromReadiness(
  readiness: PromotionReadinessV2,
  routeCostBudget: RouteCostBudget,
): string[] {
  const hardBlocks: string[] = [];
  const selectedRoute = readiness.monetizationGate.metricSnapshot.selectedRoute;
  if (!isRouteName(selectedRoute)) {
    return ['selected_route_missing_or_invalid'];
  }

  const routeBudget = routeCostBudget.routes[selectedRoute];
  if (!routeBudget) {
    return [`selected_route_budget_missing:${selectedRoute}`];
  }
  if (readiness.monetization.netExpectancyBpsPerTrade <= routeBudget.breakEvenEdgeBps) {
    hardBlocks.push(`net_expectancy_bps_below_route_break_even:${selectedRoute}`);
  }
  if (readiness.monetization.routeAdjustedBreakEvenBps < routeBudget.breakEvenEdgeBps) {
    hardBlocks.push(`route_adjusted_break_even_below_budget:${selectedRoute}`);
  }
  if (routeBudget.totalExpectedCostBps > routeBudget.maxAllowedCostBps) {
    hardBlocks.push(`route_cost_budget_exceeded:${selectedRoute}`);
  }

  const grossToCostRatio = readiness.monetizationGate.metricSnapshot.grossToCostRatio;
  if (grossToCostRatio === undefined || grossToCostRatio === 'not_reported') {
    hardBlocks.push('gross_to_cost_ratio_missing');
  } else if (typeof grossToCostRatio !== 'number' || grossToCostRatio < 2) {
    hardBlocks.push('gross_to_cost_ratio_below_threshold');
  }

  return hardBlocks;
}

function evaluateExecutionQualityArtifact(artifact: PromotionV2ExecutionQualityArtifact): string[] {
  const hardBlocks: string[] = [];

  if (artifact.recentOrderCount < 20) {
    hardBlocks.push('execution_recent_order_count_below_20');
  }
  if (artifact.slippageViolationCount > 2) {
    hardBlocks.push('execution_slippage_violations_above_2');
  }
  if (artifact.actualToSimulatedCostRatio > 1.25) {
    hardBlocks.push('execution_actual_to_simulated_cost_ratio_above_1_25');
  }
  if (artifact.missedFillRate > 0.3) {
    hardBlocks.push('execution_missed_fill_rate_above_30_pct');
  }
  if (artifact.decayCircuitBreakerTriggered) {
    hardBlocks.push('execution_decay_circuit_breaker_triggered');
  }

  for (const counterfactual of artifact.counterfactuals ?? []) {
    hardBlocks.push(...evaluateExecutionCounterfactual(counterfactual).hardBlocks);
  }

  return hardBlocks;
}

function evaluateExecutionQualityParity(
  readiness: PromotionReadinessV2,
  artifact: PromotionV2ExecutionQualityArtifact,
): string[] {
  const mismatches: string[] = [];
  const fields: Array<keyof PromotionReadinessV2['execution']> = [
    'recentOrderCount',
    'slippageViolationCount',
    'actualToSimulatedCostRatio',
    'missedFillRate',
    'decayCircuitBreakerTriggered',
  ];

  for (const field of fields) {
    if (readiness.execution[field] !== artifact[field]) {
      mismatches.push(`execution_quality_mismatch:${field}`);
    }
  }

  return mismatches;
}

function evaluateFailureAttributionReferences(artifacts: PromotionV2RuntimeArtifacts): string[] {
  const candidateIds = new Set([
    ...artifacts.candidateRegistry.entries.map((entry) => entry.candidateId),
    ...artifacts.graveyard.entries.map((entry) => entry.candidateId),
  ]);
  const evidenceIds = new Set(artifacts.evidenceLedger.map((item) => item.id));
  const hardBlocks: string[] = [];

  for (const failure of artifacts.failureAttribution) {
    if (!candidateIds.has(failure.candidateId)) {
      hardBlocks.push(`failure_attribution_candidate_missing:${failure.candidateId}`);
    }
    for (const evidenceId of failure.reusableEvidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        hardBlocks.push(`failure_attribution_evidence_missing:${evidenceId}`);
      }
    }
  }

  return hardBlocks;
}

function isRouteName(value: unknown): value is RouteName {
  return value === 'passive_passive' || value === 'passive_taker' || value === 'taker_taker' || value === 'twap';
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
