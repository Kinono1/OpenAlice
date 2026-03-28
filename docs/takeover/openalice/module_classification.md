# OpenAlice Module Classification

## Summary

This classification separates what drives the current business-critical path from what supports it or has already been archived.

## Scope

In scope:

- active code areas that influence the current trading runtime
- support subsystems that remain operationally adjacent
- archived or demoted directories that should not be mistaken for current truth

Out of scope:

- per-file cleanup recommendations
- future reactivation scenarios for archived research

## Mainline

### Runtime control path

- `src/runtime/`
- reason:
  - active paper-first execution chain
  - consumes champion and release artifacts
  - controls execution eligibility

### Crypto execution path

- `src/extension/crypto-trading/`
- reason:
  - only active exchange-side effect path
  - owns wallet, dispatcher, risk hooks, exchange adapter, PnL continuity

### Strategy expression path

- `src/extension/strategy-tools/`
- `src/backtest/`
- reason:
  - current executable strategy families live here
  - simulation and research bridge depend on these abstractions

### Composition root and core orchestration

- `src/main.ts`
- `src/core/`
- `src/task/`
- reason:
  - all runtime object ownership and lifecycle is rooted here

## Support

### Control plane and local operator surfaces

- `src/connectors/web/`
- `ui/src/`
- `src/connectors/telegram/`
- `src/connectors/mcp-ask/`
- reason:
  - important for operation and visibility
  - not the primary trading decision or execution path

### OpenBB and data access adapters

- `src/openbb/`
- `src/extension/news-collector/`
- `src/extension/analysis-kit/`
- reason:
  - feeds the system
  - not itself the runtime decision chain

### Browser and OpenClaw subsystem

- `src/extension/browser/`
- `src/openclaw/`
- reason:
  - large embedded subsystem
  - current usage is mainly browser tool exposure
  - no direct role in the paper-first trade path

## Archive

- `docs/research/archive/`
- `scripts/archive/legacy-research/`
- legacy mirror under `docs/OpenAlice/chatgpt/`

reason:

- continuity pack and memory files explicitly demote these paths
- current task plan says not to revive archived loops

### Legacy-live governance packet

- `decision_packet/`
- reason:
  - still referenced by scripts and package commands
  - explicitly demoted from the current build target by the continuity pack
  - serves as a support-area governance and validation packet rather than the active runtime root

## Ambiguous

No unresolved classification targets remain after the pilot follow-up docs for:

- `decision_packet/`
- `src/openclaw/`

## Evidence

- `fact-code`: `src/main.ts`
- `fact-code`: `src/runtime/`
- `fact-code`: `src/extension/crypto-trading/`
- `fact-code`: `src/extension/strategy-tools/`
- `fact-code`: `src/extension/browser/adapter.ts`
- `fact-operational`: `README.md`
- `fact-operational`: `chatgpt/task_plan.md`
- `intent-doc`: `chatgpt/Memory.md`
- `intent-doc`: `chatgpt/findings.md`
- `evidence_relationship`: `supports`

## Stop Reason

- stop_reason: `exit_condition_met`
