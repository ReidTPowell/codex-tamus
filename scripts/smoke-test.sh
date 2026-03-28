#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STATIC_ONLY=0

if [[ "${1:-}" == "--static-only" ]]; then
  STATIC_ONLY=1
fi

if ! command -v codex >/dev/null 2>&1; then
  if [[ "$STATIC_ONLY" -eq 0 ]]; then
    printf 'codex is not in PATH\n' >&2
    exit 1
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  printf 'node is not in PATH\n' >&2
  exit 1
fi

printf 'Checking proxy scripts...\n'
bash -n "$REPO_ROOT/bin/codex"
bash -n "$REPO_ROOT/bin/tamus-proxy"
node --check "$REPO_ROOT/lib/tamus-responses-proxy.mjs"
node --check "$REPO_ROOT/lib/sync-tamus-model-cache.mjs"
node - "$REPO_ROOT/models/tamus-models.json" <<'NODE'
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(data) || data.length !== 13) {
  throw new Error(`expected 13 models, found ${Array.isArray(data) ? data.length : 'non-array'}`);
}
const unique = new Set(data);
if (unique.size !== data.length) {
  throw new Error('model list contains duplicates');
}
console.log(`validated ${data.length} models`);
NODE

if [[ "$STATIC_ONLY" -eq 1 ]]; then
  printf 'Static smoke test completed.\n'
  exit 0
fi

if [[ -z "${TAMUS_API_KEY:-}" ]]; then
  printf 'TAMUS_API_KEY is not set\n' >&2
  exit 1
fi

printf 'Restarting proxy...\n'
"$REPO_ROOT/bin/tamus-proxy" restart

printf 'Health check...\n'
python - <<'PY'
import json, urllib.request
req = urllib.request.Request("http://127.0.0.1:8765/healthz")
data = json.loads(urllib.request.urlopen(req, timeout=20).read().decode())
assert data["ok"] is True
assert data["has_api_key"] is True
print(json.dumps(data, indent=2))
PY

printf 'Model list check...\n'
python - <<'PY'
import json, urllib.request
req = urllib.request.Request("http://127.0.0.1:8765/models")
data = json.loads(urllib.request.urlopen(req, timeout=60).read().decode())
models = [item["id"] for item in data.get("data", [])]
print(f"models={len(models)}")
print("\n".join(models))
PY

printf 'Codex exec check...\n'
codex --tamus -a never -s danger-full-access exec --json --skip-git-repo-check 'Reply with TAMUS_SMOKE_OK only.'

printf 'Smoke test completed.\n'
