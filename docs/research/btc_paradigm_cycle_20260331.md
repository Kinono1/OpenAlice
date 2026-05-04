# BTC Paradigm Cycle 2026-03-31

## Goal

Execute the first cross-repo BTC paradigm program under the unchanged OpenAlice BTC route policy and determine whether any new donor-inspired source factory is strong enough to justify promotion or bounded refinement.

## Fixed Policy

- symbol: `BTC/USD`
- protocol profile: `phaseb_native_v1`
- `multipleTestingUnit = candidate`
- `fdrMethod = bh`
- `wfoProfile = stable`

## Inputs

- `TradingAgents`
  - strict request artifact:
    - `data/research/strategy/paradigms/tradingagents/btc_strict_request.latest.json`
  - live sidecar was attempted through the donor repo runtime
  - runtime blockers encountered:
    - broken donor `.venv`
    - missing `python-dotenv`
    - missing `socksio`
    - eventual long-running sidecar timeout
  - a traceable fallback proxy decision was then emitted to preserve a route-evaluable contract:
    - `data/research/strategy/paradigms/tradingagents/btc_research_decision.latest.json`
- `alphaswarm`
  - execution-context proxy:
    - `data/research/strategy/paradigms/alphaswarm/btc_execution_context.latest.json`
- `CryptoTrade`
  - reflection/narrative proxy:
    - `data/research/strategy/paradigms/cryptotrade/btc_reflection_context.latest.json`

## Comparison Outputs

- registry:
  - `docs/research/btc_paradigm_registry_v1.json`
- comparison summary:
  - `data/research/strategy/analysis/btc_paradigm_comparison_20260331.json`
  - `data/research/strategy/analysis/btc_paradigm_comparison_20260331.md`

## Outcome

- strongest paradigm:
  - `tradingagents_research_sidecar`
- comparison recommendation:
  - `stop`

### Per-paradigm metrics

- `tradingagents_research_sidecar`
  - `meanPbo = 1.0000`
  - `meanDsrProbability = 0.2473`
  - `fdrQ = 1.0`
  - `totalGap = 1.952708`
  - `meanSharpe = 1.7418`
- `alphaswarm_execution_context`
  - `meanPbo = 1.0000`
  - `meanDsrProbability = 0.2046`
  - `fdrQ = 1.0`
  - `totalGap = 1.995424`
  - `meanSharpe = 1.4924`
- `cryptotrade_reflection_narrative`
  - `meanPbo = 1.0000`
  - `meanDsrProbability = 0.2242`
  - `fdrQ = 1.0`
  - `totalGap = 1.975789`
  - `meanSharpe = 1.4726`

## Decision

No paradigm is near the incumbent BTC frontier.

Do not:

- run bounded refinement on this specific first-pass paradigm trio
- promote any of the three to matrix or combo work
- treat the current donor-proxy versions as frontier candidates

The new evidence is still useful:

- the cross-repo paradigm program is now executable end-to-end
- the comparison contract is no longer hypothetical
- the first donor-inspired candidate factories failed cleanly under the same BTC gates

## Next Move

The next profitable move is not parameter refinement inside these same first-pass proxies.

It should be one of:

- get a real `TradingAgents` research decision from a completed live sidecar run, not only the local proxy fallback
- replace the `alphaswarm` and `CryptoTrade` proxy inputs with richer donor-native state artifacts
- design second-generation donor compilers that are materially less trend-like than the current v1 candidate families
