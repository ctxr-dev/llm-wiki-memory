// Test-run safety preload. Wired via `node --test --import ./test/setup-guard.mjs`
// so it executes ONCE per test process BEFORE any test module — and therefore
// before env.mjs captures MEMORY_DATA_DIR into its load-time const.
//
// Guarantees no test can read or write the developer's REAL brain: it records the
// real brain path (from real-brain-guard.mjs, derived the same way env.mjs derives
// its default — HOME-independent), arms LWM_FORBID_REAL_BRAIN, and — if
// MEMORY_DATA_DIR is unset or aliases that real brain — redirects it to a throwaway
// temp dir. env.mjs then THROWS if any engine module (here OR in a child spawned
// with the inherited env) still resolves to the real brain, so the mistake is a loud
// crash rather than silent corruption. A /tmp fixture install (bootstrap e2e) keeps
// working. A correct test overrides MEMORY_DATA_DIR again via setupWorkspace().
//
// NOTE: this preload is wired into the `test` / `test:e2e` / `test:llm-live` npm
// scripts. Running a single file directly (`node --test test/foo.test.mjs`) skips it
// and therefore falls back to the weaker NODE_TEST_CONTEXT signal that env.mjs also honours
// (absent under --experimental-test-isolation=none) — always run tests via `npm test` /
// `npm run test:e2e`, and pass --import explicitly when iterating on one file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realBrainDir, isRealBrain } from "../scripts/lib/real-brain-guard.mjs";

const cur = process.env.MEMORY_DATA_DIR;
if (!cur || cur === "" || isRealBrain(cur)) {
  process.env.MEMORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-guard-"));
}
process.env.LWM_REAL_BRAIN = realBrainDir();
process.env.LWM_FORBID_REAL_BRAIN = "1";
