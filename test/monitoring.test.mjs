import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setupWorkspace, cleanup, runScript } from "./harness.mjs";

// MEMORY_DATA_DIR is set by setupWorkspace BEFORE the dynamic import, so
// monitoring.mjs resolves MONITORING_DIR under the temp workspace.
const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

const mon = await import("../scripts/lib/monitoring.mjs");

// Fake, structurally-valid secrets — NEVER real ones (redact discipline).
const FAKE_GH = `ghp_${"a".repeat(36)}`;
const FAKE_BEARER = "Bearer abcdEFGH1234567890";

test("writeMonitoringCapture: date-sharded path, epoch-ms, status:open, title signature", () => {
  const now = new Date("2026-06-11T12:00:00.000Z");
  const r = mon.writeMonitoringCapture({
    title: "LLMOutputInvalid in compile decideAction",
    severity: "confirmed-bug",
    surface: "cli.mjs compile",
    observed: "compile dropped an atom.",
    evidence: "stack at compile.mjs:120",
    suspectedFiles: ["src/scripts/compile.mjs"],
    now,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.path, /\/monitoring\/2026\/06\/11\/[a-z0-9-]+-\d+\.md$/, "date-shard + epoch-ms");
  assert.ok(/^[a-z0-9-]+$/.test(r.signature), `kebab signature, got ${r.signature}`);
  // Signature is derived from the TITLE only (stable), error class survives.
  assert.match(r.signature, /llmoutputinvalid/, "error class kept in signature");
  const md = fs.readFileSync(r.path, "utf8");
  assert.match(md, /^status: open$/m);
  assert.match(md, /^severity: confirmed-bug$/m);
  assert.match(md, /^# LLMOutputInvalid in compile decideAction$/m);
  assert.match(md, /## Suspected area in src\/\n- src\/scripts\/compile\.mjs/);
});

test("redaction scrubs secrets in BOTH the md body and the json sidecar", () => {
  const r = mon.writeMonitoringCapture({
    title: "leak test",
    evidence: `failed with ${FAKE_BEARER} and api_key=${FAKE_GH}`,
    json: { creds: FAKE_GH, nested: { auth: FAKE_BEARER }, note: "ok" },
    now: new Date("2026-06-11T12:01:00.000Z"),
  });
  assert.equal(r.ok, true);
  const md = fs.readFileSync(r.path, "utf8");
  const js = fs.readFileSync(r.jsonPath, "utf8");
  for (const blob of [md, js]) {
    assert.ok(!blob.includes("abcdEFGH1234567890"), "bearer token must be redacted");
    assert.ok(!blob.includes(FAKE_GH), "ghp_ token must be redacted");
    assert.match(blob, /\[REDACTED\]/, "redaction sentinel present");
  }
  assert.match(js, /"note":\s*"ok"/, "non-secret json field preserved");
});

test("missing title is refused", () => {
  const r = mon.writeMonitoringCapture({ title: "   " });
  assert.equal(r.ok, false);
  assert.equal(r.error, "title-required");
});

test("monitoringHealth counts open and zeroes after resolveCapture (delta-based)", () => {
  const before = mon.monitoringHealth();
  const r = mon.writeMonitoringCapture({
    title: "health probe",
    now: new Date("2026-06-11T12:02:00.000Z"),
  });
  const mid = mon.monitoringHealth();
  assert.equal(mid.open, before.open + 1, "open incremented by one");
  assert.equal(mid.healthy, false);
  assert.match(mid.summary, /unreviewed/);
  assert.ok(mid.summary.length <= 200, `summary <=200 chars (got ${mid.summary.length})`);

  const res = mon.resolveCapture(r.path);
  assert.equal(res.ok, true);
  assert.equal(res.status, "triaged");
  const post = mon.monitoringHealth();
  assert.equal(post.open, before.open, "open returns to the pre-probe count");
});

test("resolveCapture refuses a missing file", () => {
  const res = mon.resolveCapture("monitoring/2026/06/11/does-not-exist-1.md");
  assert.equal(res.ok, false);
  assert.equal(res.error, "not-found");
});

test("session-start surfaces the monitoring line within the 1KB budget when captures are open", () => {
  mon.writeMonitoringCapture({
    title: "budget probe anomaly",
    severity: "confirmed-bug",
    now: new Date("2026-06-11T12:03:00.000Z"),
  });
  const r = runScript("scripts/hooks/session-start.mjs", [], { stdin: "{}" });
  assert.equal(r.status, 0, r.stderr);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  const idx = ctx.indexOf("## Memory self-observability");
  assert.notEqual(idx, -1, "monitoring section surfaced when captures are open");
  const section = ctx.slice(idx);
  assert.ok(section.length < 1024, `monitoring section stays under 1KB (got ${section.length})`);
  assert.match(section, /unreviewed/);
  assert.ok(!section.includes("```json"), "no JSON dump in the hook context");
});
