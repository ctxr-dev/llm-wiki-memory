import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");
const cli = await import("../scripts/lib/wiki-cli.mjs");

test("init produced a valid empty hosted wiki", () => {
  assert.ok(fs.existsSync(path.join(wiki, "index.md")), "root index.md exists");
  assert.ok(fs.existsSync(path.join(wiki, ".llmwiki.layout.yaml")), "contract exists");
  const v = cli.validate(wiki);
  assert.equal(v.ok, true, `validate clean: ${JSON.stringify(v)}`);
});

test("writeMemory + updateDocMetadata: knowledge leaf, validate clean, filterable", async () => {
  const res = store.writeMemory({
    name: "knowledge-oauth-decision-2026-05-22-120000000.md",
    text: "# Use OAuth2 over custom auth\n\nUse OAuth2 for billing auth.\nWhy: fewer attack vectors.",
    datasetId: "knowledge",
  });
  assert.ok(res.created.document.id.startsWith("knowledge/"), "placed under knowledge/");
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
    filters: { atom_type: "decision", project_module: "billing" },
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
  assert.match(res.created.document.id, /^daily\/\d{4}\/\d{2}\/\d{2}\/daily-/, "nested by yyyy/mm/dd");
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
  });
  store.updateDocMetadata({
    datasetId: "knowledge",
    documentId: res.created.document.id,
    metadata: { atom_type: "reference", project_module: "billing" },
  });
  const id = res.created.document.id;

  store.disableDocument({ documentId: id, datasetId: "knowledge" });
  const listed = store.listDocuments({ datasetId: "knowledge", enabled: "true" }).documents.map((d) => d.id);
  assert.ok(!listed.includes(id), "archived leaf not in active listing");

  store.enableDocument({ documentId: id, datasetId: "knowledge" });
  const relisted = store.listDocuments({ datasetId: "knowledge", enabled: "true" }).documents.map((d) => d.id);
  assert.ok(relisted.includes(id), "re-enabled leaf back in listing");
});

test("saveDocument upsert-by-name overwrites in place (no duplicate)", () => {
  const before = store.listDocuments({ datasetId: "plans", enabled: "true" }).documents.length;
  store.saveDocument({ name: "plan-x.md", text: "# Plan X\n\nv1", datasetId: "plans", metadata: { atom_type: "plan" } });
  store.saveDocument({ name: "plan-x.md", text: "# Plan X\n\nv2 updated", datasetId: "plans", metadata: { atom_type: "plan" } });
  const after = store.listDocuments({ datasetId: "plans", enabled: "true" }).documents;
  assert.equal(after.length, before + 1, "second save overwrote, no duplicate");
  const planLeaf = after.find((d) => d.name === "plan-x.md");
  const doc = store.readDocument({ documentId: planLeaf.id, datasetId: "plans" });
  assert.match(doc.text, /v2 updated/, "content updated in place");
});

test("normalizeLeafName: arbitrary names become kebab leaves (no truncation)", () => {
  assert.deepEqual(store.normalizeLeafName("My Plan.md"), { name: "my-plan.md", id: "my-plan" });
  assert.deepEqual(store.normalizeLeafName("café déjà.md"), { name: "cafe-deja.md", id: "cafe-deja" });
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
  assert.equal(res.created.document.id, "plans/my-fancy-plan.md");
  assert.ok(fs.existsSync(path.join(wiki, "plans", "my-fancy-plan.md")));
  assert.equal(cli.validate(wiki).ok, true, `validate clean: ${JSON.stringify(cli.validate(wiki))}`);
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
