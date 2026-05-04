# OpenAlice Master Forward-Port Intervention

## Goal

Rebuild the active `work/kino-mainline` capabilities on top of the latest
`master` architecture without attempting a raw branch merge.

This branch is the staging area for that work:

- `integrate/master-forward-port-20260403`

## Why raw merge failed

The latest `master` has moved major subsystems into new paths:

- trading: `src/domain/trading/*`
- market data: `src/domain/market-data/*`
- MCP server: `src/server/mcp.ts`

The older work branch still carries most custom behavior under:

- `src/extension/crypto-trading/*`
- `src/openbb/*`
- `src/plugins/mcp.ts`

That makes this a forward-port, not a conflict-resolution merge.

## Path mapping

### Trading

- `src/extension/crypto-trading/wallet/Wallet.ts`
  -> `src/domain/trading/git/TradingGit.ts`
- `src/extension/crypto-trading/wallet/Wallet.spec.ts`
  -> `src/domain/trading/git/TradingGit.spec.ts`
- `src/extension/securities-trading/wallet/SecWallet.ts`
  -> `src/domain/trading/git/TradingGit.ts`
- `src/extension/securities-trading/wallet/SecWallet.spec.ts`
  -> `src/domain/trading/git/TradingGit.spec.ts`
- `src/extension/crypto-trading/*dispatcher*`
  -> `src/domain/trading/*` and `src/domain/trading/guards/*`
- `src/extension/crypto-trading/providers/ccxt/*`
  -> `src/domain/trading/brokers/ccxt/*`

### Market data

- `src/openbb/crypto/client.ts`
  -> `src/domain/market-data/client/openbb-api/crypto-client.ts`
- `src/openbb/equity/*`
  -> `src/domain/market-data/client/openbb-api/equity-client.ts` and related types
- `src/openbb/currency/*`
  -> `src/domain/market-data/client/openbb-api/currency-client.ts`

### Server / connectors

- `src/plugins/mcp.ts`
  -> `src/server/mcp.ts`
- `src/connectors/web/routes/health.ts`
  -> no direct equivalent yet on `master`; must be reintroduced into the current web stack
- `src/connectors/web/routes/signals.ts`
  -> likely needs redesign against current `src/connectors/web/routes/trading.ts`
- `src/connectors/web/web-plugin.ts`
  -> current `src/connectors/web/web-plugin.ts` on `master`

### Provider integration

- `src/ai-providers/vercel-ai-sdk/*`
  -> same path on `master`, but behavior differences must be ported file-by-file

## Phase progress

### Done in this branch

- Ported crypto historical symbol fallback into:
  - `src/domain/market-data/client/openbb-api/crypto-client.ts`
- Added new tests for that fallback:
  - `src/domain/market-data/client/openbb-api/crypto-client.spec.ts`
- Ported sync idempotency and duplicate-update collapsing into:
  - `src/domain/trading/git/TradingGit.ts`
  - `src/domain/trading/UnifiedTradingAccount.ts`
- Added or updated tests for those behaviors:
  - `src/domain/trading/git/TradingGit.spec.ts`
  - `src/domain/trading/UnifiedTradingAccount.spec.ts`
- Ported the CCXT-side crypto authority modules into the production initialization path:
  - added `src/domain/trading/brokers/ccxt/CcxtTradingEngineAdapter.ts`
  - `AccountManager.initAccount(...)` now installs the CCXT crypto execution bridge for `CcxtBroker` accounts
  - `UnifiedTradingAccount` now supports an execution override hook so CCXT accounts can use the crypto dispatcher without changing IBKR / Alpaca paths
- Ported the branch workflow governance layer from `work/kino-mainline` into the current forward-port branch:
  - added `data/config/branch_workflow.v1.json`
  - added `scripts/branch_policy*.mjs`
  - added `.githooks/pre-push`
  - documented the current `master -> integrate -> work/kino-mainline` loop
- Promoted the CCXT crypto authority path from internal wiring to operator-visible runtime:
  - account config now supports `cryptoExecution`
  - `/api/trading/config/runtime` now exposes process/web/signal readiness plus per-account crypto execution runtime
  - `TradingPage` now shows operator readiness cards and CCXT execution badges
- Ported a self-contained subset of the `work/kino-mainline` research contract toolkit:
  - added `src/backtest/fdr.ts`
  - added `scripts/validate_research_contracts.py`
  - added `scripts/verify_environment_lock.py`
  - added `docs/research/templates/*` contract schemas and example payloads
- Ported the next builder tranche of the research toolkit:
  - added `scripts/build_evidence_graph.py`
  - added `scripts/build_paper_cards.py`
  - added `scripts/build_gate_checkpoints.py`
  - added missing support templates such as `go_no_go_evidence_pack.template.json` and `ci_exit_code_map.v1.json`
- Ported the decision-packet assembler itself:
  - added `scripts/build_decision_packet.py`
  - added `docs/research/templates/champion_registry.schema.v1.json`
- Ported the remaining self-contained backtest primitive layer from `work/kino-mainline`:
  - added `src/backtest/statistical_significance.ts`
  - added `src/backtest/risk_simulation.ts`
  - added `src/backtest/release_gate.ts`
  - added `src/backtest/index.ts`
- Started the current-architecture replacement for the old strategy tree:
  - added `src/domain/strategy/governance/*`
  - added `src/domain/strategy/event-calendar/*`
  - added `src/tool/strategy.ts`
  - registered strategy tools in `src/main.ts`
- Extended that replacement into the first factor layer:
  - added `src/domain/strategy/factors/*`
  - `src/tool/strategy.ts` now exposes factor evaluators and factor-ensemble scoring
- Reintroduced the current web stack deltas already present in the worktree and re-verified them through focused tests:
  - `src/connectors/web/routes/health.ts`
  - `src/connectors/web/routes/signals.ts`
  - `src/connectors/web/routes/security.ts`
  - `src/connectors/web/web-plugin.ts`
- Completed the MCP / Vercel AI SDK forward-port slice and restored compile-clean status.

### Verified

These targeted tests pass on this integration branch:

- `src/domain/market-data/client/openbb-api/crypto-client.spec.ts`
- `src/domain/trading/git/TradingGit.spec.ts`
- `src/domain/trading/UnifiedTradingAccount.spec.ts`
- `src/domain/trading/operation-dispatcher.spec.ts`
- `src/domain/trading/brokers/ccxt/CcxtTradingEngineAdapter.spec.ts`
- `src/domain/trading/account-manager.spec.ts`
- `src/connectors/web/__tests__/security.spec.ts`
- `src/connectors/web/__tests__/health-signals.spec.ts`
- `src/connectors/web/__tests__/chat-sse-limits.spec.ts`
- `src/connectors/web/__tests__/config-protection.spec.ts`
- `src/server/mcp.spec.ts`
- `src/ai-providers/vercel-ai-sdk/model-factory.spec.ts`
- `src/ai-providers/vercel-ai-sdk/vercel-provider.spec.ts`
- `./node_modules/.bin/tsc --noEmit`
- `pnpm branch:policy:show`
- `pnpm branch:policy:check`
- `pnpm branch:policy:can-merge -- --source work/kino-mainline --target integrate/master-forward-port-20260403`
- `./node_modules/.bin/vitest run src/connectors/web/__tests__/trading-runtime.spec.ts src/connectors/web/__tests__/health-signals.spec.ts src/connectors/web/__tests__/config-protection.spec.ts src/domain/trading/account-manager.spec.ts src/domain/trading/UnifiedTradingAccount.bridge.spec.ts src/domain/trading/brokers/ccxt/CcxtTradingEngineAdapter.spec.ts ui/src/pages/TradingPage.spec.tsx`
- `./node_modules/.bin/vitest run src/backtest/fdr.spec.ts`
- `python3 scripts/validate_research_contracts.py --inputs docs/research/templates/examples --output /tmp/openalice_research_contract_verify_report.json`
- `python3 scripts/verify_environment_lock.py --lock docs/research/templates/environment_lock.v1.json --output /tmp/openalice_environment_verify_report.json` (expected failure on this machine due version mismatch)
- `python3 scripts/build_evidence_graph.py ...` smoke run with example paper card (passed)
- `python3 scripts/build_paper_cards.py ...` smoke run with temporary manifest/note/text fixture (passed after relative-note-path fix)
- `python3 scripts/build_gate_checkpoints.py ...` smoke run with temporary reports/verdict fixture (passed)
- `python3 scripts/build_decision_packet.py ...` smoke run in v5 mode with temporary release-gate / verdict / checkpoint fixtures (passed)
- `./node_modules/.bin/vitest run src/backtest/fdr.spec.ts src/backtest/risk_simulation.spec.ts src/backtest/statistical_significance.spec.ts src/backtest/release_gate.spec.ts`
- `./node_modules/.bin/vitest run src/domain/strategy/governance/governance.spec.ts src/domain/strategy/event-calendar/freeze-rules.spec.ts`
- `./node_modules/.bin/vitest run src/domain/strategy/governance/governance.spec.ts src/domain/strategy/event-calendar/freeze-rules.spec.ts src/domain/strategy/factors/factors.spec.ts`

## Next forward-port targets

### Priority 1

- Review the `work/kino-mainline`-only research / decision-packet script bundle and explicitly classify each script as:
  - keep and port
  - superseded by current branch artifacts
  - archive only
- Remaining unported items are now concentrated in builder/orchestration scripts, not low-level contract machinery.
- The largest remaining unported runtime-adjacent script is now `run_strategy_mvp_validation.ts`, which still depends on the removed legacy strategy paths.
- The blocker for `run_strategy_mvp_validation.ts` is now sharply bounded:
  - the backtest primitive layer under it is ported
  - the missing pieces are the old `src/extension/analysis-kit/*` and `src/extension/strategy-tools/*` paths
- Current strategy work should now proceed through `src/domain/strategy/*` instead of reviving the old extension tree.
- Decide whether the current CCXT bridge should stay per-operation or be upgraded to commit-aware batch execution before any raw merge reassessment.
- Optional follow-up: promote the CCXT bridge from per-operation dispatch to commit-aware batch execution if commit-level `commit.started` / `commit.completed` event semantics become operationally important.
- Optional follow-up: add explicit account-level configuration for crypto risk/ticket policies instead of using bridge defaults only.

### Priority 2

- Review whether the newly reintroduced health/signal/security routes should be exported through any additional UI navigation or operator docs.

### Priority 3

- Only residual work here is broader functional coverage if more provider variants are introduced.

## Notes

- The current branch also shows an untracked `scripts/` directory relative to
  `master`; those files are not part of this first forward-port pass.
- Do not reattempt a raw merge from `work/kino-mainline` into `master`.
  Continue porting behavior module-by-module.
