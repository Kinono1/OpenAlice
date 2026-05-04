# OpenAlice 14天治理执行状态（2026-02-27）

本文记录 14 天计划在 2026-02-27 的关键落地状态，便于“边跑边治理”期间快速对齐。

## 已落地能力

1. 交易执行语义升级（partial fill）
   - `crypto-trading` 接口增加 `partially_filled` 状态。
   - 订单结果和钱包操作结果补齐请求量、剩余量、成交均价、首笔成交时间、完成时间、交易所更新时间戳等字段。
   - `live_gate_manager` 记录执行质量时优先使用真实成交时间字段，减少 `Date.now()` 回退导致的观测偏差。

2. 系统化代码审查门禁（review gate）
   - 配置入口：`data/config/review-gate.json`
   - 执行脚本：`scripts/systematic_review_gate.py`
   - npm 命令：
     - `pnpm review:repo`
     - `pnpm review:changed`
     - `pnpm review:gate`
   - 默认阻断级别：`critical + high`
   - 规则版本：`review-gate-v2`（含仓库特异结构化检查）

3. 回放协议门槛收敛到 stage2
   - `scripts/run_v2_protocol_replay.sh` 默认 `GATE_PROFILE=stage2`
   - matrix `full/smoke` 默认不再把 `stage1` 作为首选门槛
   - compare 阶段修复：即使 completion 文件缺失，也会继续执行基线比较

4. 日常治理流水线接入审查门禁
   - `scripts/daily_strategy_governance.sh` 默认新增前置步骤：
     1) review gate
     2) data pull
     3) external benchmark
     4) admission gate
     5) failure breakdown
     6) strategy optimize loop（adaptive）
     7) health check
     8) gate summary snapshot（含幂等 duplicate/retry 指标）
   - 可通过环境变量控制：
     - `RUN_REVIEW_GATE=0|1`
     - `REVIEW_GATE_MODE=repo|changed`
     - `REVIEW_GATE_BLOCK_SEVERITIES=critical,high`
     - `RUN_GATE_SUMMARY=0|1`

5. cross-process 幂等保障（F001）
   - 新增持久化幂等仓：`src/extension/crypto-trading/idempotency-store.ts`
   - `operation-dispatcher` 在下单前先做幂等占位（reserve），完成后写回成功/失败状态（finalize）。
   - `main.ts` 已接入默认存储文件：`data/runtime/trade_idempotency.json`
   - 同 ticket（或显式 idempotencyKey）重复请求会被拒绝，避免多进程/重启期间重复下单。
   - 对“已失败”的幂等记录支持受控重试：
     - 请求里显式 `forceRetryIdempotency=true` 才允许复用 key；
     - `forceRetryIdempotency` 现要求显式 `retryReason`；
     - 当启用 `ticketStore` 时，还要求可验证的 `retryApprovalTicketId`；
     - 会记录事件 `idempotency.retry_override`（成功重试）与 `idempotency.retry_rejected`（重试请求被治理拒绝）供审计。

6. realized PnL confidence 硬门控联动（F002）
   - `risk.ts` 对新开仓新增“realized PnL 可信度门控”：
     - source 必须在白名单内；
     - confidence 必须达到阈值。
   - `CcxtTradingEngine` 增强 realized PnL 来源判定：
     - 能从 balance payload 识别到字段（即使值为 0）=> `balance_payload` 高置信；
     - 若 balance 未提供字段，回退到“UTC 当日 closed trades ledger 聚合”=> `closed_trades_ledger` 中等置信；
     - 否则 => `derived_fallback` 低置信。
   - 新增配置（`risk.json`）：
     - `enforceRealizedPnlConfidence`
     - `minRealizedPnlConfidence`
     - `trustedRealizedPnlSources`
   - closed trades fallback 已支持按 `timestamp` 前进分页抓取（`pageLimit/maxPages`），降低高频场景单页欠采样风险。

7. 幂等事件治理可观测性补齐
   - `daily_gate_summary` 新增 `idempotencyEvents` 字段，按日汇总：
     - `duplicateCount` / `retryOverrideCount` / `retryRejectedCount`
     - `duplicateKeys` / `retryOverrideKeys` / `retryRejectedKeys`
   - `live_gate_manager` 在 `gate.daily.finalized` 事件里追加：
     - `idempotencyDuplicateCount`
     - `idempotencyRetryOverrideCount`
     - `idempotencyRetryRejectedCount`

8. cycle 实验降噪与无效 run 抑制（2026-02-28）
   - `scripts/continuous_strategy_search.py` 新增历史 gate 预筛：
     - 默认回看最近 `14` 个 cycle；
     - 统计 recipe 级别 `gate_pass_lift` 与 `eligible` 通过率；
     - 对“样本充足且双低通过率”的 recipe 进行候选剪枝，并在候选不足时自动回补。
   - cycle 执行改为“main 先行，Stage2 条件触发”：
     - 先执行主板（H0/H4/H5/H6）预算；
     - 仅当主板 winner 为 `eligible` 挑战者时，继续补跑 mixed S0/S1；
     - 主板回退到 H0 时默认跳过 Stage2，并在 cycle report 写入 `stage2SkipReason`。
   - cycle report / state 新增可观测字段：
     - `selectionMeta`（freshPool/poolAfterPrune/prunedByRecipe 等）
     - `stage2Executed`、`stage2SkipReason`

9. V3+ 治理诊断贯通（2026-02-28）
   - schema 升级：
     - `search_state.json` 增加 `searchStateSchemaVersion=2.1.0` 与 `searchStateSchemaFeatures`
     - cycle report 增加 `schemaVersion=2.1.0`、`schemaFeatures`
     - 历史记录自动回填 `legacyBackfilled`
   - regime 诊断升级：
     - `ml_ensemble_v1.py` 增加 `regimeSummary.diagnostics`
     - `wait_clean_and_retrain.py` 聚合到 `retrain/summary.json.regimeDiagnostics`
     - 记录 `fallbackRatio`、`numericWarningMean`、`clusterBalanceRatio`、`timeIndexMissMean`、`futureAlignmentRiskMean`
   - board 与决策增强：
     - `run_cvar_next_matrix.py` 将 regime 诊断写入 board 聚合列
     - `decision.md` 新增 `Regime Diagnostics Risk` 风险提示段落
   - 失败分解增强：
     - `failure_breakdown.py` 新增 fallback/numeric/survival/future-risk 的窗口趋势统计（保留 gate 失败主轴）

## 当前验证快照

1. 回归测试（截至 2026-02-27）
   - `394/394` 通过，`0` 失败。

2. 审查门禁（changed 模式）
   - 最近一次结果：`status=passed`，`blockingFindings=0`。

3. 交易风控与幂等测试
   - `idempotency-store.spec.ts`、`operation-dispatcher.spec.ts`、`risk.spec.ts`、`ccxt-pnl.spec.ts`、`CcxtTradingEngine.account.spec.ts` 已覆盖新增行为。
   - 当前全量测试：`394/394` 通过。

## 下一步（按原 14 天计划顺序）

1. 将幂等 key 与上游决策票据系统做更强绑定（尤其是人工重试审批链路）。
2. 为低置信交易所继续补充 exchange-specific 分页/游标策略，进一步降低 `derived_fallback` 阻断。
3. 针对 replay/治理链路持续补充高价值结构化审查规则并控制误报率。
