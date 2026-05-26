// End-to-end subject placement against the SHIPPED template layout (which the
// harness init installs): a real saveDocument nests by subject on disk, a
// sideways subject change relocates the leaf, and the emptied subject subtree
// is pruned up to the first shared ancestor.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");
const cli = await import("../scripts/lib/wiki-cli.mjs");

const abs = (rel) => path.join(wiki, rel.split("/").join(path.sep));

test("saveDocument nests a knowledge leaf by its subject path", () => {
  const res = store.saveDocument({
    name: "kamon-gauge-note.md",
    text: "# Kamon gauge\n\nnote body about the gauge sampler.",
    datasetId: "knowledge",
    metadata: { atom_type: "pattern-gotcha", project_module: "scala-toolkit", subject: ["observability", "kamon"] },
  });
  assert.match(
    res.created.document.id,
    /^knowledge\/scala-toolkit\/pattern-gotcha\/observability\/kamon\/kamon-gauge-note\.md$/,
    `nested by subject: ${res.created.document.id}`,
  );
  // frontmatter carries the subject slug array.
  const raw = fs.readFileSync(abs(res.created.document.id), "utf8");
  assert.match(raw, /subject:\s*\n\s*-\s*observability\s*\n\s*-\s*kamon/);
  assert.equal(cli.validate(wiki).ok, true, "validate clean after subject save");
});

// NOTE: this test consumes the leaf created by the test above via the shared
// module-level wiki. node --test runs tests within a file sequentially in
// definition order, so the dependency is safe (but the test is not isolated).
test("a sideways subject change relocates the leaf and prunes the old subject subtree", () => {
  // Anchor leaf so the shared ancestor (knowledge/scala-toolkit/pattern-gotcha)
  // keeps content and must NOT be pruned.
  store.saveDocument({
    name: "anchor.md",
    text: "# Anchor\n\nkeeps the pattern-gotcha/general subtree alive.",
    datasetId: "knowledge",
    metadata: { atom_type: "pattern-gotcha", project_module: "scala-toolkit" }, // subject absent -> general
  });

  const startRel = "knowledge/scala-toolkit/pattern-gotcha/observability/kamon/kamon-gauge-note.md";
  assert.ok(fs.existsSync(abs(startRel)), "leaf at original subject path");

  const upd = store.updateDocMetadata({
    datasetId: "knowledge",
    documentId: startRel,
    metadata: { subject: ["languages", "scala"] },
  });
  assert.ok(upd.relocated, `relocation reported: ${JSON.stringify(upd)}`);
  assert.match(upd.relocated.to, /^knowledge\/scala-toolkit\/pattern-gotcha\/languages\/scala\/kamon-gauge-note\.md$/);

  // leaf moved
  assert.ok(!fs.existsSync(abs(startRel)), "old leaf removed");
  assert.ok(fs.existsSync(abs(upd.relocated.to)), "leaf at new subject path");
  // the relocate path must REWRITE frontmatter subject to the new value, else a
  // later recompute would relocate it back.
  const movedRaw = fs.readFileSync(abs(upd.relocated.to), "utf8");
  assert.match(movedRaw, /subject:\s*\n\s*-\s*languages\s*\n\s*-\s*scala/, "frontmatter subject rewritten");
  assert.ok(!/observability/.test(movedRaw), "old subject removed from frontmatter");
  // old subject subtree fully pruned (no orphan dirs holding only index.md)
  assert.ok(!fs.existsSync(abs("knowledge/scala-toolkit/pattern-gotcha/observability/kamon")), "kamon dir pruned");
  assert.ok(!fs.existsSync(abs("knowledge/scala-toolkit/pattern-gotcha/observability")), "observability dir pruned");
  // shared ancestor with the anchor leaf survives
  assert.ok(fs.existsSync(abs("knowledge/scala-toolkit/pattern-gotcha")), "shared ancestor kept (anchor present)");
  assert.equal(cli.validate(wiki).ok, true, "validate clean after sideways relocation + prune");
});
