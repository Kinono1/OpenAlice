# work/kino-mainline Forward-Port Parity Checklist

Date: 2026-04-03
Target branch: `integrate/master-forward-port-20260403`

## Summary

This checklist captures what remains from `work/kino-mainline` after the current forward-port pass.

Parity is considered complete when all entries marked **must-port** are either:

- implemented on the current architecture, or
- explicitly downgraded to **do-not-port** with rationale.

## Matrix

| Area | work/kino-mainline delta | Current status | Decision |
| --- | --- | --- | --- |
| Trading authority | old `wallet` + `openbb` path behavior | already rebuilt on current architecture | complete |
| CCXT crypto authority | dispatcher / idempotency / intent / kill-switch chain | installed into production CCXT account initialization path | complete |
| MCP / Vercel AI SDK | mainline provider and MCP behavior deltas | rebuilt in current `src/server` / `src/ai-providers` paths | complete |
| Web operator routes | health / signals / security surfaces | reintroduced into current web stack | complete |
| Branch governance | three-branch push / merge workflow policy | missing before this pass | must-port |
| Research contract foundation | FDR module, schema contracts, environment/runtime validators | ported in current architecture | complete |
| Research / decision packet scripts | large `scripts/` and `docs/research/` builder bundle | terminal-governance, validation, and completion slices now ported; frontier/campaign orchestration still pending | review-and-triage |
| Legacy old-path test fixes | `src/extension/*` patchups in work branch | superseded by current-architecture tests | do-not-port |
| Bulk research archives / PDFs | historical notes, registries, artifacts | not runtime-critical | do-not-port |

## Port Decisions

### Must-port now

- branch workflow policy config
- policy scripts
- pre-push hook
- minimal README/doc integration for the workflow
- `src/backtest/fdr.ts`
- research contract schemas/examples
- `scripts/validate_research_contracts.py`
- `scripts/verify_environment_lock.py`

### Review-and-triage after core merge phase

- decision packet builders
- paper-card / gate-checkpoint generators
- tradingagents failure diagnosis and terminal artifact scripts
- ML ensemble / validation scripts

Already ported from this lane:

- FDR correction module and tests
- environment lock contract
- evidence / verdict / gate / paper-card schemas
- example contract payloads
- research contract validator
- environment lock verifier
- evidence graph builder
- paper card builder
- gate checkpoint builder
- decision packet builder
- CI exit-code map template
- go/no-go evidence-pack template
- champion registry schema

Already ported from this lane:

- `scripts/run_strategy_mvp_validation.ts`
- `scripts/run_validation_pipeline.ts`
- `scripts/run_openalice_completion.ts`
- TradingAgents terminal-governance slice:
  - `scripts/assess_tradingagents_stage.ts`
  - `scripts/diagnose_tradingagents_failure_mechanism.ts`
  - `scripts/summarize_tradingagents_terminal_decision.ts`
  - `scripts/materialize_tradingagents_terminal_artifacts.ts`
  - `scripts/run_tradingagents_terminal_governance.ts`
  - supporting `scripts/lib/tradingagents_*` and `execution_journal.ts`

Still review-and-triage:

- larger frontier / paradigm batch orchestration scripts
- broader decision-packet / campaign orchestration scripts
- real paper corpus / deep-read manifest migration into current repo layout

These may still be valuable, but they are not required to complete forward-port parity for the OpenAlice runtime itself.

### Do-not-port

- any old-path file that only exists to keep `src/extension/*` compiling
- historical research archives, downloaded PDFs, and bulk generated candidate registries
- deep-read corpora, downloaded paper PDFs, and archive-only route/candidate manifests
- duplicate governance commits that do not change final behavior

## Raw Merge Reassessment Gate

Raw merge should only be reconsidered after:

1. all **must-port** items are landed
2. the remaining **review-and-triage** items are either ported or explicitly rejected
3. the current branch is compile-clean and focused-test-clean

If those conditions are met and no unique runtime capability remains on `work/kino-mainline`, raw merge should be treated as unnecessary.
