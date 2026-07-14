// Workstream C e2e — the repo-target write STAMP (C4-federated change b): a write
// dispatched to a repo-owned level lands with project_module = the resolved // chain
// identity (org/repo), a brain-target write keeps the workspace default, and an
// explicit caller override still wins. Drives the real dispatchWrite (the MCP write
// handler's core), priming the reloadable impl first. Lexical backend, realpath'd /tmp.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildFakeHome, rmAll, git } from "./federation-helpers.mjs";

const { resolveWikiContext, withWikiContext } = await import("../../scripts/lib/wiki-context.mjs");
const { parseWriteRequest, WRITE_KIND } = await import("../../scripts/lib/context/write.mjs");
const { dispatchWrite } = await import("../../mcp-server/mcp-write-dispatch.mjs");
const { loadImpl } = await import("../../mcp-server/mcp-reload.mjs");
const store = await import("../../scripts/lib/wiki-store.mjs");
const { defaultProjectModule } = await import("../../scripts/lib/env.mjs");

await loadImpl();

/** @type {string[]} */
const homes = [];
/** @type {(() => void)[]} */
const restores = [];
after(() => {
  for (const r of restores) r();
  rmAll(homes);
});

/** @param {string} dir @param {string} url */
function addOrigin(dir, url) {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.local"]);
  git(dir, ["config", "user.name", "tester"]);
  git(dir, ["remote", "add", "origin", url]);
}

async function build() {
  const built = await buildFakeHome({
    prefix: "c7-stamp",
    projectModule: "brainmod",
    mounts: [{ rel: "svc" }],
  });
  homes.push(built.home);
  restores.push(built.restore);
  const svc = built.mounts[0];
  addOrigin(svc.dir, "git@github.com:acme/svc.git");
  const ctx = resolveWikiContext([svc.dir], { home: built.home, brainDataDir: built.brainDataDir });
  return { built, svc, ctx };
}

/**
 * @param {import("../../scripts/lib/wiki-context.mjs").WikiContext} ctx
 * @param {string | undefined} target
 * @param {string} name
 * @param {Record<string, unknown>} [metadata]
 * @returns {Promise<string>} the created leaf's rel id
 */
async function writeVia(ctx, target, name, metadata = {}) {
  const req = parseWriteRequest(ctx, {
    kind: WRITE_KIND.DOCUMENT,
    dataset: "knowledge",
    name,
    text: `# ${name}\n\nbody about the repo-identity write stamp.`,
    metadata: { atom_type: "reference", area: "infra", subject: ["general"], ...metadata },
    target,
  });
  /** @type {import("../../scripts/lib/types.mjs").WriteResult} */
  let saved;
  await withWikiContext(ctx, () =>
    dispatchWrite(
      req,
      (placed) => {
        saved = store.saveDocument({
          name,
          text: req.text,
          datasetId: "knowledge",
          metadata: placed,
        });
        return saved;
      },
      { tool: "save_to_dataset", op: "c7-stamp", okFromCreated: true },
    ),
  );
  return saved.created.document.id;
}

/** @param {string} root @param {string} rel @returns {string} */
function pmOf(root, rel) {
  const body = fs.readFileSync(path.join(root, rel.split("/").join(path.sep)), "utf8");
  const m = body.match(/project_module:\s*(.+)/);
  return m ? m[1].trim() : "";
}

test("stamp: a repo-target write lands with project_module = the resolved org/repo identity", async () => {
  const { svc, ctx } = await build();
  const rel = await writeVia(ctx, svc.wikiRoot, "repo-note.md");
  assert.equal(pmOf(svc.wikiRoot, rel), "acme/svc", "repo write stamped with the chain identity");
});

test("stamp: a brain-target write keeps the workspace default, not the repo identity", async () => {
  const { built, ctx } = await build();
  const rel = await writeVia(ctx, "brain", "brain-note.md");
  assert.equal(
    pmOf(built.brainWiki, rel),
    defaultProjectModule().toLowerCase(),
    "brain write keeps defaultProjectModule (here 'brainmod'), never the repo chain",
  );
  assert.notEqual(pmOf(built.brainWiki, rel), "acme/svc");
});

test("stamp: an explicit caller project_module_override still wins over the repo identity", async () => {
  const { svc, ctx } = await build();
  const rel = await writeVia(ctx, svc.wikiRoot, "override-note.md", {
    project_module_override: "deliberate/cross-project",
  });
  assert.equal(
    pmOf(svc.wikiRoot, rel),
    "deliberate/cross-project",
    "a deliberate cross-project override is not clobbered by the auto-stamp",
  );
});

test("stamp: a repo-target write dispatched with NO active wiki context is not auto-stamped (defensive branch)", async () => {
  const { svc, ctx } = await build();
  const req = parseWriteRequest(ctx, {
    kind: WRITE_KIND.DOCUMENT,
    dataset: "knowledge",
    name: "no-ctx.md",
    text: "# no-ctx\n\nwritten with no active wiki context frame.",
    metadata: { atom_type: "reference", area: "infra", subject: ["general"] },
    target: svc.wikiRoot,
  });
  /** @type {import("../../scripts/lib/types.mjs").WriteResult} */
  let saved;
  // Deliberately NO withWikiContext wrapper → getActiveWikiContext() is null.
  await dispatchWrite(
    req,
    (placed) => {
      saved = store.saveDocument({
        name: "no-ctx.md",
        text: req.text,
        datasetId: "knowledge",
        metadata: placed,
      });
      return saved;
    },
    { tool: "save_to_dataset", op: "c7-noctx", okFromCreated: true },
  );
  const pm = pmOf(svc.wikiRoot, saved.created.document.id);
  assert.notEqual(pm, "acme/svc", "with no active context, the repo chain is NOT stamped");
  assert.equal(pm, defaultProjectModule().toLowerCase(), "falls back to the workspace default");
});
