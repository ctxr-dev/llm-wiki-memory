// GAP3 (partial): codify the two bootstrap.sh arg-parsing idioms that were real
// regression sources under macOS bash 3.2 + `set -euo pipefail` — the value-flag
// guard and the empty-array re-exec expansion. The full --upgrade fetch/merge/re-exec
// sequence is shell + git + network environmental (C14: re-exec would npm-install the
// real src) and is intentionally NOT driven here; these isolated idiom checks + `bash -n`
// are its automated coverage. The idioms are copied verbatim from bootstrap.sh.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

/** @param {string} script @param {string[]} [args] */
function bash(script, args = []) {
  return spawnSync("bash", ["-c", script, "bash", ...args], { encoding: "utf8" });
}

const GUARD =
  'set -euo pipefail\n[[ $# -ge 2 && "${2:-}" != --* ]] || { echo "--flag requires a value" >&2; exit 1; }\necho OK';

test("value-flag guard: a missing value → clear error + exit 1 (not a silent set -u/shift abort)", () => {
  const r = bash(GUARD, ["--flag"]);
  assert.equal(r.status, 1, "exits 1");
  assert.match(r.stderr, /requires a value/, "prints a clear, flag-named message");
  assert.doesNotMatch(r.stdout, /OK/, "never falls through to bind a bogus value");
});

test("value-flag guard: a flag-shaped next token (--other) is rejected, not swallowed as the value", () => {
  const r = bash(GUARD, ["--flag", "--other"]);
  assert.equal(r.status, 1, "a ---prefixed token is not accepted as the value");
  assert.match(r.stderr, /requires a value/);
});

test("value-flag guard: a real value passes", () => {
  const r = bash(GUARD, ["--flag", "myvalue"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK/);
});

const REEXEC =
  'set -euo pipefail\nREEXEC_ARGS=()\n[ "$1" = fill ] && REEXEC_ARGS=("--template" "my layout" "--provider" "claude")\nset -- --migrate ${REEXEC_ARGS[@]+"${REEXEC_ARGS[@]}"}\necho "COUNT=$#"\nfor a in "$@"; do echo "ARG=[$a]"; done';

test("re-exec idiom: an EMPTY REEXEC_ARGS expands to just --migrate under set -u (no unbound error)", () => {
  const r = bash(REEXEC, ["empty"]);
  assert.equal(r.status, 0, `no unbound-variable abort: ${r.stderr}`);
  assert.match(r.stdout, /COUNT=1/, "only --migrate");
  assert.match(r.stdout, /ARG=\[--migrate\]/);
});

test("re-exec idiom: a populated REEXEC_ARGS replays every flag, preserving a space-containing value as ONE arg", () => {
  const r = bash(REEXEC, ["fill"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /COUNT=5/, "--migrate + 4 replayed tokens");
  assert.match(r.stdout, /ARG=\[my layout\]/, "the space-containing element stays a single arg");
});
