# codex-tamus

Thin TAMU overlay for stock Codex.

This repo adds a `--tamus` entry point without patching `node_modules`. It starts a local Responses-compatible proxy, routes Codex traffic to `https://chat-api.tamu.ai/api/v1`, and injects the known-good TAMU models into the `/model` picker cache.

## What it does

- adds `codex --tamus`
- starts and manages a local TAMU Responses proxy
- uses a repo-local `state/` directory for TAMU sessions instead of `~/.codex`
- injects the 13 supported TAMU models into the picker cache
- keeps plain `codex` behavior unchanged

## Repo layout

- `bin/codex`: wrapper that intercepts `--tamus`
- `bin/tamus-proxy`: helper to manage the local proxy
- `lib/tamus-responses-proxy.mjs`: Responses-to-chat-completions shim
- `lib/sync-tamus-model-cache.mjs`: picker cache injector
- `models/tamus-models.json`: supported TAMU models
- `scripts/smoke-test.sh`: quick end-to-end verification
- `install.sh`: installs `~/bin/codex` and `~/bin/tamus-proxy` symlinks

## Prerequisites

- stock Codex installed and working in `PATH`
- Node.js available in `PATH`
- a TAMU API token exported as `TAMUS_API_KEY`

Optional:

- `TAMUS_UPSTREAM_BASE_URL` if TAMU changes the upstream route
- `TAMUS_PROXY_PORT` if `8765` is already in use

## Token setup

Example:

```bash
source ./env.example.sh
export TAMUS_API_KEY="paste-token-here"
```

## Install

From the repo root:

```bash
./install.sh
```

That creates:

- `~/bin/codex` -> this wrapper
- `~/bin/tamus-proxy` -> this helper

The installer auto-detects your existing stock Codex binary and stores that path in `state/real-codex-bin`.
If auto-detection is wrong, set `CODEX_TAMUS_REAL_BIN=/absolute/path/to/codex` when running `./install.sh`.

## Usage

Interactive:

```bash
codex --tamus
codex --tamus --no-alt-screen
```

Non-interactive:

```bash
codex --tamus exec --skip-git-repo-check 'Reply with OK only.'
codex --tamus exec resume --last --skip-git-repo-check 'Continue.'
```

Proxy management:

```bash
tamus-proxy status
tamus-proxy restart
tamus-proxy logs
```

## Supported models

The picker is limited to these known-good TAMU models:

- `protected.gpt-5.2`
- `protected.gpt-5.1`
- `protected.gpt-4.1`
- `protected.gpt-4o`
- `protected.Claude Sonnet 4.5`
- `protected.Claude-Haiku-4.5`
- `protected.Claude 3.5 Sonnet`
- `protected.Claude 3.5 Haiku`
- `protected.gemini-2.5-flash-lite`
- `protected.gemini-2.0-flash`
- `protected.gemini-2.0-flash-lite`
- `protected.llama3.2`
- `tamu-study-mode`

## Smoke test

After install and token setup:

```bash
./scripts/smoke-test.sh
```

Static validation only:

```bash
./scripts/smoke-test.sh --static-only
```

## CI

GitHub Actions includes:

- `validate`: runs on pushes and pull requests, and performs static verification only
- `live-smoke`: manual `workflow_dispatch` job that installs stock Codex and runs the end-to-end smoke test when `TAMUS_API_KEY` is configured as a repository secret

Recommended repository secret:

- `TAMUS_API_KEY`

## Sharing and access

For a personal repository:

1. Open repository `Settings`
2. Go to `Collaborators`
3. Add GitHub usernames individually

For a TAMU organization repository:

1. Transfer the repository to the org
2. Create or reuse a GitHub team
3. Grant team access at the repository level
4. Store `TAMUS_API_KEY` as an org or repo secret only if you want to use the manual `live-smoke` workflow

## Security notes

- This repo intentionally does not track `state/`.
- The proxy only reads `TAMUS_API_KEY`. It does not fall back to `OPENAI_API_KEY`.
- Do not commit real tokens into the repository.
- If TAMU policy requires restricted distribution, keep the repository private or move it into a TAMU-managed organization.

## Releases

Suggested release flow:

```bash
git tag -a v0.1.0 -m "codex-tamus v0.1.0"
git push origin v0.1.0
```

## Known limitations

- The proxy is a compatibility shim, not a native Responses implementation.
- Image-heavy or unusual future Responses features may need additional translation work.
- The overlay depends on Codex CLI internals staying reasonably stable across versions.
