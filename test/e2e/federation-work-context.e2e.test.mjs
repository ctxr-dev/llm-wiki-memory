// Workstream J17 round-7 (Finding 1) — SessionStart work-context must span the
// SCOPE CHAIN, not the brain only. The active branch's in-progress plan often
// lives in a SHARED REPO's wiki (a tracker-issues topology the private brain does
// not even declare). This drives the SAME seams the session-start hook now uses
// (withScopeContext + buildWorkContextSection with the real searchMemory) against
// a real federation: a `default`-template brain + a `tracker-issues` repo mount,
// a real feature branch, the plan seeded in the REPO wiki. Asserts the plan (and
// its progress, read from the REPO root via each hit's resolvedRoot) is surfaced,
// and that the OLD brain-only path misses it (proving the fix is load-bearing).
// Also exercises round-6 scopedCategories (the repo-only `issues` category must be
// enumerated for the default search to reach it). Lexical backend, realpath'd
// $HOME, C14-safe (no bootstrap / npm install). buildFakeHome runs BEFORE the
// engine import so MEMORY_DATA_DIR/HOME are frozen to the fake.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildFakeHome, seedLeafFile, rmAll } from "./federation-helpers.mjs";

const fake = await buildFakeHome({
  prefix: "ss-repo-workctx",
  brainTemplate: "default", // brain has NO `issues` category
  mounts: [{ rel: "repos/svc", template: "tracker-issues" }], // shared repo DOES
});

const { searchMemory } = await import("../../scripts/lib/recall.mjs");
const { withScopeContext } = await import("../../scripts/cli-scopes.mjs");
const { withBrainContextSafe } = await import("../../scripts/lib/wiki-context.mjs");
const { buildWorkContextSection, computeSessionScopes } =
  await import("../../scripts/lib/work-context.mjs");

const mount = fake.mounts[0];
const BRANCH = "feature/DEV-129957-timeout";

// Make the repo mount a real git repo checked out on the feature branch.
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: mount.dir });
spawnSync("git", ["config", "user.email", "t@t.local"], { cwd: mount.dir });
spawnSync("git", ["config", "user.name", "t"], { cwd: mount.dir });
fs.writeFileSync(path.join(mount.dir, "README.md"), "ok\n");
spawnSync("git", ["add", "."], { cwd: mount.dir });
spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: mount.dir });
spawnSync("git", ["checkout", "-q", "-b", BRANCH], { cwd: mount.dir });

// The branch's in-progress plan lives in the SHARED REPO's wiki (not the brain),
// at the issues-topology path, with branch tokens so the lexical search scores it.
const PLAN_REL = "issues/JIRA/DEV/129/95/7/in-progress/DEV-129957-fix-timeout.plan.md";
seedLeafFile(
  mount.wikiRoot,
  PLAN_REL,
  `---
id: DEV-129957-fix-timeout.plan.md
status: in-progress
progress:
  total: 12
  done: 4
  label: "4/12"
memory:
  atom_type: plan
---

# Fix DEV-129957 Cassandra timeout

Investigating the Hermes DEV-129957 timeout on the feature branch: Cassandra read
timeout root cause, socket pool bump.
`,
);

const opts = { home: fake.home, brainDataDir: fake.brainDataDir };

after(() => {
  fake.restore();
  rmAll([fake.home]);
});

test("work-context spans the scope chain: a SHARED REPO's branch plan is surfaced with progress (Finding 1)", async () => {
  const section = await withScopeContext(
    computeSessionScopes(mount.dir),
    () => buildWorkContextSection({ cwd: mount.dir, searchMemory, wikiRoot: fake.brainWiki }),
    opts,
  );
  assert.match(section, /## Current-work context/, "the section is emitted for the feature branch");
  assert.match(section, new RegExp(BRANCH.replace("/", "\\/")), "names the active branch");
  assert.match(
    section,
    /issues\/JIRA\/DEV\/129\/95\/7\/in-progress\/DEV-129957-fix-timeout\.plan\.md/,
    "the SHARED REPO's plan leaf is found via the fanned-out search",
  );
  // Progress is read from the leaf on disk — only resolvable at the REPO root (the
  // hit's resolvedRoot), NOT the brain root, so this proves the per-hit-root read.
  assert.match(section, /4\/12 done/, "plan progress read from the REPO wiki");
  assert.match(section, /in-progress/, "plan lifecycle status surfaced");
});

test("contrast: the OLD brain-only path misses the shared repo's plan (fix is load-bearing)", async () => {
  const section = await withBrainContextSafe(() =>
    buildWorkContextSection({ cwd: mount.dir, searchMemory, wikiRoot: fake.brainWiki }),
  );
  assert.doesNotMatch(
    section,
    /DEV-129957-fix-timeout\.plan\.md/,
    "brain-only search (the pre-fix behavior) never reaches the repo-only issues tree",
  );
});
