// Workstream J7 — SessionStart issue-topology branch recall, end to end against a
// REAL wiki (not a stubbed search, which every other work-context test uses). Seeds
// an issues-topology plan leaf + recent daily notes, checks out a real feature
// branch named for the issue, and drives the SAME seams the SessionStart hook uses
// (buildWorkContextSection + buildRecentActivitySection under withBrainContextSafe
// with the real searchMemory) — asserting the issue plan (with its progress) lands
// in "Current-work context" and the recent notes land in "🧠 Recently". Real seams,
// lexical backend, realpath'd $HOME, C14-safe (no bootstrap/npm install).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildFakeHome, seedLeafFile, rmAll } from "./federation-helpers.mjs";

const fake = await buildFakeHome({ prefix: "ss-issue-recall", brainTemplate: "tracker-issues" });

// Lazy-import the engine AFTER buildFakeHome set HOME / MEMORY_DATA_DIR / backend.
const { searchMemory } = await import("../../scripts/lib/recall.mjs");
const { withBrainContextSafe } = await import("../../scripts/lib/wiki-context.mjs");
const { buildWorkContextSection, buildRecentActivitySection } =
  await import("../../scripts/lib/work-context.mjs");

/** @param {string} branch @returns {string} a real git repo checked out on `branch` */
function repoOnBranch(branch) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(fake.home, "repo-")));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.local"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "ok\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  spawnSync("git", ["checkout", "-q", "-b", branch], { cwd: dir });
  return dir;
}

/** @param {string} y @param {string} mo @param {string} d @param {string} stamp @param {string} brief */
function seedDaily(y, mo, d, stamp, brief) {
  seedLeafFile(
    fake.brainWiki,
    `daily/${y}/${mo}/${d}/daily-${y}-${mo}-${d}-${stamp}.md`,
    `---\nbrief: ${JSON.stringify(brief)}\nmemory:\n  atom_type: daily-capture\n---\n\nbody text ${brief}\n`,
  );
}

const repo = repoOnBranch("feature/DEV-129957-timeout");

// An issues-topology PLAN leaf at the exact tracker path (129957 → 129/95/7), with
// top-level status/progress (what readPlanProgress surfaces) + branch tokens in the
// body so the lexical search scores it against the branch-name query.
const PLAN_REL = "issues/JIRA/DEV/129/95/7/in-progress/DEV-129957-fix-timeout.plan.md";
seedLeafFile(
  fake.brainWiki,
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

// Recent daily notes on two distinct dates → the "🧠 Recently" block.
seedDaily("2026", "07", "14", "153012123", "Cassandra timeout root cause bisected to rc22");
seedDaily("2026", "07", "13", "110233004", "Decided to keep the shadow deploy behind a flag");

after(() => {
  fake.restore();
  rmAll([fake.home]);
});

test("J7: SessionStart surfaces an issues-topology plan for the active branch (Current-work context)", async () => {
  const section = await withBrainContextSafe(() =>
    buildWorkContextSection({ cwd: repo, searchMemory, wikiRoot: fake.brainWiki }),
  );
  assert.match(section, /## Current-work context/, "the section is emitted for a non-trunk branch");
  assert.match(section, /feature\/DEV-129957-timeout/, "names the active branch");
  assert.match(
    section,
    /issues\/JIRA\/DEV\/129\/95\/7\/in-progress\/DEV-129957-fix-timeout\.plan\.md/,
    "the issues-topology plan leaf is found by the real branch-name search",
  );
  assert.match(section, /4\/12 done/, "surfaces the plan's checkbox progress");
  assert.match(section, /in-progress/, "surfaces the plan's lifecycle status");
});

test("J7: SessionStart surfaces recent daily notes (🧠 Recently)", () => {
  const section = buildRecentActivitySection({ wikiRoot: fake.brainWiki, days: 3 });
  assert.match(section, /## 🧠.*Recently — last 3 days/, "the Recently header");
  assert.match(section, /Cassandra timeout root cause bisected to rc22/, "the newest note's brief");
  assert.match(section, /\]\(file:\/\/.*daily.*\.md\)/, "each note is a clickable file link");
});

test("J7: a trunk branch produces NO current-work section (only feature branches trigger recall)", async () => {
  const trunk = repoOnBranch("main");
  // repoOnBranch checks out a feature branch by default, so put it back on main.
  spawnSync("git", ["checkout", "-q", "main"], { cwd: trunk });
  const section = await withBrainContextSafe(() =>
    buildWorkContextSection({ cwd: trunk, searchMemory, wikiRoot: fake.brainWiki }),
  );
  assert.equal(section, "", "no branch-based recall on a trunk branch");
});
