# OpenAlice Baseline Freeze Manifest

Date: `2026-03-11`  
Branch: `work/kino-mainline`  
Purpose: freeze the current G3/G4 research path as a `research-only baseline` so later Stage-C work can measure deltas against a stable reference.

## 1. Freeze Scope

This freeze covers the current decision artifacts, gate snapshots, and strategy MVP outputs that produced the current `NO_GO` verdict.

- Policy: old-framework artifacts remain readable and reproducible, but are no longer treated as a production-GO candidate path.
- Successor path: `Stage-C` signal / feature / candidate generator rebuild.

## 2. Decision Packet Snapshot

| Artifact | SHA-256 |
| --- | --- |
| `decision_packet/verdict.json` | `1d0dc26aeabc266abf19a86be3ceb6d2601c9f836423223d021ebb0bfb78c0b9` |
| `decision_packet/experiment_verdict.v2.json` | `6f78ed2f16403d1586bdcda06a4aac2a55fa649f2e94a4a7e0a12e155c490290` |
| `decision_packet/release_gate_status.json` | `b260d55dafce7e71bfd15a95fd68a5a9148fa16711c9e43afc7c5e1ffcb977b2` |
| `decision_packet/gates/G0.checkpoint.json` | `2e051d8d7239fb0781ac90282e8b8c28e1c00f42d74f8e49013004db790af73e` |
| `decision_packet/gates/G1.checkpoint.json` | `b33eebbb705bb4cc48101dc8c298a26179028890c93d16a990b938e6720fa98c` |
| `decision_packet/gates/G2.checkpoint.json` | `e117e066a0b3875738a0a9063b233a286c587bfa39ae86db65bb0cf8f04cfc4d` |
| `decision_packet/gates/G3.checkpoint.json` | `9706a8b1f251f001d1adf51daaa1d05a3681f58d4eabf7c0dd6e3d45aa9fad49` |
| `decision_packet/gates/G4.checkpoint.json` | `2b14bb50538668672c498b9508bb40c42f13fa015a5237177d7b7ec8a0b94d2b` |

## 3. Gate Snapshot

| Gate | Status | Summary |
| --- | --- | --- |
| `G0` | `pass` | `4/4` checks passed |
| `G1` | `pass` | `3/3` checks passed |
| `G2` | `pass` | `8/8` checks passed |
| `G3` | `fail` | `3 passed / 5 failed` |
| `G4` | `fail` | `2 passed / 1 failed` |

G3 hard failures:

- `result=NO_GO`
- `meanPbo=0.8857142857142857 > 0.2`
- `meanDsrProbability=0.17528947232399147 < 0.5`
- `fdrQ=0.9999997082664652 > 0.1`
- `allowLiveTrading=false`

G4 failure:

- `failed gates=G3`

## 4. Candidate Baseline

Source: `decision_packet/experiment_verdict.v2.json`

| Strategy ID | Strategy Name | Status | PBO | DSR Probability | FDR q | Hard Gap Total | WFO Risk Score |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| `LPS_T047_C1` | `search_local_baseline_trend_21_80_lo` | `fail` | `0.8857142857142857` | `0.2261208428807006` | `0.9999997082664652` | `1.8595931511000503` | `1.4166666666666665` |
| `LPS_T047_C2` | `search_local_baseline_trend_30_80_lo` | `fail` | `0.8857142857142857` | `0.12252196896048678` | `0.9999997082664652` | `1.9631920250202641` | `6.827356556403085` |
| `LPS_T047_C3` | `search_local_baseline_trend_24_80_lo` | `fail` | `0.8857142857142857` | `0.177225605130787` | `0.9999997082664652` | `1.908488388849964` | `1.375` |

Champion note from artifact:

- `champion=LPS_T047_C1`

## 5. Release Gate Snapshot

Source: `decision_packet/release_gate_status.json`

- `allowPaperTrading=false`
- `allowLiveTrading=false`
- `failedChecks=["wfo","significance","risk_simulation"]`
- `warningChecks=[]`

## 6. Current Test Baseline

Recorded on the frozen baseline after Sprint 0 runtime wiring and news-collector recovery fix:

- JS tests: `corepack pnpm test`
  - `60 passed | 1 skipped` files
  - `566 passed | 1 skipped` tests
- Python tests: `corepack pnpm run test:py`
  - `127 passed`

Notable note:

- The prior `news-collector` recovery failure is no longer failing after the retention-window test fix.

## 7. Freeze Policy

The frozen baseline remains valid for:

- regression comparison
- metric delta measurement
- artifact traceability
- failure analysis against later Stage-C candidates

The frozen baseline is not valid for:

- production-GO argumentation
- release-gate override justification
- continued cosmetic parameter search on the old candidate family

## 8. Successor Work

All new research effort should flow into:

1. `Stage-C` signal rebuild
2. `CORE7`-backed candidate generation v2
3. multi-asset matrix re-evaluation against this frozen baseline
