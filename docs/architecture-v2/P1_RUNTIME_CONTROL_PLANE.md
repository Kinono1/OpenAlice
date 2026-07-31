# P1 runtime and control-plane implementation

## Scope

This phase adds the receipt-bound control plane, runtime-role isolation,
declarative pipeline inventory, deterministic Cron reconciliation, and a
modular composition root. It does not grant paper or live admission.

## Runtime roles

- `primary` retains the legacy data/config/log defaults and is the only role
  capable of owning Cron, initializing accounts, or writing shared data.
- `canary` uses isolated state, artifacts, logs, and alternate Web/MCP ports.
  It cannot own Cron, initialize accounts, submit orders, write Promotion
  state, write shared data, or invoke non-read-only HTTP APIs.
- `test` requires an explicit root below the operating-system temporary
  directory and has the same fail-closed capabilities as Canary.

Legacy path environment variables remain supported through `RuntimePaths`.

## Control plane

`ops/control-plane/control.py` executes only registered argv arrays with
`shell=False`. Each check emits a redacted `validation_receipt.v1` bound to:

- source commit;
- clean/dirty source state and dirty-state hash;
- declared input hashes;
- output hashes and bounded redacted tails;
- declared artifact hashes;
- execution/expiry timestamps and exit status.

`refresh`, `check`, `status`, and `render` can only derive state from receipts.
Missing, stale, failed, dirty-source, commit-mismatched, dirty-hash-mismatched,
or artifact-mismatched receipts remain blocked. There is no force-admission,
unlock, circuit-reset, approval, or execution-arm command.

## Pipeline and Cron ownership

`pipeline_registry.v1.json` inventories all 607 current files below
`scripts/`. `cron_definitions.v1.json` is the immutable definition source for
the 32 stable task IDs. At startup, the Cron engine reconciles definitions by
stable ID and:

- migrates the legacy full-job file additively;
- writes only stable IDs, enablement, timestamps, and runtime state to
  `data/cron/jobs.json`;
- stores user-created agent reminder definitions separately;
- preserves error, last-success, fingerprint, and open-circuit history;
- refuses to clear an open circuit without a commit-bound operator receipt;
- keeps five external-storage jobs paused and the gated-improvement job
  disabled.

The OKX warehouse wrapper now resolves an already-installed local `pnpm`
without downloading or activating a package manager. No circuit is reset by
this code change.

## Verification performed before the phase commit

- control-plane unit tests: 6 passed;
- pipeline unit tests: 2 passed;
- migration unit tests: 5 passed;
- focused runtime/config/Web/Cron tests: 83 passed;
- core Web/Cron/Heartbeat/account/CCXT/session/media regression: 385 passed;
- shell-wrapper regression: 16 passed;
- TypeScript typecheck: passed;
- full UI/backend/workspace build: passed;
- pipeline registry check: 607 entries and 32 Cron IDs;
- `git diff --check`: passed;
- scoped secret-pattern scan: no credential value found.

Final receipts must be regenerated after the phase commit so their commit and
clean-tree bindings are current.

## Admission state

This phase leaves all of the following false:

- `paperTradingAllowed`;
- `liveTradingAllowed`;
- `liveExecutionArmed`.

Credential rotation/revocation, 24-hour engineering observation, seven-day
paper/shadow evidence, and thirty-day live-admission evidence remain external
time/operations gates.
