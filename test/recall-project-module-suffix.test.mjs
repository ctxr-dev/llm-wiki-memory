import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir } = setupWorkspace();
const store = await import("../scripts/lib/wiki-store.mjs");
after(() => cleanup(dataDir));

/** @param {string} name @param {string} chain @param {string} token */
function seed(name, chain, token) {
  store.saveDocument({
    name,
    text: `# ${name}\n\n${token} body for ${name}.`,
    datasetId: "knowledge",
    metadata: { atom_type: "reference", project_module_override: chain },
  });
}

/** @param {string} token @param {string} projectModule */
async function find(token, projectModule) {
  const { records } = await store.searchMemoryFiltered({
    query: token,
    datasetId: "knowledge",
    filters: { project_module: projectModule },
    limit: 10,
  });
  return records.map((/** @type {{ documentName: string }} */ r) => r.documentName);
}

test("recall suffix-match: a project_module filter matches the INNERMOST segment of a // chain", async () => {
  seed("chainleaf.md", "org/acme//org2/core", "quokkachain");
  assert.ok((await find("quokkachain", "org2/core")).includes("chainleaf.md"), "innermost segment");
  assert.ok(
    (await find("quokkachain", "org/acme//org2/core")).includes("chainleaf.md"),
    "full chain (exact)",
  );
  assert.ok(
    (await find("quokkachain", "org2/core")).includes("chainleaf.md") &&
      !(await find("quokkachain", "org/other")).includes("chainleaf.md"),
    "a non-suffix segment does not match",
  );
});

test("recall suffix-match: a single-segment project_module matches exactly, not by substring (no regression)", async () => {
  seed("singleleaf.md", "solo/repo", "quokkasolo");
  assert.ok((await find("quokkasolo", "solo/repo")).includes("singleleaf.md"), "exact match");
  assert.ok(
    !(await find("quokkasolo", "repo")).includes("singleleaf.md"),
    "the in-segment '/repo' is not a '//' chain suffix — no false match",
  );
});
