# OpenAlice Architecture v2 — P0 Baseline

## Repository bindings

| Repository | Local branch | Base/upstream commit | Role |
| --- | --- | --- | --- |
| OpenAlice | `refactor/openalice-architecture-v2` | `fdff003939cc1fbebe4637e028d0234ce2718cb4` | sole control plane and execution authority |
| TradingAgents | `integration/openalice-sidecar-v2` | `a33fd4c0f134485a43553a2c23a63cb14adbd88f` | research-only sidecar |
| AlphaSwarm | `integration/openalice-sidecar-v2` | `cbee91f6fcd07655d17a799f6fe35746c6bdd7a8` | research-only sidecar |

The Sidecar commits were resolved from `origin/main` immediately before the
worktrees were created. Dependency locks and final integration commits are
recorded again after forward-porting.

## Isolation guarantees

- The original dirty worktrees remain the migration sources and are not reset,
  cleaned, rebased, merged, staged, or committed.
- Runtime data, logs, model artifacts, decision artifacts, `.env` files, and
  credential-bearing material are not migration source code.
- Migration is additive and does not delete source or target files.
- The running primary remains on the original release until canary, rollback,
  credential-rotation, and time-based gates are satisfied.
- `TradingAgents-crypto` is recorded as `retired_missing_dependency`; its old
  status bytes must not be rewritten to imply success.

## Admission baseline

- `paperTradingAllowed=false`
- `liveTradingAllowed=false`
- `liveExecutionArmed=false`
- accounts remain empty
- both Sidecars remain `research_only`

Engineering test success cannot change these values. Paper admission requires a
fresh continuous seven-day evidence window. Live admission requires a fresh
continuous thirty-day evidence window, all cost/risk gates, and two-person
approval. This implementation does not arm or send live orders.

## Credential-rotation blocker

Previously exposed credential classes are treated as compromised. New values
and revocation confirmation must be supplied through an external `0600` file or
system secret store. Until that occurs, the final primary cutover is
`BLOCKED: credential_rotation_incomplete`.
