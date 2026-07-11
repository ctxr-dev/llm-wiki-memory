import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

const { consolidateMemory, _internals } = await import("../scripts/consolidate.mjs");
const { resolveAllowedPasses, pickKeeper, lessonKey } = _internals;

test("resolveAllowedPasses: 'all' → every pass enabled", () => {
  const s = resolveAllowedPasses("all");
  assert.ok(s.has("dedupe-by-sha256"));
  assert.ok(s.has("compress-archived"));
  assert.ok(s.has("index-rebuild"));
});

test("resolveAllowedPasses: CSV → only listed passes", () => {
  const s = resolveAllowedPasses("dedupe-by-sha256,staleness-flag");
  assert.equal(s.size, 2);
  assert.ok(s.has("dedupe-by-sha256"));
  assert.ok(s.has("staleness-flag"));
  assert.ok(!s.has("dedupe-by-cosine"));
});

test("resolveAllowedPasses: array form also accepted", () => {
  const s = resolveAllowedPasses(["dedupe-by-sha256"]);
  assert.equal(s.size, 1);
  assert.ok(s.has("dedupe-by-sha256"));
});

test("pickKeeper: newer 'updated' wins", () => {
  const a = { documentId: "a/1.md", frontmatter: { updated: "2026-01-01" } };
  const b = { documentId: "a/2.md", frontmatter: { updated: "2026-02-01" } };
  assert.equal(pickKeeper(a, b).documentId, "a/2.md");
});

test("pickKeeper: tied 'updated' → lex-ascending id wins", () => {
  const a = { documentId: "a/zzz.md", frontmatter: { updated: "2026-01-01" } };
  const b = { documentId: "a/aaa.md", frontmatter: { updated: "2026-01-01" } };
  assert.equal(pickKeeper(a, b).documentId, "a/aaa.md");
});

test("lessonKey: composite of project_module|area|task_type|error_pattern", () => {
  const leaf = {
    memory: {
      project_module: "Acme",
      area: "Auth",
      task_type: "debugging",
      error_pattern: "wrong-Header",
    },
  };
  // All lowercased + composed.
  assert.equal(lessonKey(leaf), "acme|auth|debugging|wrong-header");
});

test("lessonKey: empty error_pattern → empty sentinel", () => {
  const leaf = { memory: { project_module: "x", area: "y", task_type: "z", error_pattern: "" } };
  assert.equal(lessonKey(leaf), "");
});

test("consolidateMemory: dry-run on an empty wiki returns ok with zero totals", async () => {
  const r = await consolidateMemory({
    dryRun: true,
    llm: false,
    now: new Date("2026-06-02T12:00:00Z"),
  });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.workingSetSize, 0);
  assert.equal(r.totals.archived, 0);
  assert.equal(r.totals.touched, 0);
});

test("consolidateMemory: dry-run does NOT write state file", async () => {
  // After the dry-run above, .consolidate.json must NOT exist.
  const stateFile = path.join(dataDir, "state", ".consolidate.json");
  assert.equal(fs.existsSync(stateFile), false);
});

test("consolidateMemory: live run on empty wiki writes state with last_run_utc", async () => {
  const r = await consolidateMemory({
    dryRun: false,
    llm: false,
    now: new Date("2026-06-02T12:00:00Z"),
  });
  assert.equal(r.ok, true);
  const stateFile = path.join(dataDir, "state", ".consolidate.json");
  assert.ok(fs.existsSync(stateFile), "state file should exist after a live run");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.last_run_utc, "2026-06-02T12:00:00.000Z");
});

test("consolidateMemory: ifDue=true re-runs are throttled by the cadence", async () => {
  // Previous test wrote state for 2026-06-02. A run with `now` 30 min later
  // (well inside the 1-day default cadence) MUST report skipped:'not-due'.
  const r = await consolidateMemory({
    ifDue: true,
    llm: false,
    now: new Date("2026-06-02T12:30:00Z"),
  });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, "not-due");
});

test("consolidateMemory: ifDue=true after the cadence elapses runs again", async () => {
  // Two days later, the throttle is past; the call must proceed.
  const r = await consolidateMemory({
    ifDue: true,
    llm: false,
    now: new Date("2026-06-04T12:00:00Z"),
  });
  assert.equal(r.ok, true);
  assert.notEqual(r.skipped, "not-due");
});
