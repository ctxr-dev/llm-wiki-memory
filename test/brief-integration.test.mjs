import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");

test("integration: renderLeaf writes a brief from the first >=3-word heading on save", () => {
  const w = store.writeMemory({
    name: "BriefLeaf.md",
    text: "# Cassandra timeout root cause zzqq\n\nThe pool was never released, so nightly jobs stalled.",
    datasetId: "knowledge",
    metadata: { atom_type: "bug-root-cause", area: "intg" },
  });
  const raw = fs.readFileSync(path.join(wiki, w.created.document.id), "utf8");
  assert.match(raw, /brief: .*Cassandra timeout root cause zzqq/);
});

test("integration: withGlance exposes the glance view; the default record shape is unchanged", async () => {
  store.writeMemory({
    name: "GlanceLeaf.md",
    text: "# Glance integration unique wwxx heading\n\nBody prose for the glance integration test.",
    datasetId: "knowledge",
    metadata: { atom_type: "decision", area: "intg" },
  });
  const query = "glance integration unique wwxx heading body prose";

  const glance = await store.searchMemoryFiltered({ query, datasetId: "knowledge", limit: 5, withGlance: true });
  const g = glance.records.find((r) => /glanceleaf/i.test(r.documentName));
  assert.ok(g, "found the leaf with withGlance");
  assert.match(g.brief, /Glance integration unique wwxx heading/);
  assert.equal(g.type, "decision");

  const plain = await store.searchMemoryFiltered({ query, datasetId: "knowledge", limit: 5 });
  const p = plain.records.find((r) => /glanceleaf/i.test(r.documentName));
  assert.ok(p, "found the leaf without withGlance");
  assert.equal(p.brief, undefined, "default record carries no brief (byte-identical shape)");
  assert.equal(p.type, undefined, "default record carries no type");
  assert.ok(typeof p.content === "string" && p.content.length > 0, "default record still carries the body");
});

test("integration: an adversarial heading cannot inject a forged frontmatter key (render→parse round-trip)", () => {
  const w = store.writeMemory({
    name: "InjectLeaf.md",
    text: "## Totally innocent: colon heading evil zzii\nmalicious: true\nid: forged-id\n\nbody",
    datasetId: "knowledge",
    metadata: { atom_type: "decision", area: "intg" },
  });
  const parsed = matter(fs.readFileSync(path.join(wiki, w.created.document.id), "utf8"));
  assert.equal(typeof parsed.data.brief, "string", "brief present as a scalar");
  assert.ok(!String(parsed.data.brief).includes("\n"), "brief is a single line");
  assert.equal(parsed.data.malicious, undefined, "no forged 'malicious' key leaked into frontmatter");
  assert.notEqual(parsed.data.id, "forged-id", "the real leaf id was not overwritten by injection");
});
