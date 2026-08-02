// The ordered registry. Unlike the ledger, this one FAILS LOUD: it is source
// under review, so a malformed entry is an authoring bug that must never reach an
// install as a silently-skipped migration.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRegistry, PHASES } from "../scripts/lib/migration-registry.mjs";

/** @type {string[]} */
const tmps = [];
after(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * Build a migrations/ tree: `entries` go into migrations.json, `files` are the
 * module files created on disk (defaults to one per entry id).
 */
function makeTree(entries, { files } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mig-reg-")));
  tmps.push(dir);
  fs.writeFileSync(path.join(dir, "migrations.json"), JSON.stringify({ migrations: entries }));
  for (const id of files ?? entries.map((e) => e.id)) {
    const abs = path.join(dir, `${id}.mjs`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "export const id = '';\n");
  }
  return dir;
}

test("phases are exactly the two bootstrap ordering slots", () => {
  assert.deepEqual([...PHASES], ["settings", "data"]);
});

test("registry order is the JSON order, not the filesystem's", () => {
  // Reverse-chronological on purpose: if the loader sorted by path or date it
  // would silently reorder migrations, and order is the whole contract.
  const dir = makeTree([
    { id: "2026/09/01/002-second", phase: "data" },
    { id: "2026/06/03/001-first", phase: "settings" },
  ]);
  assert.deepEqual(
    loadRegistry(dir).map((m) => m.id),
    ["2026/09/01/002-second", "2026/06/03/001-first"],
  );
});

test("each entry resolves to its date-nested module file", () => {
  const dir = makeTree([{ id: "2026/06/03/001-first", phase: "settings" }]);
  const [entry] = loadRegistry(dir);
  assert.equal(entry.file, path.join(dir, "2026/06/03/001-first.mjs"));
  assert.equal(entry.phase, "settings");
  assert.ok(fs.existsSync(entry.file));
});

test("filtering by phase preserves relative order", () => {
  const dir = makeTree([
    { id: "2026/01/01/001-a", phase: "data" },
    { id: "2026/01/02/002-b", phase: "settings" },
    { id: "2026/01/03/003-c", phase: "data" },
  ]);
  assert.deepEqual(
    loadRegistry(dir, { phase: "data" }).map((m) => m.id),
    ["2026/01/01/001-a", "2026/01/03/003-c"],
  );
});

test("a registered migration whose FILE is missing throws (never silently skipped)", () => {
  const dir = makeTree([{ id: "2026/06/03/001-ghost", phase: "data" }], { files: [] });
  assert.throws(() => loadRegistry(dir), /001-ghost/, "names the offending id");
});

test("a DUPLICATE id throws — the ledger is keyed by id, so duplicates are ambiguous", () => {
  const dir = makeTree([
    { id: "2026/06/03/001-a", phase: "data" },
    { id: "2026/06/03/001-a", phase: "data" },
  ]);
  assert.throws(() => loadRegistry(dir), /duplicate/i);
});

test("an unknown phase throws rather than defaulting to one", () => {
  const dir = makeTree([{ id: "2026/06/03/001-a", phase: "whenever" }]);
  assert.throws(() => loadRegistry(dir), /phase/i);
});

test("an id that escapes the migrations dir is refused (path-traversal guard)", () => {
  const dir = makeTree([{ id: "../../etc/passwd", phase: "data" }], { files: [] });
  assert.throws(() => loadRegistry(dir), /id/i);
});

test("an absent or malformed migrations.json throws with the path", () => {
  const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mig-reg-none-")));
  tmps.push(empty);
  assert.throws(() => loadRegistry(empty), /migrations\.json/);

  fs.writeFileSync(path.join(empty, "migrations.json"), "{ not json");
  assert.throws(() => loadRegistry(empty), /migrations\.json/);
});

test("an EMPTY registry is valid — a project with no migrations yet", () => {
  const dir = makeTree([]);
  assert.deepEqual(loadRegistry(dir), []);
});
