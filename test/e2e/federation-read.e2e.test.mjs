// Phase M e2e — federation READ path: the deterministic scope scanner (up-walk
// + live re-scan, no restart), the additive depth-boosted fan-out over real
// isolated trees, and the layered shared+local config merge. Driven through the
// REAL seams: scanScopes, resolveWikiContext, and the MCP `withToolScopes`
// wrapper over searchMemoryFiltered. Lexical backend; realpath'd /tmp.
//
// §6 items: (2) scanner up-walk + re-scan, (3) additive-depth fan-out + missing
// category skip + same-path survival, (7) layered layout.local.yaml merge.

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "../harness.mjs";
import { realTmp, rmAll, mkdirp, writeMountLayout, runInit } from "./federation-helpers.mjs";

const { dataDir } = setupWorkspace(); // brain = <dataDir>/wiki, lexical settings
const { scanScopes } = await import("../../scripts/lib/scope-scanner.mjs");
const { resolveWikiContext } = await import("../../scripts/lib/wiki-context.mjs");
const { withToolScopes } = await import("../../mcp-server/mcp-scopes.mjs");
const { withWikiRoot } = await import("../../scripts/lib/env.mjs");
const store = await import("../../scripts/lib/wiki-store.mjs");

const BRAIN_MODULE = "testproj"; // MEMORY_DEFAULT_PROJECT_MODULE from setupWorkspace
const MOUNT_LAYOUT = "layout:\n  - path: knowledge\n  - path: daily\n";

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
 * @returns {string} a fresh HOME with the process env pointed at it
 */
function freshHome(prefix) {
  const home = realTmp(prefix);
  tmps.push(home);
  process.env.HOME = home; // os.homedir() honours $HOME → the real scanner default
  return home;
}

/**
 * @param {string} wikiRoot
 * @param {() => unknown} fn
 * @returns {unknown}
 */
function inRoot(wikiRoot, fn) {
  return withWikiRoot(wikiRoot, fn);
}

// §6.3 — additive depth-boosted fan-out; same rel path in each tree survives ----
test("read: fan-out ranks a deeper hit above a shallower one, additively", async () => {
  const home = freshHome("read-depth");
  const repoWiki = writeMountLayout(mkdirp(home, "repo"), MOUNT_LAYOUT);
  const subWiki = writeMountLayout(mkdirp(home, "repo/sub"), MOUNT_LAYOUT);
  const deepCwd = mkdirp(home, "repo/sub/a/b/c");

  const token = "quokkamarker";
  const body = `# Doc\n\nThe ${token} identical body across every level.\n`;
  const seed = () =>
    store.saveDocument({
      name: "same.md",
      text: body,
      datasetId: "knowledge",
      metadata: { atom_type: "reference" },
      placementOverride: "knowledge/shared",
    });
  seed(); // brain (default root)
  inRoot(repoWiki, seed);
  inRoot(subWiki, seed);

  const repoId = `file://${path.join(home, "repo")}`;
  const subId = `file://${path.join(home, "repo", "sub")}`;

  const ctx = resolveWikiContext([deepCwd]); // real defaults: home=$HOME, brain=MEMORY_DATA_DIR
  assert.deepEqual(
    ctx.levels.map((l) => [l.depth, l.ownership, l.projectModule]),
    [
      [0, "wiki", BRAIN_MODULE],
      [1, "repo", repoId],
      [2, "repo", subId],
    ],
    "brain(0) + repo(1) + sub(2), shallowest-first; non-git mounts carry their file:// identity",
  );

  const { records } =
    /** @type {{ records: import("../../scripts/lib/types.mjs").SearchHit[] }} */ (
      await withToolScopes({ scopes: [deepCwd] }, () =>
        store.searchMemoryFiltered({
          query: token,
          datasetId: "knowledge",
          filters: {},
          limit: 10,
        }),
      )
    );

  assert.equal(records.length, 3, "all three same-path leaves survive (tree-namespaced dedupe)");
  assert.deepEqual(
    records.map((r) => r.depth),
    [2, 1, 0],
    "strictly deepest-first",
  );
  const cos = records[0].cosine;
  for (const r of records) {
    assert.equal(r.cosine, cos, "identical bodies → identical cosine, so only depth flips order");
    assert.equal(r.depthBoost, r.depth, "depthBoost = depth * 1 (default per-level boost)");
    assert.equal(
      r.adjustedConfidence,
      r.cosine + r.depth,
      "adjustedConfidence = cosine + depth*boost",
    );
    assert.equal(r.documentId, "knowledge/shared/same.md", "the shared rel path is identical");
    assert.ok(r.projectModule, "each hit carries its level's project_module");
  }
  assert.ok(
    records[0].adjustedConfidence > records[1].adjustedConfidence &&
      records[1].adjustedConfidence > records[2].adjustedConfidence,
    "final order strictly DESC by adjustedConfidence",
  );
  assert.deepEqual(
    records.map((r) => r.projectModule),
    [subId, repoId, BRAIN_MODULE],
    "deepest → shallowest project modules",
  );
  const roots = new Set(records.map((r) => r.resolvedRoot));
  assert.equal(roots.size, 3, "the three survivors come from three distinct trees");
});

// §6.3 — a level missing the searched category is skipped, not a crash ----------
test("read: fan-out skips a level that lacks the searched category (no crash)", async () => {
  const home = freshHome("read-miss");
  writeMountLayout(mkdirp(home, "repo"), MOUNT_LAYOUT); // mount layout has no `plans`
  const cwd = mkdirp(home, "repo/deep");

  const token = "narwhalmarker";
  store.saveDocument({
    name: "plan.md",
    text: `# Plan\n\nThe ${token} plan body lives only in the brain.\n`,
    datasetId: "plans",
    metadata: {},
    placementOverride: "plans",
  });

  const { records } =
    /** @type {{ records: import("../../scripts/lib/types.mjs").SearchHit[] }} */ (
      await withToolScopes({ scopes: [cwd] }, () =>
        store.searchMemoryFiltered({ query: token, datasetId: "plans", filters: {}, limit: 10 }),
      )
    );
  assert.equal(records.length, 1, "only the brain has a `plans` category; the mount is skipped");
  assert.equal(records[0].depth, 0, "the surviving hit is the brain's");
});

// §6.2 — scanner up-walk + a NEW mount is live on the very next scan (no restart)
test("scan: up-walk resolves every level; a freshly-init'd mount appears immediately", () => {
  const home = freshHome("read-scan");
  writeMountLayout(mkdirp(home, "repo"), MOUNT_LAYOUT);
  writeMountLayout(mkdirp(home, "repo/sub"), MOUNT_LAYOUT);
  const deepCwd = mkdirp(home, "repo/sub/x/y");

  const before = scanScopes([deepCwd], { home, brainDataDir: dataDir });
  assert.deepEqual(
    before.map((l) => l.projectModule),
    [BRAIN_MODULE, "repo", "sub"],
    "brain + parent + child, shallowest-first",
  );

  // A brand-new mount created by a real `cli.mjs init --template repo` must be
  // discoverable on the NEXT scan with no process restart (scanner reads the fs).
  const fresh = mkdirp(home, "fresh");
  const r = runInit(path.join(fresh, ".llm-wiki-memory"), ["--template", "repo"]);
  assert.equal(r.status, 0, `fresh mount init failed: ${r.stderr}`);

  const after2 = scanScopes([mkdirp(home, "fresh/nested")], { home, brainDataDir: dataDir });
  const freshLevel = after2.find((l) => l.projectModule === "fresh");
  assert.ok(freshLevel, "the new mount is visible on the very next scan");
  assert.equal(freshLevel.ownership, "repo");

  // A simulated new clone (its committed layout present) is likewise live at once.
  writeMountLayout(mkdirp(home, "cloned"), MOUNT_LAYOUT);
  const cloned = scanScopes([mkdirp(home, "cloned/deep")], { home, brainDataDir: dataDir });
  assert.ok(
    cloned.some((l) => l.projectModule === "cloned"),
    "a cloned mount is discovered too",
  );
});

// §6.7 — layered config: local ADDS, shared WINS, arrays merge per-key -----------
test("config: layout.local.yaml adds categories/vocab; shared wins conflicts", () => {
  const home = freshHome("read-layer");
  const mount = mkdirp(home, "repo");
  const wikiRoot = writeMountLayout(
    mount,
    [
      "vocabularies:",
      "  subject_domains: [shared-a, shared-b]",
      "layout:",
      "  - path: knowledge",
      "    purpose: shared-knowledge",
      "    ownership: repo",
      "  - path: team",
      "    purpose: team-only",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(wikiRoot, ".layout", "layout.local.yaml"),
    [
      "vocabularies:",
      "  subject_domains: [local-should-lose]",
      "  personal_vocab: [p1, p2]",
      "layout:",
      "  - path: knowledge",
      "    purpose: local-should-lose",
      "  - path: personal",
      "    purpose: personal-only",
      "",
    ].join("\n"),
  );

  const ctx = resolveWikiContext([mount], { home, brainDataDir: dataDir });
  const repo = ctx.levels.find((l) => l.ownership === "repo");
  assert.ok(repo, "the mount level resolved");
  const merged =
    /** @type {{ layout: Array<{ path: string, purpose?: string }>, vocabularies: Record<string, string[]> }} */ (
      /** @type {unknown} */ (repo.layout)
    );

  const entries = new Map(merged.layout.map((e) => [e.path, e]));
  assert.equal(entries.size, 3, "layout[] merged to knowledge + team + personal");
  assert.equal(
    entries.get("knowledge")?.purpose,
    "shared-knowledge",
    "shared wins the knowledge conflict",
  );
  assert.ok(entries.has("team"), "shared-only category preserved");
  assert.ok(entries.has("personal"), "local-only category added");
  assert.deepEqual(
    merged.vocabularies.subject_domains,
    ["shared-a", "shared-b"],
    "shared wins the vocab conflict",
  );
  assert.deepEqual(
    merged.vocabularies.personal_vocab,
    ["p1", "p2"],
    "local-only vocab key preserved",
  );
});
