# OpenAlice Critical Runtime Sequence

## Summary

The critical runtime chain is the paper-first path that turns approved research artifacts into simulated and then demo-paper execution. The hard stop condition is `paperGate.finalAllowPaperTrading`.

## Scope

In scope:

- champion registry loading
- release and paper gate evaluation
- data and execution contracts
- runtime-faithful simulation
- paper executor commit selection
- wallet-driven execution

Out of scope:

- legacy G3/G4 loops
- archive research packets
- UI rendering details

## Strict Sequence

1. `loadPaperChampionRegistry()`
2. `validatePaperChampionRegistryForRuntime()`
3. `loadReleaseGateStatus()`
4. `evaluateDataContract()` per symbol
5. `evaluatePaperGateStatus()`
6. `runRuntimeFaithfulSimulation()`
7. `selectRunnableSimulationCommits()`
8. `buildWalletOperationsFromSimulationCommit()`
9. `Wallet.add() -> commit() -> push()`
10. `PaperExecutorJournal` append

## Inputs, Outputs, Hard Blocks

| Layer | Input | Output | Hard Block |
| --- | --- | --- | --- |
| Champion registry | registry json | normalized registry | missing registry, checksum mismatch, identity mismatch |
| Release gate | persisted release gate status | `allowPaperTrading` context | release gate blocking |
| Data contract | aligned bar data | data quality result | duplicates, missing bars, incomplete bars, invalid OHLC, clock skew |
| Execution semantics | candidate intent | intent validation | stale, no client order id, submit before close, long-only violation |
| Paper gate | booleans + champion validation | `finalAllowPaperTrading` | any false among 9 gate booleans |
| Runtime simulation | registry + bars + flags | simulation artifact | unsupported family, failing paper gate |
| Paper executor | simulation artifact + journal | runnable commits | already executed or paper gate false |
| Wallet execution | operations | persisted commit history | dispatcher rejection or exchange failure |

## Nine Paper Gate Conditions

- researchApproved
- runtimeHealthy
- dataFresh
- dataQualityValid
- connectorHealthy
- riskLimitsLoaded
- championLoaded
- policyVersionMatch
- paperExecutorEnabled

All nine must pass. `finalAllowPaperTrading` is not advisory.

## Runtime-Faithful Simulation Details

Simulation does all of the following before an operation becomes executable:

- bar alignment across symbols
- strategy evaluation using registry params
- event-block checking
- correlation screening
- concurrency cap
- veto decider handling
- execution intent validation
- stale-intent rejection

The artifact written by `run_runtime_faithful_simulation.ts` is the bridge object between research/runtime contracts and the paper executor.

## Troubleshooting Order

If paper execution does not happen, check in this order:

1. registry file exists and passes checksum
2. release gate status allows paper
3. paper gate booleans all pass
4. runtime simulation emits commits
5. journal is not already consuming every commit
6. wallet push reaches dispatcher successfully
7. exchange engine is online and not rejecting

## Evidence

- `fact-code`: `src/runtime/paper_champion_registry.ts`
- `fact-code`: `src/runtime/release_gate_status.ts`
- `fact-code`: `src/runtime/data_contract.ts`
- `fact-code`: `src/runtime/execution_semantics.ts`
- `fact-code`: `src/runtime/paper_gate_status.ts`
- `fact-code`: `src/runtime/runtime_faithful_simulation.ts`
- `fact-code`: `src/runtime/paper_demo_executor.ts`
- `fact-code`: `src/runtime/paper_executor_journal.ts`
- `fact-code`: `scripts/run_runtime_faithful_simulation.ts`
- `fact-code`: `scripts/run_paper_demo_executor_cycle.ts`
- `fact-test`: `src/runtime/runtime_faithful_simulation.spec.ts`
- `fact-test`: `src/runtime/paper_gate_status.spec.ts`
- `fact-test`: `src/runtime/paper_demo_executor.spec.ts`

## Stop Reason

- stop_reason: `exit_condition_met`
