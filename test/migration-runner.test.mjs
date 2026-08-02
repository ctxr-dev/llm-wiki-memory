// The runner: detect -> apply -> record, per phase, in registry order.
//
// The load-bearing property is that the LEDGER is only ever a speed-up. Several
// tests below deliberately lie to it (marker ahead of reality, marker corrupt,
// marker absent) and assert the outcome is still correct.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "../scripts/lib/migration-runner.mjs";
import { readLedger, ledgerPath } from "../scripts/lib/migration-ledger.mjs";

/** @type {string[]} */
const tmps = [];
after(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmps.push(d);
  return d;
}

/**
 * Write a migrations tree whose modules record their calls into a JSON side-file,
 * so a test can assert what actually ran in a child-free, in-process way.
 * @param {{ id: string, phase?: string, needed?: boolean, throws?: boolean, decision?: string }[]} specs
 */
function makeMigrations(specs) {
  const dir = tmp("mig-run-");
  const log = path.join(dir, "calls.json");
  fs.writeFileSync(log, "[]");
  fs.writeFileSync(
    path.join(dir, "migrations.json"),
    JSON.stringify({ migrations: specs.map((s) => ({ id: s.id, phase: s.phase || "data" })) }),
  );
  for (const s of specs) {
    const abs = path.join(dir, `${s.id}.mjs`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      [
        `import fs from "node:fs";`,
        `const LOG = ${JSON.stringify(log)};`,
        `const note = (what) => { const c = JSON.parse(fs.readFileSync(LOG, "utf8")); c.push(what); fs.writeFileSync(LOG, JSON.stringify(c)); };`,
        `export const id = ${JSON.stringify(s.id)};`,
        `export const title = ${JSON.stringify(`title of ${s.id}`)};`,
        s.decision ? `export const decision = ${JSON.stringify(s.decision)};` : "",
        `export function detect() { note("detect:" + id); return ${s.needed === true}; }`,
        `export function apply() { note("apply:" + id);`,
        s.throws ? `  throw new Error("boom in " + id);` : "",
        `  return { changed: true }; }`,
      ].join("\n"),
    );
  }
  return { dir, calls: () => JSON.parse(fs.readFileSync(log, "utf8")) };
}

test("a needed migration is detected, applied, and recorded", async () => {
  const dataDir = tmp("mig-data-");
  const { dir, calls } = makeMigrations([{ id: "2026/01/01/001-a", needed: true }]);
  const res = await runMigrations({ dataDir, migrationsDir: dir, phase: "data" });

  assert.deepEqual(res.applied, ["2026/01/01/001-a"]);
  assert.deepEqual(calls(), ["detect:2026/01/01/001-a", "apply:2026/01/01/001-a"]);
  assert.deepEqual(readLedger(dataDir).applied, ["2026/01/01/001-a"]);
});

test("an ALREADY-CURRENT migration is detected, NOT applied, and still recorded", async () => {
  // Recording a not-needed migration is what makes a fresh install fast forever
  // after: nothing was done, and nothing needs re-checking.
  const dataDir = tmp("mig-data-");
  const { dir, calls } = makeMigrations([{ id: "2026/01/01/001-a", needed: false }]);
  const res = await runMigrations({ dataDir, migrationsDir: dir, phase: "data" });

  assert.deepEqual(res.applied, []);
  assert.deepEqual(res.alreadyCurrent, ["2026/01/01/001-a"]);
  assert.deepEqual(calls(), ["detect:2026/01/01/001-a"], "apply is never called");
  assert.deepEqual(readLedger(dataDir).applied, ["2026/01/01/001-a"]);
});

test("the ledger FAST-PATHS a second run: no detect, no apply", async () => {
  const dataDir = tmp("mig-data-");
  const { dir, calls } = makeMigrations([{ id: "2026/01/01/001-a", needed: true }]);
  await runMigrations({ dataDir, migrationsDir: dir, phase: "data" });
  const afterFirst = calls().length;

  const res = await runMigrations({ dataDir, migrationsDir: dir, phase: "data" });
  assert.equal(calls().length, afterFirst, "the module is not even loaded again");
  assert.deepEqual(res.skipped, ["2026/01/01/001-a"]);
});

test("--remigrate ignores the ledger and re-detects everything", async () => {
  const dataDir = tmp("mig-data-");
  const { dir, calls } = makeMigrations([{ id: "2026/01/01/001-a", needed: false }]);
  await runMigrations({ dataDir, migrationsDir: dir, phase: "data" });
  calls().length;

  await runMigrations({ dataDir, migrationsDir: dir, phase: "data", remigrate: true });
  assert.deepEqual(
    calls().filter((c) => c.startsWith("detect")),
    ["detect:2026/01/01/001-a", "detect:2026/01/01/001-a"],
    "detected again despite being in the ledger",
  );
});

test("a CORRUPT ledger re-detects rather than skipping (fail-safe)", async () => {
  const dataDir = tmp("mig-data-");
  const { dir, calls } = makeMigrations([{ id: "2026/01/01/001-a", needed: true }]);
  await runMigrations({ dataDir, migrationsDir: dir, phase: "data" });
  fs.writeFileSync(ledgerPath(dataDir), "{{{ corrupt");

  await runMigrations({ dataDir, migrationsDir: dir, phase: "data" });
  assert.equal(
    calls().filter((c) => c.startsWith("detect")).length,
    2,
    "a broken marker costs a re-detection, never a skip",
  );
});

test("a marker AHEAD of reality is corrected by --remigrate — the documented escape", async () => {
  // The one dangerous drift direction: state/ survives while the data is rolled
  // back. The ledger says applied; detect() says otherwise. --remigrate is the fix.
  const dataDir = tmp("mig-data-");
  const { dir } = makeMigrations([{ id: "2026/01/01/001-a", needed: true }]);
  fs.mkdirSync(path.dirname(ledgerPath(dataDir)), { recursive: true });
  fs.writeFileSync(ledgerPath(dataDir), JSON.stringify({ applied: ["2026/01/01/001-a"] }));

  const lying = await runMigrations({ dataDir, migrationsDir: dir, phase: "data" });
  assert.deepEqual(lying.applied, [], "the fast path trusts the marker");

  const fixed = await runMigrations({
    dataDir,
    migrationsDir: dir,
    phase: "data",
    remigrate: true,
  });
  assert.deepEqual(fixed.applied, ["2026/01/01/001-a"], "--remigrate repairs it");
});

test("PHASE selects which migrations run, and order follows the registry", async () => {
  const dataDir = tmp("mig-data-");
  const { dir, calls } = makeMigrations([
    { id: "2026/01/01/001-s", phase: "settings", needed: true },
    { id: "2026/01/02/002-d", phase: "data", needed: true },
    { id: "2026/01/03/003-s", phase: "settings", needed: true },
  ]);
  await runMigrations({ dataDir, migrationsDir: dir, phase: "settings" });
  assert.deepEqual(
    calls().filter((c) => c.startsWith("apply")),
    ["apply:2026/01/01/001-s", "apply:2026/01/03/003-s"],
    "only the settings phase, in registry order",
  );
});

test("a FAILING migration ABORTS the run and is NOT recorded", async () => {
  // Half-migrated-and-quiet is the worst outcome; the same reasoning
  // migrate-settings already documents for its own abort.
  const dataDir = tmp("mig-data-");
  const { dir, calls } = makeMigrations([
    { id: "2026/01/01/001-ok", needed: true },
    { id: "2026/01/02/002-bad", needed: true, throws: true },
    { id: "2026/01/03/003-never", needed: true },
  ]);
  await assert.rejects(
    () => runMigrations({ dataDir, migrationsDir: dir, phase: "data" }),
    /002-bad/,
    "the failure names the migration",
  );
  assert.ok(!calls().includes("detect:2026/01/03/003-never"), "later migrations do not run");
  assert.deepEqual(
    readLedger(dataDir).applied,
    ["2026/01/01/001-ok"],
    "the successful prefix IS recorded; the failure is not",
  );
});

test("decisions are collected from APPLIED migrations only, for the caller to print", async () => {
  const dataDir = tmp("mig-data-");
  const { dir } = makeMigrations([
    { id: "2026/01/01/001-a", needed: true, decision: "kept bge-large" },
    { id: "2026/01/02/002-b", needed: false, decision: "not surfaced — nothing changed" },
    { id: "2026/01/03/003-c", needed: true },
  ]);
  const res = await runMigrations({ dataDir, migrationsDir: dir, phase: "data" });
  assert.deepEqual(res.decisions, [{ id: "2026/01/01/001-a", decision: "kept bge-large" }]);
});

test("an empty registry is a clean no-op", async () => {
  const dataDir = tmp("mig-data-");
  const { dir } = makeMigrations([]);
  const res = await runMigrations({ dataDir, migrationsDir: dir, phase: "data" });
  assert.deepEqual(res, { applied: [], alreadyCurrent: [], skipped: [], decisions: [] });
});
