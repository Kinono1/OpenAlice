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

openalice_write_cron_lock_notification() {
  local job_name="$1"
  local lock_dir="$2"
  local notification_path="$3"
  local stale_after_seconds="${4:-${OPENALICE_CRON_LOCK_STALE_AFTER_SECONDS:-3600}}"
  local now_seconds lock_mtime_seconds lock_age_seconds
  now_seconds="$(date -u +%s)"
  lock_mtime_seconds="$(openalice_lock_mtime_epoch_seconds "$lock_dir")"
  lock_age_seconds=$((now_seconds - lock_mtime_seconds))
  if (( lock_mtime_seconds <= 0 || lock_age_seconds < 0 )); then
    lock_age_seconds=0
  fi

  mkdir -p "$(dirname "$notification_path")"
  node --input-type=module - "$job_name" "$lock_dir" "$notification_path" "$lock_age_seconds" "$stale_after_seconds" <<'NODE'
import { writeFileSync } from 'node:fs'

const [jobName, lockDir, notificationPath, ageRaw, staleAfterRaw] = process.argv.slice(2)
const lockAgeSeconds = Number(ageRaw)
const staleAfterSeconds = Number(staleAfterRaw)
const stale = Number.isFinite(lockAgeSeconds) &&
  Number.isFinite(staleAfterSeconds) &&
  lockAgeSeconds >= staleAfterSeconds
const headline = `${jobName} skipped: lock held${stale ? ' stale' : ''}`
const fullText = [
  `${jobName} skipped because a previous run still holds the cron lock.`,
  `lockDir=${lockDir}`,
  `lockAgeSeconds=${Number.isFinite(lockAgeSeconds) ? lockAgeSeconds : 'unknown'}`,
  `staleAfterSeconds=${Number.isFinite(staleAfterSeconds) ? staleAfterSeconds : 'unknown'}`,
  `stale=${stale}`,
].join(' ')

writeFileSync(notificationPath, `${JSON.stringify({
  shouldNotify: stale,
  deliveryDecision: stale ? 'notify' : 'suppress',
  headline,
  fullText,
  lockHeld: true,
  lockDir,
  lockAgeSeconds,
  staleAfterSeconds,
  stale,
}, null, 2)}\n`)
NODE
}

openalice_acquire_cron_lock() {
  local job_name="$1"
  local lock_dir="$2"
  local notification_path="$3"
  local log_file="${4:-}"

  mkdir -p "$(dirname "$lock_dir")" "$(dirname "$notification_path")"
  if mkdir "$lock_dir" 2>/dev/null; then
    return 0
  fi

  openalice_write_cron_lock_notification "$job_name" "$lock_dir" "$notification_path"
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
  rmdir "$lock_dir" 2>/dev/null || true
}
