# Workstream Map V1

Last updated: `2026-03-13`

## Purpose

Break the paper-first quant program into 6 expert workstreams so implementation does not mix research, exchange semantics, risk, and runtime glue.

## Workstreams

1. `alpha_research_gate`
   - owns family hypotheses, promotion thresholds, trial accounting, robustness, concentration warnings
2. `okx_data_contract`
   - owns symbol resolution, bar completion, timestamp rules, clock skew, duplicate/missing bar handling
3. `execution_semantics`
   - owns signal-at-close semantics, order deadlines, `clOrdId`, timeout reconciliation, stale-order rules
4. `portfolio_paper_gate`
   - owns exposure caps, fast/slow correlation override, paper gate structure, champion loading rules
5. `ai_veto_audit`
   - owns whitelist inputs, reason codes, intervention-rate guardrails, counterfactual monthly review
6. `runtime_simulation_paper_executor`
   - owns runtime-faithful simulation, wallet/journal flow, scheduler integration, operator pause/resume rules

## Sequence

- finish workstreams `1-4` before coding the executor
- finish workstream `5` before turning on any automatic paper trading
- finish workstream `6` before any promotion toward live
