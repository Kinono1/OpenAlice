# G3/G4 Stage-C Strategy Rebuild Charter (v1)

Date: `2026-03-03`  
Status: `draft_for_kickoff`

## 1) Why this project exists
- Stage-A gate failed on `BTC/ETH/SOL` with `conditionA=0` and `conditionB=0`.
- Research sensitivity up to `fdrQ<=0.20` still produced `jointPassRate=0.0`.
- Current framework is no longer treated as a production-GO candidate path.

## 2) Project objective
Build a new strategy framework that can satisfy both statistical validity and generalization constraints under multi-asset evaluation.

Hard target for Stage-C acceptance:
- Both workstreams must independently reach:
  - `fdrQ < 0.15`
  - `meanPbo < 0.20`
- Integrated combined candidate set must also satisfy the same thresholds.

## 3) Scope
In scope:
- Signal/feature/model redesign (workstream A)
- Statistical control redesign (workstream B)
- Multi-asset evaluation as mandatory gate

Out of scope:
- Production threshold relaxation (`fdrQ<=0.10` stays frozen for production policy)
- Cosmetic parameter-only local search on old framework

## 4) Workstreams and resource split
### Workstream A (signal rebuild)
- Focus: feature set, regime descriptors, candidate generation logic
- Responsibility: create fundamentally stronger raw signal quality

### Workstream B (methodology rebuild)
- Focus: selective-inference/e-value/knockoff style statistical control alternatives
- Responsibility: improve multiple-testing validity under candidate selection bias

Resource allocation:
- Month 1: A `70%`, B `30%`
- Month 2: A `60%`, B `40%`
- Month 3+: A `50%`, B `50%`

## 5) Timeline and milestones
### M1 (Week 4)
- A/B minimal runnable prototypes complete
- Shared evaluation harness and artifact contracts stable

### M2 (Week 8)
- Both A and B produce candidates passing internal sanity thresholds
- Multi-asset matrix evidence available for both tracks

### M3 (Week 12+)
- Integrated evaluation
- Go/No-Go decision for next production-track admission candidate

## 6) Governance rules
- Priority order:
  1. Shared infra blockers
  2. Milestone-critical blockers
  3. Local optimization
- Decision SLA for resource conflict: `24h`
- If either track stalls for 2 consecutive sprints with no measurable gain, trigger architecture-level review.

## 7) Success and failure criteria
Success:
- Both A and B independently satisfy `fdrQ<0.15` and `meanPbo<0.20`.
- Integrated result keeps both constraints.

Failure:
- By M2, either track cannot reach interim floor (`fdrQ<0.25` and `meanPbo<0.30`).
- By M3, integrated candidate set fails core constraints.

## 8) Initial owners and kickoff deliverables
Deliverables before kickoff:
1. Stage-C backlog and 2-sprint plan
2. Evaluation contract checklist
3. Baseline freeze manifest for old framework
