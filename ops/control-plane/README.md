# OpenAlice control plane

This directory is the versioned, receipt-bound replacement for the
workspace-level `launch/` status files. The historical files remain byte
preserved and untrusted as current evidence.

Supported commands:

- `control run [check-id...]` executes registered argv arrays and writes
  `validation_receipt.v1` records. Commands are never persisted in receipts;
  only their digest and redacted output summaries are recorded.
- `control refresh` derives `controller_state.v1` only from receipts bound to
  the current commit, dirty-state hash, TTL, and artifact hashes.
- `control check` validates state and receipt bindings.
- `control status` prints a compact read-only summary.
- `control render` writes a read-only Markdown report.

There is deliberately no command for forcing paper/live admission, arming live
execution, closing a circuit breaker, or resetting runtime evidence.
