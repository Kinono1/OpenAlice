# 外部衍生品数据收集失败 - 解决方案

## 问题描述

外部衍生品数据收集脚本持续失败 35 次，错误信息：
```
Client network socket disconnected before secure TLS connection was established | ECONNRESET
```

## 根本原因

网络连接问题，具体表现为：
1. 代理 (127.0.0.1:7890) 连接超时
2. 直连 Binance API (fapi.binance.com) 也超时
3. 这是网络层面的问题，不是代码问题

## 诊断步骤

运行诊断脚本：
```bash
cd /Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice
./scripts/diagnose_external_derivatives_network.sh
```

## 解决方案

### 方案 1: 禁用代理（如果代理不可用）

```bash
# 临时禁用
unset HTTPS_PROXY HTTP_PROXY

# 或在 cron 脚本中禁用
# 编辑 scripts/cron_external_derivatives_data_collect.sh
# 在 source openalice_env.sh 之后添加：
unset HTTPS_PROXY HTTP_PROXY
```

### 方案 2: 修复代理

检查代理服务是否运行：
```bash
# 检查端口
nc -z 127.0.0.1 7890 -w 2

# 如果代理是 Clash/V2Ray/其他工具，确保它正在运行
ps aux | grep -E "clash|v2ray|proxy"
```

### 方案 3: 使用备用端点

如果 Binance 主端点被阻止，尝试备用端点：
```bash
# 在 cron 脚本中设置备用 URL
export OPENALICE_BINANCE_USDM_BASE_URL="https://fapi1.binance.com"
# 或
export OPENALICE_BINANCE_USDM_BASE_URL="https://fapi2.binance.com"
```

### 方案 4: 增加超时和重试

编辑 `scripts/cron_external_derivatives_data_collect.sh`：
```bash
COLLECT_ARGS=(
  --endpoint all
  --symbols "${OPENALICE_EXTERNAL_SYMBOLS:-BTCUSDT,ETHUSDT}"
  --period "${OPENALICE_EXTERNAL_PERIOD:-5m}"
  --fetchTimeoutMs 30000  # 增加到 30 秒
  --maxRetries 3          # 增加重试次数
  --json true
)
```

### 方案 5: 检查防火墙/VPN

```bash
# 检查是否有防火墙规则阻止 HTTPS
sudo pfctl -s rules | grep 443

# 如果使用 VPN，尝试断开后测试
# 如果使用公司网络，可能需要配置企业代理
```

## 验证修复

修复后，手动运行一次收集：
```bash
cd /Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice

# 禁用代理测试
unset HTTPS_PROXY HTTP_PROXY
./node_modules/.bin/tsx scripts/collect_external_derivatives_data.ts \
  --endpoint fundingRate \
  --symbols BTCUSDT \
  --period 5m \
  --fetchTimeoutMs 30000 \
  --maxRetries 3 \
  --json true
```

如果成功，检查输出：
```bash
cat data/runtime/external_derivatives_data_collect.latest.json | jq '.errors | length'
# 应该返回 0
```

## 监控

修复后，监控 cron 作业状态：
```bash
# 检查最近的运行
tail -20 logs/external_derivatives_data_collect.log

# 检查 cron 作业状态
cat data/cron/jobs.json | jq '.jobs[] | select(.id == "106cef5e") | {lastStatus, consecutiveErrors}'
```

## 长期解决方案

1. **添加健康检查**: 在 cron 脚本开始前测试网络连接
2. **自动降级**: 如果代理失败，自动切换到直连
3. **告警**: 连续失败 5 次后发送通知
4. **备用数据源**: 配置多个 Binance 端点或使用其他交易所 API

## 相关文件

- 诊断脚本: `scripts/diagnose_external_derivatives_network.sh`
- Cron 脚本: `scripts/cron_external_derivatives_data_collect.sh`
- 收集脚本: `scripts/collect_external_derivatives_data.ts`
- 日志: `logs/external_derivatives_data_collect.log`
- 报告: `data/runtime/external_derivatives_data_collect.latest.json`
