# BTC Paradigm Program

## Goal

Replace the exhausted BTC source-regime loop with three donor-inspired candidate factories evaluated under the unchanged OpenAlice BTC route policy.

## Fixed Policy

- symbol: `BTC/USD`
- protocol: `phaseb_native_v1`
- `multipleTestingUnit = candidate`
- `fdrMethod = bh`
- `wfoProfile = stable`

## Paradigms

- `tradingagents_research_sidecar`
  - donor: `TradingAgents`
  - source: `research_decision.v1`
  - status: implemented compiler
- `alphaswarm_execution_context`
  - donor: `alphaswarm`
  - source: execution-context proxy artifact
  - status: implemented compiler with structured unavailable path
- `cryptotrade_reflection_narrative`
  - donor: `CryptoTrade`
  - source: reflection/narrative context artifact
  - status: implemented compiler with structured unavailable path

## Artifacts

- registry:
  - `docs/research/btc_paradigm_registry_v1.json`
- comparison summary:
  - `data/research/strategy/analysis/btc_paradigm_comparison_20260331.json`
  - `data/research/strategy/analysis/btc_paradigm_comparison_20260331.md`
- execution journal:
  - `data/research/strategy/execution_journal.jsonl`

## Notes

- Missing donor artifacts now produce structured `unavailable` provenance instead of silent fallback.
- Compiler outputs remain route-ready `strategy_candidates.v1` manifests so the new paradigms can be judged under the same BTC gates as the incumbent frontier.
