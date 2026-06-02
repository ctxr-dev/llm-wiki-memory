#!/usr/bin/env bash
# PreToolUse wrapper for the memory-write gate (L2 of the hardening stack).
# See pretooluse-gate-memory-writes.mjs for the decision contract.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
node "$SCRIPT_DIR/pretooluse-gate-memory-writes.mjs"
