#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

assert_contains() {
  local file="$1"
  local needle="$2"
  if ! grep -Fq -- "$needle" "$ROOT/$file"; then
    echo "missing in $file: $needle" >&2
    exit 1
  fi
}

assert_not_contains() {
  local file="$1"
  local needle="$2"
  if grep -Fq -- "$needle" "$ROOT/$file"; then
    echo "unexpected in $file: $needle" >&2
    exit 1
  fi
}

bash -n "$ROOT/install.sh"

assert_contains install.sh "--sidecar)"
assert_contains install.sh 'INSTALL_MODE="sidecar"'
assert_contains install.sh 'printf '"'"'%s\n'"'"' "$INSTALL_MODE" > "$CLAWGOD_DIR/install-mode"'
assert_contains install.sh '"$CLAWGOD_DIR/install-mode"'
assert_contains install.sh 'if [ "$INSTALL_MODE" = "sidecar" ]; then'
assert_contains install.sh 'write_launcher "$BIN_DIR/clawgod"'
sidecar_sh_block="$(perl -0ne 'if (/if \[ "\$INSTALL_MODE" = "sidecar" \]; then\n(.*?)\nelse\n/s) { print $1 }' "$ROOT/install.sh")"
if grep -Fq 'write_launcher "$CLAUDE_BIN"' <<<"$sidecar_sh_block"; then
  echo "sidecar branch must not write claude launcher" >&2
  exit 1
fi

assert_contains install.ps1 '[switch]$Sidecar'
assert_contains install.ps1 '$InstallMode = if ($Sidecar) { "sidecar" } else { "hijack" }'
assert_contains install.ps1 'Set-Content (Join-Path $ClawDir "install-mode") $InstallMode'
assert_contains install.ps1 'if ($InstallMode -eq "sidecar")'
assert_contains install.ps1 'Set-Content (Join-Path $BinDir "clawgod.cmd")'

assert_contains install.sh "install-mode"
assert_contains install.ps1 "install-mode"
