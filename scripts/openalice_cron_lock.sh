#!/usr/bin/env bash

openalice_lock_mtime_epoch_seconds() {
  local path="$1"
  local stat_output
  if stat_output="$(stat -f '%m' "$path" 2>/dev/null)"; then
    printf '%s\n' "$stat_output"
    return 0
  fi
  if stat_output="$(stat -c '%Y' "$path" 2>/dev/null)"; then
    printf '%s\n' "$stat_output"
    return 0
  fi
  printf '0\n'
}

openalice_cron_lock_age_seconds() {
  local lock_dir="$1"
  local now_seconds lock_mtime_seconds lock_age_seconds
  now_seconds="$(date -u +%s)"
  lock_mtime_seconds="$(openalice_lock_mtime_epoch_seconds "$lock_dir")"
  lock_age_seconds=$((now_seconds - lock_mtime_seconds))
  if (( lock_mtime_seconds <= 0 || lock_age_seconds < 0 )); then
    lock_age_seconds=0
  fi
  printf '%s\n' "$lock_age_seconds"
}

openalice_cron_lock_owner_pid() {
  local lock_dir="$1"
  local owner_pid=""
  if [[ -f "$lock_dir/owner_pid" ]]; then
    IFS= read -r owner_pid < "$lock_dir/owner_pid" || true
  fi
  if [[ "$owner_pid" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$owner_pid"
    return 0
  fi
  printf '\n'
}

openalice_cron_lock_owner_alive() {
  local owner_pid="$1"
  [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null
}

openalice_write_cron_lock_owner() {
  local lock_dir="$1"
  local token="$$-$(date -u +%s)-${RANDOM:-0}-${RANDOM:-0}"
  local previous_umask
  previous_umask="$(umask)"
  umask 077
  printf '%s\n' "$$" > "$lock_dir/owner_pid"
  printf '%s\n' "$token" > "$lock_dir/owner_token"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$lock_dir/owner_started_at"
  umask "$previous_umask"
  OPENALICE_CRON_LOCK_HELD_DIR="$lock_dir"
  OPENALICE_CRON_LOCK_HELD_TOKEN="$token"
}

openalice_write_cron_lock_notification() {
  local job_name="$1"
  local lock_dir="$2"
  local notification_path="$3"
  local stale_after_seconds="${4:-${OPENALICE_CRON_LOCK_STALE_AFTER_SECONDS:-3600}}"
  local owner_pid="${5:-}"
  local owner_alive="${6:-false}"
  local lock_recovered="${7:-false}"
  local recovery_path="${8:-}"
  local lock_age_seconds="${9:-$(openalice_cron_lock_age_seconds "$lock_dir")}"

  mkdir -p "$(dirname "$notification_path")"
  node --input-type=module - "$job_name" "$lock_dir" "$notification_path" "$lock_age_seconds" "$stale_after_seconds" "$owner_pid" "$owner_alive" "$lock_recovered" "$recovery_path" <<'NODE'
import { writeFileSync } from 'node:fs'

const [
  jobName,
  lockDir,
  notificationPath,
  ageRaw,
  staleAfterRaw,
  ownerPidRaw,
  ownerAliveRaw,
  lockRecoveredRaw,
  recoveryPathRaw,
] = process.argv.slice(2)
const lockAgeSeconds = Number(ageRaw)
const staleAfterSeconds = Number(staleAfterRaw)
const ownerPid = /^\d+$/.test(ownerPidRaw ?? '') ? Number(ownerPidRaw) : null
const ownerAlive = ownerAliveRaw === 'true'
const lockRecovered = lockRecoveredRaw === 'true'
const recoveryPath = recoveryPathRaw || null
const stale = Number.isFinite(lockAgeSeconds) &&
  Number.isFinite(staleAfterSeconds) &&
  lockAgeSeconds >= staleAfterSeconds
const headline = lockRecovered
  ? `${jobName} recovered stale orphan lock`
  : `${jobName} skipped: lock held${stale ? ' stale' : ''}`
const fullText = [
  lockRecovered
    ? `${jobName} recovered a stale cron lock because its owner process was not alive.`
    : `${jobName} skipped because a previous run still holds the cron lock.`,
  `lockDir=${lockDir}`,
  `lockAgeSeconds=${Number.isFinite(lockAgeSeconds) ? lockAgeSeconds : 'unknown'}`,
  `staleAfterSeconds=${Number.isFinite(staleAfterSeconds) ? staleAfterSeconds : 'unknown'}`,
  `stale=${stale}`,
  `ownerPid=${ownerPid ?? 'unknown'}`,
  `ownerAlive=${ownerAlive}`,
  `lockRecovered=${lockRecovered}`,
  recoveryPath ? `recoveryPath=${recoveryPath}` : '',
].filter(Boolean).join(' ')

writeFileSync(notificationPath, `${JSON.stringify({
  shouldNotify: stale,
  deliveryDecision: stale ? 'notify' : 'suppress',
  headline,
  fullText,
  lockHeld: !lockRecovered,
  lockDir,
  lockAgeSeconds,
  staleAfterSeconds,
  stale,
  ownerPid,
  ownerAlive,
  lockRecovered,
  recoveryPath,
}, null, 2)}\n`)
NODE
}

openalice_recover_stale_cron_lock() {
  local lock_dir="$1"
  local recovery_root recovery_path
  recovery_root="${OPENALICE_CRON_LOCK_RECOVERY_DIR:-$(dirname "$lock_dir")/../lock_recovery}"
  mkdir -p "$recovery_root"
  recovery_path="$recovery_root/$(basename "$lock_dir").$(date -u +%Y%m%dT%H%M%SZ).$$.${RANDOM:-0}"
  if mv "$lock_dir" "$recovery_path" 2>/dev/null; then
    printf '%s\n' "$recovery_path"
    return 0
  fi
  return 1
}

openalice_acquire_cron_lock() {
  local job_name="$1"
  local lock_dir="$2"
  local notification_path="$3"
  local log_file="${4:-}"
  local stale_after_seconds="${OPENALICE_CRON_LOCK_STALE_AFTER_SECONDS:-3600}"

  mkdir -p "$(dirname "$lock_dir")" "$(dirname "$notification_path")"
  if mkdir "$lock_dir" 2>/dev/null; then
    if openalice_write_cron_lock_owner "$lock_dir"; then
      return 0
    fi
    rmdir "$lock_dir" 2>/dev/null || true
    return 1
  fi

  local owner_pid owner_alive="false" recovery_path="" lock_age_seconds
  owner_pid="$(openalice_cron_lock_owner_pid "$lock_dir")"
  lock_age_seconds="$(openalice_cron_lock_age_seconds "$lock_dir")"
  if openalice_cron_lock_owner_alive "$owner_pid"; then
    owner_alive="true"
  fi

  if [[ "$owner_alive" != "true" ]] && (( lock_age_seconds >= stale_after_seconds )); then
    if recovery_path="$(openalice_recover_stale_cron_lock "$lock_dir")" && mkdir "$lock_dir" 2>/dev/null; then
      if openalice_write_cron_lock_owner "$lock_dir"; then
        openalice_write_cron_lock_notification "$job_name" "$lock_dir" "$notification_path" "$stale_after_seconds" "$owner_pid" "$owner_alive" "true" "$recovery_path" "$lock_age_seconds"
        local recovered_message="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ${job_name}: recovered stale orphan lock from ${recovery_path}"
        if [[ -n "$log_file" ]]; then
          mkdir -p "$(dirname "$log_file")"
          echo "$recovered_message" >> "$log_file"
        else
          echo "$recovered_message"
        fi
        return 0
      fi
      rmdir "$lock_dir" 2>/dev/null || true
    fi
  fi

  owner_pid="$(openalice_cron_lock_owner_pid "$lock_dir")"
  owner_alive="false"
  if openalice_cron_lock_owner_alive "$owner_pid"; then
    owner_alive="true"
  fi
  openalice_write_cron_lock_notification "$job_name" "$lock_dir" "$notification_path" "$stale_after_seconds" "$owner_pid" "$owner_alive" "false" "" "$lock_age_seconds"
  local message="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ${job_name}: lock exists, skipping overlap"
  if [[ -n "$log_file" ]]; then
    mkdir -p "$(dirname "$log_file")"
    echo "$message" >> "$log_file"
  else
    echo "$message"
  fi
  return 1
}

openalice_release_cron_lock() {
  local lock_dir="$1"
  local held_dir="${OPENALICE_CRON_LOCK_HELD_DIR:-}"
  local held_token="${OPENALICE_CRON_LOCK_HELD_TOKEN:-}"
  local current_token=""
  if [[ "$held_dir" != "$lock_dir" || -z "$held_token" || ! -f "$lock_dir/owner_token" ]]; then
    return 0
  fi
  IFS= read -r current_token < "$lock_dir/owner_token" || true
  if [[ "$current_token" != "$held_token" ]]; then
    return 0
  fi
  rm -f "$lock_dir/owner_pid" "$lock_dir/owner_token" "$lock_dir/owner_started_at"
  rmdir "$lock_dir" 2>/dev/null || true
  OPENALICE_CRON_LOCK_HELD_DIR=""
  OPENALICE_CRON_LOCK_HELD_TOKEN=""
}
