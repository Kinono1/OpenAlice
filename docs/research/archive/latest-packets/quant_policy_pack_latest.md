# Quant Policy Pack

- Generated at: `2026-03-03T14:32:33Z`
- Policy mode: `rebuild_mode`
- Production threshold frozen: `True`

## Operating Principles
- Tradability and execution feasibility outrank model novelty.
- Production threshold policy remains frozen unless governance approves exception.
- No route proceeds without auditable Stage-A/Stage-B evidence artifacts.

## Governance Cadence
- Internal review: `weekly`
- External advisor review: `monthly`

## Gate Policy
- Stage-A required path: `/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice/data/research/strategy/analysis/g3g4/stagea_gate_result.v1.json`
- Stage-B required path: `/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice/data/research/strategy/analysis/g3g4/stageb_governance_packet.v1.json`
- Recommended route: `stageC_rebuild`

## Escalation Rules
- `ESCALATE_STAGEA_FAIL`: If Stage-A gate fails, enforce Stage-B governance sign-off before any new optimization cycle.
- `ESCALATE_ZERO_JOINT_PASS`: If sensitivity scenarios show zero joint pass, route to rebuild planning.
- `ESCALATE_TRADEABILITY_BLOCK`: If execution feasibility constraints fail, reject candidate regardless of statistical metrics.
