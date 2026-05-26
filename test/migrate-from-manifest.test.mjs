// migrate-from-manifest: manifest-driven migration runner. These tests exercise
// the pure planning logic in dry-run mode (no wiki / no real saveDocument):
// classification->dataset mapping, #heading section slicing, and the guards
// (missing source, absent heading, slash-less target, no dataset mapping,
// duplicate-target collision, skip filtering).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateEntry, migrateManifest } from "../scripts/migrate-from-manifest.mjs";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mfm-"));
}

function writeManifest(dir, entries) {
  const p = path.join(dir, "manifest.json");
  fs.writeFileSync(p, JSON.stringify({ entries }));
  return p;
}

test("migrateEntry (dry-run): maps classification->dataset and derives target", async () => {
  const dir = tmpdir();
  const src = path.join(dir, "note.md");
  fs.writeFileSync(src, "---\narea: scala-toolkit\n---\n# Title\n\nBody long enough.\n");
  const r = await migrateEntry(
    {
      source: src,
      classification: "knowledge",
      target: "wiki/knowledge/scala-toolkit/concept/note.md",
      area: "scala-toolkit",
    },
    { dryRun: true },
  );
  assert.equal(r.dryRun, true);
  assert.equal(r.datasetId, "knowledge");
  assert.equal(r.dir, "knowledge/scala-toolkit/concept");
  assert.equal(r.name, "note.md");
  assert.ok(r.bodyBytes > 0);
});

test("readSource extracts a `#heading` H2 section", async () => {
  const dir = tmpdir();
  const src = path.join(dir, "bundle.md");
  fs.writeFileSync(src, "# Doc\n\n## Section A\n\nalpha body\n\n## Section B\n\nbeta body\n");
  const r = await migrateEntry(
    { source: `${src}#Section B`, classification: "lesson", target: "wiki/self_improvement/meta/process/b.md" },
    { dryRun: true },
  );
  // dry-run returns bodyBytes for the SLICED section only (beta, not alpha).
  assert.equal(r.datasetId, "self_improvement");
  assert.ok(r.bodyBytes > 0 && r.bodyBytes < 40, `sliced section is small: ${r.bodyBytes}`);
});

test("migrateManifest (dry-run): skips are excluded from the total", async () => {
  const dir = tmpdir();
  const src = path.join(dir, "k.md");
  fs.writeFileSync(src, "# K\n\nbody\n");
  const manifest = writeManifest(dir, [
    { source: src, classification: "knowledge", target: "wiki/knowledge/a/concept/k.md" },
    { source: src, classification: "skip", target: null },
  ]);
  const s = await migrateManifest(manifest, { dryRun: true });
  assert.equal(s.total, 1, "skip entry excluded");
  assert.equal(s.ok, 1);
  assert.equal(s.fail, 0);
});

test("guard: missing source file -> per-entry failure", async () => {
  const dir = tmpdir();
  const manifest = writeManifest(dir, [
    { source: path.join(dir, "nope.md"), classification: "knowledge", target: "wiki/knowledge/a/concept/x.md" },
  ]);
  const s = await migrateManifest(manifest, { dryRun: true });
  assert.equal(s.fail, 1);
  assert.match(s.results[0].error, /ENOENT|no such file/i);
});

test("guard: absent `#heading` -> per-entry failure", async () => {
  const dir = tmpdir();
  const src = path.join(dir, "b.md");
  fs.writeFileSync(src, "# Doc\n\n## Only Section\n\nbody\n");
  const manifest = writeManifest(dir, [
    { source: `${src}#Missing Heading`, classification: "lesson", target: "wiki/self_improvement/m/process/x.md" },
  ]);
  const s = await migrateManifest(manifest, { dryRun: true });
  assert.equal(s.fail, 1);
  assert.match(s.results[0].error, /section heading.*not found/i);
});

test("guard: slash-less target -> per-entry failure", async () => {
  const dir = tmpdir();
  const src = path.join(dir, "k.md");
  fs.writeFileSync(src, "# K\n\nbody\n");
  const manifest = writeManifest(dir, [
    { source: src, classification: "knowledge", target: "wiki/loose.md" }, // -> "loose.md" after strip, no slash
  ]);
  const s = await migrateManifest(manifest, { dryRun: true });
  assert.equal(s.fail, 1);
  assert.match(s.results[0].error, /no directory segment/);
});

test("guard: unknown classification -> per-entry failure", async () => {
  const dir = tmpdir();
  const src = path.join(dir, "k.md");
  fs.writeFileSync(src, "# K\n\nbody\n");
  const manifest = writeManifest(dir, [
    { source: src, classification: "bogus", target: "wiki/knowledge/a/concept/k.md" },
  ]);
  const s = await migrateManifest(manifest, { dryRun: true });
  assert.equal(s.fail, 1);
  assert.match(s.results[0].error, /no dataset mapping/);
});

test("guard: duplicate target leaf -> second entry fails (collision)", async () => {
  const dir = tmpdir();
  const a = path.join(dir, "a.md");
  const b = path.join(dir, "b.md");
  fs.writeFileSync(a, "# A\n\nbody\n");
  fs.writeFileSync(b, "# B\n\nbody\n");
  const manifest = writeManifest(dir, [
    { source: a, classification: "knowledge", target: "wiki/knowledge/x/concept/dup.md" },
    { source: b, classification: "knowledge", target: "wiki/knowledge/x/concept/dup.md" },
  ]);
  const s = await migrateManifest(manifest, { dryRun: true });
  assert.equal(s.ok, 1);
  assert.equal(s.fail, 1);
  const failed = s.results.find((r) => !r.ok);
  assert.match(failed.error, /target collision/);
});
