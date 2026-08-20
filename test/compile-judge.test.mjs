import { test, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupWorkspace, cleanup } from "./harness.mjs";

// setupWorkspace() points MEMORY_DATA_DIR at the /tmp workspace. It MUST run
// before ANY engine module is imported: env.mjs reads MEMORY_DATA_DIR into a
// load-time const (env.mjs:MEMORY_DATA_DIR), and settings.mjs / llm-parse.mjs
// import env.mjs transitively — so a STATIC import of them here would freeze the
// data dir to the real ~/.llm-wiki-memory and leak every test write (executeAction
// → writeMemory) into the developer's brain. Import all engine modules
// dynamically, below, only after the workspace env is in place.
const { dataDir } = setupWorkspace();
const { __resetMockCallIndex } = await import("../scripts/lib/llm-parse.mjs");
const { LLMProviderUnavailable } = await import("../scripts/lib/llm.mjs");
const { __setSettingsForTest, __clearSettingsForTest } =
  await import("../scripts/lib/settings.mjs");
const store = await import("../scripts/lib/wiki-store.mjs");
const { decideActionJudged, executeAction } = await import("../scripts/compile-actions.mjs");
after(() => cleanup(dataDir));

const PASS = JSON.stringify({
  pass: true,
  score: 0.9,
  checks: {
    durable: true,
    no_volatile_locators: true,
    conceptual: true,
    depersonalized: true,
    has_why_how: true,
  },
  recommendation: "",
});
function fail(score, rec) {
  return JSON.stringify({ pass: false, score, checks: {}, recommendation: rec });
}
const createDec = JSON.stringify({ action: "create", reason: "new fact" });
const skipDec = JSON.stringify({ action: "skip", reason: "duplicate" });
function updateDec(body) {
  return JSON.stringify({
    action: "update",
    supersedes: "knowledge/foo.md",
    merged_text: body,
    merged_name: "Merged Title",
  });
}

function seq(responses) {
  process.env.MEMORY_LLM_PROVIDER = "mock";
  process.env.MEMORY_LLM_MOCK_SEQUENCE = JSON.stringify(responses);
  __resetMockCallIndex();
  // The harness disables the judge for the broad suite; these tests exercise it.
  __setSettingsForTest({ quality: { judgeEnabled: true } });
}

afterEach(() => {
  delete process.env.MEMORY_LLM_PROVIDER;
  delete process.env.MEMORY_LLM_MOCK_SEQUENCE;
  __resetMockCallIndex();
  __clearSettingsForTest();
});

const durableAtom = {
  type: "decision",
  title: "Use X over Y",
  body: "Use X over Y because Z.\nWhy: Z is safer under concurrency.\nHow to apply: pick X for new code.",
  tags: ["arch"],
  metadata: { area: "infra", atom_type: "decision" },
};

// ── decideActionJudged loop (mock-driven) ─────────────────────────────────
test("decideActionJudged: create passes the judge on round 1", async () => {
  seq([createDec, PASS]);
  const { decision, flagged } = await decideActionJudged(durableAtom, [], "sys", "knowledge");
  assert.equal(decision.action, "create");
  assert.equal(flagged, false);
});

test("decideActionJudged: create failing all rounds is kept flagged", async () => {
  seq([createDec, fail(0.3, "r1"), createDec, fail(0.6, "r2"), createDec, fail(0.5, "r3")]);
  const { decision, flagged } = await decideActionJudged(durableAtom, [], "sys", "knowledge");
  assert.equal(decision.action, "create");
  assert.equal(flagged, true, "kept but flagged unverified after maxRounds");
});

test("decideActionJudged: update fail -> regenerate -> pass keeps the revised merged_text", async () => {
  seq([
    updateDec("v1 Foo.scala:1 Bar.scala:2 Baz.scala:3"),
    fail(0.4, "drop the line numbers"),
    updateDec("Durable rule. Why: x. How to apply: y."),
    PASS,
  ]);
  const { decision, flagged } = await decideActionJudged(durableAtom, [], "sys", "knowledge");
  assert.equal(decision.action, "update");
  assert.equal(flagged, false);
  assert.match(decision.merged_text, /Durable rule/, "the passing rewrite is the kept decision");
});

test("decideActionJudged: a skip decision bypasses the judge", async () => {
  seq([skipDec]);
  const { decision, flagged } = await decideActionJudged(durableAtom, [], "sys", "knowledge");
  assert.equal(decision.action, "skip");
  assert.equal(flagged, false);
});

test("decideActionJudged: a null decision passes through (not masked as a skip)", async () => {
  seq(["null"]);
  const { decision, flagged } = await decideActionJudged(durableAtom, [], "sys", "knowledge");
  assert.equal(
    decision,
    null,
    "a null LLM decision must reach processAtom's guard, not become skip",
  );
  assert.equal(flagged, false);
});

test("decideActionJudged: fail-closed when the provider is unavailable", async () => {
  process.env.MEMORY_LLM_PROVIDER = "mock";
  delete process.env.MEMORY_LLM_MOCK_SEQUENCE;
  __resetMockCallIndex();
  __setSettingsForTest({ quality: { judgeEnabled: true } });
  await assert.rejects(
    () => decideActionJudged(durableAtom, [], "sys", "knowledge"),
    (err) => err instanceof LLMProviderUnavailable,
  );
});

// ── executeAction stamps quality:unverified when flagged (real write) ─────
test("executeAction stamps memory.quality=unverified on a flagged create", async () => {
  const res = await executeAction(durableAtom, { action: "create", reason: "x" }, [], "knowledge", {
    flagged: true,
  });
  const id = res.created?.document?.id || res.created?.id;
  assert.ok(id, `expected a created id; got ${JSON.stringify(res)}`);
  const meta = store.readDocument({ documentId: id, datasetId: "knowledge" }).metadata;
  assert.equal(meta.quality, "unverified");
});

test("executeAction leaves quality unset on an unflagged create", async () => {
  const atom = { ...durableAtom, title: "Another durable decision" };
  const res = await executeAction(atom, { action: "create", reason: "x" }, [], "knowledge", {
    flagged: false,
  });
  const id = res.created?.document?.id || res.created?.id;
  const meta = store.readDocument({ documentId: id, datasetId: "knowledge" }).metadata;
  assert.equal(meta.quality, undefined);
});

test("saveLesson persists a quality:unverified flag (interactive acceptQuality path)", async () => {
  const { saveLesson } = await import("../scripts/lib/recall.mjs");
  const r = saveLesson({
    title: "Flagged behavioural lesson",
    body: "Run the tests before declaring done.\nWhy: skipped verification once.\nHow to apply: always run.",
    metadata: {
      area: "testarea",
      task_type: "implementation",
      error_pattern: "flagged-lesson",
      quality: "unverified",
    },
  });
  const id = r.created?.document?.id || r.created?.id;
  const meta = store.readDocument({ documentId: id, datasetId: "self_improvement" }).metadata;
  assert.equal(
    meta.quality,
    "unverified",
    "the accept-flag must survive saveLesson's metadata rebuild",
  );
});
