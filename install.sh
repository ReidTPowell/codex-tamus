#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR" && pwd)"
STATE_DIR="$REPO_ROOT/state"
BIN_DIR="$HOME/bin"
WRAPPER_PATH="$BIN_DIR/codex"
PROXY_PATH="$BIN_DIR/tamus-proxy"
REAL_CODEX_BIN_FILE="$STATE_DIR/real-codex-bin"

resolve_path() {
  if command -v realpath >/dev/null 2>&1; then
    realpath "$1"
  else
    readlink -f "$1"
  fi
}

detect_real_codex() {
  if [[ -n "${CODEX_TAMUS_REAL_BIN:-}" ]]; then
    printf '%s\n' "$CODEX_TAMUS_REAL_BIN"
    return 0
  fi

  local current
  current="$(command -v codex || true)"
  if [[ -z "$current" ]]; then
    printf 'No codex command found in PATH.\n' >&2
    exit 1
  fi

  local resolved
  resolved="$(resolve_path "$current")"
  if [[ "$resolved" == "$(resolve_path "$REPO_ROOT/bin/codex")" ]]; then
    if [[ -f "$REAL_CODEX_BIN_FILE" ]]; then
      cat "$REAL_CODEX_BIN_FILE"
      return 0
    fi
    printf 'Wrapper already installed but real codex path is unknown.\n' >&2
    exit 1
  fi

  if [[ "$current" == "$BIN_DIR/codex" ]]; then
    local existing_overlay_state=""
    existing_overlay_state="$(cd "$(dirname "$resolved")/.." 2>/dev/null && pwd || true)"
    if [[ -n "$existing_overlay_state" && -f "$existing_overlay_state/state/real-codex-bin" ]]; then
      cat "$existing_overlay_state/state/real-codex-bin"
      return 0
    fi

    local fallback=""
    fallback="$(type -a codex | awk 'NR==2 {print $3}')"
    if [[ -n "$fallback" ]]; then
      printf '%s\n' "$fallback"
      return 0
    fi
  fi

  printf '%s\n' "$current"
}

mkdir -p "$STATE_DIR" "$BIN_DIR"
detect_real_codex >"$REAL_CODEX_BIN_FILE"
chmod 644 "$REAL_CODEX_BIN_FILE"
ln -sfn "$REPO_ROOT/bin/codex" "$WRAPPER_PATH"
ln -sfn "$REPO_ROOT/bin/tamus-proxy" "$PROXY_PATH"
chmod 755 "$REPO_ROOT/bin/codex" "$REPO_ROOT/bin/tamus-proxy" "$REPO_ROOT/install.sh"
printf 'Installed codex-tamus overlay.\n'
printf 'Wrapper: %s\n' "$WRAPPER_PATH"
printf 'Proxy helper: %s\n' "$PROXY_PATH"
printf 'Real codex: %s\n' "$(cat "$REAL_CODEX_BIN_FILE")"
