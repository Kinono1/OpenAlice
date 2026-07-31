#!/usr/bin/env bash

# LaunchAgent-safe pnpm resolver. Source this file and call
# openalice_run_pnpm; it never downloads or activates package managers.
openalice_run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
    return
  fi

  local pnpm_candidate
  for pnpm_candidate in \
    /opt/homebrew/bin/pnpm \
    /usr/local/bin/pnpm \
    /opt/pkg/env/active/bin/pnpm \
    /opt/pmk/env/global/bin/pnpm; do
    if [[ -x "$pnpm_candidate" ]]; then
      "$pnpm_candidate" "$@"
      return
    fi
  done

  if command -v corepack >/dev/null 2>&1; then
    corepack pnpm "$@"
    return
  fi

  echo "pnpm is required but was not found in PATH or approved local install locations" >&2
  return 127
}
