#!/usr/bin/env bash
# Throttled embedding-cache GC, run on SessionEnd. Best-effort and fully
# non-blocking: it never fails or delays session termination. The throttle
# (MEMORY_GC_INTERVAL_DAYS, default 7) and last-run state (state/.embed-gc.json)
# are owned by `gc-embeddings --if-due`, so this wrapper just invokes it.
#
# Installed as its OWN SessionEnd entry, separate from the other memory hooks.
# Hook-less agents get the same behaviour via the embed-gc rule (they run
# `gc-embeddings --if-due` themselves at session end).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
node "$SCRIPT_DIR/../cli.mjs" gc-embeddings --if-due >/dev/null 2>&1 || true
exit 0
