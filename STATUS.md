# OpenAlice Plan Implementation Status

Updated: 2026-05-04

## Completed

- Added `safePathComponent` with focused path-component validation and tests.
- Applied dynamic runtime route tag validation to selected route/sweep artifact paths.
- Added provider isolation regression coverage for Vercel AI model construction and Agent SDK env injection.
- Fixed Agent SDK env isolation so inherited `ANTHROPIC_BASE_URL` cannot leak into profiles without an explicit `baseUrl`.
- Added `generateStructuredObject` / `generateZodJsonObject` structured JSON helper with usage normalization, text-json fallback, fenced JSON extraction, and compatibility usage side-channel.
- Added versioned `RuntimeCheckpointStore` with atomic JSON writes, safe runId/namespace path segments, diagnostics, load/save/clear tests.
- Added append-only decision reflection ledger writer/reader/context builder with JSONL diagnostics and useful-reflection filtering.

## Tests Run

- `corepack pnpm exec vitest run src/core/path-safety.spec.ts`
- `corepack pnpm exec vitest run src/ai-providers/vercel-ai-sdk/model-factory.spec.ts src/ai-providers/agent-sdk/query.spec.ts`
- `corepack pnpm exec vitest run src/runtime/llm_json_generation.spec.ts`
- `corepack pnpm exec vitest run src/runtime/runtime_checkpoint.spec.ts`
- `corepack pnpm exec vitest run src/runtime/decision_reflection_ledger.spec.ts`
- `corepack pnpm exec vitest run src/core/path-safety.spec.ts src/ai-providers/vercel-ai-sdk/model-factory.spec.ts src/ai-providers/agent-sdk/query.spec.ts src/runtime/llm_json_generation.spec.ts src/runtime/runtime_checkpoint.spec.ts src/runtime/decision_reflection_ledger.spec.ts`
- `corepack pnpm exec tsc --noEmit --pretty false`
- `git diff --check`

## Remaining Risks

- No business LLM call site was migrated because this branch does not currently contain `governance-context-agent.ts`, `refresh_market_intel_context.ts`, `continuous_improvement_loop.ts`, or existing `generateZodJsonObject` callers.
- Checkpoint store is not integrated into scripts yet; integration should happen one script at a time with explicit resume/fresh semantics.
- Reflection ledger context is intentionally not injected into prompts by default.
- No YAML prompt governance, multi-turn DeepSeek reasoning replay, new persistence dependency, or release/promotion artifact path migration was introduced.

## Next Suggested PRs

- Migrate the first real LLM JSON caller to `generateStructuredObject` once the target caller exists in this branch.
- Integrate `RuntimeCheckpointStore` into one long-running script with `--resume`, `--fresh`, and optional `--run-id`.
- Write `decision.pending` events from the first market-intel or governance decision producer once the producer exists in this branch.
- Gate any reflection-context prompt injection behind an explicit flag and keep it disabled by default.
