# OpenAlice 系统诊断与改进计划 (2026-05-04)

> 合并 paste 分析文档与实时系统诊断，修正优先级。

---

## 一、paste 文档与实际系统状态对比

paste 文档 (`paste-2026-05-04-212855-f44fbfe2.md`) 提出了三层问题：运行层、策略层、验证层。
但实际诊断发现运行层的大部分 P0 问题**已经不存在或从未存在**。

### 1.1 paste 声称的 P0 运行故障 — 逐个核实

| paste 声称 | 实际状态 | 结论 |
|-----------|---------|------|
| OKX 数据连接完全中断 (EHOSTDOWN 169.254.0.2:443) | `curl https://www.okx.com` → HTTP 200, 0.93s | **不存在**，OKX API 正常 |
| 180 个脏文件隔离阻止所有订单 | `git status --short` 195行，全部是 staged archive deletions + 12个 untracked 新文件，无 modified 文件 | **不存在**，这是 archive 清理不是 dirty worktree |
| 纸交易全部 dryRun=true | paper_decision 显示 `close_only_due_to_data_quality_gate`，但数据门本身正常工作 | **部分属实** — 阻塞来自 promotion gate + 数据过期，不是 dryRun |
| paper_trade_microstructure_stress.ts:451 编译错误 | tsc 报错来自 node_modules/zod v4 locales (`esModuleInterop`)，非脚本本身语法错误；tsx 运行正常 | **不存在**，是 zod v4 类型兼容问题 |
| 市场情报刷新卡在 dryRun | 需要进一步核实 | 待查 |
| 持续改进循环 dryRun | 需要进一步核实 | 待查 |
| 成交量突破永久跳过 | paper_decision 显示 cross_sectional lane 被 `market_intel_lane_not_allowed` | 待查具体 gate 逻辑 |

### 1.2 实际阻塞原因

当前纸交易被阻塞的真实原因：

1. **数据过期** — live_accumulated 1h 数据最后更新于 ~7小时前 (May 4 14:07 local ≈ 06:07 UTC)。当前 UTC 时间 13:31，数据过期约 7.5 小时。数据质量门正确地将状态设为 `degraded`，`allowClose=true, allowOpen=false`。
2. **Promotion Gate 未通过** — `market_intel_lane_not_allowed:cross_sectional`。策略推广门要求所有实验通过才允许对应 lane 交易。
3. **策略推广状态为 QUARANTINED** — 所有门 (Research, Monetization, Paper, Live) 均 FAIL。

### 1.3 数据门控代码核实

`src/runtime/data_quality_gate.ts` 的 `resolveGateCapabilities()`:
- `good` → `allowOpen=true, allowClose=true` ✅
- `degraded` → `allowOpen=false, allowClose=true` ✅ (paste 要求的改进已经存在)
- `bad` → `allowOpen=false, allowClose=false` ✅

paste 文档的 Phase 1.1 "数据门控修复" **不需要做** — 代码已经正确。

---

## 二、纸质交易真实画像 (来自 paper_pnl_diagnostics)

### 2.1 核心指标

| 指标 | 数值 | 评价 |
|------|------|------|
| 总已平仓 | 945 笔 | 样本量足够 |
| 胜率 | 37.57% | 远低于回测 53.5% |
| 总 PnL | -26.81% (-$2,825) | 深度亏损 |
| 利润因子 | 0.714 | 每赚 $1 亏 $1.40 |
| 最大连亏 | 14 笔 | 风险控制失效 |
| 成本覆盖率 | 0% (0/945) | **所有 edge 声称无法验证** |
| 上下文覆盖率 | 1.06% | 99% 交易无决策快照 |

### 2.2 退出方式

| 退出原因 | 笔数 | 占比 | 胜率 | 总 PnL% |
|---------|------|------|------|---------|
| holding_expired (48h) | 884 | 93.5% | 38.46% | -13.26% |
| stop_loss | 42 | 4.4% | 0% | -9.19% |
| take_profit | 15 | 1.6% | 100% | +3.79% |
| marketintel_banned | 3 | 0.3% | 0% | -6.09% |
| liquidation | 1 | 0.1% | 0% | -2.05% |

**核心问题**: 93.5% 靠 48h 定时器退出，仅 1.6% 触发止盈。止损 100% 亏损，平均持仓 < 30 秒。

### 2.3 各策略通道

| 通道 | 笔数 | 胜率 | 总 PnL% | 利润因子 |
|------|------|------|---------|---------|
| cross_sectional | 22 | 36.36% | -17.91% | 0.484 |
| cross_sectional_10x | 5 | 40% | +4.53% | 3.051 |
| cross_sectional_100x | 1 | 0% | -2.05% | 0 |
| volume_breakout_1x | 106 | 46.23% | -2.21% | 0.841 |
| volume_breakout_3x | 106 | 46.23% | -2.21% | 0.841 |
| volume_breakout_10x | 17 | 29.41% | -2.56% | 0.352 |
| volume_breakout_100x | 9 | 33.33% | -1.35% | 0.280 |
| microstructure_10x | 301 | 36.54% | -0.99% | 0.913 |
| microstructure_100x | 378 | 34.13% | -2.06% | 0.783 |

12 个账户中仅 stress_10x (+0.68%) 为正收益。

---

## 三、策略层面根因分析

基于 paper_pnl_diagnostics 和 paste 文档的交叉验证，确认以下根因：

### 根因 #1: 低流动性资产无过滤 (P0)
- APT-USDT: 17笔，23.53%胜率，-13.41% PnL，已被 MarketIntel 拉黑
- ORDI-USDT: 22笔，72.73%高胜率但单笔最大亏损 -7.6%（肥尾）
- WIF-USDT, TRX-USDT, PEPE-USDT 等 meme/低流动性币种造成不成比例的损失
- **5个最差币种占交易量18%但贡献约40%总亏损**

### 根因 #2: 退出逻辑原始 (P0)
- 93.5% 靠 48h 定时器退出 → 盈利仓拿不住，亏损仓死扛
- 无 ATR trailing stop，无分批止盈
- 止盈仅 1.6% 触发 → 盈利空间未被有效捕捉

### 根因 #3: 成本证据缺失 (P0)
- 0/945 笔交易有开仓成本记录
- 无法计算 net edge → 无法区分 skill vs luck
- Monetization Gate 的 11 项硬障碍之一

### 根因 #4: 回测过拟合 + 资产池过小
- 回测仅 6 个资产，生产 universe 33 个 → 策略在生产环境表现远差于回测
- PBO = 1.0 表示完全过拟合
- Sharpe 90 是虚假信号

### 根因 #5: Governance 门槛 + 上下文缺失
- 99% 交易无决策快照 → scoring 在信息真空中操作
- 缺乏 PanicIndex 联动，无 regime 感知
- Stale data 时缺乏强禁止

### 根因 #6: 止损入场时机问题
- 42 笔止损 100% 亏损，平均持仓 < 30 秒
- 这不是止损策略问题，是入场时机/滑点问题
- 尤其 microstructure_100x 通道：20笔止损占该通道亏损 72.1%

---

## 四、修正后的实施计划

### Phase 0: 恢复数据刷新 (必须先做)

#### 0.1 诊断并修复数据累积 cron
- **问题**: live_accumulated 数据过期 7+ 小时
- **文件**: `scripts/cron_accumulate_live_data.sh` 及对应的 ts 脚本
- **动作**:
  - 检查 cron 是否还在运行
  - 检查 OKX API 数据拉取逻辑 (使用 `--live` 模式)
  - 确保 1h 和 1s 数据定期更新

#### 0.2 验证数据质量门行为
- **状态**: 代码已正确 (`degraded → allowClose=true, allowOpen=false`)
- **动作**: 确认 paper_decision 正确反映数据质量状态

### Phase 1: 策略代码改进

#### 1.1 流动性/Spread 过滤 (P0 → 改为最高优先)
- **文件**:
  - `src/domain/strategy/cross-sectional-momentum.ts`
  - `src/domain/strategy/volume-breakout.ts`
- **改动**:
  - 添加 `minDailyVolumeUsd: 10_000_000` (1000万USD)
  - 添加 `maxSpreadBps: 20`
  - 在 paper_trade 脚本中添加流动性检查

#### 1.2 ATR Trailing Stop + 分批止盈
- **文件**:
  - `src/domain/strategy/risk/atr-trailing-stop.ts` (已存在，需集成)
  - `src/domain/strategy/cross-sectional-momentum.ts`
  - `scripts/paper_trade_cross_sectional.ts`
- **改动**:
  - trailing stop: ATR multiplier 2
  - 分批止盈: +1% 平 50%, 剩余 trailing stop
  - 缩短默认持有期 48h → 24h

#### 1.3 强制成本证据
- **文件**:
  - `scripts/paper_trade_cross_sectional.ts` (line ~605-611)
  - `scripts/paper_trade_volume_breakout.ts` (line ~161-163)
- **改动**:
  - 开仓时从 API 获取实时 spread
  - 写入 `routeCostBps`, `roundTripCostBps`, `markMatchPenalty`
  - 开仓前计算 `expectedNetEdge = expectedGrossEdge - estimatedCost`

#### 1.4 Governance 门槛 + PanicIndex 联动
- **文件**:
  - `src/domain/strategy/governance/action-gate.ts`
  - `src/domain/strategy/governance/scoring.ts`
  - `src/domain/strategy/cross-sectional-momentum.ts`
- **改动**:
  - probe 门槛: 55 → 65
  - attack/attack-lite: 强制 eventSafety >= 16
  - staleDataApplied === true → 禁止开仓（当前仅降分）
  - panicIndex > 50 → 自动降级 action
  - panicIndex > 75 → ATR multiplier 2 → 1

#### 1.5 策略通道配置保护
- **文件**:
  - `src/runtime/market_intel_constants.ts`
  - `scripts/continuous_improvement_loop.ts`
- **改动**:
  - 确认 spot_1x 和 conservative_3x 的 strategyLane 固定
  - 保护用户配置不被 linter 覆盖

### Phase 2: 回测与验证

#### 2.1 回测扩展
- **文件**: `scripts/continuous_improvement_loop.ts`
- **改动**:
  - 资产池: 6 → 20+
  - 引入 CPCV (Combinatorial Purged Cross-Validation)
  - 强制 OOS period >= 纸交易观察期
  - PBO > 0.3 自动拒绝

#### 2.2 启用持续改进循环
- 将 `--dryRun` 改为 false
- 允许系统自主学习优化参数

---

## 五、关键文件清单

### 策略核心
- `src/domain/strategy/cross-sectional-momentum.ts` — 横截面反转策略
- `src/domain/strategy/volume-breakout.ts` — 成交量突破策略
- `src/domain/strategy/governance/action-gate.ts` — 行动门控
- `src/domain/strategy/governance/scoring.ts` — 评分系统
- `src/domain/strategy/risk/atr-trailing-stop.ts` — ATR 追踪止损
- `src/domain/strategy/panic-index.ts` — 恐慌指数
- `src/domain/strategy/execution.ts` — 执行决策管线

### 风险管理
- `src/domain/trading/guards/guard-pipeline.ts` — 守卫管线
- `src/domain/trading/guards/registry.ts` — 守卫注册
- `src/domain/trading/production-leverage-guard.ts` — 杠杆硬阻断

### 数据与门控
- `src/runtime/data_quality_gate.ts` — 数据质量门 (已正确实现)
- `src/runtime/paper_open_context.ts` — 上下文快照
- `src/runtime/pit-guard.ts` — PIT 守卫
- `src/runtime/market_intel_constants.ts` — 通道/阈值定义

### 执行脚本
- `scripts/paper_trade_cross_sectional.ts` — 横截面执行器
- `scripts/paper_trade_volume_breakout.ts` — 成交量突破执行器
- `scripts/paper_trade_microstructure_stress.ts` — 微结构压力
- `scripts/continuous_improvement_loop.ts` — 持续改进循环

### 配置与数据
- `src/core/config.ts` — 主配置
- `data/research/best_config.json` — 当前最佳参数
- `data/runtime/strategy_promotion.latest.json` — 策略推广状态
- `data/research/paper_pnl_diagnostics.latest.json` — PnL 诊断报告

---

## 六、一句话总结

OpenAlice 的实际问题比 paste 文档描述的更集中：**运行层基本正常，数据过期是唯一运行问题；核心矛盾在策略层 — 低流动性资产无过滤 + 原始退出逻辑 + 成本证据缺失 + 回测严重过拟合**。修复优先级应为：恢复数据刷新 → 流动性过滤 → 退出逻辑 → 成本证据 → Governance → 回测重建。
