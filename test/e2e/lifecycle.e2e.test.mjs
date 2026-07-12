import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup, runScript } from "../harness.mjs";

// Full lifecycle against the REAL skill CLI and the REAL flush/compile/
// exit-plan-mode scripts. The LLM is stubbed via MEMORY_LLM_PROVIDER=mock so
// the suite is hermetic; embeddings use the lexical backend for speed.
const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../../scripts/lib/wiki-store.mjs");
const recall = await import("../../scripts/lib/recall.mjs");
const cli = await import("../../scripts/lib/wiki-cli.mjs");
const { embedCacheFor, wikiRoot } = await import("../../scripts/lib/env.mjs");

function writeTranscript(name, turns) {
  const file = path.join(dataDir, name);
  const lines = turns.map((t) =>
    JSON.stringify({
      type: t.role,
      message: { role: t.role, content: [{ type: "text", text: t.text }] },
    }),
  );
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

function runFlush(transcriptPath, atoms, sessionId = "e2e") {
  const hookInput = JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
    hook_event_name: "SessionEnd",
    cwd: dataDir,
  });
  // The flush hook front now spawns a DETACHED worker and returns at once, so
  // the daily leaf is written asynchronously (see waitForDailyOfSession). Clear
  // any inherited re-entry guard so the front runs; pin attempts=1 so the
  // success path needs no retry/backoff and stays fast.
  return runScript("scripts/hooks/flush.mjs", ["session-end"], {
    stdin: hookInput,
    env: {
      MEMORY_HOOK_REENTRY: "",
      CLAUDE_INVOKED_BY: "",
      MEMORY_LLM_PROVIDER: "mock",
      MEMORY_LLM_MOCK_RESPONSE: JSON.stringify({ atoms }),
      MEMORY_FLUSH_DISTILL_ATTEMPTS: "1",
    },
  });
}

function runCompile() {
  return runScript("scripts/compile.mjs", [], {
    env: {
      MEMORY_LLM_PROVIDER: "mock",
      MEMORY_LLM_MOCK_RESPONSE: JSON.stringify({ action: "create", reason: "e2e" }),
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const flushLog = path.join(dataDir, "state", ".flush.log");
function logTail() {
  try {
    return fs.readFileSync(flushLog, "utf8");
  } catch {
    return "(no .flush.log yet)";
  }
}

// The daily's session id lives in the header body, not the filename.
function findDailyForSession(sid) {
  const docs = store.listDocuments({
    prefix: "daily-",
    enabled: "true",
    datasetId: "daily",
  }).documents;
  for (const d of docs) {
    const { text } = store.readDocument({ documentId: d.id, datasetId: "daily" });
    if (text.includes(`session_id: ${sid}`)) return { id: d.id, text };
  }
  return null;
}

// Session ids used here are simple, so this mirrors flush.mjs:flushLockPath.
function flushLockPathFor(sid) {
  const safe = String(sid || "manual")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 80);
  return path.join(dataDir, "state", `.flush-${safe}.lock`);
}

// The hook front returns before the detached worker writes. Wait until the
// daily for this session exists AND the worker has released its session lock
// (released in a finally AFTER writeMemory + ensureIndexes complete), so a
// later validate/compile never races the worker's index rebuild.
async function waitForDailyOfSession(sid, timeoutMs = 20000) {
  const lock = flushLockPathFor(sid);
  const start = Date.now();
  for (;;) {
    const hit = findDailyForSession(sid);
    if (hit && !fs.existsSync(lock)) return hit;
    // Hard fail on timeout (return null): proceeding while the lock still exists
    // would let compile race the worker's index rebuild, the exact hazard this
    // guard exists to prevent.
    if (Date.now() - start > timeoutMs) return null;
    await sleep(50);
  }
}

const LESSON_ATOM = {
  type: "self-improvement-lesson",
  title: "Always await async db calls",
  body: "Always await async database calls before reading the result set.",
  tags: ["async", "database"],
  metadata: {
    project_module: "testproj",
    language: "typescript",
    task_type: "implementation",
    error_pattern: "missing-await-async",
  },
};
const DECISION_ATOM = {
  type: "decision",
  title: "Use feature flags for risky rollouts",
  body: "Use feature flags for risky rollouts. Why: limit blast radius. How to apply: wrap new endpoints.",
  tags: ["infra", "rollout"],
  metadata: { project_module: "testproj", language: "", task_type: "deploy" },
};

test("1. genesis: engine-built wiki shell, contract, validate clean", () => {
  assert.ok(fs.existsSync(path.join(wiki, "index.md")), "root index.md");
  assert.ok(fs.existsSync(path.join(wiki, ".layout", "layout.yaml")), "layout contract");
  // Genesis is engine-built (indexRebuildAll, m2/INIT-08), not the skill's
  // buildHosted, so the skill-internal .llmwiki/op-log.yaml is not a genesis
  // artifact (it appears lazily on a skill mutation). A fresh shell validates
  // without it; the engine has no dependency on the op-log.
  assert.equal(cli.validate(wiki).ok, true);
});

test("2. daily capture: flush extracts atoms into nested daily leaf", async () => {
  const t = writeTranscript("t1.jsonl", [
    { role: "user", text: "Let's use feature flags for rollout." },
    { role: "assistant", text: "Agreed; also always await async db calls." },
  ]);
  const r = runFlush(t, [DECISION_ATOM, LESSON_ATOM], "s1");
  assert.equal(r.status, 0, `flush exit 0: ${r.stderr}`);
  // The worker is detached, so wait until it has written the daily and released
  // its session lock (which means ensureIndexes has finished too).
  const hit = await waitForDailyOfSession("s1");
  assert.ok(hit, `worker wrote a daily for s1; flush.log:\n${logTail()}`);
  const dailies = store.listDocuments({
    prefix: "daily-",
    enabled: "true",
    datasetId: "daily",
  }).documents;
  assert.equal(dailies.length, 1, "one daily leaf");
  assert.match(dailies[0].id, /^daily\/\d{4}\/\d{2}\/\d{2}\/daily-/, "nested by date");
  assert.equal(cli.validate(wiki).ok, true, "validate clean after capture");
});

test("3. save_lesson lands in self_improvement (frontmatter filterable)", () => {
  const r = recall.saveLesson({
    title: "Resolve PR threads in the same push",
    body: "Resolve addressed review threads in the same push, never defer.",
    metadata: {
      project_module: "testproj",
      task_type: "review",
      error_pattern: "deferred-thread-resolve",
    },
    tags: ["pr", "review"],
  });
  assert.ok(r.created);
  assert.equal(cli.validate(wiki).ok, true);
});

test("4. save_to_dataset upserts knowledge/plans/investigations", () => {
  store.saveDocument({
    name: "knowledge-fact.md",
    text: "# Fact\n\nThe build uses Node 20.",
    datasetId: "knowledge",
    metadata: { atom_type: "project-lore", project_module: "testproj" },
  });
  store.saveDocument({
    name: "investigation-latency.md",
    text: "# Latency probe\n\nP99 spikes after deploy.",
    datasetId: "investigations",
    metadata: { atom_type: "investigation", project_module: "testproj" },
  });
  store.saveDocument({
    name: "plan-x.md",
    text: "# Plan X\n\nv1",
    datasetId: "plans",
    metadata: { atom_type: "plan" },
  });
  store.saveDocument({
    name: "plan-x.md",
    text: "# Plan X\n\nv2",
    datasetId: "plans",
    metadata: { atom_type: "plan" },
  });
  const plans = store
    .listDocuments({ datasetId: "plans", enabled: "true" })
    .documents.filter((d) => d.name === "plan-x.md");
  assert.equal(plans.length, 1, "upsert by name: no duplicate plan");
  assert.equal(cli.validate(wiki).ok, true);
});

test("4b. ExitPlanMode hook captures an approved plan into plans/", () => {
  const hookInput = JSON.stringify({
    tool_input: { plan: "# Ship the widget\n\nStep 1. Do the thing." },
    tool_response: { approved: true },
  });
  const r = runScript("scripts/hooks/exit-plan-mode.mjs", [], { stdin: hookInput });
  assert.equal(r.status, 0, `exit-plan-mode exit 0: ${r.stderr}`);
  const plans = store
    .listDocuments({ datasetId: "plans", enabled: "true" })
    .documents.map((d) => d.name);
  // Per .claude/rules/plans-lifecycle.md the captured plan leaf name is
  // `<slug>.plan.md` (compound extension preserved by normalizeLeafName);
  // the legacy `plan-<slug>.md` prefix is no longer produced.
  assert.ok(
    plans.includes("ship-the-widget.plan.md"),
    `captured plan present: ${plans.join(", ")}`,
  );
  assert.equal(cli.validate(wiki).ok, true);
});

test("5. compile promotes daily atoms into knowledge + self_improvement, archives daily", () => {
  const r = runCompile();
  assert.equal(r.status, 0, `compile exit 0: ${r.stderr}`);

  const knowledge = store
    .listDocuments({ datasetId: "knowledge", enabled: "true" })
    .documents.map((d) => d.name);
  assert.ok(
    knowledge.some((n) => n.startsWith("knowledge-")),
    `promoted knowledge present: ${knowledge.join(", ")}`,
  );

  const lessons = store
    .listDocuments({ datasetId: "self_improvement", enabled: "true" })
    .documents.map((d) => d.name);
  assert.ok(
    lessons.some((n) => n.startsWith("lesson-")),
    "promoted lesson present",
  );

  const activeDailies = store.listDocuments({
    prefix: "daily-",
    enabled: "true",
    datasetId: "daily",
  }).documents;
  assert.equal(activeDailies.length, 0, "source daily archived after promotion");
  assert.equal(cli.validate(wiki).ok, true);

  // The compile pipeline records each self_improvement promotion in the
  // gate-audit ledger (observability only; it never gates compile). The audit
  // is best-effort, so its absence must NOT fail compile — but on a healthy run
  // the promoted lesson above should have produced a compile-distilled record.
  const auditLog = path.join(dataDir, "state", ".save-gate-audit.log");
  const auditRecs = fs.existsSync(auditLog)
    ? fs
        .readFileSync(auditLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  const compileLesson = auditRecs.find(
    (a) =>
      a.layer === "compile" && a.consent === "compile-distilled" && a.target === "self_improvement",
  );
  assert.ok(compileLesson, `compile promotion is audited: ${JSON.stringify(auditRecs)}`);
  assert.equal(compileLesson.status, "accepted");
  assert.ok(["create", "update"].includes(compileLesson.action), "records a create/update action");
});

test("5b. dedup: a second daily lesson with the same error_pattern force-updates, not duplicates", async () => {
  const t = writeTranscript("t2.jsonl", [
    { role: "user", text: "Reminder about awaiting async db calls." },
    { role: "assistant", text: "Yes, always await async db calls." },
  ]);
  assert.equal(runFlush(t, [LESSON_ATOM], "s2").status, 0);
  // Wait for the detached worker to land the s2 daily before compiling, else
  // compile would run against an empty daily slot.
  assert.ok(
    await waitForDailyOfSession("s2"),
    `s2 daily present before compile; flush.log:\n${logTail()}`,
  );
  assert.equal(runCompile().status, 0);

  const activeLessons = [];
  for (const d of store.listDocuments({ datasetId: "self_improvement", enabled: "true" })
    .documents) {
    const { metadata } = store.readDocument({ documentId: d.id, datasetId: "self_improvement" });
    if (metadata.error_pattern === "missing-await-async") activeLessons.push(d.id);
  }
  assert.equal(
    activeLessons.length,
    1,
    "exactly one active lesson per error_pattern (old archived)",
  );
  assert.equal(cli.validate(wiki).ok, true);

  // The force-update is also audited with action:"update" (the compile UPDATE
  // branch of auditCompileLessonPromotion, distinct from test 5's create path).
  const auditLog = path.join(dataDir, "state", ".save-gate-audit.log");
  const updateRec = (
    fs.existsSync(auditLog)
      ? fs
          .readFileSync(auditLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : []
  ).find((a) => a.layer === "compile" && a.action === "update");
  assert.ok(updateRec, "compile records an action:update on a force-update");
  assert.equal(updateRec.consent, "compile-distilled");
});

test("6. recall surfaces the promoted lesson by project_module", async () => {
  const out = await recall.recallLessons({
    query: "await async database calls",
    project_module: "testproj",
    task_type: "implementation",
  });
  assert.ok(out.lessonHits >= 1, "recall finds a lesson");
  assert.ok(out.records.some((r) => r.documentName.startsWith("lesson-")));
});

test("7. tree stays valid as a category grows (skill nesting/index-rebuild)", () => {
  for (let i = 0; i < 30; i += 1) {
    store.saveDocument({
      name: `knowledge-bulk-${String(i).padStart(2, "0")}.md`,
      text: `# Bulk fact ${i}\n\nFact number ${i} about subsystem ${i % 5}.`,
      datasetId: "knowledge",
      metadata: { atom_type: "reference", project_module: "testproj" },
    });
  }
  const verdict = cli.heal(wiki).verdict;
  assert.notEqual(verdict, "broken", `heal verdict not broken (was ${verdict})`);
  if (verdict === "needs-rebuild") {
    cli.rebuild(wiki, { quality: "deterministic" });
  } else if (verdict === "fixable") {
    cli.run(["fix", wiki]);
  }
  assert.equal(cli.validate(wiki).ok, true, "validate clean after growth");
  const count = store
    .listDocuments({ datasetId: "knowledge", enabled: "true" })
    .documents.filter((d) => d.name.startsWith("knowledge-bulk-")).length;
  assert.equal(count, 30, "all 30 bulk leaves remain reachable");
});

test("8. integrity + idempotency: re-compile is a clean no-op; embed cache present", () => {
  const r = runCompile();
  assert.equal(r.status, 0, "re-compile exits 0 with no active dailies");
  assert.ok(
    fs.existsSync(embedCacheFor(wikiRoot(), "self_improvement")),
    "per-category embedding cache written (self_improvement, populated by the test-6 recall)",
  );
  assert.equal(cli.validate(wiki).ok, true, "final validate clean");
});
