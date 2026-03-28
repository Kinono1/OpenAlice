# Manual Signal Operating Mode

Date: `2026-03-11`

## Purpose

This document defines the temporary赚钱模式 for OpenAlice before `G3` passes:

- OpenAlice does not auto-trade live
- OpenAlice acts as a structured signal and context workstation
- the human operator remains the final execution layer

## Default Operating Mode

Use OpenAlice in `analysis-first, execution-manual` mode.

That means:

- OpenAlice generates structured trade context
- you decide whether to place the trade manually
- OpenAlice does not get treated as an autonomous executor

## Tool Hierarchy

### Primary tool

`expertQuantDecision`

Use this first because it already combines:

- strategy signal selection
- optional ML ensemble prediction
- news impact
- release gate context
- composite decision output

Treat it as the default front door for every manual trade idea.

### Secondary tools

`strategyCompare`

Use when you need a quick baseline ranking before trusting a specific strategy family.

`strategyGetSignal`

Use when you want to inspect one strategy in isolation after `expertQuantDecision` suggests a direction.

### Reference-only tool

`mlEnsemblePredict`

Use as supporting evidence only.

It must not be used as a standalone reason to trade.

## Required Calling Pattern

For manual analysis mode, use `expertQuantDecision` with:

- `requireReleaseGatePass=false`
- `useMl=true`
- `strategySelection=auto_rotate`

Reason:

- current formal release gate still blocks promotion
- you still need structured analysis output during demo / human-in-the-loop mode
- disabling `requireReleaseGatePass` here is only for analysis visibility, not for authorizing auto-execution

## Allowed Uses

- generate a structured long/short/flat view
- compare strategy family alignment
- inspect whether ML, news, and rule-based signals agree
- reject low-quality setups quickly

## Disallowed Uses

- treating `tradeAllowed=true` as permission for unattended live trading
- using a single ML output as a trade trigger
- using a single strategy signal as a trade trigger
- using `manual_override` to convert analysis mode into stealth live automation

## Final Execution Rule

Any actual capital deployment remains manual until:

- `G3` passes
- runtime remains healthy
- non-empty fill restart recovery is validated

Until then, OpenAlice is a decision aid, not an autonomous trader.

Current status:

- a minimal real WIF round-trip has already confirmed trade permission and non-empty fill recovery
- this does not change the policy that ongoing use remains human-in-the-loop
