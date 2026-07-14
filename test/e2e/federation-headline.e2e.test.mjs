// Workstream J5 — the HEADLINE shared-knowledge scenario, driven through the FULL
// registered write chain (withToolScopes → gateRefusal → parseWriteRequest →
// dispatchWrite → store) exactly as tools-write.mjs does, over a real brain+repo
// context. No prior test threads the whole chain OR asserts right-tree + right-
// identity + zero-git-on-the-repo TOGETHER — this one does.
//
// CRITICAL: withToolScopes reads the engine's DEFAULT home (os.homedir()) and
// MEMORY_DATA_DIR — both frozen at engine-import time. So the fake $HOME +
// MEMORY_DATA_DIR MUST be set (via buildFakeHome) BEFORE the engine is imported,
// or a brain-target write would resolve against the real data dir and pollute it.
// buildFakeHome runs first here for exactly that reason.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildFakeHome, rmAll, git, commitCount, lsFiles } from "./federation-helpers.mjs";

// (1) Fixture FIRST — sets HOME + MEMORY_DATA_DIR + lexical backend before imports.
const fake = await buildFakeHome({
  prefix: "j5-headline",
  projectModule: "brainmod",
  mounts: [{ rel: "svc", template: "repo" }],
});
const svc = fake.mounts[0];
// A real git repo at the mount with an origin remote (README committed, wiki left
// untracked) so the identity resolves to acme/svc and staged-only is observable.
git(svc.dir, ["init", "-q"]);
git(svc.dir, ["config", "user.email", "t@t.local"]);
git(svc.dir, ["config", "user.name", "tester"]);
git(svc.dir, ["remote", "add", "origin", "git@github.com:acme/svc.git"]);
fs.writeFileSync(path.join(svc.dir, "README.md"), "ok\n");
git(svc.dir, ["add", "README.md"]);
git(svc.dir, ["commit", "-q", "-m", "init"]);

// (2) Engine imports AFTER the fixture — they capture the fake HOME/MEMORY_DATA_DIR.
const { withToolScopes } = await import("../../mcp-server/mcp-scopes.mjs");
const { gateRefusal, dispatchWrite } = await import("../../mcp-server/mcp-write-dispatch.mjs");
const { parseWriteRequest, WRITE_KIND } = await import("../../scripts/lib/context/write.mjs");
const { getActiveWikiContext } = await import("../../scripts/lib/wiki-context.mjs");
const { MCP_OPS } = await import("../../scripts/lib/context/enums.mjs");
const { loadImpl } = await import("../../mcp-server/mcp-reload.mjs");
const store = await import("../../scripts/lib/wiki-store.mjs");
const { defaultProjectModule } = await import("../../scripts/lib/env.mjs");

await loadImpl();

after(() => {
  fake.restore();
  rmAll([fake.home]);
});

/** Drive the FULL registered save_to_dataset chain, returning the dispatched envelope.
 * @param {string} target @param {string} name */
function saveViaFullChain(target, name) {
  return withToolScopes({ scopes: [svc.dir] }, async () => {
    const refusal = gateRefusal({
      tool: "save_to_dataset",
      dataset: "knowledge",
      name,
      metadata: {},
    });
    assert.equal(refusal, null, "knowledge is not gated → gateRefusal returns null");
    const req = parseWriteRequest(getActiveWikiContext(), {
      kind: WRITE_KIND.DOCUMENT,
      dataset: "knowledge",
      name,
      text: `# ${name}\n\nheadline shared-knowledge routing body.`,
      metadata: { atom_type: "reference", area: "infra", subject: ["general"] },
      target,
    });
    return dispatchWrite(
      req,
      (placed) =>
        store.saveDocument({ name, text: req.text, datasetId: "knowledge", metadata: placed }),
      { tool: "save_to_dataset", op: MCP_OPS.SAVE, okFromCreated: true },
    );
  });
}

/** dispatchWrite returns an MCP content envelope; the write payload is the JSON text inside.
 * @param {{ content: Array<{ text: string }> }} res */
const payloadOf = (res) => JSON.parse(res.content[0].text);
/** @param {string} root @param {string} rel */
const exists = (root, rel) => fs.existsSync(path.join(root, rel.split("/").join(path.sep)));
/** @param {string} root @param {string} rel */
function pmOf(root, rel) {
  const m = fs
    .readFileSync(path.join(root, rel.split("/").join(path.sep)), "utf8")
    .match(/project_module:\s*(.+)/);
  return m ? m[1].trim() : "";
}

test("J5: brain-target write lands in the BRAIN with the workspace identity — repo untouched", async () => {
  const beforeCommits = commitCount(svc.dir);
  const p = payloadOf(await saveViaFullChain("brain", "j5-brain-note.md"));
  const rel = p.created.document.id;
  assert.ok(exists(fake.brainWiki, rel), "leaf is in the brain tree");
  assert.ok(!exists(svc.wikiRoot, rel), "leaf is NOT in the repo tree");
  assert.equal(
    pmOf(fake.brainWiki, rel),
    defaultProjectModule().toLowerCase(),
    "workspace identity",
  );
  assert.equal(commitCount(svc.dir), beforeCommits, "the team repo's git is untouched");
  assert.ok(!p.sharedTarget, "a brain write carries no shared-target annotation");
});

test("J5: repo-target write → RIGHT tree + RIGHT identity + ZERO git on the repo + a 'commit and push' note, all together", async () => {
  const beforeCommits = commitCount(svc.dir);
  const beforeTracked = lsFiles(svc.dir);
  const p = payloadOf(await saveViaFullChain(svc.wikiRoot, "j5-repo-note.md"));
  const rel = p.created.document.id;
  // right tree
  assert.ok(exists(svc.wikiRoot, rel), "leaf is in the repo's wiki tree");
  assert.ok(!exists(fake.brainWiki, rel), "leaf is NOT in the brain tree");
  // right identity (the org/repo from the origin remote, not the brain default)
  assert.equal(pmOf(svc.wikiRoot, rel), "acme/svc", "stamped with the repo's org/repo identity");
  // zero git on the team repo (R11): no new commit, no new TRACKED file (leaf staged only)
  assert.equal(commitCount(svc.dir), beforeCommits, "no new commit in the team repo");
  assert.deepEqual(
    lsFiles(svc.dir),
    beforeTracked,
    "no new tracked file — the leaf is only staged",
  );
  // the note
  assert.ok(p.sharedTarget && p.sharedTarget.repo === "acme/svc", "sharedTarget names the repo");
  assert.match(String(p.message), /commit and push/, "tells the user to commit and push it");
});

test("J5: an out-of-scope target is REFUSED (never a silent mis-route)", async () => {
  const elsewhere = path.join(path.dirname(svc.dir), "not-in-scope", ".llm-wiki-memory", "wiki");
  await assert.rejects(
    () => saveViaFullChain(elsewhere, "j5-nope.md"),
    /not one of the active context levels|target/i,
    "a target outside the resolved scope chain is rejected, not silently redirected",
  );
});
