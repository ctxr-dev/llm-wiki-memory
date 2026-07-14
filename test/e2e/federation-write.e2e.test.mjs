// Phase M e2e — federation WRITE/MUTATE path, driven through the REAL MCP tool
// composition (withToolScopes → withWriteTarget → withWikiCommit → the store
// writers). Proves the user-locked invariants: a default write lands in the
// brain and advances the brain's OWN git; an explicit shared target stages a
// working-tree file and runs ZERO git against the shared repo (R11); a mutate
// routes by the mount's relative id; and cron consolidate stays brain-only.
//
// §6 items: (4) default→brain + brain commit +1, (5) shared write zero-git,
// (6) mutate hits the mount leaf not the brain's, (8) cron isolation + refusal.

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "../harness.mjs";
import {
  realTmp,
  rmAll,
  mkdirp,
  gitInit,
  gitCommitAll,
  commitCount,
  lsFiles,
  porcelain,
  writeMountLayout,
} from "./federation-helpers.mjs";

const { dataDir, wiki: brainWiki } = setupWorkspace();
const { withToolScopes } = await import("../../mcp-server/mcp-scopes.mjs");
const { withWriteTarget, annotateSharedWrite } =
  await import("../../mcp-server/mcp-write-target.mjs");
const { withWikiCommit, _resetGitProbeCache } = await import("../../scripts/lib/wiki-commit.mjs");
const { withWikiRoot } = await import("../../scripts/lib/env.mjs");
const { resolveWikiContext, withWikiContext } = await import("../../scripts/lib/wiki-context.mjs");
const { resetLayoutCache } = await import("../../scripts/lib/wiki-layout-state.mjs");
const store = await import("../../scripts/lib/wiki-store.mjs");
const { initMount } = await import("../../scripts/mount-init.mjs");
const { consolidateMemory } = await import("../../scripts/consolidate.mjs");
const { SHARED_TARGET_ERROR } = await import("../../scripts/consolidate-isolation.mjs");

const MOUNT_LAYOUT = "layout:\n  - path: knowledge\n  - path: daily\n";
const FROZEN_NOW = new Date("2026-06-02T12:00:00Z");
const REF_META = { atom_type: "reference", project_module: "fedwrite", area: "infra" };

/** @type {string[]} */
const tmps = [];
/** @type {string | undefined} */
let savedHome;
before(() => {
  savedHome = process.env.HOME;
});
after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  cleanup(dataDir);
  rmAll(tmps);
});

/**
 * @param {string} prefix
 * @returns {string} a fresh HOME (also pointed at by process.env.HOME)
 */
function freshHome(prefix) {
  const home = realTmp(prefix);
  tmps.push(home);
  process.env.HOME = home;
  return home;
}

/**
 * Active/archived leaf names under a specific wiki root.
 * @param {string} root
 * @param {boolean} enabled
 * @returns {string[]}
 */
function namesUnder(root, enabled) {
  return /** @type {string[]} */ (
    withWikiRoot(root, () =>
      store
        .listDocuments({ datasetId: "knowledge", enabled })
        .documents.map((/** @type {{ name: string }} */ d) => d.name)
        .sort(),
    )
  );
}

// §6.4 — an explicit brain-target write lands in the brain; the brain's own git advances --
test("write: an explicit brain target lands in the brain and advances the brain's git by one", () => {
  gitInit(brainWiki);
  gitCommitAll(brainWiki, "brain baseline");
  _resetGitProbeCache();
  const home = freshHome("w-brain");
  const repoDir = mkdirp(home, "repo");
  writeMountLayout(repoDir, MOUNT_LAYOUT);
  const before = commitCount(brainWiki);

  const res = /** @type {{ created?: { document?: { id?: string } } }} */ (
    withToolScopes({ scopes: [repoDir] }, () =>
      withWriteTarget("brain", () =>
        withWikiCommit({ op: "e2e-brain-write", actor: "test" }, () =>
          store.saveDocument({
            name: "brain-note.md",
            text: "# Brain note\n\nDefault writes stay private.\n",
            datasetId: "knowledge",
            metadata: REF_META,
          }),
        ),
      ),
    )
  );

  const id = res.created?.document?.id ?? "";
  assert.ok(id.endsWith("brain-note.md"), "leaf id returned");
  assert.ok(fs.existsSync(path.join(brainWiki, id)), "leaf physically lives in the brain tree");
  assert.equal(commitCount(brainWiki), before + 1, "brain git advanced by exactly one commit");
});

// §6.5 — an explicit shared target stages a file and runs ZERO git (R11) --------
test("write: an explicit shared target stages a working-tree file and never runs git", () => {
  const home = freshHome("w-shared");
  const repo = mkdirp(home, "proj");
  gitInit(repo);
  initMount(repo); // seeds the repo template (knowledge, ownership: repo) + gitignore
  gitCommitAll(repo, "repo baseline (tracked layout + gitignore)");
  _resetGitProbeCache();
  const beforeCount = commitCount(repo);
  const beforeTracked = lsFiles(repo);

  const res = /** @type {Record<string, unknown>} */ (
    withToolScopes({ scopes: [repo] }, () =>
      withWriteTarget(repo, (level) =>
        annotateSharedWrite(
          level,
          /** @type {Record<string, unknown>} */ (
            withWikiCommit({ op: "e2e-shared-write", actor: "test" }, () =>
              store.saveDocument({
                name: "shared-note.md",
                text: "# Shared note\n\nStaged for the user to commit.\n",
                datasetId: "knowledge",
                metadata: REF_META,
              }),
            )
          ),
        ),
      ),
    )
  );

  assert.equal(commitCount(repo), beforeCount, "the shared repo HEAD never moved (zero git)");
  assert.deepEqual(
    lsFiles(repo),
    beforeTracked,
    "the git index is byte-identical (nothing staged)",
  );
  assert.ok(
    /\?\?\s+.*knowledge\/.*shared-note\.md/.test(porcelain(repo)),
    "the shared leaf is an UNTRACKED working-tree file (?? in status)",
  );
  assert.ok(
    !lsFiles(repo).some((f) => f.includes("shared-note.md")),
    "the shared leaf is never tracked by the engine",
  );
  const shared = /** @type {{ repo?: string }} */ (res.sharedTarget);
  assert.ok(shared && shared.repo, "the response carries a sharedTarget note");
  assert.match(String(res.message), /commit and push/, "the caller is told to commit and push");
});

// §6.6 — a mutate with a relative id + explicit scope hits the MOUNT leaf --------
test("mutate: disable with a mount target hits the mount leaf, not the brain's same-path leaf", () => {
  const home = freshHome("w-mutate");
  const mountWiki = writeMountLayout(mkdirp(home, "repo"), MOUNT_LAYOUT);
  const rel = "knowledge/shared/dup.md";
  const seed = (/** @type {string} */ tag) => ({
    name: "dup.md",
    text: `# Dup ${tag}\n\nSame rel path in two trees.\n`,
    datasetId: "knowledge",
    metadata: REF_META,
    placementOverride: "knowledge/shared",
  });
  store.saveDocument(seed("brain")); // brain (default root)
  withWikiRoot(mountWiki, () => store.saveDocument(seed("mount")));

  const result = /** @type {{ ok?: boolean, status?: string }} */ (
    withToolScopes({ scopes: [path.join(home, "repo")] }, () =>
      withWriteTarget(path.join(home, "repo"), () =>
        withWikiCommit({ op: "e2e-mutate", actor: "test" }, () =>
          store.disableDocument({ documentId: rel, datasetId: "knowledge" }),
        ),
      ),
    )
  );

  assert.equal(result.ok, true, "the mutate resolved a real leaf (not a 404)");
  assert.equal(result.status, "archived");
  assert.deepEqual(namesUnder(mountWiki, false), ["dup.md"], "the MOUNT leaf was archived");
  assert.deepEqual(namesUnder(brainWiki, false), [], "the brain's same-path leaf is untouched");
  assert.ok(namesUnder(brainWiki, true).includes("dup.md"), "the brain leaf stays active");
});

// §6.8 — cron consolidate stays brain-only; a shared target is refused ----------
test("cron: consolidate skips repo-owned categories, never writes a mount, refuses a shared target", async () => {
  // Mark the brain's `knowledge` repo-owned so consolidate must skip it.
  const layoutFile = path.join(brainWiki, ".layout", "layout.yaml");
  const raw = fs.readFileSync(layoutFile, "utf8");
  fs.writeFileSync(
    layoutFile,
    raw.replace("  - path: knowledge\n", "  - path: knowledge\n    ownership: repo\n"),
  );
  resetLayoutCache();

  const dupBody = "# Dedupe me\n\nIdentical body; sha256 dedupe fires when a tree is walked.\n";
  // Repo-owned brain knowledge: MUST survive (skipped).
  store.saveDocument({ name: "k-a.md", text: dupBody, datasetId: "knowledge", metadata: REF_META });
  store.saveDocument({ name: "k-b.md", text: dupBody, datasetId: "knowledge", metadata: REF_META });
  // Brain-owned self_improvement: one loser MUST be archived (proves the run ran).
  const les = (/** @type {string} */ ep) => ({
    text: dupBody,
    datasetId: "self_improvement",
    metadata: {
      project_module: "fedcron",
      area: "infra",
      task_type: "implementation",
      error_pattern: ep,
    },
  });
  store.saveDocument({ name: "s-a.md", ...les("cron-a") });
  store.saveDocument({ name: "s-b.md", ...les("cron-b") });

  // A real repo mount under HOME whose tree must be left completely untouched.
  const home = freshHome("w-cron");
  const proj = mkdirp(home, "proj");
  gitInit(proj);
  initMount(proj);
  const mountWiki = path.join(proj, ".llm-wiki-memory", "wiki");
  withWikiRoot(mountWiki, () => {
    store.saveDocument({
      name: "m-a.md",
      text: dupBody,
      datasetId: "knowledge",
      metadata: REF_META,
    });
    store.saveDocument({
      name: "m-b.md",
      text: dupBody,
      datasetId: "knowledge",
      metadata: REF_META,
    });
  });

  const ambient = resolveWikiContext([proj], { home, brainDataDir: dataDir });
  assert.equal(ambient.levels.length, 2, "ambient context: brain + repo mount");
  const r = /** @type {{ ok: boolean, totals: { archived: number } }} */ (
    await withWikiContext(ambient, () =>
      consolidateMemory({
        dryRun: false,
        llm: false,
        passes: ["dedupe-by-sha256"],
        now: FROZEN_NOW,
      }),
    )
  );
  assert.equal(r.ok, true);

  const disabled = /** @type {string[]} */ (
    store
      .listDocuments({ enabled: false })
      .documents.map((/** @type {{ name: string }} */ d) => d.name)
  );
  assert.ok(disabled.includes("s-b.md"), "a brain-owned self_improvement duplicate was archived");
  assert.ok(
    !disabled.includes("k-a.md") && !disabled.includes("k-b.md"),
    "repo-owned knowledge skipped",
  );
  assert.deepEqual(namesUnder(mountWiki, false), [], "the repo mount tree received ZERO writes");

  // A manual consolidate directed at a shared/non-brain target is refused outright.
  const refused = /** @type {{ ok: boolean, error?: string }} */ (
    await consolidateMemory({
      dryRun: false,
      llm: false,
      passes: ["dedupe-by-sha256"],
      target: proj,
      now: FROZEN_NOW,
    })
  );
  assert.equal(refused.ok, false, "the shared-target consolidate is refused");
  assert.equal(refused.error, SHARED_TARGET_ERROR);
  assert.deepEqual(
    namesUnder(mountWiki, false),
    [],
    "still zero writes to the mount after the refusal",
  );
});
