#!/usr/bin/env bash
# Best-effort re-embed of changed SHARED wiki categories after a host-repo git
# merge/checkout/rewrite. Detached + always exits 0 so it can never block or
# fail the host repo's git operation. Lazy-embed at search time is the net.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
( node "$SCRIPT_DIR/sync-embeddings.mjs" "$@" >/dev/null 2>&1 & )
exit 0
