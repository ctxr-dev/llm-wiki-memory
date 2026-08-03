# Skill: run the test suite safely

1. Pre-flight: `df -h /tmp`, then sweep stale workspaces: `rm -rf /tmp/lwm-*`. Killed or
   crashed runs strand them (cleanup hooks never fire), and accumulation has filled the
   disk to ENOSPC before.
2. While iterating, run only the file you're changing — ALWAYS with the guard preload:
   `node --import ./test/setup-guard.mjs --test test/<file>.test.mjs`. The preload is what
   points `MEMORY_DATA_DIR` away from the developer's REAL brain and arms
   `LWM_FORBID_REAL_BRAIN` so `env.mjs` throws if anything still resolves there; a bare
   `node --test test/<file>.test.mjs` skips it. A second signal (`NODE_TEST_CONTEXT`, set by
   the runner itself) still refuses the real brain, but it is absent under
   `--experimental-test-isolation=none` — do not rely on it. For a
   parse-only gate (no execution, no workspace): `node --check <file>`.
3. Full suite: `npm test` (~70 s; the current test count lives in the README badge — keep
   counts out of this file so it can't rot). Run it once per change-set — never in a loop,
   never repeatedly "to be sure".
4. Read results from the summary lines (`ℹ tests` / `ℹ pass` / `ℹ fail`); failures print
   `✖` blocks with file:line.
5. After ANY crashed or killed run, sweep `/tmp/lwm-*` again before the next one.
6. On ENOSPC: free `/tmp` first (`du -sh /tmp/lwm-* | sort -h | tail`, then remove). The
   failing write path in the error is usually a red herring — do not blindly re-run.
