// Workstream J10 + J14 — multi-level LIFECYCLE over a federated stack.
//
// J10: removing ONE repo's wiki out of band drops it from the resolved chain
// while the brain and the OTHER repo persist — their leaves stay on disk,
// targetable, and searchable, and the removed repo's root is refused as a
// write target and never surfaces in a fan-out search.
//
// J14: a cross-level mutate (disable) hits the TARGETED level only — a
// same-named leaf at a different level is untouched — and a mutate directed at
// an out-of-scope root is refused loudly. Real seams (resolveWikiContext +
// withWriteTarget + the store's disable/move mutators), lexical backend,
// realpath'd temp HOME. All leaf names are prefixed `j1014-`.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SRC } from "../harness.mjs";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-j1014-")));
const brainData = path.join(home, ".llm-wiki-memory");
process.env.MEMORY_DATA_DIR = brainData;
process.env.MEMORY_DEFAULT_PROJECT_MODULE = "brainmod";
process.env.LLM_WIKI_SKILL_CLI = path.join(
  SRC,
  "node_modules/@ctxr/skill-llm-wiki/scripts/cli.mjs",
);
process.env.LLM_WIKI_FIXED_TIMESTAMP = process.env.LLM_WIKI_FIXED_TIMESTAMP || "1700000000";
process.env.LLM_WIKI_NO_PROMPT = "1";

/** @param {string} dataDir */
function initWikiAt(dataDir) {
  fs.mkdirSync(path.join(dataDir, "settings"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "settings", "settings.yaml"),
    "embed:\n  backend: lexical\nwiki:\n  autoCommit: true\nconsolidate:\n  enabled: false\n",
  );
  const r = spawnSync(process.execPath, [path.join(SRC, "scripts/cli.mjs"), "init"], {
    env: { ...process.env, MEMORY_DATA_DIR: dataDir },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`init failed for ${dataDir}: ${r.stderr || r.stdout}`);
}
/** @param {string} mountDir @param {string} [origin] */
function makeMount(mountDir, origin) {
  fs.mkdirSync(mountDir, { recursive: true });
  initWikiAt(path.join(mountDir, ".llm-wiki-memory"));
  spawnSync("git", ["-C", mountDir, "init", "-q"], { encoding: "utf8" });
  spawnSync("git", ["-C", mountDir, "config", "user.email", "t@t.local"], { encoding: "utf8" });
  spawnSync("git", ["-C", mountDir, "config", "user.name", "t"], { encoding: "utf8" });
  if (origin)
    spawnSync("git", ["-C", mountDir, "remote", "add", "origin", origin], { encoding: "utf8" });
}
initWikiAt(brainData);

const store = await import("../../scripts/lib/wiki-store.mjs");
const { searchMemoryFiltered } = store;
const { readLeaf, leafMemory, isActive } = await import("../../scripts/lib/wiki-core.mjs");
const { withWikiCommit } = await import("../../scripts/lib/wiki-commit.mjs");
const { resolveWikiContext, withWikiContext } = await import("../../scripts/lib/wiki-context.mjs");
const { withWriteTarget } = await import("../../mcp-server/mcp-write-target.mjs");

after(() => fs.rmSync(home, { recursive: true, force: true }));

const opts = { home, brainDataDir: brainData };
const abs = (/** @type {string} */ r, /** @type {string} */ id) =>
  path.join(r, id.split("/").join(path.sep));
/** @param {ReturnType<typeof resolveWikiContext>} ctx @param {string|undefined} target @param {string} name @param {string} token */
function saveTo(ctx, target, name, token) {
  const metadata = { atom_type: "reference", area: "infra", subject: ["general"] };
  const res = withWikiContext(ctx, () =>
    withWriteTarget(target, () =>
      withWikiCommit({ op: "j1014", actor: "test" }, () =>
        store.saveDocument({
          name,
          text: `# ${name}\n\nquokka ${token} body`,
          datasetId: "knowledge",
          metadata,
        }),
      ),
    ),
  );
  return res.created.document.id;
}
/** @param {string} root @param {string} id */
const statusActive = (root, id) => isActive(readLeaf(abs(root, id)).data);
/** @param {string} root @param {string} id */
const statusOf = (root, id) => leafMemory(readLeaf(abs(root, id)).data).status;

test("J10: removing ONE repo's wiki drops it from the chain — brain + other repo persist, are targetable + searchable, and the gone repo is refused", async () => {
  const A = path.join(home, "j10", "aaa");
  const B = path.join(home, "j10", "bbb");
  makeMount(A, "git@github.com:acme/aaa.git");
  makeMount(B, "git@github.com:acme/bbb.git");

  const ctx1 = resolveWikiContext([A, B], opts);
  assert.equal(ctx1.levels.length, 3, "brain + repo A + repo B");
  const brainLevel = ctx1.levels[0];
  const aLevel1 = ctx1.levels.find((l) => l.projectModule === "acme/aaa");
  const bLevel1 = ctx1.levels.find((l) => l.projectModule === "acme/bbb");
  assert.ok(aLevel1 && bLevel1, "both repo levels resolved");

  const idA = saveTo(ctx1, aLevel1.root, "j1014-a.md", "aaatok");
  const idB = saveTo(ctx1, bLevel1.root, "j1014-b.md", "bbbtok");
  const idBrain = saveTo(ctx1, brainLevel.root, "j1014-brain.md", "braintok");
  assert.ok(fs.existsSync(abs(aLevel1.root, idA)), "A leaf seeded in A's tree");
  assert.ok(fs.existsSync(abs(bLevel1.root, idB)), "B leaf seeded in B's tree");
  assert.ok(fs.existsSync(abs(brainLevel.root, idBrain)), "brain leaf seeded in the brain");

  const oldBRoot = bLevel1.root;

  // Repo B is decommissioned: its whole `.llm-wiki-memory` mount is removed out
  // of band (the brain and repo A are untouched on disk).
  fs.rmSync(path.join(B, ".llm-wiki-memory"), { recursive: true, force: true });

  const ctx2 = resolveWikiContext([A, B], opts);
  assert.equal(ctx2.levels.length, 2, "B is gone — only brain + repo A remain");
  assert.ok(
    !ctx2.levels.some((l) => l.root === oldBRoot),
    "repo B's old root is no longer in the chain",
  );
  const brainLevel2 = ctx2.levels[0];
  const aLevel2 = ctx2.levels.find((l) => l.projectModule === "acme/aaa");
  assert.ok(aLevel2, "repo A still resolves");

  // Targeting B's now-orphaned root is refused (not in the active chain).
  assert.throws(
    () => withWikiContext(ctx2, () => withWriteTarget(oldBRoot, () => undefined)),
    /not one of the active context levels/,
    "a write directed at the removed repo's root throws",
  );

  // Repo A stays targetable: a fresh save lands in A's tree under ctx2.
  const idA2 = saveTo(ctx2, aLevel2.root, "j1014-a2.md", "aaa2tok");
  assert.ok(fs.existsSync(abs(aLevel2.root, idA2)), "A is still targetable after B's removal");

  // A's original leaf and the brain leaf survive on disk.
  assert.ok(fs.existsSync(abs(aLevel2.root, idA)), "A's original leaf survives");
  assert.ok(fs.existsSync(abs(brainLevel2.root, idBrain)), "the brain leaf survives");

  // Both survivors stay searchable under ctx2, each attributed to its own tree.
  const foundA = await withWikiContext(ctx2, () =>
    searchMemoryFiltered({ query: "aaatok", datasetId: "knowledge" }),
  );
  assert.ok(
    foundA.records.some((r) => r.documentName === "j1014-a.md" && r.resolvedRoot === aLevel2.root),
    "A's leaf is searchable under ctx2 (attributed to A's tree)",
  );
  const foundBrain = await withWikiContext(ctx2, () =>
    searchMemoryFiltered({ query: "braintok", datasetId: "knowledge" }),
  );
  assert.ok(
    foundBrain.records.some(
      (r) => r.documentName === "j1014-brain.md" && r.resolvedRoot === brainLevel2.root,
    ),
    "the brain leaf is searchable under ctx2 (attributed to the brain)",
  );

  // The removed repo's leaf never surfaces — its whole tree left the chain.
  const foundB = await withWikiContext(ctx2, () =>
    searchMemoryFiltered({ query: "bbbtok", datasetId: "knowledge" }),
  );
  assert.ok(
    !foundB.records.some((r) => r.documentName === "j1014-b.md"),
    "the removed repo's leaf is never surfaced under ctx2",
  );
});

test("J14: a cross-level disable archives the TARGETED level's leaf while the same-named brain leaf stays active", () => {
  const svc = path.join(home, "j14", "svc");
  makeMount(svc, "git@github.com:acme/svc.git");
  const ctx = resolveWikiContext([svc], opts);
  assert.equal(ctx.levels.length, 2, "brain + svc");
  const brainRoot = ctx.brain.root;
  const svcLevel = ctx.levels.find((l) => l.projectModule === "acme/svc");
  assert.ok(svcLevel, "svc level resolved");
  const svcRoot = svcLevel.root;

  // The SAME leaf name at BOTH levels: identical metadata → identical rel id, so
  // the level (not the id) is what disambiguates which one a mutate touches.
  const brainId = saveTo(ctx, brainRoot, "j1014-dup.md", "duptok");
  const svcId = saveTo(ctx, svcRoot, "j1014-dup.md", "duptok");
  assert.equal(brainId, svcId, "same name + metadata → same rel id at both levels");
  assert.ok(fs.existsSync(abs(brainRoot, brainId)), "brain copy seeded");
  assert.ok(fs.existsSync(abs(svcRoot, svcId)), "svc copy seeded");
  assert.ok(statusActive(brainRoot, brainId), "brain copy starts active");
  assert.ok(statusActive(svcRoot, svcId), "svc copy starts active");

  // Disable the leaf with target=svc: the mutator resolves the id against the
  // svc root only (withWriteTarget pins the active wiki root).
  const res = withWikiContext(ctx, () =>
    withWriteTarget(svcRoot, () =>
      withWikiCommit({ op: "j1014-disable", actor: "test" }, () =>
        store.disableDocument({ documentId: svcId }),
      ),
    ),
  );
  assert.equal(res.ok, true, "disable succeeded against the svc level");
  assert.equal(res.status, "archived", "svc leaf reported archived");

  // The targeted level flipped to archived; the same-named brain leaf is untouched.
  assert.equal(statusOf(svcRoot, svcId), "archived", "svc leaf is archived");
  assert.ok(!statusActive(svcRoot, svcId), "svc leaf is no longer active");
  assert.ok(
    statusActive(brainRoot, brainId),
    "the same-named brain leaf is UNTOUCHED (still active)",
  );
});

test("J14: a mutate directed at an out-of-scope root is refused loudly", () => {
  const svc = path.join(home, "j14r", "svc");
  makeMount(svc, "git@github.com:acme/svc-r.git");
  const ctx = resolveWikiContext([svc], opts);
  const svcLevel = ctx.levels.find((l) => l.projectModule === "acme/svc-r");
  assert.ok(svcLevel, "svc level resolved");
  const id = saveTo(ctx, svcLevel.root, "j1014-scoped.md", "scopedtok");

  const outsider = path.join(home, "j14r", "not-a-mounted-level");
  assert.throws(
    () =>
      withWikiContext(ctx, () =>
        withWriteTarget(outsider, () => store.disableDocument({ documentId: id })),
      ),
    /not one of the active context levels/,
    "a mutate to a root outside the active chain throws before any write",
  );
  // The would-be-targeted leaf is untouched — the refusal happens at target
  // resolution, before the mutator runs.
  assert.ok(
    statusActive(svcLevel.root, id),
    "the leaf stays active after a refused out-of-scope mutate",
  );
});

// J14 move sub-case: SKIPPED, and here's why. `moveDocument` takes no level
// selector — it resolves BOTH its source and destination against the active
// wiki root (the level pinned by `withWriteTarget`), so a move is level-bounded
// by construction: a "cross-level" move is not even expressible through this
// API. The default `knowledge` category is also FACET-placed, so `moveDocument`
// refuses a free-path relocate of it outright (that's the assertion below),
// meaning there is no clean in-level relocate to demonstrate without editing the
// layout to add a curated free-path category (out of scope — one file only).
// The disable cross-level test above is the priority and covers J14's core.
test("J14: move_document refuses a free-path relocate of the facet-placed knowledge category (move sub-case documented as skipped)", () => {
  const svc = path.join(home, "j14m", "svc");
  makeMount(svc, "git@github.com:acme/svc-m.git");
  const ctx = resolveWikiContext([svc], opts);
  const svcLevel = ctx.levels.find((l) => l.projectModule === "acme/svc-m");
  assert.ok(svcLevel, "svc level resolved");
  const id = saveTo(ctx, svcLevel.root, "j1014-move.md", "movetok");

  const res = withWikiContext(ctx, () =>
    withWriteTarget(svcLevel.root, () =>
      store.moveDocument({ documentId: id, toPath: "knowledge/relocated/j1014-move.md" }),
    ),
  );
  assert.equal(res.ok, false, "a free-path move of a facet-placed category is refused");
  assert.match(res.reason, /facet/i, "the refusal names the facet-placement regime");
  assert.ok(fs.existsSync(abs(svcLevel.root, id)), "the leaf is left in place by the refused move");
});
