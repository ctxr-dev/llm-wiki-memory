// B3 (nested + subrepo install, §6d) — a repo-in-repo mount: an OUTER git repo
// with a mount, and an INNER git subrepo (its own .git) nested inside it, each
// initMount'd. Driven through the initMount LIB (mount-init.mjs is npm-free —
// no bootstrap.sh, no `npm install`), real git repos in realpath'd /tmp.
// Additive per C19: federation-install.e2e covers a SINGLE mount's check-ignore
// matrix; scope-scanner.test covers the nested-scan depths. The gap here is the
// SUBREPO double-guard — the engine must never treat either wiki as a committable
// git root (so it never runs git against a shared/host repo).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installNest, rmAll } from "./federation-helpers.mjs";
import { validateMount } from "./federation-asserts-git.mjs";

/** @type {string[]} */
const tmps = [];
/** @type {string | undefined} */
let savedHome;
/** @type {{ repos: { rel: string, dir: string, result: any, wikiRoot: string }[] }} */
let nest;
/** @type {(root: string) => boolean} */
let gitUsable;
/** @type {() => void} */
let resetGitProbe;

before(async () => {
  savedHome = process.env.HOME;
  nest = /** @type {any} */ (
    await installNest({
      prefix: "b3-nested",
      tmps,
      repos: [{ rel: "acme" }, { rel: "acme/pkg/core" }],
    })
  );
  const git = await import("../../scripts/lib/wiki-commit-git.mjs");
  gitUsable = git.gitUsable;
  resetGitProbe = git._resetGitProbeCache;
});

after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmAll(tmps);
});

test("nested install: the OUTER and INNER subrepo mounts each validate (tree, personal git, sync hook)", async () => {
  const [outer, inner] = nest.repos;
  await validateMount(outer);
  await validateMount(inner);
});

test("nested install: neither mount's wiki is a git working tree (wiki/.git absent; personal git lives under personal/)", () => {
  for (const m of nest.repos) {
    assert.ok(!fs.existsSync(path.join(m.wikiRoot, ".git")), `${m.rel}: wiki/.git absent`);
    assert.ok(
      fs.existsSync(path.join(m.dir, ".llm-wiki-memory", "personal", ".git")),
      `${m.rel}: personal/.git present`,
    );
  }
});

test("subrepo double-guard: gitUsable is FALSE for BOTH the outer and inner wiki roots", () => {
  const [outer, inner] = nest.repos;
  // The probe caches per root; reset between the two limbs.
  resetGitProbe();
  assert.equal(gitUsable(outer.wikiRoot), false, "outer wiki is not a committable git root");
  resetGitProbe();
  assert.equal(
    gitUsable(inner.wikiRoot),
    false,
    "inner (subrepo) wiki is not a committable git root",
  );
});
