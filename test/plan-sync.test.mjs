// Tests for scripts/lib/plan-sync.mjs — the orchestrator that wraps
// plan-frontmatter rewrite with lifecycle-aware file moves.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { syncPlanFile, syncAllPlans, pickNonColliding } from "../scripts/lib/plan-sync.mjs";
import { _resetCacheForTests as resetTopologyCache } from "../scripts/lib/topology-runtime.mjs";

// Spin up a fresh wiki with the tracker-issues layout so the topology
// runtime recognises lifecycle-aware paths. We copy the example layout
// inline since the test runs in isolation from the live wiki.
function makeWikiWithLayout() {
  const wiki = fs.mkdtempSync(path.join(os.tmpdir(), "plan-sync-wiki-"));
  fs.mkdirSync(path.join(wiki, "layout"));
  // Inline a minimal tracker-issues layout that uses path_template (no
  // sandboxed compiler needed for tests).
  fs.writeFileSync(
    path.join(wiki, "layout", "layout.yaml"),
    `
layout:
  - path: issues
    placement_facets: []
    topology:
      strategy: caller_path
      helper:
        module: scripts/lib/topology-runtime.mjs
        package: llm-wiki-memory
        schema_version: 1
      file_kinds:
        plan:
          required_facets: [tracker, prefix, number, lifecycle, slug]
          enums:
            lifecycle: [pending, in-progress, done, archived]
          to_path_file: ./to_path.mjs
          from_path_file: ./from_path.mjs
        knowledge:
          required_facets: [tracker, prefix, number]
          to_path_file: ./to_path.mjs
          from_path_file: ./from_path.mjs
      facet_inputs:
        tracker: { type: string }
        prefix: { type: string }
        number: { type: integer, minimum: 1 }
        lifecycle: { type: string }
        slug: { type: string, pattern: "^[A-Za-z0-9-]+$" }
`,
  );
  fs.writeFileSync(
    path.join(wiki, "layout", "to_path.mjs"),
    `function digitBuckets(n) {
  const number = Number(n);
  return {
    n: number,
    thousands: Math.floor(number / 1000),
    hundredsTens: Math.floor((number % 1000) / 10),
    units: number % 10,
  };
}
export function knowledge({ tracker, prefix, number }) {
  const b = digitBuckets(number);
  return \`issues/\${tracker}/\${prefix}/\${b.thousands}/\${b.hundredsTens}/\${b.units}/\${prefix}-\${b.n}.md\`;
}
export function plan({ tracker, prefix, number, lifecycle, slug }) {
  const b = digitBuckets(number);
  return \`issues/\${tracker}/\${prefix}/\${b.thousands}/\${b.hundredsTens}/\${b.units}/\${lifecycle}/\${prefix}-\${b.n}-\${slug}.plan.md\`;
}
`,
  );
  fs.writeFileSync(
    path.join(wiki, "layout", "from_path.mjs"),
    `const KNOW = /^issues\\/([^/]+)\\/([^/]+)\\/(\\d+)\\/(\\d+)\\/(\\d+)\\/[^/]+-(\\d+)\\.md$/;
const PLAN = /^issues\\/([^/]+)\\/([^/]+)\\/(\\d+)\\/(\\d+)\\/(\\d+)\\/([^/]+)\\/[^/]+-(\\d+)-(.+)\\.plan\\.md$/;
export function knowledge(rel) {
  const m = KNOW.exec(rel);
  return m ? { tracker: m[1], prefix: m[2], number: parseInt(m[6], 10) } : null;
}
export function plan(rel) {
  const m = PLAN.exec(rel);
  return m ? {
    tracker: m[1], prefix: m[2], number: parseInt(m[7], 10),
    lifecycle: m[6], slug: m[8],
  } : null;
}
`,
  );
  // Skill needs a valid wiki shell. We won't run validate in unit tests;
  // syncPlanFile catches ensureIndexes failures and proceeds, so this is
  // safe enough.
  resetTopologyCache();
  return wiki;
}

function writePlan(wiki, relDir, basename, frontmatter, body) {
  const dir = path.join(wiki, relDir);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, basename);
  fs.writeFileSync(fp, matter.stringify(body, frontmatter));
  return fp;
}

// ---------------------------------------------------------------------------
// pickNonColliding
// ---------------------------------------------------------------------------

test("pickNonColliding: returns the target when nothing collides", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pnc-empty-"));
  const target = path.join(dir, "foo.plan.md");
  const r = pickNonColliding(target);
  assert.equal(r.path, target);
  assert.equal(r.suffix, null);
});

test("pickNonColliding: adds -v2 on first collision", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pnc-v2-"));
  const target = path.join(dir, "foo.plan.md");
  fs.writeFileSync(target, "");
  const r = pickNonColliding(target);
  assert.equal(r.path, path.join(dir, "foo-v2.plan.md"));
  assert.equal(r.suffix, "-v2");
});

test("pickNonColliding: keeps trying -v3, -v4, … until a free slot is found", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pnc-v4-"));
  const target = path.join(dir, "foo.plan.md");
  fs.writeFileSync(target, "");
  fs.writeFileSync(path.join(dir, "foo-v2.plan.md"), "");
  fs.writeFileSync(path.join(dir, "foo-v3.plan.md"), "");
  const r = pickNonColliding(target);
  assert.equal(r.path, path.join(dir, "foo-v4.plan.md"));
  assert.equal(r.suffix, "-v4");
});

// ---------------------------------------------------------------------------
// syncPlanFile — frontmatter only (file outside lifecycle-aware topology)
// ---------------------------------------------------------------------------

test("syncPlanFile: updates frontmatter on a flat plan file (no move)", async () => {
  const wiki = makeWikiWithLayout();
  // Place under wiki/plans/<area>/<file>.plan.md — NOT a lifecycle-aware path.
  const fp = writePlan(
    wiki,
    "plans/billing",
    "fix-it.plan.md",
    { status: "pending" },
    "# fix-it\n\n1. - [x] step 1\n2. - [ ] step 2\n",
  );
  const r = await syncPlanFile(fp, { wikiRoot: wiki });
  assert.equal(r.error, null);
  assert.equal(r.frontmatter_changed, true);
  assert.equal(r.status, "in-progress");
  assert.equal(r.moved, null);
  const fm = matter(fs.readFileSync(fp, "utf8")).data;
  assert.equal(fm.status, "in-progress");
  assert.deepEqual(fm.progress, { total: 2, done: 1, label: "1/2" });
});

// ---------------------------------------------------------------------------
// syncPlanFile — lifecycle-aware move (the tracker-issues case)
// ---------------------------------------------------------------------------

test("syncPlanFile: pending → in-progress moves the file into in-progress/", async () => {
  const wiki = makeWikiWithLayout();
  const fp = writePlan(
    wiki,
    "issues/JIRA/DEV/100/0/1/pending",
    "DEV-100001-investigate.plan.md",
    { issue_key: "DEV-100001", status: "pending" },
    "# Investigate\n\n1. - [x] step 1\n2. - [ ] step 2\n",
  );
  const r = await syncPlanFile(fp, { wikiRoot: wiki });
  assert.equal(r.error, null);
  assert.equal(r.status, "in-progress");
  assert.ok(r.moved, JSON.stringify(r));
  assert.ok(
    r.moved.to.includes("in-progress/DEV-100001-investigate.plan.md"),
    r.moved.to,
  );
  assert.equal(fs.existsSync(r.moved.from), false, "source removed");
  assert.equal(fs.existsSync(r.moved.to), true, "destination present");
});

test("syncPlanFile: in-progress → done moves the file into done/", async () => {
  const wiki = makeWikiWithLayout();
  const fp = writePlan(
    wiki,
    "issues/JIRA/DEV/100/0/2/in-progress",
    "DEV-100002-finish.plan.md",
    { issue_key: "DEV-100002", status: "in-progress" },
    "# Finish\n\n1. - [x] step 1\n2. - [x] step 2\n",
  );
  const r = await syncPlanFile(fp, { wikiRoot: wiki });
  assert.equal(r.status, "done");
  assert.ok(r.moved.to.includes("done/DEV-100002-finish.plan.md"));
});

test("syncPlanFile: reason:canceled items count as resolved → done", async () => {
  const wiki = makeWikiWithLayout();
  const fp = writePlan(
    wiki,
    "issues/JIRA/DEV/100/0/3/in-progress",
    "DEV-100003-mixed.plan.md",
    { issue_key: "DEV-100003", status: "in-progress" },
    "# mixed\n\n1. - [x] done\n2. - [ ] aborted  reason:canceled:no longer needed\n",
  );
  const r = await syncPlanFile(fp, { wikiRoot: wiki });
  assert.equal(r.status, "done");
  assert.ok(r.moved.to.includes("done/"));
});

test("syncPlanFile: reason:deferred items do NOT count as resolved", async () => {
  const wiki = makeWikiWithLayout();
  const fp = writePlan(
    wiki,
    "issues/JIRA/DEV/100/0/4/in-progress",
    "DEV-100004-stuck.plan.md",
    { issue_key: "DEV-100004", status: "in-progress" },
    "# stuck\n\n1. - [x] done\n2. - [ ] waiting  reason:deferred:awaiting infra\n",
  );
  const r = await syncPlanFile(fp, { wikiRoot: wiki });
  assert.equal(r.status, "in-progress");
  assert.equal(r.moved, null, "no move when lifecycle unchanged");
});

test("syncPlanFile: archived: true freezes status (no auto-flip, no move)", async () => {
  const wiki = makeWikiWithLayout();
  const fp = writePlan(
    wiki,
    "issues/JIRA/DEV/100/0/5/in-progress",
    "DEV-100005-done.plan.md",
    {
      issue_key: "DEV-100005",
      status: "in-progress",
      archived: true,
    },
    "# done\n\n1. - [x] done\n2. - [x] done2\n",
  );
  const r = await syncPlanFile(fp, { wikiRoot: wiki });
  // All boxes checked, but archived: true freezes status at "in-progress"
  // (the value as supplied by the user). No auto-move triggers.
  assert.equal(r.status, "in-progress");
  assert.equal(r.moved, null);
});

test("syncPlanFile: collision at destination triggers auto-suffix -v2", async () => {
  const wiki = makeWikiWithLayout();
  // Plant an existing file at the destination so the move collides.
  fs.mkdirSync(
    path.join(wiki, "issues/JIRA/DEV/100/0/6/in-progress"),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(wiki, "issues/JIRA/DEV/100/0/6/in-progress/DEV-100006-foo.plan.md"),
    "pre-existing",
  );
  // Now create a "pending" plan that should move to the same destination.
  const fp = writePlan(
    wiki,
    "issues/JIRA/DEV/100/0/6/pending",
    "DEV-100006-foo.plan.md",
    { issue_key: "DEV-100006", status: "pending" },
    "# foo\n\n1. - [x] step 1\n2. - [ ] step 2\n",
  );
  const r = await syncPlanFile(fp, { wikiRoot: wiki });
  assert.equal(r.error, null);
  assert.ok(r.moved.to.endsWith("DEV-100006-foo-v2.plan.md"), r.moved.to);
  assert.equal(r.moved.suffix, "-v2");
  assert.equal(fs.existsSync(r.moved.to), true);
  assert.equal(
    fs.readFileSync(
      path.join(wiki, "issues/JIRA/DEV/100/0/6/in-progress/DEV-100006-foo.plan.md"),
      "utf8",
    ),
    "pre-existing",
    "the colliding original file was NOT overwritten",
  );
});

test("syncPlanFile: idempotent — second call is a no-op", async () => {
  const wiki = makeWikiWithLayout();
  const fp = writePlan(
    wiki,
    "issues/JIRA/DEV/100/0/7/in-progress",
    "DEV-100007-stable.plan.md",
    { issue_key: "DEV-100007", status: "in-progress" },
    "# stable\n\n1. - [x] step 1\n2. - [ ] step 2\n",
  );
  const r1 = await syncPlanFile(fp, { wikiRoot: wiki });
  const r2 = await syncPlanFile(fp, { wikiRoot: wiki });
  // First pass writes progress/status; second pass should produce
  // identical values and detect no change.
  assert.equal(r2.frontmatter_changed, false);
  assert.equal(r2.moved, null);
  assert.equal(r2.status, r1.status);
});

test("syncPlanFile: handles missing file gracefully", async () => {
  const wiki = makeWikiWithLayout();
  const r = await syncPlanFile(path.join(wiki, "nope.plan.md"), { wikiRoot: wiki });
  assert.equal(r.error, "file does not exist");
});

test("syncPlanFile: handles non-.plan.md file gracefully", async () => {
  const wiki = makeWikiWithLayout();
  const fp = path.join(wiki, "not-a-plan.md");
  fs.writeFileSync(fp, "x");
  const r = await syncPlanFile(fp, { wikiRoot: wiki });
  assert.equal(r.error, "not a .plan.md file");
});

// ---------------------------------------------------------------------------
// syncAllPlans
// ---------------------------------------------------------------------------

test("syncAllPlans: sweeps every .plan.md and returns per-file results", async () => {
  const wiki = makeWikiWithLayout();
  writePlan(
    wiki,
    "issues/JIRA/DEV/100/0/8/pending",
    "DEV-100008-a.plan.md",
    { status: "pending" },
    "1. - [x] only step\n",
  );
  writePlan(
    wiki,
    "issues/JIRA/DEV/100/0/9/in-progress",
    "DEV-100009-b.plan.md",
    { status: "in-progress" },
    "1. - [ ] step\n",
  );
  const results = await syncAllPlans(wiki);
  assert.equal(results.length, 2);
  // DEV-100008 had one step and it's checked → done; move happens.
  const done = results.find((r) => r.moved && r.moved.to.includes("done/"));
  assert.ok(done, "one plan must have moved to done/");
});
