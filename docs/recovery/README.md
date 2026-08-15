# OpenAlice Recovery Documents

| 文件 | 用途 |
|------|------|
| `OpenAlice_recovery_backlog_v5.md` | 当前可执行计划（v5） |
| `OpenAlice_recovery_snapshot.json` | 脚本生成的运行时 Snapshot（每次执行前刷新） |
| `OpenAlice_recovery_archive_DO_NOT_EXECUTE.md` | 旧版存档，不作为执行依据 |
| `OpenAlice_recovery_handoff.md` | Agent 接手 prompt |
| `scripts/generate_snapshot.sh` | Snapshot 生成脚本 |

**每次执行前**: 先运行 `scripts/generate_snapshot.sh` 刷新 snapshot，再读最新值。
