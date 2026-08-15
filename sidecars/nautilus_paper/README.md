# OpenAlice Nautilus paper sidecar ledger

Phase one starts with a Python 3.13 standard-library SQLite ledger.  It records
commands and ordered events, supplies a fenced single-writer lease, and fails
closed on idempotency-key/hash conflicts.  The current package also has a
managed in-process, local-only UDS durable-admission runtime and an optional,
explicitly configured `PAPER_LOCAL` deterministic simulator path.  It
deliberately has no TCP listener, Nautilus, broker, venue order execution,
private-credential discovery, autonomous daemon, or operating-system service
registration.  A local simulator receipt is not broker evidence.

Every command/event write requires a current `Lease`; a new owner after lease
expiry receives a higher epoch, and writers holding an earlier epoch are fenced.
An idempotency hash conflict suspends global admission: exact replays of the
original command remain readable, while every new idempotency key is rejected
until a future, explicitly designed recovery protocol clears the circuit.

`payload_hash` is mandatory: exactly 64 lowercase hexadecimal characters equal
to SHA-256 of canonical JSON (sorted keys, compact separators, UTF-8 and
unescaped non-ASCII). The ledger recomputes this hash; a new-key mismatch has
no command/event side effect, and a changed payload for an existing key trips
the circuit even when its caller reuses the old declared hash.

Phase 3 adds an in-process-only `admit_execution_command(command, permit, ...)`
path. `command` must contain exactly `schemaVersion`, `commandId`,
`payloadHash`, and `payload`, with schema `openalice_execution_command.v1`.
`commandId == payloadHash == SHA-256(canonical payload JSON)`; the durable
`command_hash` is that public `commandId`, never an implementation-defined
envelope hash. Canonical command and permit JSON are stored separately. An
exact command replay keeps the first stored permit even if a permit is later
re-signed. The path preserves its legacy generic accepted-event cursor and also
records a dedicated lifecycle accepted sequence, but never sends an order.
It also supplies `get_command_by_hash()`, `latest_cursor()`, cursor-guarded
`upsert_snapshot()` / `get_snapshot()`, and one-way `suspend(reason)`. Orders,
fills, reconciliation, Nautilus, and broker integration remain intentionally
out of scope.

Phase 4 adds a deliberately narrow local gRPC adapter in `grpc_receiver.py`.
`Handshake` binds the exact protocol/service/mode/run/proof/schema/writer-epoch
identity, while `Health` reports durable-admission readiness only (never broker
readiness) and does not implicitly renew a lease.
`Execute` validates the typed protobuf projection and exact canonical payload
and permit bytes before calling the same durable-only core. `GetCommand` reads
the original durable command, permit bytes, and accepted sequence for restart
reconciliation. `build_uds_server()` accepts only an absolute Unix-domain
socket path beneath an owner-only, non-symlink directory. A direct core remains
strictly one-worker; a managed runtime uses four bounded workers, but it does
not start, daemonize, load credentials, or connect to a
broker. gRPC binds only a random staging name; `start()` publishes the public
name with an atomic hard link while holding a per-path publication lock. An
existing public inode is never replaced, and both staging and public socket
links are mode `0600`. Nautilus execution and Paper Canary are not implemented.

Phase 5 adds the managed durable-only lifecycle in `runtime.py`:

- `RuntimeExecutor` is a bounded gateway onto one non-daemon owner thread. Only
  that thread constructs, reads, writes, renews, releases, and closes the
  SQLite ledger, `PaperSidecarCore`, and fenced writer lease.
- The runtime is the only lease acquirer. It renews at approximately one third
  of the TTL, requires an unchanged owner/name/epoch, rechecks the current lease
  before admission, and repeats lease, environment-proof, and permit-expiry
  fencing after SQLite obtains its write lock. Expected Ed25519 public keys are
  resolved and frozen before READY. The runtime permanently enters
  `WRITE_DISARMED` after lease loss, identity drift, an in-flight admission
  timeout, or an unexpected owner-thread operation failure. Re-arming requires
  a new runtime incarnation with a new UUID owner identity.
- `DURABLE_UDS_READY` requires an exact caller-supplied protocol, service, mode,
  run, proof, schema, and writer-epoch identity. It also requires explicit
  evidence that no execution client was invoked and broker submission is
  disabled. It means only `durable_admission_ready_not_broker_ready`.
- Start requires absolute paths beneath existing owner-only, non-symlink
  directories. Any pre-existing socket inode, including an apparently stale
  socket, blocks start and is never auto-unlinked. A socket created by this
  runtime is mode `0600` and is removed on clean stop only while its recorded
  device/inode identity still matches.
- Stop first closes the admission gate, drains already-enqueued work in FIFO
  order, expires the current lease without deleting its epoch, and closes the
  ledger on its owner thread. A replaced socket path or a permanently blocked
  Python callback is a fail-closed process-restart boundary, not a clean stop.

If a queued admission times out before the owner begins it, the request is
cancelled and cannot later write. If the owner has already begun, its durable
outcome is explicitly `runtime_submission_unknown`: admission is permanently
disarmed, and the caller must reconcile by `commandId` through `GetCommand`.
The same timeout is derived from an incoming gRPC deadline. A command may have
become durable in this unknown case, but it still has not been submitted to a
broker.

The pathname replacement guarantee assumes the local process boundary used by
this package: an owner-only directory and cooperating publishers using the
publication lock. A hostile process already running under the same Unix UID is
outside that boundary and requires operating-system/process isolation.

Phase B adds a read-only execution lifecycle model without claiming broker
terminal state:

- `lifecycle_events.sequence` is a dedicated, contiguous sequence beginning at
  one. It is never filtered from or reused from generic `events.cursor`.
  Admission writes the generic audit event, a strict hash-bound
  `openalice_execution_event.v1` `acknowledged` event, and the command row in
  one `BEGIN IMMEDIATE` transaction. Exact duplicates return the original
  `accepted_sequence` and append nothing.
- Opening a legacy database atomically adds `accepted_sequence` and
  deterministically backfills one acknowledged event per existing execution
  command in accepted-cursor order. Every stored lifecycle event is canonical
  UTF-8 JSON and is revalidated against its hash and redundant database columns
  on read; a malformed row or sequence gap fails closed.
- A lease-protected Python-only `append_lifecycle_event()` boundary exists for
  a future execution adapter. The ledger, not its caller, allocates sequence and
  event ID, and refuses events for unknown commands. No gRPC method exposes an
  arbitrary lifecycle write. Hash binding proves stored-event integrity, not
  broker provenance or execution authenticity; until a separately admitted
  adapter establishes that source boundary, even terminal-looking fixture or
  simulated events must not finalize idempotency as a broker terminal result.
- `lifecycle_snapshots` is separate from legacy `snapshots`; a generic
  `as_of_cursor` is never silently treated as a lifecycle sequence. Snapshot
  bytes are exact canonical UTF-8, opaque diagnostics. Reading them does not
  assert submission, fill, cancellation, rejection, or any broker terminal
  state.
- `GetSnapshot`, `ReplayEvents`, and `StreamEvents` are implemented over this
  dedicated model. Replay limits are `1..1000`; account/symbol scope and uint64
  sequences are strict. `StreamEvents` first catches up and then bounded-polls
  until cancellation, deadline, or shutdown. At most two streams are active,
  leaving at least two of the runtime's four gRPC workers for `Health` and
  `Execute`. The owner-thread gateway keeps snapshot/replay reads available in
  `WRITE_DISARMED` until stop.

Phase C1 adds an opt-in local simulator execution/recovery path without adding
an external simulator-mutation RPC:

- `OfflineExecutionRuntimeConfig` accepts one canonical V3 offline policy, a
  pre-provisioned owner-private simulator database, and four distinct Ed25519
  authority roles. The runtime snapshots and verifies the policy, key IDs, and
  public-key fingerprints before its owner thread starts. Request data cannot
  replace a policy, key, clock, store identity, or signer.
- The Runtime owner thread constructs one Ledger, one simulator store, one
  Core, and one `OfflineExecutionCoordinator`. The Coordinator is rebound to
  the exact renewed fenced lease. A command is placed on the internal offline
  backlog only after the `RuntimeExecutor` admission Future is complete. This
  is an in-process caller-ordering guarantee, not a gRPC wire-delivery timing
  guarantee.
- Startup scans incomplete dispatches in accepted-command order. A verified
  existing signed source effect is committed before admission opens. If an
  old-epoch attempt has no effect, startup leaves it
  `RECONCILIATION_REQUIRED`, publishes `WRITE_DISARMED`, rejects all further
  admission, and retains bounded Python/raw-gRPC reads until stop. It never
  blind-creates a takeover effect.
- Simulator effects form a signed global store chain. The Ledger independently
  anchors that chain and atomically advances the anchor with the signed
  simulator-only receipt and V2 lifecycle event. The supported invariant is
  one simulator store identity to one Ledger/logical owner.
- The protobuf service method set is unchanged. `Execute` remains the only
  signed admission mutation; there is no RPC to issue a capability, call the
  simulator, commit a receipt, or mutate reconciliation state.

The managed Python read methods remain available after write disarm, while the
Node writer bootstrap intentionally accepts writable READY only. A separate
Node diagnostic assembly verifies an exact READ_ONLY identity, exposes frozen
command/lifecycle/receipt read facades only, binds one frozen receipt trust
policy, loads no permit private key, and never exposes the raw transport or
`Execute`. Health cursor rollback, identity/epoch drift, or malformed read data
permanently poisons that client; a transport that has observed READ_ONLY cannot
be rearmed as READY.

Test-only direct Node-to-Python UDS coverage verifies READY admission,
duplicate replay, signed simulator-only receipt retrieval, clean restart, and
the old-epoch missing-effect READ_ONLY boundary with no new receipt or effect.
The fixture has an explicit test-only environment marker, a credential-free
child environment, fixed public test keys, and no CCXT, Nautilus, broker, or
network dependency. The existing application CCXT account composition is not
used for this local path because it initializes a broker and loads markets.

The runtime is still not a launch daemon or operating-system service manager.
D1 adds one formal foreground `PAPER_LOCAL` supervisor; an external operator
or service manager must start and monitor it. Test-only real-process recovery
now covers a durable
`DISPATCH_PENDING` before claim, `IN_FLIGHT` before a source effect, a durable
signed source effect before receipt commit, and a committed receipt before the
`RuntimeExecutor.admit()` caller returns. The first three cut points use
`os._exit`; the last uses parent `SIGKILL`. A fresh runtime then proves the
expected single effect/receipt or the missing-effect read-only boundary. This
is a Runtime caller-boundary test, not evidence that gRPC response bytes were
delivered before an effect.

Deterministic Runtime lease tests also expire the constructor-pinned fencing
clock after Runtime/Coordinator preflight but before each target Ledger write
transaction begins. The transaction's first trusted post-`BEGIN IMMEDIATE`
sample rejects the stale lease without receipt, effect, source-head, or
terminal lifecycle side effects. A failed startup publishes neither READY nor
a listener; a fresh incarnation can recover an existing effect or expose the
supported missing-effect read-only state. Expiry after a transaction's trusted
fencing sample is not reclassified as an unauthorized transaction: that sample
is the documented SQLite serialization/fencing point.

D1 adds three fail-closed production-admission components without adding any
broker path:

- `supervisor.py` accepts exactly one explicit owner-private config. It holds a
  process-lifetime `flock`, creates a random per-incarnation UDS under the
  configured private run root, loads four policy-pinned and mutually distinct
  Ed25519 roles, and starts only `RuntimeExecutor` with the offline simulator
  coordinator. It has no restart/rearm loop, environment discovery, dependency
  installation, broker client, or network client. A disarmed runtime remains
  read-only until the process is stopped.
- `verify_release_environment.py` must be executed by the candidate venv with
  `-I -S -B`; disabling `site` prevents an unverified `.pth` or
  `sitecustomize` file from running before validation. The canonical runtime
  contract pins CPython 3.13.5 on macOS 26 arm64, the resolved interpreter and
  `pyvenv.cfg` byte hashes, deterministic aggregates of the complete base
  CPython runtime and `site-packages` trees, exactly six wheel distributions
  and their complete RECORD-backed installation closure, the minimal
  hash-required lock and wheel manifest, the proto, and generated bindings.
  Extra or undeclared files,
  distributions, environment pollution, symlink/path drift, or a different
  interpreter fail closed. The verifier never installs or downloads anything.
  The checked-in contract deliberately has `runtimeProvenance.status=unfrozen`;
  it cannot issue a pass receipt until a separately approved, exact minimal
  venv has been provisioned and all five provenance hashes are reviewed and
  frozen in source.
- `release_manifest.v2` binds the immutable environment receipt and the exact
  seven D1 validation receipts as hashed release artifacts. The release copy
  allowlist excludes Python tests, fixed-key UDS test servers, crash harnesses,
  dependency provisioners, caches, and the broad research dependency lock.
  `ops/release/launch_nautilus_paper.sh` is the only supported entrypoint. It
  requires an absolute Node binary plus its exact SHA-256 and an independently
  pinned `OPENALICE_PAPER_LOCAL_MJS_SHA256`. Before Node can read candidate
  JavaScript, the shell rejects a non-canonical, symlinked, service-writable,
  mis-owned, group/world-writable, or hash-mismatched fixed-name `.mjs`
  sibling (and checks the complete parent hierarchy), then starts that launcher
  through `env -i`. The launcher accepts only an
  explicit release ID or `research-current`, re-verifies the complete release
  closure, frozen runtime provenance, candidate interpreter, and environment,
  then launches the foreground supervisor with `site` disabled and a minimal
  credential-free environment. It never falls back to the existing CCXT
  account composition.

  **D1 deployment prerequisite — separate publisher/service identities.** The
  manifest hashes are not an access-control boundary: a service UID that can
  replace a release pathname can change a file after verification but before
  Node or Python executes it. The service manager must therefore run the
  launcher as a non-root service UID and pass the numeric
  `OPENALICE_RELEASE_PUBLISHER_UID` for a *different* trusted publisher UID.
  At launch, the `.mjs` fails closed unless the selected release tree (including
  `ops/release/launch_nautilus_paper.sh` and `.mjs`) is publisher-owned,
  contains no group/world-writable entry, and is not effectively writable by
  the service UID. It also checks every canonical ancestor from the release
  root to `/`: each must be owned by that publisher or root, have no
  group/world write bit, and deny the service UID write access. This prevents a
  writable parent from replacing `research-current` or the verified release.
  A future authorized publisher phase must materialize the stable sibling pair
  `runtime/bin/launch_nautilus_paper.{sh,mjs}`; the current one-shot cutover is
  not allowed to do so for V2. The shell forwards its own canonical path, and
  the `.mjs` requires exactly that fixed-name sibling pair to be
  publisher-owned and service-unwritable under one protected hierarchy. It
  additionally hashes both materialized files against the selected release
  manifest's two launcher artifacts. An arbitrary external copy, a pair split
  across directories, or byte drift is rejected.

  This ownership boundary is an external deployment requirement, not evidence
  that can be established by the release manifest. In particular, the shell
  and `.mjs` must already be in the protected publisher-owned hierarchy before
  the service invokes the shell. The service manager's protected configuration
  must fix the shell path and the MJS hash; a shell cannot establish its own
  pre-execution trust after the OS has already loaded it. Otherwise a same-UID
  attacker can replace the bootstrap before its checks run. Filesystem ACLs/MAC policy must likewise not
  grant the service UID write permission (the launcher tests effective
  `W_OK`, but the OS/service configuration remains authoritative). The shell
  applies the same owner/mode/effective-write rule to the pinned Node binary
  and every ancestor before hashing and executing it. Before every Python
  spawn, Node strictly derives the base prefix from `pyvenv.cfg`, recursively
  verifies and hashes the complete base-runtime and `site-packages` trees, and
  verifies the venv, requested/resolved interpreter, config, and ancestors.
  The Python verifier independently repeats the deployment-mode UID,
  owner/mode/effective-write, base-runtime, venv, RECORD, and site closure
  checks. Any binding change between environment verification, config check,
  and foreground start is rejected. These checks establish the code contract;
  a formal pass still requires an operator to provision the matching protected
  OS hierarchy.

  The existing `research_cutover` is **not** a D1 one-shot deployment path: for
  every V2 manifest its preflight returns
  `paper_local_two_identity_deployment_required` before changing a pointer,
  materializing a wrapper, or touching launchd. The generic launchd helper is
  also plan-only for V2: non-dry-run V2 use is rejected before creating
  directories, copying files, writing a plist, or calling launchctl; its V2
  plist preview fixes the interpreter to `/bin/sh`. Generic V2 research-pointer
  activation and rollback are likewise rejected before pointer or receipt
  writes. None of these helpers creates users, performs `chown`, or proves a
  service UID different from the publisher. A separately authorized deployment
  must therefore have two OS-level phases: (1) the
  trusted publisher builds/seals the release and materializes the pair into its
  protected hierarchy; (2) a trusted service administrator installs a
  protected job that runs as a distinct non-root service identity and pins
  `OPENALICE_RELEASE_PUBLISHER_UID` and
  `OPENALICE_PAPER_LOCAL_MJS_SHA256` to that publisher's sealed artifacts.
  The service administrator must also provide a
  `paper_local_service_execution_control_attestation.v1` proving an OS-enforced
  policy that denies that service identity interactive login and arbitrary
  direct interpreter execution, permits only the fixed protected launcher and
  arguments, and binds the service UID, launchd domain/label, canonical plist,
  policy profile, launcher pair, Node, and Python hashes. Without that control,
  the service UID could bypass shell/MJS verification and invoke the Python
  supervisor directly with self-created PAPER_LOCAL config and keys. A
  supervisor status file or local simulator receipt is service-writable
  diagnostic state and is never evidence of this execution-control property.
  Until an operator has established and evidenced those permissions,
  formal D1 deployment remains blocked.

`scripts/plan_paper_local_deployment.ts` is the source-only handoff for that
future two-identity operation. It accepts only a fully verified V2 release and
an immutable `--release-id`; rechecks the frozen runtime contract, the pinned
Node and resolved Python bytes, and a canonical supervisor config against the
release's hash-bound schema; and constructs a closed launchd semantic payload
for a separately materialized `launch_nautilus_paper.{sh,mjs}` sibling pair.
The resulting `paper_local_deployment_plan.v1` always has
`status=plan_only`, explicitly denies deployment/start/launchctl/pointer,
Broker, network, and live-execution authority, and lists eight independent
attestations that a future authorized OS deployment must still obtain. Its
owner-private output is an exclusively reserved `<planId>.plan` directory;
the canonical plan is fsynced before the final `SEALED` marker, and an existing
or partial reservation is never overwritten. The planner does not create
users, materialize the launcher pair, write a plist, switch a release pointer,
invoke launchctl, start a process, or contact a Broker or network service. A
plan is not a pass receipt or an authorization. The JSON Schema describes only
the closed wire shape: every consumer must also call
`validatePaperLocalDeploymentPlan` with a current `freshAt`; schema validation
alone is never authorization. Because this checkout has no
verified V2 release and its runtime provenance remains unfrozen, no real
deployment plan has been generated.

`runtime_freeze_proposal.py` is a source-only inspector for that later review.
It never executes the candidate interpreter, creates a venv, installs or
downloads a package, or edits the contract. Given an already provisioned
owner-private runtime, an exact six-wheel local wheelhouse, and an
operator-supplied local CPython artifact hash, it can write only a short-lived,
non-overwritable `status=candidate` proposal containing the five prospective
hashes. The proposal explicitly does **not** establish CPython source
provenance and is not a pass, freeze, deployment, or release receipt. This
checkout contains neither the approved CPython artifact nor the exact
wheelhouse, so no real proposal has been generated.

The D1 gate is intentionally not `test:release`: it runs no project-defined
Broker E2E suite, build, dependency install, release activation, publication,
or Broker operation. It does run the two local, credential-free Node-to-Python
UDS contract integration specs; those use only a private temporary socket and
SQLite and are not the Broker E2E configuration. It
requires a clean source tree and distinct absolute runtime/test interpreters.
Each fixed child check has a 20-minute fail-closed wall-clock limit; expiry
terminates its isolated process group with `SIGTERM` followed by bounded
`SIGKILL`, and no pass receipt is written for a timed-out check.
It publishes all seven receipts, the environment receipt, and a canonical
`d1_release_bundle.v1.json` into an exclusively created directory. Fsynced
files are hard-linked first and the hash-binding manifest is linked last, so a
pre-existing directory is never replaced and a partial directory cannot
validate. Release construction accepts that exact bundle directory, not a mix
of individual receipts:

```bash
OPENALICE_NAUTILUS_PYTHON=/absolute/minimal-runtime/bin/python3.13 \
OPENALICE_NAUTILUS_TEST_PYTHON=/absolute/test-runtime/bin/python3.13 \
OPENALICE_D1_RECEIPT_DIR=/absolute/owner-private/receipts \
pnpm release:gate:d1
```

After a successful gate, the research-only release builder is given the
resulting directory with `--d1Bundle /absolute/.../<commit>.d1-release-gate`.
The bundle and every receipt are copied and hash-bound into
`release_manifest.v2`; each copy is re-hashed against the loaded bundle, and
the launcher re-parses the materialized bundle and cross-binds its environment
and seven receipt hashes to the manifest. An expired bundle is rejected both
at build and launch.

The checked-in implementation and unit tests are not a D1 pass receipt. Until
the runtime provenance is frozen and that command succeeds from a clean
candidate using the exact minimal venv, formal PAPER_LOCAL release admission
remains blocked. The V2 release is a standalone Python sidecar artifact, not a
self-contained or rebuildable OpenAlice Node application: its selected
TypeScript bridge sources, package metadata, and lock are hash-bound
interoperability evidence validated in the clean source tree, while the
materialized runtime executes only the protected shell/MJS launcher and Python
sidecar. A brokerless
application composition, Nautilus execution, broker reconciliation, OS service
registration, and any approved Paper Canary remain separate future gates.

The checked-in Python protobuf bindings are reproducible from the shared proto.
Run the locked-environment freshness check with:

```bash
PYTHONPATH=/path/to/verified/site-packages \
  OPENALICE_NAUTILUS_PYTHON=/opt/miniconda3/bin/python3.13 \
  pnpm sidecar:proto:check
```

Run its focused test without writing a pytest cache:

```bash
PYTHONPATH=/path/to/verified/site-packages \
  /opt/miniconda3/bin/python3.13 -B -m pytest -p no:cacheprovider sidecars/nautilus_paper
```
