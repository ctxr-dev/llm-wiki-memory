import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");
const cli = await import("../scripts/lib/wiki-cli.mjs");

// These tests exercise the CORE area/atom_type/task_type placement + relocation
// mechanics. The shipped default layout adds a semantic `subject` axis (covered
// by subject-axis.test.mjs); pin an explicit no-subject layout here so these
// assertions test the mechanic itself, decoupled from the template's subject
// policy.
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

test("init produced a valid empty hosted wiki", () => {
  assert.ok(fs.existsSync(path.join(wiki, "index.md")), "root index.md exists");
  assert.ok(
    fs.existsSync(path.join(wiki, ".layout", "layout.yaml")),
    "contract exists at the canonical .layout/layout.yaml location",
  );
  const v = cli.validate(wiki);
  assert.equal(v.ok, true, `validate clean: ${JSON.stringify(v)}`);
});

test("writeMemory + updateDocMetadata: knowledge leaf, validate clean, filterable", async () => {
  const res = store.writeMemory({
    name: "knowledge-oauth-decision-2026-05-22-120000000.md",
    text: "# Use OAuth2 over custom auth\n\nUse OAuth2 for billing auth.\nWhy: fewer attack vectors.",
    datasetId: "knowledge",
    metadata: { atom_type: "decision", project_module: "billing", tags: "auth,billing" },
  });
  assert.match(
    res.created.document.id,
    /^knowledge\/billing\/decision\/knowledge-oauth-decision-/,
    "nested by project_module/atom_type facets",
  );
  store.updateDocMetadata({
    datasetId: "knowledge",
    documentId: res.created.document.id,
    metadata: { atom_type: "decision", project_module: "billing", tags: "auth,billing" },
  });

  const v = cli.validate(wiki);
  assert.equal(v.ok, true, `validate clean after write: ${JSON.stringify(v)}`);

  const list = store.listDocuments({ datasetId: "knowledge", enabled: "true" });
  assert.equal(list.documents.length, 1);

  const found = await store.searchMemoryFiltered({
    query: "oauth billing auth decision",
    datasetId: "knowledge",
    filters: { atom_type: "decision", area: "billing" },
  });
  assert.equal(found.records.length, 1, "filter matches the decision");
  assert.equal(found.records[0].documentName, "knowledge-oauth-decision-2026-05-22-120000000.md");

  const miss = await store.searchMemoryFiltered({
    query: "anything",
    datasetId: "knowledge",
    filters: { atom_type: "bug-root-cause" },
  });
  assert.equal(miss.records.length, 0, "wrong atom_type filters it out");
});

test("daily leaves nest by date and list with prefix", () => {
  const res = store.writeMemory({
    name: "daily-2026-05-22-130000000.md",
    text: "# Daily flush\n\n### Atom · decision · x\n- type: decision\n- body: |\n    body",
    datasetId: "daily",
  });
  assert.match(
    res.created.document.id,
    /^daily\/\d{4}\/\d{2}\/\d{2}\/daily-/,
    "nested by yyyy/mm/dd",
  );
  const v = cli.validate(wiki);
  assert.equal(v.ok, true, `validate clean with nested daily: ${JSON.stringify(v)}`);

  const list = store.listDocuments({ prefix: "daily-", enabled: "true", datasetId: "daily" });
  assert.equal(list.documents.length, 1);
});

test("daily placement honours an explicit capture date, not the write time", () => {
  // A flush worker can run after midnight UTC; the leaf must nest under the
  // captured day so the directory matches the header's captured_at_utc.
  const res = store.writeMemory({
    name: "daily-2024-01-02-030405000.md",
    text: "# Daily flush\n\nbody",
    datasetId: "daily",
    date: new Date(Date.UTC(2024, 0, 2, 3, 4, 5)),
  });
  assert.equal(
    res.created.document.id.startsWith("daily/2024/01/02/"),
    true,
    `nested under the capture date: ${res.created.document.id}`,
  );
  assert.equal(cli.validate(wiki).ok, true);
});

test("disableDocument hides from listing and search; enable restores", async () => {
  const res = store.writeMemory({
    name: "knowledge-temp-2026-05-22-140000000.md",
    text: "# Temp fact\n\nephemeral fact about widgets.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "billing" },
  });
  store.updateDocMetadata({
    datasetId: "knowledge",
    documentId: res.created.document.id,
    metadata: { atom_type: "reference", project_module: "billing" },
  });
  const id = res.created.document.id;

  store.disableDocument({ documentId: id, datasetId: "knowledge" });
  const listed = store
    .listDocuments({ datasetId: "knowledge", enabled: "true" })
    .documents.map((d) => d.id);
  assert.ok(!listed.includes(id), "archived leaf not in active listing");

  store.enableDocument({ documentId: id, datasetId: "knowledge" });
  const relisted = store
    .listDocuments({ datasetId: "knowledge", enabled: "true" })
    .documents.map((d) => d.id);
  assert.ok(relisted.includes(id), "re-enabled leaf back in listing");
});

test("saveDocument upsert-by-name overwrites in place (no duplicate)", () => {
  const before = store.listDocuments({ datasetId: "plans", enabled: "true" }).documents.length;
  store.saveDocument({
    name: "plan-x.md",
    text: "# Plan X\n\nv1",
    datasetId: "plans",
    metadata: { atom_type: "plan" },
  });
  store.saveDocument({
    name: "plan-x.md",
    text: "# Plan X\n\nv2 updated",
    datasetId: "plans",
    metadata: { atom_type: "plan" },
  });
  const after = store.listDocuments({ datasetId: "plans", enabled: "true" }).documents;
  assert.equal(after.length, before + 1, "second save overwrote, no duplicate");
  const planLeaf = after.find((d) => d.name === "plan-x.md");
  const doc = store.readDocument({ documentId: planLeaf.id, datasetId: "plans" });
  assert.match(doc.text, /v2 updated/, "content updated in place");
});

test("normalizeLeafName: arbitrary names become kebab leaves (no truncation)", () => {
  assert.deepEqual(store.normalizeLeafName("My Plan.md"), { name: "my-plan.md", id: "my-plan" });
  assert.deepEqual(store.normalizeLeafName("café déjà.md"), {
    name: "cafe-deja.md",
    id: "cafe-deja",
  });
  assert.deepEqual(store.normalizeLeafName("a/b\\c.md"), { name: "a-b-c.md", id: "a-b-c" });
  // timestamped compile name survives intact (digits + hyphens, no truncation)
  const ts = "knowledge-use-oauth2-2026-05-22-120000000";
  assert.deepEqual(store.normalizeLeafName(`${ts}.md`), { name: `${ts}.md`, id: ts });
  assert.deepEqual(store.normalizeLeafName("   "), { name: "untitled.md", id: "untitled" });
});

test("saveDocument with a messy name yields a leaf that passes validate", () => {
  const res = store.saveDocument({
    name: "My Fancy Plan!.md",
    text: "# My Fancy Plan\n\nshipit",
    datasetId: "plans",
    metadata: { atom_type: "plan" },
  });
  assert.equal(res.name, "my-fancy-plan.md", "stored under a sanitised name");
  assert.equal(
    res.created.document.id,
    "plans/workspace/my-fancy-plan.md",
    "absent area nests under the cross-cutting fallback",
  );
  assert.ok(fs.existsSync(path.join(wiki, "plans", "workspace", "my-fancy-plan.md")));
  assert.equal(
    cli.validate(wiki).ok,
    true,
    `validate clean: ${JSON.stringify(cli.validate(wiki))}`,
  );
});

test("unknown slot is rejected with a clear error", () => {
  assert.throws(
    () => store.saveDocument({ name: "x.md", text: "# x\n\nbody", datasetId: "notes" }),
    /unknown memory category 'notes'/,
  );
  assert.throws(
    () => store.writeMemory({ name: "x.md", text: "# x\n\nbody", datasetId: "random" }),
    /Valid categories/,
  );
});

test("deleteDocument removes the leaf and keeps wiki valid", () => {
  const res = store.saveDocument({
    name: "plan-doomed.md",
    text: "# Doomed\n\nto be deleted",
    datasetId: "plans",
    metadata: { atom_type: "plan" },
  });
  const id = res.created.document.id;
  store.deleteDocument({ documentId: id, datasetId: "plans" });
  assert.ok(!fs.existsSync(path.join(wiki, id.split("/").join(path.sep))), "leaf file gone");
  const v = cli.validate(wiki);
  assert.equal(v.ok, true, `validate clean after delete: ${JSON.stringify(v)}`);
});

test("deleteDocument retries a transient Windows-style lock on the hard delete (H1)", () => {
  const res = store.saveDocument({
    name: "plan-locked.md",
    text: "# Locked\n\ntransiently locked on delete",
    datasetId: "plans",
    metadata: { atom_type: "plan" },
  });
  const id = res.created.document.id;
  const abs = path.join(wiki, id.split("/").join(path.sep));
  const realRm = fs.rmSync;
  let rmCalls = 0;
  const spy = mock.method(fs, "rmSync", (/** @type {any} */ p, /** @type {any} */ opts) => {
    rmCalls++;
    if (rmCalls === 1) throw Object.assign(new Error("EBUSY: locked"), { code: "EBUSY" });
    return realRm(p, opts);
  });
  try {
    store.deleteDocument({ documentId: id, datasetId: "plans" });
  } finally {
    spy.mock.restore();
  }
  assert.ok(rmCalls >= 2, "the hard delete retried past the transient lock");
  assert.ok(!fs.existsSync(abs), "leaf gone after the retry");
});

test("deleteDocument prunes the dir it emptied (no orphan index.md left)", () => {
  // Sole occupant of a unique area dir; deleting it must remove that emptied
  // dir, not leave a blind nested dir holding only an auto-generated index.md.
  const res = store.saveDocument({
    name: "delete-prune-probe.md",
    text: "# Prune probe\n\nsole occupant of a unique area.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "deleteproneprobe" },
  });
  const id = res.created.document.id;
  const areaDir = path.join(wiki, "knowledge", "deleteproneprobe");
  assert.ok(fs.existsSync(areaDir), "area dir exists before delete");
  store.deleteDocument({ documentId: id, datasetId: "knowledge" });
  assert.ok(!fs.existsSync(areaDir), "emptied area dir pruned after delete");
  assert.equal(cli.validate(wiki).ok, true, "validate clean after delete+prune");
});

test("long scalars are not folded into block scalars (validate stays clean)", () => {
  // A title long enough that the focus scalar would exceed js-yaml's default
  // 80-col line width and fold to `>-`, which the skill's frontmatter parser
  // cannot read. With lineWidth -1 the scalar stays single-line and the
  // (installed) skill validates the doc instead of dropping it.
  const longTitle =
    "Proactively invoke available skills for the task such as frontend-excellence and frontend-design before writing UI";
  const res = store.writeMemory({
    name: "knowledge-long-title-2026-05-23-180000000.md",
    text: `# ${longTitle}\n\nBody with enough prose to embed.\nWhy: regression guard.`,
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "llm-wiki-memory" },
  });
  const id = res.created.document.id;
  store.updateDocMetadata({
    datasetId: "knowledge",
    documentId: id,
    metadata: { atom_type: "reference", project_module: "llm-wiki-memory" },
  });

  const abs = path.join(wiki, id.split("/").join(path.sep));
  const raw = fs.readFileSync(abs, "utf8");
  const fm = raw.split("\n---", 2)[0];
  assert.ok(!/[|>][+-]?\d?\s*$/m.test(fm), `frontmatter must not fold scalars:\n${fm}`);

  const v = cli.validate(wiki);
  assert.equal(v.ok, true, `validate clean with a long-titled leaf: ${JSON.stringify(v)}`);
  const list = store.listDocuments({ datasetId: "knowledge", enabled: "true" });
  assert.ok(
    list.documents.some((d) => d.id === id),
    "long-titled leaf is listed (not dropped from the index)",
  );
});

test("a separator-only ATX heading does not become the title (falls back to basename)", () => {
  // `# ===========` is decoration emitted by some note styles, not a title. The
  // H1 regex matches it, so without the guard the leaf would be titled "===".
  const res = store.writeMemory({
    name: "knowledge-separator-title-2026-06-11-000000000.md",
    text: "# ==============================\n\nReal body prose for the separator-title guard.\nWhy: decoration must not name the leaf.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "llm-wiki-memory" }, // no title -> derive
  });
  const id = res.created.document.id;
  const abs = path.join(wiki, id.split("/").join(path.sep));
  const fm = fs.readFileSync(abs, "utf8").split("\n---", 2)[0];
  // The derived title lands in the `focus` frontmatter field.
  const focus = (fm.match(/^focus:\s*(.+)$/m) || ["", ""])[1].trim().replace(/^["']|["']$/g, "");
  assert.ok(focus, "a focus/title was written");
  assert.ok(
    !/^[=\-_*#>~\s]+$/.test(focus),
    `title must not be separator-only, got ${JSON.stringify(focus)}`,
  );
  assert.match(focus, /separator/, "fell back to the basename-derived title");
  assert.equal(cli.validate(wiki).ok, true, "validate clean");
});

test("non-daily leaves nest by metadata facets (search-aligned)", () => {
  const lesson = store.saveDocument({
    name: "lesson-always-await-2026-05-25-120000000.md",
    text: "# Always await\n\nAwait async calls.\nWhy: avoid races.",
    datasetId: "self_improvement",
    metadata: { project_module: "billing", task_type: "refactor", error_pattern: "missing-await" },
  });
  assert.match(
    lesson.created.document.id,
    /^self_improvement\/billing\/refactor\/lesson-always-await-/,
    "self_improvement nests by project_module/task_type",
  );
  assert.equal(
    cli.validate(wiki).ok,
    true,
    `validate clean with nested facet leaf: ${JSON.stringify(cli.validate(wiki))}`,
  );
});

test("missing area falls back to the cross-cutting area; missing task_type to the unknown sentinel", () => {
  const k = store.writeMemory({
    name: "knowledge-no-scope-2026-05-25-130000000.md",
    text: "# Unscoped fact\n\nA fact with no project_module.\nWhy: exercise the fallback.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference" }, // no area / project_module
  });
  // Facet inference never leaves area unknown/unscoped: absent area resolves to
  // the cross-cutting area (default "workspace"), an honest, searchable bucket.
  assert.match(
    k.created.document.id,
    /^knowledge\/workspace\/reference\//,
    "absent area -> cross-cutting 'workspace'",
  );

  const l = store.saveDocument({
    name: "lesson-no-task-2026-05-25-140000000.md",
    text: "# No task\n\nlesson body.\nWhy: exercise the sentinel.",
    datasetId: "self_improvement",
    metadata: { project_module: "billing" }, // no task_type
  });
  assert.match(
    l.created.document.id,
    /^self_improvement\/billing\/unknown\//,
    "absent task_type -> unknown sentinel",
  );
});

test("renameEmbedding moves a cache entry so a relocation keeps the cached vector", async () => {
  const { embedCacheFor, wikiRoot } = await import("../scripts/lib/env.mjs");
  const { loadCache, saveCache } = await import("../scripts/lib/embed.mjs");
  const cp = embedCacheFor(wikiRoot(), "knowledge");
  const cache = loadCache(cp);
  cache.entries["knowledge/old/x.md"] = { hash: "sha256:abc", vector: [0.1, 0.2, 0.3] };
  saveCache(cp, cache);

  store.renameEmbedding("knowledge/old/x.md", "knowledge/new/x.md");

  const after = loadCache(embedCacheFor(wikiRoot(), "knowledge"));
  assert.ok(!after.entries["knowledge/old/x.md"], "old cache id removed");
  assert.deepEqual(
    after.entries["knowledge/new/x.md"],
    { hash: "sha256:abc", vector: [0.1, 0.2, 0.3] },
    "vector preserved under the new id (no cold re-embed)",
  );
});

test("updateDocMetadata relocates a leaf when a facet field changes", () => {
  const res = store.writeMemory({
    name: "knowledge-relocate-2026-05-25-160000000.md",
    text: "# Relocate me\n\nstarts cross-cutting, then gains a project_module.\nWhy: relocation test.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference" }, // no area -> knowledge/workspace/reference/
  });
  const startId = res.created.document.id;
  assert.match(startId, /^knowledge\/workspace\/reference\//, `starts cross-cutting: ${startId}`);

  const upd = store.updateDocMetadata({
    datasetId: "knowledge",
    documentId: startId,
    metadata: { project_module: "billing" }, // -> knowledge/billing/reference/
  });
  assert.ok(upd.relocated, `relocation reported: ${JSON.stringify(upd)}`);
  assert.match(upd.relocated.to, /^knowledge\/billing\/reference\/knowledge-relocate-/);
  assert.ok(
    !fs.existsSync(path.join(wiki, startId.split("/").join(path.sep))),
    "old location removed",
  );
  assert.ok(
    fs.existsSync(path.join(wiki, upd.relocated.to.split("/").join(path.sep))),
    "leaf at the new facet path",
  );
  assert.equal(
    cli.validate(wiki).ok,
    true,
    `validate clean after relocation: ${JSON.stringify(cli.validate(wiki))}`,
  );

  const again = store.updateDocMetadata({
    datasetId: "knowledge",
    documentId: upd.relocated.to,
    metadata: { project_module: "billing", atom_type: "reference" },
  });
  assert.ok(!again.relocated, "re-applying identical facets is an in-place no-op");
});

test("relocation prunes the emptied source dir (no orphan index.md left behind)", () => {
  // Unique area so this leaf is the SOLE occupant of its source dir; relocating
  // it must leave no orphan dir (the user's "never keep blind nested dirs" rule).
  const res = store.saveDocument({
    name: "orphan-prune-probe.md",
    text: "# Orphan prune\n\nsole occupant of a unique area dir.\nWhy: prune test.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "orphanprobesrc" },
  });
  const startId = res.created.document.id;
  assert.match(startId, /^knowledge\/orphanprobesrc\/reference\//);
  const srcDir = path.join(wiki, "knowledge", "orphanprobesrc");
  assert.ok(fs.existsSync(srcDir), "source area dir exists before relocation");

  const upd = store.updateDocMetadata({
    datasetId: "knowledge",
    documentId: startId,
    metadata: { project_module: "orphanprobedst" },
  });
  assert.ok(upd.relocated, `relocation reported: ${JSON.stringify(upd)}`);
  assert.ok(!fs.existsSync(srcDir), "emptied source area dir pruned (no orphan index.md)");
  assert.equal(cli.validate(wiki).ok, true, "validate clean after prune");
});

test("saveDocument relocates a same-named leaf when its facets change (upsert, no stale copy)", () => {
  const first = store.saveDocument({
    name: "knowledge-upsert-move.md",
    text: "# Upsert move\n\nv1 under billing.\nWhy: relocation test.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "billing" },
  });
  assert.match(
    first.created.document.id,
    /^knowledge\/billing\/reference\/knowledge-upsert-move\.md$/,
  );

  const second = store.saveDocument({
    name: "knowledge-upsert-move.md",
    text: "# Upsert move\n\nv2 under landing.\nWhy: relocation test.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "landing" },
  });
  assert.match(
    second.created.document.id,
    /^knowledge\/landing\/reference\/knowledge-upsert-move\.md$/,
  );
  assert.equal(second.relocatedFrom, first.created.document.id, "reports the relocation source");
  assert.ok(
    !fs.existsSync(path.join(wiki, first.created.document.id.split("/").join(path.sep))),
    "stale-facet copy removed (no duplicate)",
  );
  const matches = store
    .listDocuments({ datasetId: "knowledge", enabled: "true" })
    .documents.filter((d) => d.name === "knowledge-upsert-move.md");
  assert.equal(matches.length, 1, "exactly one leaf with that name after relocation");
  assert.equal(
    cli.validate(wiki).ok,
    true,
    `validate clean after upsert-relocation: ${JSON.stringify(cli.validate(wiki))}`,
  );
});

test("saveDocument does not delete-and-clobber when a duplicate basename exists across facets", () => {
  // Two leaves with the SAME basename in different facet folders (writeMemory
  // places by exact path without a recursive dedup, so this is reachable).
  store.writeMemory({
    name: "knowledge-dup-name.md",
    text: "# A\n\nbilling copy.\nWhy: x.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "billing" },
  });
  store.writeMemory({
    name: "knowledge-dup-name.md",
    text: "# B\n\nlanding copy.\nWhy: y.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "landing" },
  });
  const before = store
    .listDocuments({ datasetId: "knowledge", enabled: "true" })
    .documents.filter((d) => d.name === "knowledge-dup-name.md").length;
  assert.equal(before, 2, "two cross-facet duplicates seeded");

  // An upsert that would relocate onto the occupied target must not delete one
  // leaf while clobbering the other.
  store.saveDocument({
    name: "knowledge-dup-name.md",
    text: "# C\n\nupsert.\nWhy: z.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module: "landing" },
  });

  const after = store
    .listDocuments({ datasetId: "knowledge", enabled: "true" })
    .documents.filter((d) => d.name === "knowledge-dup-name.md").length;
  assert.equal(after, 2, "no leaf was deleted-and-clobbered (count preserved)");
  // NB: two same-basename leaves share one leaf id, so this seeded state is
  // intentionally DUP-ID-invalid; the point here is purely that saveDocument did
  // not destroy data. Clean up so the duplicate id doesn't fail later validate.
  for (const d of store
    .listDocuments({ datasetId: "knowledge", enabled: "true" })
    .documents.filter((x) => x.name === "knowledge-dup-name.md")) {
    store.deleteDocument({ documentId: d.id, datasetId: "knowledge" });
  }
});

test("placementDirForMeta maps each category to its facet path (by area)", () => {
  assert.equal(
    store.placementDirForMeta("knowledge", { area: "tradingtune", atom_type: "pattern-gotcha" }),
    "knowledge/tradingtune/pattern-gotcha",
  );
  assert.equal(
    store.placementDirForMeta("self_improvement", { area: "tt", task_type: "debugging" }),
    "self_improvement/tt/debugging",
  );
  assert.equal(store.placementDirForMeta("plans", { area: "tt" }), "plans/tt");
  assert.equal(store.placementDirForMeta("investigations", {}), "investigations/unscoped");
  assert.equal(
    store.placementDirForMeta("self_improvement", { area: "tt" }),
    "self_improvement/tt/unknown",
  );
  assert.equal(
    store.placementDirForMeta("daily", {}),
    null,
    "daily is date-nested, not facet-nested",
  );
});

test("searchMemoryFiltered: subject is an array-membership filter", async () => {
  // subject persists into frontmatter regardless of the (no-subject) pinned
  // layout; metaMatchesFilters treats it as array membership like tags.
  store.saveDocument({
    name: "subj-obs.md",
    text: "# Obs\n\nkamon metrics gauge sampler note.",
    datasetId: "knowledge",
    metadata: {
      atom_type: "concept",
      project_module: "subjtest",
      subject: ["observability", "kamon"],
    },
  });
  store.saveDocument({
    name: "subj-lang.md",
    text: "# Lang\n\ncats-effect resource note.",
    datasetId: "knowledge",
    metadata: { atom_type: "concept", project_module: "subjtest", subject: ["languages", "scala"] },
  });

  const hit = await store.searchMemoryFiltered({
    query: "note",
    datasetId: "knowledge",
    filters: { area: "subjtest", subject: ["observability"] },
  });
  const names = hit.records.map((r) => r.documentName);
  assert.ok(names.includes("subj-obs.md"), "observability leaf matches");
  assert.ok(!names.includes("subj-lang.md"), "languages leaf excluded by subject filter");

  const both = await store.searchMemoryFiltered({
    query: "note",
    datasetId: "knowledge",
    filters: { subject: ["observability", "kamon"] },
  });
  assert.ok(
    both.records.map((r) => r.documentName).includes("subj-obs.md"),
    "all wanted subject terms present matches",
  );

  const none = await store.searchMemoryFiltered({
    query: "note",
    datasetId: "knowledge",
    filters: { subject: ["nonexistent"] },
  });
  assert.equal(none.records.length, 0, "unmatched subject term filters everything out");

  for (const n of ["subj-obs.md", "subj-lang.md"]) {
    const d = store
      .listDocuments({ datasetId: "knowledge", enabled: "true" })
      .documents.find((x) => x.name === n);
    if (d) store.deleteDocument({ documentId: d.id, datasetId: "knowledge" });
  }
});
