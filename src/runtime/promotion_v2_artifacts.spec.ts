import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROMOTION_V2_SCHEMA_VERSION,
  buildPromotionReadinessV2,
  makeGateResult,
  sha256Hex,
  type CandidateRegistry,
  type EvidenceItem,
  type FeeSnapshot,
  type RouteBudget,
  type RouteCostBudget,
  type SchemaMeta,
} from './promotion_v2.js';
import {
  DEFAULT_PROMOTION_READINESS_V2_PATH,
  loadPromotionV2RuntimeArtifacts,
  loadPromotionReadinessV2,
  promotionV2ArtifactFileNames,
  tryLoadPromotionReadinessV2,
  tryLoadValidatedPromotionReadinessV2,
  validatePromotionV2RuntimeArtifacts,
  writePromotionV2RuntimeArtifacts,
  type PromotionV2RuntimeArtifacts,
} from './promotion_v2_artifacts.js';

const now = '2026-04-30T12:00:00.000Z';
const future = '2026-04-30T13:00:00.000Z';

const schemaMeta: SchemaMeta = {
  schemaName: 'strategy_promotion',
  schemaVersion: PROMOTION_V2_SCHEMA_VERSION,
  createdBy: 'vitest',
  createdAt: now,
  codeCommit: 'test',
};

function routeBudget(route: RouteBudget['route']): RouteBudget {
  return {
    route,
    feeBps: 4,
    spreadBps: 2,
    slippageBps: 3,
    adverseSelectionBufferBps: 3,
    queueMissBufferBps: 2,
    fundingBps: 0,
    totalExpectedCostBps: 14,
    maxAllowedCostBps: 20,
    breakEvenEdgeBps: 14,
  };
}

function feeSnapshot(): FeeSnapshot {
  return {
    venue: 'binance',
    symbol: 'BTC/USDT:USDT',
    instrumentType: 'perpetual',
    accountTier: 'regular',
    makerFeeBps: 2,
    takerFeeBps: 5,
    source: 'api',
    sourceFetchedAt: now,
    expiresAt: future,
    verifiedByRuntime: true,
  };
}

function artifacts(evidencePath = '/tmp/evidence.json'): PromotionV2RuntimeArtifacts {
  const evidence: EvidenceItem = {
    id: 'evidence-1',
    experimentId: 'experiment-1',
    claim: 'positive live paper net dollars',
    evidenceType: 'paper',
    dataOrigin: 'paper_live_sync',
    artifactPath: evidencePath,
    artifactSha256: sha256Hex('evidence'),
    inputArtifactHashes: [sha256Hex('input')],
    metricSnapshot: { netExpectancyUsdPerDay: 6 },
    validFrom: now,
    invalidationRule: 'gate_expiry',
    createdAt: now,
  };
  const candidateRegistry: CandidateRegistry = {
    schemaMeta,
    registryId: 'registry-1',
    candidateCount: 1,
    entries: [{
      candidateId: 'candidate-1',
      experimentId: 'experiment-1',
      strategyId: 'cross-sectional-v2',
      generatedAt: now,
      scriptName: 'optimize:cross-sectional',
      parameterHash: sha256Hex('params'),
      status: 'active',
    }],
    graveyardCandidateCount: 0,
  };
  const routeCostBudget: RouteCostBudget = {
    schemaMeta,
    generatedAt: now,
    feeSnapshot: feeSnapshot(),
    routes: {
      passive_passive: routeBudget('passive_passive'),
      passive_taker: routeBudget('passive_taker'),
      taker_taker: routeBudget('taker_taker'),
      twap: routeBudget('twap'),
    },
  };

  return {
    strategyPromotion: buildPromotionReadinessV2({
      schemaMeta,
      strategyId: 'cross-sectional-v2',
      experimentId: 'experiment-1',
      generatedAt: now,
      globalReleaseGate: makeGateResult({ gateName: 'global_release', expiresAt: future }),
      researchGate: makeGateResult({ gateName: 'research', expiresAt: future }),
      monetizationGate: makeGateResult({
        gateName: 'monetization',
        metricSnapshot: {
          selectedRoute: 'passive_passive',
          grossToCostRatio: 2.2,
        },
        expiresAt: future,
      }),
      paperGate: makeGateResult({ gateName: 'paper', expiresAt: future }),
      liveGate: makeGateResult({ gateName: 'live', hardBlocks: ['tiny_cap_not_reviewed'], expiresAt: future }),
      monetization: {
        netExpectancyBpsPerTrade: 30,
        netExpectancyUsdPerTrade: 3,
        netExpectancyUsdPerDay: 6,
        netExpectancyUsdPerMonth: 180,
        validSignalsPerMonth: 30,
        executableCapacityUsd: 5_000,
        turnoverPerDay: 0.2,
        routeAdjustedBreakEvenBps: 14,
        benchmarkExcessReturnBps: 18,
      },
      execution: {
        recentOrderCount: 20,
        slippageViolationCount: 0,
        actualToSimulatedCostRatio: 1.1,
        missedFillRate: 0.2,
        decayCircuitBreakerTriggered: false,
      },
      dataFreshness: {
        latestDecisionStatus: 'fresh',
        staleBlockCount: 0,
        maxDataLatencyMinutes: 3,
      },
      evidence: {
        supportingEvidenceIds: ['evidence-1'],
        blockingEvidenceIds: [],
        missingRequiredEvidence: [],
      },
      now: new Date(now),
    }),
    evidenceLedger: [evidence],
    candidateRegistry,
    graveyard: { ...candidateRegistry, registryId: 'graveyard-1', candidateCount: 0, entries: [] },
    feeSnapshot: feeSnapshot(),
    routeCostBudget,
    benchmarkComparison: [
      {
        benchmarkName: 'no_trade',
        sameWindow: true,
        sameCostModel: true,
        sameExecutionEligibility: true,
        sameDataOriginPolicy: true,
        strategyNetReturnBps: 20,
        benchmarkNetReturnBps: 0,
        excessReturnBps: 20,
        excessMaxDrawdownAdjusted: 15,
        pass: true,
      },
      {
        benchmarkName: 'equal_weight_universe',
        sameWindow: true,
        sameCostModel: true,
        sameExecutionEligibility: true,
        sameDataOriginPolicy: true,
        strategyNetReturnBps: 20,
        benchmarkNetReturnBps: 5,
        excessReturnBps: 15,
        excessMaxDrawdownAdjusted: 10,
        pass: true,
      },
      {
        benchmarkName: 'btc_eth_50_50',
        sameWindow: true,
        sameCostModel: true,
        sameExecutionEligibility: true,
        sameDataOriginPolicy: true,
        strategyNetReturnBps: 20,
        benchmarkNetReturnBps: 10,
        excessReturnBps: 10,
        excessMaxDrawdownAdjusted: 8,
        pass: true,
      },
      {
        benchmarkName: 'low_turnover_momentum',
        sameWindow: true,
        sameCostModel: true,
        sameExecutionEligibility: true,
        sameDataOriginPolicy: true,
        strategyNetReturnBps: 20,
        benchmarkNetReturnBps: 25,
        excessReturnBps: -5,
        excessMaxDrawdownAdjusted: -3,
        pass: false,
      },
    ],
    universeAttribution: {
      researchUniverseSize: 16,
      executionUniverseSize: 8,
      pnlFromExecutionEligiblePct: 90,
      signalsFromExecutionEligiblePct: 88,
      topContributors: [],
    },
    runtimePathAudit: {
      mode: 'paper',
      signalCodePathHash: sha256Hex('signal'),
      gateCodePathHash: sha256Hex('gate'),
      executionCodePathHash: sha256Hex('execution'),
      configHash: sha256Hex('config'),
      differsFromPaper: false,
      differences: [],
    },
    quarantine: null,
    executionQuality: {
      generatedAt: now,
      recentOrderCount: 20,
      slippageViolationCount: 0,
      actualToSimulatedCostRatio: 1.1,
      missedFillRate: 0.2,
      decayCircuitBreakerTriggered: false,
    },
    failureAttribution: [],
  };
}

describe('promotion_v2_artifacts', () => {
  it('writes all required latest artifact files and reloads strategy promotion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-promotion-v2-'));
    const written = await writePromotionV2RuntimeArtifacts(dir, artifacts());

    expect(Object.keys(written).sort()).toEqual(Object.keys(promotionV2ArtifactFileNames).sort());
    await expect(readFile(join(dir, 'evidence_ledger.latest.json'), 'utf-8')).resolves.toContain('evidence-1');
    for (const [key, artifactPath] of Object.entries(written)) {
      const raw = await readFile(artifactPath, 'utf-8');
      const manifest = JSON.parse(await readFile(`${artifactPath}.manifest.json`, 'utf-8')) as Record<string, any>;
      expect(manifest).toMatchObject({
        job: `promotion_v2_runtime_${key}`,
        artifactPath,
        manifestPath: `${artifactPath}.manifest.json`,
        exitCode: 0,
      });
      expect(manifest.artifactHash).toBe(sha256Hex(raw));
      expect(manifest.evidenceTrust).toMatch(/^(pass|quarantine)$/);
      expect(manifest.dqStatus).toBe(manifest.evidenceTrust);
    }

    const readiness = await loadPromotionReadinessV2(join(dir, 'strategy_promotion.latest.json'));
    expect(readiness.schemaMeta.schemaVersion).toBe(PROMOTION_V2_SCHEMA_VERSION);
    expect(readiness.finalVerdict).toBe('paper_allowed');

    const loaded = await loadPromotionV2RuntimeArtifacts(dir);
    expect(loaded.evidenceLedger[0]?.id).toBe('evidence-1');
  });

  it('reports missing readiness artifacts without throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-promotion-v2-missing-'));
    const result = await tryLoadPromotionReadinessV2(join(dir, 'missing.latest.json'));

    expect(DEFAULT_PROMOTION_READINESS_V2_PATH).toBe('data/runtime/strategy_promotion.latest.json');
    expect(result.kind).toBe('missing');
    expect(result.path).toContain('missing.latest.json');
  });

  it('loads validated readiness from a complete latest artifact directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-promotion-v2-validated-'));
    const evidencePath = join(dir, 'evidence.json');
    await writeFile(evidencePath, 'evidence', 'utf-8');
    await writePromotionV2RuntimeArtifacts(dir, artifacts(evidencePath));

    const result = await tryLoadValidatedPromotionReadinessV2(dir, {
      now: new Date(now),
    });

    expect(result.kind).toBe('loaded');
    if (result.kind === 'loaded') {
      expect(result.readiness.finalVerdict).toBe('paper_allowed');
      expect(result.validation.valid).toBe(true);
    }
  });

  it('returns invalid validated readiness when required latest artifacts do not recompute cleanly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openalice-promotion-v2-invalid-'));
    await writePromotionV2RuntimeArtifacts(dir, artifacts(join(dir, 'missing-evidence.json')));

    const result = await tryLoadValidatedPromotionReadinessV2(dir, {
      now: new Date(now),
    });

    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.error).toContain('research:artifact_missing:evidence-1');
      expect(result.readiness?.finalVerdict).toBe('research_only');
    }
  });

  it('validates and recomputes a consistent latest artifact bundle', () => {
    const validation = validatePromotionV2RuntimeArtifacts(artifacts(), {
      now: new Date(now),
      evidenceArtifactsByPath: {
        '/tmp/evidence.json': 'evidence',
      },
    });

    expect(validation.valid).toBe(true);
    expect(validation.hardBlocks).toEqual([]);
    expect(validation.recomputedReadiness.finalVerdict).toBe('paper_allowed');
  });

  it('fails closed when evidence artifact content is unavailable', () => {
    const validation = validatePromotionV2RuntimeArtifacts(artifacts(), {
      now: new Date(now),
    });

    expect(validation.valid).toBe(false);
    expect(validation.hardBlocks).toContain('research:artifact_missing:evidence-1');
    expect(validation.hardBlocks).toContain(
      'strategy_promotion_verdict_mismatch:paper_allowed->research_only',
    );
    expect(validation.recomputedReadiness.finalVerdict).toBe('research_only');
  });

  it('detects stale strategy promotion when route economics no longer support the verdict', () => {
    const stale = artifacts();
    stale.routeCostBudget = {
      ...stale.routeCostBudget,
      routes: {
        ...stale.routeCostBudget.routes,
        passive_passive: {
          ...stale.routeCostBudget.routes.passive_passive,
          breakEvenEdgeBps: 40,
        },
      },
    };

    const validation = validatePromotionV2RuntimeArtifacts(stale, {
      now: new Date(now),
      evidenceArtifactsByPath: {
        '/tmp/evidence.json': 'evidence',
      },
    });

    expect(validation.valid).toBe(false);
    expect(validation.hardBlocks).toContain(
      'monetization:net_expectancy_bps_below_route_break_even:passive_passive',
    );
    expect(validation.hardBlocks).toContain(
      'strategy_promotion_verdict_mismatch:paper_allowed->research_only',
    );
  });
});
