# OpenAlice Promotion v2.6 Spec

Net-Dollar Monetization Filter for the cross-sectional sleeve.

This document freezes the v2.6 promotion contract before implementation. The
goal is not to prove that a strategy must make money. The goal is to make every
promotion verdict reproducible, auditable, cost-aware, and hostile to common
research self-deception.

## Design Principles

1. Global release gate is authoritative.
2. Missing critical evidence equals fail.
3. Backfilled data cannot promote paper or live.
4. Maker fill requires trade-through or conservative queue evidence.
5. Recent OOS failure cannot be hidden by older average performance.
6. Confidence cannot override economics, cost, freshness, or veto.
7. Quarantined strategies cannot generate paper or live orders.
8. Failed candidates remain in the registry or graveyard and count toward multiple testing.
9. Paper and tiny-cap must share the same runtime decision path except for the final broker adapter.
10. Every promotion verdict must be recomputable from versioned schemas and validated hashes.
11. Percentage edge is insufficient; promotion requires positive net-dollar evidence after route-specific costs.
12. P0/P1/P2 remain focused on the low-turnover cross-sectional sleeve. Funding, LLM, TS teacher, stablecoin alpha, Alpha DSL, and HRP remain deferred.

## Gate Stack

```text
GlobalReleaseGate
  -> ResearchGate
  -> MonetizationGate
       -> RouteCostGate
       -> BenchmarkGate
       -> TurnoverGate
       -> CapitalGate
       -> OpportunityDensityGate
       -> UniverseAttributionGate
  -> PaperGate
  -> LiveGate
```

ResearchGate proves the strategy is not obviously fake. MonetizationGate proves
the strategy is worth trading in cash terms. PaperGate proves live-collected
paper execution still supports the thesis. LiveGate proves the strategy can be
reviewed for tiny-cap execution.

## Runtime Artifacts

Required latest artifacts:

- `strategy_promotion.latest.json`
- `evidence_ledger.latest.json`
- `candidate_registry.latest.json`
- `graveyard.latest.json`
- `fee_snapshot.latest.json`
- `route_cost_budget.latest.json`
- `benchmark_comparison.latest.json`
- `universe_attribution.latest.json`
- `runtime_path_audit.latest.json`
- `quarantine.latest.json`
- `execution_quality.latest.json`
- `failure_attribution.latest.json`

Each artifact must include schema metadata, code commit, generation time, and
input artifact hashes where applicable.

## Core Schemas

Every versioned artifact carries:

```ts
type SchemaMeta = {
  schemaName: string;
  schemaVersion: string;
  createdBy: string;
  createdAt: string;
  codeCommit: string;
};
```

Evidence items must bind claims to immutable artifacts and explicit data origin:

```ts
type EvidenceItem = {
  id: string;
  experimentId: string;
  claim: string;
  evidenceType: string;
  dataOrigin: "backtest" | "paper_live_sync" | "live_capture";
  artifactPath: string;
  artifactSha256: string;
  inputArtifactHashes: string[];
  metricSnapshot: Record<string, number | string | boolean>;
  validFrom: string;
  validUntil?: string;
  invalidationRule: string;
  createdAt: string;
};
```

PaperGate and LiveGate must fail if required promotion evidence contains
`dataOrigin: "backtest"`.

Fee snapshots must be fresh and runtime-verifiable:

```ts
type FeeSnapshot = {
  venue: string;
  symbol: string;
  instrumentType: string;
  accountTier: string;
  makerFeeBps: number;
  takerFeeBps: number;
  source: "api" | "account_page" | "official_page" | "manual_override";
  sourceFetchedAt: string;
  expiresAt: string;
  manualOverrideReason?: string;
  verifiedByRuntime: boolean;
  fundingIntervalHours?: number;
  fundingCapBps?: number;
  fundingFloorBps?: number;
  nextFundingAt?: string;
};
```

`manual_override` is allowed for research only. It cannot support PaperGate,
MonetizationGate paper checks, or LiveGate.

Route budgets are route-specific:

```ts
type RouteName = "passive_passive" | "passive_taker" | "taker_taker" | "twap";

type RouteBudget = {
  route: RouteName;
  feeBps: number;
  spreadBps: number;
  slippageBps: number;
  adverseSelectionBufferBps: number;
  queueMissBufferBps: number;
  fundingBps: number;
  totalExpectedCostBps: number;
  maxAllowedCostBps: number;
  breakEvenEdgeBps: number;
};
```

Monetization metrics must include cash terms:

```ts
type MonetizationMetrics = {
  netExpectancyBpsPerTrade: number;
  netExpectancyUsdPerTrade: number;
  netExpectancyUsdPerDay: number;
  netExpectancyUsdPerMonth: number;
  validSignalsPerMonth: number;
  executableCapacityUsd: number;
  turnoverPerDay: number;
  routeAdjustedBreakEvenBps: number;
  benchmarkExcessReturnBps: number;
};
```

CapitalGate is configurable and must not hard-code subjective costs:

```ts
type CapitalGate = {
  accountEquityUsd: number;
  maxCapitalAllocatedUsd: number;
  minOrderNotionalUsd: number;
  minUsefulDailyNetProfitUsd: number;
  minUsefulMonthlyNetProfitUsd: number;
  infraCostUsd: number;
  riskBufferUsd: number;
  expectedDailyNetProfitUsd: number;
  expectedMonthlyNetProfitUsd: number;
  capacityAtCurrentCostUsd: number;
  capitalEfficiency: number;
  status: "pass" | "fail";
  hardBlocks: string[];
};
```

BenchmarkGate requires no-trade to pass and at least two of three simple
benchmarks to pass over the identical OOS or live-paper window:

```ts
type BenchmarkName =
  | "no_trade"
  | "equal_weight_universe"
  | "btc_eth_50_50"
  | "low_turnover_momentum";
```

UniverseAttributionGate fails when less than 80 percent of PnL comes from
execution-eligible assets:

```ts
type UniverseAttribution = {
  researchUniverseSize: number;
  executionUniverseSize: number;
  pnlFromExecutionEligiblePct: number;
  signalsFromExecutionEligiblePct: number;
  topContributors: {
    symbol: string;
    universeRole: "research_only" | "execution_eligible";
    pnlContributionPct: number;
    tradeCount: number;
  }[];
};
```

Rebalance decisions must trade only when marginal expected edge clears route
cost plus a safety margin:

```ts
type RebalanceDecision = {
  symbol: string;
  currentWeight: number;
  targetWeight: number;
  proposedDeltaWeight: number;
  incrementalExpectedEdgeBps: number;
  routeRebalanceCostBps: number;
  safetyMarginBps: number;
  rebalanceNetBenefitBps: number;
  action: "hold" | "partial_rebalance" | "full_rebalance" | "block";
};
```

Maker missed-fill opportunity cost must be measured:

```ts
type MissedFillOpportunityCost = {
  orderId: string;
  missedFillReason: string;
  postDecisionMoveBps: number;
  wouldHaveProfitedBps: number;
  opportunityCostBps: number;
  evaluationWindowMinutes: number;
};
```

Research failures must be converted into constraints for the next iteration:

```ts
type FailureAttribution = {
  candidateId: string;
  primaryFailure:
    | "no_signal"
    | "cost_too_high"
    | "turnover_too_high"
    | "recent_oos_fail"
    | "route_unexecutable"
    | "benchmark_underperform"
    | "execution_drift"
    | "data_quality_fail"
    | "overfit";
  secondaryFailures: string[];
  suggestedNextMutation:
    | "increase_horizon"
    | "reduce_turnover"
    | "change_universe"
    | "tighten_route_filter"
    | "drop_factor"
    | "freeze_line";
  reusableEvidenceIds: string[];
};
```

## Monetization Rules

Promotion requires ResearchGate, MonetizationGate, PaperGate, and positive
live-collected net-dollar evidence after route-specific costs.

The strategy must beat `no_trade` and at least two configured simple
benchmarks over the identical OOS or live-paper window, using identical allowed
data origin and comparable route-cost assumptions.

Opportunity density must pass:

- minimum valid signals per month
- minimum expected net dollars per month
- minimum executable capacity on execution-eligible symbols

A strategy that is positive in percentage terms but fails CapitalGate remains
`research_only`. A strategy whose PnL mostly comes from research-only assets
fails UniverseAttributionGate. A strategy that requires excessive turnover
fails TurnoverGate even if rank quality looks strong.

## Execution Rules

Maker fill is conservative:

- same-price touch is not fill
- buy limit fill requires trade-through below the bid or conservative queue evidence
- sell limit fill requires trade-through above the ask or conservative queue evidence
- queue multiplier defaults to 5x
- multiplier rises to 10x under volatility spike or spread widening
- multiplier rises to 20x under severe combined stress

Maker routing must pass:

1. route cost lower than alternatives
2. toxicity benign
3. missed-fill opportunity cost smaller than expected cost saving

If any maker check fails, route switches to taker/TWAP or blocks.

Execution decay breaker quarantines a strategy if the recent 10 orders average
realized slippage exceeds expected slippage by more than 5 bps. Recent 20 paper
orders allow at most 2 slippage violations, actual/simulated cost ratio at most
1.25, and missed fill rate at most 30 percent.

## Implementation Priority

P0:

- this spec
- JSON schema/types
- SchemaMeta and artifact SHA-256
- EvidenceItem.dataOrigin
- CandidateRegistry
- GateResult precedence
- PromotionReadinessV2
- FeeSnapshot
- RouteCostBudget
- MonetizationGate skeleton
- BenchmarkComparison
- fake gross-to-cost ratio fail test

P1:

- research/execution universe split
- route-specific net edge
- turnover objective
- RebalanceDecision
- OpportunityDensityGate
- CapitalGate
- BenchmarkGate
- UniverseAttributionGate

P2:

- trade-through maker fill
- dynamic queue multiplier
- MissedFillOpportunityCost
- ExecutionCounterfactual
- adverse-selection blocker
- execution decay breaker

P3:

- full Funding auditor
- Stablecoin regime
- LLM event risk reducer
- TS teacher
- Alpha DSL
- HRP

## Required Tests

P0:

- schema version required
- hash mismatch invalidates evidence
- backtest data origin fails PaperGate
- manual fee override cannot promote paper/live
- fake gross-to-cost ratio fail
- PromotionReadinessV2 lists blocking evidence

P1:

- no-trade must pass
- at least two simple benchmarks must pass
- CapitalGate fails below useful net-dollar threshold
- UniverseAttributionGate fails if execution-eligible PnL is below 80 percent
- RebalanceDecision holds when edge does not exceed route cost plus safety margin

P2:

- same-price maker touch is missed
- dynamic queue multiplier increases under stress
- missed-fill opportunity cost can make maker route fail
- stale 1h bar after 10 minutes hard blocks
- paper/live path mismatch fails tiny-cap
- quarantine blocks orders

## Valid Verdict

A promotion verdict is valid only if it can be recomputed from:

- versioned schemas
- validated hashes
- allowed data origins
- CandidateRegistry counts
- frozen statistical policy
- fresh FeeSnapshot
- route-specific cost budgets
- benchmark comparisons
- net-dollar monetization metrics
- runtime path parity
- quarantine state

## Fail-Closed Clarifications

- Missing evidence artifact content fails promotion hash validation by default. A schema-only check must opt out explicitly.
- Missing critical economics fails MonetizationGate. `grossToCostRatio` must be present unless a future strategy-class policy explicitly exempts it.
- Route economics must clear the selected route break-even. Positive net dollars alone is not enough.
- Expired gate passes are treated as failed before a final verdict is emitted.
- Benchmark names must be present exactly once. Benchmark `pass` flags must agree with recomputed excess-return and comparability checks.
- Rebalance deltas must move toward the target weight. Wrong-direction deltas are blocked and same-direction overshoots are clamped to the target delta.
- Existing paper execution planning can consume `PromotionReadinessV2`; when supplied or required, non-`paper_allowed` and non-`tiny_cap_candidate` verdicts hard-block paper order generation.
- Runtime consumers should prefer validated loading. When `requirePromotionV2` is enabled, sidecar intake, runtime truth mainline, and expert-quant runtime truth should load the full latest artifact directory and recompute readiness from the bundle unless `validatePromotionV2Artifacts: false` is explicitly set for migration or schema-only tests.
- Live new-open guards should require `tiny_cap_candidate`, not merely `paper_allowed`. A paper-only readiness may generate paper orders, but it must not authorize tiny-cap or live order generation.
- Invalid validated artifact bundles may still return a recomputed readiness object for diagnostics, but the recomputed verdict is authoritative for order gating.

## Implemented Runtime Wiring

- `pnpm optimize:cross-sectional` now uses a deterministic seeded search by default and writes `candidate_registry.latest.json`, `graveyard.latest.json`, and `data/research/best_config.json`.
- `pnpm promotion:v2:publish` bridges the current cross-sectional optimizer registry plus `paper_decision.latest.json` into the required v2.6 runtime artifacts. It is conservative by construction: missing WFO/PBO/DSR/FDR, unverified fees, benchmark failures, execution quality gaps, or backfilled evidence remain hard blocks.
- `pnpm paper:shadow-loop` runs `promotion:v2:publish` after the cross-sectional paper decision so the latest shadow run refreshes the v2.6 artifact bundle.
- `pnpm paper:cross-sectional -- --requirePromotionV2 true` enforces validated v2.6 readiness before creating new local paper orders. This is optional for bootstrap evidence collection to avoid the PaperGate circularity, but strict dry-runs and promotion rehearsals should enable it.
- Sidecar signal intake, runtime truth mainline, expert-quant runtime truth, and live new-open guards can use validated artifact loading. Live new opens require `tiny_cap_candidate` when `requirePromotionV2ForLiveOrders` is enabled.
- `pnpm paper:monitor` surfaces the latest `strategy_promotion.latest.json` verdict alongside the legacy paper readiness fields and raises review alerts for `tiny_cap_candidate` and critical alerts for `quarantined`.
