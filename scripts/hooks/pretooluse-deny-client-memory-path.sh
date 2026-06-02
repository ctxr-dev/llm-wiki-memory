#!/usr/bin/env bash
# PreToolUse wrapper that denies Write/Edit/NotebookEdit targeting Claude
# Code's client-local memory directory (~/.claude/projects/.../memory/).
# See pretooluse-deny-client-memory-path.mjs for the rule.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
node "$SCRIPT_DIR/pretooluse-deny-client-memory-path.mjs"
