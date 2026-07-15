#!/usr/bin/env bash
# Best-effort re-embed of changed SHARED wiki categories after a host-repo git
# merge/checkout/rewrite. Detached + always exits 0 so it can never block or
# fail the host repo's git operation. Lazy-embed at search time is the net.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# git sets GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE (and merge-time quarantine
# vars) for its hooks; inherited, they hijack sync-embeddings' OWN `git -C <dir>`
# range resolution (it reads the hook's transient index) so it warms nothing.
# Clear them so the child resolves the mount's repo cleanly.
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_QUARANTINE_PATH GIT_QUARANTINE_ENVIRONMENT
# Default: fully detached so it can never block or fail the host git op. Tests
# set LWM_SYNC_EMBEDDINGS_FOREGROUND=1 to run synchronously — a detached
# background process is not reliably reaped-to-completion on CI runners, so the
# async form can't be asserted deterministically there.
if [ -n "${LWM_SYNC_EMBEDDINGS_FOREGROUND:-}" ]; then
  node "$SCRIPT_DIR/sync-embeddings.mjs" "$@" >/dev/null 2>&1 || true
else
  ( node "$SCRIPT_DIR/sync-embeddings.mjs" "$@" >/dev/null 2>&1 & )
fi
exit 0
