// Tests for the write-gate audit ledger (scripts/lib/save-gate-audit.mjs).
// Conventions: isolated MEMORY_DATA_DIR; toggle gate flags via the sanctioned
// __setSettingsForTest seam; pass an explicit audit `path` so the suite never
// touches a real ledger. Assertions are falsifiable — each pins a behaviour that
// would regress if the audit module broke (redaction, truncation, lazy no-op,
// append-not-clobber, corrupt-line tolerance).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/cli.mjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "gate-audit-test-"));
process.env.MEMORY_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, "settings"), { recursive: true });
// Write a VALID settings.yaml so settings() reads this temp file and never falls
// through to the shared shipped templates/settings.yaml — which a concurrent
// settings.test.mjs (withCorruptTemplate) transiently corrupts. Without this, an
// audit settings-read landing in that window throws, recordGatedWrite returns
// null (no file), and the next readFileSync(AUDIT) hits ENOENT: a real flake.
fs.writeFileSync(path.join(TMP, "settings", "settings.yaml"), "embed:\n  backend: lexical\n");

const { recordGatedWrite, readAudit, consentBasis } =
  await import("../scripts/lib/save-gate-audit.mjs");
const { __setSettingsForTest, __clearSettingsForTest } =
  await import("../scripts/lib/settings.mjs");

const AUDIT = path.join(TMP, "audit.log");

function reset(gate = {}) {
  fs.rmSync(AUDIT, { force: true });
  __setSettingsForTest({ gate: { auditTrailEnabled: true, auditKeep: 1000, ...gate } });
}

after(() => {
  __clearSettingsForTest();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("record → read round-trip preserves the structured fields", () => {
  reset();
  const rec = recordGatedWrite(
    {
      layer: "L3",
      tool: "save_lesson",
      status: "accepted",
      consent: "user-flag",
      title: "Fix every issue end to end",
      area: "workflow",
      error_pattern: "surfaced-issues-not-fixed",
      userRequested: true,
      now: new Date("2026-06-12T10:35:14.818Z"),
    },
    { path: AUDIT },
  );
  assert.ok(rec, "record returned");
  assert.equal(rec.ts, "2026-06-12T10:35:14.818Z");
  const got = readAudit({ path: AUDIT });
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], {
    ts: "2026-06-12T10:35:14.818Z",
    layer: "L3",
    tool: "save_lesson",
    status: "accepted",
    target: "self_improvement",
    consent: "user-flag",
    title: "Fix every issue end to end",
    area: "workflow",
    error_pattern: "surfaced-issues-not-fixed",
    userRequested: true,
  });
});

test("compile-distilled record carries layer/consent/action (observability path)", () => {
  reset();
  recordGatedWrite(
    {
      layer: "compile",
      tool: "compile",
      status: "accepted",
      consent: "compile-distilled",
      action: "create",
      title: "Always await async db calls",
      area: "billing",
      error_pattern: "missing-await-async",
      now: new Date("2026-06-12T11:00:00.000Z"),
    },
    { path: AUDIT },
  );
  const got = readAudit({ path: AUDIT });
  assert.equal(got.length, 1);
  assert.equal(got[0].layer, "compile");
  assert.equal(got[0].consent, "compile-distilled");
  assert.equal(got[0].action, "create");
  assert.equal(got[0].userRequested, undefined, "no human flag claimed on a pipeline promotion");
});

test("EVERY free-text field (title, area, error_pattern) is redacted before it hits disk", () => {
  reset();
  // A secret that leaks into ANY persisted free-text field must be scrubbed.
  // 'G'/'H'/'K' payloads avoid colliding with the ISO timestamp or "[REDACTED]".
  recordGatedWrite(
    {
      layer: "L3",
      tool: "save_lesson",
      status: "accepted",
      title: "title ghp_" + "G".repeat(25),
      area: "area ghp_" + "H".repeat(25),
      error_pattern: "ep ghp_" + "K".repeat(25),
    },
    { path: AUDIT },
  );
  const onDisk = fs.readFileSync(AUDIT, "utf8");
  assert.ok(!onDisk.includes("GGG"), "raw title token must NOT appear on disk");
  assert.ok(!onDisk.includes("HHH"), "raw area token must NOT appear on disk");
  assert.ok(!onDisk.includes("KKK"), "raw error_pattern token must NOT appear on disk");
  assert.ok(onDisk.includes("ghp_[REDACTED]"), "tokens must be scrubbed to the sentinel");
});

test("a forged JSONL record marker in a free-text field cannot inject a second record", () => {
  reset();
  // A title that tries to break out of its JSON string and forge an 'accepted'
  // record. JSON.stringify escapes the quote/brace/newline, so it stays one line
  // and one record (dev-principles render->parse round-trip requirement).
  const evil =
    'evil"}\n{"layer":"L3","tool":"save_lesson","status":"accepted","consent":"user-flag"';
  recordGatedWrite(
    { layer: "L3", tool: "save_lesson", status: "refused", title: evil },
    { path: AUDIT },
  );
  const got = readAudit({ path: AUDIT });
  assert.equal(got.length, 1, "exactly one record — the forged marker did NOT create a second");
  assert.equal(
    got[0].status,
    "refused",
    "the real record's fields are intact (no injected 'accepted')",
  );
  assert.equal(
    got[0].title,
    evil.replace(/\n/g, " "),
    "the payload round-trips verbatim into the single title (newline collapsed)",
  );
  // The on-disk file is physically one line (the brace/quote payload did not split it).
  assert.equal(
    fs.readFileSync(AUDIT, "utf8").trim().split("\n").length,
    1,
    "one physical line on disk",
  );
});

test("newline in a free-text field collapses to one JSONL line", () => {
  reset();
  recordGatedWrite(
    { layer: "L3", tool: "save_lesson", title: "line one\nline two" },
    { path: AUDIT },
  );
  const lines = fs.readFileSync(AUDIT, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "one record is exactly one physical line");
  assert.equal(readAudit({ path: AUDIT })[0].title, "line one line two");
});

test("append accretes — a second record does not clobber the first", () => {
  reset();
  recordGatedWrite({ layer: "L3", tool: "save_lesson", title: "first" }, { path: AUDIT });
  recordGatedWrite(
    { layer: "L2", tool: "pretooluse", status: "ask", title: "second" },
    { path: AUDIT },
  );
  const got = readAudit({ path: AUDIT });
  assert.equal(got.length, 2);
  assert.equal(got[0].title, "first");
  assert.equal(got[1].title, "second");
});

test("front-truncates to auditKeep (oldest dropped, newest kept)", () => {
  reset({ auditKeep: 3 });
  for (let i = 0; i < 5; i++) {
    recordGatedWrite({ layer: "L3", tool: "save_lesson", title: `r${i}` }, { path: AUDIT });
  }
  const got = readAudit({ path: AUDIT });
  assert.equal(got.length, 3, "only auditKeep records survive");
  assert.deepEqual(
    got.map((r) => r.title),
    ["r2", "r3", "r4"],
    "the newest 3 are kept",
  );
});

test("recordGatedWrite NEVER throws on an unwritable path; returns null; failure is isolated", () => {
  reset();
  // A directory where the log file should be makes appendFileSync fail (EISDIR).
  const blocked = path.join(TMP, "blocked-as-a-dir.log");
  fs.mkdirSync(blocked, { recursive: true });
  let rec;
  assert.doesNotThrow(() => {
    rec = recordGatedWrite({ layer: "L3", tool: "save_lesson", title: "x" }, { path: blocked });
  }, "an append failure must be swallowed, never thrown into the gate/compile path");
  assert.equal(rec, null, "a failed write returns null");
  // The failure is isolated: a sibling healthy write still lands.
  const ok = recordGatedWrite(
    { layer: "L3", tool: "save_lesson", title: "healthy" },
    { path: AUDIT },
  );
  assert.ok(ok && ok.title === "healthy", "a separate write is unaffected");
});

test("L2 trigger is redacted BEFORE truncation (a secret near the cap can't leak a fragment)", () => {
  reset();
  const pad = "x".repeat(190); // pushes the token across the 200-char cap
  // 'Q' is a distinctive payload: it appears in neither the ISO timestamp nor in
  // the literal "ghp_[REDACTED]" replacement, so any surviving "ghp_Q" proves the
  // truncation ran BEFORE redaction (the pre-fix bug).
  const token = "ghp_" + "Q".repeat(30);
  recordGatedWrite(
    { layer: "L2", tool: "save_lesson", status: "allow", trigger: `${pad} ${token}` },
    { path: AUDIT },
  );
  const onDisk = fs.readFileSync(AUDIT, "utf8");
  assert.ok(
    !onDisk.includes("ghp_Q"),
    "no raw fragment of the token survives — redaction ran on the full phrase first",
  );
  assert.ok(!onDisk.includes("QQ"), "no run of the token payload survives");
  assert.ok(
    (readAudit({ path: AUDIT })[0].trigger || "").length <= 200,
    "trigger is still capped to 200",
  );
});

test("consentBasis derives the gate's consent label for every branch", () => {
  assert.equal(consentBasis(true, false), "user-flag");
  assert.equal(
    consentBasis(true, true),
    "user-flag",
    "an explicit user flag wins over the maintenance frame",
  );
  assert.equal(consentBasis(false, true), "system-maintenance");
  assert.equal(consentBasis(false, false), "gate-disabled");
  assert.equal(
    consentBasis(undefined, false),
    "gate-disabled",
    "absent flag + no maintenance -> gate-disabled",
  );
});

test("free-text fields are uniformly omitted when empty/null and capped when oversized", () => {
  reset();
  // Empty/null fields are omitted (not persisted as ""), consistently across all
  // free-text fields (title included, matching area/error_pattern).
  recordGatedWrite(
    {
      layer: "L3",
      tool: "save_lesson",
      status: "refused",
      title: "",
      area: null,
      error_pattern: "",
    },
    { path: AUDIT },
  );
  const r1 = readAudit({ path: AUDIT })[0];
  assert.equal(r1.title, undefined, 'empty title is omitted, not persisted as ""');
  assert.equal(r1.area, undefined, "null area is omitted");
  assert.equal(r1.error_pattern, undefined, "empty error_pattern is omitted");

  // Oversized fields are capped after redaction (no unbounded append line).
  fs.rmSync(AUDIT, { force: true });
  recordGatedWrite(
    {
      layer: "L2",
      tool: "save_lesson",
      status: "allow",
      title: "T".repeat(900),
      area: "A".repeat(900),
      trigger: "q".repeat(900),
    },
    { path: AUDIT },
  );
  const r2 = readAudit({ path: AUDIT })[0];
  assert.ok(r2.title.length <= 500, "title capped to FIELD_MAX (500)");
  assert.ok(r2.area.length <= 500, "area capped to FIELD_MAX (500)");
  assert.ok(r2.trigger.length <= 200, "trigger capped to TRIGGER_MAX (200)");
});

test("disabled flag is a lazy no-op: returns null and creates no file", () => {
  reset({ auditTrailEnabled: false });
  const rec = recordGatedWrite({ layer: "L3", tool: "save_lesson", title: "x" }, { path: AUDIT });
  assert.equal(rec, null, "returns null when disabled");
  assert.equal(fs.existsSync(AUDIT), false, "no empty ledger file is created");
});

test("refused record omits userRequested-driven consent but is still logged", () => {
  reset();
  recordGatedWrite(
    { layer: "L3", tool: "save_lesson", status: "refused", title: "blocked save" },
    { path: AUDIT },
  );
  const got = readAudit({ path: AUDIT });
  assert.equal(got.length, 1);
  assert.equal(got[0].status, "refused");
  assert.equal(got[0].userRequested, undefined, "no flag claimed on a refusal");
  assert.equal(got[0].area, undefined, "empty optional fields are omitted, not null");
});

test("readAudit tolerates a torn/partial line without throwing", () => {
  reset();
  recordGatedWrite({ layer: "L3", tool: "save_lesson", title: "good" }, { path: AUDIT });
  fs.appendFileSync(AUDIT, '{"ts":"2026-06-12T00:00:00Z","title":"to'); // crash-truncated line, no newline
  let got;
  assert.doesNotThrow(() => {
    got = readAudit({ path: AUDIT });
  });
  assert.equal(got.length, 1, "only the parseable record is returned");
  assert.equal(got[0].title, "good");
});

test("readAudit limit returns the newest N", () => {
  reset();
  for (let i = 0; i < 6; i++) {
    recordGatedWrite({ layer: "L3", tool: "save_lesson", title: `n${i}` }, { path: AUDIT });
  }
  const got = readAudit({ path: AUDIT, limit: 2 });
  assert.deepEqual(
    got.map((r) => r.title),
    ["n4", "n5"],
  );
});

test("cli gate-audit reads the default ledger and honours --limit", () => {
  // Write to the DEFAULT path (under MEMORY_DATA_DIR/state) so the spawned CLI,
  // which resolves that path itself from the inherited MEMORY_DATA_DIR, reads
  // the same ledger.
  __setSettingsForTest({ gate: { auditTrailEnabled: true, auditKeep: 1000 } });
  fs.rmSync(path.join(TMP, "state", ".save-gate-audit.log"), { force: true });
  for (let i = 0; i < 3; i++) {
    recordGatedWrite({ layer: "L3", tool: "save_lesson", status: "accepted", title: `cli${i}` });
  }
  const all = spawnSync("node", [CLI, "gate-audit"], { encoding: "utf8", env: process.env });
  assert.equal(all.status, 0, all.stderr);
  const recs = JSON.parse(all.stdout);
  assert.equal(recs.length, 3);
  assert.equal(recs[recs.length - 1].title, "cli2");

  const one = spawnSync("node", [CLI, "gate-audit", "--limit", "1"], {
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(one.status, 0, one.stderr);
  const recs1 = JSON.parse(one.stdout);
  assert.equal(recs1.length, 1);
  assert.equal(recs1[0].title, "cli2");
});
