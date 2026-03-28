# FDR Frontier Shortlist (2026-03-03)

- Generated at: `2026-03-03T07:01:46Z`
- Items: `12`
- Digest: `/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice/data/research/strategy-watch/latest_digest.json`
- Citation network: `/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice/data/research/literature/citations/latest_citation_network.v1.json`
- PDF extract report: `/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice/data/research/literature/pdf_extract/latest_pdf_extract_report.v1.json`
- Hypotheses: `/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice/data/research/hypotheses/backlog.v1.json`

| Rank | methodId | paperId | year | methodFamily | FDR impact | WFO impact | Cost | Risk | Citations |
| --- | --- | --- | ---: | --- | --- | --- | --- | --- | ---: |
| 1 | `m-robust-baseline-w4406389031` | `W4406389031` | 2025 | robust-baseline | low_to_medium_reduction_expected | uncertain | low | low | 2 |
| 2 | `m-robust-baseline-w7132840265` | `W7132840265` | 2026 | robust-baseline | uncertain | uncertain | low | low | 0 |
| 3 | `m-selective-inference-2602-10785v1` | `2602.10785v1` | 2026 | selective-inference | uncertain | medium_stability_gain_expected | high | high | 0 |
| 4 | `m-robust-baseline-w4411350528` | `W4411350528` | 2025 | robust-baseline | uncertain | uncertain | low | low | 6 |
| 5 | `m-robust-baseline-2601-13435v3` | `2601.13435v3` | 0 | robust-baseline | uncertain | low_to_medium_stability_gain_expected | low | low | 0 |
| 6 | `m-robust-baseline-w4413794959` | `W4413794959` | 2025 | robust-baseline | uncertain | uncertain | low | low | 2 |
| 7 | `m-regime-aware-risk-control-2511-08616v2` | `2511.08616v2` | 0 | regime-aware-risk-control | uncertain | medium_stability_gain_expected | medium | medium | 0 |
| 8 | `m-robust-baseline-w4386415902` | `W4386415902` | 2023 | robust-baseline | uncertain | uncertain | low | low | 11 |
| 9 | `m-robust-baseline-w7131074398` | `W7131074398` | 2025 | robust-baseline | uncertain | uncertain | low | low | 0 |
| 10 | `m-robust-baseline-2408-11773v2` | `2408.11773v2` | 2024 | robust-baseline | uncertain | uncertain | low | low | 0 |
| 11 | `m-regime-aware-risk-control-2501-15106v2` | `2501.15106v2` | 2025 | regime-aware-risk-control | uncertain | low_to_medium_stability_gain_expected | medium | medium | 0 |
| 12 | `m-robust-baseline-2505-07820v2` | `2505.07820v2` | 2025 | robust-baseline | low_to_medium_reduction_expected | uncertain | low | low | 0 |

## Action Hints

1. `m-robust-baseline-w4406389031`: Apply conservative FDR baseline gate and monitor fdrQ and WFO density.
2. `m-robust-baseline-w7132840265`: Apply conservative FDR baseline gate and monitor fdrQ and WFO density.
3. `m-selective-inference-2602-10785v1`: Prototype selective-inference gate in replay and verify calibration drift.
4. `m-robust-baseline-w4411350528`: Apply conservative FDR baseline gate and monitor fdrQ and WFO density.
5. `m-robust-baseline-2601-13435v3`: Add and ablate high-information feature groups before full rollout.
6. `m-robust-baseline-w4413794959`: Apply conservative FDR baseline gate and monitor fdrQ and WFO density.
7. `m-regime-aware-risk-control-2511-08616v2`: Inject event/news features only in volatility-sensitive regimes with strict latency controls.
8. `m-robust-baseline-w4386415902`: Apply conservative FDR baseline gate and monitor fdrQ and WFO density.
9. `m-robust-baseline-w7131074398`: Apply conservative FDR baseline gate and monitor fdrQ and WFO density.
10. `m-robust-baseline-2408-11773v2`: Apply conservative FDR baseline gate and monitor fdrQ and WFO density.
11. `m-regime-aware-risk-control-2501-15106v2`: Run regime-aware split first, then apply FDR control per regime bucket.
12. `m-robust-baseline-2505-07820v2`: Apply conservative FDR baseline gate and monitor fdrQ and WFO density.
