#!/bin/bash
# generate_snapshot.sh
# Generates a lockstep runtime snapshot with code review findings as new_blockers.
# Output: docs/recovery/OpenAlice_recovery_snapshot.json
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUTPUT_FILE="$REPO_ROOT/docs/recovery/OpenAlice_recovery_snapshot.json"

DATA_RUNTIME="$REPO_ROOT/data/runtime"
DATA_RESEARCH="$REPO_ROOT/data/research"

# Timestamp of this script run
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Temp directory for intermediate fragments
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# ---------------------------------------------------------------
# Helper: safely extract fields from a JSON file using python3.
# Writes result to a temp file to avoid shell quoting issues.
#   usage: extract_artifact <output_var_name> <json_path> <python_expression>
# ---------------------------------------------------------------
extract_artifact() {
  local out_var="$1"
  local filepath="$2"
  local python_expr="$3"
  local out_file="$TMPDIR/${out_var}.json"

  if [ ! -f "$filepath" ]; then
    echo '{"__MISSING__": "'"$filepath"'"}' > "$out_file"
    eval "$out_var='$out_file'"
    return
  fi

  python3 -c "
import json, sys
try:
    with open('$filepath') as f:
        d = json.load(f)
    result = $python_expr
    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
except Exception as e:
    print(json.dumps({'__ERROR__': str(e), '__FILE__': '$filepath'}, ensure_ascii=False))
" > "$out_file"

  eval "$out_var='$out_file'"
}

# ---------------------------------------------------------------
# SECTION 1: system_status_reason_chain
# ---------------------------------------------------------------
extract_artifact SYS_STATUS "$DATA_RUNTIME/system_status_reason_chain.latest.json" '{
    "generatedAt": d.get("generatedAt"),
    "overallPlanCompletionPct": d.get("overallPlanCompletionPct"),
    "effectiveActionability": d.get("effectiveActionability"),
    "paperTradingAllowed": d.get("paperTradingAllowed"),
    "liveTradingAllowed": d.get("liveTradingAllowed"),
    "canPromote": d.get("canPromote"),
    "reasonChainCount": len(d.get("reasonChain", [])),
    "components": [
      {"name": c.get("component"), "status": c.get("status")}
      for c in d.get("reasonChain", [])
    ]
  }'

# ---------------------------------------------------------------
# SECTION 2: live_data_freshness
# ---------------------------------------------------------------
extract_artifact LIVE_FRESH "$DATA_RUNTIME/live_data_freshness.latest.json" '{
    "generatedAt": d.get("generatedAt"),
    "expectedAssets": d.get("summary", {}).get("expectedAssets"),
    "presentAssets": d.get("summary", {}).get("presentAssets"),
    "freshAssets": d.get("summary", {}).get("freshAssets")
  }'

# ---------------------------------------------------------------
# SECTION 3: route_cost_budget
# ---------------------------------------------------------------
extract_artifact ROUTE_COST "$DATA_RUNTIME/route_cost_budget.latest.json" '{
    "generatedAt": d.get("generatedAt"),
    "makerFeeBps": d.get("feeSnapshot", {}).get("makerFeeBps"),
    "takerFeeBps": d.get("feeSnapshot", {}).get("takerFeeBps"),
    "verifiedByRuntime": d.get("feeSnapshot", {}).get("verifiedByRuntime"),
    "routes": d.get("routes", {})
  }'

# ---------------------------------------------------------------
# SECTION 4: strategy_promotion
# ---------------------------------------------------------------
extract_artifact STRAT_PROMO "$DATA_RUNTIME/strategy_promotion.latest.json" '{
    "generatedAt": d.get("generatedAt"),
    "finalVerdict": d.get("finalVerdict"),
    "researchGate": {
      "status": d.get("researchGate", {}).get("status"),
      "hardBlocks": d.get("researchGate", {}).get("hardBlocks")
    },
    "paperGate": {
      "status": d.get("paperGate", {}).get("status"),
      "hardBlockCount": len(d.get("paperGate", {}).get("hardBlocks", [])),
      "metricSnapshot": d.get("paperGate", {}).get("metricSnapshot", {})
    }
  }'

# ---------------------------------------------------------------
# SECTION 5: paper_pnl_diagnostics
# ---------------------------------------------------------------
extract_artifact PNL_DIAG "$DATA_RESEARCH/paper_pnl_diagnostics.latest.json" '{
    "generatedAt": d.get("generatedAt"),
    "closedTrades": d.get("coverage", {}).get("closedTrades"),
    "contextBuckets": {
      "ok": next(
        (b for b in d.get("coverage", {}).get("contextBuckets", []) if b.get("bucket") == "ok"),
        None
      )
    },
    "costEvidence": d.get("coverage", {}).get("costEvidence"),
    "mfeMaeEvidence": d.get("coverage", {}).get("mfeMaeEvidence"),
    "overallPf": d.get("overall", {}).get("profitFactor")
  }'

# ---------------------------------------------------------------
# SECTION 6: strategy_defect_monitor
# ---------------------------------------------------------------
extract_artifact DEFECT_MON "$DATA_RESEARCH/strategy_defect_monitor.latest.json" '{
    "summary": {
      "findings": d.get("summary", {}).get("findings"),
      "blocked": d.get("summary", {}).get("blocked")
    },
    "findings": [
      {"id": c.get("id"), "status": c.get("status")}
      for c in d.get("findings", [])
    ]
  }'

# ---------------------------------------------------------------
# SECTION 7: strategy_defect_registry
# ---------------------------------------------------------------
extract_artifact DEFECT_REG "$DATA_RESEARCH/strategy_defect_registry.latest.json" '{
    "defects": [
      {"id": c.get("id"), "status": c.get("status")}
      for c in d.get("defects", [])
    ]
  }'

# ---------------------------------------------------------------
# SECTION 8: strategy_quality_gate_coverage
# ---------------------------------------------------------------
extract_artifact QG_COVERAGE "$DATA_RESEARCH/strategy_quality_gate_coverage.latest.json" '{
    "coveragePct": d.get("summary", {}).get("coveragePct"),
    "p0p1OpenOrPartialUncovered": d.get("summary", {}).get("p0p1OpenOrPartialUncovered"),
    "uncoveredDefects": [
      {"id": c.get("id")} for c in d.get("uncoveredDefects", [])
    ]
  }'

# ---------------------------------------------------------------
# SECTION 9: Locks
# ---------------------------------------------------------------
python3 -c "
import json, os, time
locks_dir = '$DATA_RUNTIME/locks'
locks = []
if os.path.isdir(locks_dir):
    for entry in sorted(os.listdir(locks_dir)):
        entry_path = os.path.join(locks_dir, entry)
        if os.path.isdir(entry_path):
            pid = None
            ts = None
            age = None
            info_file = os.path.join(entry_path, 'info.json')
            if os.path.isfile(info_file):
                try:
                    with open(info_file) as f:
                        info = json.load(f)
                    pid = info.get('pid')
                    ts = info.get('ts')
                    if ts:
                        age_seconds = int(time.time() - ts / 1000)
                        age = f'{age_seconds}s'
                except Exception:
                    pass
            if not ts:
                try:
                    mtime = os.path.getmtime(entry_path)
                    age_seconds = int(time.time() - mtime)
                    age = f'{age_seconds}s'
                except Exception:
                    age = 'unknown'
            locks.append({
                'lockName': entry,
                'age': age,
                'pid': pid
            })
print(json.dumps(locks, indent=2, ensure_ascii=False))
" > "$TMPDIR/locks.json"

# ---------------------------------------------------------------
# SECTION 10: Git state
# ---------------------------------------------------------------
python3 -c "
import subprocess, json
try:
    result = subprocess.run(
        ['git', 'status', '--short'],
        capture_output=True, text=True, cwd='$REPO_ROOT'
    )
    lines = result.stdout.strip().split(chr(10)) if result.stdout.strip() else []
    modified = 0
    untracked = 0
    for l in lines:
        l = l.strip()
        if l.startswith('??'):
            untracked += 1
        elif l:
            modified += 1
    print(json.dumps({'modified': modified, 'untracked': untracked}))
except Exception as e:
    print(json.dumps({'__ERROR__': str(e)}))
" > "$TMPDIR/git_state.json"

# ---------------------------------------------------------------
# SECTION 11: new_blockers (hardcoded code review findings)
# ---------------------------------------------------------------
python3 -c "
import json
blockers = {
  'critical': [
    {'id': 'CR-1', 'title': 'accounts.json 为空是唯一实时交易隔离', 'file': 'data/config/accounts.json', 'detail': '一旦填入账户，sandbox=false + demoTrading=true (crypto.json:9-10) 即可触发实时交易', 'phase': 'P0'},
    {'id': 'CR-2', 'title': 'Black-Litterman 协方差矩阵为对角线近似', 'file': 'src/portfolio/allocator.ts:553-562', 'detail': '假设相关性为零，BL 模型从根本上被破坏', 'phase': 'P2'},
    {'id': 'CR-3', 'title': 'Lock 死锁永不自动释放', 'file': 'scripts/openalice_cron_lock.sh:37-51', 'detail': '检测到 stale 只发通知不移除锁目录。若进程 SIGKILL 完锁永久存在', 'phase': 'P0'},
    {'id': 'CR-4', 'title': '账户文件损坏静默重置 equity=100k', 'file': 'scripts/paper_trade_microstructure_stress.ts:307-316 + volume_breakout.ts:384-397', 'detail': 'JSON 解析失败静默回退到新账户，所有历史丢失', 'phase': 'P1'}
  ],
  'high': [
    {'id': 'CR-5', 'title': 'Leverage guard 仅阻止 ≥100x', 'file': 'src/domain/trading/production-leverage-guard.ts:3-9', 'detail': '50x/75x/99x 均通过门控', 'phase': 'P2'},
    {'id': 'CR-6', 'title': 'execution.ts reduce/close 绕过所有仓位门控', 'file': 'src/domain/strategy/execution.ts:84-102', 'detail': '若错误归类可执行任意订单', 'phase': 'P2'},
    {'id': 'CR-7', 'title': '资金费率魔法数字 ×3 无依据', 'file': 'src/domain/strategy/cross-sectional-momentum.ts:154', 'detail': '不可配置的硬编码缩放因子', 'phase': 'P2'},
    {'id': 'CR-8', 'title': 'Dirty worktree quarantine 未传播到 evidence chain', 'file': 'scripts/build_system_status_reason_chain.ts:403', 'detail': 'Allocator reason 不接收 dirty worktree audit 数据', 'phase': 'P0'},
    {'id': 'CR-9', 'title': 'effectiveActionability 缺失 not_available_warmup 检查', 'file': 'scripts/build_system_status_reason_chain.ts:431-435', 'detail': '暖机状态错误标记为 paper_execution_blocked', 'phase': 'P0'},
    {'id': 'CR-10', 'title': 'Zod schema 无 sandbox/demoTrading 交叉验证', 'file': 'src/core/config.ts:275-286 + 441-449', 'detail': 'brokerConfig 完全不受约束', 'phase': 'P0'}
  ],
  'medium': [
    {'id': 'CR-11', 'title': 'Paper-monitor 五个 SKIP flags 全 true，空转 no-op', 'file': 'scripts/launch_realtime_shadow_monitor.sh:37-41', 'detail': '进程运行但不做任何事', 'phase': 'P1'},
    {'id': 'CR-12', 'title': 'featuresAvailableAtDecisionTime 等价于非 stale', 'file': 'src/runtime/paper_open_context.ts:89', 'detail': '而非真实特征可用性', 'phase': 'P0'},
    {'id': 'CR-13', 'title': 'flashContextStatus 是 contextStatus 完全重复', 'file': 'src/runtime/paper_open_context.ts:93', 'detail': '无独立信息', 'phase': 'P0'},
    {'id': 'CR-14', 'title': 'evidence_manifest exit code ≠ 0 掩盖 dirty 信号', 'file': 'src/runtime/evidence_manifest.ts:58-62', 'detail': 'dirty 被 fail 掩盖', 'phase': 'P0'},
    {'id': 'CR-15', 'title': 'risk_reduced riskMode 被忽略（等价于 risk_on）', 'file': 'src/runtime/paper_open_context.ts:102-131', 'detail': '风险降低模式无独立处理', 'phase': 'P0'},
    {'id': 'CR-16', 'title': 'volume_breakout stopLossPct 文档 0.5% 实际 3.0%', 'file': 'src/domain/strategy/volume-breakout.ts:21 vs 52', 'detail': '文档与默认值严重不一致', 'phase': 'P2'},
    {'id': 'CR-17', 'title': 'Paper trader 无路由选择逻辑', 'file': 'scripts/paper_trade_*.ts', 'detail': 'taker_taker vs passive_passive 未实现', 'phase': 'P1'},
    {'id': 'CR-18', 'title': 'cron 脚本硬编码 node_modules/.bin/tsx', 'file': '多个 cron .sh', 'detail': 'pnpm isolated linker 下不可用', 'phase': 'P0'}
  ]
}
print(json.dumps(blockers, indent=2, ensure_ascii=False))
" > "$TMPDIR/new_blockers.json"

# ---------------------------------------------------------------
# BUILD FINAL JSON from temp files
# ---------------------------------------------------------------
python3 -c "
import json, os

tmpdir = '$TMPDIR'

def load_fragment(name):
    path = os.path.join(tmpdir, name)
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        return {'__ERROR__': str(e), '__FRAGMENT__': name}

output = {
    'generatedAt': '$NOW_ISO',
    'sourceFile': 'docs/recovery/scripts/generate_snapshot.sh',
    'truth': {
        'systemStatus':        load_fragment('SYS_STATUS.json'),
        'liveDataFreshness':   load_fragment('LIVE_FRESH.json'),
        'routeCostBudget':     load_fragment('ROUTE_COST.json'),
        'strategyPromotion':   load_fragment('STRAT_PROMO.json'),
        'paperPnLDiagnostics': load_fragment('PNL_DIAG.json'),
        'defectMonitor':       load_fragment('DEFECT_MON.json'),
        'defectRegistry':      load_fragment('DEFECT_REG.json'),
        'qualityGateCoverage': load_fragment('QG_COVERAGE.json')
    },
    'locks':    load_fragment('locks.json'),
    'gitState': load_fragment('git_state.json'),
    'new_blockers': load_fragment('new_blockers.json')
}

with open('$OUTPUT_FILE', 'w') as f:
    json.dump(output, f, indent=2, ensure_ascii=False)

print('Snapshot written to $OUTPUT_FILE')
"
