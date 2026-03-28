# OpenAlice Packet-Builder Cluster Triage 2026-03-11

## Summary

This note covers the remaining `build_*` and `research_*` script cluster that was deferred during the first scripts cleanup pass.

Key finding:

- this cluster is still directly referenced by `package.json`
- therefore it is **not safe** to move it into archive in the same way as the legacy `g3g4` / `phaseb` strategy loop scripts

So the correct hygiene decision for this pass is:

- **do not move these scripts yet**
- first treat them as a coordinated command surface
- only archive or relocate them together with command cleanup

## Direct Command References

The following package scripts still point at these paths:

- `research:hypothesis-compile -> scripts/research_hypothesis_compile.py`
- `research:pdf:extract -> scripts/research_pdf_extract.py`
- `research:citation:build -> scripts/build_citation_network.py`
- `research:frontier:shortlist -> scripts/research_fdr_shortlist.py`
- `strategy:g3g4:stagea:gate -> scripts/build_stagea_gate_result.py`
- `strategy:g3g4:stageb:packet -> scripts/build_stageb_governance_packet.py`
- `strategy:g3g4:policy:pack -> scripts/build_quant_policy_pack.py`
- `strategy:g3g4:advisor:packet -> scripts/build_advisor_committee_packet.py`
- `strategy:g3g4:hiring:scorecard -> scripts/build_quant_hiring_scorecard.py`
- `strategy:g3g4:paper:board -> scripts/build_problem_driven_paper_board.py`
- `strategy:g3g4:decision:precontinue -> scripts/build_precontinue_decision.py`
- `strategy:g3g4:compile-candidates -> scripts/research_hypothesis_to_candidates.py`
- `strategy:g3g4:switch -> scripts/research_plan_switch.py`
- `strategy:g3g4:research:methodology-top2 -> scripts/research_methodology_execute.py`
- `strategy:g3g4:research:methodology-top2:dry -> scripts/research_methodology_execute.py`

This means the cluster is still a live entrypoint surface, even if some commands are no longer part of the current preferred research path.

## Cluster Inventory

Scripts in this deferred cluster:

- `scripts/build_advisor_committee_packet.py`
- `scripts/build_citation_network.py`
- `scripts/build_precontinue_decision.py`
- `scripts/build_problem_driven_paper_board.py`
- `scripts/build_quant_hiring_scorecard.py`
- `scripts/build_quant_policy_pack.py`
- `scripts/build_stagea_gate_result.py`
- `scripts/build_stageb_governance_packet.py`
- `scripts/research_fdr_shortlist.py`
- `scripts/research_hypothesis_compile.py`
- `scripts/research_hypothesis_to_candidates.py`
- `scripts/research_methodology_execute.py`
- `scripts/research_pdf_extract.py`
- `scripts/research_plan_switch.py`

Paired tests:

- `scripts/tests/test_build_advisor_committee_packet.py`
- `scripts/tests/test_build_citation_network.py`
- `scripts/tests/test_build_precontinue_decision.py`
- `scripts/tests/test_build_problem_driven_paper_board.py`
- `scripts/tests/test_build_quant_hiring_scorecard.py`
- `scripts/tests/test_build_quant_policy_pack.py`
- `scripts/tests/test_build_stagea_gate_result.py`
- `scripts/tests/test_build_stageb_governance_packet.py`
- `scripts/tests/test_research_fdr_shortlist.py`
- `scripts/tests/test_research_hypothesis_compile.py`
- `scripts/tests/test_research_hypothesis_to_candidates.py`
- `scripts/tests/test_research_methodology_execute.py`
- `scripts/tests/test_research_pdf_extract.py`
- `scripts/tests/test_research_plan_switch.py`
- `scripts/tests/test_schema_contracts.py`

## Current Decision

For the current cleanup phase, the right decision is:

- `status = defer`

Rationale:

- moving these scripts now would break current command aliases
- package-level cleanup has not been done yet
- this cluster is lower-noise than the already-archived legacy strategy-loop scripts
- command cleanup should happen only after the active Stage-C path is more settled

## What To Do Later

When the repo is ready for the next hygiene pass, this cluster should be handled as one coordinated change:

1. review whether each package script still deserves to exist
2. drop commands that are clearly superseded
3. move retained historical builders into an archive path only if their command aliases are also updated or removed
4. keep the tests aligned with the final command surface

## Final Recommendation

Do not move or delete the packet-builder cluster in the current pass.

Current cleanup should stop after:

- `tmp/` partial cleanup
- superseded research-doc archive
- legacy strategy-loop script archive

The packet-builder cluster is the next cleanup candidate, but only as a coordinated `package.json + scripts + tests` refactor, not as a simple move.
