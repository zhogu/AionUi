#!/usr/bin/env bash

set -euo pipefail

VERSION='2.2.2'
ARCHIVE_NAME="aionui-web-${VERSION}-linux-x86_64.tar.gz"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-${HOME}/.local/share/aionui-web}"
BIN_DIR="${BIN_DIR:-${HOME}/.local/bin}"
INSTALL_PARENT="$(dirname "$INSTALL_DIR")"

if [[ "$(uname -s)" != 'Linux' || "$(uname -m)" != 'x86_64' ]]; then
  echo 'This build supports Linux x86_64 only.' >&2
  exit 1
fi

parts=("${SCRIPT_DIR}/${ARCHIVE_NAME}.part-"*)
if [[ ! -f "${parts[0]}" ]]; then
  echo "Package parts not found beside install.sh: ${ARCHIVE_NAME}.part-*" >&2
  exit 1
fi

if [[ -e "${BIN_DIR}/aionui-web" && ! -L "${BIN_DIR}/aionui-web" ]]; then
  echo "${BIN_DIR}/aionui-web exists and is not a symlink." >&2
  exit 1
fi

mkdir -p "$INSTALL_PARENT" "$BIN_DIR"
TEMP_DIR="$(mktemp -d "${INSTALL_PARENT}/.aionui-web-install.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT

ARCHIVE_PATH="${TEMP_DIR}/${ARCHIVE_NAME}"
cat "${parts[@]}" > "$ARCHIVE_PATH"

expected_checksum="$(awk 'NR == 1 { print $1 }' "${SCRIPT_DIR}/${ARCHIVE_NAME}.sha256")"
if command -v sha256sum >/dev/null 2>&1; then
  actual_checksum="$(sha256sum "$ARCHIVE_PATH" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual_checksum="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{ print $1 }')"
else
  echo 'sha256sum or shasum is required.' >&2
  exit 1
fi

if [[ "$actual_checksum" != "$expected_checksum" ]]; then
  echo 'Package checksum verification failed.' >&2
  exit 1
fi

tar -xzf "$ARCHIVE_PATH" -C "$TEMP_DIR"
STAGED_DIR="${TEMP_DIR}/aionui-web"
if [[ ! -x "${STAGED_DIR}/aionui-web" ]]; then
  echo 'Invalid package: aionui-web executable is missing.' >&2
  exit 1
fi

backup_dir=''
if [[ -e "$INSTALL_DIR" ]]; then
  backup_dir="${INSTALL_DIR}.backup.$(date +%Y%m%dT%H%M%S)"
  mv "$INSTALL_DIR" "$backup_dir"
fi

if ! mv "$STAGED_DIR" "$INSTALL_DIR"; then
  if [[ -n "$backup_dir" && -e "$backup_dir" ]]; then
    mv "$backup_dir" "$INSTALL_DIR"
  fi
  exit 1
fi

ln -sfn "${INSTALL_DIR}/aionui-web" "${BIN_DIR}/aionui-web"

echo "AionUi Web ${VERSION} installed at ${INSTALL_DIR}"
if [[ -n "$backup_dir" ]]; then
  echo "Previous installation backed up at ${backup_dir}"
fi
echo "Start with: ${BIN_DIR}/aionui-web start"
