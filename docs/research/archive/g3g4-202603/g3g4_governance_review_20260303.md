# G3/G4 Governance Review (2026-03-03)

## 1) Current Evidence Snapshot
- Stage-A matrix run: `20260303T131924Z`
- Requested assets: `BTC, ETH, SOL`
- Completed assets: `3/3`
- Data quality: all valid (`validAssets=3`, `invalidAssets=0`)

Asset-level metrics:
- BTC: `fdrQ=0.8775`, `meanPbo=0.8857`, `meanDsrProbability=0.1753`
- ETH: `fdrQ=0.7733`, `meanPbo=0.1000`, `meanDsrProbability=0.2345`
- SOL: `fdrQ=0.9845`, `meanPbo=0.7857`, `meanDsrProbability=0.0285`

## 2) Stage-A Gate Result
- Gate file: `data/research/strategy/analysis/g3g4/stagea_gate_result.v1.json`
- Decision: `passed=false`
- Next stage: `stageB_governance_review`

Dual-condition gate status:
- Condition A (`fdrQ < 0.355` and `meanPbo <= 0.20` and `meanDsrProbability >= 0.50`): `0` assets passed (min required `2`)
- Condition B (`fdrQ <= 0.25` and `meanPbo <= 0.20` and `meanDsrProbability >= 0.50`): `0` assets passed (min required `1`)

Conclusion: Current framework fails Stage-A by a wide margin.

## 3) Threshold Sensitivity (Research-Only)
- `prod_frozen`: `jointPassRate=0.0`, `fdrBlockRate=1.0`
- `research_fdr_12`: `jointPassRate=0.0`, `fdrBlockRate=1.0`
- `research_fdr_15`: `jointPassRate=0.0`, `fdrBlockRate=1.0`
- `research_fdr_20`: `jointPassRate=0.0`, `fdrBlockRate=1.0`

Interpretation: Even research-only relaxation to `fdrQ<=0.20` does not produce any passing asset under current signal regime.

## 4) Cost-Benefit Analysis
### Option A: Continue current framework optimization
- Time: `1-2 months`
- Estimated success probability: `<20%`
- Evidence basis: Stage-A hard fail across 3 assets; no sensitivity relief signal.

### Option B: Strategy rebuild project (new project)
- Time: `3-6 months`
- Estimated success probability: `unknown` (must be re-estimated after M1)
- Benefit: only path that can fundamentally improve both signal quality and statistical control.

### Option C: Accept current result as research baseline only
- Time: immediate
- Benefit: avoids sunk cost escalation
- Cost: production GO remains blocked by policy.

## 5) Business Risk Assessment
- Production policy remains frozen: `fdrQ<=0.10`.
- Current observed `fdrQ` values (`0.77-0.98`) imply severe false-discovery exposure if promoted.
- Risk statement:
  - If interpreted as expected false-discovery proportion, current range is materially above acceptable production tolerance.
  - Promoting current framework to production would violate policy and likely create unstable strategy admission outcomes.

## 6) Alternative Paths (Non-FDR-Tuning)
1. Risk-budget-first admission:
   - tighten position/risk caps before attempting admission, treat current strategy as exploratory only.
2. Execution microstructure track:
   - focus on execution slippage control and transaction-cost robustness as a separate objective.
3. Data/feature redesign track:
   - rebuild alpha signal feature set and regime descriptors before reapplying FDR gate logic.

## 7) Recommendation
- Recommended immediate decision: enter Stage-B governance route with production thresholds frozen.
- Recommended operational action this week:
  - Do not run additional local parameter searches in current framework for GO intent.
  - Prepare Stage-C project charter for dual-track rebuild (signal redesign + statistical method redesign).

## 8) Decision Log
- Date: `2026-03-03`
- Trigger artifact: `stagea_gate_result.v1.json`
- Trigger reason: Stage-A fail (`conditionA=0`, `conditionB=0`)
- Proposed next-step owner action: start rebuild scoping and resource planning in April 2026 window.
