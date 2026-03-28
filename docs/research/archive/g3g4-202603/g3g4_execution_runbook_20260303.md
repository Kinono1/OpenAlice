# OpenAlice G3/G4 恢复执行 Runbook（未来 72 小时）

## 0. 当前状态（用于执行前校准）

基于现有资料（`docs/research/g3_g4_recovery_iteration_playbook_20260302.md`、`docs/research/g3_g4_top_venue_research_brief_20260302.md`、`docs/research/v5_risk_fix_compare.md`、`data/research/strategy/analysis/g3g4/latest_strategy_g3g4_breakdown.{md,json}`）：

- 当前主瓶颈是 `FDR + WFO`，不是 `meanPbo/meanDsrProbability`。
- 最新关键值：`meanPbo=0.157143`（过线）、`meanDsrProbability=0.660012`（过线）、`fdrQ=0.369772`（未过线，阈值 0.1）。
- G3/G4 仍为 `fail/fail`，`reasonCodes` 核心为 `HARD_FDR_THRESHOLD_FAIL`、`HARD_RELEASE_GATE_BLOCKED`、`HARD_UPSTREAM_GATE_FAILED`。
- WFO 失败密度仍高（当前样本 `wfoFailureDensity` 约 `0.73` 量级）。

执行目标：在不放松硬门槛前提下，优先降低 `wfoFailureDensity` 与 `fdrQ`，推动 `G3/G4 -> pass/pass`；若 72h 内仍不满足，则产出可审计的 NO_GO 证据链与下一阶段输入。

## 1. 72 小时总流程

工作目录：

```bash
cd /Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice
```

统一规则：

- 每轮都保留 run_id 与归档。
- `strategy:mvp`、`decision:validate` 返回 `2` 在 NO_GO 路径下是允许行为，不算执行失败。
- 仅当工具链异常（命令崩溃、产物缺失、schema 断裂）才判定为执行失败。

---

## 2. T+0h 到 T+24h（Phase A：协议与基线稳定）

### 2.1 执行命令

```bash
pnpm run env:verify
pnpm run freeze:verify
pnpm run gates:preflight
python3 scripts/strategy_g3g4_iteration.py --execute-chain --profile fast --protocol-profile shift --run-id rbook-a1-shift
pnpm run strategy:g3g4:breakdown
```

### 2.2 停止条件

- `env:verify` 或 `freeze:verify` 非 0：立即停止，先修环境锁，不进入策略迭代。
- `gates:preflight` 非 0：立即停止，先修 preflight 报告中的阻塞项。
- 迭代后若 `latest_strategy_g3g4_breakdown.json` 丢失或 JSON 不可读：停止并修复脚本链路。

### 2.3 预期产物

- `data/research/strategy/runs/latest_strategy_g3g4_iteration.json`
- `data/research/strategy/runs/archive/rbook-a1-shift/strategy_g3g4_iteration.json`
- `data/research/strategy/analysis/g3g4/latest_strategy_g3g4_breakdown.json`
- `data/runtime/gates/G3.checkpoint.json`
- `data/runtime/gates/G4.checkpoint.json`

### 2.4 当日通过判据

- 工具链通过：所有命令有产物，且 gate checkpoint 可读。
- 指标方向性：相对执行前基线，`wfoFailureDensity` 不上升，且 `fdrQ` 不恶化。

---

## 3. T+24h 到 T+48h（Phase B：Phase-B 搜索注入 + 快速回归）

### 3.1 执行命令

```bash
pnpm run strategy:g3g4:phaseb-search
python3 scripts/strategy_g3g4_iteration.py --execute-chain --profile fast --protocol-profile shift --with-phaseb-search --run-id rbook-b1-phaseb
pnpm run strategy:g3g4:breakdown
```

### 3.2 停止条件

- `strategy:g3g4:phaseb-search` 非 0：停止，保留日志，回退到前一版候选集。
- `latest_phaseb_recommended_candidates.json` 未生成：停止，不允许进入下一轮决策验证。
- 若连续 2 轮（含本阶段）`fdrQ` 与 `wfoFailureDensity` 均无改善：停止扩搜，转入失败归因整理。

### 3.3 预期产物

- `data/research/strategy/analysis/g3g4/latest_phaseb_family_search.json`
- `data/research/strategy/analysis/g3g4/latest_phaseb_recommended_candidates.json`
- `data/research/strategy/runs/archive/rbook-b1-phaseb/strategy_g3g4_iteration.json`
- `decision_packet/verdict.json`

### 3.4 当日通过判据

- Phase-B 报告产物完整。
- top trial 的排序遵循当前目标（先 `wfoFailureDensity`，再 hard gaps，再 Sharpe）。
- 至少一组候选在 breakdown 中表现为：`wfoFailureDensity` 下降或 `fdrGap` 缩小。

---

## 4. T+48h 到 T+72h（Phase C：收敛决策与收口）

### 4.1 执行命令

```bash
python3 scripts/strategy_g3g4_iteration.py --execute-chain --profile full --protocol-profile shift --with-phaseb-search --run-id rbook-c1-final
pnpm run strategy:g3g4:breakdown
python3 scripts/validate_decision_packet.py --packet-dir decision_packet --output decision_packet/verdict.json
```

### 4.2 停止条件（最终）

满足任一条件即停止 72h 执行并收口：

1) **成功收口**：`G3=pass` 且 `G4=pass` 且 `verdict.result=GO`。
2) **失败收口**：连续 3 次迭代（A/B/C）均为 `NO_GO` 且 `fdrQ` 无显著改善（仍明显高于 0.1），触发“进入下一阶段家族扩展”决策。
3) **系统性异常**：核心产物（G3/G4 checkpoint、breakdown、verdict）任一缺失或 schema 损坏。

### 4.3 预期产物

- `data/research/strategy/runs/archive/rbook-c1-final/strategy_g3g4_iteration.{json,md}`
- `data/research/strategy/analysis/g3g4/latest_strategy_g3g4_breakdown.{json,md}`
- `data/runtime/gates/gate_checkpoints_index.v1.json`
- `decision_packet/verdict.json`

### 4.4 最终输出要求

- 若 GO：记录通过时的候选集、`fdrQ`、`wfoFailureDensity`、checkpoint 快照。
- 若 NO_GO：输出 72h 对比结论（A/B/C 三阶段指标变化）并明确下阶段动作（扩大非 trend 家族 + 保持 hard gate）。

---

## 5. 每轮执行后的快速核验命令

```bash
python3 -m json.tool data/research/strategy/analysis/g3g4/latest_strategy_g3g4_breakdown.json >/dev/null
python3 -m json.tool data/runtime/gates/G3.checkpoint.json >/dev/null
python3 -m json.tool data/runtime/gates/G4.checkpoint.json >/dev/null
python3 -m json.tool decision_packet/verdict.json >/dev/null
```

核验口径：以上命令任一失败都视为“本轮不可用”，必须先修产物链。

## 6. 每日最小执行集

仅保留最小闭环（4 条）：

```bash
cd /Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice
pnpm run strategy:g3g4:phaseb-search
python3 scripts/strategy_g3g4_iteration.py --execute-chain --profile fast --protocol-profile shift --with-phaseb-search --run-id daily-min-$(date -u +%Y%m%dT%H%M%SZ)
pnpm run strategy:g3g4:breakdown
python3 -m json.tool data/research/strategy/analysis/g3g4/latest_strategy_g3g4_breakdown.json >/dev/null
```

说明：若时间或资源更紧，可临时去掉第 2 条 phaseb-search，保留第 3-5 条完成最小可审计闭环。
