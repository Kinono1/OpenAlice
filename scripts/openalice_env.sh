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

normalize_openalice_proxy_env() {
  if [[ -z "${HTTPS_PROXY:-}" && -n "${https_proxy:-}" ]]; then
    export HTTPS_PROXY="$https_proxy"
  fi
  if [[ -z "${https_proxy:-}" && -n "${HTTPS_PROXY:-}" ]]; then
    export https_proxy="$HTTPS_PROXY"
  fi
  if [[ -z "${HTTP_PROXY:-}" && -n "${http_proxy:-}" ]]; then
    export HTTP_PROXY="$http_proxy"
  fi
  if [[ -z "${http_proxy:-}" && -n "${HTTP_PROXY:-}" ]]; then
    export http_proxy="$HTTP_PROXY"
  fi
  if [[ -z "${NO_PROXY:-}" && -n "${no_proxy:-}" ]]; then
    export NO_PROXY="$no_proxy"
  fi
  if [[ -z "${no_proxy:-}" && -n "${NO_PROXY:-}" ]]; then
    export no_proxy="$NO_PROXY"
  fi
}

load_openalice_env
normalize_openalice_proxy_env
