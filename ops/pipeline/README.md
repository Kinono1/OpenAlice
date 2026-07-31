# Pipeline registry

`pipeline_registry.v1.json` is the declarative inventory for every tracked or
non-ignored file under `scripts/`. Each entry declares ownership, lifecycle,
entrypoint, aliases, inputs/outputs, safety, lock, timeout, network policy,
evidence TTL, and scheduling ownership.

`cron_definitions.v1.json` contains the immutable definition side of the 32
legacy Cron jobs. It deliberately contains no mutable job state. Existing
error counts and circuit history remain in `data/cron/jobs.json`; closing a
circuit requires a separate operator receipt.

Run `python3 ops/pipeline/build_registry.py --check` in CI. Any unregistered
script, stale registry entry, missing Cron entrypoint, duplicate task ID,
enabled gated-improvement task, or unpaused external-storage dependency fails
the check.
