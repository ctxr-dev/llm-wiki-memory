// Regression guard for a real incident: a test that failed to isolate
// MEMORY_DATA_DIR (a static engine import froze it to the default before
// setupWorkspace ran) read AND WROTE the developer's real ~/.llm-wiki-memory,
// leaking test leaves and hard-deleting ~590 real ones. These tests pin the safety
// layers: env.mjs refuses the real brain under LWM_FORBID_REAL_BRAIN, and
// test/setup-guard.mjs (the --import preload) arms that marker + redirects an
// unset/real data dir. The real-brain path comes from the same shared derivation
// (real-brain-guard.mjs) the guard uses, so these exercise the real logic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realBrainDir, isRealBrain } from "../scripts/lib/real-brain-guard.mjs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_BRAIN = realBrainDir();
const IMPORT_ENV =
  "import('./scripts/lib/env.mjs').then(()=>process.exit(0)).catch(()=>process.exit(42))";

const importEnvStatus = (env) =>
  spawnSync(process.execPath, ["-e", IMPORT_ENV], {
    cwd: SRC,
    env: { ...process.env, ...env },
    encoding: "utf8",
  }).status;

test("env.mjs THROWS when armed and pointed at the real brain", () => {
  // NODE_TEST_CONTEXT is cleared so this pins the PRELOAD signal alone — otherwise the
  // inherited runner marker would keep it green even if that branch were deleted.
  const status = importEnvStatus({
    MEMORY_DATA_DIR: REAL_BRAIN,
    LWM_REAL_BRAIN: REAL_BRAIN,
    LWM_FORBID_REAL_BRAIN: "1",
    NODE_TEST_CONTEXT: "",
  });
  assert.equal(status, 42, "env.mjs must refuse the real brain when the guard marker is armed");
});

test("env.mjs is FAIL-CLOSED: armed at the real brain with LWM_REAL_BRAIN empty still throws", () => {
  const status = importEnvStatus({
    MEMORY_DATA_DIR: REAL_BRAIN,
    LWM_REAL_BRAIN: "",
    LWM_FORBID_REAL_BRAIN: "1",
    NODE_TEST_CONTEXT: "",
  });
  assert.equal(status, 42, "a missing LWM_REAL_BRAIN must derive the real brain, not go inert");
});

test("env.mjs LOADS for a temp data dir under the marker (no false positive)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-guard-canary-"));
  try {
    const status = importEnvStatus({
      MEMORY_DATA_DIR: tmp,
      LWM_REAL_BRAIN: REAL_BRAIN,
      LWM_FORBID_REAL_BRAIN: "1",
    });
    assert.equal(status, 0, "a temp data dir must be allowed even with the marker armed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("env.mjs LOADS at the real brain in production (no test signal — inert)", () => {
  // NODE_TEST_CONTEXT must be cleared explicitly: this process IS a test runner, so the
  // child inherits it, and inheriting it is precisely what makes the second signal work.
  const status = importEnvStatus({
    MEMORY_DATA_DIR: REAL_BRAIN,
    LWM_REAL_BRAIN: REAL_BRAIN,
    LWM_FORBID_REAL_BRAIN: "",
    NODE_TEST_CONTEXT: "",
  });
  assert.equal(status, 0, "the guard must never fire in production (no test signal)");
});

// The preload is attached by the npm scripts, so a bare `node --test test/<file>.test.mjs`
// skipped it and ran UNGUARDED. That is not hypothetical: it overwrote the real brain's
// embedding caches with lexical vectors. The runner's own marker cannot be skipped.
test("env.mjs THROWS at the real brain under NODE_TEST_CONTEXT ALONE (no preload)", () => {
  const status = importEnvStatus({
    MEMORY_DATA_DIR: REAL_BRAIN,
    LWM_REAL_BRAIN: REAL_BRAIN,
    LWM_FORBID_REAL_BRAIN: "",
    NODE_TEST_CONTEXT: "child-v8",
  });
  assert.equal(status, 42, "the node:test runner's own marker must arm the guard by itself");
});

test("NODE_TEST_CONTEXT does not fire the guard for a TEMP data dir (no false positive)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-ntc-"));
  try {
    const status = importEnvStatus({
      MEMORY_DATA_DIR: tmp,
      LWM_REAL_BRAIN: REAL_BRAIN,
      LWM_FORBID_REAL_BRAIN: "",
      NODE_TEST_CONTEXT: "child-v8",
    });
    assert.equal(status, 0, "an isolated test workspace must still load normally");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("setup-guard preload redirects an unset MEMORY_DATA_DIR off the real brain + arms the marker", () => {
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      "./test/setup-guard.mjs",
      "-e",
      "process.stdout.write(process.env.MEMORY_DATA_DIR+'|'+process.env.LWM_FORBID_REAL_BRAIN+'|'+process.env.LWM_REAL_BRAIN)",
    ],
    { cwd: SRC, env: { ...process.env, MEMORY_DATA_DIR: "" }, encoding: "utf8" },
  );
  const [dir, marker, real] = r.stdout.split("|");
  assert.equal(marker, "1", "the preload must arm LWM_FORBID_REAL_BRAIN");
  assert.equal(
    path.resolve(real),
    path.resolve(REAL_BRAIN),
    "the preload must record the clone-derived real brain in LWM_REAL_BRAIN",
  );
  assert.notEqual(
    path.resolve(dir),
    path.resolve(REAL_BRAIN),
    "must not leave the dir at the real brain",
  );
  assert.ok(dir.includes("lwm-guard"), "the preload must redirect to a throwaway temp dir");
});

test("isRealBrain: true for the real brain (realpath-normalised), false for a temp dir or empty", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-guard-unit-"));
  try {
    assert.equal(isRealBrain(REAL_BRAIN), true);
    assert.equal(isRealBrain(tmp), false);
    assert.equal(isRealBrain(""), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The bootstrap e2e copies the whole clone under os.tmpdir(), so the copy derives its OWN
// data dir as "the real brain". Under NODE_TEST_CONTEXT with no LWM_REAL_BRAIN to trust,
// the fail-closed derivation therefore SELF-MATCHED and refused the very dir the fixture
// was told to use — 5 of 6 bootstrap e2e tests failed in a bare run. A derived real brain
// under the temp dir is a fixture, never the developer's.
test("a FIXTURE install under os.tmpdir() is not mistaken for the real brain", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-fixture-"));
  try {
    const dataDir = path.join(fixture, ".llm-wiki-memory");
    fs.mkdirSync(dataDir, { recursive: true });
    const status = spawnSync(process.execPath, ["-e", IMPORT_ENV], {
      cwd: SRC,
      env: {
        ...process.env,
        MEMORY_DATA_DIR: dataDir,
        LWM_REAL_BRAIN: "",
        LWM_FORBID_REAL_BRAIN: "",
        NODE_TEST_CONTEXT: "child-v8",
      },
      encoding: "utf8",
    }).status;
    assert.equal(status, 0, "a temp-dir fixture brain must load, not be refused");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("the tmp carve-out does NOT reopen the hole for the developer's real brain", () => {
  // The carve-out is scoped to a DERIVED path under the temp dir; the real brain is not
  // there, so a bare test run pointed at it must still be refused.
  const status = importEnvStatus({
    MEMORY_DATA_DIR: REAL_BRAIN,
    LWM_REAL_BRAIN: "",
    LWM_FORBID_REAL_BRAIN: "",
    NODE_TEST_CONTEXT: "child-v8",
  });
  assert.equal(status, 42, "the real brain is still refused under the runner marker alone");
});
