#!/bin/sh

# Supported D1 entrypoint.  The service manager must provide five pinned values
# (absolute Node/Python paths, Node and launcher-module hashes, and the trusted
# publisher UID); everything else is removed before Node starts.
set -eu

node_path=${OPENALICE_NODE-}
node_sha256=${OPENALICE_NODE_SHA256-}
runtime_python=${OPENALICE_NAUTILUS_PYTHON-}
publisher_uid=${OPENALICE_RELEASE_PUBLISHER_UID-}
mjs_sha256=${OPENALICE_PAPER_LOCAL_MJS_SHA256-}

trusted_deployment_path() {
  trusted_path=$1
  trusted_error=$2
  while :; do
    if [ -L "$trusted_path" ]; then
      echo "$trusted_error" >&2
      exit 2
    fi
    trusted_meta=$(/usr/bin/stat -f '%u %Lp' "$trusted_path" 2>/dev/null) || {
      echo "$trusted_error" >&2
      exit 2
    }
    trusted_owner=${trusted_meta%% *}
    trusted_mode=${trusted_meta#* }
    case "$trusted_owner" in
      0|"$publisher_uid") ;;
      *) echo "$trusted_error" >&2; exit 2 ;;
    esac
    case "$trusted_mode" in
      ''|*[!0-7]*) echo "$trusted_error" >&2; exit 2 ;;
    esac
    if [ $((0$trusted_mode & 022)) -ne 0 ] || [ -w "$trusted_path" ]; then
      echo "$trusted_error" >&2
      exit 2
    fi
    if [ "$trusted_path" = / ]; then
      return
    fi
    trusted_parent=$(/usr/bin/dirname -- "$trusted_path") || {
      echo "$trusted_error" >&2
      exit 2
    }
    if [ "$trusted_parent" != / ] && [ ! -d "$trusted_parent" ]; then
      echo "$trusted_error" >&2
      exit 2
    fi
    trusted_path=$trusted_parent
  done
}

case "$node_path" in
  /*) ;;
  *) echo "absolute_OPENALICE_NODE_required" >&2; exit 2 ;;
esac
case "$runtime_python" in
  /*) ;;
  *) echo "absolute_OPENALICE_NAUTILUS_PYTHON_required" >&2; exit 2 ;;
esac
case "$node_sha256" in
  ''|*[!0-9a-f]*) echo "OPENALICE_NODE_SHA256_required" >&2; exit 2 ;;
  *) ;;
esac
case "$mjs_sha256" in
  ''|*[!0-9a-f]*) echo "OPENALICE_PAPER_LOCAL_MJS_SHA256_required" >&2; exit 2 ;;
  *) ;;
esac
case "$publisher_uid" in
  ''|*[!0-9]*) echo "OPENALICE_RELEASE_PUBLISHER_UID_required" >&2; exit 2 ;;
  *) ;;
esac
service_real_uid=$(/usr/bin/id -r -u)
service_effective_uid=$(/usr/bin/id -u)
case "$service_real_uid" in
  ''|0|*[!0-9]*) echo "trusted_node_service_uid_unsafe" >&2; exit 2 ;;
esac
case "$service_effective_uid" in
  ''|0|*[!0-9]*) echo "trusted_node_service_uid_unsafe" >&2; exit 2 ;;
esac
if [ "$service_real_uid" != "$service_effective_uid" ]; then
  echo "trusted_node_service_uid_unsafe" >&2
  exit 2
fi
if [ "$service_real_uid" = "$publisher_uid" ] || [ "$service_effective_uid" = "$publisher_uid" ]; then
  echo "trusted_node_publisher_uid_unsafe" >&2
  exit 2
fi
if [ "${#node_sha256}" -ne 64 ] || [ ! -f "$node_path" ] || [ -L "$node_path" ] || [ ! -x "$node_path" ]; then
  echo "trusted_node_invalid" >&2
  exit 2
fi
if [ "${#mjs_sha256}" -ne 64 ]; then
  echo "OPENALICE_PAPER_LOCAL_MJS_SHA256_required" >&2
  exit 2
fi
trusted_deployment_path "$node_path" trusted_node_path_unsafe
actual_node_sha256=$(/usr/bin/shasum -a 256 "$node_path")
actual_node_sha256=${actual_node_sha256%% *}
if [ "$actual_node_sha256" != "$node_sha256" ]; then
  echo "trusted_node_hash_mismatch" >&2
  exit 2
fi

case "$0" in
  /*) ;;
  *) echo "paper_local_shell_entrypoint_unsafe" >&2; exit 2 ;;
esac
script_dir=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
shell_path="$script_dir/launch_nautilus_paper.sh"
module_path="$script_dir/launch_nautilus_paper.mjs"
if [ "$0" != "$shell_path" ] || [ ! -f "$shell_path" ] || [ -L "$shell_path" ]; then
  echo "paper_local_shell_entrypoint_unsafe" >&2
  exit 2
fi
trusted_deployment_path "$shell_path" paper_local_shell_entrypoint_unsafe
if [ ! -f "$module_path" ] || [ -L "$module_path" ]; then
  echo "paper_local_mjs_entrypoint_unsafe" >&2
  exit 2
fi
trusted_deployment_path "$module_path" paper_local_mjs_entrypoint_unsafe
actual_mjs_sha256=$(/usr/bin/shasum -a 256 "$module_path")
actual_mjs_sha256=${actual_mjs_sha256%% *}
if [ "$actual_mjs_sha256" != "$mjs_sha256" ]; then
  echo "paper_local_mjs_hash_mismatch" >&2
  exit 2
fi
if [ "$#" -eq 0 ]; then
  release_root=${OPENALICE_RELEASE_DIR-}
  supervisor_config=${OPENALICE_PAPER_LOCAL_SUPERVISOR_CONFIG-}
  case "$release_root" in
    /*) ;;
    *) echo "absolute_OPENALICE_RELEASE_DIR_required" >&2; exit 2 ;;
  esac
  case "$supervisor_config" in
    /*) ;;
    *) echo "absolute_OPENALICE_PAPER_LOCAL_SUPERVISOR_CONFIG_required" >&2; exit 2 ;;
  esac
  set -- \
    --release-root "$release_root" \
    --pointer research-current \
    --config "$supervisor_config"
fi
exec /usr/bin/env -i \
  PATH=/usr/bin:/bin \
  LANG=C \
  LC_ALL=C \
  OPENALICE_NAUTILUS_PYTHON="$runtime_python" \
  OPENALICE_RELEASE_PUBLISHER_UID="$publisher_uid" \
  OPENALICE_PAPER_LOCAL_SHELL_PATH="$shell_path" \
  "$node_path" "$module_path" "$@"
