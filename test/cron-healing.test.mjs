import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup, runScript } from "./harness.mjs";

// Entity-level self-healing: per-entity attempt history, escalation rules,
// deterministic skeleton issue reports (episode-versioned, redacted), and the
// sharded full-log retention. Drives the exported cron-job helpers directly —
// deterministic, no LLM, no subprocesses except the consolidate e2e at the end.

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

process.env.MEMORY_LLM_PROVIDER = "mock";

const cron = await import("../scripts/cron-job.mjs");
const { normalizeErrorSignature } = await import("../scripts/lib/error-signature.mjs");
const { dailyDatePath } = await import("../scripts/lib/slug.mjs");
const store = await import("../scripts/lib/wiki-store.mjs");
const { consolidateMemory } = await import("../scripts/consolidate.mjs");

const ENTITIES_PATH = path.join(dataDir, "state", ".consolidate-entities.json");
const ISSUES_DIR = path.join(dataDir, "issues");
const ISSUES_INDEX = path.join(dataDir, "state", ".issues-index.json");
const LOGS_DIR = path.join(dataDir, "state", "logs");

function failureReport(id, excerpt, { pass = "llm-merge-near-duplicates", kind = "dedup-pair" } = {}) {
  return {
    passes: {
      [pass]: {
        name: pass,
        entities: [],
        failures: [{ id, kind, action: "merge", ok: false, excerpt }],
      },
    },
  };
}

function successReport(id, { pass = "llm-merge-near-duplicates", kind = "dedup-pair" } = {}) {
  return {
    passes: {
      [pass]: {
        name: pass,
        entities: [{ id, kind, action: "merge", ok: true }],
        failures: [],
      },
    },
  };
}

// ---- error signatures ----

test("normalizeErrorSignature strips volatile tokens to a stable slug", () => {
  const a = normalizeErrorSignature("merge-write failed: EACCES /tmp/x/knowledge/auth/leaf-123.md at 2026-06-04T10:00:00Z", { pass: "p", kind: "k" });
  const b = normalizeErrorSignature("merge-write failed: EACCES /var/y/knowledge/db/other-999.md at 2026-06-05T22:11:33Z", { pass: "p", kind: "k" });
  assert.equal(a, b, "ids/paths/timestamps must not split one bug into two signatures");
  assert.match(a, /eacces/, "the error class survives normalization");
});

test("normalizeErrorSignature keeps different passes apart and never emits an empty slug", () => {
  const a = normalizeErrorSignature("boom 42", { pass: "pass-a", kind: "leaf" });
  const b = normalizeErrorSignature("boom 42", { pass: "pass-b", kind: "leaf" });
  assert.notEqual(a, b, "same message under different passes must not collapse");
  assert.equal(normalizeErrorSignature("", {}), "unknown-error");
  assert.equal(normalizeErrorSignature("12345 67890", {}).length > 0, true);
});

test("normalizeErrorSignature redacts secrets before slugging", () => {
  // Letters outside [0-9a-f] so the hex/number volatile-token strips can NOT
  // mask a redaction failure — only redact()'s ghp_ rule removes this token.
  const secret = "ghp_" + "WXYZwxyzQRSTqrst".repeat(2);
  const sig = normalizeErrorSignature(`provider rejected ${secret}`, { pass: "p", kind: "k" });
  assert.ok(!sig.includes("wxyz"), "secret material must not leak into the signature");
  assert.ok(sig.includes("redacted"), "the redaction sentinel survives into the slug");
});

// ---- entity state lifecycle ----

test("entity state: failures increment a capped history; success deletes; absence leaves untouched", () => {
  const state = { version: 1, entities: {} };
  const opts = { ts: "2026-06-04T10:00:00.000Z", logPath: "state/logs/2026/06/cron-1.json", escalateAfter: 3 };
  for (let i = 0; i < 7; i++) {
    cron.updateEntityState(state, failureReport("pair:a.md|b.md", "merge-write failed: EACCES"), opts);
  }
  const ent = state.entities["pair:a.md|b.md"];
  assert.equal(ent.consecutiveFailures, 7);
  assert.equal(ent.history.length, 5, "history capped at max(escalateAfter+2, 5)");
  assert.deepEqual(ent.ids, ["a.md", "b.md"], "pair ids split for fan-out detection");

  // A run where the entity is absent entirely (not attempted) must not reset the streak.
  cron.updateEntityState(state, { passes: {} }, opts);
  assert.equal(state.entities["pair:a.md|b.md"].consecutiveFailures, 7);

  // Explicit success resolves: the key is deleted.
  cron.updateEntityState(state, successReport("pair:a.md|b.md"), opts);
  assert.equal(state.entities["pair:a.md|b.md"], undefined);
});

test("entity state: a failure recorded in the same run beats a success entry", () => {
  const state = { version: 1, entities: {} };
  const report = {
    passes: {
      "llm-merge-near-duplicates": {
        entities: [{ id: "pair:x.md|y.md", kind: "dedup-pair", action: "flag", ok: true }],
        failures: [{ id: "pair:x.md|y.md", kind: "dedup-pair", action: "archive", ok: false, excerpt: "archive failed: EPERM" }],
      },
    },
  };
  cron.updateEntityState(state, report, { ts: "2026-06-04T10:00:00.000Z", logPath: "l", escalateAfter: 3 });
  assert.equal(state.entities["pair:x.md|y.md"]?.consecutiveFailures, 1, "flag success must not mask the archive failure");
});

test("entity state: corrupt file tolerated (rebuilt empty, no throw)", () => {
  fs.mkdirSync(path.dirname(ENTITIES_PATH), { recursive: true });
  fs.writeFileSync(ENTITIES_PATH, "{definitely not json");
  const state = cron.readEntityState();
  assert.deepEqual(state.entities, {});
  fs.rmSync(ENTITIES_PATH, { force: true });
});

// ---- escalation rules ----

test("escalation fires after N consecutive pending failures, not before", () => {
  const state = { version: 1, entities: {} };
  const opts = { ts: "2026-06-04T10:00:00.000Z", logPath: "state/logs/2026/06/cron-2.json", escalateAfter: 3 };
  cron.updateEntityState(state, failureReport("pair:p.md|q.md", "merge failed: LLMOutputInvalid schema"), opts);
  cron.updateEntityState(state, failureReport("pair:p.md|q.md", "merge failed: LLMOutputInvalid schema"), opts);
  assert.equal(cron.evaluateEscalations(state, { escalateAfter: 3 }).length, 0, "2 < N: silent");
  cron.updateEntityState(state, failureReport("pair:p.md|q.md", "merge failed: LLMOutputInvalid schema"), opts);
  const esc = cron.evaluateEscalations(state, { escalateAfter: 3 });
  assert.equal(esc.length, 1);
  assert.equal(esc[0].reason, "pending-consecutive");
  assert.equal(esc[0].attempts, 3);
  // Resolution before the next threshold clears everything.
  cron.updateEntityState(state, successReport("pair:p.md|q.md"), opts);
  assert.equal(cron.evaluateEscalations(state, { escalateAfter: 3 }).length, 0, "resolved → silent");
});

test("one signature across >=3 distinct entities escalates as recurring-bug even below N", () => {
  const state = { version: 1, entities: {} };
  const opts = { ts: "2026-06-04T10:00:00.000Z", logPath: "state/logs/2026/06/cron-3.json", escalateAfter: 3 };
  for (const leaf of ["leaf:one.md", "leaf:two.md", "leaf:three.md"]) {
    cron.updateEntityState(state, failureReport(leaf, "refresh failed: TypeError cannot read x", { pass: "llm-semantic-refresh", kind: "leaf" }), opts);
  }
  const esc = cron.evaluateEscalations(state, { escalateAfter: 3 });
  assert.equal(esc.length, 1);
  assert.equal(esc[0].reason, "recurring-bug");
  assert.equal(esc[0].entityCount, 3);
});

// ---- issue reports ----

test("issue lifecycle: skeleton v1 under yyyy/mm/dd, occurrences append, resolve flips in place, recurrence becomes v2", () => {
  const now = new Date("2026-06-04T12:00:00.000Z");
  const state = { version: 1, entities: {} };
  const opts = { ts: now.toISOString(), logPath: "state/logs/2026/06/cron-4.json", escalateAfter: 2 };
  cron.updateEntityState(state, failureReport("pair:k.md|l.md", "archive failed: EROFS read-only filesystem"), opts);
  cron.updateEntityState(state, failureReport("pair:k.md|l.md", "archive failed: EROFS read-only filesystem"), opts);
  const esc = cron.evaluateEscalations(state, { escalateAfter: 2 });
  assert.equal(esc.length, 1);
  const sig = esc[0].signature;

  // v1 skeleton.
  cron.writeIssueReports(esc, state, now);
  const v1 = path.join(ISSUES_DIR, dailyDatePath(now), `${sig}.1.md`);
  assert.ok(fs.existsSync(v1), `v1 report at ${v1}`);
  let body = fs.readFileSync(v1, "utf8");
  assert.match(body, /^status: open$/m);
  assert.match(body, /^version: 1$/m);
  // Pair entities are reported as their constituent leaf ids (fan-out unit).
  assert.match(body, /^- k\.md$/m);
  assert.match(body, /^- l\.md$/m);
  assert.match(body, /state\/logs\/2026\/06\/cron-4\.json/);

  // Second occurrence appends to the SAME open episode (no new file).
  cron.writeIssueReports(esc, state, now);
  body = fs.readFileSync(v1, "utf8");
  assert.equal(body.match(/^- 2026-06-04T12:00:00\.000Z — attempts=/gm)?.length, 2, "occurrence appended");
  assert.equal(fs.existsSync(path.join(ISSUES_DIR, dailyDatePath(now), `${sig}.2.md`)), false);

  // Resolution: entity gone → status flips in place; file kept.
  cron.updateEntityState(state, successReport("pair:k.md|l.md"), opts);
  cron.writeIssueReports([], state, now);
  body = fs.readFileSync(v1, "utf8");
  assert.match(body, /^status: resolved$/m);
  assert.match(body, /^resolvedAt: /m);

  // Recurrence after resolution → version 2 under the (new) day.
  const later = new Date("2026-07-01T09:00:00.000Z");
  const opts2 = { ts: later.toISOString(), logPath: "state/logs/2026/07/cron-5.json", escalateAfter: 2 };
  cron.updateEntityState(state, failureReport("pair:k.md|l.md", "archive failed: EROFS read-only filesystem"), opts2);
  cron.updateEntityState(state, failureReport("pair:k.md|l.md", "archive failed: EROFS read-only filesystem"), opts2);
  const esc2 = cron.evaluateEscalations(state, { escalateAfter: 2 });
  cron.writeIssueReports(esc2, state, later);
  const v2 = path.join(ISSUES_DIR, dailyDatePath(later), `${sig}.2.md`);
  assert.ok(fs.existsSync(v2), "recurrence starts a new versioned episode");
  assert.match(fs.readFileSync(v1, "utf8"), /^status: resolved$/m, "v1 stays resolved");
  assert.match(fs.readFileSync(v2, "utf8"), /^status: open$/m);

  // Clean up for the following tests.
  cron.updateEntityState(state, successReport("pair:k.md|l.md"), opts2);
  cron.writeIssueReports([], state, later);
});

test("issue reports never carry secrets: the whole document is redacted", () => {
  const now = new Date("2026-06-04T13:00:00.000Z");
  const state = { version: 1, entities: {} };
  const secret = "sk-" + "z".repeat(24);
  const opts = { ts: now.toISOString(), logPath: "state/logs/2026/06/cron-6.json", escalateAfter: 1 };
  cron.updateEntityState(state, failureReport("leaf:secret.md", `provider rejected token ${secret} for db postgres://svc:hunter2pass@db.host/x`, { pass: "llm-semantic-refresh", kind: "leaf" }), opts);
  const esc = cron.evaluateEscalations(state, { escalateAfter: 1 });
  cron.writeIssueReports(esc, state, now);
  const rec = cron.readIssuesIndex().signatures[esc[0].signature];
  const body = fs.readFileSync(path.join(dataDir, rec.path), "utf8");
  assert.ok(!body.includes(secret), "API key scrubbed");
  assert.ok(!body.includes("hunter2pass"), "DB password scrubbed");
  assert.match(body, /\[REDACTED\]/);
  cron.updateEntityState(state, successReport("leaf:secret.md", { pass: "llm-semantic-refresh", kind: "leaf" }), opts);
  cron.writeIssueReports([], state, now);
});

test("corrupt issues index is rebuilt from the issues/ tree (dedupe + status survive)", () => {
  // Self-seed: this test must not depend on reports left behind by siblings.
  const now = new Date("2026-06-04T14:00:00.000Z");
  const state = { version: 1, entities: {} };
  const opts = { ts: now.toISOString(), logPath: "state/logs/2026/06/cron-7.json", escalateAfter: 1 };
  cron.updateEntityState(state, failureReport("leaf:rebuild-seed.md", "seed failure: EIO io error", { pass: "llm-semantic-refresh", kind: "leaf" }), opts);
  const esc = cron.evaluateEscalations(state, { escalateAfter: 1 });
  cron.writeIssueReports(esc, state, now);
  const sig = esc[0].signature;

  fs.writeFileSync(ISSUES_INDEX, "%%% corrupt %%%");
  const rebuilt = cron.readIssuesIndex();
  assert.ok(rebuilt.signatures[sig], "seeded signature recovered from the frontmatter scan");
  assert.ok(rebuilt.signatures[sig].version >= 1);

  cron.updateEntityState(state, successReport("leaf:rebuild-seed.md", { pass: "llm-semantic-refresh", kind: "leaf" }), opts);
  cron.writeIssueReports([], state, now);
});

test("cron-health + session-start surface an open escalation within budget (no failed attempt needed)", () => {
  const now = new Date("2026-06-04T16:00:00.000Z");
  const state = { version: 1, entities: {} };
  const longMsg = `${"extremely long failure description that keeps going ".repeat(6)} EBUSY resource busy`;
  const opts = { ts: now.toISOString(), logPath: "state/logs/2026/06/cron-8.json", escalateAfter: 1 };
  cron.updateEntityState(state, failureReport("leaf:long-sig.md", longMsg, { pass: "llm-semantic-refresh", kind: "leaf" }), opts);
  const esc = cron.evaluateEscalations(state, { escalateAfter: 1 });
  cron.writeIssueReports(esc, state, now);
  try {
    const h = cron.cronHealth({ limit: 0 });
    assert.equal(h.healthy, false, "open escalation drives healthy=false even with no failed attempt");
    assert.ok(h.summary.length <= 200, `summary stays ≤200 chars (got ${h.summary.length})`);
    assert.ok(h.escalations.length >= 1);

    const r = runScript("scripts/hooks/session-start.mjs", [], { stdin: "{}" });
    assert.equal(r.status, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    const idx = ctx.indexOf("## Memory cron health");
    assert.notEqual(idx, -1, "cron section surfaced on escalation");
    const section = ctx.slice(idx);
    assert.ok(section.length < 1024, `cron section stays under 1KB (got ${section.length})`);
    assert.match(section, /escalation/i);
    assert.ok(!section.includes("```json"), "no JSON dumps in the hook context");
  } finally {
    cron.updateEntityState(state, successReport("leaf:long-sig.md", { pass: "llm-semantic-refresh", kind: "leaf" }), opts);
    cron.writeIssueReports([], state, now);
  }
});

// ---- sharded full logs ----

test("fullLogPathFor shards by yyyy/mm with a parseable epoch filename", () => {
  const d = new Date("2026-06-04T10:20:30.000Z");
  const p = cron.fullLogPathFor(d);
  assert.ok(p.startsWith(path.join(LOGS_DIR, "2026", "06") + path.sep));
  assert.match(path.basename(p), /^cron-\d+\.json$/);
});

test("pruneFullLogs removes only filename-aged logs and prunes emptied shard dirs", () => {
  const oldDir = path.join(LOGS_DIR, "2020", "01");
  fs.mkdirSync(oldDir, { recursive: true });
  const oldLog = path.join(oldDir, "cron-1577836800000.json"); // 2020-01-01
  fs.writeFileSync(oldLog, "{}");
  const fresh = cron.fullLogPathFor(new Date());
  fs.mkdirSync(path.dirname(fresh), { recursive: true });
  fs.writeFileSync(fresh, "{}");
  // mtime must NOT matter: make the old file look freshly touched.
  fs.utimesSync(oldLog, new Date(), new Date());

  const { removed } = cron.pruneFullLogs(new Date(), 90);
  assert.ok(removed >= 1);
  assert.equal(fs.existsSync(oldLog), false, "old log removed by filename age");
  assert.equal(fs.existsSync(oldDir), false, "emptied month dir pruned");
  assert.equal(fs.existsSync(path.join(LOGS_DIR, "2020")), false, "emptied year dir pruned");
  assert.ok(fs.existsSync(fresh), "fresh log kept");
});

// ---- consolidate end-to-end: per-entity arrays on the real orchestrator ----

test("consolidate surfaces per-entity arrays for a real sha256 dedup (counts unchanged)", async () => {
  const body = "# Dup body\n\nidentical bytes in two leaves; sha256 dedup must flag and archive the pair.";
  const meta = { area: "healing", atom_type: "pattern-gotcha", task_type: "debugging" };
  store.saveDocument({ name: "healing-dup-a-2026-06-04-000000001.md", text: body, datasetId: "knowledge", metadata: meta });
  store.saveDocument({ name: "healing-dup-b-2026-06-04-000000002.md", text: body, datasetId: "knowledge", metadata: meta });

  const out = await consolidateMemory({ dryRun: false, llm: false, passes: "dedupe-by-sha256", now: new Date("2026-06-04T15:00:00.000Z") });
  assert.equal(out.ok, true);
  const pass = out.passes["dedupe-by-sha256"];
  assert.equal(typeof pass.flagged, "number", "counts shape intact");
  assert.ok(Array.isArray(pass.entities) && Array.isArray(pass.failures), "arrays present");
  const flag = pass.entities.find((e) => e.action === "flag" && e.kind === "dedup-pair");
  const archive = pass.entities.find((e) => e.action === "archive" && e.kind === "dedup-pair");
  assert.ok(flag, `flag entity recorded: ${JSON.stringify(pass.entities)}`);
  assert.ok(archive, "archive entity recorded");
  assert.equal(pass.failures.length, 0);
  // The slim state file must stay counts-only.
  const stateFile = JSON.parse(fs.readFileSync(path.join(dataDir, "state", ".consolidate.json"), "utf8"));
  assert.equal(stateFile.passes["dedupe-by-sha256"].entities, undefined, ".consolidate.json strips entity arrays");
});

// ---- synthetic provider entities (compile exit 69 / consolidate llm-skip) ----

const ENOENT_ABORT =
  "compile.mjs: aborting (LLMProviderUnavailable): all providers exhausted (claude:(default), codex:(default), cursor:(default)); last: cursor: cursor-agent failed to start: spawn cursor-agent ENOENT";
const TIMEOUT_ABORT =
  "compile.mjs: aborting (LLMProviderUnavailable): all providers exhausted (claude:(default)); last: claude: claude timed out after 120000ms";

const SYNTH_COMPILE_ID = "system:compile-llm-providers";
const SYNTH_CONSOLIDATE_ID = "system:consolidate-llm-providers";

function wipeHealingState() {
  fs.rmSync(ENTITIES_PATH, { force: true });
  fs.rmSync(ISSUES_INDEX, { force: true });
  fs.rmSync(ISSUES_DIR, { recursive: true, force: true });
}

test("synthesizeProviderEntities: exit 69 -> compile failure pass with the abort excerpt", () => {
  const passes = cron.synthesizeProviderEntities({ compileExit: 69, compileOk: false, compileError: ENOENT_ABORT });
  const p = passes["compile-promote"];
  assert.ok(p, "compile-promote pass present");
  assert.equal(p.entities.length, 0);
  assert.equal(p.failures.length, 1);
  assert.equal(p.failures[0].id, SYNTH_COMPILE_ID);
  assert.equal(p.failures[0].kind, "system-provider");
  assert.match(p.failures[0].excerpt, /LLMProviderUnavailable/);
  assert.equal(passes["consolidate-llm"], undefined, "no consolidate pass without a report");
});

test("synthesizeProviderEntities: exit 69 with empty error falls back to a stable excerpt", () => {
  const passes = cron.synthesizeProviderEntities({ compileExit: 69, compileOk: false, compileError: "" });
  assert.match(passes["compile-promote"].failures[0].excerpt, /exit 69/);
});

test("synthesizeProviderEntities: compile ok -> success entity (the resolution signal)", () => {
  const passes = cron.synthesizeProviderEntities({ compileExit: 0, compileOk: true });
  const p = passes["compile-promote"];
  assert.equal(p.failures.length, 0);
  assert.deepEqual(p.entities.map((e) => e.id), [SYNTH_COMPILE_ID]);
});

test("synthesizeProviderEntities: a HARD compile failure contributes no compile pass at all", () => {
  const passes = cron.synthesizeProviderEntities({ compileExit: 1, compileOk: false, compileError: "boom" });
  assert.equal(passes["compile-promote"], undefined, "hard failure is not a provider signal: streak untouched");
});

test("synthesizeProviderEntities: consolidate llm-skip -> failure; llm ran -> success; skipped/dryRun/no-llm -> nothing", () => {
  const skip = cron.synthesizeProviderEntities({ compileOk: true, report: { llmRequested: true, llm: false } });
  assert.equal(skip["consolidate-llm"].failures.length, 1);
  assert.equal(skip["consolidate-llm"].failures[0].id, SYNTH_CONSOLIDATE_ID);

  const ran = cron.synthesizeProviderEntities({ compileOk: true, report: { llmRequested: true, llm: true } });
  assert.equal(ran["consolidate-llm"].failures.length, 0);
  assert.deepEqual(ran["consolidate-llm"].entities.map((e) => e.id), [SYNTH_CONSOLIDATE_ID]);

  for (const report of [
    { skipped: "not-due" },
    { llmRequested: true, llm: false, dryRun: true },
    { llmRequested: false, llm: false },
    null,
  ]) {
    const none = cron.synthesizeProviderEntities({ compileOk: true, report });
    assert.equal(none["consolidate-llm"], undefined, `no consolidate signal for ${JSON.stringify(report)}`);
  }
});

test("signatures: ENOENT vs timeout aborts open DIFFERENT episodes; volatile tokens still collapse", () => {
  // Through the production path: the synthesized excerpt is tail-first
  // ("last: <cause>" before the long shared prefix) precisely so the 80-char
  // signature window sees the differentiating words.
  const sigOf = (msg) => {
    const passes = cron.synthesizeProviderEntities({ compileExit: 69, compileOk: false, compileError: msg });
    const f = passes["compile-promote"].failures[0];
    return normalizeErrorSignature(f.excerpt, { pass: "compile-promote", kind: f.kind });
  };
  assert.notEqual(sigOf(ENOENT_ABORT), sigOf(TIMEOUT_ABORT), "different root causes, different operator fixes");
  assert.equal(
    sigOf(TIMEOUT_ABORT),
    sigOf(TIMEOUT_ABORT.replace("120000ms", "90000ms")),
    "timeout duration is volatile and must not split the episode",
  );
  assert.equal(
    sigOf(ENOENT_ABORT),
    sigOf(ENOENT_ABORT.replace("(claude:(default), codex:(default), cursor:(default))", "(claude:(default))")),
    "the exhausted-chain listing is suffix context and must not split the episode",
  );
});

test("compile synthetic lifecycle: threshold escalation -> issue report -> recovery resolves", () => {
  wipeHealingState();
  const state = { version: 1, entities: {} };
  const failPasses = cron.synthesizeProviderEntities({ compileExit: 69, compileOk: false, compileError: ENOENT_ABORT });

  for (let i = 0; i < 2; i++) {
    cron.updateEntityState(state, { passes: failPasses }, { ts: `2026-06-04T1${i}:00:00.000Z`, logPath: `state/logs/2026/06/cron-${i}.json`, escalateAfter: 3 });
  }
  assert.equal(cron.evaluateEscalations(state, { escalateAfter: 3 }).length, 0, "below threshold: silent");

  cron.updateEntityState(state, { passes: failPasses }, { ts: "2026-06-04T12:00:00.000Z", logPath: "state/logs/2026/06/cron-2.json", escalateAfter: 3 });
  const escalations = cron.evaluateEscalations(state, { escalateAfter: 3 });
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].reason, "pending-consecutive");
  assert.deepEqual(escalations[0].entityIds, [SYNTH_COMPILE_ID]);

  const now = new Date("2026-06-04T12:00:01.000Z");
  const res = cron.writeIssueReports(escalations, state, now);
  assert.equal(res.openCount, 1);
  const reportAbs = path.join(ISSUES_DIR, dailyDatePath(now), `${escalations[0].signature}.1.md`);
  assert.ok(fs.existsSync(reportAbs), `issue report written at ${reportAbs}`);
  assert.match(fs.readFileSync(reportAbs, "utf8"), /^status: open$/m);

  const okPasses = cron.synthesizeProviderEntities({ compileExit: 0, compileOk: true });
  cron.updateEntityState(state, { passes: okPasses }, { ts: "2026-06-04T13:00:00.000Z", logPath: "state/logs/2026/06/cron-3.json", escalateAfter: 3 });
  assert.equal(state.entities[SYNTH_COMPILE_ID], undefined, "success deletes the entity");
  const res2 = cron.writeIssueReports([], state, new Date("2026-06-04T13:00:01.000Z"));
  assert.equal(res2.openCount, 0, "episode resolved once the signature has no live entity");
  assert.match(fs.readFileSync(reportAbs, "utf8"), /^status: resolved$/m);
});

test("both synthetic failures in one tick escalate independently with distinct signatures", () => {
  wipeHealingState();
  const state = { version: 1, entities: {} };
  const passes = cron.synthesizeProviderEntities({
    compileExit: 69,
    compileOk: false,
    compileError: ENOENT_ABORT,
    report: { llmRequested: true, llm: false },
  });
  for (let i = 0; i < 3; i++) {
    cron.updateEntityState(state, { passes }, { ts: `2026-06-04T1${i}:00:00.000Z`, logPath: `state/logs/2026/06/cron-${i}.json`, escalateAfter: 3 });
  }
  const escalations = cron.evaluateEscalations(state, { escalateAfter: 3 });
  assert.equal(escalations.length, 2, "one episode per synthetic entity");
  const sigs = new Set(escalations.map((e) => e.signature));
  assert.equal(sigs.size, 2, "distinct signatures");
  const ids = escalations.flatMap((e) => e.entityIds).sort();
  assert.deepEqual(ids, [SYNTH_COMPILE_ID, SYNTH_CONSOLIDATE_ID].sort());
});
