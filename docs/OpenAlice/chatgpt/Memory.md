# OpenAlice ChatGPT Memory

## Purpose
- Rolling handoff memory for ChatGPT/Codex work inside `docs/OpenAlice/chatgpt/`.
- Read this file (and any future `task_plan.md`, `findings.md`, `progress.md` siblings) before touching the code so you start from the same high-level view.

## Current State
- OpenAlice is a file-driven AI trading desk bundled with Claude Code CLI + Vercel AI SDK providers, connectors (Web UI, Telegram, MCP Ask), and a persistent event log/brain in `data/brain`.
- Core architecture exposes a centralized ToolCenter/ProviderRouter plus extension stacks for crypto trading, securities trading, news collection, guard enforcement, brain/emotion tracking, and cron/heartbeat tasks.
- Configuration is stored under `data/config/` (e.g., `agent.json`, `crypto.json`, `risk.json`, `connectors.json`) and validated with Zod loaders inside `src/core/config.ts`.
- Branch workflow follows `work/kino-mainline`, `dev`, and `master` with enforcement scripts (`pnpm branch:policy:*` commands and `.githooks` pre-push hooks).

## Recent Actions
- Added the new strategy suite: `strategyGetSignal`, `strategyBacktest`, and `strategyCompare` tools plus the ensemble strategy that mixes `trend`, `meanReversion`, and `breakout` votes with configurable weighting and cost modeling (fees, slippage, funding, latency).
- Hardened pre-trade safety by wiring the guard pipeline into crypto order execution and centralizing limits in `data/config/risk.json` (max position size, leverage, daily loss, cooldowns) referenced by the wallet `stage/commit/push` flow.
- Delivered the ML ensemble prediction stack (`mlEnsemblePredict` tool, `scripts/ml_ensemble_v1.py`, and `scripts/ml_ensemble_eval.ts`) along with the `pnpm ml:eval` CLI that runs OKX-based evaluation runs against `data/market/okx_historical` candles.
- Documented dataset and pipeline playbooks in README (recent additions list) and reaffirmed the job schedule guard commands (`scripts/daily_strategy_*`, `run_strategy_mvp_validation.ts`, `strategy_pipeline_health_check.ts`).

## Key Facts
- Wallet operations follow a git-like flow (`walletStage`, `walletCommit`, `walletPush`) recorded in `data/crypto-trading/` and `data/securities-trading/` with full event-log replication in `data/event-log/events.jsonl`.
- Brain/emotion state persists under `data/brain/`; connect with `data/default/persona.default.md` + `data/brain/persona.md` overrides and heartbeat prompts mirroring `data/default/heartbeat.default.md`.
- Providers are switchable at runtime via `ai-provider.json` (`claude-code` default, `vercel-ai-sdk` optional) with session state captured in `data/sessions/*.jsonl`.
- Guard/cron/heartbeat tasks surface through `scripts/strategy_*`, `scripts/daily_strategy_*`, and the `task/cron/` + `task/heartbeat/` folders.
- Geography of configs: `data/config/branch_workflow.v1.json` for branch rules, `docs/branch-workflow-policy.md` as the policy reference, `docs/mcp-ask-connector.md` for MCP connectors, and README.md for architecture/context summaries.

## Decisions
- `work/kino-mainline` is the active work branch; merges only flow through the documented three-branch policy enforced via `scripts/branch_policy*.{mjs,sh}`.
- Keep all mutable session memory under `docs/OpenAlice/chatgpt/*` (Memory + future task/finding/progress files) so Codex/ChatGPT always knows where to look.
- Default to Claude Code CLI for local runs while keeping the Vercel AI SDK option ready via `ai-provider.json` + `api-keys.json` so future experiments can swap providers without touch ups.
- Data and model config edits happen in JSON under `data/config/`, with the TypeScript Zod loaders in `src/core/config.ts` ensuring validation before runtime.

## Relevant Scripts
- `scripts/run_openalice_completion.ts`: production entry point that drives the AI conversation loop and writes to `data/events` + `data/sessions` while honoring connectors/cognition.
- `scripts/run_okx_historical_pipeline.sh`: orchestrates the OKX download/import pipeline (`okx_download_*`, `okx_materialize_training_csv.ts`) responsible for `data/market/okx_historical` datasets used by strategy search + ML eval.
- `scripts/ml_ensemble_v1.py` & `scripts/ml_ensemble_eval.ts`: build/evaluate the ML ensemble predictors that feed `mlEnsemblePredict`; `pnpm ml:eval` invokes the TypeScript runner.
- `scripts/strategy_pipeline_health_check.ts`: exercises the guard/strategy pipeline, ensuring core7 jobs are healthy before letting wallets push trades.
- `scripts/run_strategy_mvp_validation.ts`: validation harness for new strategy proposals before they are committed into the guard pipeline or wallet commit history.
- `scripts/daily_strategy_optimize.sh` (and companion `daily_strategy_*` helpers): cron-driven maintenance for strategy health, queue draining, and optimization loops mentioned in README recent-additions.

## Blockers
- Real trading requires exchange API keys (OKX/Binance/Bybit via `crypto.json`, and Alpaca via `securities.json`) plus guard values; defaults are inert, so the agent can run only in demo mode until secrets are populated.
- Telegram/MCP/Web connectors still need channel credentials configured in `data/config/connectors.json` before remote delivery can be tested end-to-end.
- `data/market/okx_historical` downloads are sizable; re-runs of `scripts/run_okx_historical_pipeline.sh` may be needed if old artifacts expire before future ML evaluations.

## Next Steps
1. Keep the README + docs/branch references in sync when we add new strategy tools or guard limits so future sessions can quickly orient around changes.
2. Populate connectors + exchange secrets, then run `scripts/daily_strategy_health_check.sh` and `scripts/strategy_pipeline_health_check.ts` to baseline the guarantee pipeline.
3. Touch `docs/OpenAlice/chatgpt/task_plan.md`, `findings.md`, and `progress.md` in upcoming sessions so the Memory file has companion detail logs.

## Update Process (note)
- After each substantial ChatGPT/Codex session, summarize what changed, what was verified, and what still blocks you in this file.
- Mirror the same updates into `docs/OpenAlice/chatgpt/task_plan.md`, `findings.md`, and `progress.md` so future sessions can resume without rereading full conversations.
- Always mention the filenames and dates of files you touched when updating the memory so the handoff is explicit.
