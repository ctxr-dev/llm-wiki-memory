// GAP1+GAP2: the REAL upgrade codepath — `cli.mjs migrate-identity` with NO ids,
// so the legacy id derives from workspaceBasename() and the new id from
// defaultProjectModule() (env MEMORY_DEFAULT_PROJECT_MODULE). Exercised as a
// subprocess so the exit-code contract (3=pending / 0=clean) and the real run's
// withWikiCommit wrapper are covered, not just the in-process function.
//
// workspaceBasename() derives from MEMORY_DIR (import.meta.url), NOT from env, so
// it is the SAME value in this process and in the cli.mjs subprocess (same src).
// We read it here and seed a leaf with it — robust on any machine.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mi-cli-")));
const dataDir = path.join(home, ".llm-wiki-memory");

process.env.MEMORY_DATA_DIR = dataDir;
process.env.MEMORY_DEFAULT_PROJECT_MODULE = "org/migrated-cli";
process.env.LLM_WIKI_NO_PROMPT = "1";

fs.mkdirSync(path.join(dataDir, "settings"), { recursive: true });
fs.writeFileSync(
  path.join(dataDir, "settings", "settings.yaml"),
  "embed:\n  backend: lexical\nconsolidate:\n  enabled: false\n",
);
const init = spawnSync(process.execPath, [path.join(SRC, "scripts/cli.mjs"), "init"], {
  env: process.env,
  encoding: "utf8",
});
if (init.status !== 0) throw new Error(`init failed: ${init.stderr || init.stdout}`);

const store = await import("../scripts/lib/wiki-store.mjs");
const { workspaceBasename } = await import("../scripts/lib/env.mjs");
after(() => fs.rmSync(home, { recursive: true, force: true }));

/** @param {string[]} args */
function cli(args) {
  return spawnSync(process.execPath, [path.join(SRC, "scripts/cli.mjs"), ...args], {
    env: process.env,
    encoding: "utf8",
  });
}

test("cli.mjs migrate-identity (no ids): default-derivation restamps a basename leaf; exit 3 pending → 0 clean", () => {
  const legacy = workspaceBasename();
  assert.ok(
    legacy && legacy !== "org/migrated-cli",
    `workspaceBasename resolved to a distinct legacy id: ${legacy}`,
  );
  const id = store.saveDocument({
    name: "legacy.md",
    text: "# legacy\n\nbody stamped with the workspace basename identity.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", area: "infra", project_module_override: legacy },
  }).created.document.id;

  const checkPending = cli(["migrate-identity", "--check"]);
  assert.equal(checkPending.status, 3, `--check exits 3 while pending: ${checkPending.stdout}`);

  const run = cli(["migrate-identity"]);
  assert.equal(run.status, 0, `the real run exits 0: ${run.stderr}`);

  const meta = /** @type {{ project_module?: string }} */ (
    store.readDocument({ documentId: id, datasetId: "knowledge" }).metadata
  );
  assert.equal(
    meta.project_module,
    "org/migrated-cli",
    "the basename leaf is restamped to defaultProjectModule() derived from the env",
  );

  const checkClean = cli(["migrate-identity", "--check"]);
  assert.equal(checkClean.status, 0, "--check exits 0 once nothing is on the legacy id");
});
