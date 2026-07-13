// Phase B8 e2e — commit-layer edge: TWO nested shared repos written in ONE commit
// batch. Each shared leaf is staged only in its repo's working tree; the engine
// runs ZERO git against EITHER shared repo (R11), and the brain's own git is not
// advanced by a shared-only batch. (Single-shared zero-git is covered by
// federation-write.e2e; the subrepo gitUsable double-guard by federation-install-
// nested.e2e — this adds the multi-shared-in-one-batch case.) Realpath'd /tmp.

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
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
} from "./federation-helpers.mjs";

const { dataDir } = setupWorkspace();
const { withWikiCommit, _resetGitProbeCache } = await import("../../scripts/lib/wiki-commit.mjs");
const { withWriteTarget } = await import("../../mcp-server/mcp-write-target.mjs");
const { resolveWikiContext, withWikiContext } = await import("../../scripts/lib/wiki-context.mjs");
const store = await import("../../scripts/lib/wiki-store.mjs");
const { initMount } = await import("../../scripts/mount-init.mjs");

const REF_META = { atom_type: "reference", project_module: "fedcommit", area: "infra" };

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

test("commit-edge: two NESTED shared repos in ONE batch — both staged untracked, ZERO engine git on either, brain untouched", () => {
  const home = realTmp("commit-nested");
  tmps.push(home);
  process.env.HOME = home;

  const outer = mkdirp(home, "outer");
  gitInit(outer);
  initMount(outer);
  gitCommitAll(outer, "outer baseline");
  const inner = mkdirp(home, "outer/inner");
  gitInit(inner);
  initMount(inner);
  gitCommitAll(inner, "inner baseline");
  _resetGitProbeCache();

  const cwd = mkdirp(home, "outer/inner/deep");
  const ctx = resolveWikiContext([cwd], { home, brainDataDir: dataDir });
  const outerLevel = ctx.levels.find((l) => l.mountDir === outer);
  const innerLevel = ctx.levels.find((l) => l.mountDir === inner);
  assert.ok(outerLevel && innerLevel, "both nested repo levels resolved");

  const brainBefore = commitCount(path.dirname(dataDir));
  const outerBefore = { count: commitCount(outer), tracked: lsFiles(outer) };
  const innerBefore = { count: commitCount(inner), tracked: lsFiles(inner) };

  // A SINGLE commit batch that writes into BOTH shared repos (Phase F captures
  // rootDir per entry, so one batch can span levels).
  withWikiContext(ctx, () =>
    withWikiCommit({ op: "e2e-two-shared", actor: "test" }, () => {
      withWriteTarget(outerLevel.root, () =>
        store.saveDocument({
          name: "outer-note.md",
          text: "# Outer\n\nstaged.\n",
          datasetId: "knowledge",
          metadata: REF_META,
        }),
      );
      withWriteTarget(innerLevel.root, () =>
        store.saveDocument({
          name: "inner-note.md",
          text: "# Inner\n\nstaged.\n",
          datasetId: "knowledge",
          metadata: REF_META,
        }),
      );
    }),
  );

  assert.equal(
    commitCount(outer),
    outerBefore.count,
    "OUTER repo HEAD never moved (zero engine git)",
  );
  assert.equal(
    commitCount(inner),
    innerBefore.count,
    "INNER repo HEAD never moved (zero engine git)",
  );
  assert.deepEqual(
    lsFiles(outer),
    outerBefore.tracked,
    "OUTER git index byte-identical (nothing staged)",
  );
  assert.deepEqual(
    lsFiles(inner),
    innerBefore.tracked,
    "INNER git index byte-identical (nothing staged)",
  );
  assert.ok(
    /\?\?\s+.*outer-note\.md/.test(porcelain(outer)),
    "OUTER leaf is an untracked working-tree file",
  );
  assert.ok(
    /\?\?\s+.*inner-note\.md/.test(porcelain(inner)),
    "INNER leaf is an untracked working-tree file",
  );
  assert.equal(
    commitCount(path.dirname(dataDir)),
    brainBefore,
    "a shared-only batch does not advance the brain's own git",
  );
});
