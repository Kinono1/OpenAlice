# OpenAlice OKX Warehouse and SSD Migration Manifest — 2026-07-18

## Safety baseline

- Pre-change backup: `/Users/kino/.local/share/openalice/backups/20260718T074815Z_okx_warehouse_ssd`
- The existing dirty worktree is preserved; no reset, clean, or bulk rollback was used.
- `evolutionMode=false`, active private accounts remain zero, and candidate-mode automation remains disabled.
- Active market data always writes to the repository-local data root. `/Volumes/shield` is cold storage only after explicit UUID plus archive-ID enrollment.

## Scheduler ownership

| Job family | Owner | Initial state | Migration rule |
|---|---|---|---|
| Existing OKX 1s/5m/1h collectors | CronEngine | Retained and enabled | Keep until the new warehouse passes a 24-hour shadow comparison. |
| OKX warehouse instrument/fast/broad/compact/universe | CronEngine | Installed disabled | Enable only through the P0 canary and shadow rollout. |
| OKX market-data health | CronEngine | Enabled | Read-only health and storage-pressure reporting. |
| SSD presence/archive probe | CronEngine | Enabled | Missing enrollment or an unmounted SSD is a blocked state, not a retry failure. |
| SSD weekly/follow-up reminders | CronEngine | Enabled | Sunday 20:00 and Monday-Wednesday 20:00 local time with 24-hour state rate limiting. |
| SSD integrity and local retention | CronEngine | Enabled | Retention deletes only after current-volume identity validation and batch re-verification. |
| OKX WebSocket worker | `ai.openalice.main` child supervisor | Config disabled | No second LaunchAgent; enable only after P1 canary. |

## Data and rollback

- New local warehouse: `data/warehouse/okx`.
- Legacy CSV/JSONL consumers remain authoritative during shadow rollout.
- Old files are not deleted by this migration. A later cutover requires a committed SSD archive batch plus retention eligibility.
- Rollback before P0 enablement: disable/remove the new internal job names and leave `data/config/okx-market-data.json` with `enabled=false` and `stream.enabled=false`.
- Rollback after P0 enablement: disable new collectors, retain immutable warehouse artifacts, and keep/re-enable the legacy collectors. Do not relabel or overwrite historical rows.
- SSD enrollment cannot be fabricated while the volume is offline. First enrollment requires the real `shield` mount and a successful write/fsync/rename/delete canary.
