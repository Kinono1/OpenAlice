# OpenAlice Task Plan

Last updated: `2026-03-18`

## Read Order Rule

For any new Codex session working on OpenAlice:

1. read `chatgpt/Memory.md`
2. read this file
3. read `chatgpt/findings.md`
4. read `chatgpt/progress.md`

Do not start implementation from memory alone.

## Update Rules

- This file must always reflect the current active plan, not a historical plan.
- Replace outdated steps when the decision path changes.
- Keep completed items in a short “recently completed” section instead of leaving them in the active queue.
- Every task must have:
  - objective
  - why it matters
  - concrete output
  - stop condition

## Active Objective

User-directed priority shift on `2026-03-26`:

- start an **OpenAlice integration design v1** workstream
- treat **OpenAlice as the host platform**
- plan how to absorb the strongest capabilities from:
  - `TradingAgents-crypto`
  - `CryptoTrade`
  - `alphaswarm`
- recommended first implementation slice:
  - `research-desk` crypto decision-support extension

The earlier directional `BTC/USD 1h` research-closure work remains valid historical context, but it is no longer the only active planning lens for the next session.

## Why This Is The Active Objective

- the lawful paper-promotion bridge now exists in code
- runtime observability and diagnostic paths are already validated against real OpenBB data
- the latest bounded falsification sprint answered the current research question directly:
  - `volBreakout` final pack: `NO_GO` under all 3 allowed FDR variants
  - `volTrend` final pack: `NO_GO` under all 3 allowed FDR variants
- there is no exploratory `GO`, so no canonical rerun and no promotion lane were entered
- the blocker remains research quality, not runtime:
  - `PBO` still fails hard
  - `DSR` still fails hard
  - `releaseGateAllowPaper` remains false
- the Binance sidecar line also clarified a second constraint:
  - current local Binance raw shards stop at `2026-02`
  - the repo-native `2026-03` monthly refresh attempt returned `missing=6`
  - cross-venue work is therefore blocked by source-window availability, not by a proven runtime issue
- the next real step is therefore not scheduler work, not champion activation, and not more refinement of the same two directional families

## Active Plan

### P0 — Close the current directional family line

Objective:
- treat `volBreakout` and `volTrend` on `BTC/USD 1h` as closed after the final bounded methodology pass

Required inputs:
- `/tmp/openalice-research-final/track_a_summary.json`
- `/tmp/openalice-research-final/track_a_closure_note.md`
- `docs/research/stage_c_round4_arch_review_20260311.md`
- `docs/research/stage_c_round4_mapping_experiment_20260311.md`

Constraints:
- keep the current market scope at `OKX swap-only + BTC/USD + 1h + long-only + demoTrading=true`
- no live promotion
- no release-gate override
- no fabricated champion registry
- no promotion from `volNoTradeFilter`
- do not reopen the same two directional families unless a new architecture review explicitly re-authorizes them

Required outputs:
- one short closure memo stating why the current directional family line is closed
- one short shortlist for the next research direction:
  - new family
  - new timeframe
  - or new venue/data surface

Stop condition:
- the next session no longer treats `volBreakout` / `volTrend` refinement as active mainline work

### P0 — Keep runtime baseline stable

Objective:
- preserve `BTC/USD + demoTrading=true` as the safe operating baseline

Required checks:
- `/api/crypto/account`
- `/api/dev/registry`
- `/api/heartbeat/status`
- `/api/chat -> OPENAI_OK`
- `/api/dev/send -> delivered=true`

Stop condition:
- runtime remains healthy while research work proceeds

### P1 — Decide the Binance data-source path

Objective:
- replace the old generic “Binance alignment repair” idea with one concrete data-source plan

Required inputs:
- `/tmp/openalice-trackb/track_b_preflight.json`
- `/tmp/openalice-trackb/binance_alignment_diagnosis.v1.json`
- `docs/research/binance_core7_alignment_round2_20260311.md`

Constraints:
- do not assume the current blocker is a merge-code bug
- do not start arbitrary pipeline code edits before a source-window plan exists
- do not reopen arbitrage / cross-venue strategy work until a refreshed Binance window actually exists

Required outputs:
- one explicit choice for the next Binance step:
  - wait for monthly shard availability
  - add a daily/API refresh path
  - or find another local/offline source for the missing window

Stop condition:
- the next Track B session starts from a specific source strategy instead of a vague “fix Binance”

## Recently Completed

- final bounded directional falsification sprint:
  - `12`-candidate `volBreakout` pack
  - `12`-candidate `volTrend` pack
  - `3` allowed FDR variants each
  - all `6` runs ended `NO_GO`
- Track B Binance refresh preflight:
  - repo-native `2026-03` monthly refresh attempt returned `missing=6`
  - fresh alignment diagnosis still returned `keep_arbitrage_closed`

- automatic `OKX demo paper executor` cycle runtime module
- `paper_executor_journal` runtime module
- `paper:execute:cycle` CLI entrypoint
- `runtime-faithful simulation` runtime module
- `runtime-faithful simulation` CLI entrypoint
- `DataContract` runtime module
- `ExecutionSemanticsContract` runtime module
- `PaperChampionRegistry` runtime module
- `paperGate` runtime module
- `paper/live` release-gate split in `LiveGateManager`
- Contract freeze set created in root `chatgpt/`:
  - `alpha_contract_v1.md`
  - `runtime_contract_v1.md`
  - `paper_acceptance_v1.md`
  - `reproducibility_fingerprint_v1.md`
- Round 4 mapping strategy implementation:
  - `volNoTradeFilter`
  - `volBreakout`
  - `volTrend`
- Round 4 candidate generation + runner tooling
- First full Round 4 end-to-end run across `BTC / ETH / SOL`
- First real `WIF/USD` trade-permission test
- `pnl-fills.jsonl` non-empty generation
- TypeScript `PnLTracker` restore validation
- Full-process non-empty fill restart validation
- Stage-C architecture review
- `feature_horizon_redesign`
- Round 1 keep-seed and Round 2 kill-seed analysis
- Binance alignment diagnosis
- Repo hygiene pass v1

## Explicit Boundaries

Do not do these unless the user explicitly changes direction:

- do not turn on automatic live trading
- do not rebuild `decision_packet`
- do not widen symbol coverage
- do not reopen direct forward-return prediction
- do not expand to multiple new strategy families
- do not reopen arbitrage research before Binance alignment is repaired

## If Current Phase Succeeds

Success means:
- one directional family clears research promotion and is ready for runtime-faithful simulation plus automatic demo execution

Then the next plan should be:
- keep the same target
- load the champion into a paper registry
- validate runtime-faithful simulation
- promote into the OKX demo paper executor

## If Current Phase Fails

Failure means:
- no new research direction is selected after the current directional family line is closed

Then the next plan should be:
- return to architecture review
- prioritize the Binance data-source decision
- stop spending effort on the closed `volBreakout` / `volTrend` line

## Immediate Integration Deliverables

1. write the design doc:
   - `chatgpt/openalice_integration_plan_v1.md`
2. choose the first slice:
   - `research-desk`
3. map target destination modules in OpenAlice:
   - `src/extension/`
   - `src/runtime/`
   - `src/core/tool-center.ts`
4. define the first structured output packet for crypto decision support
5. implement a smoke path only after the module boundary is explicit

## Session Close Rule

At the end of every relevant session:

- update this plan if active priorities changed
- otherwise leave it unchanged and write only to `progress.md`
