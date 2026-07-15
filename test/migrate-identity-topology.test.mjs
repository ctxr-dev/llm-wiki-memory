// migrate-identity topology guard — a topology (issues) category leaf must NOT be
// restamped (they nest by the path-compiler, not the facet contract; the guard at
// collectLegacyCandidates deletes-no-test otherwise). Needs a tracker-issues wiki,
// so it lives apart from the default-layout migrate-identity.test.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mi-topo-")));
const dataDir = path.join(home, ".llm-wiki-memory");
process.env.MEMORY_DATA_DIR = dataDir;
process.env.MEMORY_DEFAULT_PROJECT_MODULE = "mitopo";
fs.mkdirSync(path.join(dataDir, "settings"), { recursive: true });
fs.writeFileSync(
  path.join(dataDir, "settings", "settings.yaml"),
  "embed:\n  backend: lexical\nconsolidate:\n  enabled: false\n",
);
const init = spawnSync(
  process.execPath,
  [path.join(SRC, "scripts/cli.mjs"), "init", "--template", "tracker-issues"],
  { env: { ...process.env, MEMORY_DATA_DIR: dataDir }, encoding: "utf8" },
);
if (init.status !== 0) throw new Error(`init failed: ${init.stderr || init.stdout}`);

const store = await import("../scripts/lib/wiki-store.mjs");
const { migrateProjectModuleIdentity } = await import("../scripts/migrate-identity.mjs");
after(() => fs.rmSync(home, { recursive: true, force: true }));

const wiki = path.join(dataDir, "wiki");

test("migrate-identity: a topology (issues) leaf on the legacy id is NOT restamped (guard tested)", () => {
  assert.equal(
    store.categoryHasTopology("issues"),
    true,
    "issues is a topology category under the tracker-issues template",
  );
  // A migratable knowledge leaf on the legacy id.
  store.saveDocument({
    name: "k.md",
    text: "# k\n\nmigratable knowledge body.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", area: "infra", project_module_override: "mitopo" },
  });
  // A RAW topology leaf under issues/ tagged with the legacy id (listDocuments still
  // enumerates it; the guard must skip it BEFORE any restamp).
  const issuesLeaf = path.join(wiki, "issues", "JIRA", "DEV", "1", "2", "3", "DEV-123.md");
  fs.mkdirSync(path.dirname(issuesLeaf), { recursive: true });
  fs.writeFileSync(
    issuesLeaf,
    "---\nmemory:\n  atom_type: reference\n  project_module: mitopo\n---\n\ntracker fact.\n",
  );

  const res = migrateProjectModuleIdentity({ newId: "org/new", oldId: "mitopo" });
  assert.equal(res.mode, "migrate");
  assert.ok(res.migrated >= 1, "the knowledge leaf WAS restamped");
  assert.match(
    fs.readFileSync(issuesLeaf, "utf8"),
    /project_module: mitopo/,
    "the topology leaf keeps its legacy project_module — the guard skipped it",
  );
});
