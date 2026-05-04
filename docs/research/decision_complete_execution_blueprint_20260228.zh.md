# OpenAlice Decision-Complete 执行蓝图（补齐治理接口）

日期: 2026-02-28  
适用范围: E7/E8/E9（以及与 E1-E6 的联动执行）  
状态: `PRE-FLIGHT LOCK REQUIRED`

本文件定义 6 个“开工前必须锁死”的执行细节，目标是消除评审口径争议与事故处理扯皮。

## 0. 开工阻断条件（Hard Blockers）

以下任一项未完成，禁止进入实现与上线阶段:

1. RACI 表未填入实名 DRI/备份/on-call，且未签字确认。
2. `degrade_to_H0` 状态机未以表格形式写入并通过评审。
3. alpha-spending 与 FDR 公式未固化到版本化文档。
4. `champion_registry` 原子更新与回滚策略未落盘。
5. `datasetSnapshotId/protocolHash` 生成规范未固定版本。
6. Go/No-Go 证据包模板未发布且未完成演练。

## 1. RACI / Owner 锁定

### 1.1 实名 RACI（必须填人名）

| Workstream | DRI (唯一) | Backup | Night On-Call | Accountable | Consulted | Informed |
|---|---|---|---|---|---|---|
| E7 协议与配置治理 | `<NAME>` | `<NAME>` | `<NAME>` | Tech Lead | Runtime, Data, QA | All |
| E8 线上闭环指标化 | `<NAME>` | `<NAME>` | `<NAME>` | SRE Lead | Runtime, Trading | All |
| E9 统计与晋级治理 | `<NAME>` | `<NAME>` | `<NAME>` | Research Lead | Stats, Runtime | All |
| 发布与回滚治理 | `<NAME>` | `<NAME>` | `<NAME>` | Incident Commander | All DRI | All |

### 1.2 响应 SLA（默认）

1. P0 交易阻断/误交易: 首响 `<= 5 分钟`，缓解 `<= 30 分钟`。
2. P1 指标重大偏离: 首响 `<= 15 分钟`，缓解 `<= 2 小时`。
3. P2 非阻断缺陷: 首响 `<= 4 小时`，缓解 `<= 1 工作日`。

### 1.3 值班规则

1. 每个 workstream 只有一个 DRI，对结果负责，不可并列。
2. 夜间 on-call 必须可执行 `pause/degrade/recover` 操作。
3. DRI 不在线时，Backup 自动接管，责任同级。

## 2. degrade_to_H0 状态机（不可歧义）

### 2.1 状态定义

1. `NORMAL`: 正常策略运行。
2. `WATCH`: 风险预警，降档但不强制退回 H0。
3. `DEGRADE_H0`: 强制切换到 H0 策略配置。
4. `PAUSE_NEW_OPENS`: 暂停新开仓，仅允许减仓/平仓。
5. `RECOVERY_SHADOW`: 影子恢复验证阶段。

### 2.2 迁移优先级（同一 tick 多条件命中时）

1. `MANUAL_HARD_PAUSE`（最高）
2. `RELEASE_GATE_BLOCK`（missing/expired/failed）
3. `EXECUTION_BREAKER`（连续漂移超阈）
4. `SLO_HARD_BREACH`
5. `SLO_WARN_BREACH`
6. `RECOVERY_READY`

### 2.3 进入/退出/冷却规则

| 当前状态 | 进入条件 | 退出条件 | 最小驻留时间 | 自动动作 |
|---|---|---|---|---|
| NORMAL | 所有 hard gate 通过 | 任一 WARN/HARD 触发 | 0 | 正常策略 |
| WATCH | 任一 WARN 命中（无 HARD） | WARN 连续清零 `>= 12h` | 30 分钟 | 风险降档 1 级 |
| DEGRADE_H0 | `EXECUTION_BREAKER` 或 `SLO_HARD_BREACH` | hard breach 连续清零 `>= 48h` | 24 小时 | 切换 H0 |
| PAUSE_NEW_OPENS | `MANUAL_HARD_PAUSE` 或 release gate 阻断 | 人工解除 + health pass | 12 小时 | 禁止新开仓 |
| RECOVERY_SHADOW | 从 DEGRADE_H0 满足恢复前置 | shadow 通过后进 NORMAL；失败回 DEGRADE_H0 | 7 天 | H0 实盘 + challenger 影子 |

### 2.4 人工 Override 优先级

1. `L2 Incident Commander`: 可放宽/收紧，TTL `<= 2h`，必须写审计理由。
2. `L1 Ops On-Call`: 仅可收紧，不可放宽。
3. `L0 Auto`: 默认自动策略。

冲突裁决: `L2 > L1 > L0`。任何人工覆盖到期后自动回到 `L0` 重评估。

## 3. alpha-spending + FDR 固化

### 3.1 周期预算定义

1. 单 campaign 最大周期: `C_max = 20`
2. 总显著性预算: `alpha_total = 0.10`
3. 预算下限: `alpha_floor = 0.005`

### 3.2 每 cycle 消耗函数（固定）

记:

- `t`: 当前 cycle（从 1 开始）
- `alpha_remaining`: 剩余预算
- `C_remaining = C_max - t + 1`

定义:

`alpha_t = max(alpha_floor, min(0.015, alpha_remaining / (C_remaining + 1)))`

更新:

`alpha_remaining = alpha_remaining - alpha_t`

### 3.3 晋级判定（必须同时满足）

1. `p_i <= alpha_t`
2. 同 cycle 内候选经 BH 程序后 `q_i <= 0.10`
3. `effect_i >= MDE_t`
4. 原有业务 gate 通过（收益、成本、风险、稳定性）

### 3.4 MDE 固化

`MDE_t = max(0.005, 1.645 * sigma_ref / sqrt(n_eff))`

- `sigma_ref`: 最近 5 个 cycle 的 H0 `robust_std` 中位数
- `n_eff`: `seed_count * valid_windows`

### 3.5 预算熔断

若 `alpha_remaining < 0.01`，进入 `HOLDOUT_ONLY`:

1. 禁止新冠军晋级 live。
2. 仅允许 shadow/诊断实验。
3. 必须由 DRI 触发“新 campaign”重置预算。

## 4. champion_registry 原子更新与回滚

### 4.1 写入责任

唯一写入方: 离线晋级管道（run_cvar_next_matrix / completion 流程）。  
运行时进程只读，不可写。

### 4.2 原子写流程（必须执行）

1. 获取锁: `.locks/champion_registry.lock`
2. 读取当前 registry（版本号 `version`）
3. 构造新 payload（`version + 1`，含 `previousHash`）
4. 写入临时文件: `champion_registry.json.tmp.<pid>`
5. `fsync(temp)` 后执行 schema 校验
6. `rename(temp, champion_registry.json)`（原子替换）
7. 追加 journal: `champion_registry.journal.jsonl`
8. 释放锁

### 4.3 写失败回滚

1. 任一步失败保持旧 `champion_registry.json` 不变。
2. 写入 `promotion_failed` 事件并记录错误码。
3. 不允许“半写入”状态参与运行时读取。

### 4.4 运行时读取 fail-safe

1. 若读取/解析失败:
   - 优先使用内存中最近一次有效 champion（最大 1 小时）。
2. 若无可用缓存:
   - 强制 `DEGRADE_H0`；
   - 若同时 release gate 阻断，进入 `PAUSE_NEW_OPENS`。

## 5. datasetSnapshotId / protocolHash 统一规范

### 5.1 规范版本

1. Canonicalization: `canon:v1`（RFC 8785 JCS）
2. Hash 算法: `sha256:v1`

### 5.2 protocolHash 生成

输入对象（字段必须齐全）:

1. `protocolVersion`
2. `splitSpec`
3. `seeds`
4. `timeframe`
5. `symbolAllowlist`
6. `costModel`
7. `profile`
8. `codeVersion.gitSha`
9. `datasetSnapshotId`

输出格式:

`protocolHash = "phash:v1:" + sha256_hex(canonical_json_bytes)`

### 5.3 datasetSnapshotId 生成

输入对象:

1. `dataProvider`
2. `venue`
3. `symbols`（升序）
4. `timeframe`
5. `timeRange`
6. `rowCount`
7. `sourceFiles`（每个文件含 `path`, `size`, `sha256`）

输出格式:

`datasetSnapshotId = "dsnap:v1:" + sha256_hex(canonical_json_bytes)[0:24]`

### 5.4 一致性防抖

禁止多实现各自序列化。必须通过单一库/脚本生成（同一版本）。

## 6. Go/No-Go 验收证据包（一次性提交）

### 6.1 必交工件

1. `decision_packet/manifest.json`
2. `decision_packet/protocol_spec.json`
3. `decision_packet/protocol_hash.txt`
4. `decision_packet/comparability_report.json`
5. `decision_packet/champion_registry_snapshot.json`
6. `decision_packet/release_gate_status.json`
7. `decision_packet/offline_metrics.json`
8. `decision_packet/live_shadow_metrics_14d.json`
9. `decision_packet/state_machine_log.jsonl`
10. `decision_packet/decision.md`

### 6.2 数值化阈值（默认）

1. `transferPassRatio_rolling14d >= 0.25`
2. `winnerEligibleRatio_rolling14d >= 0.35`
3. `meanPbo <= 0.20`
4. `meanDsrProbability >= 0.50`
5. `FDR q <= 0.10`
6. `quote_age_p95 <= 2000ms`（live 模式）
7. `decision_to_submit_p95 <= 800ms`
8. `decision_to_first_fill_p95 <= 2500ms`
9. `release_gate_status_age <= 24h` 且未过期

### 6.3 会议裁决规则

1. 任一 hard threshold 不满足 => `NO-GO`
2. 仅 warning 超标可进入 `GO with constraints`（必须附限制条款）
3. 所有 hard threshold 满足且证据包齐全 => `GO`

## 7. 执行清单（Pre-flight Checklist）

1. [ ] RACI 实名完成并签字  
2. [ ] 状态机迁移表在代码/文档双处一致  
3. [ ] alpha/FDR/MDE 公式写入版本化文件  
4. [ ] champion_registry 原子写流程演练通过  
5. [ ] protocolHash 与 datasetSnapshotId 双语言一致性测试通过  
6. [ ] Go/No-Go 证据包模板试跑通过  

---

本文件即 E7/E8/E9 开工前门槛定义。未满足第 0 节任一项，不得开工。

## 8. V3.6 锁死补充（执行前争议消解）

### 8.1 Reason Code 单一真源

1. 唯一文件: `docs/research/templates/verdict_reason_codes.v1.json`
2. 命名规则: `SEVERITY_SUBJECT_CONDITION`（全大写下划线）
3. Canonical 码固定使用 `HARD_MISSING_ARTIFACT`
4. `HARD_ARTIFACT_MISSING` 仅作为废弃别名，校验器必须拒绝并提示 canonical 名称

### 8.2 Python 入口回退策略（机器可执行）

1. 统一执行器: `scripts/python_fallback.ts`
2. 解释器回退顺序:
   - `OPENALICE_PYTHON_BIN`
   - `./.venv/bin/python`
   - `python3`
   - `python`
3. 所有治理入口必须通过 `pnpm` 调用该执行器

### 8.3 Exit Code 与 CI 判定映射

唯一映射文件: `docs/research/templates/ci_exit_code_map.v1.json`

| 命令 | 0 | 2 | 3 | 127 |
|---|---|---|---|---|
| `freeze:verify` | PASS | POLICY_FAIL | TOOL_ERROR | ENV_ERROR |
| `evidence:validate` | PASS_OR_CONSTRAINED | NO_GO | TOOL_ERROR | ENV_ERROR |
| `runtime:replay-state` | PASS | REPLAY_INVALID | TOOL_ERROR | ENV_ERROR |

CI 聚合规则:
1. 任一 `TOOL_ERROR` / `ENV_ERROR` => pipeline `error`
2. 任一 `POLICY_FAIL` / `NO_GO` / `REPLAY_INVALID` => pipeline `failed`
3. 全部命令返回 0 后，读取 `decision_packet/verdict.json` 决定最终状态
