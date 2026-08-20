#!/usr/bin/env bash
# PreToolUse wrapper: asks once per session when the wiki has not been consulted before the
# first search-or-edit. See pretooluse-recall-first.mjs for the rule.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
node "$SCRIPT_DIR/pretooluse-recall-first.mjs"
