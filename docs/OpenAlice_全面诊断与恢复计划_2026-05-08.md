# OpenAlice 系统恢复与 Alpha 证伪计划（执行版）

**日期**: 2026-05-08
**项目**: OpenAlice v0.9.0-beta.8
**源码**: `src/` `scripts/` `data/`
**版本**: v3 — 合并盈利诊断 + Alpha证伪计划 + 工程化执行框架 + Day 0 前置验证

---

## ⚠️ 先读这句

**策略信号公式里有 `× 0.25 × 3` 这个魔法数字。没有任何复杂的风控架构能修复信号本身没有 edge 这个事实。** 建了 BL 优化器、HCA 聚类、WFO 验证框架来包裹一个拍脑袋的参数——这套架构越复杂，越是给噪音穿西装。在证明信号有 alpha 之前，修任何东西都是负收益。

---

## ⚠️ 复杂度警告

**当前系统需要 3-5 人专职量化团队维护，但实际只有一个人。** 34个交易对 × 3个策略通道 × 4个账户层 × 8个因子 × 5层风控 × 12项门控 × AI自优化循环 × cron调度 × 锁文件机制 × 三套账本口径 × BL+HCA分配器。这不是一个"先修好再优化"的项目——它的初始设计就假设了团队规模。任何单人恢复计划都必须以"砍掉"开头，而不是"修复"。

---

## 审稿式总批评（自检）

当前版本已正确地将 OpenAlice 从"盈利恢复计划"改写为"系统恢复与 Alpha 证伪计划"，但仍存在几个核心缺陷：

1. **文档过度框架化，执行路径偏散。** P0-P3、WFO/PBO/DSR/FDR、MFE/MAE、regime、资产准入、AI 自优化等内容同时展开，但缺少最小闭环优先级，容易导致实际执行时无法聚焦。
2. **P0 完成标准仍不够工程化。** "连续 24-48 小时稳定运行"需要拆成明确 healthcheck，包括 cron 最近成功时间、数据 freshness、锁文件年龄、报告生成时间、错误日志阈值和健康检查退出码，否则 P0 是否完成仍然依赖人工判断。
3. **账本分离虽然正确，但仍缺少 append-only event log。** shadow / paper / actual 不能只靠最终表格区分，必须通过不可变事件流记录 SIGNAL_CREATED、GATE_EVALUATED、ORDER_SUBMITTED、ORDER_FILLED、POSITION_CLOSED、PNL_ATTRIBUTED 等事件，否则 PnL 仍可能被事后拼表污染。
4. **统计验证名词完整，但计算定义不足。** WFO、PBO、DSR、FDR 必须明确窗口长度、fold 数、objective、trial count、通过阈值和失败阈值，否则这些指标只是验证口号，不能成为 promotion gate。
5. **Kill criteria 太粗。** Gross PF、Net PF、OOS PF 不应单独作为杀策略依据，还需要 bootstrap confidence interval、tail loss、cost sensitivity、parameter stability 和 regime-specific 表现，否则容易误杀或漏杀。
6. **Market regime 要求不合理。** 不是所有策略都应在多个 regime 下盈利。每个策略应预先声明 target regime，并在非目标 regime 自动暂停或降仓，而不是要求所有策略跨 regime 普遍有效。
7. **最小闭环中的 BTC/ETH/SOL only 不适合验证 cross_sectional alpha。** 三资产 universe 只能验证数据、账本、执行和成本归因，不足以验证横截面排序策略。
8. **Passive route 验证必须基于 order intent 样本，而不是只统计 filled orders。** 否则会忽略未成交、部分成交、撤单、过期和 missed alpha，导致低估真实执行成本。
9. **资产准入规则还缺少交易所约束。** 包括 tick size、lot size、min notional、fee tier、post-only、reduce-only、funding interval 等。没有这些约束，策略层允许交易不代表执行层可交易。
10. **文档缺少数据泄漏与样本污染控制。** 所有 universe、regime、特征、参数搜索和 OOS 验证必须 point-in-time；任何人工看过结果后修改规则，都应记录为一次 trial，并污染原 OOS 窗口。
11. **AI 自优化 read-only 必须通过权限隔离强制实现。** 不能只靠约定。应禁用文件写入、git push、production config 修改和破坏性 shell 命令，只允许输出 patch diff 到 review queue。
12. **文档缺少项目级退出条件。** 若连续 60 天 paper net PF < 1.05、所有策略 OOS PF < 1.00、PBO 持续高风险、DSR 持续失败，应停止策略交易方向，只保留数据管道、回测框架和风控系统，转为 alpha research。
13. **Alpha 验证假设了时间稳定性，但 crypto alpha 是时变的。** OOS 需要 100+ 笔交易，但 crypto market regime 半衰期可能是数周——验证完时 regime 已经消失。需要用 CPCV 做 structure-break-aware 的交叉验证，而非固定窗口 OOS。
14. **没有先做离线 alpha 验证就开始修基础设施。** 在证明信号有 edge 之前，修复 corepack/tsx/锁文件是浪费。Day 0 应该是：读 shadow ledger，做 confidence bucket 分析，判定信号是否是噪音。
15. **AI 自优化循环已失败 500+ 次，没有审计它在崩溃期间写了什么。** 每次失败前 AI 都在读坏数据、生成建议——不知道有多少"AI 优化"已经污染了策略配置。必须先审计再恢复。
16. **回测数据存在存活偏差。** 当前 34 个币种的 universe 不包含已下架/归零的币种，回测 universe 天生比真实环境更安全。需要纳入已退市资产做 survivorship-bias-free 验证。
17. **系统复杂度超过单人维护上限。** 34 交易对 × 3 策略 × 4 账户层 × 8 因子 × 5 风控 × 12 门控 × AI 自优化——初始设计假设了团队规模。单人恢复计划必须以"砍掉"开头，不是"修复"。
18. **策略公式里的 `× 0.25 × 3` 是整个系统的缩影。** 没有任何复杂的风控架构能修复信号本身没有 edge 这个事实。建了 BL 优化器、HCA 聚类、WFO 验证框架来包裹一个拍脑袋的参数——架构越复杂，越是给噪音穿西装。

---

## 核心风险声明

当前 OpenAlice 最大风险不是某个策略参数错误，而是系统尚未处于可验证状态：

1. **Shadow PnL、paper PnL 与 actual account equity 口径混杂**，无法得出统一的盈亏结论。
2. **交易上下文覆盖率为 0%**、成本覆盖率约 0.21%、MFE/MAE 覆盖率为 1.06%。任何关于"降成本后扭亏""提高置信度后改善""删除亏损币种后盈利"的判断，都只能视为**待验证假设**，不能作为恢复交易或 promotion 的依据。
3. **系统 alpha 尚未被证明存在。** 当前所见亏损归因只是亏损的解释，不等于修复后就能盈利。
4. 在 context coverage、cost coverage、ledger integrity、route execution quality、WFO/PBO/DSR/FDR 验证全部恢复前，系统只能进入 shadow / paper / replay 模式，**禁止 live trading**。

---

---

## Day 0 前置验证：信号是 Alpha 还是噪音？（先于一切修复）

**在修任何一行代码之前，先回答这个问题：信号本身有没有 edge？**

如果离线历史数据上扣除真实成本后没有正期望，修 corepack、修锁文件、修路由、修止损——全部是负收益。正确的顺序是：**离线验证先于任何基础设施修复。**

### 验证脚本（≤ 30 分钟可执行）

读 `data/paper_trading/paper_policy_shadow_ledger.jsonl`，按 confidence bucket 分组，输出每桶的 gross PF / net PF (扣除估算成本) / win rate：

| confidence bucket | trade count | gross PF | net PF (est.) | win rate |
|-------------------|-------------|----------|---------------|----------|
| 0.00-0.10 | | | | |
| 0.10-0.20 | | | | |
| 0.20-0.35 | | | | |
| 0.35+ | | | | |

**判定**: 如果高 confidence 桶的 net PF 不显著高于低 confidence 桶 → **信号就是噪音 → 停止全部修复，转为 alpha research。**

### 这个验证的局限性（必须标注）

1. **Point-in-time 数据**: Shadow ledger 的信号用的是当时的实时 K 线（可能是修订前的），但你回测时的成本估算用的是当前费率——二者时间不匹配。
2. **存活偏差**: 当前 universe 里的 34 个币种是"活到今天"的 34 个。回测期间已经下架/归零的币种不在数据里——你的回测 universe 天生比真实环境更安全。Bailey, Borwein, Lopez de Prado & Zhu (2014) 在 *Pseudo-Mathematics and Financial Charlatanism* 里把这一点列为量化策略最常见的隐性作弊。
3. **多次测试**: 即使"只看一眼"数据，选择 confidence bucket 的边界本身就是一次 implicit trial。Lopez de Prado 的 Deflated Sharpe Ratio (DSR) 正是针对这个问题：Sharpe 需要按 trial count 做 haircut。
4. **成本模型的时变性**: Crypto market 的 spread 在低流动性时段可以扩大 5-10 倍，逆向选择在趋势行情中可以变成 30+ bps。离线成本估算用的是一个静态数字，不是实测。

**所以 Day 0 脚本的产出只能回答一个问题：有没有任何证据表明这个信号值得继续研究？** 答案如果是"没有"，后面的修复计划可以扔掉。答案如果是"高 confidence 桶的 PF 确实更好"，才有理由进入 Phase 0。

### Day 0 通过后: Day 1 完整离线回测

在 PIT 约束下做完整回测:
- 用**当时可用**的 K 线数据（非修订后）
- **存活偏差修正**的 universe（包含已下架币种）
- **CPCV** 交叉验证（Combinatorial Purged Cross-Validation）——不按时间顺序切 train/test，而是按时间簇做组合交叉验证，每个 fold 覆盖不同 regime，避免 regime 切换导致的虚假 OOS 表现
- **DSR haircut**（按 trial count 调整 Sharpe 显著性）
- 动态成本模型（至少按波动率分档的 spread/slippage 估算）

Day 1 的结果决定是否进入 Phase 0。

> **参考**: Lopez de Prado, *Advances in Financial Machine Learning*, 第 8 章 "Feature Importance" 和第 11 章 "The Deflated Sharpe Ratio"。当前系统设计问题几乎每一个都在那两章里有对应的量化警告。

---

## AI 自优化写入审计（Day 0 必须同步完成）

`cron_continuous_improvement` 已经失败 **500+ 次**，但失败不等于无写入。每次崩溃前 AI 循环可能在读坏数据、生成建议、写入某处。**在重新启用 AI（即使是 read-only）之前，必须先审计 AI 循环已经写了什么。**

### 审计清单

```bash
# 1. 检查 AI 是否有写入过策略配置
git log --all --oneline --author="openalice\|ai\|agent\|claude" --since="2026-04-01"

# 2. 检查 data/ 下是否有 AI 生成的 patch/建议文件
find data/ -name "*.patch" -o -name "*improvement*" -o -name "*ai_gen*" -o -name "*suggestion*" -mtime -30

# 3. 检查策略配置是否被非人工修改
git diff origin/dev -- data/config/strategy.json data/config/risk.json
```

### 审计结论

- **无污染**: 可以按计划进入 Phase 0 read-only 模式
- **有污染但可回滚**: git revert 污染 commit，标记污染窗口
- **有污染且无法确认范围**: 策略配置需要从头重建，所有 AI 关联文件进入 quarantine 目录

---

## 第 0 阶段：最小闭环（先于一切 P0-P3）

**当前 OpenAlice 的状态是：基础设施坏了、数据覆盖断了、账本口径乱了、策略证据缺失。且 Day 0 验证通过——信号有微弱证据值得继续研究。**

在这种状态下，最优先不是把全部验证体系一次性设计完整，而是先恢复一个最小闭环：

```
market data → signal → paper order → fill simulation → exit → PnL attribution → report
```

### 最小闭环范围

```
资产:   BTC / ETH / SOL only（3 个，仅用于验证数据/账本/执行链路）
杠杆:   1x only
执行:   paper only
AI:     read-only（权限隔离强制）
100x:   excluded
microstructure: excluded
低流动性币: excluded
策略:   单资产 breakout 或 signal replay only（不建议 cross_sectional，3 资产横截面无意义）
日志:   full context + cost + event logging
MFE/MAE: full logging
```

**重要**: BTC/ETH/SOL only 的 3 资产 universe **不能验证 cross_sectional alpha**。横截面排序需要 ≥10 个资产且所有资产数据 freshness 合格才有统计意义。最小闭环阶段只验证：数据管道、账本完整性、执行链路、成本归因。不验证策略盈利能力。

### 最小闭环完成标准

```
连续 7 天稳定运行（非 14 天 — 7 天足以暴露基础设施问题）
0 stale data
0 stale lock
context coverage > 95%
cost coverage > 95%
paper ledger valid（基于 event log，非拼表）
no real money execution
pnpm healthcheck:phase0 退出码 = 0
```

**最小闭环阶段的三种可选模式**:
1. **signal replay only**: 仅重放历史信号，验证数据和账本状态机
2. **single-asset breakout**: BTC only，验证完整执行链路
3. **no-trade paper ledger**: 仅跑状态机不产生订单，验证 ledger 完整性

---

## 一、总体盈亏概况（严格分账本口径）

### 1.1 三套账本，三个结论

| 账本 | 含义 | 能否作为真实盈利证据 | 当前状态 |
|------|------|---------------------|----------|
| **Shadow / 反事实交易** | 系统假设会做的交易（含所有杠杆倍数叠加复记） | **不能** — 未经过实际执行验证 | 947 笔，-26.81% |
| **Paper execution** | 模拟执行交易（经过门控过滤） | **部分可以** — 但样本量极小 | 24 笔 |
| **Actual account equity** | 实际账户权益变动 | **仅作为账户层观察事实** — 需核验 | 合计 +0.02% |

**关键纠正**:
- **-26.81% 主要来自 shadow / counterfactual ledger，不应直接等同于真实账户亏损。**
- **Actual account equity 当前接近持平（+0.02%），但不能直接证明风控有效。** 由于实际执行样本仅 24 笔，且 accounts.json 为空、100x 账户仍有未平仓、funding/fee/slippage/mark-to-market 口径仍需核验，该结果只能作为账户层观察事实，不能作为策略或风控有效性的证据。
- **系统处于"既不赚钱也不亏钱，但什么也做不了"的状态。**

### 1.2 四个账户权益（实际口径，仅供参考）

| 账户 | 初始权益 | 当前权益 | 总回报 | 状态 |
|------|----------|----------|--------|------|
| spot_1x | $100,000 | $99,856.26 | -0.14% | 已全部平仓 |
| conservative_3x | $100,000 | $99,797.31 | -0.20% | 已全部平仓 |
| stress_10x | $100,000 | $100,679.92 | **+0.68%** | 唯一盈利 |
| liquidation_probe_100x | $100,000 | $99,750.00 | -0.25% | 仍有未平仓 |
| **合计** | **$400,000** | **$400,083.49** | **+0.02%** | 几乎持平 |

### 1.3 宏观指标（shadow 口径，仅供参考，不得用于决策）

| 指标 | 数值 | 评判 |
|------|------|------|
| 累计已平仓交易 | 947 笔（含影子） | 包含多杠杆叠加复记 |
| 实际执行交易 | 24 笔 | 经过门控过滤 |
| Shadow 统计盈亏 | -26.81% | 非实际账户亏损 |
| Shadow 胜率 | 37.57% | 低于随机 |
| Shadow 盈亏比 | 0.71 | < 1.0 |
| Shadow 最大连续亏损 | 14 笔 | 需确认是否跨账本 |

### 1.4 账本架构：必须基于不可变事件流

所有 ledger 必须基于 **append-only event log** 生成，不允许直接手工改写最终 PnL 表。每个 PnL 数字必须可追溯到 event_id 序列。

**事件类型定义**:
```
SIGNAL_CREATED → GATE_EVALUATED → ORDER_INTENDED →
ORDER_SUBMITTED → ORDER_FILLED / ORDER_PARTIALLY_FILLED / ORDER_CANCELLED →
POSITION_OPENED → POSITION_UPDATED → POSITION_CLOSED → PNL_ATTRIBUTED
```

**每事件必含字段**:
```
event_id          — UUID v7（时间有序）
parent_event_id   — 上游事件
ledger_type       — shadow | paper | actual
strategy_id       — 策略标识
signal_id         — 信号标识
order_id          — 订单标识
position_id       — 仓位标识
timestamp_exchange — 交易所时间
timestamp_local   — 本地时间
event_type        — 事件类型枚举
payload_hash      — payload 内容哈希
source_module     — 产生事件的模块
schema_version    — schema 版本
```

**当前必须补充的交易级字段**（覆盖率 → 目标）:
- 成本记录: 0.21% → ≥95%
- 预期毛/净收益: 0% → ≥95%
- MFE/MAE 路径: 1.06% → ≥95%
- V3 上下文快照: 0% → ≥95%

---

## 二、策略逻辑深度拆解（含证据等级）

> 以下分析中的"亏损原因"均为**事后归因**。在没有样本外验证和完整成本证据前，这些解释不能直接作为修复方向的依据。

### 2.1 横截面反转 (cross_sectional) — 最大 shadow 亏损源

**源码**: `src/domain/strategy/cross-sectional-momentum.ts:1-249`
**纸面执行**: `scripts/paper_trade_cross_sectional.ts:1-2918`
**证据等级**: 低级（shadow 口径，上下文 0%，成本证据 0%）

**信号公式**:
```
riskAdjustedScore = primaryReturn/σ × (1-mtfWeight) + secondaryReturn/σ × mtfWeight + fundingAdjust
fundingAdjust = -clamp(fundingRate/0.05, -1, 1) × 0.25 × 3
```

按 score 升序排列 → 底部 N 名做多，顶部 N 名做空。要求回报率离散度 ≥ 5%。

**Shadow 战绩**: 24 笔真实交易，胜率 41.7%，总亏损 -3.76%，盈亏比 0.892

**致命缺陷**:

| 缺陷 | 详情 | 证据等级 | 可验证 |
|------|------|----------|--------|
| 融资率调整为硬编码魔法数字 | `× 0.25 × 3` 无理论依据 | 零 | 否 |
| 最小离散度 5% 门槛过低 | 强制信号在无效分布上运行 | 低 | 需样本外验证 |
| 无流动性过滤 | `minDailyVolumeUsd` 存在但字段未填充 | 可验证 | 是 |
| 48 小时固定到期退出 | 93.5% 以 `holding_expired` 结束 | 低 | 需 MFE/MAE |
| 等权排名 | 小币种波动大，主导排名两端 | 中 | 需量化分析 |

**使用限制**: cross_sectional 需要 ≥10 个资产且所有资产数据 freshness 合格才有统计意义。在 universe < 10 时自动降级为 signal replay only。

**ORDI-USDT 悖论（shadow 口径，仅供参考）**: ORDI shadow 胜率 72.7%，但总 PnL -11.11%。盈利交易每笔赚极少，亏损交易一笔（-7.60%）抹去 12 笔盈利。

### 2.2 成交量突破 (volume_breakout) — 成本吞噬收益

**源码**: `src/domain/strategy/volume-breakout.ts:1-237`
**纸面执行**: `scripts/paper_trade_volume_breakout.ts:1-1044`
**证据等级**: 低级

**信号公式**:
```
volumeRatio = currentVolume / medianVolume(24 bars)
rangeBreakout = close > max(high[-12:-1])
confidence = volumeRatio × breakQuality × rangeBreakoutPct 的复合函数
```

**Shadow 战绩**: 1x/3x 各 106 笔，胜率 46.2%，各亏损 -2.21%，盈亏比 0.841

**致命缺陷**:

| 缺陷 | 详情 | 严重程度 |
|------|------|----------|
| 5 分钟 K 线中位数成交量仅 24 bar | 2 小时历史，样本量太小 | 高 |
| `breakQuality` 只看单根 K 线收盘位置 | 忽略跳空、影线突破 | 中 |
| 3% 固定止损对 3 倍杠杆太紧 | BTC 日均波动 ~2-3% | 高 |
| 持仓仅 6 根 bar（30 分钟） | 不足以让突破趋势发展 | 高 |
| taker_taker 路由成本 43 bps | 即使信号正确，净收益为负 | 高 |

**硬性执行门槛**: 只有当 median expected move > 3 × total execution cost 时，volume_breakout 才允许交易。否则直接禁止。

### 2.3 微观结构压力 (microstructure) — 100x 通道永久禁用

**源码**: `scripts/paper_trade_microstructure_stress.ts:1-1457`
**证据等级**: 极低（缺乏 L2 order book、spread、latency、fill model）

**Shadow 战绩**: stress_10x 301 笔（胜率 36.5%, -0.99%），liquidation_probe_100x 378 笔（胜率 34.1%, -2.06%）

| 参数 | stress_10x | liquidation_probe_100x |
|------|-----------|----------------------|
| 杠杆 | 10x | 100x |
| 最大持仓 | 120 秒 | 30 秒 |
| 止损 | 0.25% | 0.08% |
| 止盈 | 0.35% | 0.12% |

**100x 通道缺乏的基本执行条件**: L2 order book 深度（缺失）、bid-ask spread 实测（unknown）、latency measurement（缺失）、fill simulator（缺失）、queue position model（缺失）、liquidation/margin model（不完整）。

> **结论**: 100x 通道永久禁用，不进入任何 promotion level，不进入 live，不参与收益统计。

---

## 三、交易成本深度分析

### 3.1 四条路由成本拆解

| 路由 | 手续费 | 价差 | 滑点 | 逆向选择 | 队列损失 | 资金费率 | **总成本** | 预算 | 状态 |
|------|--------|------|------|----------|----------|----------|------------|------|------|
| passive_passive | 4 | 2 | 4 | 5 | 3 | 0 | **18 bps** | 20 | 通过 |
| passive_taker | 7 | 4 | 8 | 3 | 2 | 0 | **24 bps** | 20 | 超支 |
| taker_taker | 10 | 8 | 12 | 6 | 4 | 3 | **43 bps** | 20 | 严重超支 |
| twap | 7 | 6 | 7 | 4 | 3 | 0 | **27 bps** | 20 | 超支 |

### 3.2 成本证据置信等级

每个 cost component 必须标记 source 和 confidence:

| 成本项 | 证据来源 | 置信等级 |
|--------|----------|----------|
| fee | 交易所费率表 / account tier | **高** |
| spread | 实时 bid-ask | **中/高** |
| slippage | 实际成交 vs decision price | **低**（需 real fills） |
| adverse selection | 成交后价格漂移 | **低**（需 passive tests） |
| queue loss | order book replay | **极低**（无 L2 replay） |
| funding | exchange funding history | **中/高** |

> 18 bps 和 43 bps 不是精确数字。在 slippage 和 adverse selection 置信等级为低/极低的情况下，真实执行成本可能显著偏离纸面估算。

### 3.3 "passive_passive 降成本后扭亏" — 该假设需要证伪

Maker 成本低，不代表 maker 执行质量好。

**passive_passive 的隐藏成本**:

| 隐藏问题 | 解释 |
|----------|------|
| 不成交风险 | 信号出现后挂单未成交，错过行情 |
| 逆向选择 | 只有价格反向扫到挂单时才成交 = 被动接刀 |
| 队列损失 | 排队靠后，吃不到好成交 |
| Missed alpha | 信号窗口很短，等成交时 alpha 已衰减 |

**关键**: route evaluation **必须基于 order_intent 样本**，而不是 filled_order 样本。只分析 filled passive orders 会产生选择偏差（只有被市场打到的挂单才进入统计）。

**必须统计的完整 intent 样本**:
```
intent_count           — 发出的总意图数
fill_rate              — 成交率
partial_fill_rate      — 部分成交率
cancel_rate            — 撤单率
expire_rate            — 过期率
missed_alpha_bps       — 未成交造成的 alpha 损失
post_fill_adverse_selection_bps — 成交后逆向选择
implementation_shortfall_bps    — 执行缺口
```

**最终评价公式**:
```
expected_net_edge_after_route =
  fill_rate × realized_edge_when_filled
  + partial_fill_rate × realized_edge_when_partial
  - missed_opportunity_cost
  - adverse_selection_cost
  - operational_cost
```

**passive_passive rollback 条件**:
1. fill_rate < 40%
2. missed_alpha_bps > saved_cost_bps
3. adverse_selection_bps > 10 bps
4. net PF 低于 taker benchmark

---

## 四、基础设施全面瘫痪

### 4.1 三层阻断

```
第 1 层 (环境): corepack/tsx 未安装
      ↓
第 2 层 (进程): 8 个 cron/launchd 任务全部失败
      ↓
第 3 层 (业务): 锁文件死锁 → 门控过期 → 证据链断裂 → 全通道封锁
```

### 4.2 所有失败进程

| 进程 | 错误 | 影响 |
|------|------|------|
| realtime_shadow_monitor | `spawn corepack ENOENT` | 影子交易信号完全停摆 |
| cron_continuous_improvement | `tsx: command not found` | AI 自我优化停摆 |
| cron_cp_intake | `tsx: command not found` | 策略候选摄取停摆 |
| cron_market_intel_context | `tsx: command not found` + 锁死锁 | 市场情报不再更新 |
| cron_paper_pnl_diagnostics | `tsx: command not found` | PnL 数据停在 5 月 5 日 |
| cron_paper_trade_volume_breakout | `not promotion-v2 gated` | 突破通道被门控跳过 |
| paper_policy_shadow_settle | 锁死锁 | 影子结算永久跳过 |
| microstructure_stress | `accumulate-1s failed` | 微结构策略双停 |
| agent-sdk | `exited with code 1` | AI 推理后端崩溃 |

### 4.3 锁文件死锁

```
cron_market_intel_context: 锁年龄 > 3 天, staleAfterSeconds: 3600, ×650+ skip
paper_policy_shadow_settle: 锁年龄 > 3.5 天 (304,027s), staleAfterSeconds: 3600, ×300+ skip
```

根因: 持有锁的进程已崩溃，但无锁超时强制释放逻辑。

---

## 五、风控门控与信号质量

### 5.1 12 项必检清单（6/12 通过）

6 项阻断: 多源数据目录(68%)、AI-Scientist 二次验证(18%)、量化框架基准(0%)、策略缺陷登记(29%)、ETH 前瞻证据(28/100)、发布门控盈利性(0%)。

### 5.2 发布门控 — 五项全败

WFO（窗口比率 0.6 > 0.3）、统计显著性（PBO/DSR/FDR 缺失）、风险模拟（缺失）、经济性（3/4 路由超预算）、策略计划一致性（配置不匹配）。

### 5.3 纸面门控 — 40+ 项阻断

核心: paper_days 7<14, closed_trades 12<20, live_universe 5<20, evidence_trust 6项全失败, trial_ledger 5项失败, stop_loss_cluster 42笔。

### 5.4 上下文覆盖率: 0%

| 上下文状态 | 交易数 | 占比 |
|-----------|--------|------|
| ok（正常） | **0** | **0%** |
| missing | 937 | 99.1% |

### 5.5 信号置信度分布

| 置信度区间 | 占比 |
|-----------|------|
| 0.00-0.05 | 32% |
| 0.05-0.15 | 41% |
| 0.15-0.20 | 18% |
| **0.20+** | **9%** |

### 5.6 实时数据覆盖

有实时数据的币种: 5 个（BTC、ETH、SOL、BNB、XRP），策略 universe: 34 个，覆盖率: 14.7%，其余 29 个: `stale: 41h`。

**约束**: 当实时数据覆盖率 < 95% 时，禁止运行 cross_sectional 排名策略。

---

## 六、策略缺陷登记册

48 个已登记缺陷: P0=10（全部开放）、P1=18（9 开放+9 部分完成）、P2/P3=20（部分完成或观察中）。

P0 包括: 固定参数未自适应、止损未使用 ATR、滑点遥测缺失、订单簿深度检查未实现、小币种流动性过滤未生效、PBO=1.0 未解决。

---

## 七、根因全链路

```
策略设计缺陷（魔法数字、止损不对称、流动性过滤缺失）
         ↓
信号质量差（置信度 < 0.2, 上下文 0%）
         ↓
┌────────┼────────┐
↓        ↓        ↓
交易成本  门控触发  基础设施
吞噬收益  全部阻断  瘫痪
         ↓
系统完全锁死
```

**按严重程度排序**:

| # | 根因 | 影响面 | 修复难度 |
|---|------|--------|----------|
| 1 | 基础设施崩溃 (corepack/tsx) | 所有定时任务 | 低 |
| 2 | 锁文件死锁 | 市场情报、影子结算 | 低 |
| 3 | 信号公式硬编码魔法数字 | 所有策略信号 | 中 |
| 4 | 无止盈逻辑 | 盈利头寸全部反转 | 中 |
| 5 | 路由成本 43 bps > 信号期望收益 | 即使信号正确也亏 | 中 |
| 6 | 止损未按波动率自适应 | 高波动币种频繁扫损 | 中 |
| 7 | 流动性过滤缺失 | APT/ORDI 造成大部分亏损 | 中 |
| 8 | 上下文数据 98.9% 缺失 | 所有决策基于不完整信息 | 高 |
| 9 | 统计验证全部失败 | 策略缺乏统计证据 | 高 |
| 10 | 48 个已知缺陷未修复 | 系统整体可靠性 | 高 |

---

## 八、分级 Promotion 体系

当前 promotion 门槛过重，缺少中间级别。必须区分:

| Level | 名称 | 目的 | 允许范围 | 关键 Gate |
|-------|------|------|----------|-----------|
| **L0** | Research | 离线探索 | 仅回测，无实时数据 | 无（自由探索） |
| **L1** | Replay | 历史重放验证状态机 | 历史数据重放 | event log 完整性 |
| **L2** | Shadow | 实时信号观察 | 实时数据，不下单 | 数据 freshness > 95% |
| **L3** | Paper-light | 最小模拟执行 | BTC/ETH/SOL, 1x, 单策略 | P0 healthcheck 通过 |
| **L4** | Paper-full | 完整模拟执行 | 完整 universe, paper only | context/cost coverage > 70% |
| **L5** | Live-probe | 极小实盘探针 | $500 max, 1x, 单策略 | WFO/PBO/DSR 通过 |
| **L6** | Live-limited | 受限实盘 | 限仓、限损、限策略 | L5 + paper gate 全通过 |
| **L7** | Live-normal | 正常实盘 | 全 gate 通过 | 全部 release gate + 60 天 L6 稳定 |

每级有独立 gate，不得跳级。当前系统处于 **L0 且基础设施不工作**，目标是先恢复到 L3（Paper-light）。

---

## 九、Alpha 证伪流程

### 9.1 核心问题

当前修复路线默认假设：策略本身可能有 edge，只是成本、止损、数据、执行出了问题。**但这没有被证明。**

如果策略本身没有 alpha，那么所有修复只是让系统更稳定地证明自己不赚钱。

### 9.2 Alpha 验证的 regime 时变问题

**Alpha 证伪流程面临一个内在张力**: OOS 验证需要 100+ 笔交易（需要数月），但 crypto market regime 半衰期可能是数周。验证完时那个 regime 可能已经消失了——你在用固定窗口验证动态目标。

**这不是逻辑悖论，而是要求验证方法必须是 regime-aware 的。** 解决方案：

1. **CPCV (Combinatorial Purged Cross-Validation)**: 不按时间顺序切 train/test，而是按时间簇做组合交叉验证。每个 fold 覆盖不同 regime，避免单一 regime 主导评估。Lopez de Prado 在 *Advances in Financial Machine Learning* 第 11 章详细讨论了 CPCV 如何解决"单一 OOS 窗口不可重复"的问题。

2. **Regime 切换检测**: 用 HMM 或 GARCH 结构断点检测识别 regime 切换点。在每个 regime 内独立评估策略表现。Ang & Timmermann (2012) *Regime Changes and Financial Markets* (Annual Review of Financial Economics) 提供了 regime 切换建模的理论框架。

3. **Regime-aware 持续评估**: 不等待"固定 OOS 窗口结束"才判定。每次 regime 切换自动触发评估：该 regime 内 PF > 1.00 则目标 regime 验证通过；非目标 regime 自动降仓/暂停。

### 9.4 四步证伪流程（修正版）

| 关卡 | 检查项 | 标准 | 不通过操作 |
|------|--------|------|-----------|
| 1 | Gross edge > 0? | Gross PF > 1.05 且 bootstrap 95% CI 上界 ≥ 1.05 | **直接 kill** |
| 2 | Net edge > 0? | Net PF > 1.00，且在成本降低 25% 情景下仍 > 1.00 | **修执行，否则 kill** |
| 3 | OOS net edge > 0? | OOS PF > 1.00，且连续两个 WFO fold 通过 | **判定过拟合** |
| 4 | Target regime 有效? | 目标 regime 内 PF > 1.00 | **非目标 regime 自动暂停** |

### 9.5 Market Regime 与策略匹配

**不是所有策略都应该在所有 regime 有效。** 每个策略必须预先声明 target regime。非目标 regime 的要求不是盈利，而是自动暂停或降低仓位。

| 策略 | Target Regime | Non-target Action |
|------|--------------|-------------------|
| volume_breakout | trend + high volume | pause |
| cross_sectional | high dispersion + sufficient liquidity | reduce / pause |
| funding reversal | funding extreme | pause |
| microstructure | high depth + low spread + low latency | research only |

**要求一个策略在多个 regime 都 PF > 1，等于要求鱼会爬树。然后宣布鱼战略失败。**

### 9.6 Kill Criteria（含防护）

| # | 条件 | 操作 | 防护 |
|---|------|------|------|
| 1 | Gross PF < 1.05 且 bootstrap 95% CI 上界 ≤ 1.05 | kill | 防止小样本误杀 |
| 2 | Net PF < 1.00 且在成本降低 25% 情景下仍 < 1.00 | kill | 防止仅因成本判死刑 |
| 3 | OOS PF < 1.00 且连续两个 WFO fold 失败 | kill | 防止单个 fold 偶然失败 |
| 4 | PBO ≥ 0.4 | kill | 0.2 ≤ PBO < 0.4 为 warning |
| 5 | Target regime PF < 1.00 持续 30 天 | kill | 给予足够观察期 |
| 6 | 样本数达 100 后 bootstrap 95% CI 上界 ≤ 1.00 | kill | 用 CI 替代点估计 |
| 7 | max drawdown > 30% 或 tail loss (CVaR 95%) > 15% | kill | 增加尾部风险条件 |
| 8 | 成本/上下文覆盖率不足 | 不允许 promotion（不 kill） | 基础设施问题 |

**辅助判断指标**（不单独触发 kill，但影响综合评估）:
- median trade expectancy 的 bootstrap CI
- cost sensitivity: 成本 +10% 后是否仍正期望
- parameter stability: 相邻参数值绩效是否平滑
- regime stability: 同一 regime 内绩效方差

**防恢复条款**: 被 kill 后不允许通过改名、换参数、删亏损样本重新进入 promotion，必须重新走 L0 → L1 → L2 完整研究流程。

---

## 十、修复实施方案

### P0 — 恢复系统运行能力（3-5 天）

**完成标准（可测试的验收项）**:

| # | 验收项 | 判定标准 | 检查命令 |
|---|--------|----------|----------|
| 1 | 所有必需 cron 恢复 | 最近成功运行时间 < 2 × 调度周期 | `pnpm healthcheck:p0` |
| 2 | Market data freshness | < 2 min | `pnpm healthcheck:p0` |
| 3 | Context generator | 最近成功运行 < 15 min | `pnpm healthcheck:p0` |
| 4 | Paper executor | 最近成功运行 < 15 min | `pnpm healthcheck:p0` |
| 5 | PnL report | 最近成功生成 < 24 h | `pnpm healthcheck:p0` |
| 6 | Runtime locks | 无 age > 2× expected_runtime 的 lock | `pnpm healthcheck:p0` |
| 7 | Error log | 最近 24h 内无 P0/P1 级异常 | `pnpm healthcheck:p0` |
| 8 | Healthcheck 脚本 | 退出码 = 0 | `pnpm healthcheck:p0` |

**必须创建的 healthcheck 脚本** (`scripts/healthcheck_p0.sh`):

```bash
#!/bin/bash
# P0 healthcheck — 所有检查项必须通过，退出码 0 表示 P0 完成
set -euo pipefail
FAIL=0

# 1. 必需 cron 最近成功时间
check_cron() {
  local name=$1 max_age=$2
  local last_run=$(cat "data/runtime/cron_${name}.latest.json" 2>/dev/null | jq -r '.lastSuccess' 2>/dev/null || echo "0")
  local age=$(( $(date +%s) - last_run ))
  if [ "$age" -gt "$max_age" ]; then
    echo "FAIL: cron ${name} last success ${age}s ago > ${max_age}s"
    FAIL=1
  fi
}
check_cron "realtime_shadow_monitor" 600
check_cron "market_intel_context" 900
check_cron "paper_pnl_diagnostics" 86400
# ... 其余 cron

# 2. Market data freshness
# ... 检查 data/runtime/live_data_freshness.latest.json

# 3. Lock file age
for f in data/runtime/locks/*.lock; do
  age=$(( $(date +%s) - $(stat -f %m "$f") ))
  if [ "$age" -gt 7200 ]; then
    echo "FAIL: stale lock $f age=${age}s"
    FAIL=1
  fi
done

# 4. Error log
if grep -q "P0\|P1\|FATAL\|ENOENT\|command not found" logs/*.log 2>/dev/null; then
  # 只检查最近 24h 的日志
  # ...
fi

exit $FAIL
```

**P0 需人工确认的项**:
- accounts.json 是否已配置（需 OKX demo API key，人工操作）
- Agent SDK OAuth 是否已认证

#### P0-1: 修复 corepack 环境

```bash
npm install -g corepack && corepack enable
which corepack && corepack pnpm --version
cd /Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice
pnpm add -D tsx
```

**脚本改进** — `scripts/launch_realtime_shadow_monitor.sh` 在第 28 行后插入:
```bash
if [[ "${#PNPM_CMD[@]}" -eq 0 ]] && command -v npx >/dev/null 2>&1; then
  PNPM_CMD=(npx pnpm)
fi
```

#### P0-2: 清理死锁文件 + 添加超时强制释放

```bash
rm -f data/runtime/locks/*.lock
```

**代码改进** — 在锁管理工具中添加超时强制释放:
```typescript
const STALE_LOCK_SECONDS = 3600
function acquireLock(lockPath: string): boolean {
  if (fs.existsSync(lockPath)) {
    const ageSeconds = (Date.now() - fs.statSync(lockPath).mtimeMs) / 1000
    if (ageSeconds > STALE_LOCK_SECONDS) {
      console.warn(`Force-releasing stale lock: ${lockPath} (age: ${ageSeconds}s)`)
      fs.unlinkSync(lockPath)
    } else { return false }
  }
  fs.writeFileSync(lockPath, String(process.pid), 'utf-8')
  return true
}
```

#### P0-3: 修复 Agent SDK

```bash
claude --version && claude auth status
# 如需要: claude auth login
# 如版本问题: pnpm update @anthropic-ai/claude-agent-sdk
```

#### P0-4: 创建账户配置

```bash
cp data/config/accounts.demo.template.json data/config/accounts.json
# 人工编辑: enabled → true, exchange → "okx", 配置 demo API key
```

**安全边界**: 在所有 P0/P1 gate 通过前，**禁止配置具备真实下单权限的 production API key**。只允许 demo trading key 或完全本地 paper executor。production key 必须保持 withdraw disabled、trade permission disabled 或不写入系统。

---

### P1 — 止血（4-6 周，含验证）

**前置条件**: P0 healthcheck 通过，最小闭环（Phase 0）连续运行 ≥7 天，context coverage > 30%，cost coverage > 30%。

**每个 P1 改动必须有 rollback condition。**

#### P1-1: 切换路由为 passive_passive

**目标**: `scripts/paper_trade_volume_breakout.ts`, `scripts/paper_trade_microstructure_stress.ts`

将默认路由从 taker_taker → passive_passive。显性成本 43 → 18 bps。

**验证要求**（基于 order intent 样本，非 filled only）: fill_rate, partial_fill_rate, cancel_rate, expire_rate, missed_alpha_bps, adverse_selection_bps, implementation_shortfall_bps。

**Rollback 条件**:
1. fill_rate < 40%
2. missed_alpha_bps > saved_cost_bps
3. adverse_selection_bps > 10 bps
4. net PF 低于 taker benchmark

#### P1-2: 置信度校准（需先做分桶+校准曲线验证）

**前置**: 必须完成 confidence 分桶回测 + 校准曲线。

**分桶表**:
| bucket | avg confidence | trade count | gross pnl | net pnl | win rate | PF | avg net return | ECE | monotonic? |
|--------|---------------|-------------|-----------|---------|----------|-----|----------------|-----|------------|
| 0.00-0.10 | | | | | | | | | |
| 0.10-0.20 | | | | | | | | | |
| 0.20-0.35 | | | | | | | | | |
| 0.35-0.50 | | | | | | | | | |
| 0.50+ | | | | | | | | | |

**校准通过条件**:
1. avg net return 随 confidence 单调上升（允许一个 bucket 例外）
2. 高 confidence bucket 样本数 ≥ 30
3. ECE (Expected Calibration Error) < 0.10
4. 高 confidence bucket net PF > 低 confidence bucket

仅当校准通过，才允许提高门槛。否则 confidence 只是一个装饰性数字。

**Rollback 条件**:
1. trade count 下降 > 70%
2. net PF 未提升
3. 高 confidence bucket 样本不足 30

#### P1-3: 资产准入规则（替代手工删币种）

**禁止**: 把"删除历史亏损币种后的回测改善"作为策略通过证据。

**资产进入 universe 的条件**:
1. `dailyVolumeUsd > $50M`
2. `spreadBps < 20`（需实时数据）
3. 最近 N 天数据完整率 > 95%
4. 无异常跳价 / 缺 K / stale data

**交易所微观结构约束**（新增）:
1. tick size 满足策略最小价格变动
2. lot size / min notional 满足策略最小下单量
3. maker/taker fee tier 已知
4. funding interval 已知且匹配策略持仓周期
5. 支持 post-only（passive 路由需要）
6. 支持 reduce-only（风控需要）
7. 标记价格与最新成交价偏差 < 阈值
8. 无合约异常（清算中/下架/仅减仓）

**任何不满足以上约束的资产，不得进入 universe。策略说可以买，交易所说"不行"的情况必须消除。**

#### P1-4: ATR 动态止损（需先做 MFE/MAE 分析）

**前置 MFE/MAE 分析**:

| 问题 | 意义 |
|------|------|
| 亏损交易是否曾经浮盈？ | 如果有，说明止盈差 |
| 止损后价格是否继续下跌？ | 如果是，止损有效 |
| 止损后价格是否经常反弹？ | 如果是，止损过紧 |
| 盈利交易最大回撤是多少？ | 用于设置 trailing stop |
| 不同币种 MAE 分布是否不同？ | 用于分币种止损 |

**实现** (`src/domain/strategy/volume-breakout.ts:47-56`):
```typescript
function computeAtr(candles: Bar[], period: number = 14): number {
  if (candles.length < period + 1) return 0
  let trSum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high, low = candles[i].low, prevClose = candles[i-1].close
    trSum += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
  }
  return trSum / period
}

export const DEFAULT_VB_CONFIG: VolumeBreakoutConfig = {
  stopLossPct: 0.03,        // 回退默认值
  atrStopMultiplier: 2.0,
  atrPeriod: 14,
  ...
}

// 止损计算:
const atr = computeAtr(candles, cfg.atrPeriod)
const dynamicStopPct = atr > 0 ? (atr / latest.close) * cfg.atrStopMultiplier : cfg.stopLossPct
const stopLoss = latest.close * (1 - Math.max(dynamicStopPct, cfg.stopLossPct * 0.5))
```

**Rollback 条件**:
1. max drawdown 增加 > 20%
2. avg loss 扩大 > 15%
3. MAE tail risk 扩大

#### P1-5: 100x 杠杆永久禁用

```typescript
{ id: 'liquidation_probe_100x', mode: 'disabled' }
```

无需证据前提，无需 rollback。

#### P1-6: 启用流动性过滤

确保 `dailyVolumeUsd` 字段被填充，`minDailyVolumeUsd` → $50M。

---

### P2 — 策略逻辑修复（8-12 周，含验证）

**前置条件**: P1 修复已通过至少 7 天观察，context coverage ≥ 70%，cost coverage ≥ 70%。

#### P2-1: cross_sectional 信号公式修复

移除硬编码 `× 0.25 × 3`，改为可配置参数 `fundingScaleFactor`（默认 1.0）。

同样修复 microstructure 中的 `(strength / 0.2) * Math.min(2, volumeRatio) / 2`。

#### P2-2: 引入主动止盈

参考 `paper_trade_cross_sectional.ts:1734-1753` 的 ATR trailing stop，添加分批止盈（50% @ 1.5R, 50% trailing）。

#### P2-3: 多时间框架确认

添加 1h K 线趋势过滤（SMA fast/slow 交叉确认突破方向）。

#### P2-4: breakQuality 改进

从单 K 线收盘位置改为加权: 收盘位置(0.35) + 实体方向(0.25) + 跳空确认(0.25) + 影线惩罚(0.15)。

#### P2-5: 统计验证（含完整计算定义）

**WFO 定义**:
```
train window: 60 days
test window: 14 days
step: 7 days
minimum folds: 6
objective: net PF / Sharpe / drawdown-adjusted return
pass condition: median OOS PF > 1.05 AND worst 25% fold PF > 0.95
```

**PBO 定义**:
```
method: CSCV (Combinatorial Purged Cross-Validation)
partitions: S = 8 or 10
strategy configurations: all parameter variants tested
objective: Sharpe or net PF
pass: PBO < 0.2
warning: 0.2 ≤ PBO < 0.4
fail: PBO ≥ 0.4
```

**DSR 定义**:
```
input: daily strategy returns after cost
adjustments: skewness, kurtosis, number of trials
pass condition: DSR probability > 95%
```

**FDR 定义**:
```
method: Benjamini-Hochberg
family: all tested strategy-parameter combinations
pass condition: q-value < 0.10
```

实现:
```typescript
export function benjaminiHochberg(pValues: number[], q: number = 0.1): boolean[] {
  const n = pValues.length
  const indexed = pValues.map((p, i) => ({ p, i }))
  indexed.sort((a, b) => a.p - b.p)
  let maxK = 0
  for (let k = 0; k < n; k++) {
    if (indexed[k].p <= (k + 1) * q / n) maxK = k + 1
  }
  const rejected = new Array(n).fill(false)
  for (let k = 0; k < maxK; k++) rejected[indexed[k].i] = true
  return rejected
}

export function computePBO(isSharpes: number[], oosSharpes: number[]): number {
  const combined = isSharpes.map((is, i) => ({ is, oos: oosSharpes[i] }))
  combined.sort((a, b) => b.is - a.is)
  const medianOos = median(oosSharpes)
  return combined[0].oos < medianOos ? 1
    : combined.filter(c => c.oos < medianOos).length / combined.length
}
```

---

### P3 — 系统加固（16-24 周）

#### P3-1: 上下文管道重构

目标: `contextBuckets.ok` 从 0% → >95%。

```
决策触发 → [记录快照] → 信号评估 → [记录信号] → 门控检查 → [记录门控结果] → 执行
```

#### P3-2: 锁文件超时守护进程

```typescript
function startLockCleanupDaemon(lockDir: string, intervalMs: number = 300_000) {
  setInterval(() => {
    for (const file of fs.readdirSync(lockDir)) {
      if (!file.endsWith('.lock')) continue
      const lockPath = path.join(lockDir, file)
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 3_600_000) {
          console.warn(`[LockCleanup] Force-releasing: ${file}`)
          fs.unlinkSync(lockPath)
        }
      } catch (err) { /* 可能已被删除 */ }
    }
  }, intervalMs)
}
```

#### P3-3: 策略自动淘汰

```typescript
interface StrategyHealthMonitor {
  lane: string
  consecutiveLosses: number; maxConsecutiveLosses: number  // 5
  rollingSharpe7d: number; minRollingSharpe: number        // 0
  maxDrawdown7d: number  // -10%
  tailLossCvar95: number; maxTailLoss: number             // -15%
}
```

#### P3-4: 数据质量实时监控

mark price freshness、spread quality、volume quality 全部实时校验。不通过 → 阻止交易。

#### P3-5: 满足纸面门控要求

| 门控 | 当前 | 目标 |
|------|------|------|
| paper_days | 7 | ≥14 |
| closed_paper_trades | 12 | ≥20 |
| live_data_quality | 5 | ≥20 |
| evidence_trust | 6 fail | 6 pass |
| stop_loss_cluster | 42 | <10 |

---

## 十一、数据泄漏、样本污染与存活偏差控制

量化系统常见泄漏及防控:

| # | 泄漏类型 | 防控规则 |
|---|---------|----------|
| 1 | 用未来 K 线算当前信号 | 所有特征必须 **point-in-time**（使用该时间点实际可获取的数据，非修订后数据） |
| 2 | 用全样本分位数定义当前 regime | Regime 分类不得使用未来数据 |
| 3 | 用未来成交量判断当前流动性 | 成交量过滤必须用当时已知数据 |
| 4 | 用完整历史 universe 回测过去 | Universe 必须 point-in-time |
| 5 | 用未来失败案例调整过滤规则 | 任何人工调整后，OOS 窗口重新定义 |
| 6 | 同一交易进入参数选择和效果验证 | 参数搜索和效果验证必须用不同数据 |
| 7 | 手工删除亏损币种后 OOS | 视同 trial，污染 OOS |
| 8 | 人工审查后修改规则 | 必须记录为一次 trial，OOS 降级为 IS |
| 9 | **存活偏差 (Survivorship Bias)** | Universe 只包含"活到今天"的币种，不包含已下架/归零币种——回测 universe 天生比真实环境更安全。必须纳入已退市资产做 survivorship-bias-free 验证。Bailey et al. (2014) 将此列为量化策略最常见的隐性作弊。 |
| 10 | **K 线修订 (Data Restatement)** | 交易所的历史 K 线会被修订。回测时看到的"历史价格"不等于当时实时推送的价格。必须用原始 tick/实时 snapshot 做验证，不能用修订后 K 线。Lopez de Prado 第 2 章将此称为 "backtest overfitting from information leakage through revised data"。 |

**核心规则**:
1. 所有 universe 必须 point-in-time（含已退市资产）
2. 所有 regime 分类不得使用未来数据
3. 所有参数搜索必须记录 trial count（用于 DSR 调整）
4. OOS 数据一旦参与人工决策，即降级为 IS
5. 删除币种、改阈值、调止损都必须记录为一次 trial
6. 每次人工审查后，重新定义 clean OOS window
7. 回测数据必须是当时实际可获取的版本（非修订后）
8. Universe 构建必须纳入历史上存在但现已退市的资产

**否则所谓 OOS 只是"被人类看过答案的考试"。而把退市币种排除在外，等于考前已经知道哪些题不会出现在试卷上。**

---

## 十二、资金费率与持仓周期统一口径

不同策略持仓周期不同（microstructure: 30s/120s, volume_breakout: 30min, cross_sectional: 48h），资金费率影响完全不同。

**规则**:
```
expected_funding_cost =
  funding_rate_per_interval × expected_holding_intervals × position_direction
```

**关键分离**:
- funding feature → 用于信号（alpha 侧）
- funding cost → 用于成本（cost 侧）
- 二者必须分离计算，不得双重计入

如果 funding 是每 8 小时结算，30 秒策略和 48 小时策略不能用同一套 fundingAdjust 解释。

---

## 十三、杠杆归因拆分

同一策略在不同杠杆下的 PnL 不能直接相加。杠杆会放大 PnL%、影响止损距离、产生非线性爆仓风险、放大手续费占保证金比例。

**规则**: 所有策略先在 **unlevered return** 口径下评估 alpha。杠杆只作为 portfolio/risk overlay，不得混入 signal quality 判断。

**字段**:
```
raw_asset_return
unlevered_strategy_return
leveraged_return
margin_return
liquidation_adjusted_return
```

否则 100x 的小波动会把统计表污染成鬼故事。

---

## 十四、AI 自优化权限隔离

**前置条件（Day 0 必须完成）**: `cron_continuous_improvement` 已失败 500+ 次。每次崩溃前 AI 循环可能在读坏数据、生成建议、写入某处。在重新启用 AI 之前，**必须先审计 AI 循环已经写了什么**。

审计步骤见上文 "AI 自优化写入审计" 章节。未完成审计前，AI 循环不得以任何模式启动。

**权限隔离（审计通过后）**:

AI read-only 不能只靠约定，必须通过权限层强制实现:

1. 禁用 write_file / edit_file
2. 禁用 git commit / git push
3. 禁用 rm / mv / chmod / chown
4. 禁用 production config 修改
5. 输出 patch diff 到 review queue
6. 人工 review 后才允许 apply

**任何 AI-generated patch 必须包含**:
```
root cause
changed files
test plan
rollback plan
risk rating (P0/P1/P2/P3)
```

AI 自优化循环不得在 P0 立即恢复为自动写入模式。先在 read-only / suggestion-only 模式运行，等待数据覆盖率、成本覆盖率、PnL ledger 全部恢复后，再允许进入 controlled patch generation。

---

## 十五、回滚规则

每个 P1/P2 改动必须具备 rollback condition:

| 改动 | Rollback 触发条件 |
|------|-------------------|
| passive_passive | fill_rate < 40% 或 missed_alpha_bps > saved_cost_bps 或 adverse_selection_bps > 10 bps |
| confidence threshold | trade count 下降 > 70% 或 net PF 未提升 或 high bucket 样本 < 30 |
| ATR stop | max drawdown 增加 > 20% 或 avg loss 扩大 > 15% 或 MAE tail risk 扩大 |
| 资产准入规则 | universe < 5 个合格资产 |
| 多时间框架确认 | 信号数下降 > 50% 且 net PF 未提升 |
| 主动止盈 | avg win 下降 > 20% 或 win rate 下降 > 15% |

**没有 rollback 的优化就是赌博，只是穿着工程服。**

---

## 十六、项目级退出条件

如果一直"再收集 14 天、再调一个参数、再换个 regime、再做一次 OOS"，项目会无限消耗。

**项目级 stop-loss**:

| # | 条件 | 操作 |
|---|------|------|
| 1 | 连续 60 天 paper net PF < 1.05 | 停止策略交易方向 |
| 2 | 所有策略 OOS PF < 1.00 | 停止策略交易方向 |
| 3 | PBO 持续 ≥ 0.4（连续 3 次评估） | 停止策略交易方向 |
| 4 | DSR 持续不通过（连续 3 次评估） | 停止策略交易方向 |
| 5 | 成本后 expectancy ≤ 0（连续 60 天） | 停止策略交易方向 |
| 6 | 修复投入超过预算但无单一策略通过 L4 gate | 停止策略交易方向 |

**触发后操作**:
- 停止策略交易方向
- 保留数据管道、回测框架、风控系统
- 保留 paper executor 和诊断系统
- 转为 alpha research 项目

**否则 OpenAlice 会变成一台"消耗时间但不给答案"的机器。人类已经有社交媒体了，不需要再造一个。**

---

## 十七、恢复时间线

```
Day 0-2:       Phase 0 最小闭环启动
               ├─ corepack/tsx 安装
               ├─ 锁文件清理
               ├─ Agent SDK 修复
               ├─ 安全屏障（禁止 production API key）
               └─ 启动 BTC/ETH/SOL paper only 闭环

Day 3-5:       P0 healthcheck 调试
               ├─ healthcheck:p0 脚本就绪
               ├─ 所有 cron 正常运行确认
               └─ 最小闭环连续运行观察

Day 6-14:      最小闭环稳定观察（7 天）
               ├─ 数据/账本/执行链路验证
               ├─ AI read-only 模式
               └─ MFE/MAE 基线建立

Day 15-21:     基线建立期
               ├─ confidence 分桶回测 + 校准曲线
               ├─ fill quality 基线（基于 order intent）
               └─ 资产准入规则定义（含交易所约束）

Day 22-35:     P1 止血 + 验证（2 周）
               ├─ 路由切换 passive_passive + intent 样本统计
               ├─ 置信度门槛调整（基于校准证据）
               ├─ 规则过滤上线
               ├─ ATR 止损（基于 MFE/MAE）
               ├─ 100x 禁用
               └─ 流动性过滤启用

里程碑 M1:     检查点 — P1 修复是否有效？
               ├─ context/cost coverage > 50%
               ├─ confidence 校准通过
               ├─ fill_rate + adverse_selection 可接受
               └─ 未通过 → rollback，不得进入 P2

Day 36-56:     P2 策略修复 + 统计验证（3 周）
               ├─ 信号公式改进
               ├─ 主动止盈（基于 MFE）
               ├─ 多时间框架确认
               ├─ WFO / FDR / PBO / DSR（完整计算）
               └─ Alpha 证伪（四步流程）

里程碑 M2:     检查点 — 策略 alpha 是否被证明？
               ├─ 至少一个策略通过 Alpha 四步证伪
               ├─ WFO/PBO/DSR/FDR 全部通过
               └─ 未通过 → 全线降级为 research

Day 57-90:     P3 系统加固（5 周）
               ├─ 上下文管道 → 95%+
               ├─ 48 缺陷修复
               ├─ 自动淘汰机制
               ├─ 数据质量监控
               ├─ Leakage control 审计
               └─ 纸面门控全部解除

里程碑 M3:     L5 Live-probe gate 检查
               ├─ 通过 → 考虑 $500 极小实盘探针（BTC/ETH/SOL, 1x）
               └─ 未通过 → 继续迭代，评估项目 stop-loss
```

---

## 十八、完全修复合计工作量

| 阶段 | 修复项 | 证据验证 | 实施 | 观察 | 总计 |
|------|--------|---------|------|------|------|
| Phase 0 | 最小闭环 | 0 | 1-2天 | 7天 | **8-9天** |
| P0 | 6 | Phase 0 通过 | 1-2天 | 2天 | **3-5天**（含 Phase 0） |
| P1 | 6 | 7天 | 2-3天 | 7天 | **16-17天** |
| P2 | 6 | 14天 | 5-7天 | 7天 | **26-28天** |
| P3 | 6 | 30天 | 7-14天 | 14天 | **51-58天** |

**合计**: Phase 0 + P0: 1-2 周, P0-P1: 4-6 周, P0-P2: 8-12 周, P0-P3: 16-24 周。

---

## 十九、关键发现总结

### 可确认的事实

1. **基础设施全面崩溃**: corepack/tsx 缺失导致 8 个定时任务全部停摆。
2. **系统处于"风控防护成功但业务瘫痪"状态**: 门控拦截了大多数低质量信号，但系统无法形成有效交易闭环。
3. **路由成本超支 115%**: taker_taker 43 bps > 预算 20 bps。
4. **上下文覆盖率为 0%**: 没有一笔交易拥有完整的决策上下文。
5. **策略 alpha 未被证明**: 归因只能解释历史亏损，不能预测修复后的盈利能力。
6. **统计证据链几乎全部断裂**: WFO/PBO/DSR/FDR 全部失败或缺失。
7. **实时数据覆盖 5/34**: universe 远大于有效数据覆盖范围。
8. **Actual account equity +0.02% 不能证明风控有效**: 仅 24 笔真实执行、账户配置为空、未平仓仓位未结算，该结果只能作为账户层观察事实。
9. **ORDI 高胜率低盈利悖论**: 胜率是虚荣指标，需要优化的是 Profit Factor。
10. **成本优化最容易见效但需验证**: passive_passive 18 bps 只是显性成本，真实执行成本需 intent 样本验证。

### 待验证假设（不得视为承诺）

| 假设 | 验证条件 |
|------|----------|
| 切换 passive_passive 后净收益改善 | 需 fill_rate、adverse_selection、missed_opportunity（intent 样本） |
| 提高 confidence 门槛可提升胜率 | 需 confidence 分桶 + 校准曲线 |
| ATR 动态止损可减少误触 | 需 MFE/MAE 分析 |
| 规则过滤低流动性币种可改善收益 | 需规则过滤 + OOS 验证（point-in-time） |

---

## 二十、最终判断

**策略公式里有 `× 0.25 × 3` 这个魔法数字——建了 BL 优化器、HCA 聚类、WFO 验证框架来包裹它。这是整个系统的缩影：外壳越来越像量化对冲基金，内核越来越像有 100 行注释的随机数生成器。**

当前最优先不是赚钱，而是回答一个根本问题:

**OpenAlice 是否有任何策略，在真实成本、真实成交、完整上下文、样本外验证下，仍然具备正期望？**

**正确的顺序是**:
1. **Day 0（今天）**: 读 shadow ledger，confidence bucket 分析。高 confidence 桶的 PF 是否显著高于低 confidence？不是 → 停止一切，转为 alpha research。
2. **Day 1（如果 Day 0 通过）**: PIT 约束离线回测 + 存活偏差修正 + CPCV + DSR haircut。
3. **Phase 0（如果 Day 1 通过）**: 恢复最小闭环，验证数据/账本/执行链路。
4. **P0-P3（仅在以上全部通过后）**: 修基础设施、修策略逻辑、系统加固。

如果答案最终是否定的，杀掉大部分交易逻辑，只保留:
- 数据管道
- 成本模型
- 回测框架
- 风控门控
- paper executor
- 诊断系统

然后从 alpha research 重新开始。

**最狠结论**:

这份计划从"幻想赚钱"进化到"知道自己可能不赚钱"，再到"先验证信号再修系统"。现在最该做的不是继续写文档，而是那个 **Day 0 脚本**——读 shadow ledger，按 confidence bucket 分组，输出 PF 和 win rate。这个脚本不需要修 corepack，不需要修锁文件，不需要任何基础设施修复。数据已经在磁盘上。答案可能让整个修复计划变成废纸——而知道这件事越早越好。

---

## 附录 A: 数据来源

| 数据 | 路径 | 最新时间戳 |
|------|------|-----------|
| PnL 诊断 | `logs/cron_paper_pnl_diagnostics.log` | 2026-05-05 |
| 影子账本 | `data/paper_trading/paper_policy_shadow_ledger.jsonl` | 2026-05-07 |
| 实际交易结果 | `data/paper_trading/paper_trade_result.jsonl` | 2026-05-07 |
| 系统状态 | `data/runtime/system_status_reason_chain.latest.json` | 2026-05-08 |
| 影子监控 | `data/runtime/realtime_shadow_monitor.latest.json` | 2026-05-08 |
| 路由成本 | `data/runtime/route_cost_budget.latest.json` | 2026-05-08 |
| 影子捕获 | `data/runtime/paper_policy_shadow_capture.latest.json` | 2026-05-08 |
| 错误日志 | `logs/openalice_main.launchd.err.log` | 2026-05-08 |
| Agent SDK 日志 | `logs/agent-sdk.log` | 2026-05-08 |

## 附录 B: 关键配置文件

| 文件 | 路径 | 关键内容 |
|------|------|----------|
| kill-switch | `data/config/kill-switch.json` | 默认 block_new_only |
| risk | `data/config/risk.json` | 5 阶段资金规模，max 5x leverage |
| strategy | `data/config/strategy.json` | 8 因子启用，volTarget=10% |
| crypto | `data/config/crypto.json` | OKX demo, BTC/ETH only |
| accounts | `data/config/accounts.json` | **空数组 — 需人工创建** |
| governance | `data/config/governance.json` | release/live/stats 三层门控 |
| review-gate | `data/config/review-gate.json` | 阻断 critical/high |

---

*本计划基于 OpenAlice 项目实际运行数据和源代码分析生成。所有数据截至 2026-05-08。执行版整合了盈利诊断报告的全部细节、Alpha 证伪计划的证据标准、以及针对 14 条工程缺陷的修正——包括最小闭环优先、可测试 healthcheck、append-only event log、分级 promotion、校准曲线、order intent 统计、交易所约束、数据泄漏控制、回滚规则、权限隔离和项目级 stop-loss。*
