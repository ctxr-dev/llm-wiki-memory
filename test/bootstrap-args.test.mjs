// GAP3 (partial): codify the two bootstrap.sh arg-parsing idioms that were real
// regression sources under macOS bash 3.2 + `set -euo pipefail` — the value-flag
// guard and the empty-array re-exec expansion. The full --upgrade fetch/merge/re-exec
// sequence is shell + git + network environmental (C14: re-exec would npm-install the
// real src) and is intentionally NOT driven here; these isolated idiom checks + `bash -n`
// are its automated coverage. The idioms are copied verbatim from bootstrap.sh.

import { test } from "./skip-windows.mjs";
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

// #3b: `--schedule hourly` is the canonical name; `daily` is a deprecated alias
// that installs the SAME hourly job; `off` removes; an unknown value warns and
// does NOT touch the schedule. The case block is copied VERBATIM from bootstrap.sh
// with schedule_job/log stubbed so the routing is testable without a real install.
const SCHEDULE_CASE = `set -euo pipefail
schedule_job() { echo "SCHEDULE_JOB:$1"; }
log() { echo "LOG:$*"; }
SCHEDULE="\${1:-}"
case "$SCHEDULE" in
  "") : ;;
  hourly | daily) schedule_job "$SCHEDULE" ;;
  off) schedule_job off ;;
  *) log "WARNING: unknown --schedule value '$SCHEDULE' (expected hourly|off; 'daily' is a deprecated alias for hourly); skipping." ;;
esac`;

test("--schedule hourly (canonical) routes to schedule_job", () => {
  const r = bash(SCHEDULE_CASE, ["hourly"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SCHEDULE_JOB:hourly/, "hourly installs the job");
});

test("--schedule daily (deprecated alias) installs the SAME hourly job", () => {
  const r = bash(SCHEDULE_CASE, ["daily"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SCHEDULE_JOB:daily/, "the alias still routes to install");
});

test("--schedule off removes the job", () => {
  const r = bash(SCHEDULE_CASE, ["off"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SCHEDULE_JOB:off/);
});

test("--schedule <unknown> warns (naming hourly + the daily alias) and never touches the schedule", () => {
  const r = bash(SCHEDULE_CASE, ["weekly"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /deprecated alias for hourly/,
    "warning names hourly as canonical + daily as alias",
  );
  assert.doesNotMatch(r.stdout, /SCHEDULE_JOB/, "no install/remove on an unknown value");
});

test("--schedule (empty, flag omitted) is a clean no-op", () => {
  const r = bash(SCHEDULE_CASE, [""]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /SCHEDULE_JOB|LOG/, "empty leaves the schedule alone");
});
