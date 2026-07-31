# Standard Trap Pattern for Cron Scripts

All cron scripts should use this trap pattern for consistent error handling:

```bash
#!/usr/bin/env bash
set -euo pipefail

cleanup() {
  local exit_code=$?
  # Add cleanup logic here (release locks, etc.)
  if [[ $exit_code -ne 0 ]]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] cleanup: script exited with code $exit_code" >> "$LOG_PATH"
  fi
}
trap cleanup EXIT INT TERM
```

## Why This Pattern?

- `EXIT`: Always runs when script exits (success or failure)
- `INT`: Catches Ctrl+C (SIGINT)
- `TERM`: Catches kill/launchd stop (SIGTERM)

## Anti-Pattern

Do NOT use:
```bash
trap 'some_function' EXIT  # Missing INT/TERM
```

This only catches normal exits, not interrupts.
