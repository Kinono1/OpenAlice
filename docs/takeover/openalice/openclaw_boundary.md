# OpenAlice OpenClaw Boundary

## Summary

`src/openclaw/` is a large embedded browser and agent subsystem, but the current OpenAlice trading mainline only imports a narrow slice of it through the browser adapter. This note exists to stop future readers from misclassifying OpenClaw as the trading runtime core.

## Scope

In scope:

- current import boundary from OpenAlice mainline into OpenClaw
- operational role of the browser subsystem
- why OpenClaw is support rather than mainline

Out of scope:

- full OpenClaw architecture
- browser relay deployment details

## Actual Mainline Touchpoint

Current mainline import path:

- `src/main.ts`
  - registers `createBrowserTools()`
- `src/extension/browser/adapter.ts`
  - wraps `createBrowserTool()` from `src/openclaw/agents/tools/browser-tool.ts`

This means the current trading/runtime mainline depends on OpenClaw only as a browser capability provider.

## What OpenClaw Is Not

OpenClaw is not currently:

- the composition root
- the provider router
- the wallet or exchange executor
- the paper gate or simulation runtime
- the main cron / heartbeat control plane

## What OpenClaw Is

OpenClaw is currently:

- a bundled browser automation subsystem
- the backing implementation for the `browser` tool
- a support-area dependency that can produce screenshots, navigation, and browser control side effects

## Classification Decision

Final classification:

- `src/openclaw/` = `support`

Reasoning:

- it does have side effects
- it does have large code surface area
- but the active trading mainline uses it through one adapter boundary rather than as a central execution substrate

## Practical Rule

When reading OpenAlice:

- read `src/openclaw/` only after the active trading/runtime path is already understood
- treat `src/extension/browser/adapter.ts` as the true boundary file
- do not infer from subtree size that OpenClaw is the current system center

## Evidence

- `fact-code`: `src/main.ts`
- `fact-code`: `src/extension/browser/adapter.ts`
- `fact-code`: `src/openclaw/agents/tools/browser-tool.ts`
- `fact-operational`: `README.md`
- `fact-operational`: `docs/takeover/openalice/module_classification.md`
- `evidence_relationship`: `supports`

## Stop Reason

- stop_reason: `exit_condition_met`
