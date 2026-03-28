# Ghost 未完成工作恢复清单（OpenAlice，2026-03-03）

基于当前仓库 `git status --short`（`/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice`）盘点。

## 1) 未提交项分组

### 代码（8）
- `package.json`
- `scripts/run_strategy_mvp_validation.ts`
- `scripts/strategy_g3g4_failure_breakdown.py`
- `scripts/strategy_g3g4_iteration.py`
- `scripts/strategy_phaseb_family_search.py`
- `scripts/strategy_protocol_ablation.py`
- `docs/research/strategy_candidates.v1.json`
- `docs/research/strategy_candidates.phaseb_r1.json`

### 测试（4）
- `scripts/tests/test_strategy_g3g4_failure_breakdown.py`
- `scripts/tests/test_strategy_g3g4_iteration.py`
- `scripts/tests/test_strategy_phaseb_family_search.py`
- `scripts/tests/test_strategy_protocol_ablation.py`

### 生成产物（11）
- `decision_packet/evidence_pack.json`
- `decision_packet/experiment_verdict.v2.json`
- `decision_packet/gates/G0.checkpoint.json`
- `decision_packet/gates/G1.checkpoint.json`
- `decision_packet/gates/G2.checkpoint.json`
- `decision_packet/gates/G3.checkpoint.json`
- `decision_packet/gates/G4.checkpoint.json`
- `decision_packet/gates/gate_checkpoints_index.v1.json`
- `decision_packet/manifest.json`
- `decision_packet/release_gate_status.json`
- `decision_packet/verdict.json`

### 文档（4）
- `docs/research/g3_g4_recovery_iteration_playbook_20260302.md`
- `docs/research/g3_g4_top_venue_research_brief_20260302.md`
- `docs/research/g3g4_execution_runbook_20260303.md`
- `docs/research/ghost_task_backlog_20260303.md`

## 2) 建议执行顺序（4 步）
1. 先固定代码与测试：优先收口 `strategy_g3g4_iteration.py`、`strategy_phaseb_family_search.py` 与对应测试。
2. 再做最小验证：跑关键测试与一轮 fast iteration，确认命令链与 ranking 行为正确。
3. 然后处理产物：明确 `decision_packet/*` 哪些保留为证据，哪些归档/排除。
4. 最后文档收口：统一 runbook + backlog + completion status，形成可交接状态。

## 3) 当前结论
- 本轮核心能力已落地到仓库（phaseB 接入、ranking 优化、runbook）。
- 主要剩余工作是“变更分层提交 + 证据产物治理”。
- 暂未执行 commit/push（按要求）。
