# Real Trade WIF Test

Date: `2026-03-11`

## Objective

Confirm three things with the smallest possible real trade:

- the OKX key has real trade permission
- OpenAlice can open and close a real position through its execution path
- `data/crypto-trading/pnl-fills.jsonl` can become non-empty

## Test Configuration

- symbol: `WIF/USD`
- venue: `OKX swap`
- mode at test time: real trading
- budget ceiling: `<= 0.5 USDT`

## Observed Round-Trip

### Open

- orderId: `3379610448694452224`
- side: `buy`
- filledPrice: `0.1631`
- filledSize: `1`

### Close

- orderId: `3379610560766255104`
- side: `sell`
- `reduceOnly=true`
- filledPrice: `0.1630`
- filledSize: `1`

Observed round-trip notional was approximately `0.3261 USDT`, which stayed below the allowed `0.5 USDT` ceiling.

## Account Impact

- balance before: `19.657509451383937`
- balance after: `19.657246401383937`

## Fill Persistence

`data/crypto-trading/pnl-fills.jsonl` now contains two real fills:

1. `buy WIF/USD`
2. `sell WIF/USD`

## Decision

- `trade permission confirmed`: yes
- `non-empty pnl-fills generated`: yes
- `budget respected`: yes

## Boundary

This test proves the real trade path works.

It does **not** authorize autonomous live trading.
