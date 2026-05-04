#!/usr/bin/env bash

load_openalice_env() {
  local explicit_env_file="${OPENALICE_ENV_FILE:-}"
  local default_env_file=""
  if [[ -n "${HOME:-}" ]]; then
    default_env_file="$HOME/.config/openalice/openalice.env"
  fi

  local env_file="${explicit_env_file:-$default_env_file}"
  if [[ -z "$env_file" ]]; then
    return 0
  fi

  if [[ ! -e "$env_file" ]]; then
    if [[ -n "$explicit_env_file" ]]; then
      echo "OPENALICE_ENV_FILE points to a missing file: $env_file" >&2
      return 78
    fi
    return 0
  fi

  if [[ ! -f "$env_file" || -L "$env_file" ]]; then
    echo "OPENALICE_ENV_FILE must be a regular non-symlink file: $env_file" >&2
    return 78
  fi

  local stat_output owner_uid mode
  if stat_output="$(stat -f '%u %Lp' "$env_file" 2>/dev/null)"; then
    read -r owner_uid mode <<<"$stat_output"
  elif stat_output="$(stat -c '%u %a' "$env_file" 2>/dev/null)"; then
    read -r owner_uid mode <<<"$stat_output"
  else
    echo "unable to stat OPENALICE_ENV_FILE: $env_file" >&2
    return 78
  fi

  if [[ "$owner_uid" != "$(id -u)" ]]; then
    echo "OPENALICE_ENV_FILE must be owned by the current user: $env_file" >&2
    return 78
  fi

  if (( (10#$mode % 100) != 0 )); then
    echo "OPENALICE_ENV_FILE must not be group/other-accessible; run: chmod 600 $env_file" >&2
    return 78
  fi

  local allexport_was_set="false"
  case "$-" in
    *a*) allexport_was_set="true" ;;
  esac

  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  if [[ "$allexport_was_set" != "true" ]]; then
    set +a
  fi
}

load_openalice_env
