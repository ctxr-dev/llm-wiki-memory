// Phase B8 e2e — scanner EDGE cases not covered by the scope-scanner unit tests
// (HOME-unset / dedupe / half-mount / inaccessible are unit-covered — not rebuilt):
// a GAP level between two mounts, a DEEP 4–5 chain (scan contiguity + fan-out
// ordering), and realpath/symlink alias dedupe. Real seams: scanScopes,
// withToolScopes → searchMemoryFiltered. Lexical backend, realpath'd /tmp.

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "../harness.mjs";
import { realTmp, rmAll, mkdirp, writeMountLayout, symlinkAlias } from "./federation-helpers.mjs";

const { dataDir } = setupWorkspace();
const { scanScopes } = await import("../../scripts/lib/scope-scanner.mjs");
const { withToolScopes } = await import("../../mcp-server/mcp-scopes.mjs");
const { withWikiRoot } = await import("../../scripts/lib/env.mjs");
const store = await import("../../scripts/lib/wiki-store.mjs");

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

/** @param {string} prefix @returns {string} */
function freshHome(prefix) {
  const home = realTmp(prefix);
  tmps.push(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home; // Windows: os.homedir() reads USERPROFILE, not HOME
  return home;
}

test("scan-edge: a GAP dir between two mounts contributes no level (depths stay contiguous)", () => {
  const home = freshHome("scan-gap");
  writeMountLayout(mkdirp(home, "repo"), MOUNT_LAYOUT);
  mkdirp(home, "repo/mid"); // a plain dir, NOT a mount
  writeMountLayout(mkdirp(home, "repo/mid/deep"), MOUNT_LAYOUT);
  const cwd = mkdirp(home, "repo/mid/deep/x/y");

  const levels = scanScopes([cwd], { home, brainDataDir: dataDir });
  assert.deepEqual(
    levels.map((l) => [l.depth, path.basename(l.mountDir)]),
    [
      [0, path.basename(path.dirname(dataDir))],
      [1, "repo"],
      [2, "deep"],
    ],
    "brain + repo + deep; the gap 'mid' is not a level and depths stay 0,1,2",
  );
  assert.ok(!levels.some((l) => path.basename(l.mountDir) === "mid"), "the gap dir is not a level");
});

test("scan-edge: a DEEP 4–5 mount chain scans to contiguous depths 0..5", () => {
  const home = freshHome("scan-deep");
  let rel = "";
  for (const seg of ["a", "b", "c", "d", "e"]) {
    rel = rel ? `${rel}/${seg}` : seg;
    writeMountLayout(mkdirp(home, rel), MOUNT_LAYOUT);
  }
  const cwd = mkdirp(home, "a/b/c/d/e/deep/cwd");
  const levels = scanScopes([cwd], { home, brainDataDir: dataDir });
  assert.equal(levels.length, 6, "brain + 5 nested mounts");
  assert.deepEqual(
    levels.map((l) => l.depth),
    [0, 1, 2, 3, 4, 5],
    "contiguous 0..5 shallowest-first",
  );
});

test("scan-edge: a DEEP chain fan-out ranks strictly deepest-first (adjustedConfidence = cosine + depth)", async () => {
  const home = freshHome("scan-deepfan");
  const roots = [];
  let rel = "";
  for (const seg of ["p", "q", "r"]) {
    rel = rel ? `${rel}/${seg}` : seg;
    roots.push(writeMountLayout(mkdirp(home, rel), MOUNT_LAYOUT));
  }
  const token = "wombatmarker";
  const body = `# Doc\n\nThe ${token} identical body at every level.\n`;
  const seed = () =>
    store.saveDocument({
      name: "same.md",
      text: body,
      datasetId: "knowledge",
      metadata: { atom_type: "reference" },
      placementOverride: "knowledge/shared",
    });
  seed(); // brain
  for (const r of roots) withWikiRoot(r, seed);

  const cwd = mkdirp(home, "p/q/r/deep");
  const { records } =
    /** @type {{ records: import("../../scripts/lib/types.mjs").SearchHit[] }} */ (
      await withToolScopes({ scopes: [cwd] }, () =>
        store.searchMemoryFiltered({
          query: token,
          datasetId: "knowledge",
          filters: {},
          limit: 10,
        }),
      )
    );
  assert.equal(records.length, 4, "brain + 3 mounts, all same-path leaves survive");
  assert.deepEqual(
    records.map((r) => r.depth),
    [3, 2, 1, 0],
    "strictly deepest-first",
  );
  for (const r of records) {
    assert.equal(r.adjustedConfidence, r.cosine + r.depth, "adjustedConfidence = cosine + depth*1");
  }
});

test("scan-edge: a symlinked scope + its real path dedupe to ONE realpath'd level", () => {
  const home = freshHome("scan-alias");
  writeMountLayout(mkdirp(home, "real"), MOUNT_LAYOUT);
  const realCwd = mkdirp(home, "real/inner");
  const linkCwd = symlinkAlias(realCwd, path.join(home, "link-inner"));

  const levels = scanScopes([realCwd, linkCwd], { home, brainDataDir: dataDir });
  const repos = levels.filter((l) => l.ownership === "repo");
  assert.equal(repos.length, 1, "the real path and its symlink alias collapse to one mount");
  assert.equal(
    repos[0].mountDir,
    fs.realpathSync(path.join(home, "real")),
    "the level's mountDir is the realpath'd target, not the symlink path",
  );
});
