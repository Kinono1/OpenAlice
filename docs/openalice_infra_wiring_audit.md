# OpenAlice Infrastructure Wiring Audit

## WFO (`src/backtest/wfo.ts`)

- `createRollingWindows(totalBars, config)` → `WfoWindow[]` (train/test/embargo)
- `runStrategyWalkForward(input)` → `WfoResult<StrategyParams>`
- `evaluateWindowGate()` — degradation check: (IS_sharpe - OOS_sharpe) / |IS_sharpe| > 0.4 → overfit
- Config: `WfoConfig` with trainBars, testBars, embargoBars, stepBars, totalBars
- **Status**: EXISTS, NOT used by `continuous_improvement_loop.ts`
- **Risk**: embargo=24 prevents future leak in daily data; verify for crypto 24/7 5m bars
- **Connection point**: `continuous_improvement_loop.ts` main() — pass best configs through `runStrategyWalkForward()`

## IC Monitor (`ic-monitor.ts`)

- `FactorIcMonitor` class with `computeRollingIc()` using **Spearman Rank** (ranks)
- Config: `enabled: false` (line 30), `minSamples: 20`, `warmupWindows` NOT IMPLEMENTED
- `detectDecay()` — computes IC/IC_IR across multiple horizons
- `getConditioning()` — returns multiplierBySignal
- **Status**: EXISTS but DISABLED. No warmup protection. minSamples=20 is too low.
- **IC type**: Cross-sectional RankIC (per-symbol factor scores at same timestamp)
- **Risk**: No NaN handling in the config. minSamples=20 means IC noise at low sample counts.
- **Connection point**: Enable with `mode: 'shadow'`, add `minSampleCount: 50`, `warmupWindows: 3`

## Portfolio Allocator (`allocator.ts`)

- `allocateInverseVolatilityPortfolio(config)` → risk parity weights
- `allocateSignedRiskConstrainedPortfolio(config)` → alpha/vol sizing with net/gross exposure caps
- `computeHCAWeights()` (imported from `hca.ts`) — HRP (Lopez de Prado 2016)
- `computeBlackLitterman()` (imported from `black-litterman.ts`) — full BL posterior
- **Status**: EXISTS but NOT used by paper trading (uses equal-weight)
- **Risk**: Alpha sign semantics unverified (long bias = positive?). Vol unit unverified.
- **Connection point**: Paper trade scripts add `--allocator-shadow` to run allocator in parallel

## Cost Model (paper_trade_cross_sectional.ts)

- `PAPER_COST_MODEL` (line 484): `feeRate: 0.0006` (6bps), `slippageBps: 8`
- `estimateRoundTripCostPct()` (line 716): fee*2 + slippage/10000*2 + funding
- **Unit risk**: Returns PERCENT (0.28 = 0.28%), NOT decimal (0.0028). 100x mismatch risk.
- **Status**: Used in paper trading, hardcoded.

## EvaluatedConfig (continuous_improvement_loop.ts)

- `StrategyMetrics` interface: `signals, winRate, spreadCum, avgSpread, sharpeApprox, score`
- `evaluateConfig()` computes these from assets + params
- **NO `oosNetReturn` field** — uses `spreadCum` (cumulative return, not OOS net)
- **NO `oosSharpe` field** — uses `sharpeApprox` (IS, not annualized)
- **NO `maxDrawdown` field** — not computed in evaluateConfig
- **NO `turnoverCost` field** — cost model is separate
- **Risk**: `costAdjustedScore` needs adapter/missing_fields marker until these are added

## NaN Risk Audit

- Scanned all factor files — no direct `/0` patterns found (factors use helper functions)
- `helpers.ts` has `safeZScore()`, `winsorizedPercentileRank()`, `quantile()` — all have bounds checks
- **Low risk** in existing factors; new K-bar/volume factors must use `safeDivide()`
