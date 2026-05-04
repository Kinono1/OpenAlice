# OpenAlice Integration Plan v1

Last updated: `2026-03-26`

## Goal

Turn **OpenAlice** into the primary long-lived trading operating system and absorb the strongest capabilities from the other crypto repos without turning the codebase into an unmaintainable monolith.

Primary intent:
- better decision quality
- clearer buy / hold / sell recommendations
- stronger post-trade review
- gradual path toward execution assistance

## Decision

Use **OpenAlice as the host platform**.

Do **not** merge repos wholesale.
Instead:
- identify the strongest capability from each repo
- extract the underlying pattern / module boundary
- re-implement or adapt it into OpenAlice's extension + runtime model

## Why OpenAlice is the host

OpenAlice already has the right system shape:
- persistent brain / memory
- event log
- cron / heartbeat
- connectors (web / telegram / MCP)
- wallet workflow
- risk guards
- runtime governance
- paper/live split
- extension-oriented structure

This makes it a better long-term platform than the other repos, which are stronger in narrower areas.

## Source repos and what to absorb

### 1. TradingAgents-crypto
Absorb for:
- multi-agent market analysis
- analyst role decomposition
- structured research synthesis
- market + social + news + fundamentals collaboration

What to import conceptually:
- market analyst
- social/news analyst
- fundamentals analyst
- bull/bear synthesis pattern
- trader/risk report handoff shape

Target OpenAlice destination:
- new extension: `src/extension/research-desk/`

### 2. CryptoTrade
Absorb for:
- reflection / post-trade review
- trade-outcome feedback loop
- chain + off-chain mixed reasoning pattern
- benchmark-style evaluation mindset

What to import conceptually:
- daily reflection after trade outcomes
- structured "what worked / what failed / what to do next" loop
- explicit regime and information-priority review

Target OpenAlice destination:
- new extension: `src/extension/reflection-engine/`
- optional runtime hook under `src/runtime/`

### 3. AlphaSwarm
Absorb for:
- execution orchestration ideas
- strategy-to-action translation
- multi-chain / DEX routing abstractions
- alert / execution workflow concepts

What to import conceptually:
- strategy runtime interface
- chain-agnostic execution abstraction
- execution-intent object before order placement
- optional Telegram/alert coupling

Target OpenAlice destination:
- extend `src/extension/crypto-trading/`
- optionally add `src/extension/execution-router/`

## Integration principles

### Principle 1 — analysis first, execution last
Order of work:
1. research / analysis
2. reflection / review
3. execution enhancements

### Principle 2 — preserve current safe baseline
Do not break the current trusted baseline:
- `BTC/USD`
- `demoTrading=true`

### Principle 3 — do not bypass runtime governance
Any absorbed capability must still honor:
- paper/live gate separation
- wallet workflow
- risk guards
- event log
- replayability / auditability

### Principle 4 — every new capability must expose structured outputs
New modules should emit machine-usable objects, not only prose.
At minimum:
- thesis
- confidence
- risks
- invalidation conditions
- suggested action
- suggested size / aggressiveness
- supporting evidence references

### Principle 5 — build as extensions, not ad-hoc patches
Prefer:
- `src/extension/...`
- `src/runtime/...`
- explicit tool registration
- explicit event-log integration

Avoid:
- copying foreign repos into `vendor/`
- deep cross-repo imports
- hidden side effects
- duplicate config systems

## Proposed target architecture

```text
OpenAlice
├── Brain / Memory / Event Log / Connectors / Cron
├── Risk / Wallet / Paper-Live Governance
├── Research Desk            ← absorb TradingAgents-crypto ideas
├── Reflection Engine        ← absorb CryptoTrade ideas
└── Execution Router         ← absorb AlphaSwarm ideas
```

## Delivery roadmap

## Phase 0 — design and boundary lock
Objective:
- define exact extension boundaries and avoid architecture drift

Outputs:
- this plan doc
- module map
- first implementation slice choice
- explicit non-goals

Stop condition:
- one implementation slice is chosen and boundary is clear

## Phase 1 — research desk slice
Objective:
- add a multi-agent crypto research layer inside OpenAlice

Scope:
- no live execution changes
- no multi-chain routing yet
- focus on decision-support quality

Deliverables:
- `src/extension/research-desk/`
- analyst roles for at least:
  - market
  - news/social
  - fundamentals/on-chain (depending on available data)
- structured research report object
- integration with current chat / decision flow
- ability to answer prompts like:
  - analyze BTC today
  - analyze ETH under current market conditions
  - summarize bullish and bearish case

Success criteria:
- Alice can produce a structured research packet on demand
- output is stored / logged for later review
- output can feed risk / decision tools

Stop condition:
- one smoke task runs end-to-end with stable structured output

## Phase 2 — reflection engine slice
Objective:
- add a post-trade review loop

Deliverables:
- `src/extension/reflection-engine/`
- post-trade review artifact format
- event-log-driven review hook
- operator-facing summary:
  - what happened
  - why it happened
  - what to change next time

Success criteria:
- after a paper or demo trade, Alice can generate a review packet
- review packet updates memory / review log without changing trade history

Stop condition:
- at least one demo-trade review is reproducible from logs

## Phase 3 — execution router slice
Objective:
- improve execution abstraction without weakening existing risk controls

Deliverables:
- execution intent schema
- route selection abstraction
- optional exchange/DEX routing layer
- explicit pre-trade policy checks before route submission

Success criteria:
- Alice can transform a decision into a route-ready execution intent
- execution remains blocked when governance or risk checks fail

Stop condition:
- paper execution path consumes the new intent object safely

## First implementation slice (recommended)

Choose this first:

### `research-desk` for crypto decision support

Reason:
- highest value
- lowest execution risk
- best fit for user-facing asks like:
  - should I buy BTC today?
  - what is the bullish / bearish case for ETH?
  - what order setup makes sense under current conditions?

## Concrete v1 research-desk scope

### In scope
- multi-agent crypto analysis orchestration
- structured output packet
- reusable analyst prompts
- integration with OpenAlice chat/runtime layer
- logging + persistence

### Out of scope
- autonomous live trading
- automatic order placement from research-desk outputs
- direct repo-to-repo code import from external projects
- multi-chain execution routing

## Suggested module breakdown

```text
src/extension/research-desk/
  index.ts
  types.ts
  orchestrator.ts
  analysts/
    market.ts
    news_social.ts
    fundamentals.ts
    synthesis.ts
  tools/
    market_context.ts
    crypto_news_context.ts
    onchain_context.ts
```

## Core output contract (draft)

```ts
interface ResearchDeskDecisionPacket {
  instrument: string;
  timestamp: string;
  thesis: string;
  stance: "buy" | "hold" | "sell" | "watch";
  confidence: number;          // 0-1
  timeHorizon: string;
  bullishCase: string[];
  bearishCase: string[];
  keyRisks: string[];
  invalidationSignals: string[];
  suggestedEntryIdeas: string[];
  suggestedExitIdeas: string[];
  sizingNotes: string[];
  evidence: Array<{ source: string; note: string }>;
}
```

## Testing plan

### Smoke tests
1. BTC/USD daily research request
2. ETH/USD daily research request
3. output packet persistence
4. event-log recording
5. chat response rendering

### Full tests later
1. integrate with current expert decision path
2. feed packet into risk checks
3. attach to paper executor advisory path
4. run repeated daily research cycles

## Risks

### Risk 1 — repo bloat
Mitigation:
- extension boundary
- no wholesale code copy
- explicit output contracts

### Risk 2 — duplicate decision logic
Mitigation:
- research-desk produces inputs to current decision layer
- do not silently replace existing runtime decision contracts on day one

### Risk 3 — execution drift
Mitigation:
- no execution changes in phase 1
- preserve wallet + guard path as system of record

### Risk 4 — data-source mismatch
Mitigation:
- start with currently available crypto + news + research tools already in OpenAlice
- treat external repo ideas as prompt/orchestration patterns first

## Non-goals for v1

- not rewriting OpenAlice around another repo
- not replacing current wallet / guard / gate model
- not turning on automatic live trading
- not promising all four repos will coexist as runtime dependencies
- not broadening symbol coverage before the first slice works on the baseline path

## Immediate next actions

1. approve `research-desk` as the first integration slice
2. map existing OpenAlice tools/data paths that can feed crypto analyst roles
3. draft the `ResearchDeskDecisionPacket` type and minimal orchestrator
4. implement one smoke path:
   - ask Alice to analyze `BTC/USD`
   - get a structured packet
   - log it
   - display it in chat / operator surface

## Operator success criterion

The plan is working when the user can ask something like:

- "分析今天 BTC 能不能买"
- "给我 ETH 的多空理由"
- "如果我要挂单，给我 entry / stop / invalidation 建议"

and OpenAlice returns a structured, evidence-backed, risk-aware answer without needing live execution enabled.
