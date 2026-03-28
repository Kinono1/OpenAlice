# OpenAlice 现状深度分析审计

日期：`2026-03-11`  
仓库：`/Users/kino/Files/work_projects/code/expCode/effeciency/OpenAlice`  
活跃分支：`work/kino-mainline`

## 1. 结论摘要

1. `OpenAlice` 不是概念性仓库，而是已经完成平台级 MVP 闭环的本地 AI 量化交易系统。核心运行时、双 provider routing、Web UI、connector、wallet、guard、event log、cron、heartbeat、decision packet 都已真实接线并可运行。
2. 当前主阻塞不在平台能力缺失，而在量化策略主线的硬门控失败。`G0-G2` 已经通过，真正失败的是 `G3`，`G4` 只是被 `G3` 连坐后的决策层反映。
3. 仓库仍在活跃推进而非停摆。审计时工作树观察到 `git status --short` 共 `155` 条记录，其中 `modified=21`、`untracked=134`，说明研发仍在持续推进，但当前状态尚未收敛。
4. 平台层“能跑”不等于“可上线”。当前 `decision_packet/release_gate_status.json` 明确写着 `allowPaperTrading=false`、`allowLiveTrading=false`；同时，runtime 侧虽已存在 live-gate 相关代码，但当前 crypto 主执行路径对这批保护的接线完整性仍需继续核实，因此所有“交易能力存在”的说法都不能外推成“已放行”。
5. 旧的 G3/G4 策略路线已经被内部文档事实性降级为非 production-GO 路径。`docs/research/g3g4_stageC_rebuild_charter_20260303.md` 已明确把当前框架定位为需要重构，而不是继续做参数微调。
6. 当前研发焦点已经切向两条新线：一条是 `Stage-C` 的 signal / feature / candidate generator 重构，另一条是 `CORE7` 数据、归一化、feature base 与 baseline pipeline。两者都是真实投入方向，但目前都还不能写成“已经改善 G3”。

## 2. 产品/工程视角：能力成熟度矩阵

评级标准：

- `可用`：主链真实接线，已有明确运行入口，且局部测试足以支撑“可以工作”。
- `可用但有明显边界`：不是壳，但只适合单机/受控环境或缺少关键产品化条件。
- `半成品 / 研究态`：已有真实代码和产物，但恢复语义、长期可靠性或主链闭环还不成立。
- `阻塞 / 不可放行`：即使功能存在，也有硬门控或关键条件明确不满足。

本章对运行时执行保护相关证据分两级使用：

- `A 级硬证据`：可以直接支撑正文强结论，例如 `decision_packet/*`、`data/config/risk.json`、`data/config/crypto.json`、`idempotency-store.ts`、`risk_breaker_state.ts`、`telegram-plugin.ts`。
- `B 级候选证据`：代码能力存在，但当前主执行路径是否已完整接线仍需谨慎，例如 `release_gate_status.ts`、`live_gate_manager.ts`、`Wallet.ts`、`pnl-tracker.ts`、`operation-dispatcher.ts`。

### 2.1 核心运行时与 AI provider routing

- 成熟度：`可用`
- 一句话判断：核心运行时已经形成“统一 engine + 统一 session + 双 provider 可路由”的真实实现，不是 README 中的概念性描述。
- 实现证据：
  - `src/main.ts:278-317` 真实组装了 `ToolCenter`、`VercelAIProvider`、`ClaudeCodeProvider`、`ProviderRouter`、`AgentCenter`、`Engine`。
  - `src/core/ai-provider.ts:40-58` 说明 provider routing 是按请求生效，非启动时写死。
  - `src/core/session.ts:2-18,62-96` 说明两套 provider 共享统一 JSONL session store。
  - `src/ai-providers/vercel-ai-sdk/vercel-provider.ts:21-70` 与 `src/ai-providers/claude-code/claude-code-provider.ts:20-33` 说明两套 provider 都是实际 adapter，不是空壳占位。
  - `package.json:7-11` 暴露了 `dev`、`build:ui`、`build:backend` 等真实启动/构建入口。
- 运行/测试证据：
  - 审计中定向运行 `corepack pnpm exec vitest run src/core/engine.spec.ts src/ai-providers/vercel-ai-sdk/agent.spec.ts`，`14` 个测试全部通过。
  - `src/core/engine.spec.ts` 覆盖了 `ask()`、`askWithSession()`、session 写入与 compaction 路径。
  - `src/ai-providers/vercel-ai-sdk/agent.spec.ts` 覆盖了 tool-loop 与工具调用终止条件。
- 明确边界：
  - 这一层成熟度是“本地单机可用”，不是“生产级 provider 平台”。
  - `ProviderRouter` 切换依赖配置文件在请求时成功读取，没有看到更强的 failover 设计。
  - `ClaudeCodeProvider` 依赖本地 Claude Code CLI 可用；配置坏掉时更可能在请求期暴露。
- 结论：运行时主骨架足以支撑“平台不是空壳”这一判断，但不足以把 OpenAlice 描述成已经完成生产级 provider 管理和高可用。

### 2.2 Web UI 与运维控制面

- 成熟度：`可用但有明显边界`
- 一句话判断：UI 已经是一个真实的本地控制面，而不是聊天壳；但它明显是单机、单用户、本地运维导向，不是生产级多用户 admin console。
- 实现证据：
  - `ui/src/App.tsx:16-50` 实际挂了 `14` 个 route state。
  - `ui/src/components/Sidebar.tsx:41-110` 把 Chat、Portfolio、Events、Heartbeat、Data Sources、Connectors、Tools、Crypto、Securities、AI Provider、Settings、Dev 组织成完整导航。
  - `ui/src/pages/EventsPage.tsx`、`HeartbeatPage.tsx`、`TradingPage.tsx`、`SecuritiesPage.tsx`、`ToolsPage.tsx`、`DevPage.tsx` 都具备实操能力，不是占位页。
  - `src/connectors/web/web-plugin.ts:47-66` 实际挂载 `/api/chat`、`/api/config`、`/api/openbb`、`/api/events`、`/api/cron`、`/api/heartbeat`、`/api/crypto`、`/api/securities`、`/api/dev`、`/api/tools`，并对外提供 `dist/ui` 静态资源。
- 运行/测试证据：
  - `ui/package.json:5-8` 具备独立 `vite dev`、`tsc -b && vite build`、`vite preview` 生命周期。
  - 根 `package.json:7-10` 把 UI 纳入正式构建链，说明不是独立 demo。
- 明确边界：
  - `src/connectors/web/web-plugin.ts:32` 直接使用 `SessionStore('web/default')`，是单用户本地会话模型。
  - Web API 层未见登录、RBAC、租户隔离或权限中间件。
  - `ui/package.json` 没有第一方前端测试脚本，说明 UI 可构建但测试基线偏弱。
  - Connectors 页写“修改需要重启”，但后端配置路由会触发 reconnect，说明产品语义仍在收敛。
- 结论：可以把这部分写成“真实可用的本地控制面”，但不能写成“可上线的多用户运维后台”。

### 2.3 Crypto / Securities wallet + 风控 / 执行保护机制

- 成熟度：`可用但仅限受控环境`
- 一句话判断：交易链已经不是概念性代码，`engine -> wallet -> dispatcher -> guard pipeline -> toolCenter` 主链真实存在；但运行时依赖外部引擎在线，而且一部分更深的执行保护虽然代码存在，当前 crypto 主执行路径是否已完整启用仍需继续核实。
- A 级硬证据：
  - `src/main.ts:125-158,358-399,543-558` 真实接线了 crypto 与 securities 的 engine、wallet、state bridge、guard pipeline 与 tool registration。
  - 已落地的保护能力至少包括：
    - `max-position-size`
    - `max-leverage`
    - `cooldown`
    - `symbol-whitelist`
    - `decision-ticket`
    - `kill-switch`
    - `pre-trade quantitative risk`
  - `src/extension/crypto-trading/idempotency-store.ts` 明确实现了文件锁、TTL、atomic rename 的跨进程 idempotency reservation / finalize。
  - `src/runtime/risk_breaker_state.ts` 明确实现 execution breaker、daily PnL、consecutive loss 的跨重启持久化。
  - `data/config/risk.json` 已配置完整风控参数，且含 `5` 级 `capitalScaleRules`。
- B 级候选证据：
  - `src/runtime/release_gate_status.ts` 与 `src/runtime/live_gate_manager.ts` 表明 runtime 里存在 release-gate / pre-place-order 的阻断能力。
  - `src/extension/crypto-trading/operation-dispatcher.ts` 暴露了 `beforePlaceOrderGate`、`getRiskContext`、`estimateExpectedPrice`、`idempotencyStore` 等 option 注入点。
  - 但当前 `src/main.ts:375` 与 `src/main.ts:547` 创建 dispatcher 时调用的是 `createCryptoOperationDispatcher(engine)`，没有显式传入上述 option，因此这些 deeper runtime protections 是否已经进入当前 crypto 主执行路径，不能直接下强结论。
  - `src/extension/crypto-trading/wallet/Wallet.ts` 采用“先执行外部操作，再写 commit 持久化”的时序，存在潜在 crash window，但是否会形成可观测双执行风险仍待验证。
  - `src/extension/crypto-trading/pnl-tracker.ts` 只明确实现了内部 `avg-cost vs FIFO` 方法对账；系统是否已有第一方“内部成交记录 vs 交易所仓位”的完整 reconciliation 闭环，当前证据不足。
- 运行/测试证据：
  - 子代理定向运行了 `11` 个测试文件，共 `152` 个测试全部通过，覆盖 crypto guards、guard pipeline、risk、wallet、trading-safety、dispatcher，以及 securities wallet/dispatcher。
  - `src/extension/crypto-trading/trading-safety.spec.ts`、`risk.spec.ts`、`wallet/Wallet.spec.ts`、`operation-dispatcher.spec.ts` 都是真实回归保障。
- 明确边界：
  - 交易服务初始化失败时，主程序允许降级继续启动。
  - crypto 工具在 CCXT ready 后异步注入，说明交易能力不是“进程启动即稳定在线”。
  - securities guard registry 只有 `max-position-size`、`cooldown`、`symbol-whitelist` 三类，和 crypto 成熟度并不完全对称。
  - 当前可以确认“保护能力广泛存在”，但不能把所有保护都写成“当前 crypto 主路径已启用”。
  - 最硬边界是 `decision_packet/release_gate_status.json` 中 `allowLiveTrading=false`。
- 结论：可以写成“具备多层保护设计、且在受控环境下可运行的交易链”，但不能写成“所有保护均已在当前主执行路径生效，更不能写成已放行的生产交易系统”。

### 2.4 Event log / cron / heartbeat / connector

- 成熟度：`可用但有明显边界`
- 一句话判断：事件链、cron、heartbeat 和 connector 已经达到“真实可跑、具备恢复与容错语义”的水平，但它们仍是单机单租户优先的本地编排层。
- 实现证据：
  - `src/core/event-log.ts` 是“磁盘 JSONL + 内存 ring buffer”的双写事件总线。
  - `src/task/cron/engine.ts`、`src/task/cron/listener.ts` 说明 cron 是“调度写事件 + listener 消费”的事件驱动模型。
  - `src/task/heartbeat/heartbeat.ts` 说明 heartbeat 具备 active-hours、dedup、structured response、fail-open 投递、持久化开关。
  - `src/connectors/web/web-plugin.ts`、`src/connectors/telegram/telegram-plugin.ts`、`src/connectors/mcp-ask/mcp-ask-plugin.ts` 加上主 `MCP server` 共同构成 “3 个主要 connector + 1 个工具暴露面”。
  - `src/core/connector-center.ts` 是单租户、基于“最后一次交互渠道”的出站路由中心。
- 运行/测试证据：
  - repo 级 Vitest 当前总体是 `58 passed | 1 failed | 1 skipped` 文件，`555 passed | 1 failed | 1 skipped` 测试；失败不在 eventing 主链。
  - `src/core/event-log.spec.ts` 31 个测试。
  - `src/core/connector-center.spec.ts` 22 个测试。
  - `src/task/cron/engine.spec.ts` 27 个测试通过。
  - `src/task/cron/listener.spec.ts` 9 个测试通过。
  - `src/task/heartbeat/heartbeat.spec.ts` 35 个测试通过。
- 明确边界：
  - `ConnectorCenter` 是“last interaction”策略，不是 per-user/per-tenant routing。
  - `CronListener` 串行执行，处理期内新 job 会被跳过，不是并发队列。
  - `Heartbeat` 对未解析 AI 输出采用 fail-open 投递，提高可见性但也提升误报风险。
  - `data/config/heartbeat.json` 当前默认 `enabled=false`，说明 heartbeat 能力存在，但当前默认部署姿态并不是主动自检。
  - `mcp-ask` 是 pull-based，会话入口，不是主动通知通道。
  - `Web` connector 依赖活跃 SSE client，不是可靠消息队列。
  - `Telegram` 目前基于 polling 而非 webhook，适合作为本地值守告警通道，但不是面向大规模生产推送的交付形态。
- 结论：可以说它是“本地编排层”，不能说它是“生产级通知/调度基础设施”。

### 2.5 News collector / archive

- 成熟度：`半成品 / 研究态`
- 一句话判断：采集、持久化、检索三件套已经存在，但恢复路径暴露出 retention 与 archive 语义不一致的问题，因此还不能视为稳定的持久归档系统。
- 实现证据：
  - `src/extension/news-collector/store.ts` 是独立 JSONL store，维护 `buffer + dedupSet + seq`，并提供 `getNews/getNewsV2`。
  - `src/extension/news-collector/collector.ts` 是基于 `setInterval` 的 RSS collector。
  - `src/extension/news-collector/tools.ts` 暴露 `globNews`、`grepNews`、`readNews`。
  - `src/main.ts:290-345` 说明 OpenBB news 工具可被 piggyback 到 store，且 `newsCollector.enabled` 时会注册 `news-archive` 并启动 collector。
- 运行/测试证据：
  - `news-collector/tools.spec.ts` 本轮通过 `28` 个测试。
  - `news-collector/rss-parser.spec.ts` 本轮通过 `7` 个测试。
  - 当前唯一明确回归在 `src/extension/news-collector/store.spec.ts:84-105`。
  - 实际错误是：日志打印 `recovered 2 dedup keys, 0 items in memory`，随后 `expect(store2.count).toBe(2)` 失败，实际为 `0`。
- 明确边界：
  - `store.ts` 的 `init()` 只把 retention 窗口内的数据放回内存 buffer；超出窗口的数据虽然仍在 JSONL 中，但在重启后对 archive 查询不可见。
  - 这使它更像“短期新闻缓存 + 检索”而不是“稳定长期 archive”。
  - collector 本身也没有接入 event log 的统一调度/重试/审计链。
- 结论：这块不该写成“稳定可依赖的持久新闻档案系统”，更准确的说法是“可用的短期新闻采集与查询能力”。

### 2.6 Strategy backtest / FDR / decision packet

- 成熟度：`研究可用、生产不可用`
- 一句话判断：OpenAlice 已经把研究评估与决策闭环打通，但这个闭环当前输出的是可解释的 `NO_GO`，不是“已找到可上线策略”。
- 实现证据：
  - `package.json:40-61` 暴露 `research:mvp`、`strategy:mvp`、`gates:checkpoints`、`decision:build`、`decision:validate` 等成链命令。
  - `src/backtest/fdr.ts` 提供 FDR 相关逻辑。
  - `scripts/build_gate_checkpoints.py` 和 `scripts/validate_decision_packet.py` 把实验结果挂到 gate 与 decision packet。
- 运行/产物证据：
  - `docs/research/plan_v5_72h_final_report.md:3-9` 明确记载 MVP closed loop 已完成。
  - `decision_packet/verdict.json` 当前结论是 `NO_GO`。
  - `decision_packet/experiment_verdict.v2.json` 明确记录了 3 个候选策略全部失败。
- 明确边界：
  - 研究链闭环 != 交易策略过门。
  - 当前这条链的价值在于“可证伪”，不是“已证成”。
- 结论：审计文档里应强调“研究闭环可用”，而不是“策略有效”。

### 2.7 ML Ensemble 研究能力栈

- 成熟度：`研究可用`
- 一句话判断：这部分已经具备真实工具接口、CLI 评估入口、独立依赖和数值稳定性测试，是一套存在感很强的研究建模工位；但它当前仍不应被描述成已经改善了 `G3`。
- 实现证据：
  - `src/extension/ml-ensemble-tools/adapter.ts` 暴露 `mlEnsemblePredict`，支持 `xgboost`、`lightgbm`、`catboost`、`randomForest`、`ridge`、`pytorch` 六类模型。
  - 同一工具还支持 `stacking` / `regime_moe`、`rule` / `kmeans` regime、`sigmoid` / `isotonic` calibration、OOF coverage、locked test window 等研究参数。
  - `scripts/ml_ensemble_eval.ts` 提供独立 CLI 评估入口。
  - `scripts/requirements-ml-ensemble.txt` 给出明确 Python 依赖。
- 运行/测试证据：
  - `src/extension/ml-ensemble-tools/python-runner.spec.ts` 在本地 Python 可用时，会验证至少使用 3 个模型、方向准确率高于 baseline，并产出 regime summary / OOF quality / selection audit。
  - `scripts/tests/test_ml_ensemble_regime_stability.py` 验证 `kmeans` regime 在 `NaN/Inf/extreme/constant` 输入上的数值稳定性。
- 明确边界：
  - JS 侧关键测试是条件性运行，不等于所有环境都全绿。
  - 这条链更像“研究模型工位”，不是当前 release gate 依据。
  - 当前没有证据表明它已经改变 `decision_packet` 的结论。
- 结论：可以写成“研究能力真实存在”，不能写成“当前主策略突破口”。

### 2.8 CORE7 数据 / 归一化 / feature / base model

- 成熟度：`半成品但已产生产物`
- 一句话判断：CORE7 已经从“设计文档”推进到“有完整流水线和真实产物”，但它仍然是 Stage-C 的输入底座，而不是已经证明能改善 G3 的研究主线。
- 实现证据：
  - `docs/CORE7_FEATURE_PIPELINE.md` 明确给出 `OKX 1m + Binance 1m -> normalized -> feature tables -> minimal sklearn baseline summary` 的四步流水线。
  - `scripts/run_core7_feature_pipeline.sh` 真正编排 `normalize_okx`、`normalize_binance`、`build_feature_base`、`train_baseline` 四步。
  - `scripts/build_core7_feature_base.py` 构建 per-instId feature table。
  - `scripts/train_core7_baseline.py` 只做最小 baseline，总体定位是 baseline summary。
- 产物/测试证据：
  - 审计时数据目录已存在真实产物：
    - `okx_1m_core7`: `1.0G`
    - `binance_1m_core7`: `1.9G`
    - `okx_1m_core7_norm`: `839M`
    - `binance_1m_core7_norm`: `2.2G`
    - `core7_feature_base_1m`: `18G`
    - `core7_models`: `80K`
  - `core7_feature_base_1m` 下已有 `ADA/BNB/BTC/DOGE/ETH/SOL/XRP` 的 spot/swap instId 目录。
  - `scripts/tests/test_run_core7_feature_pipeline.py`、`test_build_core7_feature_base.py`、`test_train_core7_baseline.py` 提供关键环节测试。
- 明确边界：
  - `run_core7_feature_pipeline.sh` 默认 Python 路径写死为 `/opt/miniconda3/bin/python`，可移植性还不成熟。
  - `CORE7_FEATURE_PIPELINE.md:50-55` 明确说明 baseline trainer 只使用 `sklearn`，不能夸大成完整建模栈。
  - `core7_models` 体量很小，说明“数据/特征先行”远大于“训练产出充分积累”。
  - 当前没有证据证明它已经进入并改善 `G3` 闭环。
- 结论：这块应被写成“Stage-C / candidate rebuild 的输入链候选”，不是“现成突破口”。

### 2.9 Live trading / release readiness

- 成熟度：`阻塞 / 不可放行`
- 一句话判断：这不是“还差一点”的软风险，而是当前决策产物明确给出的硬阻塞；同时 runtime 侧虽已出现 live-gate 相关代码，但当前主执行路径对这批逻辑的接线完整性仍需继续核实。
- 实现证据：
  - `scripts/build_gate_checkpoints.py:419-522` 的 `gate3_checks()` 会直接检查 `allowLiveTrading`。
  - `data/config/crypto.json` 当前已配置为 `exchange=okx`、`defaultMarketType=swap`、`sandbox=false`、`demoTrading=false`，说明配置姿态本身已经偏向实盘而非 demo。
  - `src/runtime/release_gate_status.ts` 与 `src/runtime/live_gate_manager.ts` 说明 runtime 里存在 release gate blocking 与 `beforePlaceOrder()` 能力。
  - `src/extension/crypto-trading/operation-dispatcher.ts` 也确实暴露了 `beforePlaceOrderGate` 钩子。
- 运行/产物证据：
  - `decision_packet/release_gate_status.json:1-10` 记录 `allowPaperTrading=false`、`allowLiveTrading=false`。
  - `decision_packet/gates/G3.checkpoint.json:28-52` 里 `release_gate_allows_live` 明确失败。
- 明确边界：
  - 这不是“平台已经准备好，只差运营确认”，而是“统计层与发布层同时红灯”。
  - 当前 `main.ts:375` 与 `src/main.ts:547` 的 dispatcher 创建未显式传入 live-gate 相关 option，因此“runtime 代码存在”不能直接等价成“当前主路径已代码级硬阻断每一笔下单”。
  - 当前最明确的仿真通路仍是交易所 `demoTrading` 模式；未见独立第一方 shadow trading runtime。
  - `data/config/heartbeat.json` 当前默认关闭，也意味着上线值守面默认并未主动开启。
- 结论：必须用“阻塞 / 不可放行”描述，不能软化；而且这一结论主要由 `decision_packet` 硬事实支撑，而不是由当前 runtime 接线完整性来背书。

## 3. 量化研究视角：G0-G4 门控拆解

Gate 定义以 `scripts/build_gate_checkpoints.py` 为准。

| Gate | 定义 | 当前状态 | 关键证据 | 解释 |
| --- | --- | --- | --- | --- |
| G0 | 环境锁与 freeze 校验门 | `pass` | `decision_packet/gates/G0.checkpoint.json` | 治理基础设施可用，不是当前瓶颈 |
| G1 | preflight 执行链门 | `pass` | `decision_packet/gates/G1.checkpoint.json` | 编排链正常，不是当前瓶颈 |
| G2 | research quality + contract validation 门 | `pass` | `decision_packet/gates/G2.checkpoint.json` | 研究产物质量和契约层可用，不是当前瓶颈 |
| G3 | 实验结果与 release gate 硬门 | `fail` | `decision_packet/gates/G3.checkpoint.json` | 当前真正阻塞点 |
| G4 | 决策输入与上游依赖门 | `fail` | `decision_packet/gates/G4.checkpoint.json` | `G3` 失败后的决策层投影 |

### 3.1 G0：环境锁与 freeze

- 定义：检查 `env:verify` 和 `freeze:verify` 报告存在且通过。
- 当前状态：`pass`
- 证据：
  - `decision_packet/gates/G0.checkpoint.json` 显示 `4/4` 检查全部通过。
  - `scripts/build_gate_checkpoints.py:232-288` 明确定义了这 4 个检查项。
- 解释：治理基础设施已经成型，当前不应继续把资源投在“先修 G0”上。

### 3.2 G1：preflight 执行链

- 定义：检查 preflight 报告存在、最终退出码为 `0`、步骤全部通过。
- 当前状态：`pass`
- 证据：
  - `decision_packet/gates/G1.checkpoint.json` 显示 `3/3` 检查全部通过。
  - `scripts/build_gate_checkpoints.py:290-329` 定义了 `gates_preflight_report_exists`、`gates_preflight_exit_zero`、`gates_preflight_steps_all_pass`。
- 解释：执行编排链正常，不是主阻塞。

### 3.3 G2：research quality + contract validation

- 定义：检查 research quality report、paper count、schema pass rate、missing fields、evidence link rate、contract report。
- 当前状态：`pass`
- 证据：
  - `decision_packet/gates/G2.checkpoint.json` 显示 `8/8` 检查全部通过。
  - `scripts/build_gate_checkpoints.py:331-417` 明确把 `paperCount`、`paperCardSchemaPassRate`、`missingRequiredFields`、`evidenceLinkRate`、`contracts.passed` 等都纳入硬检查。
- 解释：研究产物质量和契约验证层都已经可用，不是当前问题。

### 3.4 G3：实验结果与 release gate

- 定义：检查 experiment verdict 的 schema、结果、3 个统计阈值，以及 `allowLiveTrading`。
- 当前状态：`fail`
- 机器可读证据：
  - `decision_packet/gates/G3.checkpoint.json` 显示 `8` 项检查中 `3 passed / 5 failed`。
  - `scripts/build_gate_checkpoints.py:419-522` 定义了 `gate3_checks()` 的全部语义。
- 失败项必须按数值理解：
  - `result=NO_GO`
  - `meanPbo=0.8857142857142857 > 0.2`
  - `meanDsrProbability=0.17528947232399147 < 0.5`
  - `fdrQ=0.9999997082664652 > 0.1`
  - `allowLiveTrading=False`
- 更底层的实验产物也证实同一结论：
  - `decision_packet/experiment_verdict.v2.json` 给出阈值 `meanPboMax=0.2`、`meanDsrProbabilityMin=0.5`、`fdrQMax=0.1`
  - 同文件还显示 3 个候选策略全部失败，且 release gate failed checks 为 `wfo`、`significance`、`risk_simulation`
  - `decision_packet/release_gate_status.json` 记录 `allowPaperTrading=false`、`allowLiveTrading=false`
- 解释：
  - 这不是“统计结果还行，只是运营没批准”。
  - 也不是“策略其实可以，只差一个 release 开关”。
  - 实际情况是：统计层和发布层都同时红灯。

### 3.5 G4：决策输入与上游依赖

- 定义：检查 `G0..G3` 上游 hard gates 是否全部通过，同时确认 experiment verdict / release gate status 输入存在。
- 当前状态：`fail`
- 证据：
  - `decision_packet/gates/G4.checkpoint.json` 只失败了 `upstream_hard_gates_passed`，并明确写出 `failed gates=G3`。
  - `scripts/build_gate_checkpoints.py:524-585` 说明 `G4` 只是在看上游 gate 是否失败，以及输入文件是否在。
- 解释：`G4` 不是独立根因；它只是 `G3` 的决策层投影。

### 3.6 一句话总结

真正阻塞在 `G3`。`G0-G2` 证明治理、执行编排和研究契约层已经工作；`G3` 证明当前策略族本身不过关；`G4` 只是把这个结果向上反映到决策层。

## 4. 下一步最该做什么

### P0

1. 冻结旧框架为 `research-only baseline`，停止在旧 G3/G4 路线上继续做 cosmetic 参数搜索。
2. 按 `Stage-C` charter 把资源优先投向 Workstream A，先做 signal / feature / candidate generator v2，再考虑统计方法升级。当前证据指向“原始信号质量不够”，而不是“治理层不够”。
3. 将 `CORE7` 链明确接入新的 candidate generation 与 multi-asset smoke matrix。`CORE7` 不能继续作为旁支工程目标存在，必须被证明能服务于下一个 `G3` 改善回合。

### P1

4. 修复 `NewsCollectorStore` 的恢复回归，统一 retention 与 archive 语义，提高平台层“可长期跑、可交接”的可信度。
5. 单独追踪 `main.ts -> createCryptoOperationDispatcher(...) -> wallet.push() -> engine.placeOrder()` 真实保护链，确认 `beforePlaceOrderGate`、`riskConfig`、`killSwitch`、`idempotencyStore` 等 deeper runtime protections 在当前 crypto 主执行路径中的接线完整性。
6. `G0-G2` 进入维护态，不再作为主要攻坚方向。当前主约束不是环境锁、contract 或 decision packet，而是 `G3` 对统计有效性与 release readiness 的双重否决。

## 5. 附录：证据索引

### 5.1 运行脚本与 gate 定义

- `scripts/build_gate_checkpoints.py`
- `package.json`

### 5.2 当前 decision packet

- `decision_packet/verdict.json`
- `decision_packet/gates/G0.checkpoint.json`
- `decision_packet/gates/G1.checkpoint.json`
- `decision_packet/gates/G2.checkpoint.json`
- `decision_packet/gates/G3.checkpoint.json`
- `decision_packet/gates/G4.checkpoint.json`
- `decision_packet/experiment_verdict.v2.json`
- `decision_packet/release_gate_status.json`

### 5.3 Stage-C 重构文档

- `docs/research/g3g4_stageC_rebuild_charter_20260303.md`
- `docs/research/plan_v5_72h_final_report.md`

### 5.4 平台接线与 UI 证据

- `src/main.ts`
- `src/core/ai-provider.ts`
- `src/core/session.ts`
- `src/core/engine.ts`
- `src/connectors/web/web-plugin.ts`
- `ui/src/App.tsx`
- `ui/src/components/Sidebar.tsx`
- `ui/src/pages/*`

### 5.5 交易与运行时保护证据

A 级硬证据：

- `data/config/risk.json`
- `data/config/crypto.json`
- `src/extension/crypto-trading/guards/registry.ts`
- `src/extension/securities-trading/guards/registry.ts`
- `src/extension/crypto-trading/decision-ticket.ts`
- `src/extension/crypto-trading/kill-switch.ts`
- `src/extension/crypto-trading/risk.ts`
- `src/extension/crypto-trading/idempotency-store.ts`
- `src/runtime/risk_breaker_state.ts`
- `src/connectors/telegram/telegram-plugin.ts`

B 级候选证据：

- `src/runtime/release_gate_status.ts`
- `src/runtime/live_gate_manager.ts`
- `src/extension/crypto-trading/operation-dispatcher.ts`
- `src/extension/crypto-trading/wallet/Wallet.ts`
- `src/extension/crypto-trading/pnl-tracker.ts`

### 5.6 事件 / 调度 / 新闻证据

- `src/core/event-log.ts`
- `src/core/connector-center.ts`
- `src/task/cron/engine.ts`
- `src/task/cron/listener.ts`
- `src/task/heartbeat/heartbeat.ts`
- `src/extension/news-collector/store.ts`
- `src/extension/news-collector/collector.ts`
- `src/extension/news-collector/tools.ts`

### 5.7 ML / CORE7 证据

- `src/extension/ml-ensemble-tools/adapter.ts`
- `scripts/ml_ensemble_eval.ts`
- `scripts/requirements-ml-ensemble.txt`
- `scripts/tests/test_ml_ensemble_regime_stability.py`
- `docs/CORE7_FEATURE_PIPELINE.md`
- `scripts/run_core7_feature_pipeline.sh`
- `scripts/build_core7_feature_base.py`
- `scripts/train_core7_baseline.py`

### 5.8 当前测试基线

- repo 级 JS 测试：`corepack pnpm test`
  - 结果：`58 passed | 1 failed | 1 skipped` 文件
  - 结果：`555 passed | 1 failed | 1 skipped` 测试
  - 唯一失败点：`src/extension/news-collector/store.spec.ts` 的恢复场景
- repo 级 Python 测试：`corepack pnpm run test:py`
  - 结果：`127 passed`
- 定向补充测试：
  - 运行时/provider：`14 passed`
  - 交易与风控：`152 passed`

## 6. 审计总评

OpenAlice 当前最准确的定位是：

- 平台层：已经达成“本地单机可运行、可审计、可扩展”的 MVP。
- 研究层：已经达成“能产出机器可读 `NO_GO` 结论”的闭环。
- 生产层：明确还没有达到“可放行交易”的门槛。

因此，后续资源不应继续平均铺在平台润色、治理补丁和旧策略微调上，而应集中到 `Stage-C` signal rebuild，并让 `CORE7` 成为下一轮候选生成与多资产验证的输入链。只有当 `G3` 被实质改善后，`OpenAlice` 才有资格从“平台级 MVP + 研究失败”向“策略接近可放行”推进。
