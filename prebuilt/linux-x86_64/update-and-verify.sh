#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
SERVICE_NAME="${SERVICE_NAME:-aionui-webui.service}"
PORT="${PORT:-25808}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT}/}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-build}"
stopped=0
verify_dir=''

usage() {
  cat <<'EOF'
Update the build checkout, install AionUi Web, restart its system service, and
wait for the local HTTP endpoint to respond.

Usage:
  bash prebuilt/linux-x86_64/update-and-verify.sh

Environment overrides:
  SERVICE_NAME=aionui-webui.service
  PORT=25808
  HEALTH_URL=http://127.0.0.1:25808/
  HEALTH_TIMEOUT=60
  REMOTE=origin
  BRANCH=build
  INSTALL_DIR=~/.local/share/aionui-web
  BIN_DIR=~/.local/bin
EOF
}

if [[ "${1:-}" == '--help' || "${1:-}" == '-h' ]]; then
  usage
  exit 0
fi
if [[ $# -ne 0 ]]; then
  usage >&2
  exit 2
fi
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
  echo "Invalid PORT: ${PORT}" >&2
  exit 2
fi
if [[ ! "$HEALTH_TIMEOUT" =~ ^[0-9]+$ ]] || ((HEALTH_TIMEOUT < 1)); then
  echo "Invalid HEALTH_TIMEOUT: ${HEALTH_TIMEOUT}" >&2
  exit 2
fi

for command in git sudo systemctl curl sha256sum tar; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: ${command}" >&2
    exit 1
  fi
done

cleanup() {
  if [[ -n "$verify_dir" && -d "$verify_dir" ]]; then
    rm -rf "$verify_dir"
  fi
}

recover_service() {
  local exit_code=$?
  trap - ERR
  if ((stopped)); then
    echo "Update failed; attempting to start ${SERVICE_NAME} again." >&2
    sudo systemctl start "$SERVICE_NAME" || true
    sudo systemctl status "$SERVICE_NAME" --no-pager -l || true
  fi
  exit "$exit_code"
}

trap cleanup EXIT
trap recover_service ERR

current_branch="$(git -C "$REPO_ROOT" branch --show-current)"
if [[ "$current_branch" != "$BRANCH" ]]; then
  echo "Expected branch ${BRANCH}, but this checkout is on ${current_branch:-a detached HEAD}." >&2
  exit 1
fi

echo "Updating ${REMOTE}/${BRANCH}..."
git -C "$REPO_ROOT" pull --ff-only "$REMOTE" "$BRANCH"

# Resolve this again after pull so a package layout update is respected.
SCRIPT_DIR="${REPO_ROOT}/prebuilt/linux-x86_64"
INSTALL_SCRIPT="${SCRIPT_DIR}/install.sh"
checksum_file="$(find "$SCRIPT_DIR" -maxdepth 1 -type f -name 'aionui-web-*-linux-x86_64.tar.gz.sha256' -print -quit)"
if [[ ! -x "$INSTALL_SCRIPT" || -z "$checksum_file" ]]; then
  echo 'The build branch does not contain a complete Linux x86_64 installer.' >&2
  exit 1
fi

archive_name="$(awk 'NR == 1 { print $2 }' "$checksum_file")"
archive_name="${archive_name#\*}"
archive_name="${archive_name##*/}"
parts=("${SCRIPT_DIR}/${archive_name}.part-"*)
if [[ -z "$archive_name" || ! -f "${parts[0]}" ]]; then
  echo "Package parts not found for ${archive_name:-the checksummed archive}." >&2
  exit 1
fi

echo 'Verifying package before stopping the service...'
verify_dir="$(mktemp -d)"
cat "${parts[@]}" > "${verify_dir}/${archive_name}"
(
  cd "$verify_dir"
  sha256sum -c "$checksum_file"
)
tar -tzf "${verify_dir}/${archive_name}" >/dev/null
cleanup
verify_dir=''

sudo systemctl cat "$SERVICE_NAME" >/dev/null
if ! sudo systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "${SERVICE_NAME} is not active; refusing to start an intentionally stopped service." >&2
  exit 1
fi

echo "Stopping ${SERVICE_NAME}..."
sudo systemctl stop "$SERVICE_NAME"
stopped=1

echo 'Installing verified package...'
bash "$INSTALL_SCRIPT"

echo "Starting ${SERVICE_NAME}..."
sudo systemctl start "$SERVICE_NAME"
stopped=0

deadline=$((SECONDS + HEALTH_TIMEOUT))
until curl --noproxy '*' -fsS --max-time 5 -o /dev/null "$HEALTH_URL"; do
  if ((SECONDS >= deadline)); then
    echo "HTTP health check did not succeed within ${HEALTH_TIMEOUT}s: ${HEALTH_URL}" >&2
    stopped=1
    false
  fi
  sleep 2
done

sudo systemctl status "$SERVICE_NAME" --no-pager -l
curl --noproxy '*' -fsS --max-time 15 -o /dev/null \
  -w 'HTTP %{http_code}, %{size_download} bytes, %{time_total}s\n' \
  "$HEALTH_URL"
echo "AionUi Web update completed successfully from ${REMOTE}/${BRANCH}."
