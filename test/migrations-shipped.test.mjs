// The SHIPPED migrations, driven against real tmp installs.
//
// The tree gates check shape; these check behaviour: a stale install is detected
// and repaired, a current one is left alone, and running twice is harmless. This
// is the contract every future migration must also satisfy (see
// .agents/rules/release-migrations-authoring.md).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SRC } from "./harness.mjs";
import { runMigrations } from "../scripts/lib/migration-runner.mjs";
import { readLedger } from "../scripts/lib/migration-ledger.mjs";

const MIGRATIONS = path.join(SRC, "scripts", "migrations");

/** @type {string[]} */
const tmps = [];
after(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
});

/** A data dir in the shape the argument describes. */
function makeInstall({ legacy = false } = {}) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mig-shipped-")));
  tmps.push(dataDir);
  const settings = path.join(dataDir, "settings");
  fs.mkdirSync(settings, { recursive: true });
  if (legacy) {
    // The pre-2026-06-03 shape: provider config in its own llm.yaml, no settings.yaml.
    fs.writeFileSync(path.join(settings, "llm.yaml"), "provider: mock\n");
    fs.writeFileSync(path.join(settings, ".env"), "MEMORY_LLM_PROVIDER=mock\n");
  } else {
    fs.writeFileSync(path.join(settings, "settings.yaml"), "embed:\n  backend: lexical\n");
  }
  return dataDir;
}

test("a LEGACY install is detected and repaired by the settings-phase migration", async () => {
  const dataDir = makeInstall({ legacy: true });
  const res = await runMigrations({ dataDir, migrationsDir: MIGRATIONS, phase: "settings" });

  assert.deepEqual(res.applied, ["2026/06/03/001-settings-yaml"], "the stale shape was migrated");
  assert.ok(
    fs.existsSync(path.join(dataDir, "settings", "settings.yaml")),
    "settings.yaml now exists — the migration actually did the work",
  );
  assert.deepEqual(readLedger(dataDir).applied, ["2026/06/03/001-settings-yaml"]);
});

test("a CURRENT install is detected as already-settled and left untouched", async () => {
  const dataDir = makeInstall();
  const before = fs.readFileSync(path.join(dataDir, "settings", "settings.yaml"), "utf8");
  const res = await runMigrations({ dataDir, migrationsDir: MIGRATIONS, phase: "settings" });

  assert.deepEqual(res.applied, [], "nothing applied");
  assert.deepEqual(res.alreadyCurrent, ["2026/06/03/001-settings-yaml"]);
  assert.equal(
    fs.readFileSync(path.join(dataDir, "settings", "settings.yaml"), "utf8"),
    before,
    "a settled install is byte-identical afterwards",
  );
});

test("re-running over a just-migrated install is a clean no-op (idempotence)", async () => {
  const dataDir = makeInstall({ legacy: true });
  await runMigrations({ dataDir, migrationsDir: MIGRATIONS, phase: "settings" });
  const afterFirst = fs.readFileSync(path.join(dataDir, "settings", "settings.yaml"), "utf8");

  // --remigrate so the ledger cannot mask a non-idempotent apply().
  const second = await runMigrations({
    dataDir,
    migrationsDir: MIGRATIONS,
    phase: "settings",
    remigrate: true,
  });
  assert.deepEqual(second.applied, [], "the second pass detects nothing left to do");
  assert.equal(
    fs.readFileSync(path.join(dataDir, "settings", "settings.yaml"), "utf8"),
    afterFirst,
    "and changed no bytes",
  );
});

test("detect() is READ-ONLY — a detection pass alone never mutates the install", async () => {
  const dataDir = makeInstall({ legacy: true });
  const snapshot = fs.readdirSync(path.join(dataDir, "settings")).sort();
  const { loadRegistry } = await import("../scripts/lib/migration-registry.mjs");
  for (const entry of loadRegistry(MIGRATIONS, { phase: "settings" })) {
    const mod = await import(entry.file);
    await mod.detect({ dataDir });
  }
  assert.deepEqual(
    fs.readdirSync(path.join(dataDir, "settings")).sort(),
    snapshot,
    "detect() must be safe to call on every bootstrap, forever",
  );
});
