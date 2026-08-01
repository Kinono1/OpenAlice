# P2 sidecar contract and isolation receipt

## Authority boundary

OpenAlice is the only admission and execution authority. TradingAgents and
AlphaSwarm are permanent `research_only` sidecars. The shared contract cannot
carry paper/live admission, approvals, broker credentials, order authority, or
an execution arm.

Every accepted exchange is bound to:

- a run ID and sidecar source;
- issue/expiry timestamps;
- an OpenAlice commit and sidecar commit;
- allowed BTC/USD or ETH/USD assets;
- input artifact hashes;
- canonical request, output, and evidence-manifest hashes.

Unknown schemas, expired requests, unallowlisted commits, identity/hash
mismatches, non-research modes, unauthorized assets, stale signals, timeouts,
crashes, and execution-authorization fields fail closed. Empty signals degrade
to research-only without opening paper or live access.

## Compatibility

- TradingAgents continues to accept `tradingagents_sidecar_request.v1`.
- A new `openalice_sidecar_request.v1` is validated and mapped through the
  existing strict-request validator.
- Common requests emit `openalice_sidecar_result.v1`, a sibling
  `sidecar_evidence_manifest.v1`, and the legacy
  `tradingagents_sidecar_report.v1` as a supplemental artifact.
- The legacy TradingAgents research-decision output remains available only for
  the legacy request path and always reports `tradeAllowed=false`.
- AlphaSwarm's existing `NormalizedSignal` is mapped into the same common
  result and evidence manifest; its signer, wallet, swap-build, and transaction
  submission guards remain unchanged and permanently disabled.

## Cross-language fixture

The same fixture bytes are stored in all three repositories:

- OpenAlice: `src/sidecar/fixtures/openalice_sidecar_contract_v1.json`
- TradingAgents: `tests/fixtures/openalice_sidecar_contract_v1.json`
- AlphaSwarm: `tests/data/openalice_sidecar_contract_v1.json`

Fixture SHA-256:

`8ab37dc14bcc6c21e151e2e0a63026a05ee0c20dd1de38a715ae1f54d1b8367a`

It covers canonical object-key ordering, arrays, and the numeric values `0`,
`0.25`, `-0.25`, and `0.6`. OpenAlice rebuilds the request hashes and validates
the Python-produced result/manifest bundles for both sidecars.

## Admission effect

All contract validation outcomes retain:

- `paperTradingAllowed=false`
- `liveTradingAllowed=false`
- `liveExecutionArmed=false`

Sidecar success is research evidence only and cannot satisfy the 7-day paper
gate, 30-day live gate, dual approval, risk gates, or the short-lived execution
arm.
