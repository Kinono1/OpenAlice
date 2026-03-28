# OpenAlice System Assembly

## Summary

OpenAlice is assembled from a single composition root in `src/main.ts`. The runtime starts synchronously for core infrastructure, then injects crypto trading asynchronously when CCXT finishes initialization.

## Scope

In scope:

- bootstrap order
- object ownership
- persistence responsibilities
- hot-reload points
- delayed crypto injection
- shutdown flow

Out of scope:

- per-strategy math
- archived research scripts
- detailed browser subsystem internals

## Bootstrap Sequence

1. `loadConfig()` loads unified config from `data/config/*.json`.
2. `configureGlobalNetworkProxy()` applies outbound proxy if configured.
3. `createCryptoTradingEngine(config)` starts in the background with retries.
4. Security and persistence infrastructure is built:
   - `DecisionTicketStore`
   - `IntentLedger`
   - `TradeIdempotencyStore`
   - `KillSwitch`
   - `PnLTracker`
5. Securities engine and persisted states load in parallel:
   - wallet state
   - securities wallet state
   - brain state
   - persona
6. Wallets are assembled:
   - `SecWallet` immediately
   - crypto wallet later, after CCXT init resolves
7. `Brain` is restored or created and bound to `data/brain/*`.
8. `EventLog` is created on `data/event-log/events.jsonl`.
9. `CronEngine` is created against `EventLog`.
10. `NewsCollectorStore` is restored.
11. OpenBB clients are created:
    - equity
    - crypto
    - currency
    - economy
    - commodity
    - news
12. `ToolCenter` registers tool groups incrementally.
13. Providers are wired:
    - `VercelAIProvider`
    - `ClaudeCodeProvider`
    - `ProviderRouter`
14. `AgentCenter` and `Engine` are created.
15. `ConnectorCenter` is created and subscribes to `message.received`.
16. Runtime tasks start:
    - cron engine
    - cron listener
    - heartbeat
    - optional news collector
17. Core and optional plugins start:
    - MCP
    - Web
    - Telegram
    - MCP Ask
18. Background CCXT promise resolves:
    - `LiveGateManager`
    - crypto wallet
    - crypto tools registration
19. Shutdown handlers stop collectors, tasks, plugins, stores, and engines.
20. Main loop sleeps on `config.engine.interval`.

## Object Relationships

| Object | Created by | Reads | Writes | Hot Reload |
| --- | --- | --- | --- | --- |
| `Config` | `loadConfig()` | `data/config/*.json` | seeded defaults | yes, per-section |
| `ToolCenter` | `src/main.ts` | tool disabled list | none | yes, tools re-read on request |
| `ProviderRouter` | `src/main.ts` | `ai-provider.json` | none | yes |
| `SessionStore` | connectors / cron | `data/sessions/*.jsonl` | same | yes |
| `EventLog` | `src/main.ts` | `data/event-log/events.jsonl` | same | live append |
| `ConnectorCenter` | `src/main.ts` | event subscription | none | connector reconnect |
| `Brain` | `src/main.ts` | `data/brain/commit.json` | brain files | persistent |
| `Wallet` | `src/main.ts` | wallet state json | wallet state json | rebuilt on reconnect |
| `LiveGateManager` | `src/main.ts` | release gate, market data | daily summaries | rebuilt on reconnect |

## Persistence Anchors

- brain: `data/brain/*`
- crypto wallet: `data/crypto-trading/commit.json`
- securities wallet: `data/securities-trading/commit.json`
- intent ledger: `data/crypto-trading/intents.jsonl`
- idempotency state: `data/runtime/trade_idempotency.json`
- event log: `data/event-log/events.jsonl`
- sessions: `data/sessions/*.jsonl`

## Hot-Reload Anchors

- AI backend: `data/config/ai-provider.json`
- tools disabled list: `data/config/tools.json`
- agent evolution mode and Claude settings: `data/config/agent.json`
- connectors: `data/config/connectors.json`
- crypto and securities engines: rebuilt on reconnect functions

## Delayed Injection

Crypto is intentionally delayed because CCXT market loading and exchange auth are slower and failure-prone. The rest of the runtime starts without blocking on crypto, then registers crypto tools only after:

- engine init succeeds
- `LiveGateManager` is created
- crypto wallet is restored

This makes the runtime available for chat, web UI, cron, heartbeat, and non-crypto tools before exchange connectivity stabilizes.

## Shutdown Path

Shutdown order:

1. stop news collector
2. stop heartbeat
3. stop cron listener
4. stop cron engine
5. stop plugins
6. close news store
7. close event log
8. close crypto and securities engines

## Evidence

- `fact-code`: `src/main.ts`
- `fact-code`: `src/core/config.ts`
- `fact-code`: `src/core/tool-center.ts`
- `fact-code`: `src/core/connector-center.ts`
- `fact-code`: `src/task/cron/engine.ts`
- `fact-code`: `src/task/heartbeat/heartbeat.ts`
- `fact-operational`: `README.md`
- `fact-test`: `src/task/cron/engine.spec.ts`
- `fact-test`: `src/task/heartbeat/heartbeat.spec.ts`

## Stop Reason

- stop_reason: `exit_condition_met`
