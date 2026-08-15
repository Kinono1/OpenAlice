# P3 execution receipt and recovery contract

## Status, scope, and terminology

**Implemented contract.** Phase C1 implements local SQLite authority, deterministic offline simulation, source-effect attestation, and receipt verification mechanics. It may prove that the configured local simulator created one authenticated simulated effect for an admitted command and that the ledger recorded it consistently. It does not prove a broker, exchange, Nautilus, paper engine, Demo endpoint, or Live endpoint accepted an order.

**Implemented bounded runtime integration.** The owner-thread-only
`OfflineExecutionCoordinator` is wired into the optional `PAPER_LOCAL`
`RuntimeExecutor` configuration, the single-owner backlog, lease renewal, and
startup recovery. Runtime-level tests cover a pre-provisioned simulator store,
post-admission internal dispatch, two-command global-store ordering, recovery
of an existing signed effect, and fail-closed read-only startup when an old
attempt has no effect. This remains an in-process local simulator path, not a
broker, Nautilus, application-level CCXT composition, or production service.

The following are outside Phase C1 and forbidden here:

- broker or exchange network access, credentials, credential discovery, and native CCXT fallback;
- Nautilus execution clients or paper-engine execution;
- release activation, paper Canary, Demo, or Live trading;
- promotion of lifecycle observations or a simulator result to broker evidence.

`terminal` must name its evidence source. An offline-simulator terminal is not a broker terminal; a future Nautilus paper-engine terminal would not be a venue terminal; an OKX Demo observation would be scoped to its endpoint, account, instrument, and time and would not be an OKX Live claim.

## Implemented trust and policy boundary

### Policy version and immutable identity

New offline execution requires `openalice_offline_adapter_policy.v3`, `mode=PAPER_LOCAL`, `receiptSchemaVersion=openalice_offline_execution_receipt.v1`, and `receiptScope=offline_simulator_only`. The exact canonical V3 policy is persisted and addressed by its policy hash before dispatch.

V1 and V2 policies remain readable only for historical diagnostics. They cannot claim a new offline dispatch, issue a simulator capability, or complete an offline receipt. This prevents a legacy policy from omitting the store and source-proof roots required by V3.

V3 pins adapter identity/build/config/run, source namespace, permit authority, the offline capability, `ensureExact`, and `finalizationEligible=false`. It additionally pins:

- `simulatorStoreId` — SHA-256 identity of the particular simulator store;
- `sourceAttestationKeyId` and `sourceAttestationPublicKeySpkiSha256` — the trust root for signed simulator source effects.

### Four independent Ed25519 roles

V3 requires all four IDs **and** all four canonical SPKI DER SHA-256 fingerprints to be different:

| Role | Held by | Authority |
| --- | --- | --- |
| Permit authority | admission/permit path | proves command admission scope and expiry |
| Receipt signer (`adapterKeyId`) | ledger constructor | signs `openalice_offline_execution_receipt.v1` |
| Simulator-capability authority | ledger constructor | signs local `ensure_exact` capability |
| Source-attestation signer | simulator constructor | signs the original simulator source-effect proof |

The policy itself does not supply private keys. The ledger constructor pins the receipt private key/key ID, capability private key/key ID, and the source-attestation public-key mapping. The simulator constructor pins the capability public-key mapping, source-attestation private key/key ID, and store identity. Constructor validation rejects aliased key material between the capability and receipt signer, between source attestation and capability authority, and V3 rejects any of the four policy fingerprints or IDs being aliased.

### Constructor-pinned time authorities

Lease fencing samples the `Ledger` constructor's `fencing_clock` only after `BEGIN IMMEDIATE`; business calls cannot pass a lease clock. Simulator capability expiry samples the `OfflineSimulatorStore` constructor's `capability_clock`; an `ensure_exact` caller cannot backdate a capability. Timestamp arguments retained for record timestamps are not fencing or capability-expiry authority.

## Evidence schemas and bindings

### Offline capability

`openalice_offline_simulator_capability.v1` is a canonical, domain-separated Ed25519 token. It is issued only by the ledger under a current fenced lease and binds, among other fields:

- V3 policy hash, `simulatorStoreId`, and `sourceAttestationKeyId`;
- command, immutable original attempt and adapter epoch, namespace, `clientOrderId`, and exact request hash;
- writer name/owner/epoch, issue and expiry time;
- `authorityKind`: either `original_dispatch` or `takeover_reconciliation`; a takeover also binds its active reconciliation claim.

The simulator never accepts a Python `Lease` object as authority. It verifies the signed capability against its constructor-pinned public keys, historical issued time, exact binding, and constructor-pinned current time. Each use is persisted atomically with the effect or retry result. This capability is strictly `offline_simulator_only`; it grants no network, Nautilus, Demo, or broker authority.

### Signed original source-effect proof

The simulator's creation path emits `openalice_offline_simulator_effect.v1`, scope `offline_simulator_only`. It is a separately canonical, domain-separated Ed25519 source-effect proof, not an unsigned response supplied by a caller. Its core binds:

- store ID, global `storeSequence`, previous global store-chain hash, and computed global store-chain hash;
- V3 policy hash, original capability ID, source-attestation key ID, command, original attempt/adapter epoch, source namespace/sequence, client order ID, request/response hashes, simulated order ID, and simulator occurrence time;
- `authorityKind=original_dispatch` and the original writer identity/epoch.

For a new effect, the simulator atomically persists the order, source event, capability use, signed effect bytes, namespace head, and global store head. Namespace heads enforce contiguous source sequence and source-chain history; the global identity row pins `simulatorStoreId`, global sequence, and global chain head. A new database path requires explicit provisioning; an existing path with missing or inconsistent identity/head data fails closed. Lookup audits the persisted proof and chain before returning it.

The ledger independently anchors the same simulator-global chain in
`offline_source_store_heads`. The receipt table enforces a unique
`(source_store_id, source_store_sequence)`, and a commit first admits either
the genesis link (`storeSequence=1`, all-zero predecessor) or exactly the next
link whose predecessor equals the durable ledger head. The head advance,
receipt, V2 lifecycle event, and terminal dispatch update are one ledger
transaction. A reopen performs structural chain coverage validation: every
anchored store head must exactly match contiguous receipt-linked effects. An
exact retry repeats that structural validation and then re-verifies the stored
receipt/source proof before returning success.

`simulatorStoreId` is a single globally ordered source identity, not a
per-command namespace. Its supported deployment invariant is **one simulator
store ID to one Ledger/one logical ledger owner**. Two Ledgers must not share
one store identity. With the supported single Ledger, a rejected or missing
global link N prevents accepting N+1: this is intentionally availability-costly
and fail-closed, rather than allowing a forked global source history.

Open-time anchor validation is structural only: it parses receipt/effect
fields, genesis/predecessor links, sequence continuity, and head coverage.
Signature and frozen-policy verification requires constructor-pinned trust
roots and is performed on durable reads, exact retries, and receipt commits.

The effect must use the immutable **original-dispatch** capability. A takeover
capability cannot create an effect.

### Offline execution receipt and V2 lifecycle event

`openalice_offline_execution_receipt.v1` is an adapter/ledger-signed local receipt whose fixed scope is `offline_simulator_only` and whose policy fixes `finalizationEligible=false`. It binds command/permit/economic/adapter/attempt identity, source namespace and sequence, canonical request and response hashes, the original simulator occurrence time, and the ledger lifecycle projection. Its receipt ID and signature are domain separated; it embeds no public key.

The ledger constructs the receipt only with its constructor-pinned receipt signer after checking that its public-key SPKI fingerprint and key ID match the frozen V3 policy. The completion transaction inserts canonical request, response, signed source-effect proof, signed receipt, and a corresponding `openalice_execution_event.v2`. The V2 event includes immutable evidence schema/receipt identity; receipt and event mutually bind their semantic projection. Legacy V1 lifecycle events remain readable observations and are never upgraded into signed evidence.

## Implemented durable dispatch state

Only a current fenced ledger owner can mutate the local dispatch state:

```text
ACKNOWLEDGED
  -> DISPATCH_PENDING
  -> IN_FLIGHT
       -> RECEIPT_COMMITTED
       -> RECONCILIATION_REQUIRED
  -> RECEIPT_COMMITTED
```

Implemented constraints:

1. Admission creates at most one `DISPATCH_PENDING` row for an exact eligible submit command; exact duplicates do not create another dispatch.
2. Claiming under `BEGIN IMMEDIATE` establishes an immutable original attempt (including original adapter epoch) and records `IN_FLIGHT` before any simulator effect.
3. `ensure_exact` is keyed by exact canonical `(clientOrderId, requestHash)`. An original capability may atomically create or return that exact effect; any divergent command/request is equivocation.
4. `commit_offline_execution_receipt` accepts canonical response bytes and canonical **signed source-effect proof** bytes. It does not accept a caller-selected receipt private key, receipt public key, simulator key, or naked canonical response as evidence.
5. Completion verifies the frozen V3 policy, constructor-pinned authorities,
   source-effect signature/store/key/capability/request/response bindings, the
   persisted immutable original capability, current lease, and the next
   contiguous source/lifecycle sequence. It then atomically advances the
   global Ledger store anchor before receipt/lifecycle mutation. A mismatch
   suspends or fails closed; exact repetition structurally revalidates the
   anchor and re-verifies the same committed evidence.
6. Completion uses the active reconciliation claim when dispatch is in `RECONCILIATION_REQUIRED`; completion under an old writer or stale claim is rejected. It never changes the identity of the original attempt that explains the effect.

The current C1 receipt model supports exactly one simulator transition per dispatch (`transitionNumber=1`, no predecessor). Multi-transition receipt chains remain a future design and must not be inferred from reserved fields.

## Implemented coordinator and bounded runtime wiring

`OfflineExecutionCoordinator` is an implemented, owner-thread-only state
machine. It snapshots permit and receipt public trust roots at construction,
accepts no call-level clocks, keys, stores, or policy resolvers, and propagates
durable/integrity failures for a fresh coordinator to recover from durable
state. Its verified behavior is:

1. After a claimed original attempt, first call simulator `lookup_exact` by
   the immutable original request. Never create before this lookup.
2. If a signed original effect exists, use that exact proof and response for
   receipt completion. After takeover, acquire a current active reconciliation
   claim; this authorizes the ledger completion write, while the original
   capability/effect continues to explain the external effect.
3. A takeover capability may call controlled `ensure_exact` only to return an
   already existing exact original effect. It cannot create when lookup is
   missing, unavailable, malformed, or uncertain.
4. If the original effect is absent or cannot be verified, leave the dispatch
   `RECONCILIATION_REQUIRED`; do not mint a substitute effect, retry a network
   operation, or reinterpret absence as authority to create.
5. If `RECEIPT_COMMITTED` is already durable, recovery is read/verification
   only. It must not call the simulator again.

Coordinator unit tests exercise durable crash cut points after claim,
capability issuance, simulator effect, and ledger receipt commit. They verify
lookup-first behavior, missing effect under a new epoch remaining
`RECONCILIATION_REQUIRED`, a found original effect being completed with the
current reconciliation claim, and committed dispatches remaining read-only.

The optional Runtime integration additionally freezes the canonical V3 policy
and all four authority roles before READY, requires an already provisioned
owner-private simulator database, constructs the Ledger, simulator, Core, and
Coordinator on the same owner thread, and rebinds both Core and Coordinator to
the exact renewed lease. A successful durable-admission Future is completed
before the command is placed on the internal offline backlog. This ordering is
the `RuntimeExecutor` caller boundary; it is not a claim that gRPC response
bytes reach a client before the simulator effect.

Startup scans incomplete dispatches in accepted-command order. An existing
signed original effect is verified and committed before admission opens. An
old-epoch attempt with no effect is durably moved to
`RECONCILIATION_REQUIRED`; the process publishes a write-disarmed UDS that
rejects admission while retaining the bounded Python/raw-gRPC read methods.
No external RPC was added to issue capabilities, call `ensure_exact`, commit a
receipt, or mutate recovery state.

The test-only Node-to-Python boundary is also implemented. A direct
`ExecutionGrpcTransport` UDS test verifies READY admission, exact duplicate
replay, signed simulator-only receipt retrieval, and a clean process restart
without adding another command, receipt, or source effect. A second test seeds
an old-epoch missing-effect attempt and verifies exact READ_ONLY identity,
diagnostic command access, local rejection of `Execute`, and zero receipt/effect
creation. The independent Node diagnostic assembly exposes only frozen read
facades, binds the frozen receipt trust policy, loads no permit private key, and
cannot rearm a transport after READ_ONLY. Writer assembly still requires READY.

Real-process tests now start the actual `RuntimeExecutor`, drive its owner
thread and offline backlog, and terminate the child only after the original
durable operation returns. They cover: durable `DISPATCH_PENDING` before
claim, `IN_FLIGHT` before effect, durable signed effect before receipt, and
durable receipt/lifecycle before the `RuntimeExecutor.admit()` caller returns.
The first three use child `os._exit`; the receipt cut uses parent `SIGKILL`.
Restart proves exactly one command/attempt/effect/receipt where recovery is
safe, and preserves `RECONCILIATION_REQUIRED` plus read-only diagnostics when
an old-epoch attempt has no effect. The caller-return gate is not a gRPC wire
delivery claim.

Deterministic Runtime lease tests cover existing-effect receipt/anchor/event
commit, missing-effect reconciliation marking, active reconciliation claim,
and a post-renewal dispatch claim. They advance only the constructor-pinned
clock after Runtime/Coordinator preflight and before the target Ledger method
begins its write transaction. The target method's trusted post-`BEGIN
IMMEDIATE` sample rejects the stale lease and the transaction leaves no
unauthorized state. A failed startup exposes no listener or READY status; a
fresh incarnation then completes a verified existing effect or exposes the
supported missing-effect read-only state. The post-`BEGIN` trusted sample is
the transaction's fencing/serialization point; the tests do not impose a
second commit-time TTL sample.

**Still pending:** a brokerless application composition, production sidecar
launcher/supervisor and locked installed Python runtime, and mandatory release
gate execution of the Python plus explicit Node-to-Python UDS suites. The
existing CCXT account bootstrap is not such a composition because it
initializes a broker and loads markets.

Permit expiry forbids a new dispatch attempt; it does not erase evidence of an attempt armed before expiry. Recovery rechecks the frozen permit signature/binding and the stored `dispatchArmedAt < permit.expiresAt` relationship rather than requiring a later receipt to predate permit expiry. A disarmed runtime is not rearmed in process; reconciliation occurs only in a new runtime incarnation with a new current lease unless a separately modelled and tested narrower capability is added.

## Crash boundary, atomicity, and threat limits

There are two independent SQLite databases: the OpenAlice ledger and the simulator store. They do **not** form a distributed ACID transaction. The crash-recoverable protocol is deliberately three durable steps:

1. ledger claims and commits `IN_FLIGHT`;
2. simulator atomically creates/returns and durably attests the original effect;
3. ledger atomically verifies that proof and commits receipt plus V2 event.

A process crash between steps 1 and 2 leaves no effect; a crash between steps 2 and 3 leaves a lookup-recoverable signed original effect; a crash after step 3 leaves a verified ledger receipt. This is a recovery protocol, not a claim of cross-database atomicity.

The simulator's internal namespace/global heads, strict provisioning, and the
Ledger's independent global-store anchor detect deletion, gaps, wrong store
identity, local chain breaks, and many partial-history changes. They do **not**
resist an attacker who can coherently roll back or replace the entire SQLite
database together with all of its internal heads (or consistently roll back
both local databases). That stronger rollback threat requires an independent
cross-storage witness, for example an append-only external checkpoint, and is
outside the current local-store guarantee.

## Read and promotion boundary

Node receipt retrieval is a separate strict read model, not lifecycle replay. It verifies exact canonical UTF-8/protobuf projection, receipt ID/signature, the pinned policy/key material, receipt-to-V2-event binding, and the stored source-effect proof. Results remain distinct:

- invalid evidence: fail closed and poison/reconcile as required;
- valid simulator-only evidence: readable diagnostics only; `finalizationEligible=false` and broker idempotency remains `unresolved`;
- future broker evidence: requires a separately approved schema, authenticated transport/source semantics, and a broker-specific atomic finalization path.

No Phase C1 result authorizes Nautilus, paper Canary, OKX Demo, OKX Live, or live trading. Future promotion requires separately implemented adapters, authorized credentials/network access where applicable, and evidence gates specific to those environments.

## Verified runtime gates and remaining integration gates

The bounded Python Runtime proof now covers:

- exact `PAPER_LOCAL` identity, canonical V3 policy, key fingerprints, and a
  pre-provisioned owner-private simulator store before READY;
- construction and use of the Coordinator only on the Ledger owner thread;
- completion of the durable-admission Future before internal simulator work;
- sequential source-store links for two admitted commands;
- restart from an old-epoch `IN_FLIGHT` command with an existing signed effect,
  producing one verified receipt before admission opens;
- restart from an old-epoch `IN_FLIGHT` command with no effect, producing
  `WRITE_DISARMED`/read-only behavior with no blind create;
- owner-thread rebinding of the exact renewed lease before later offline work;
- the unchanged gRPC service method set: `Execute` remains the sole signed
  admission mutation; no receipt/capability/simulator mutation RPC exists.
- a direct test-only Node-to-Python UDS round trip that verifies the signed
  simulator-only receipt, exact duplicate behavior, and clean restart;
- a real UDS READ_ONLY recovery round trip for an old-epoch missing effect,
  including readable command diagnostics and Node-local rejection of Execute;
- an independently assembled Node diagnostic facade with no raw transport,
  signer, writer, key-file load, or Execute surface; peer identity/epoch/health
  cursor drift and malformed read-model data permanently poison the client;
- release-closure checks that require the offline Node read models and Python
  contract/simulator modules, plus a launch closure that requires `sidecars/`.

Before any broader integration or admission claim, the remaining gates are:

- make the locked Python suite, real-process crash/lease tests, and explicit
  Node-to-Python UDS tests mandatory fail-closed release checks rather than
  optional/manual evidence;
- provide a production sidecar launcher/supervisor bound to a verified,
  installed Python environment; the test-only servers are not entrypoints;
- only if application-level local execution is later approved, add a separate
  brokerless `PAPER_LOCAL` composition. Reusing the current CCXT account path
  would initialize a broker/network dependency and is outside this phase.

These remaining gates do not authorize Nautilus, broker credentials or
network access, Paper Canary, OKX Demo, or OKX Live.
