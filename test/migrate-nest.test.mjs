import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");
const cli = await import("../scripts/lib/wiki-cli.mjs");
const { migrateNest } = await import("../scripts/migrate-nest.mjs");

const abs = (rel) => path.join(wiki, rel.split("/").join(path.sep));

// Seed a leaf through the (now-nesting) writer to get valid frontmatter, then move
// it up to the flat category root to mimic a pre-nesting install. The leaf's facets
// map back to the same nested dir, so migration returns it exactly there.
function seedFlat({ name, text, datasetId, metadata }) {
  const res = store.writeMemory({ name, text, datasetId, metadata });
  const nestedRel = res.created.document.id;
  const base = path.basename(nestedRel);
  fs.renameSync(abs(nestedRel), abs(`${datasetId}/${base}`));
  return { flatRel: `${datasetId}/${base}`, nestedRel };
}

test("migrate-nest moves flat leaves into their facet folders and validates", async () => {
  const seeds = [
    seedFlat({
      name: "knowledge-a-2026-05-25-100000000.md",
      text: "# A\n\nfact A about billing.\nWhy: x.",
      datasetId: "knowledge",
      metadata: { atom_type: "decision", project_module: "billing" },
    }),
    seedFlat({
      name: "lesson-b-2026-05-25-110000000.md",
      text: "# B\n\nlesson B.\nWhy: y.",
      datasetId: "self_improvement",
      metadata: { project_module: "billing", task_type: "refactor", error_pattern: "ep" },
    }),
    seedFlat({
      name: "knowledge-c-2026-05-25-120000000.md",
      text: "# C\n\nfact C, no module.\nWhy: z.",
      datasetId: "knowledge",
      metadata: { atom_type: "reference" },
    }),
  ];
  for (const s of seeds) assert.ok(fs.existsSync(abs(s.flatRel)), `seeded flat: ${s.flatRel}`);

  const res = await migrateNest({ wiki });
  assert.equal(res.moved, 3, "moved all three flat leaves");
  assert.equal(res.ok, true, `migration validates clean: ${JSON.stringify(res.validate)}`);

  for (const s of seeds) {
    assert.ok(fs.existsSync(abs(s.nestedRel)), `re-nested at facet path: ${s.nestedRel}`);
    assert.ok(!fs.existsSync(abs(s.flatRel)), `flat copy removed: ${s.flatRel}`);
    const folderIndex = path.join(path.dirname(abs(s.nestedRel)), "index.md");
    assert.ok(
      fs.existsSync(folderIndex),
      `per-folder index built: ${path.relative(wiki, folderIndex)}`,
    );
  }
  // expected facet destinations
  assert.ok(seeds[0].nestedRel.startsWith("knowledge/billing/decision/"), seeds[0].nestedRel);
  assert.ok(
    seeds[1].nestedRel.startsWith("self_improvement/billing/refactor/"),
    seeds[1].nestedRel,
  );
  assert.ok(seeds[2].nestedRel.startsWith("knowledge/workspace/reference/"), seeds[2].nestedRel);
  assert.equal(cli.validate(wiki).ok, true);
});

test("migrate-nest is idempotent, search still works, and --check flags flat leaves", async () => {
  const chk = await migrateNest({ wiki, check: true });
  assert.equal(chk.ok, true, "no flat leaves remain after migration");
  assert.equal(chk.flatCount, 0);

  const again = await migrateNest({ wiki });
  assert.equal(again.moved, 0, "second run is a no-op");

  const found = await store.searchMemoryFiltered({
    query: "fact about billing",
    datasetId: "knowledge",
    filters: { area: "billing" },
  });
  assert.ok(found.records.length >= 1, "re-nested leaf is still found by folder-agnostic search");

  seedFlat({
    name: "knowledge-d-2026-05-25-130000000.md",
    text: "# D\n\nfact D.\nWhy: w.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "billing" },
  });
  const chk2 = await migrateNest({ wiki, check: true });
  assert.equal(chk2.ok, false, "a freshly introduced flat leaf is detected");
  assert.equal(chk2.flatCount, 1);
});

test("migrate-nest refuses to clobber an existing destination (no data loss)", async () => {
  // A nested leaf already lives at its facet path.
  const nested = store.writeMemory({
    name: "knowledge-clash-2026-05-25-150000000.md",
    text: "# Nested original\n\nthe original nested leaf.\nWhy: keep it.",
    datasetId: "knowledge",
    metadata: { atom_type: "decision", project_module: "billing" },
  });
  const nestedRel = nested.created.document.id; // knowledge/billing/decision/knowledge-clash-...md
  const nestedAbs = abs(nestedRel);
  const before = fs.readFileSync(nestedAbs, "utf8");

  // A flat leaf with the SAME basename that would migrate onto the nested one.
  const flatRel = `knowledge/${path.basename(nestedRel)}`;
  const flatAbs = abs(flatRel);
  fs.copyFileSync(nestedAbs, flatAbs);
  fs.appendFileSync(flatAbs, "\nDISTINCT FLAT MARKER\n");

  const res = await migrateNest({ wiki });
  assert.equal(res.ok, false, "a destination collision makes the run not-ok");
  assert.ok(
    res.conflicts.some((c) => c.from === flatRel),
    `collision recorded: ${JSON.stringify(res.conflicts)}`,
  );
  assert.ok(fs.existsSync(flatAbs), "flat source left in place, not deleted");
  assert.equal(fs.readFileSync(nestedAbs, "utf8"), before, "existing nested leaf not overwritten");

  fs.rmSync(flatAbs); // tidy up so the leftover flat leaf does not perturb later runs
});

// ─── topology categories (tracker issues) ──────────────────────────────────

const { resetLayoutCache } = store;

// Overlay a tracker-issues topology onto the hosted wiki's layout so wiki-store
// + the skill both see it. Inline to_path/from_path mirror the live compilers.
function installIssuesTopology() {
  const layoutPath = abs(".layout/layout.yaml");
  const cur = fs.readFileSync(layoutPath, "utf8");
  if (cur.includes("path: issues")) return;
  fs.writeFileSync(
    layoutPath,
    cur +
      `
  - path: issues
    placement_facets: []
    consolidate: none
    topology:
      strategy: caller_path
      file_kinds:
        knowledge:
          required_facets: [tracker, prefix, number]
          to_path: |
            function to_path({ tracker, prefix, number }) {
              const n = Number(number);
              return \`issues/\${tracker}/\${prefix}/\${Math.floor(n/1000)}/\${Math.floor((n%1000)/10)}/\${n%10}/\${prefix}-\${n}.md\`;
            }
          from_path: |
            function from_path(rel) {
              const m = /^issues\\/([^/]+)\\/([^/]+)\\/(\\d+)\\/(\\d+)\\/(\\d+)\\/[^/]+-(\\d+)\\.md$/.exec(rel);
              return m ? { tracker: m[1], prefix: m[2], number: parseInt(m[6], 10) } : null;
            }
        plan:
          required_facets: [tracker, prefix, number, lifecycle, slug]
          enums:
            lifecycle: [pending, in-progress, done, archived]
          to_path: |
            function to_path({ tracker, prefix, number, lifecycle, slug }) {
              const n = Number(number);
              return \`issues/\${tracker}/\${prefix}/\${Math.floor(n/1000)}/\${Math.floor((n%1000)/10)}/\${n%10}/\${lifecycle}/\${prefix}-\${n}-\${slug}.plan.md\`;
            }
          from_path: |
            function from_path(rel) {
              const m = /^issues\\/([^/]+)\\/([^/]+)\\/(\\d+)\\/(\\d+)\\/(\\d+)\\/([^/]+)\\/(.+)\\.plan\\.md$/.exec(rel);
              if (!m) return null;
              const n = parseInt(m[3],10)*1000 + parseInt(m[4],10)*10 + parseInt(m[5],10);
              const stem = m[7];
              if (!stem.startsWith(\`\${m[2]}-\${n}-\`)) return null;
              return { tracker: m[1], prefix: m[2], number: n, lifecycle: m[6], slug: stem.slice(\`\${m[2]}-\${n}-\`.length) };
            }
      facet_inputs:
        tracker: { type: string }
        prefix: { type: string }
        number: { type: integer, minimum: 1 }
        lifecycle: { type: string }
        slug: { type: string, pattern: "^[A-Za-z0-9-]+$" }
`,
  );
  resetLayoutCache();
}

function writeFlatIssue(name, body) {
  const p = abs(`issues/${name}`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return `issues/${name}`;
}

test("migrate-nest derives tracker facets and computes topology dests (dry-run)", async () => {
  installIssuesTopology();
  // plan with mixed checkboxes → in-progress; bucket 555/0/0 (units/tens zero)
  writeFlatIssue(
    "DEV-555000-fix-thing.plan.md",
    "---\nstatus: pending\n---\n# Fix thing\n\n- [x] a\n- [ ] b\n",
  );
  // knowledge kind (no lifecycle segment)
  writeFlatIssue("DEV-555000.md", "---\n---\n# DEV-555000\n\nlink + decision.\n");
  // multi-hyphen slug + -vN
  writeFlatIssue(
    "DEV-129957-v2-code-review-fixes.plan.md",
    "---\nstatus: in-progress\n---\n# v2\n\n- [ ] x\n",
  );
  // unparseable: not a tracker key → must be recorded unresolved, never moved
  writeFlatIssue("just-a-note.md", "---\n---\n# note\n\nnot a tracker leaf.\n");

  const res = await migrateNest({ wiki, dryRun: true });
  const to = (from) => res.moves.find((m) => m.from === from)?.to;
  assert.equal(
    to("issues/DEV-555000-fix-thing.plan.md"),
    "issues/JIRA/DEV/555/0/0/in-progress/DEV-555000-fix-thing.plan.md",
  );
  assert.equal(
    to("issues/DEV-555000.md"),
    "issues/JIRA/DEV/555/0/0/DEV-555000.md",
    "knowledge kind: no lifecycle segment",
  );
  assert.equal(
    to("issues/DEV-129957-v2-code-review-fixes.plan.md"),
    "issues/JIRA/DEV/129/95/7/in-progress/DEV-129957-v2-code-review-fixes.plan.md",
  );
  assert.ok(
    res.unresolved.includes("issues/just-a-note.md"),
    "unparseable flat recorded unresolved",
  );
  assert.ok(
    !res.moves.some((m) => m.from === "issues/just-a-note.md"),
    "unparseable never queued for move",
  );

  // cleanup the flats so other tests aren't perturbed
  for (const n of [
    "DEV-555000-fix-thing.plan.md",
    "DEV-555000.md",
    "DEV-129957-v2-code-review-fixes.plan.md",
    "just-a-note.md",
  ]) {
    fs.rmSync(abs(`issues/${n}`), { force: true });
  }
});

test("migrate-nest lifecycle: stored 'done' wins over an unchecked checklist", async () => {
  installIssuesTopology();
  // 0 checked boxes → inferLifecycle=pending, but memory.status=done → done wins
  writeFlatIssue(
    "DEV-700001-finished.plan.md",
    "---\nstatus: pending\nmemory:\n  status: done\n---\n# Finished\n\n- [ ] leftover unchecked box\n",
  );
  const res = await migrateNest({ wiki, dryRun: true });
  assert.equal(
    res.moves.find((m) => m.from === "issues/DEV-700001-finished.plan.md")?.to,
    "issues/JIRA/DEV/700/0/1/done/DEV-700001-finished.plan.md",
    "more-advanced stored status wins",
  );
  fs.rmSync(abs("issues/DEV-700001-finished.plan.md"), { force: true });
});

test("migrate-nest: zero-padded issue number relocates to the NORMALISED round-tripping basename", async () => {
  installIssuesTopology();
  // pathFor normalises DEV-007 -> DEV-7; the dest basename must use the
  // normalised name so the landed path round-trips through from_path.
  writeFlatIssue(
    "DEV-007-padded.plan.md",
    "---\nstatus: in-progress\n---\n# padded\n\n- [x] a\n- [ ] b\n",
  );
  const res = await migrateNest({ wiki, dryRun: true });
  const to = res.moves.find((m) => m.from === "issues/DEV-007-padded.plan.md")?.to;
  assert.equal(
    to,
    "issues/JIRA/DEV/0/0/7/in-progress/DEV-7-padded.plan.md",
    "dest uses the topology-normalised basename, not the padded original",
  );
  fs.rmSync(abs("issues/DEV-007-padded.plan.md"), { force: true });
});

test("migrate-nest --check does NOT throw on an unparseable topology flat", async () => {
  installIssuesTopology();
  writeFlatIssue("garbage-name.md", "---\n---\n# garbage\n\nx\n");
  const chk = await migrateNest({ wiki, check: true });
  assert.equal(chk.ok, false, "flat present → not ok");
  assert.ok(chk.unresolved.includes("issues/garbage-name.md"), "recorded, not thrown");
  fs.rmSync(abs("issues/garbage-name.md"), { force: true });
});

test("migrate-nest: a knowledge flat with a trailing segment is REFUSED, not silently collapsed", async () => {
  installIssuesTopology();
  writeFlatIssue(
    "DEV-660003-extra.md",
    "---\n---\n# extra\n\nknowledge with a stray slug segment.\n",
  );
  const res = await migrateNest({ wiki, dryRun: true });
  assert.ok(
    res.unresolved.includes("issues/DEV-660003-extra.md"),
    "trailing-segment knowledge recorded unresolved",
  );
  assert.ok(
    !res.moves.some((m) => m.from === "issues/DEV-660003-extra.md"),
    "never silently relocated",
  );
  fs.rmSync(abs("issues/DEV-660003-extra.md"), { force: true });
});

test("migrate-nest live-run relocates a tracker plan into the topology tree", async () => {
  installIssuesTopology();
  writeFlatIssue(
    "DEV-880002-live-move.plan.md",
    "---\nstatus: in-progress\n---\n# Live move\n\n- [x] done step\n- [ ] next step\n",
  );
  const res = await migrateNest({ wiki });
  const dest = "issues/JIRA/DEV/880/0/2/in-progress/DEV-880002-live-move.plan.md";
  assert.ok(
    res.moves.some((m) => m.to === dest),
    `relocated: ${JSON.stringify(res.moves)}`,
  );
  assert.ok(fs.existsSync(abs(dest)), "file at topology path");
  assert.ok(!fs.existsSync(abs("issues/DEV-880002-live-move.plan.md")), "flat copy gone");
  // layout NOT clobbered by the run (seedContractIfAbsent, not refresh)
  assert.ok(
    fs.readFileSync(abs(".layout/layout.yaml"), "utf8").includes("path: issues"),
    "topology layout survived the run",
  );
});
