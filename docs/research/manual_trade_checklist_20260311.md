# Manual Trade Checklist

Date: `2026-03-11`

Use this before every manual trade attempt.

## Minimum Go Conditions

All of these must be true:

- `expertQuantDecision.tradeAllowed = true`
- `expertQuantDecision.action = long`
- `expertQuantDecision.confidence >= 0.35`
- `expertQuantDecision.components.totalScore >= 0.35`
- `expertQuantDecision.blockedBy` is empty
- `news.riskScore < 0.45`
- ML is available and aligned with the strategy direction
- `ml.confidence >= 0.58`
- `abs(ml.expectedReturnPct) >= 0.05`

If any item is false, do not trade.

## Hard No-Trade Conditions

Do not trade when any of these is true:

- only `mlEnsemblePredict` looks good, but `expertQuantDecision` does not
- only a single strategy signal looks good, but ML and news do not agree
- `expertQuantDecision.blockedBy` contains any blocker
- `news.riskScore >= 0.45`
- runtime checks are failing
- reconnect drift is unresolved

## Daily Limits

- maximum manual trade attempts per day: `2`
- maximum concurrent symbol exposure: `1`
- only `BTC/USD`
- no discretionary shorting in this temporary mode

## Stop Rules

Stop trading immediately for the day if any of these happens:

- daily realized loss reaches your personal cutoff
- two consecutive losing attempts occur
- `riskOff` / news risk spikes materially
- heartbeat or connector health becomes uncertain
- any reconciliation alert appears

## Mode Reminder

This checklist is for `human-in-the-loop` only.

It does not authorize autonomous live trading.
