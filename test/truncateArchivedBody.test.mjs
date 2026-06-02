import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");

fs.writeFileSync(
  path.join(wiki, ".layout", "layout.yaml"),
  `mode: hosted
layout:
  - path: knowledge
    placement_facets: [area, atom_type]
    max_depth: 5
  - path: self_improvement
    placement_facets: [area, task_type]
    max_depth: 5
  - path: plans
    placement_facets: [area]
    max_depth: 5
  - path: investigations
    placement_facets: [area]
    max_depth: 5
  - path: daily
    placement_strategy: daily-date
    max_depth: 5
`,
);
store._resetLayoutCacheForTests();

const FOOTER_RE =
  /\n\n\[truncated by consolidate at (.+?); original sha256 preserved in frontmatter\.source\.hash\]\n$/;

function readFm(absPath) {
  const raw = fs.readFileSync(absPath, "utf8");
  return matter(raw);
}

function absFor(documentId) {
  return path.join(wiki, String(documentId).split("/").join(path.sep));
}

let leafCounter = 0;
function makeArchivedLeaf({ body, name } = {}) {
  leafCounter += 1;
  const leafName =
    name || `knowledge-trunc-fixture-${leafCounter}-2026-05-22-120000000.md`;
  const res = store.writeMemory({
    name: leafName,
    text: body ?? "# Fixture\n\nseed body content for truncate tests.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "billing" },
  });
  const documentId = res.created.document.id;
  const disabled = store.disableDocument({ documentId, datasetId: "knowledge" });
  assert.equal(disabled.ok, true, "fixture leaf was archived");
  return { documentId, absPath: absFor(documentId) };
}

test("truncateArchivedBody: refuses when the leaf is not found", () => {
  const result = store.truncateArchivedBody({
    documentId: "knowledge/does/not/exist.md",
    max: 100,
    nowIso: "2026-06-02T00:00:00.000Z",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /leaf not found/);
});

test("truncateArchivedBody: refuses when memory.status is not 'archived'", () => {
  const res = store.writeMemory({
    name: "knowledge-active-leaf-2026-05-22-120000000.md",
    text: "# Active\n\n" + "x".repeat(5000),
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "billing" },
  });
  const documentId = res.created.document.id;

  const result = store.truncateArchivedBody({
    documentId,
    max: 100,
    nowIso: "2026-06-02T00:00:00.000Z",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not archived/);

  const onDisk = readFm(absFor(documentId));
  assert.ok(
    !onDisk.data.memory.consolidate_truncated_at,
    "active leaf was not stamped",
  );
  assert.equal(
    onDisk.content.trim(),
    ("# Active\n\n" + "x".repeat(5000)).trim(),
    "active leaf body untouched",
  );
});

test("truncateArchivedBody: idempotent when consolidate_truncated_at is already set", () => {
  const body = "# Big\n\n" + "y".repeat(5000);
  const { documentId, absPath } = makeArchivedLeaf({ body });

  const first = store.truncateArchivedBody({
    documentId,
    max: 200,
    nowIso: "2026-06-02T10:00:00.000Z",
  });
  assert.equal(first.ok, true);
  assert.ok(!first.skipped, "first pass actually truncated");

  const afterFirst = fs.readFileSync(absPath, "utf8");
  const fmFirst = readFm(absPath);
  assert.equal(fmFirst.data.memory.consolidate_truncated_at, "2026-06-02T10:00:00.000Z");

  const second = store.truncateArchivedBody({
    documentId,
    max: 50,
    nowIso: "2026-06-02T11:00:00.000Z",
  });
  assert.equal(second.ok, true);
  assert.equal(second.skipped, "already-truncated");

  const afterSecond = fs.readFileSync(absPath, "utf8");
  assert.equal(afterSecond, afterFirst, "file byte-identical after second call");

  const fmSecond = readFm(absPath);
  assert.equal(
    fmSecond.data.memory.consolidate_truncated_at,
    "2026-06-02T10:00:00.000Z",
    "stamp from first call preserved",
  );
});

test("truncateArchivedBody: no-op when body length is at or below the threshold", () => {
  const body = "# Small\n\nshort enough body.";
  const { documentId, absPath } = makeArchivedLeaf({ body });

  const beforeBytes = fs.readFileSync(absPath, "utf8");
  const fmBefore = readFm(absPath);
  const originalHash = fmBefore.data.source.hash;

  const result = store.truncateArchivedBody({
    documentId,
    max: 10_000,
    nowIso: "2026-06-02T12:00:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, "below-threshold");

  const afterBytes = fs.readFileSync(absPath, "utf8");
  assert.equal(afterBytes, beforeBytes, "no rewrite happened");

  const fmAfter = readFm(absPath);
  assert.ok(
    !fmAfter.data.memory.consolidate_truncated_at,
    "no stamp written when below threshold",
  );
  assert.equal(fmAfter.data.source.hash, originalHash, "hash preserved verbatim");
});

test("truncateArchivedBody: also no-ops when body length exactly equals max", () => {
  const body = "z".repeat(300);
  const { documentId, absPath } = makeArchivedLeaf({ body });

  const fmBefore = readFm(absPath);
  const onDiskBodyLen = fmBefore.content.length;

  const result = store.truncateArchivedBody({
    documentId,
    max: onDiskBodyLen,
    nowIso: "2026-06-02T12:00:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.skipped,
    "below-threshold",
    "equal-to-max path uses the same skip branch",
  );

  const fmAfter = readFm(absPath);
  assert.ok(!fmAfter.data.memory.consolidate_truncated_at);
});

test("truncateArchivedBody: truncates a long body, appends the marker footer, and stamps memory", () => {
  const body = "# Long doc\n\n" + "a".repeat(5000);
  const { documentId, absPath } = makeArchivedLeaf({ body });

  const fmBefore = readFm(absPath);
  const originalHash = fmBefore.data.source.hash;
  assert.match(originalHash, /^sha256:/);

  const stamp = "2026-06-02T15:30:00.000Z";
  const result = store.truncateArchivedBody({
    documentId,
    max: 400,
    nowIso: stamp,
  });

  assert.equal(result.ok, true);
  assert.ok(!result.skipped, "truncation happened (no skip reason)");
  assert.equal(result.documentId, documentId);
  assert.ok(
    typeof result.freedBytes === "number" && result.freedBytes > 0,
    `freedBytes is positive (got ${result.freedBytes})`,
  );

  const fmAfter = readFm(absPath);
  const newBody = fmAfter.content;

  assert.match(newBody, FOOTER_RE, "footer present at end of body");
  const m = newBody.match(FOOTER_RE);
  assert.equal(m[1], stamp, "footer timestamp matches nowIso");

  const head = newBody.replace(FOOTER_RE, "");
  assert.ok(
    head.length <= 400,
    `head (sans footer) is bounded by max: head=${head.length}, max=400`,
  );

  assert.equal(
    fmAfter.data.memory.consolidate_truncated_at,
    stamp,
    "memory.consolidate_truncated_at stamped with nowIso",
  );
  assert.equal(fmAfter.data.memory.status, "archived", "still archived");

  assert.equal(
    fmAfter.data.source.hash,
    originalHash,
    "frontmatter.source.hash preserved verbatim",
  );
});

test("truncateArchivedBody: defaults max to 1200 when max is missing or invalid", () => {
  const body = "# Default max\n\n" + "b".repeat(3000);

  // missing max
  const a = makeArchivedLeaf({ body });
  const resA = store.truncateArchivedBody({
    documentId: a.documentId,
    nowIso: "2026-06-02T16:00:00.000Z",
  });
  assert.equal(resA.ok, true);
  assert.ok(!resA.skipped, "default max kicked in and truncated");
  const headA = readFm(a.absPath).content.replace(FOOTER_RE, "");
  assert.ok(headA.length <= 1200, `default max=1200, got head=${headA.length}`);

  // invalid: NaN
  const b = makeArchivedLeaf({ body });
  const resB = store.truncateArchivedBody({
    documentId: b.documentId,
    max: Number.NaN,
    nowIso: "2026-06-02T16:01:00.000Z",
  });
  assert.equal(resB.ok, true);
  assert.ok(!resB.skipped);
  const headB = readFm(b.absPath).content.replace(FOOTER_RE, "");
  assert.ok(headB.length <= 1200);

  // invalid: zero
  const c = makeArchivedLeaf({ body });
  const resC = store.truncateArchivedBody({
    documentId: c.documentId,
    max: 0,
    nowIso: "2026-06-02T16:02:00.000Z",
  });
  assert.equal(resC.ok, true);
  assert.ok(!resC.skipped);
  const headC = readFm(c.absPath).content.replace(FOOTER_RE, "");
  assert.ok(headC.length <= 1200);

  // invalid: negative
  const d = makeArchivedLeaf({ body });
  const resD = store.truncateArchivedBody({
    documentId: d.documentId,
    max: -100,
    nowIso: "2026-06-02T16:03:00.000Z",
  });
  assert.equal(resD.ok, true);
  assert.ok(!resD.skipped);
  const headD = readFm(d.absPath).content.replace(FOOTER_RE, "");
  assert.ok(headD.length <= 1200);

  // invalid: non-numeric string
  const e = makeArchivedLeaf({ body });
  const resE = store.truncateArchivedBody({
    documentId: e.documentId,
    max: "not-a-number",
    nowIso: "2026-06-02T16:04:00.000Z",
  });
  assert.equal(resE.ok, true);
  assert.ok(!resE.skipped);
  const headE = readFm(e.absPath).content.replace(FOOTER_RE, "");
  assert.ok(headE.length <= 1200);
});

test("truncateArchivedBody: defaults nowIso to current ISO when missing", () => {
  const body = "# now-default\n\n" + "c".repeat(5000);
  const { documentId, absPath } = makeArchivedLeaf({ body });

  const before = Date.now();
  const result = store.truncateArchivedBody({ documentId, max: 300 });
  const after = Date.now();

  assert.equal(result.ok, true);
  assert.ok(!result.skipped);

  const fm = readFm(absPath);
  const stamp = fm.data.memory.consolidate_truncated_at;
  assert.ok(typeof stamp === "string" && stamp.length > 0, "stamp is a string");
  assert.match(
    stamp,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
    "stamp is an ISO-8601 UTC string",
  );

  const t = Date.parse(stamp);
  assert.ok(
    t >= before - 1000 && t <= after + 1000,
    `stamp ~= now (before=${before}, stamp=${t}, after=${after})`,
  );

  const footerMatch = fm.content.match(FOOTER_RE);
  assert.ok(footerMatch, "footer present");
  assert.equal(footerMatch[1], stamp, "footer timestamp matches memory stamp");
});

test("truncateArchivedBody: drops trailing whitespace from the truncated head before appending the footer", () => {
  const body = "# trailing ws\n\n" + "d".repeat(200) + "      \n\t\n" + "e".repeat(5000);
  const { documentId, absPath } = makeArchivedLeaf({ body });

  const result = store.truncateArchivedBody({
    documentId,
    max: 220,
    nowIso: "2026-06-02T17:00:00.000Z",
  });
  assert.equal(result.ok, true);
  assert.ok(!result.skipped);

  const fm = readFm(absPath);
  const head = fm.content.replace(FOOTER_RE, "");
  assert.ok(!/\s+$/.test(head), `head has no trailing whitespace: ${JSON.stringify(head.slice(-10))}`);
});
