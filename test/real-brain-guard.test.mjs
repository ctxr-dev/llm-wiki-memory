// Regression guard for a real incident: a test that failed to isolate
// MEMORY_DATA_DIR (a static engine import froze it to the default before
// setupWorkspace ran) read AND WROTE the developer's real ~/.llm-wiki-memory,
// leaking test leaves and hard-deleting ~590 real ones. These tests pin the two
// safety layers that make that impossible: env.mjs refuses the real brain under
// the LWM_FORBID_REAL_BRAIN marker, and test/setup-guard.mjs (the --import
// preload) arms that marker + redirects an unset/real data dir to a temp dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_BRAIN = path.join(os.homedir(), ".llm-wiki-memory");
const IMPORT_ENV =
  "import('./scripts/lib/env.mjs').then(()=>process.exit(0)).catch(()=>process.exit(42))";

test("env.mjs THROWS when armed and pointed at the real brain", () => {
  const r = spawnSync(process.execPath, ["-e", IMPORT_ENV], {
    cwd: SRC,
    env: {
      ...process.env,
      MEMORY_DATA_DIR: REAL_BRAIN,
      LWM_REAL_BRAIN: REAL_BRAIN,
      LWM_FORBID_REAL_BRAIN: "1",
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 42, "env.mjs must refuse the real brain when the guard marker is armed");
});

test("env.mjs LOADS for a temp data dir under the marker (no false positive)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-guard-canary-"));
  try {
    const r = spawnSync(process.execPath, ["-e", IMPORT_ENV], {
      cwd: SRC,
      env: {
        ...process.env,
        MEMORY_DATA_DIR: tmp,
        LWM_REAL_BRAIN: REAL_BRAIN,
        LWM_FORBID_REAL_BRAIN: "1",
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, "a temp data dir must be allowed even with the marker armed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("env.mjs LOADS at the real brain in production (marker unset — inert)", () => {
  const r = spawnSync(process.execPath, ["-e", IMPORT_ENV], {
    cwd: SRC,
    env: {
      ...process.env,
      MEMORY_DATA_DIR: REAL_BRAIN,
      LWM_REAL_BRAIN: REAL_BRAIN,
      LWM_FORBID_REAL_BRAIN: "",
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, "the guard must never fire in production (marker unset)");
});

test("setup-guard preload redirects an unset MEMORY_DATA_DIR off the real brain + arms the marker", () => {
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      "./test/setup-guard.mjs",
      "-e",
      "process.stdout.write(process.env.MEMORY_DATA_DIR + '|' + process.env.LWM_FORBID_REAL_BRAIN)",
    ],
    { cwd: SRC, env: { ...process.env, MEMORY_DATA_DIR: "" }, encoding: "utf8" },
  );
  const [dir, marker] = r.stdout.split("|");
  assert.equal(marker, "1", "the preload must arm LWM_FORBID_REAL_BRAIN");
  assert.notEqual(
    path.resolve(dir),
    REAL_BRAIN,
    "the preload must not leave the dir at the real brain",
  );
  assert.ok(dir.includes("lwm-guard"), "the preload must redirect to a throwaway temp dir");
});
