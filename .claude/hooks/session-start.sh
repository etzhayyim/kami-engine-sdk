#!/bin/bash
# SessionStart hook — etzhayyim/kami-engine-sdk
#
# Bootstraps the Node toolchain + installs dependencies so a Claude Code on the
# web session can build (`npm run build` → svelte-package) and test
# (`npm test` → vitest) the SDK WITHOUT any secrets touching the cloud container.
#
# Idempotent: re-running is a no-op once node_modules exists.
#
# Runs only in the remote (web) environment. Local Macs already have the toolchain.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  echo "session-start: not a remote session — skipping toolchain bootstrap"
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
log() { echo "session-start: $*"; }

if ! command -v node >/dev/null 2>&1; then
  log "WARN: node not found — build/test will be unavailable (expected on the cloud image)"
  exit 0
fi
log "node $(node --version) / npm $(npm --version 2>/dev/null || echo '?')"

# ── Install dependencies (idempotent) ────────────────────────────────────────
cd "$PROJECT_DIR"
if [ -d node_modules ] && [ node_modules -nt package.json ]; then
  log "node_modules present and up to date — skipping install"
else
  log "installing dependencies"
  if [ -f package-lock.json ]; then
    npm ci >/tmp/sdk-install.log 2>&1 || npm install >/tmp/sdk-install.log 2>&1 \
      || { log "WARN: dependency install failed"; tail -20 /tmp/sdk-install.log; exit 0; }
  else
    npm install >/tmp/sdk-install.log 2>&1 \
      || { log "WARN: dependency install failed"; tail -20 /tmp/sdk-install.log; exit 0; }
  fi
  log "dependencies installed"
fi

log "toolchain ready — npm run build + npm test enabled"
